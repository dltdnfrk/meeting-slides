#!/usr/bin/env bash
# ============================================================
# build-app.sh — Meeting Slides.app 번들 생성
# ============================================================
# anarlog 방식: 앱 번들이 마이크 권한(TCC)의 주체가 되어 터미널 없이
# 더블클릭으로 서버를 실행한다. 권한 프롬프트는 최초 1회만 뜬다.
set -euo pipefail

APP="Meeting Slides.app"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Meeting Slides</string>
  <key>CFBundleDisplayName</key><string>Meeting Slides</string>
  <key>CFBundleIdentifier</key><string>com.meetingslides.app</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>meeting-slides</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSMicrophoneUsageDescription</key><string>회의 음성을 로컬에서 전사하기 위해 마이크가 필요합니다.</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

cat > "$APP/Contents/MacOS/meeting-slides" <<'EOF'
#!/bin/bash
# Meeting Slides 런처 — 앱 번들이 프로세스 트리의 뿌리라
# 마이크 권한이 "Meeting Slides" 앱에 귀속된다.
APP_BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$(cd "$APP_BUNDLE/.." && pwd)"
cd "$PROJ" || exit 1

find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  for p in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  return 1
}

BUN="$(find_bun)" || {
  osascript -e 'display dialog "bun이 필요합니다. https://bun.sh 에서 설치 후 다시 실행해주세요." buttons {"확인"} default button 1 with icon stop with title "Meeting Slides"' >/dev/null 2>&1 || true
  exit 1
}

if [ "${1:-}" = "--mic-check" ]; then
  # 마이크 권한 프롬프트를 앱 이름으로 한 번 띄우기 위한 트리거.
  STREAM_BIN="${WHISPER_STREAM_BIN:-/opt/homebrew/bin/whisper-stream}"
  MODEL="${WHISPER_MODEL_PATH:-./models/ggml-medium.bin}"
  if [ -x "$STREAM_BIN" ] && [ -f "$MODEL" ]; then
    "$STREAM_BIN" -m "$MODEL" -l ko -t 2 --step 1000 --length 3000 --keep 200 -c "${WHISPER_CAPTURE_ID:--1}" -fa >/dev/null 2>&1 &
    PID=$!
    sleep 5
    kill "$PID" 2>/dev/null || true
  fi
  exit 0
fi

# 이미 서버가 떠 있으면 브라우저만 연다
PORT="${HTTP_PORT:-8787}"
if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/"; then
  open "http://localhost:$PORT/"
  exit 0
fi

exec "$BUN" run server.ts
EOF

chmod +x "$APP/Contents/MacOS/meeting-slides"

echo "✅ 빌드 완료: $PROJ/$APP"
echo ""
echo "사용법:"
echo "  1. 최초 1회: Finder에서 '$APP' 우클릭 → 열기 (Gatekeeper)"
echo "  2. 마이크 권한 프롬프트가 뜨면 허용 (이후 영구 적용)"
echo "  3. 이후에는 더블클릭/Spotlight로 바로 실행"
echo ""
echo "권한 프롬프트를 미리 띄우려면:"
echo "  open -a \"$APP\" --args --mic-check"
