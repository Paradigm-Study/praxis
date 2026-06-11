#!/usr/bin/env bash
# Install (or remove) the launchd LaunchAgent that starts Praxis.app at login.
#
#   scripts/install-launchagent.sh             install + start now
#   scripts/install-launchagent.sh --uninstall stop + remove
#
# The plist bakes in PRAXIS_HOME (this repo) and PRAXIS_NODE (your node binary)
# so the app works from launchd's minimal environment.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

LABEL=com.paradigm.praxis
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_BIN="$ROOT/dist/Praxis.app/Contents/MacOS/praxis-bar"
UID_NUM=$(id -u)

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ uninstalled ($LABEL)"
  exit 0
fi

if [ ! -x "$APP_BIN" ]; then
  echo "dist/Praxis.app not found — run: npm run app:package" >&2
  exit 1
fi

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${APP_BIN}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRAXIS_HOME</key><string>${ROOT}</string>
    <key>PRAXIS_NODE</key><string>${NODE_BIN}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>${ROOT}/data/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/data/logs/launchd.log</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

# Restart cleanly if already loaded, then bootstrap into the user's GUI session.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

sleep 1
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 && pgrep -q praxis-bar; then
  echo "✓ installed and running — Praxis is in your menu bar (and will start at login)"
  echo "  uninstall: npm run app:uninstall"
else
  echo "⚠ installed, but the agent doesn't look alive — check $ROOT/data/logs/launchd.log" >&2
  exit 1
fi
