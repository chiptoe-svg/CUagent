---
name: add-email-triage
description: Set up email triage — hourly inbox scanning that creates todo items for actionable emails. Filing happens when todos are completed. Requires email accounts (/add-email-account) and archive config (/add-email-archive) to be set up first.
---

# Add Email Triage

Interactive setup for the email triage system. Configures hourly inbox scanning that identifies actionable emails and creates todo items for them.

**Prerequisites:**
- At least one email account registered (run `/add-email-account`)
- Email archive configured with taxonomy and rules (run `/add-email-archive`)

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
