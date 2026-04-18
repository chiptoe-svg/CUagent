# Apple Reminders MCP — Tool Surface

Contract for the `reminders` MCP provider. The agent sees these tools as `mcp__reminders__<tool>`. Implementation is a thin in-container stdio MCP server that proxies each call to a Swift REST app running on the host (Mac mini), which bridges to EventKit.

**Transport chain:** agent → stdio MCP server (container) → HTTP fetch to `host.docker.internal:3002` → Swift HTTP server (host) → EventKit → Reminders.app → iCloud → iPhone.

**Direction:** pull only. Agent queries reminder state; agent mutates reminder state. No server-push today. User actions on iPhone propagate to the agent via polling (see [Polling & reconciliation](#polling--reconciliation)).

---

## Identifiers

- **`id`** — EventKit `calendarItemIdentifier`. Opaque string (UUID-shaped). Stable across renames/moves. This is what the agent stores whenever it needs to reference a reminder later.
- **`list_id`** — EventKit `EKCalendar.calendarIdentifier` for calendars of type `.reminder`. Opaque. A reminders list.
- **`list_name`** — User-visible title of a list (e.g. "Reminders", "Work", "Email Actions"). Not guaranteed unique; prefer `list_id` when routing internally but accept names at the agent interface for ergonomics.

---

## Tools

### `reminder_list_available`

Enumerate the user's reminder lists (EKCalendars of type `.reminder`).

**Args:** none.

**Returns:** text block:

```
Available lists:
  - Reminders (default) [id=ABC...]
  - Work [id=DEF...]
  - Shopping [id=GHI...]
  - Email Actions [id=JKL...]
```

The `(default)` marker indicates `EKEventStore.defaultCalendarForNewReminders`.

**Use when:** the agent needs to pick or validate a list before creating a reminder, or present a list menu to the user.

---

### `reminder_list_create`

Create a new reminder list (a new EKCalendar of type `.reminder`). Use only when the user has explicitly asked for a new list — the common case is adding items to an existing list, which doesn't need this tool.

**Args:**

| name | type | required | description |
|---|---|---|---|
| `name` | string | yes | User-visible title (e.g. "Conference Trip"). Uniqueness across lists isn't enforced by EventKit — duplicate titles are allowed but confusing; the agent should check `reminder_list_available` first. |
| `source` | string | no | EventKit `EKSource.title` — controls where the list is stored ("iCloud", "Local", etc.). Default: user's current default reminders source (typically iCloud, so the list syncs to iPhone). |

**Returns:** `Created list: <list_id> — "<name>"`.

**Errors:**

- `invalid_source` — named source doesn't exist or doesn't support reminders.

---

### `reminder_create`

Create a new reminder.

**Args:**

| name | type | required | description |
|---|---|---|---|
| `title` | string | yes | Short action description. |
| `notes` | string | no | Free-form details. For email todos, include message ID, account, sender, subject, proposed folder as JSON — same convention as the existing `todo_*` tools. |
| `due` | string | no | ISO-8601. Host interprets in the Mac mini's local timezone if no zone specified. Omit for no due date. |
| `priority` | `"high" \| "medium" \| "low"` | no | Default `"medium"`. Maps to EventKit priority (1 / 5 / 9). |
| `list` | string | no | List name **or** list_id. Default: the user's default reminders list. If a name is supplied and no such list exists, the call fails with `list_not_found` — agent should call `reminder_list_available` (to pick an existing one) or `reminder_list_create` (to deliberately create a new one) before retrying. |
| `parent_id` | string | no | Accepted in the schema for forward compatibility. **v1 rejects with `subtasks_unsupported`** — see [Subtasks](#subtasks--accepted-in-the-contract-not-supported-in-v1). |
| `alert` | string | no | ISO-8601 absolute time for a notification. If set, iOS will buzz the user at this time. Omit for a silent reminder (due date only, no notification). |
| `alert_before_due` | string | no | Relative alert — `"15min"`, `"1h"`, `"1d"`. Only meaningful when `due` is also set. Cannot be combined with `alert`. |

**Returns:** `Created: <id> — "<title>"`.

**Errors:**

- `list_not_found` — named list doesn't exist; call `reminder_list_available` or `reminder_list_create`.
- `subtasks_unsupported` — `parent_id` was set; v1 doesn't honor it (see [Subtasks](#subtasks--accepted-in-the-contract-not-supported-in-v1)).
- `invalid_due` — unparseable due string.
- `invalid_alert` — `alert` unparseable, or both `alert` and `alert_before_due` set, or `alert_before_due` set without `due`.
- `host_unreachable` — see [Error surface](#error-surface).

---

### `reminder_list`

Query reminders.

**Args:**

| name | type | required | description |
|---|---|---|---|
| `list` | string | no | Filter by list name or id. Omit for all lists. |
| `status` | `"pending" \| "completed" \| "recently_completed" \| "all"` | no | Default `"pending"`. `"recently_completed"` = completed within the last 24h (used by the reconciliation poll). |
| `include_notes` | bool | no | Default `false`. |
| `limit` | int | no | Default 100. |

**Returns:** text grouped by list, matching the current `todo_list` output format (so agent prompts don't need to change). Reminders render flat in v1 (no subtask indentation — see [Subtasks](#subtasks--accepted-in-the-contract-not-supported-in-v1)):

```
**Work** (3)
[ ] REM-abc: Prep Monday meeting (due 2026-04-25) [high]
[ ] REM-def: Reply to dean re: budget 🔔 2026-04-24 16:00
[x] REM-ghi: Send weekly digest  ✓ 2026-04-17 10:32

**Email Actions** (1)
[ ] REM-jkl: Confirm meeting time with Dr. Smith ⚠️ OVERDUE
```

Sort: overdue first, then by due date (earliest first, null last), then by priority (high → low). Alarms render as 🔔 followed by the alert time.

---

### `reminder_complete`

Mark a reminder as completed.

**Args:** `id` (string, required).

**Returns:** `Completed: "<title>"` or `Already completed: "<title>"`.

**Side effect:** sets `EKReminder.isCompleted = true`, `completionDate = now`. iCloud propagates the check to iPhone.

---

### `reminder_uncomplete`

Reverse a completion. Used when the user un-taps on iPhone and we detect it during reconciliation, or when the agent decides its earlier completion was wrong.

**Args:** `id` (string, required).

**Returns:** `Reopened: "<title>"`.

---

### `reminder_update`

Edit fields of an existing reminder.

**Args:** `id` (required) + any subset of `{title, notes, due, priority, list, parent_id, alert, alert_before_due}` (same types as `reminder_create`). Unspecified fields untouched. Pass empty string to clear `notes`; pass `null` (via JSON) to clear `due`, `parent_id` (detaches from parent), `alert`, or `alert_before_due`.

**Returns:** `Updated: "<title>"`.

---

### `reminder_delete`

Delete a reminder.

**Args:** `id` (string, required).

**Returns:** `Deleted: "<title>"`.

**Warning:** the iPhone Reminders app also syncs the delete. No recovery.

---

## Polling & reconciliation

The agent-side scheduler already polls for due scheduled tasks. We add a reconciliation task (every 30–60s; configurable via `REMINDERS_POLL_INTERVAL` env var, default 30s on the Mac mini) that:

1. Calls `reminder_list({ status: "recently_completed", limit: 50 })`.
2. For each newly-completed reminder whose id is tracked in a workflow state file (e.g. `email-triage/pending.json`), fires the completion handler (file the email, send confirmation, etc.).
3. Removes handled ids from the tracked set.

Un-completion (iPhone taps then un-taps) is detected the same way — if a tracked id flips from completed back to pending within the window, log it and do **not** undo the side effect by default. (Explicit undo is a future design question.)

Reminders created externally (Siri, iPhone Reminders app, another Mac) appear on `reminder_list` calls but have no tracked workflow state, so they're visible to the agent for queries but don't trigger automatic handlers.

---

## Error surface

All tools return standard MCP errors (`isError: true` with a text message) on failures. Specific error kinds the host may emit:

| code | meaning | agent action |
|---|---|---|
| `host_unreachable` | The container-side proxy can't reach `host.docker.internal:3002`. | Report to user; check launchd/Swift app status; no fallback. |
| `eventkit_denied` | macOS hasn't granted the host app EventKit access. | Tell the user to approve in System Settings → Privacy & Security → Reminders. |
| `list_not_found` | Named list doesn't exist. | Call `reminder_list_available` to pick, or `reminder_list_create` to make a new one. |
| `invalid_source` | `source` passed to `reminder_list_create` doesn't exist or doesn't support reminders. | Retry with a valid source name, or omit for default. |
| `not_found` | `id` doesn't exist. | Stale reference; re-query `reminder_list`. |
| `subtasks_unsupported` | `parent_id` was provided; v1 doesn't honor it. | Drop `parent_id` and create/update as a flat reminder. Encode hierarchy in `notes` if needed. |
| `invalid_due` | Unparseable `due`. | Retry with corrected ISO-8601. |
| `invalid_alert` | `alert` unparseable, both `alert` and `alert_before_due` set, or `alert_before_due` without `due`. | Pick one form; ensure `due` is set when using relative alerts. |
| `invalid_priority` | Not one of `high`/`medium`/`low`. | Retry with valid value. |

Host temporarily unreachable (e.g. Swift app restarting) should NOT cause workflow failures — the stdio proxy should return `host_unreachable` and the agent should treat reminder operations as soft-failing, informing the user. No silent retries at the tool layer.

---

## Subtasks — accepted in the contract, not supported in v1

The tool schema accepts `parent_id` on `reminder_create` and `reminder_update` so agent prompts can be written once and keep working when subtask support lands. **v1 rejects any call that sets `parent_id` with error `subtasks_unsupported`** — agents should handle that error cleanly and either fall back to flat reminders or ask the user to accept a flat list.

Reason: EventKit's public API does not expose the parent/child relationship. The iOS Reminders app uses private API for that. Options for real subtask support (all deferred to v1.1+):

- Shell out to `osascript` and drive Reminders.app via AppleScript.
- Adopt a newer EventKit API if Apple exposes one.
- Encode hierarchy in `notes` as a fallback (loses native iOS rendering).

When we pick a path, the tool contract doesn't need to change — the host just starts honoring `parent_id`.

## Intentional non-goals

- **Recurring reminders.** EventKit supports recurrence rules, but the tool surface doesn't expose them in v1. Agent can create a new reminder when the old one completes if recurrence is needed.
- **Location-based alarms.** Time alarms (`alert`, `alert_before_due`) are supported; location alarms ("alert when I arrive home") are not. Separate mechanism, rarely needed for agent-created reminders.
- **Subtasks / nested reminders.** See above — accepted in the schema, rejected at the host. Revisit in v1.1.
- **Shared lists / collaborators.** Read works if the user's Mac mini account has access; write requires the user to have write perms on the shared list. No special tooling for invitations.
- **Search by full-text on notes.** `reminder_list` filters by list + status only in v1. The agent can retrieve and filter client-side if needed.

---

## Why this shape

- **Tool names and formats mirror the current `todo_*` tools.** Agent prompts across `add-email-triage` and general task tracking won't need rewording.
- **`id` is opaque.** The EventKit identifier is stable across renames; using it instead of a title-based reference means renames on iPhone don't break the agent's workflow state.
- **`list_id` + `list_name` duality.** Users think in names; the system needs ids for correctness. Tools accept either.
- **Pull-only, fixed poll interval.** Keeps v1 simple and matches what EventKit-on-Mac makes cheap. Push can be added later (Option A in the design discussion) without changing this tool contract.
