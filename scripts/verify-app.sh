#!/usr/bin/env bash
# Verify a built Meeting Slides.app bundle as an artifact.
#
# This runs against a bundle, not against the build: it is what proves an
# incomplete or tampered bundle is rejected before anyone installs or trusts it.
# Usage: scripts/verify-app.sh [path/to/Meeting Slides.app]
set -euo pipefail

APP="${1:-$HOME/Applications/Meeting Slides.app}"
CONTENTS="$APP/Contents"
EXEC="$CONTENTS/MacOS/meeting-slides"
PLIST="$CONTENTS/Info.plist"
RESOURCES="$CONTENTS/Resources"

fail() {
  echo "FAIL: $1"
  exit 1
}

[[ -d "$APP" ]] || fail "no bundle at $APP"

# --- required files, each non-empty ---
for required in "$PLIST" "$EXEC" "$RESOURCES/project-path.txt"; do
  [[ -f "$required" ]] || fail "missing ${required#"$CONTENTS/"}"
  [[ -s "$required" ]] || fail "empty ${required#"$CONTENTS/"}"
done
[[ -x "$EXEC" ]] || fail "MacOS/meeting-slides is not executable"

# --- Info.plist identity and the TCC strings the runtime actually needs ---
plutil -lint "$PLIST" >/dev/null || fail "Info.plist does not lint"
for key in CFBundleIdentifier CFBundleExecutable CFBundleShortVersionString \
  CFBundleVersion NSMicrophoneUsageDescription NSAudioCaptureUsageDescription NSCalendarsUsageDescription \
  NSCalendarsFullAccessUsageDescription; do
  value="$(plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null || true)"
  [[ -n "$value" ]] || fail "Info.plist missing $key"
done
[[ "$(plutil -extract CFBundleIdentifier raw -o - "$PLIST")" == "com.meetingslides.app" ]] \
  || fail "unexpected CFBundleIdentifier"
[[ "$(plutil -extract CFBundleExecutable raw -o - "$PLIST")" == "meeting-slides" ]] \
  || fail "unexpected CFBundleExecutable"

# --- every split native module is inside the one packaged executable ---
symbols="$(strings -a "$EXEC")"
for module in LauncherEnvironment ServerLifecycle NativeSurfaceGeometry \
  StopCommandGuard TransportClient MinibarProjection MinibarWindowController \
  MinibarView MinibarPanel SystemAudioCapture; do
  grep -q "$module" <<<"$symbols" || fail "packaged executable is missing $module"
done
grep -q 'statusItemWithLength:' <<<"$symbols" || fail "packaged executable has no menu-bar item"
grep -q 'sharedWorkspace' <<<"$symbols" || fail "packaged executable cannot open the browser workspace"

# --- the packaged project path must be a usable checkout ---
project="$(tr -d '\n' <"$RESOURCES/project-path.txt")"
[[ -f "$project/server.ts" ]] || fail "packaged project-path.txt has no server.ts: $project"
[[ -f "$project/package.json" ]] || fail "packaged project-path.txt has no package.json: $project"

# --- current browser asset graph: one generated-slide and one operator source ---
for asset in public/index.html public/style.css public/caret-operator.css \
  public/operator-surface.js public/app.js public/generated/module-manifest.json; do
  [[ -s "$project/$asset" ]] || fail "project is missing current browser asset: $asset"
done
index="$project/public/index.html"
grep -q 'href="/style.css"' "$index" || fail "index has no generated-slide stylesheet"
grep -q 'href="/caret-operator.css"' "$index" || fail "index has no operator stylesheet"
grep -q 'type="module" src="/app.js"' "$index" || fail "index has no app module"
grep -Fq 'from "./operator-surface.js"' "$project/public/app.js" || fail "app module has no operator surface import"
if grep -Eq 'workspace-shell\.css|operational-liquid\.css|caret-shell\.css|caret-foundation\.css|transcript-overlay' "$index"; then
  fail "obsolete active shell reference in public/index.html"
fi

# --- linkage: browser workspace, never an embedded web view ---
linked="$(otool -L "$EXEC")"
grep -q 'WebKit' <<<"$linked" && fail "packaged executable links WebKit"
grep -q 'AppKit' <<<"$linked" || fail "packaged executable does not link AppKit"

# --- signing ---
codesign --verify --deep --strict "$APP" || fail "codesign --verify --deep --strict failed"
# Capture first: `grep -q` closes the pipe on its first match, which under
# `pipefail` turns codesign's SIGPIPE into a spurious verification failure.
signing="$(codesign -dvvv "$APP" 2>&1)"
grep -q 'Signature=adhoc' <<<"$signing" || fail "bundle is not ad-hoc signed"
grep -q 'Identifier=com.meetingslides.app' <<<"$signing" || fail "unexpected signing identifier"

echo "OK bundle verified: $APP"
