#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
E="$ROOT/.omo/evidence/caret-clone-redesign/final/f3-manual-qa-native-visual"
SEG="$ROOT/.omo/evidence/caret-clone-redesign/final/f3-manual-qa-segmented"
APP="$HOME/Applications/Meeting Slides.app"
EXEC="$APP/Contents/MacOS/meeting-slides"
MARKER="$APP/Contents/Resources/project-path.txt"
PORT=54745
EXPECTED=dddc34ffa7d7776daf183ae5c601d4c28a578f81c8fb3ac2543a6e01d2b34a7c
TMP="$(mktemp -d /tmp/f3-native-visual.XXXXXX)"
PROJECT="$TMP/project"
RECEIPT="$E/server-receipts.jsonl"
SERVER_PID=""
APP_PID=""
DEFAULTS_BEFORE="$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)"
mkdir -p "$PROJECT" "$E/screenshots" "$E/windows" "$E/actions"
cp "$MARKER" "$TMP/marker.before"

hash_preserved() {
  local out="$1"
  (cd "$SEG" && find build segment-a-browser segment-c-quit segment-d-launcher terminal -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) > "$out"
}
restore_defaults() {
  if [[ -n "$DEFAULTS_BEFORE" ]]; then
    local x y w h
    x="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/x =/{gsub(";","");print $3}')"
    y="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/y =/{gsub(";","");print $3}')"
    w="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/width =/{gsub(";","");print $3}')"
    h="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/height =/{gsub(";","");print $3}')"
    defaults write com.meetingslides.app 'minibar.frame.v1' -dict x "$x" y "$y" width "$w" height "$h"
  else
    defaults delete com.meetingslides.app 'minibar.frame.v1' >/dev/null 2>&1 || true
  fi
}
cleanup() {
  set +e
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then kill -TERM "$APP_PID"; wait "$APP_PID"; fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill -TERM "$SERVER_PID"; wait "$SERVER_PID"; fi
  cp "$TMP/marker.before" "$MARKER"
  restore_defaults
  hash_preserved "$E/acd-preservation-after.txt"
  cmp -s "$E/acd-preservation-before.txt" "$E/acd-preservation-after.txt"; acd_ok=$?
  marker_ok=false; cmp -s "$TMP/marker.before" "$MARKER" && marker_ok=true
  defaults_ok=false; [[ "$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)" == "$DEFAULTS_BEFORE" ]] && defaults_ok=true
  port_free=false; [[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]] && port_free=true
  app_gone=false; [[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]] && app_gone=true
  actual="$(shasum -a 256 "$EXEC" | awk '{print $1}')"
  codesign --verify --deep --strict "$APP" >"$E/post-cleanup-codesign.txt" 2>&1; sign_rc=$?
  printf '{"acdPreserved":%s,"markerRestored":%s,"defaultsRestored":%s,"portFree":%s,"appProcessGone":%s,"executableHash":"%s","codesignExit":%s,"temporaryRemoved":true}\n' "$([[ $acd_ok -eq 0 ]] && echo true || echo false)" "$marker_ok" "$defaults_ok" "$port_free" "$app_gone" "$actual" "$sign_rc" > "$E/cleanup.json"
  rm -rf "$TMP"
}
trap cleanup EXIT

hash_preserved "$E/acd-preservation-before.txt"
{
  echo "expected_sha256=$EXPECTED"
  echo "actual_sha256=$(shasum -a 256 "$EXEC" | awk '{print $1}')"
  echo "bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
  echo "executable=$EXEC"
  echo "app=$APP"
} > "$E/artifact-identity.txt"
[[ "$(shasum -a 256 "$EXEC" | awk '{print $1}')" == "$EXPECTED" ]]
"$SEG/build/../tools/quit-protection" --help >/dev/null 2>&1 || true
codesign --verify --deep --strict --verbose=2 "$APP" >"$E/preflight-codesign.txt" 2>&1
"$ROOT/scripts/verify-app.sh" "$APP" >"$E/preflight-bundle.txt" 2>&1

cat > "$PROJECT/server.ts" <<'EOF'
// Presence-only marker for the installed launcher's project resolution.
EOF
printf 'HTTP_PORT=%s\n' "$PORT" > "$PROJECT/.env"
printf '%s\n' "$PROJECT" > "$MARKER"
defaults write com.meetingslides.app 'minibar.frame.v1' -dict x 9000 y 9000 width 360 height 56
mkfifo "$TMP/ready.fifo"
: > "$RECEIPT"
HTTP_PORT="$PORT" RECEIPT_PATH="$RECEIPT" READY_FIFO="$TMP/ready.fifo" bun run "$E/fake-server.ts" >"$E/server.stdout.txt" 2>"$E/server.stderr.txt" & SERVER_PID=$!
IFS= read -r -t 10 ready < "$TMP/ready.fifo"
[[ "$ready" == ready ]]

"$EXEC" >"$E/app.stdout.txt" 2>"$E/app.stderr.txt" & APP_PID=$!
python3 "$E/wait-receipt.py" "$RECEIPT" websocket-open 1 30
python3 "$E/wait-receipt.py" "$RECEIPT" workspace-get 2 30

swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/01-collapsed.json"
screencapture -x "$E/screenshots/01-collapsed.png"

osascript - "$APP_PID" >"$E/actions/02-menu-first.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "AXPress succeeded"
end run
APPLESCRIPT
screencapture -x "$E/screenshots/02-after-menu-first.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/02-after-menu-first.json"

osascript - "$APP_PID" >"$E/actions/03-menu-second.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "AXPress succeeded"
end run
APPLESCRIPT
screencapture -x "$E/screenshots/03-after-menu-second.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/03-after-menu-second.json"

osascript - "$APP_PID" >"$E/actions/04-disclosure.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "미니바 펼치기" of group 1 of window 1
  end tell
  return "AXPress succeeded"
end run
APPLESCRIPT
screencapture -x "$E/screenshots/04-expanded.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/04-expanded.json"

curl -fsS -X POST "http://127.0.0.1:$PORT/control/idle" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/receipt" > "$TMP/before-open.json"
BEFORE_GET="$(python3 -c 'import json,sys; print(sum(x["kind"]=="workspace-get" for x in json.load(open(sys.argv[1]))))' "$TMP/before-open.json")"
osascript - "$APP_PID" >"$E/actions/05-open-workspace.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "작업 공간 열기" of group 1 of window 1
  end tell
  return "AXPress succeeded"
end run
APPLESCRIPT
python3 "$E/wait-receipt.py" "$RECEIPT" workspace-get "$((BEFORE_GET + 1))" 30
screencapture -x "$E/screenshots/05-open-workspace.png"

curl -fsS -X POST "http://127.0.0.1:$PORT/control/capturing" >/dev/null
screencapture -x "$E/screenshots/06-capturing-stop.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/06-capturing-stop.json"
osascript - "$APP_PID" >"$E/actions/07-five-stop-presses.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    repeat 5 times
      perform action "AXPress" of button "녹음 중지" of group 1 of window 1
    end repeat
  end tell
  return "5 AXPress activations succeeded"
end run
APPLESCRIPT
python3 "$E/wait-receipt.py" "$RECEIPT" client-command 1 30
curl -fsS -X POST "http://127.0.0.1:$PORT/control/idle" >/dev/null
screencapture -x "$E/screenshots/07-after-stop-idle.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/07-after-stop-idle.json"

osascript - "$APP_PID" >"$E/actions/08-menu-owner-still-pressable.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "AXPress succeeded after all interactions"
end run
APPLESCRIPT
screencapture -x "$E/screenshots/08-menu-owner-remains.png"
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/08-menu-owner-remains.json"
curl -fsS "http://127.0.0.1:$PORT/receipt" > "$E/server-receipts-final.json"
