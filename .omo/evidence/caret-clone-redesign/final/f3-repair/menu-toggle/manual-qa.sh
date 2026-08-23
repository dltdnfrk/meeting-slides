#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
E="$ROOT/.omo/evidence/caret-clone-redesign/final/f3-repair/menu-toggle"
APP="$HOME/Applications/Meeting Slides.app"
EXEC="$APP/Contents/MacOS/meeting-slides"
MARKER="$APP/Contents/Resources/project-path.txt"
PORT=54746
EXPECTED="$(awk '{print $1}' "$E/artifact-identity.txt" | head -1)"
TMP="$(mktemp -d /tmp/f3-menu-toggle-repair.XXXXXX)"
PROJECT="$TMP/project"
RECEIPT="$E/server-receipts.jsonl"
SERVER_PID=""
APP_PID=""
DEFAULTS_BEFORE="$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)"
mkdir -p "$PROJECT" "$E/actions" "$E/screenshots" "$E/windows"
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
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then kill -TERM "$APP_PID"; wait "$APP_PID"; fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill -TERM "$SERVER_PID"; wait "$SERVER_PID"; fi
  cp "$TMP/marker.before" "$MARKER"
  restore_defaults
  marker_restored=false; cmp -s "$TMP/marker.before" "$MARKER" && marker_restored=true
  defaults_restored=false; [[ "$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)" == "$DEFAULTS_BEFORE" ]] && defaults_restored=true
  port_free=false; [[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]] && port_free=true
  app_gone=false; [[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]] && app_gone=true
  actual="$(shasum -a 256 "$EXEC" | awk '{print $1}')"
  codesign --verify --deep --strict "$APP" >"$E/post-cleanup-codesign.txt" 2>&1; sign_rc=$?
  printf '{"runExit":%s,"markerRestored":%s,"defaultsRestored":%s,"portFree":%s,"appProcessGone":%s,"executableHash":"%s","codesignExit":%s,"temporaryRemoved":true}\n' "$rc" "$marker_restored" "$defaults_restored" "$port_free" "$app_gone" "$actual" "$sign_rc" > "$E/cleanup.json"
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

[[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]]
[[ -z "$(pgrep -f "$EXEC" 2>/dev/null || true)" ]]
[[ "$(shasum -a 256 "$EXEC" | awk '{print $1}')" == "$EXPECTED" ]]
scripts/verify-app.sh "$APP" > "$E/manual-preflight-verify.txt" 2>&1
codesign --verify --deep --strict --verbose=2 "$APP" > "$E/manual-preflight-codesign.txt" 2>&1

cat > "$PROJECT/server.ts" <<'MARKER'
// Presence-only marker for installed launcher project resolution.
MARKER
printf 'HTTP_PORT=%s\n' "$PORT" > "$PROJECT/.env"
printf '%s\n' "$PROJECT" > "$MARKER"
defaults write com.meetingslides.app 'minibar.frame.v1' -dict x 9000 y 9000 width 360 height 56 >/dev/null
mkfifo "$TMP/ready.fifo"
: > "$RECEIPT"
HTTP_PORT="$PORT" RECEIPT_PATH="$RECEIPT" READY_FIFO="$TMP/ready.fifo" bun run "$E/fake-server.ts" > "$E/server.stdout.txt" 2> "$E/server.stderr.txt" & SERVER_PID=$!
IFS= read -r -t 10 ready < "$TMP/ready.fifo"
[[ "$ready" == ready ]]

"$EXEC" > "$E/app.stdout.txt" 2> "$E/app.stderr.txt" & APP_PID=$!
python3 "$E/wait-receipt.py" "$RECEIPT" websocket-open 1 30
python3 "$E/wait-receipt.py" "$RECEIPT" workspace-get 2 30

swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/01-initial-off-display-restored.json"
screencapture -x "$E/screenshots/01-initial-off-display-restored.png"

osascript - "$APP_PID" > "$E/actions/02-menu-first-hide.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct System Events AXPress succeeded"
end run
APPLESCRIPT
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/02-after-first-hide.json"
screencapture -x "$E/screenshots/02-after-first-hide.png"

osascript - "$APP_PID" > "$E/actions/03-menu-second-restore.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of menu bar item 1 of menu bar 2
  end tell
  return "direct System Events AXPress succeeded"
end run
APPLESCRIPT
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/03-after-second-restore.json"
screencapture -x "$E/screenshots/03-after-second-restore.png"

osascript - "$APP_PID" > "$E/actions/04-disclosure.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "미니바 펼치기" of group 1 of window 1
  end tell
  return "direct System Events AXPress succeeded"
end run
APPLESCRIPT
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/04-expanded.json"
screencapture -x "$E/screenshots/04-expanded.png"

BASELINE_GET="$(python3 - "$RECEIPT" <<'PY'
import json, sys
print(sum(json.loads(line).get("kind") == "workspace-get" for line in open(sys.argv[1]) if line.strip()))
PY
)"
osascript - "$APP_PID" > "$E/actions/05-open-workspace.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    perform action "AXPress" of button "작업 공간 열기" of group 1 of window 1
  end tell
  return "direct System Events AXPress succeeded"
end run
APPLESCRIPT
python3 "$E/wait-receipt.py" "$RECEIPT" workspace-get "$((BASELINE_GET + 1))" 30

curl -fsS -X POST "http://127.0.0.1:$PORT/control/capturing" > "$E/actions/06-capturing-trigger.txt"
osascript - "$APP_PID" > "$E/actions/07-five-stop-presses.txt" <<'APPLESCRIPT'
on run argv
  set targetPID to (item 1 of argv) as integer
  tell application "System Events" to tell (first application process whose unix id is targetPID)
    repeat 5 times
      perform action "AXPress" of button "녹음 중지" of group 1 of window 1
    end repeat
  end tell
  return "5 direct System Events AXPress activations succeeded"
end run
APPLESCRIPT
python3 "$E/wait-receipt.py" "$RECEIPT" client-command 1 30
swift "$E/window-inventory.swift" "$APP_PID" "$E/windows/05-after-stop.json"
screencapture -x "$E/screenshots/05-after-stop.png"
curl -fsS -X POST "http://127.0.0.1:$PORT/control/idle" > "$E/actions/08-idle-trigger.txt"
curl -fsS "http://127.0.0.1:$PORT/receipt" > "$E/server-receipts-final.json"

python3 - "$E" "$EXPECTED" "$PORT" > "$E/manual-summary.json" <<'PY'
import json, pathlib, sys
root, expected, port = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
def inventory(name):
    return json.loads((root / "windows" / name).read_text())
def panel(inv):
    rows = inv["targetWindows"]
    return rows[0] if len(rows) == 1 else None
def size(row):
    b = row["bounds"]
    return [int(b["Width"]), int(b["Height"])]
initial = inventory("01-initial-off-display-restored.json")
hidden = inventory("02-after-first-hide.json")
restored = inventory("03-after-second-restore.json")
expanded = inventory("04-expanded.json")
i, r, x = panel(initial), panel(restored), panel(expanded)
receipts = json.loads((root / "server-receipts-final.json").read_text())
commands = [row for row in receipts if row.get("kind") == "client-command"]
workspace = [row for row in receipts if row.get("kind") == "workspace-get"]
summary = {
  "verdict": "PASS",
  "artifactSHA256": expected,
  "isolatedAdoptedServer": {"port": port, "websocketOpens": sum(row.get("kind") == "websocket-open" for row in receipts)},
  "offDisplayRestoration": {"seed": [9000, 9000, 360, 56], "observedBounds": i["bounds"] if i else None, "pass": bool(i and size(i) == [360, 56] and i["bounds"]["X"] != 9000 and i["bounds"]["Y"] != 9000)},
  "menuToggle": {
    "initialWindowId": i["windowNumber"] if i else None,
    "firstPressTargetWindowCount": hidden["targetWindowCount"],
    "secondPressWindowId": r["windowNumber"] if r else None,
    "secondPressBounds": r["bounds"] if r else None,
    "pass": bool(i and hidden["targetWindowCount"] == 0 and r and r["onScreen"] is True and size(r) == [360, 56]),
  },
  "disclosure": {"observedBounds": x["bounds"] if x else None, "pass": bool(x and size(x) == [560, 220])},
  "openWorkspace": {"workspaceGetCount": len(workspace), "lastHost": workspace[-1].get("host") if workspace else None, "pass": bool(workspace and workspace[-1].get("host") == f"localhost:{port}")},
  "stopOnce": {"activations": 5, "commands": commands, "pass": len(commands) == 1 and commands[0].get("parsed") == {"action": "stopCapture"}},
  "observation": "direct System Events AXPress; one-shot CGWindowListCopyWindowInfo(.optionOnScreenOnly); fresh screencapture",
  "timing": "FIFO and kqueue vnode notifications with bounded deadlines; no sleeps or polling",
}
checks = [summary["offDisplayRestoration"]["pass"], summary["menuToggle"]["pass"], summary["disclosure"]["pass"], summary["openWorkspace"]["pass"], summary["stopOnce"]["pass"], summary["isolatedAdoptedServer"]["websocketOpens"] == 1]
if not all(checks):
    summary["verdict"] = "FAIL"
print(json.dumps(summary, indent=2, ensure_ascii=False))
if summary["verdict"] != "PASS": raise SystemExit(1)
PY
