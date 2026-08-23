#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../../.." && pwd)"
E="$ROOT/.omo/evidence/caret-clone-redesign/final/f3-manual-qa-segmented/segment-b-native"
APP="$HOME/Applications/Meeting Slides.app"
EXEC="$APP/Contents/MacOS/meeting-slides"
PORT=54743
TMP="$(mktemp -d /tmp/f3-b-direct.XXXXXX)"
PROJ="$TMP/project"; mkdir -p "$PROJ" "$TMP/exports" "$TMP/bundles"
MARKER="$APP/Contents/Resources/project-path.txt"; cp "$MARKER" "$TMP/marker.before"
DEFAULTS_BEFORE="$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)"
APP_PID=""
cleanup(){
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then kill -TERM "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  pids="$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"; [[ -z "$pids" ]] || kill -9 $pids 2>/dev/null || true
  cp "$TMP/marker.before" "$MARKER"
  if [[ -n "$DEFAULTS_BEFORE" ]]; then
    x="$(printf '%s' "$DEFAULTS_BEFORE"|awk '/x =/{gsub(";","");print $3}')"; y="$(printf '%s' "$DEFAULTS_BEFORE"|awk '/y =/{gsub(";","");print $3}')"; w="$(printf '%s' "$DEFAULTS_BEFORE"|awk '/width =/{gsub(";","");print $3}')"; h="$(printf '%s' "$DEFAULTS_BEFORE"|awk '/height =/{gsub(";","");print $3}')"
    defaults write com.meetingslides.app 'minibar.frame.v1' -dict x "${x:-0}" y "${y:-0}" width "${w:-360}" height "${h:-56}"
  else defaults delete com.meetingslides.app 'minibar.frame.v1' >/dev/null 2>&1 || true; fi
  hash="$(shasum -a 256 "$EXEC"|awk '{print $1}')"; port_free=true; [[ -z "$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ]] || port_free=false
  marker_ok=false; cmp -s "$TMP/marker.before" "$MARKER" && marker_ok=true
  defaults_ok=false; [[ "$(defaults read com.meetingslides.app 'minibar.frame.v1' 2>/dev/null || true)" == "$DEFAULTS_BEFORE" ]] && defaults_ok=true
  printf '{"markerRestored":%s,"portFree":%s,"defaultsRestored":%s,"hashStill":"%s","temporaryRemoved":true}\n' "$marker_ok" "$port_free" "$defaults_ok" "$hash" > "$E/cleanup.json"
  rm -rf "$TMP"
}
trap cleanup EXIT
for f in server.ts package.json bun.lock tsconfig.json; do cp "$ROOT/$f" "$PROJ/$f"; done
for d in src public node_modules deck models; do ln -s "$ROOT/$d" "$PROJ/$d"; done
printf 'HTTP_PORT=%s\n' "$PORT" > "$PROJ/.env"; printf '%s\n' "$PROJ" > "$MARKER"
cat > "$TMP/recorder" <<'FIX'
#!/usr/bin/env bun
console.log('[00:00:00.000 --> 00:00:01.000] 네이티브 정지 검증 문장입니다.');process.on('SIGTERM',()=>process.exit(0));await new Promise(()=>{});
FIX
cat > "$TMP/provider" <<'FIX'
#!/usr/bin/env bun
if(process.argv.includes('--version')){console.log('f3-local-provider 1.0');process.exit(0)}console.log(JSON.stringify({items:[]}));
FIX
chmod +x "$TMP/recorder" "$TMP/provider"; printf fixture > "$TMP/model.bin"
defaults write com.meetingslides.app 'minibar.frame.v1' -dict x 9000 y 9000 width 360 height 56
MEETINGS_DB_PATH="$TMP/meetings.db" MEETING_BUNDLE_OUTPUT_ROOT="$TMP/bundles" LLM_PROVIDER=cli LLM_CLI_BIN="$TMP/provider" LLM_CLI_PRESET=claude LLM_CLI_TIMEOUT_MS=20000 WHISPER_INPUT_MODE=mic WHISPER_STREAM_BIN="$TMP/recorder" WHISPER_MODEL_PATH="$TMP/model.bin" OPENAI_API_KEY='' ANTHROPIC_API_KEY='' "$EXEC" >"$E/direct-app.log" 2>&1 & APP_PID=$!
python3 - "$E/direct-app.log" <<'PY'
import os,selectors,sys,time
path=sys.argv[1]; deadline=time.monotonic()+60
while not os.path.exists(path):
    if time.monotonic()>=deadline: raise SystemExit('deadline: app log creation')
fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK); sel=selectors.DefaultSelector(); sel.register(fd,selectors.EVENT_READ); data=b''
while time.monotonic()<deadline:
    for key,_ in sel.select(deadline-time.monotonic()):
        chunk=os.read(fd,65536); data+=chunk
        if b'minibar' in data and b'port=54743' in data: raise SystemExit(0)
raise SystemExit('deadline: installed app ready')
PY
ACTUAL="$(shasum -a 256 "$EXEC"|awk '{print $1}')"; EXPECTED="$(cat "$ROOT/.omo/evidence/caret-clone-redesign/final/f3-manual-qa-segmented/build/EXECUTABLE_SHA256")"; [[ "$ACTUAL" == "$EXPECTED" ]]
"$ROOT/.omo/evidence/caret-clone-redesign/final/f3-manual-qa-segmented/tools/segment-b-direct" "$APP_PID" "$PORT" "$E/evidence.json"
echo 'SEGMENT B DIRECT PASS'
