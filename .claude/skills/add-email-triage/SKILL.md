---
name: add-email-triage
description: Set up email triage — hourly inbox scanning that creates Apple Reminders for actionable emails. Filing happens when reminders are completed. Requires email accounts (/add-email-account), archive config (/add-email-archive), and the Apple Reminders host service installed (see docs/apple-reminders-mcp.md).
---

# Add Email Triage

Interactive setup for the email triage system. Configures hourly inbox scanning that identifies actionable emails and creates a reminder for each one. When the user checks off a reminder (on any device — iPhone, Reminders.app, etc.), the scheduler's reconciliation poll picks it up and files the associated email.

**Prerequisites:**
- At least one email account registered (run `/add-email-account`)
- Email archive configured with taxonomy and rules (run `/add-email-archive`)
- Apple Reminders MCP installed and the host service running — see `docs/apple-reminders-mcp.md`. If the host is unreachable the legacy file-backed `todo_*` tools keep triage alive as a fallback, but existing open `todos.json` items should be migrated with `todo_migrate_to_reminders` once the host is up.

## Tool surface (post-migration)

Email triage writes actionable items via `mcp__reminders__reminder_create` into a dedicated list (default: "Email Actions"). Each reminder's `notes` field stores the email metadata as JSON — message id, account, sender, subject, proposed folder — so the filing step has everything it needs without re-querying the inbox.

The older `todo_create` / `todo_list` / `todo_complete` / `todo_delete` tools still work but emit deprecation warnings. New installs should use the `reminder_*` surface exclusively; pre-existing installs should run `todo_migrate_to_reminders` once after standing up the host service.

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
> 1. gmail (gws) — tonkin@g.clemson.edu
> 2. outlook (ms365) — tonkin@clemson.edu
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
