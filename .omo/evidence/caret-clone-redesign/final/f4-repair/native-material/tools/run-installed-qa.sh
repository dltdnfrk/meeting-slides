#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
E="$ROOT/.omo/evidence/caret-clone-redesign/final/f4-repair/native-material"
APP="$HOME/Applications/Meeting Slides.app"
EXEC="$APP/Contents/MacOS/meeting-slides"
MARKER="$APP/Contents/Resources/project-path.txt"
PORT=54831
TMP="$(mktemp -d /tmp/f4-native-material.XXXXXX)"
PROJECT="$TMP/project"
RECEIPT="$E/qa/server-receipts.jsonl"
SERVER_PID=""; APP_PID=""
DEFAULTS_BEFORE="$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)"
mkdir -p "$PROJECT" "$E/qa/screenshots" "$E/qa/windows"
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
  [[ -n "$APP_PID" ]] && kill -TERM "$APP_PID" 2>/dev/null; [[ -n "$APP_PID" ]] && wait "$APP_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null; [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null
  cp "$TMP/marker.before" "$MARKER"; restore_defaults
  marker=false; cmp -s "$TMP/marker.before" "$MARKER" && marker=true
  defaults_ok=false; [[ "$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)" == "$DEFAULTS_BEFORE" ]] && defaults_ok=true
  port_free=false; [[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]] && port_free=true
  app_gone=false; [[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]] && app_gone=true
  printf '{"runExit":%s,"markerRestored":%s,"defaultsRestored":%s,"portFree":%s,"appGone":%s,"temporaryRemoved":true}\n' "$rc" "$marker" "$defaults_ok" "$port_free" "$app_gone" >"$E/qa/cleanup.json"
  rm -rf "$TMP"; exit "$rc"
}
trap cleanup EXIT
cd "$ROOT"
[[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]]
[[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]]
scripts/verify-app.sh "$APP" >"$E/qa/preflight-verify.txt" 2>&1
codesign --verify --deep --strict "$APP" >"$E/qa/preflight-codesign.txt" 2>&1
swiftc "$E/tools/window-inventory.swift" -o "$TMP/window-inventory"
printf '// isolated presence marker\n' >"$PROJECT/server.ts"
printf 'HTTP_PORT=%s\n' "$PORT" >"$PROJECT/.env"
printf '%s\n' "$PROJECT" >"$MARKER"
LAUNCHER_LOG="$HOME/Library/Logs/Meeting Slides/launcher.log"
LOG_OFFSET="$(stat -f%z "$LAUNCHER_LOG" 2>/dev/null || echo 0)"
defaults write com.meetingslides.app 'minibar.frame.v1' -dict x 9000 y 9000 width 360 height 56 >/dev/null
mkfifo "$TMP/server-ready"; : >"$RECEIPT"
HTTP_PORT="$PORT" RECEIPT_PATH="$RECEIPT" READY_FIFO="$TMP/server-ready" bun run "$E/tools/qa-server.ts" >"$E/qa/server.stdout.txt" 2>"$E/qa/server.stderr.txt" & SERVER_PID=$!
IFS= read -r -t 10 ready <"$TMP/server-ready"; [[ "$ready" == ready ]]
"$EXEC" >"$E/qa/app.stdout.txt" 2>"$E/qa/app.stderr.txt" & APP_PID=$!
python3 "$E/tools/wait-receipt.py" "$RECEIPT" websocket-open 1 30
python3 "$E/tools/wait-log.py" "$LAUNCHER_LOG" "$LOG_OFFSET" "미니바 준비됨 port=$PORT" 30

osascript - "$APP_PID" >"$E/qa/windows/01-collapsed-idle.ax.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    return {position of window 1, size of window 1, entire contents of window 1}
  end tell
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/01-collapsed-idle.json"
screencapture -x "$E/qa/screenshots/01-collapsed-idle.png"
IDLE_WINDOW="$(jq -r '.targetWindows[0].windowNumber' "$E/qa/windows/01-collapsed-idle.json")"
screencapture -x -l "$IDLE_WINDOW" "$E/qa/screenshots/01-collapsed-idle-panel.png"

curl -fsS -X POST "http://127.0.0.1:$PORT/control/capturing" >"$E/qa/live-trigger.txt"
osascript - "$APP_PID" >"$E/qa/windows/02-collapsed-live.ax.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    return {position of window 1, size of window 1, entire contents of window 1}
  end tell
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/02-collapsed-live.json"
screencapture -x "$E/qa/screenshots/02-collapsed-live.png"
LIVE_WINDOW="$(jq -r '.targetWindows[0].windowNumber' "$E/qa/windows/02-collapsed-live.json")"
screencapture -x -l "$LIVE_WINDOW" "$E/qa/screenshots/02-collapsed-live-panel.png"

osascript - "$APP_PID" >"$E/qa/disclosure-action.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "미니바 펼치기" of group 1 of window 1
  end tell
  return "direct AXPress succeeded"
end run
APPLESCRIPT
osascript - "$APP_PID" >"$E/qa/windows/03-expanded-live.ax.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    return {position of window 1, size of window 1, entire contents of window 1}
  end tell
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/03-expanded-live.json"
screencapture -x "$E/qa/screenshots/03-expanded-live.png"
EXPANDED_WINDOW="$(jq -r '.targetWindows[0].windowNumber' "$E/qa/windows/03-expanded-live.json")"
screencapture -x -l "$EXPANDED_WINDOW" "$E/qa/screenshots/03-expanded-live-panel.png"

osascript - "$APP_PID" >"$E/qa/menu-first-hide.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct menu AXPress succeeded"
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/04-menu-hidden.json"
osascript - "$APP_PID" >"$E/qa/menu-second-restore.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct menu AXPress succeeded"
end run
APPLESCRIPT
"$TMP/window-inventory" "$APP_PID" "$E/qa/windows/05-menu-restored-expanded.json"
curl -fsS "http://127.0.0.1:$PORT/receipt" >"$E/qa/server-receipts-final.json"

python3 - "$E" "$EXEC" >"$E/qa/summary.json" <<'PY'
import hashlib, json, pathlib, sys
root, exe = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def load(name): return json.loads((root/'qa/windows'/name).read_text())
def bounds(doc): return doc['targetWindows'][0]['bounds'] if doc['targetWindows'] else None
def ax(name): return (root/'qa/windows'/name).read_text()
idle, live, expanded = load('01-collapsed-idle.json'), load('02-collapsed-live.json'), load('03-expanded-live.json')
hidden, restored = load('04-menu-hidden.json'), load('05-menu-restored-expanded.json')
idle_ax, live_ax, expanded_ax = ax('01-collapsed-idle.ax.txt'), ax('02-collapsed-live.ax.txt'), ax('03-expanded-live.ax.txt')
ib, lb, eb, rb = map(bounds, (idle,live,expanded,restored))
summary = {
 'verdict':'PASS', 'installedExecutableSHA256':hashlib.sha256(exe.read_bytes()).hexdigest(),
 'isolatedPort':54831, 'noMicUserDbExternalAPI':True,
 'offDisplayRestoration':{'seed':[9000,9000,360,56],'bounds':ib,'pass':bool(ib and ib['Width']==360 and ib['Height']==56 and ib['X']!=9000 and ib['Y']!=9000)},
 'collapsedIdle':{'bounds':ib,'axHasIdle':'대기 중' in idle_ax,'axHasStop':'녹음 중지' in idle_ax,'axHasDisclosure':'미니바 펼치기' in idle_ax},
 'collapsedLive':{'bounds':lb,'axHasLive':'녹음 중' in live_ax,'axHasStop':'녹음 중지' in live_ax},
 'expandedLive':{'bounds':eb,'axHasWorkspace':'작업 공간 열기' in expanded_ax,'axHasTranscript':sum(fragment in expanded_ax for fragment in ['핵심 결정','다음 단계','발표 자료'])},
 'menuToggle':{'hiddenCGWindowCount':len(hidden['targetWindows']),'restoredBounds':rb,'pass':len(hidden['targetWindows'])==0 and bool(rb and rb['Width']==560 and rb['Height']==220)},
}
summary['collapsedIdle']['pass']=ib is not None and ib['Width']==360 and ib['Height']==56 and summary['collapsedIdle']['axHasIdle']
summary['collapsedLive']['pass']=lb is not None and lb['Width']==360 and lb['Height']==56 and summary['collapsedLive']['axHasLive'] and summary['collapsedLive']['axHasStop']
summary['expandedLive']['pass']=eb is not None and eb['Width']==560 and eb['Height']==220 and summary['expandedLive']['axHasWorkspace'] and summary['expandedLive']['axHasTranscript']==3
if not all([summary['offDisplayRestoration']['pass'],summary['collapsedIdle']['pass'],summary['collapsedLive']['pass'],summary['expandedLive']['pass'],summary['menuToggle']['pass']]): summary['verdict']='FAIL'
print(json.dumps(summary,ensure_ascii=False,indent=2))
if summary['verdict']!='PASS': raise SystemExit(1)
PY
