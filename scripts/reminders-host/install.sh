#!/usr/bin/env bash
# reminders-host install: build, register launchd service, enable provider.
#
# Idempotent. Safe to re-run after a rebuild.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.nanoclaw.reminders-host.plist"
LABEL="com.nanoclaw.reminders-host"
BIN_PATH="$SCRIPT_DIR/.build/release/reminders-host"
LOG_DIR="$HOME/.nanoclaw/logs"
SENTINEL_DIR="$HOME/.nanoclaw/.reminders"
SENTINEL_FILE="$SENTINEL_DIR/enabled"

echo "==> Building reminders-host (release)"
(cd "$SCRIPT_DIR" && swift build -c release)

if [[ ! -x "$BIN_PATH" ]]; then
  echo "Build succeeded but binary not found at $BIN_PATH" >&2
  exit 1
fi

echo "==> Installing launchd plist → $PLIST"
mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BIN_PATH}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${LOG_DIR}/reminders-host.log</string>
    <key>StandardErrorPath</key><string>${LOG_DIR}/reminders-host.err</string>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

echo "==> Bootstrapping launchd service"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "==> Waiting for the service to come up"
for attempt in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3002/healthz >/dev/null; then
    echo "    ready on 127.0.0.1:3002 (attempt $attempt)"
    break
  fi
  sleep 0.5
  if [[ $attempt -eq 20 ]]; then
    echo "Service didn't respond within 10s. Check $LOG_DIR/reminders-host.err" >&2
    echo "You may need to approve the Reminders access prompt in System Settings." >&2
    exit 1
  fi
done

echo "==> Writing sentinel → $SENTINEL_FILE"
mkdir -p "$SENTINEL_DIR"
touch "$SENTINEL_FILE"

echo "==> Setting REMINDERS_HOST in .env if not already set"
ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  if ! grep -q '^REMINDERS_HOST=' "$ENV_FILE"; then
    echo 'REMINDERS_HOST=http://host.docker.internal:3002' >> "$ENV_FILE"
  fi
  if ! grep -q '^REMINDERS_POLL_INTERVAL=' "$ENV_FILE"; then
    echo 'REMINDERS_POLL_INTERVAL=30' >> "$ENV_FILE"
  fi
fi

echo
echo "Done. Smoke test:"
echo "  curl -s http://127.0.0.1:3002/lists | jq ."
echo
echo "Provider is enabled for the container on next agent run. If an agent was"
echo "already running, rebuild the container (./container/build.sh) or restart NanoClaw."
