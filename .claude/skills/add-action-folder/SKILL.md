---
name: add-action-folder
description: Configure a root-level mail folder as an "action folder" — drag an email into it and the action-folder watcher creates a To Do task automatically (deterministic, zero LLM cost). Completing the task files the email via the standard reconciler. Runs once per email account (typically Gmail + Outlook).
---

# Add Action Folder

Sets up deterministic "drag → task" handling. You drop a mail in the configured folder; a host-side poll notices and creates a To Do. When you tap-complete the task, the existing reconciler files the email per archive rules.

**Why this skill exists.** The LLM-driven triage in `/email-triage` costs real money per scan. For anything YOU can identify as actionable (subs requests, things to sign, recurring forms) the LLM adds nothing — it just burns tokens. A folder-watcher turns the obvious cases into a one-drag, zero-token flow.

**What gets asked:**
- Folder name for Gmail (or skip if no Gmail account).
- Folder name for Outlook / MS365 (or skip if no MS365 account).

Both are root-level folders by default (e.g. `Action Required`, not `Sorted/Action Required`). Rationale: keeps them visible in the mail app sidebar and reinforces "inbox-zero-adjacent" behavior.

## Phase 1: Pre-flight

### Check prerequisites

The watcher runs in the NanoClaw host process (see `src/action-folder-watcher.ts`). It's active the moment the config file exists. Required:

- Email accounts registered (`email-accounts.yaml`) — run `/add-email-account` first if missing.
- At least one of: Gmail (`gws` CLI) or MS365 tokens available.
- `/add-email-triage` already run — the action-folder watcher writes to the same sidecar (`email-triage/state/tasks.json`) that the triage skill uses.

### Resolve the main group folder

```bash
sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main = 1 LIMIT 1;"
```

## Phase 2: Configure per account

Ask the user which accounts to configure. For each:

### Gmail (if registered)

Ask: **"What folder name would you like to use for Gmail action items? (leave blank to skip Gmail; common choice: 'Action Required')"**

If they provide a name:
1. Gmail treats folders as labels. Create the label if it doesn't exist:
   ```bash
   GWS_CREDENTIAL_STORE=plaintext gws gmail labels +triage create "<NAME>" 2>&1 || echo "(label may already exist — that's fine)"
   ```
2. Record it for the config (see Phase 3).

### MS365 (if registered)

Ask: **"What folder name would you like to use for Outlook/MS365 action items? (leave blank to skip; common choice: 'Action Required')"**

If they provide a name:
1. Look up the folder ID. Create it first if needed:
   ```
   Call mcp__ms365__list-specific-mail-folder with name=<NAME> at root (parentFolderId=msgfolderroot).
   If not found, call mcp__ms365__create-specific-mail-folder with displayName=<NAME> under msgfolderroot.
   Capture the returned folder `id`.
   ```
2. Record both the id and display name.

## Phase 3: Write config

Resolve `MAIN_FOLDER` from the DB. Write to `groups/${MAIN_FOLDER}/email-triage/action-folders.yaml`:

```yaml
# Root-level action folders. The action-folder watcher
# (src/action-folder-watcher.ts) polls these every 30s (ACTION_FOLDER_INTERVAL)
# and creates MS365 To Do tasks for new messages — zero LLM involvement.
# Completing a task in MS To Do / Outlook / iOS Reminders fires the
# existing ms365-reconciler which files the email per archive rules.

ms365:
  folder_id: "<MS365 FOLDER ID>"
  folder_name: "Action Required"

# gws support is planned — when added, the stanza will be:
# gws:
#   label: "Action Required"
```

Omit stanzas for accounts the user skipped. If the user only configured Gmail for now, write a header comment noting that the gws branch of the watcher isn't implemented yet and the label alone won't activate anything until it is.

## Phase 4: Verify

1. Confirm the config file exists and is valid YAML:
   ```bash
   cat "groups/${MAIN_FOLDER}/email-triage/action-folders.yaml"
   ```
2. Restart NanoClaw so the watcher picks up the config:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
3. Ask the user to drag a single test email from inbox into the Action folder on either Outlook web or their phone, then wait ~45 seconds and:
   ```bash
   grep "action-folder: created task" logs/nanoclaw.log | tail -3
   ```
   Expect one line per dropped email. Confirm a new task appeared in the user's default "Tasks" list.

## Troubleshooting

### No task shows up after dragging mail

Check the log:

```bash
tail -30 logs/nanoclaw.log | grep -i "action-folder"
```

Common causes:
- **Config not loaded** — `action-folders.yaml` has wrong path or invalid YAML. The parser is permissive; run `node -e "console.log(require('fs').readFileSync('groups/${MAIN_FOLDER}/email-triage/action-folders.yaml','utf8'))"` to confirm contents.
- **Stale folder_id** — folder was renamed/recreated after setup. Re-run this skill.
- **MS365 token expired** — `/tasks` in Telegram will say "Microsoft 365 is not connected"; re-run `/auth`.

### Task shows up but with the wrong title

Titles are `<subject> → /outlook/<folder>`. If the email had no subject, you'll see `(no subject) → /outlook/Action Required`. Clean up the task manually and drag the email back out + in with a subject next time — the watcher doesn't re-title existing tasks.

### Creating duplicate tasks for the same email

The seen-set (`data/action-folder-seen.json`) is the source of truth. If it got deleted, the watcher will re-create tasks for every message in the folder. Remedy: let it complete one full pass (cap ~50 per tick), then tap-complete the duplicates.

## Removal

Delete `groups/${MAIN_FOLDER}/email-triage/action-folders.yaml` and restart NanoClaw. The watcher self-disables (no config → noop each tick). Nothing else to uninstall — all persistence is that one file + a seen-set in `data/`.

## Operational notes

- **Polling interval** defaults to 30s. Tune via `ACTION_FOLDER_INTERVAL` (seconds) in `.env` if you want faster drop→task feedback.
- **Batch limit** is 50 messages per tick. If you drop a huge backlog into the folder, it'll drain over multiple ticks.
- **Gmail is planned, not shipped.** MS365 watcher only for now — if you configured a Gmail folder, the YAML has the name but no behavior attaches to it yet.
