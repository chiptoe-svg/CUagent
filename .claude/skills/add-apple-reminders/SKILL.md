---
name: add-apple-reminders
description: Add Apple Reminders as a first-class MCP tool surface. Installs a host-side Swift app that bridges HTTP → EventKit, a container-side stdio MCP proxy, a reconciliation poll that fires email-filing when the user tap-completes a reminder on iPhone, and a one-shot migration from the legacy file-backed todo_* tools. Triggers on "add apple reminders", "apple reminders mcp", "ios reminders", "reminders integration".
---

# Add Apple Reminders

Exposes Apple Reminders to the agent as `mcp__reminders__*` tools. Reminders created by the agent appear in the user's Reminders.app and sync to iPhone/iPad via iCloud. When the user tap-completes a reminder on their phone, a host-side reconciliation poll picks it up and enqueues a filing action — this is what makes the email-triage "check it off on my phone and the email files itself" flow work.

**Design decisions** live in `docs/apple-reminders-mcp.md`:
- Pull-only in v1 (polling, not push). Fine for email-triage latency.
- State comes from the reminder's own `notes` field — no separate `pending.json`.
- Subtasks accepted in the schema for forward compat, but rejected at the host with `subtasks_unsupported` (EventKit public API doesn't expose parent/child).

## Phase 1: Pre-flight

### Check if already applied

Check whether the core files exist:

- `container/providers/reminders.json`
- `container/agent-runner/src/mcp-reminders.ts`
- `container/agent-runner/src/host-fetch.ts`
- `scripts/reminders-host/Package.swift`
- `src/reminders-reconciler.ts`

If all five are present, the code is already applied — skip to **Phase 3: Setup**.

### Ask the user

Use `AskUserQuestion` to collect:

- Will this run on a Mac that has iCloud signed in with Reminders enabled? (Required — without iCloud, reminders stay on that Mac and never reach iPhone.)
- Do they want the default 30-second reconciliation poll interval, or something else?

## Phase 2: Apply Code Changes

The reminders code lives on the `apple-reminders-skill` branch of this repo. Merging that branch installs:

- `container/providers/reminders.json` — provider config (sentinel-gated on `~/.nanoclaw/.reminders/enabled`)
- `container/agent-runner/src/mcp-reminders.ts` — in-container stdio MCP proxy
- `container/agent-runner/src/host-fetch.ts` — shared HTTP helper used by the proxy and the migration tool
- `container/agent-runner/src/ipc-mcp-stdio.ts` — adds the one-shot `todo_migrate_to_reminders` tool to the nanoclaw MCP
- `scripts/reminders-host/` — Swift Hummingbird REST app bridging HTTP → EventKit
- `src/reminders-reconciler.ts` — host-side poll + wiring in `src/index.ts`
- `docs/apple-reminders-mcp.md` — tool-surface contract

### Merge the skill branch

```bash
git checkout main
git fetch origin
git merge origin/apple-reminders-skill || {
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json 2>/dev/null
  git merge --continue
}
```

If the merge reports conflicts, read the conflicted files and understand the intent of both sides before resolving.

If this skill is ever extracted to a standalone repo, add it as a remote and merge from there instead (same pattern as other channel skills).

### Validate

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Install and start the Swift host

```bash
bash scripts/reminders-host/install.sh
```

This script:
1. Builds the Swift app (`swift build -c release`).
2. Registers it under launchd at `com.nanoclaw.reminders-host`.
3. Triggers the first-run EventKit permission prompt — **approve it when it pops up** (click Allow in the macOS dialog).
4. Health-checks the service.
5. Writes the sentinel `~/.nanoclaw/.reminders/enabled` so the container provider-registry picks it up.
6. Appends `REMINDERS_HOST` and `REMINDERS_POLL_INTERVAL` to `.env` if missing.

Verify:

```bash
curl -s http://127.0.0.1:3002/healthz       # → OK
curl -s http://127.0.0.1:3002/lists | jq .  # lists your reminder lists with source field
```

### iCloud must be enabled for Reminders

Open System Settings → Apple ID → iCloud and ensure "Reminders" is toggled on. Otherwise every reminder the agent creates stays Mac-local and never reaches the iPhone.

Confirm with:

```bash
curl -s http://127.0.0.1:3002/lists | jq '.[] | {name, source}'
```

At least one list should have `"source": "iCloud"`. If every source says "Local", iCloud isn't enabled for Reminders on this Mac.

### Rebuild and restart the container runtime

The Apple Reminders code includes new TypeScript sources that need to be compiled and baked into the container image, plus provider JSON the host registry needs:

```bash
# Fresh-copy the provider JSON into the runtime dir
cp container/providers/reminders.json ~/.nanoclaw/providers/

# Rebuild the container image
./container/build.sh

# Stop any running containers so the next message spawns fresh
docker ps --filter "name=nanoclaw-" -q | xargs -r docker stop

# Restart NanoClaw itself (picks up the new reconciler + provider registry)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Verify the container sees the tools

Send any Telegram message, wait ~10s, then:

```bash
CID=$(docker ps --filter "name=nanoclaw-" -q | head -1)
docker exec "$CID" cat /home/node/.codex/config.toml | grep -A3 'mcp_servers.reminders'
```

Should show:

```
[mcp_servers.reminders]
type = "stdio"
command = "node"
args = ["/tmp/dist/mcp-reminders.js"]
```

### Migrate existing todos (if any)

If the user was using the old `todo_*` tools, migrate their open items into Apple Reminders — the agent can do this via the MCP tool:

Tell the user:
> In Telegram, say: "Run `todo_migrate_to_reminders` with dry_run: true first to preview, then run it for real if the list looks right."

The tool will POST each open todo to the reminders host, create a matching reminder, and (on clean success) archive `todos.json` → `todos.json.migrated`.

## Phase 4: Verify end-to-end

Ask the user to:

1. In Telegram: *"remind me at 5pm to test the apple reminders bridge"*
2. Confirm the reminder appears in the iOS Reminders app within seconds.
3. Tap-complete it on the iPhone.
4. Watch the reconciler catch it:
   ```bash
   tail -f logs/nanoclaw.log 2>/dev/null | grep -iE 'reconcile|reminder'
   ```
   Expect: `reminders reconciler starting` on boot, and `enqueued email-filing task from completed reminder` after tap-complete (or for test reminders without email metadata, the reconciler silently tracks the completion and moves on — also correct).

## Troubleshooting

### Agent says "I don't have Apple Reminders tools"

Container didn't see the provider. Cause is almost always one of:

- **Sentinel missing.** `ls -la ~/.nanoclaw/.reminders/enabled`. If absent: `mkdir -p ~/.nanoclaw/.reminders && touch ~/.nanoclaw/.reminders/enabled`.
- **Stale provider copy.** `~/.nanoclaw/providers/reminders.json` was written by a previous version and points at the wrong path. Fix: `cp container/providers/reminders.json ~/.nanoclaw/providers/`.
- **Stale session cache.** Per-group agent-runner-src wasn't refreshed when new files were added. Fix: `rm -rf data/sessions/*/agent-runner-src && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

After any of those fixes, kill the running container and send a fresh Telegram message to respawn:

```bash
docker ps --filter "name=nanoclaw-" -q | xargs -r docker stop
```

### Agent picks `schedule_task` instead of `reminder_create`

For "remind me at 8pm" phrasing, the agent may pick `schedule_task` (schedule the agent to run at 8pm and send a message) instead of `reminder_create` (put a reminder in the user's Reminders app). The reminders provider's `agentDocs` includes an explicit disambiguation, but if you tune it further, edit the `agentDocs` block in `container/providers/reminders.json`.

### Host is up but POSTs fail

Check the Swift host's stderr:

```bash
tail -30 ~/.nanoclaw/logs/reminders-host.err
```

`eventkit_denied` → user hasn't approved the Reminders privacy prompt. Go to System Settings → Privacy & Security → Reminders and enable `reminders-host`, then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw.reminders-host`.

### Reminder created but doesn't show on iPhone

- Check Reminders.app **on the Mac** first. If it's there, it's an iCloud sync issue.
- `curl -s http://127.0.0.1:3002/lists | jq '.[] | select(.isDefault) | {name, source}'` — the default list must have `"source": "iCloud"`. If it says `"Local"` or `"Exchange"`, the reminder syncs to that account, not iPhone Reminders.
- Set a different default in Reminders.app → Settings → Default List, or explicitly pass `list: "<iCloud list name>"` when creating.

### Subtasks silently don't work

Known v1 limitation — the tool schema accepts `parent_id` but the host rejects with `subtasks_unsupported`. Reason: EventKit's public API doesn't expose the parent/child relationship. Documented in `docs/apple-reminders-mcp.md#subtasks`. Revisit in v1.1 via AppleScript bridge or newer EventKit API.

## Removal

```bash
# Revert the skill merge
git log --merges --grep='apple-reminders' -n 1
git revert -m 1 <merge-commit-sha>

# Stop and unregister the Swift host
launchctl bootout "gui/$(id -u)/com.nanoclaw.reminders-host" 2>/dev/null
rm ~/Library/LaunchAgents/com.nanoclaw.reminders-host.plist

# Remove local state
rm -rf ~/.nanoclaw/.reminders ~/.nanoclaw/providers/reminders.json
rm -f data/reminders-reconciled.json

# Rebuild and restart
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

EventKit permission (Privacy & Security → Reminders → `reminders-host`) can be revoked in System Settings when done.

## Operational notes

- **The reconciler polls every 30s by default.** Tune via `REMINDERS_POLL_INTERVAL` (seconds) in `.env`. Lower values make tap-complete → email-filing feel near-instant at negligible cost on a Mac mini.
- **The Mac running NanoClaw must be the same Mac whose iCloud account owns the reminders.** iPhone ↔ Mac sync is via iCloud; the Swift host reads EventKit on the local user account.
- **Migration is one-shot.** After `todo_migrate_to_reminders` runs cleanly, `todos.json` is archived to `todos.json.migrated`. Safe to re-run — it only migrates open items and becomes a no-op once everything is moved.
- **The deprecated `todo_*` tools keep working** as a fallback when the reminders host is unreachable. This means triage doesn't break if you reboot the Mac or the Swift app crashes.
