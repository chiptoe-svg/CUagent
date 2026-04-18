// RemindersHost — HTTP bridge from NanoClaw's in-container reminder MCP
// to macOS EventKit.
//
// Runs on the Mac mini (or any Mac with the user's iCloud Reminders signed in).
// The container-side MCP proxy talks to http://host.docker.internal:3002/...
//
// Contract: docs/apple-reminders-mcp.md

import EventKit
import Foundation
import Hummingbird

// MARK: - Error model

/// Build an HTTPError whose message body is a JSON blob with { code, message }.
/// Matches the error-code strings in docs/apple-reminders-mcp.md#error-surface.
func _apiError(code: String, message: String) -> HTTPError {
    let status: HTTPResponse.Status = {
        switch code {
        case "not_found", "list_not_found", "parent_not_found": return .notFound
        case "eventkit_denied": return .forbidden
        case "host_unreachable": return .badGateway
        default: return .badRequest
        }
    }()
    let escaped = message
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return HTTPError(status, message: #"{"code":"\#(code)","message":"\#(escaped)"}"#)
}

// MARK: - DTOs

struct ListInfo: ResponseCodable {
    let id: String
    let name: String
    let isDefault: Bool
    let source: String
}

struct ReminderInfo: ResponseCodable {
    let id: String
    let title: String
    let notes: String?
    let due: String?                // ISO-8601
    let priority: String            // "high" | "medium" | "low" | "none"
    let completed: Bool
    let completedAt: String?
    let listId: String
    let listName: String
    let parentId: String?
    let alert: String?              // absolute ISO-8601 if set
    let alertBeforeDue: String?     // "15min" | "1h" | "1d" if set
}

struct CreateListBody: Codable {
    let name: String
    let source: String?
}

struct CreateReminderBody: Codable {
    let title: String
    let notes: String?
    let due: String?
    let priority: String?           // high|medium|low, default medium
    let list: String?               // name or id
    let parentId: String?
    let alert: String?              // absolute ISO-8601
    let alertBeforeDue: String?     // "15min" | "1h" | "1d"
}

struct UpdateReminderBody: Codable {
    let title: String?
    let notes: String?              // empty string clears
    let due: String?                // null clears
    let priority: String?
    let list: String?
    let parentId: String?           // null clears
    let alert: String?
    let alertBeforeDue: String?
}

struct CreatedResponse: ResponseCodable {
    let id: String
}

struct OkResponse: ResponseCodable {
    let ok: Bool
    init() { self.ok = true }
}

// MARK: - Store helpers

let store = EKEventStore()

/// Resolve a list name-or-id to an EKCalendar (type .reminder).
func resolveList(_ nameOrId: String) throws -> EKCalendar {
    let calendars = store.calendars(for: .reminder)
    if let byId = calendars.first(where: { $0.calendarIdentifier == nameOrId }) {
        return byId
    }
    if let byName = calendars.first(where: { $0.title == nameOrId }) {
        return byName
    }
    throw _apiError(code: "list_not_found", message: "No reminders list matches '\(nameOrId)'")
}

func priorityToInt(_ s: String?) throws -> Int {
    switch (s ?? "medium").lowercased() {
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    case "none": return 0
    default:
        throw _apiError(code: "invalid_priority", message: "priority must be high/medium/low")
    }
}

func intToPriority(_ i: Int) -> String {
    switch i {
    case 1...4: return "high"
    case 5: return "medium"
    case 6...9: return "low"
    default: return "none"
    }
}

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func parseDate(_ s: String) throws -> Date {
    if let d = iso.date(from: s) { return d }
    // Also accept date-only / no-fractions forms
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let d = plain.date(from: s) { return d }
    throw _apiError(code: "invalid_due", message: "Unparseable ISO-8601: \(s)")
}

func parseRelativeOffset(_ s: String) throws -> TimeInterval {
    // Accept 15min | 1h | 1d (and plural forms). Returns seconds BEFORE the event.
    let t = s.trimmingCharacters(in: .whitespaces).lowercased()
    if let mins = t.components(separatedBy: "min").first.flatMap(Int.init), t.hasSuffix("min") || t.hasSuffix("mins") {
        return TimeInterval(mins * 60)
    }
    if let hours = t.components(separatedBy: "h").first.flatMap(Int.init), t.hasSuffix("h") || t.hasSuffix("hr") || t.hasSuffix("hrs") {
        return TimeInterval(hours * 3600)
    }
    if let days = t.components(separatedBy: "d").first.flatMap(Int.init), t.hasSuffix("d") || t.hasSuffix("day") || t.hasSuffix("days") {
        return TimeInterval(days * 86400)
    }
    throw _apiError(code: "invalid_alert", message: "alert_before_due must be NNmin / NNh / NNd")
}

func dateComponents(from date: Date) -> DateComponents {
    let cal = Calendar(identifier: .gregorian)
    return cal.dateComponents(
        [.year, .month, .day, .hour, .minute, .second, .timeZone],
        from: date
    )
}

func fetchAllReminders(predicate: NSPredicate) async throws -> [EKReminder] {
    try await withCheckedThrowingContinuation { cont in
        store.fetchReminders(matching: predicate) { reminders in
            cont.resume(returning: reminders ?? [])
        }
    }
}

func reminderInfo(_ r: EKReminder) -> ReminderInfo {
    let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }.map(iso.string(from:))
    let completedAt = r.completionDate.map(iso.string(from:))

    // Alarms: extract first absolute-date alarm or first relative-offset alarm.
    var alert: String? = nil
    var alertBeforeDue: String? = nil
    if let alarm = r.alarms?.first {
        if let absolute = alarm.absoluteDate {
            alert = iso.string(from: absolute)
        } else if alarm.relativeOffset != 0 {
            let offset = -alarm.relativeOffset
            if offset >= 86400 { alertBeforeDue = "\(Int(offset / 86400))d" }
            else if offset >= 3600 { alertBeforeDue = "\(Int(offset / 3600))h" }
            else if offset >= 60 { alertBeforeDue = "\(Int(offset / 60))min" }
        }
    }

    return ReminderInfo(
        id: r.calendarItemIdentifier,
        title: r.title ?? "",
        notes: r.notes,
        due: due,
        priority: intToPriority(r.priority),
        completed: r.isCompleted,
        completedAt: completedAt,
        listId: r.calendar.calendarIdentifier,
        listName: r.calendar.title,
        parentId: nil, // v1: EventKit public API doesn't expose the parent relationship
        alert: alert,
        alertBeforeDue: alertBeforeDue
    )
}

// MARK: - Handlers

func handleListAvailable() -> [ListInfo] {
    let calendars = store.calendars(for: .reminder)
    let defaultCal = store.defaultCalendarForNewReminders()
    return calendars.map { cal in
        ListInfo(
            id: cal.calendarIdentifier,
            name: cal.title,
            isDefault: cal.calendarIdentifier == defaultCal?.calendarIdentifier,
            source: cal.source.title
        )
    }
}

func handleCreateList(_ body: CreateListBody) throws -> ListInfo {
    let sources = store.sources
    let source: EKSource
    if let sourceName = body.source {
        guard let s = sources.first(where: { $0.title == sourceName }) else {
            throw _apiError(code: "invalid_source", message: "No source '\(sourceName)'")
        }
        source = s
    } else {
        // Default to the source that owns the default reminders list
        if let defSource = store.defaultCalendarForNewReminders()?.source {
            source = defSource
        } else if let anySource = sources.first(where: {
            $0.sourceType == .calDAV || $0.sourceType == .local
        }) {
            source = anySource
        } else {
            throw _apiError(code: "invalid_source", message: "No reminders-capable source available")
        }
    }

    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = body.name
    cal.source = source
    try store.saveCalendar(cal, commit: true)
    return ListInfo(id: cal.calendarIdentifier, name: cal.title, isDefault: false, source: source.title)
}

func handleListReminders(list: String?, status: String, limit: Int) async throws -> [ReminderInfo] {
    let calendars: [EKCalendar]?
    if let list {
        calendars = [try resolveList(list)]
    } else {
        calendars = nil
    }

    let predicate: NSPredicate
    switch status {
    case "pending":
        predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: calendars
        )
    case "completed":
        predicate = store.predicateForCompletedReminders(
            withCompletionDateStarting: nil, ending: nil, calendars: calendars
        )
    case "recently_completed":
        let since = Date().addingTimeInterval(-24 * 3600)
        predicate = store.predicateForCompletedReminders(
            withCompletionDateStarting: since, ending: nil, calendars: calendars
        )
    case "all":
        predicate = store.predicateForReminders(in: calendars)
    default:
        throw _apiError(code: "invalid_status", message: "status must be pending/completed/recently_completed/all")
    }

    let reminders = try await fetchAllReminders(predicate: predicate)
    return Array(reminders.prefix(limit).map(reminderInfo))
}

func handleCreateReminder(_ body: CreateReminderBody) async throws -> CreatedResponse {
    let calendar: EKCalendar
    if let l = body.list { calendar = try resolveList(l) }
    else if let def = store.defaultCalendarForNewReminders() { calendar = def }
    else { throw _apiError(code: "list_not_found", message: "No default reminders list") }

    if body.parentId != nil {
        // EventKit's public API does not expose the parent/child relationship.
        // Documented in the contract (docs/apple-reminders-mcp.md#subtasks)
        // and surfaced as an explicit error rather than silent drop so the
        // agent can detect and adapt instead of assuming a hierarchy saved.
        throw _apiError(
            code: "subtasks_unsupported",
            message: "parent_id is accepted in the schema but v1 does not honor it. Drop parent_id and create a flat reminder."
        )
    }
    if body.alert != nil && body.alertBeforeDue != nil {
        throw _apiError(code: "invalid_alert", message: "Pass only one of alert or alert_before_due")
    }
    if body.alertBeforeDue != nil && body.due == nil {
        throw _apiError(code: "invalid_alert", message: "alert_before_due requires due to be set")
    }

    let r = EKReminder(eventStore: store)
    r.calendar = calendar
    r.title = body.title
    r.notes = body.notes
    r.priority = try priorityToInt(body.priority)
    if let due = body.due { r.dueDateComponents = dateComponents(from: try parseDate(due)) }

    if let a = body.alert {
        r.addAlarm(EKAlarm(absoluteDate: try parseDate(a)))
    } else if let ab = body.alertBeforeDue {
        r.addAlarm(EKAlarm(relativeOffset: -(try parseRelativeOffset(ab))))
    }

    try store.save(r, commit: true)
    return CreatedResponse(id: r.calendarItemIdentifier)
}

func handleUpdateReminder(id: String, body: UpdateReminderBody) async throws -> OkResponse {
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw _apiError(code: "not_found", message: "No reminder with id \(id)")
    }
    if body.parentId != nil {
        throw _apiError(
            code: "subtasks_unsupported",
            message: "parent_id is accepted in the schema but v1 does not honor it. Drop parent_id when updating."
        )
    }
    if let t = body.title { r.title = t }
    if let n = body.notes { r.notes = n.isEmpty ? nil : n }
    if let d = body.due { r.dueDateComponents = dateComponents(from: try parseDate(d)) }
    if body.due == nil && containsExplicitNull(for: "due", body: body) { r.dueDateComponents = nil }
    if let p = body.priority { r.priority = try priorityToInt(p) }
    if let l = body.list { r.calendar = try resolveList(l) }

    if body.alert != nil || body.alertBeforeDue != nil {
        // Replace all alarms when either is set
        for a in r.alarms ?? [] { r.removeAlarm(a) }
        if let a = body.alert {
            r.addAlarm(EKAlarm(absoluteDate: try parseDate(a)))
        } else if let ab = body.alertBeforeDue {
            r.addAlarm(EKAlarm(relativeOffset: -(try parseRelativeOffset(ab))))
        }
    }

    try store.save(r, commit: true)
    return OkResponse()
}

/// Helper for distinguishing "field not present" from "field set to null" in PATCH bodies.
/// Codable collapses these; a richer decoder would avoid the need for this stub.
/// v1: returns false (caller can't distinguish). Document limitation.
func containsExplicitNull<T: Codable>(for field: String, body: T) -> Bool { false }

func handleComplete(id: String) throws -> OkResponse {
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw _apiError(code: "not_found", message: "No reminder with id \(id)")
    }
    if !r.isCompleted {
        r.isCompleted = true
        r.completionDate = Date()
        try store.save(r, commit: true)
    }
    return OkResponse()
}

func handleUncomplete(id: String) throws -> OkResponse {
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw _apiError(code: "not_found", message: "No reminder with id \(id)")
    }
    if r.isCompleted {
        r.isCompleted = false
        r.completionDate = nil
        try store.save(r, commit: true)
    }
    return OkResponse()
}

func handleDelete(id: String) throws -> OkResponse {
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw _apiError(code: "not_found", message: "No reminder with id \(id)")
    }
    try store.remove(r, commit: true)
    return OkResponse()
}

// MARK: - Bootstrap

@main
struct RemindersHost {
    static func main() async throws {
        // 1) EventKit permission
        do {
            let granted = try await store.requestFullAccessToReminders()
            guard granted else {
                fputs("reminders-host: EventKit access denied. Approve in System Settings → Privacy & Security → Reminders.\n", stderr)
                exit(2)
            }
        } catch {
            fputs("reminders-host: EventKit error: \(error)\n", stderr)
            exit(2)
        }

        // 2) HTTP router
        let router = Router()

        router.get("/healthz") { _, _ -> String in
            "OK"
        }

        router.get("/lists") { _, _ -> [ListInfo] in
            handleListAvailable()
        }

        router.post("/lists") { req, ctx -> ListInfo in
            let body = try await req.decode(as: CreateListBody.self, context: ctx)
            return try handleCreateList(body)
        }

        router.get("/reminders") { req, _ -> [ReminderInfo] in
            let q = req.uri.queryParameters
            let list = q["list"].map(String.init)
            let status = q["status"].map(String.init) ?? "pending"
            let limit = q["limit"].flatMap { Int(String($0)) } ?? 100
            return try await handleListReminders(list: list, status: status, limit: limit)
        }

        router.post("/reminders") { req, ctx -> CreatedResponse in
            let body = try await req.decode(as: CreateReminderBody.self, context: ctx)
            return try await handleCreateReminder(body)
        }

        router.patch("/reminders/:id") { req, ctx -> OkResponse in
            let id = try ctx.parameters.require("id")
            let body = try await req.decode(as: UpdateReminderBody.self, context: ctx)
            return try await handleUpdateReminder(id: id, body: body)
        }

        router.post("/reminders/:id/complete") { _, ctx -> OkResponse in
            let id = try ctx.parameters.require("id")
            return try handleComplete(id: id)
        }

        router.post("/reminders/:id/uncomplete") { _, ctx -> OkResponse in
            let id = try ctx.parameters.require("id")
            return try handleUncomplete(id: id)
        }

        router.delete("/reminders/:id") { _, ctx -> OkResponse in
            let id = try ctx.parameters.require("id")
            return try handleDelete(id: id)
        }

        // 3) Serve on loopback only.
        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname("127.0.0.1", port: 3002),
                serverName: "reminders-host"
            )
        )
        try await app.runService()
    }
}
