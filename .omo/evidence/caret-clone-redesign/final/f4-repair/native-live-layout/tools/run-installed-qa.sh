#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
E="$ROOT/.omo/evidence/caret-clone-redesign/final/f4-repair/native-live-layout"
APP="$HOME/Applications/Meeting Slides.app"
EXEC="$APP/Contents/MacOS/meeting-slides"
MARKER="$APP/Contents/Resources/project-path.txt"
PORT=54832
TMP="$(mktemp -d /tmp/f4-native-live-layout.XXXXXX)"
PROJECT="$TMP/project"
RECEIPT="$E/qa/server-receipts.jsonl"
SERVER_PID=""; APP_PID=""
DEFAULTS_BEFORE="$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)"
mkdir -p "$PROJECT" "$E/qa/screenshots" "$E/qa/windows" "$E/qa/waits"
cp "$MARKER" "$TMP/marker.before"

restore_defaults() {
  if [[ -n "$DEFAULTS_BEFORE" ]]; then
    local x y width height
    x="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/x =/{gsub(";",""); print $3}')"
    y="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/y =/{gsub(";",""); print $3}')"
    width="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/width =/{gsub(";",""); print $3}')"
    height="$(printf '%s' "$DEFAULTS_BEFORE" | awk '/height =/{gsub(";",""); print $3}')"
    defaults write com.meetingslides.app 'minibar.frame.v1' -dict x "$x" y "$y" width "$width" height "$height" >/dev/null
  else
    defaults delete com.meetingslides.app 'minibar.frame.v1' >/dev/null 2>&1 || true
  fi
}
cleanup() {
  local rc=$?
  set +e
  [[ -n "$APP_PID" ]] && kill -TERM "$APP_PID" 2>/dev/null
  [[ -n "$APP_PID" ]] && wait "$APP_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null
  cp "$TMP/marker.before" "$MARKER"
  restore_defaults
  local marker=false defaults_ok=false port_free=false app_gone=false
  cmp -s "$TMP/marker.before" "$MARKER" && marker=true
  [[ "$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)" == "$DEFAULTS_BEFORE" ]] && defaults_ok=true
  [[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]] && port_free=true
  [[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]] && app_gone=true
  printf '{"runExit":%s,"markerRestored":%s,"defaultsRestored":%s,"portFree":%s,"appGone":%s,"temporaryRemoved":true}\n' \
    "$rc" "$marker" "$defaults_ok" "$port_free" "$app_gone" >"$E/qa/cleanup.json"
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

capture_state() {
  local stem="$1" began ended
  began="$(python3 -c 'import time; print(round(time.time()*1000))')"
  "$TMP/window-inventory" "$APP_PID" "$E/qa/windows/$stem.inventory.json"
  "$TMP/ax-window-probe" "$APP_PID" "$E/qa/windows/$stem.ax.json"
  screencapture -x "$E/qa/screenshots/$stem.display.png"
  local window_id
  window_id="$(jq -r '.targetWindows[0].windowNumber' "$E/qa/windows/$stem.inventory.json")"
  [[ "$window_id" != null && "$window_id" != 0 ]]
  screencapture -x -l "$window_id" "$E/qa/screenshots/$stem.panel.png"
  ended="$(python3 -c 'import time; print(round(time.time()*1000))')"
  printf '{"captureBeganAt":%s,"captureEndedAt":%s,"windowNumber":%s}\n' "$began" "$ended" "$window_id" >"$E/qa/screenshots/$stem.timing.json"
}
start_wait() {
  local stem="$1" kind="$2" expected="$3" fifo
  fifo="$TMP/$stem.fifo"
  mkfifo "$fifo"
  "$TMP/ax-settled-wait" "$APP_PID" "$kind" "$expected" "$fifo" >"$E/qa/waits/$stem.txt" 2>"$E/qa/waits/$stem.stderr.txt" &
  WAIT_PID=$!
  IFS= read -r -t 10 ready <"$fifo"
  [[ "$ready" == ready ]]
}
finish_wait() {
  wait "$WAIT_PID"
  WAIT_PID=""
}

cd "$ROOT"
[[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]]
[[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]]
scripts/verify-app.sh "$APP" >"$E/qa/preflight-verify.txt" 2>&1
codesign --verify --deep --strict "$APP" >"$E/qa/preflight-codesign.txt" 2>&1
swiftc "$E/tools/ax-settled-wait.swift" -o "$TMP/ax-settled-wait"
swiftc "$E/tools/ax-window-probe.swift" -o "$TMP/ax-window-probe"
swiftc "$E/tools/window-inventory.swift" -o "$TMP/window-inventory"
printf '// isolated presence marker\n' >"$PROJECT/server.ts"
printf 'HTTP_PORT=%s\n' "$PORT" >"$PROJECT/.env"
printf '%s\n' "$PROJECT" >"$MARKER"
defaults write com.meetingslides.app 'minibar.frame.v1' -dict x 9000 y 9000 width 360 height 56 >/dev/null
mkfifo "$TMP/server-ready"
: >"$RECEIPT"
HTTP_PORT="$PORT" RECEIPT_PATH="$RECEIPT" READY_FIFO="$TMP/server-ready" \
  bun run "$E/tools/qa-server.ts" >"$E/qa/server.stdout.txt" 2>"$E/qa/server.stderr.txt" &
SERVER_PID=$!
IFS= read -r -t 10 ready <"$TMP/server-ready"
[[ "$ready" == ready ]]
"$EXEC" >"$E/qa/app.stdout.txt" 2>"$E/qa/app.stderr.txt" &
APP_PID=$!
python3 "$E/tools/wait-receipt.py" "$RECEIPT" websocket-open 1 15

start_wait idle text "대기 중"
finish_wait
capture_state 01-collapsed-idle

start_wait live text "녹음 중"
curl -fsS -X POST "http://127.0.0.1:$PORT/control/capturing" >"$E/qa/live-trigger.json"
finish_wait
capture_state 02-collapsed-live

start_wait expanded size "560x220"
osascript - "$APP_PID" >"$E/qa/expand-action.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "미니바 펼치기" of group 1 of window 1
  end tell
  return "direct disclosure AXPress succeeded"
end run
APPLESCRIPT
finish_wait
capture_state 03-expanded-live

start_wait ended text "대기 중"
osascript - "$APP_PID" >"$E/qa/stop-action.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "녹음 중지" of group 1 of window 1
  end tell
  return "direct native Stop AXPress succeeded"
end run
APPLESCRIPT
finish_wait
python3 "$E/tools/wait-receipt.py" "$RECEIPT" capture-ended 1 15
capture_state 04-expanded-ended

osascript - "$APP_PID" >"$E/qa/menu-hide-action.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct menu AXPress hide succeeded"
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/05-menu-hidden.inventory.json"
osascript - "$APP_PID" >"$E/qa/menu-restore-action.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct menu AXPress restore succeeded"
end run
APPLESCRIPT
start_wait restored size "560x220"
finish_wait
capture_state 06-menu-restored-expanded-ended
curl -fsS "http://127.0.0.1:$PORT/receipt" >"$E/qa/server-receipts-final.json"

python3 "$E/tools/summarize.py" "$E" "$EXEC" >"$E/qa/summary.json"
