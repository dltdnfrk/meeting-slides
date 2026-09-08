#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Meeting Slides.app"
BUNDLE_ID="com.meetingslides.app"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
APP_INSTALL_DIR="${MEETING_SLIDES_APP_DIR:-$HOME/Applications}"
APP="$APP_INSTALL_DIR/$APP_NAME"
PROJECT_APP_LINK="$PROJ/$APP_NAME"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS_DIR="$CONTENTS/MacOS"
TMP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/meeting-slides-build.XXXXXX")"
trap 'rm -rf "$TMP_BUILD"' EXIT

cd "$PROJ"
mkdir -p "$APP_INSTALL_DIR"

for tool in swiftc codesign plutil xattr; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing tool: $tool (xcode-select --install)"
    exit 1
  fi
done

rm -rf "$CONTENTS"
mkdir -p "$MACOS_DIR" "$RESOURCES"

cat > "$CONTENTS/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Meeting Slides</string>
  <key>CFBundleDisplayName</key><string>Meeting Slides</string>
  <key>CFBundleIdentifier</key><string>com.meetingslides.app</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleExecutable</key><string>meeting-slides</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>회의 음성을 로컬에서 전사하기 위해 마이크가 필요합니다.</string>
  <key>NSAudioCaptureUsageDescription</key><string>Zoom이나 브라우저에서 재생되는 회의 소리를 로컬에서 전사하기 위해 컴퓨터 오디오가 필요합니다.</string>
  <key>NSCalendarsUsageDescription</key><string>다음 회의 시작에 맞춰 녹음을 자동으로 시작하기 위해 캘린더 일정을 읽습니다.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>다음 회의 시작에 맞춰 녹음을 자동으로 시작하기 위해 캘린더 일정을 읽습니다.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>LSUIElement</key><false/>
</dict>
</plist>
EOF

# The launcher resolves this marker, then reads .env for HTTP_PORT and runs
# `bun run server.ts` there. Packaging a path without that entry point would
# ship a launcher that cannot start the session it promises.
if [[ ! -f "$PROJ/server.ts" || ! -f "$PROJ/package.json" ]]; then
  echo "refusing to package: $PROJ has no server.ts/package.json"
  exit 1
fi
printf '%s\n' "$PROJ" > "$RESOURCES/project-path.txt"

if [[ -f "$HOME/Applications/Meeting Slides.app/Contents/Resources/AppIcon.icns" ]]; then
  cp "$HOME/Applications/Meeting Slides.app/Contents/Resources/AppIcon.icns" "$RESOURCES/AppIcon.icns" || true
fi

echo "compile browser webapp launcher…"
swiftc -O -o "$MACOS_DIR/meeting-slides" \
  macos/launcher.swift \
  macos/AppLifecycle.swift \
  macos/NativeSurfaceContract.swift \
  macos/TransportClient.swift \
  macos/MinibarProjection.swift \
  macos/MinibarWindowController.swift \
  macos/MinibarView.swift \
  macos/SystemAudioCapture.swift \
  -framework AVFoundation \
  -framework CoreAudio \
  -framework AudioToolbox \
  -framework AppKit \
  -framework Foundation
chmod +x "$MACOS_DIR/meeting-slides"

plutil -lint "$CONTENTS/Info.plist" >/dev/null
xattr -cr "$APP" || true
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --deep --strict "$APP"

# The repository symlink names the canonical installed app. A redirected build
# (MEETING_SLIDES_APP_DIR, e.g. a test or a throwaway bundle) must never
# repoint it at a temporary directory that is about to be deleted.
if [[ "$APP_INSTALL_DIR" == "$HOME/Applications" && "$PROJECT_APP_LINK" != "$APP" ]]; then
  rm -rf "$PROJECT_APP_LINK"
  ln -sfn "$APP" "$PROJECT_APP_LINK"
fi

if strings "$MACOS_DIR/meeting-slides" | rg -q 'WKWebView|WebKit\.framework'; then
  # Framework linkage would also show in otool
  if otool -L "$MACOS_DIR/meeting-slides" | rg -q 'WebKit'; then
    echo "build still links WebKit"
    exit 1
  fi
fi
if otool -L "$MACOS_DIR/meeting-slides" | rg -q 'WebKit'; then
  echo "build still links WebKit"
  exit 1
fi

printf '\nOK webapp launcher: %s\n' "$APP"
printf 'mode: default browser -> http://localhost (not WKWebView/Tauri)\n'
printf 'project: %s\n' "$PROJ"
printf 'run: open \"%s\"\n' "$APP"
printf 'log: ~/Library/Logs/Meeting Slides/launcher.log\n'
