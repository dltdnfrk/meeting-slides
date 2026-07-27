#!/usr/bin/env bash
# ============================================================
# install-login-item.sh — 로그인 시 Meeting Slides 자동 시작
# ============================================================
# macOS 로그인 항목에 앱을 등록한다 (시스템 설정 → 일반 → 로그인 항목에서
# 언제든 제거 가능). 제거하려면 --remove 옵션.
set -euo pipefail

APP_PATH="$(cd "$(dirname "$0")/.." && pwd)/Meeting Slides.app"

if [ ! -d "$APP_PATH" ]; then
  echo "앱이 없습니다: 먼저 scripts/build-app.sh 를 실행하세요."
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  osascript -e "tell application \"System Events\" to delete (login items whose path is \"$APP_PATH\")" 2>/dev/null || true
  echo "로그인 항목에서 제거했습니다."
  exit 0
fi

osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP_PATH\", hidden:false}"
echo "✅ 로그인 항목 등록: $APP_PATH"
echo "   다음 로그인부터 Meeting Slides 서버가 자동으로 켜집니다."
echo "   제거: scripts/install-login-item.sh --remove 또는 시스템 설정 → 일반 → 로그인 항목"
