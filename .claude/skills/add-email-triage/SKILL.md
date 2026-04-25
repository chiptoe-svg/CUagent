---
name: add-email-triage
description: Set up email triage — hourly inbox scanning that creates MS365 To Do tasks (or Apple Reminders if installed, or file-backed todos as a last resort) for actionable emails. Filing happens when the task is completed. Requires email accounts (/add-email-account) and archive config (/add-email-archive).
---

# Add Email Triage

Interactive setup for the email triage system. Configures hourly inbox scanning that identifies actionable emails and creates a to-do item for each one. When the user checks off the item (on iPhone via the Reminders app, in Microsoft To Do, in Outlook — anywhere), the scheduler's reconciliation poll picks it up and files the associated email.

**Prerequisites:**
- At least one email account registered (run `/add-email-account`)
- Email archive configured with taxonomy and rules (run `/add-email-archive`)
- A to-do surface. This skill assumes **MS365 Tasks** is the primary surface — it's what `/add-email-account` (MS365 path) sets up, and its tap-completes sync back to us through the MS365 reconciler. Apple Reminders is supported as an alternative if you prefer to keep tasks in iCloud and have installed `/add-apple-reminders` — but pick one; running both against the same email account leads to duplicate task items and duplicate filings when completed.

## Tool surface

Email triage uses **MS365 To Do** for new items via `mcp__ms365__create-todo-task` into the user's default task list (typically named `Tasks`). When the task is tap-completed on any Microsoft surface (Outlook, MS To Do, iOS Reminders Exchange list), `src/ms365-reconciler.ts` picks it up within ~5 min and enqueues the filing action.

**Clean titles + sidecar metadata.** The user-visible task title is of the form `<concise action> → /<account>/<folder>` (e.g. `Reply to Dr. Smith re: budget → /gmail/Sorted/Work`). The email-filing metadata (message id, sender, subject, proposed folder) lives in a sidecar JSON at `groups/<main>/email-triage/state/tasks.json`, keyed by task id. **Do not** stuff JSON into the task body — iOS Reminders renders body text as a second line under the title and it reads as noise.

If this install uses Apple Reminders instead (via `/add-apple-reminders`), the same clean-title + sidecar pattern applies into an "Email Actions" list, and `src/reminders-reconciler.ts` handles the completions via EventKit. Only one surface should be active at a time.

If MS365 is temporarily unreachable, fall back to the deprecated `mcp__nanoclaw__todo_create` (or Apple Reminders, if installed). Log the fallback so the user knows to re-enable MS365 once things are back.

## Phase 1: Prerequisites

### Check if already configured

```bash
MAIN_FOLDER=$(sqlite3 store/nanoclaw.db "SELECT folder FROM registered_groups WHERE is_main = 1 LIMIT 1;" 2>/dev/null)
echo "MAIN_FOLDER=${MAIN_FOLDER:-unknown}"
test -f "groups/${MAIN_FOLDER}/email-triage/config.yaml" && echo "CONFIGURED" || echo "NOT_CONFIGURED"
```

If `CONFIGURED`, show current config and ask whether to reconfigure or leave as-is.

### Check email accounts

```bash
test -f "groups/${MAIN_FOLDER}/email-accounts.yaml" && cat "groups/${MAIN_FOLDER}/email-accounts.yaml" || echo "NO_ACCOUNTS"
```

If `NO_ACCOUNTS`:
> No email accounts registered. Run `/add-email-account` first.

Stop here.

### Check archive config

```bash
test -f "groups/${MAIN_FOLDER}/email-archive/config.yaml" && echo "ARCHIVE_OK" || echo "NO_ARCHIVE"
test -f "groups/${MAIN_FOLDER}/email-archive/rules.yaml" && echo "RULES_OK" || echo "NO_RULES"
```

If either missing:
> Email archive not configured. Run `/add-email-archive` first — triage reuses the archive's taxonomy and sender rules.

Stop here.

## Phase 2: Configure

### Create directory structure

```bash
mkdir -p "groups/${MAIN_FOLDER}/email-triage/state"
```

### Choose accounts

Read the accounts from `email-accounts.yaml` and present:

> Which accounts should triage scan?
>
> 1. gmail (gws) — <user>@g.clemson.edu
> 2. outlook (ms365) — <user>@clemson.edu
>
> Default: all. Or pick specific ones.

Use `AskUserQuestion`.

### Configure settings

Ask the user to confirm or adjust:

> **Triage settings:**
>
> - **Scan frequency:** every hour (`0 * * * *`)
> - **Default due date:** 3 days from email receipt (for items without explicit deadlines)
> - **Todo list name:** "Email Actions"
>
> Want to change any of these?

Use `AskUserQuestion`.

### Write config

Write `groups/${MAIN_FOLDER}/email-triage/config.yaml`:

```yaml
# Email Triage Configuration
# Scans inbox hourly, creates todos for actionable emails
# Filing happens when todos are completed
# Shares taxonomy and rules with email-archive/

accounts:
  - gmail
  - outlook

schedule:
  scan_cron: "0 * * * *"
  timezone: "America/New_York"

reminders:
  list: "Email Actions"
  default_due_days: 1
  overdue_nag: true

classification:
  rules_path: "../email-archive/rules.yaml"

state_path: "state/"
```

### Initialize state

Write `groups/${MAIN_FOLDER}/email-triage/state/progress.yaml`:

```yaml
accounts:
  gmail:
    last_scan_date: null
    total_scanned: 0
    total_todos_created: 0
  outlook:
    last_scan_date: null
    total_scanned: 0
    total_todos_created: 0
stats:
  total_filed: 0
  total_skipped: 0
```

## Phase 3: Schedule

Set up the hourly scan:

```
Use schedule_task:
  schedule_type: "cron"
  schedule_value: "0 * * * *"
  context_mode: "isolated"
  prompt: "[SCHEDULED TASK] /email-triage scan"
```

## Phase 4: Rebuild and Done

```bash
./container/build.sh
```

> Email triage configured for N account(s).
>
> - Inbox scan: every hour
> - Todo list: "Email Actions"
> - Filing: manual (complete the todo to file the email)
>
> Commands:
> - `/email-triage` — scan new emails now
> - `/email-triage status` — view pending action items
> - `/email-triage file <id>` — complete a todo and file the email
>
> The first hourly scan will run at the next hour mark.
> Or send `/email-triage` now to scan immediately.
