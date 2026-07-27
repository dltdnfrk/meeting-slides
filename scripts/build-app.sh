#!/usr/bin/env bash
# ============================================================
# build-app.sh — Meeting Slides.app 번들 생성 (네이티브 런처)
# ============================================================
# macOS는 Mach-O 네이티브 바이너리 + 번들 조합만 마이크 권한(TCC)의
# 주체로 인정한다. 그래서 macos/launcher.swift를 컴파일해 넣고
# ad-hoc 코드사인으로 번들 정체성을 고정한다.
set -euo pipefail

APP="Meeting Slides.app"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc가 필요합니다 (Xcode Command Line Tools: xcode-select --install)"
  exit 1
fi

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

echo "▶ 런처 컴파일 중 (macos/launcher.swift)…"
swiftc -O -o "$APP/Contents/MacOS/meeting-slides" macos/launcher.swift \
  -framework AVFoundation -framework AppKit -framework Foundation
chmod +x "$APP/Contents/MacOS/meeting-slides"

echo "▶ ad-hoc 코드사인 중…"
codesign --force --deep --sign - "$APP"

echo ""
echo "✅ 빌드 완료: $PROJ/$APP"
echo ""
echo "사용법:"
echo "  1. 최초 1회: Finder에서 '$APP' 우클릭 → 열기 (Gatekeeper)"
echo "  2. \"Meeting Slides\" 마이크 권한 프롬프트 → 허용 (영구 적용)"
echo "  3. 이후 더블클릭/Spotlight로 실행하면 서버 + 브라우저 자동 오픈"
