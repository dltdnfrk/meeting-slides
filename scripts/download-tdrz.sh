#!/bin/zsh
# tinydiarize 화자 분리 모델 다운로드 (영어 전용)
# 사용: scripts/download-tdrz.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/models/ggml-small.en-tdrz.bin"
URL="https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin"

if [[ -f "$TARGET" ]]; then
  echo "이미 존재: $TARGET"
  exit 0
fi

echo "다운로드 중: $URL"
curl -L --fail --progress-bar -o "$TARGET" "$URL"
echo "완료: $TARGET"
echo "활성화: .env에 WHISPER_DIARIZE=true"
