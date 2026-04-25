---
name: email-taskfinder
description: Twice-daily cognitive pass. Walks new inbox mail, decides `{needs_task, sort_folder}` per email. Creates MS365 To Do tasks; logs a decision per email. Never moves or archives.
---

# /email-taskfinder — Cognitive Pass

## Two invocation modes

### (a) User-triggered from chat

Reply exactly one line: `Scanning inbox in the background — results soon.` Then enqueue `/email-taskfinder scan` as a once-task 60s in the future. One ack, one schedule, done.

### (b) Preclassifier-handoff (scheduled cron)

When the prompt contains `pre_resolved: N` and a numbered candidate list, bucket 1 and 2 are ALREADY DONE host-side. You only classify the listed candidates through buckets 3/4/5. Do NOT re-list the inbox; do NOT re-check skip_senders or action_templates. Use the `scan_run_id` from the prompt on every `log_triage_decision` call.

### (c) Direct scheduled task without preclassifier-handoff

Run the full cascade below. Generate a fresh `scan_run_id` = ISO timestamp at start.

### 1. Load state + rules — ONCE at scan start, minimal reads

```bash
cat /workspace/group/email-accounts.yaml
cat /workspace/group/email-archive/classification.yaml 2>/dev/null || cat /workspace/group/email-archive/rules.yaml
cat /workspace/group/email-archive/institutions.yaml 2>/dev/null || echo "institutions: []"
cat /workspace/group/email-archive/known_contacts.yaml 2>/dev/null || echo "known_contacts: []"
cat /workspace/group/email-archive/config.yaml | head -80   # taxonomy folders only
cat /workspace/group/email-triage/state/progress.yaml 2>/dev/null || echo "no progress"
```

Do NOT read `user-profile.md`, `tasks.json`, `filed.jsonl`, `decisions.jsonl`.

### 2. Fetch new-mail metadata — IDs + sender + subject only, no bodies

**Gmail:**

```bash
GWS_CREDENTIAL_STORE=plaintext gws gmail users messages list \
  --params '{"userId":"me","q":"in:inbox after:YYYY/MM/DD","maxResults":50}' \
  --format json
```

Derive `after:YYYY/MM/DD` from `progress.yaml.last_scan_date.gmail`; if missing, default to today.

**Outlook:** `mcp__ms365__list-mail-messages` with `$select=id,subject,from,conversationId,receivedDateTime` and `$filter=receivedDateTime ge <last_scan_date>`. Do NOT request bodies here.

### 3. Four-bucket cascade — first match wins, zero re-evaluation

Per email, in this order:

| #   | Bucket             | Check                                                                                                                                                                                                                                                           | Cost             | Action                                                                                                           |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `action_templates` | `from_address` AND any `subject_contains` match                                                                                                                                                                                                                 | zero LLM         | create task per template (substitute `{subject}`), or skip if `skip: true`                                       |
| 2   | `skip_senders`     | `from_address` or `from_domain` match                                                                                                                                                                                                                           | zero LLM         | log `decision=skip`, `sort_folder=<rule.folder>`, no body fetch                                                  |
| 3   | Solicited          | sender in `known_contacts` OR domain in `institutions` OR `conversationId` seen before in decisions.jsonl                                                                                                                                                       | body fetch + LLM | classify with the prompt below                                                                                   |
| 4   | Outreach           | ≥2 of: body<800 chars · personal greeting · scheduling keyword (coffee/meet/schedule/availability/touch base/follow up/great meeting) · no `List-Unsubscribe`/`Auto-Submitted`/`Precedence:bulk` · non-bulk sender (not `noreply@`/`info@`/`hello@`/`support@`) | body fetch + LLM | classify with the prompt below                                                                                   |
| 5   | Unsolicited        | anything not matched above                                                                                                                                                                                                                                      | label only       | apply `triage:archived` (Gmail label / Outlook category), `decision=label-only`, `sort_folder="triage:archived"` |

**Fetch bodies ONE AT A TIME** for bucket 3/4 only. Never batch bodies — each inflates context for every subsequent turn.

### 4. LLM prompt for buckets 3 and 4 (JSON-only output)

> Decide two things independently. Return JSON only.
> `needs_task` (bool): true if email creates a real obligation, deadline, action from someone with standing authority, contract/billing/legal/payroll/benefits/school/medical/government consequence, date-dependent ask, or ties to an existing project/account/application. Otherwise false. Test: "Will something bad happen if I do nothing?" If no → false.
> `sort_folder` (string): one exact value from the taxonomy. REQUIRED even when `needs_task=false`.
> `reasoning` (string): one concise sentence.
>
> Taxonomy: <inline folder list from email-archive/config.yaml>
>
> From: `<from>` | Subject: `<subject>` | Body: `<pre-fetched, noise-stripped, may include a "[…body truncated, N chars original]" marker>`
>
> Output exactly: `{"needs_task": ..., "sort_folder": "...", "reasoning": "..."}`

### 5. Task creation (when `needs_task=true`)

- Clean title: `<concise action> → /<account>/<sort_folder>` (arrow + slash-path preserved)
- `mcp__ms365__create-todo-task` — title from above, empty body, `dueDateTime` from body if present (weekday only; Fri/Sat/Sun → Mon), `importance=high` only if urgent keywords present.
- Sidecar: write metadata to `/workspace/group/email-triage/state/tasks.json` keyed by returned `task.id`. Use `mcp__nanoclaw__file_read` + `file_write`.

### 6. Decision logging — REQUIRED, once per email

Call `mcp__nanoclaw__log_triage_decision` with:

- `scan_run_id`, `email_id`, `account`, `sender`, `subject`
- `pass`: `template` | `skip` | `solicited` | `outreach` | `unsolicited`
- `decision`: `task` | `skip` | `label-only`
- `sort_folder` (always populated)
- `rule_matched` (template name, skip-sender glob, or the signals that fired)
- `reasoning` (one sentence)
- `task_id_created` (only on task creation)

### 7. State + summary

Write `/workspace/group/email-triage/state/progress.yaml`:

```yaml
last_scan_date: { gmail: '<ISO>', outlook: '<ISO>' }
last_scan_run_id: '<scan_run_id>'
```

Send exactly ONE summary via `mcp__nanoclaw__send_message`:

```
📬 Email Taskfinder — <scan_run_id>

Scanned: N   Tasks: N
Templated: N   Skip-rule: N   Solicited→task/skip: N/N   Outreach→task/skip: N/N   Unsolicited(labeled): N

<new tasks: one-per-line "• title"
```

Omit zero sections. If 0 scanned: `No new mail since last scan.`

## Hard limits

- NEVER move or archive emails (filing is a separate future skill)
- NEVER auto-delete; unsolicited bucket is label-only in v1
- If a single scan processes >100 emails or runs >5 min, STOP, log what's done, and send a truncated summary noting `[scan truncated]`
