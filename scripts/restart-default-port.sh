#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HTTP_PORT:-8787}"
DB="${MEETINGS_DB_PATH:-$ROOT/meetings.db}"

echo "Stopping listeners on :$PORT (if any)..."
if command -v lsof >/dev/null 2>&1; then
  pids=($(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true))
  if (( ${#pids[@]} > 0 )); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    sleep 1
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi
fi

cd "$ROOT"
export OPEN_BROWSER="${OPEN_BROWSER:-false}"
export HTTP_PORT="$PORT"
export MEETINGS_DB_PATH="$DB"
echo "Starting Meeting Slides on http://localhost:$PORT"
exec /Users/hyunjun/.bun/bin/bun server.ts
