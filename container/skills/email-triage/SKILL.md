---
name: email-triage
description: Scan inbox for actionable emails, create MS365 To Do tasks (or Apple Reminders as fallback) for things needing response or action, and file emails when the task is completed. Use /email-triage to scan now, /email-triage status for pending items.
---

# /email-triage — Email Triage

Scan inbox emails, identify actionable items, create MS365 To Do tasks for them (with Apple Reminders and the deprecated file-backed `todo_*` as fallbacks). Filing happens when the task is completed — either by the agent on user request ("mark it done") or by the user tap-completing on their iPhone / in Outlook / in Microsoft To Do (picked up by the host-side reconciliation polls for both surfaces).

## Modes

Parse the user's command:
- `/email-triage` or `/email-triage scan` → **Scan mode**
- `/email-triage status` → **Status mode**
- `/email-triage file <task-id>` → **File mode** (complete task + file email)

If this is a scheduled task (message starts with `[SCHEDULED TASK`), run scan mode directly.

## Prerequisites

```bash
test -f /workspace/group/email-accounts.yaml && echo "ACCOUNTS_OK" || echo "NO_ACCOUNTS"
test -f /workspace/group/email-archive/config.yaml && echo "ARCHIVE_OK" || echo "NO_ARCHIVE"
test -f /workspace/group/email-triage/config.yaml && echo "TRIAGE_OK" || echo "NO_TRIAGE"
```

If `NO_ACCOUNTS`: "No email accounts. Run `/add-email-account` first."
If `NO_ARCHIVE`: "No archive config. Run `/add-email-archive` first (need taxonomy and rules)."
If `NO_TRIAGE`: "Triage not configured. Run `/add-email-triage` to set up."

## Load Configuration

Load ONLY the files you need to decide what to do this scan. Skip anything you can look up lazily — each extra file read compounds in the context window for the rest of the turn, and a single scan can push 100k+ input tokens into every subsequent LLM call.

```bash
cat /workspace/group/email-accounts.yaml
cat /workspace/group/email-archive/rules.yaml
cat /workspace/group/email-triage/state/progress.yaml 2>/dev/null || echo "no progress yet"
```

**Do NOT front-load** `user-profile.md`, `filed.jsonl`, `tasks.json`, `email-triage/config.yaml`, or `email-archive/config.yaml` at scan time. They are either large or irrelevant to the classification decision. If you actually need something from them mid-scan (e.g. a taxonomy folder mapping), read only the specific field then. `tasks.json` is the sidecar you WRITE to at the end — don't read it at scan start.

## Scan Mode

### Delegation — REQUIRED

**When invoked from a user message (not a scheduled task), ALWAYS delegate to a background task.** Do NOT run inline — scanning blocks the conversation.

1. Acknowledge: "Scanning inbox for new actionable emails..."
2. Schedule a one-time immediate task:
   - `schedule_type`: "once"
   - `schedule_value`: 1 minute from now
   - `prompt`: "/email-triage scan"
3. Return control to the user

### Scan Pipeline (when running as scheduled task)

**Cost invariant:** every email classified by the LLM costs real money. Emails resolvable by rule should never reach the LLM. Emails resolvable by sender+subject should never have their body fetched. Target: <20% of scanned emails reach full-body LLM classification.

**Decision logging — REQUIRED.** For every email you evaluate (including ones that don't become tasks), call `mcp__nanoclaw__log_triage_decision` once. This is the basis for benchmarking — without it we can't compare your classifications against ground truth or judge whether a cheaper model could have handled a given email. The logging tool never throws; log and keep going even if a call warns. Generate a `scan_run_id` once at the start of the scan (use the ISO timestamp) and pass it on every call so the full scan is analysable as a group.

1. **Load state + rules (ONCE at scan start)** — read only these:
   - `email-triage/state/progress.yaml` for `last_scan_date` per account
   - `email-archive/rules.yaml` for sender-classified rules
   - `email-accounts.yaml` for enabled accounts

2. **Fetch minimal email metadata** per account — subject + sender + id only, no body:

   **gws:**
   ```bash
   GWS_CREDENTIAL_STORE=plaintext gws gmail +triage --query "in:inbox newer_than:1d" --max 50 --format json
   ```

   **ms365:** `mcp__ms365__list-mail-messages` with `$select=id,subject,from,receivedDateTime` and `$filter` for since-last-scan. Do NOT request bodies at this stage.

3. **Three-pass classification — stop at the first pass that resolves each email:**

   **Pass A — rules-only (ZERO LLM cost).** For each email, check the sender against `email-archive/rules.yaml`:
   - Matches a **non-actionable** category (Newsletters, Accounts, Notifications, To Delete) → **SKIP IMMEDIATELY.** Do NOT add the email to further reasoning; it's not actionable. Don't fetch body. Don't count it against the LLM quota. Call `log_triage_decision` with `pass="A"`, `decision="skip"`, `rule_matched="<Category>:<sender-glob>"`.
   - Matches an **actionable** category (Work, Personal) → mark as `candidate`, proceed to Pass B. (Log after Pass B resolves.)
   - **No rule matches** → mark as `unknown`, proceed to Pass B.

   Emit one log line like `Pass A: skipped N newsletters/digests, M candidates, K unknown` so the cost report can attribute savings.

   **Pass B — sender+subject classification (bounded LLM cost).** Only `candidate` and `unknown` items reach this pass. In ONE turn, classify each using just sender + subject:
   - **Obviously actionable** (direct request, signed-for items, meeting invites that need response, deadlines in subject) → proceed to Pass C for body fetch.
   - **Obviously skip** (unsubscribe-only footer senders not already in rules.yaml, auto-replies, bounces) → skip; if the pattern recurs, suggest a rule via `email-archive/rules.yaml` in the final summary. Call `log_triage_decision` with `pass="B"`, `decision="skip"`, and a one-sentence `reasoning`.
   - **Uncertain from subject alone** → proceed to Pass C.

   **Pass C — body-aware classification (most expensive).** Only items that survived Pass B reach here. Fetch bodies ONE AT A TIME (not all at once — each body inflates the context for every subsequent call) and decide:
   - **Clearly actionable** → create task (step 4). After creation, log with `pass="C"`, `decision="actionable"`, `task_id_created=<id>`, and `reasoning`.
   - **Clearly not actionable** → skip. Log with `pass="C"`, `decision="skip"`, `reasoning`.
   - **Uncertain** → add to uncertain list (reported in summary). Log with `pass="C"`, `decision="uncertain"`, `reasoning`.

   If Pass A drops 60–80% of emails with zero tokens and Pass B drops another ~half of the rest without bodies, the scan should land under ~$0.10 at default model.

4. **Create a to-do item** for actionable emails. Preferred surface: **MS365 To Do** (tasks sync to iOS Reminders via the Exchange account and the user works out of MS365). The task the user SEES must never contain raw JSON metadata — that goes in a sidecar file.

   **a. Build the metadata dict** you'll persist to the sidecar:
   ```json
   {
     "email_id": "MSG_ID",
     "account": "gmail",
     "from": "<faculty>@clemson.edu",
     "subject": "Budget meeting",
     "folder": "Sorted/Work"
   }
   ```

   **b. Build the clean title.** Format: `<concise action> → /<account>/<folder>`. Keep the arrow (`→`) and slash-delimited path exactly as shown so the user can scan destinations at a glance.
   - Example: `Reply to Dr. Smith re: budget meeting → /gmail/Sorted/Work`
   - `<account>` is the short form (`gmail`, `outlook`, or `ms365` — match the account's `type`).
   - `<folder>` is the proposed filing folder (preserve case; don't invent hierarchy).

   **c. Call `mcp__ms365__create-todo-task`** with:
   - `title`: the clean title from (b). **Never put JSON in the title.**
   - `body`: **leave empty** (`{"content": "", "contentType": "text"}` or omit). All metadata lives in the sidecar now.
   - `dueDateTime`: extracted from email content if present (e.g., "by Friday", "due April 18", "deadline tomorrow"), otherwise next business day (skip weekends — Friday defaults to Monday, Saturday/Sunday default to Monday). Provide as an object with `dateTime` and `timeZone` per Graph's requirements.
   - `importance`: `high` if urgent signals, `normal` otherwise.
   - List: the user's default To Do list (named `Tasks` on this install). Call `mcp__ms365__list-todo-lists` once at setup time to get the `listId`.

   Capture the returned task `id`.

   **d. Persist the metadata to the sidecar at `/workspace/group/email-triage/state/tasks.json`.** Use `mcp__nanoclaw__file_read` + `mcp__nanoclaw__file_write` (or `bash` with `jq`/`python`). The file is a single JSON object keyed by task id:
   ```json
   {
     "AAMkAD...task-id-1": {"email_id": "...", "account": "gmail", ...},
     "AAMkAD...task-id-2": {...}
   }
   ```
   Create `email-triage/state/` if it doesn't exist. Read the current JSON (or `{}` if the file doesn't exist), set `obj[task.id] = metadata`, write back atomically.

   **e. If writing the sidecar fails**, fall back to the legacy convention: call `mcp__ms365__update-todo-task` to put the metadata JSON in the task's `body`. The reconcilers can still parse it from there. Warn the user so they can investigate the filesystem issue.

   **f. Fallback surface** when MS365 itself is unreachable (token expired, Graph 5xx): `mcp__nanoclaw__todo_create` (deprecated file-backed) as a last resort. If Apple Reminders has been installed on this system via `/add-apple-reminders`, `mcp__reminders__reminder_create` is also acceptable — but don't assume it's present; check `list_mcp_resources` first. Surface the underlying error to the user whenever you fall back.

5. **Update state** — save `last_scan_date` per account

6. **Send summary** via `mcp__nanoclaw__send_message`:
   ```
   📬 Email Triage Scan

   Scanned: N new emails (N Gmail, N Outlook)
   New action items: N
   Skipped (known non-actionable): N

   Uncertain — want reminders for any of these?
   • "Re: Q3 budget projections" from <colleague>@clemson.edu
   • "Meeting notes from Tuesday" from <dept-list>@clemson.edu

   Pending reminders: N total (N overdue)

   View all: /email-triage status
   ```

   Only include the "Uncertain" section if there are uncertain emails. If no new emails found, send a brief "No new emails since last scan."

## File Mode

When the user says something like "mark the Smith email as done" or `/email-triage file <task-id>`, or when a reconciliation poll detects a completion:

- **MS365 reconciler** (`src/ms365-reconciler.ts`) polls Graph for `status eq 'completed'` tasks and fires this mode with the task's body parsed from JSON.
- **Apple Reminders reconciler** (`src/reminders-reconciler.ts`) polls EventKit's `recently_completed` reminders and fires this mode with the reminder's notes parsed from JSON.

Steps:

1. **Look up the to-do item** only if invoked manually — the reconcilers pass the parsed metadata directly in the prompt.
   - MS365: `mcp__ms365__list-todo-tasks` (filter by id)
   - Apple: `mcp__reminders__reminder_list` (list: "Email Actions")
2. **Get the metadata**: first check the sidecar at `/workspace/group/email-triage/state/tasks.json` keyed by the task/reminder id — that's the canonical source. Fall back to parsing JSON from the task body / reminder notes only for legacy items (pre-2026-04-19, before the sidecar convention).
3. **Move the email** to the folder:

   **gws_mcp** (preferred — structured MCP tools):
   ```
   Call mcp__gws_mcp__move_gmail_message (or similar) with the message ID and destination label.
   ```

   **gws** (legacy CLI fallback):
   ```bash
   GWS_CREDENTIAL_STORE=plaintext gws gmail users messages modify --params '{"id":"MSG_ID"}' --json '{"addLabelIds":["LABEL_ID"],"removeLabelIds":["INBOX"]}'
   ```

   **ms365:**
   ```
   Call mcp__ms365__move-mail-message with the message ID and destination folder ID.
   ```

   Look up folder/label IDs from `email-archive/config.yaml` (`archive_accounts[].folder_ids`).

4. **Mark the to-do item complete** — skip if the user already tap-completed on their phone (that's how the reconciler saw it). Only needed when the agent is closing the loop itself:
   - MS365: `mcp__ms365__update-todo-task` with `status: 'completed'`
   - Apple: `mcp__reminders__reminder_complete`
5. **Log the filing** — append to `email-triage/state/filed.jsonl`:
   ```json
   {"timestamp": "ISO", "email_id": "...", "account": "...", "folder": "...", "task_id": "..."}
   ```
6. **Clean up the sidecar** — remove `tasks.json[task_id]` so it doesn't grow unboundedly. Safe to skip if the filing failed; the next completion will overwrite.
7. **Confirm** only if the user triggered it manually: "Filed 'Budget meeting' → Sorted/Work. Task completed." Reconciler-triggered filings should run silently (no chat message).

## Status Mode

1. **List pending tasks** on whichever surface was used during scan:
   - MS365 (default): `mcp__ms365__list-todo-tasks` with `status eq 'notStarted' or status eq 'inProgress'`, scoped to the `Tasks` list
   - Apple Reminders (fallback): `mcp__reminders__reminder_list` (list: "Email Actions", status: "pending")
   - Legacy: `mcp__nanoclaw__todo_list`
2. **Read state** for scan stats
3. **Report:**

   ```
   📊 Email Triage Status

   Pending actions (MS365 Tasks):
   [ ] Reply to Dr. Smith re: budget (due Apr 14) ⚠️ overdue
   [ ] Review contract from Legal (due Apr 16)
   [ ] Submit expense report (due Apr 18)

   Last scan: 45min ago
   Filed today: N emails

   Complete an item: /email-triage file <task-id>
   Or tell me: "mark the Smith email as done"
   ```

## Constraints

- **Triage NEVER auto-files emails** — only on explicit todo completion
- **Non-actionable emails stay in inbox** — handled by `/email-archive` runs
- **Agent can complete reminders** when the user instructs (e.g., "mark it done", "I replied to Smith"). The agent can also leave the reminder alone and wait for the user to tap-complete on their iPhone — the reconciliation poll will catch it.
- **NEVER auto-delete emails**
- **NEVER send emails** on the user's behalf without explicit instruction
- **Provider-agnostic** — all email operations use provider reference from `/add-email-account`
- **Save state after each operation** — crash-safe
