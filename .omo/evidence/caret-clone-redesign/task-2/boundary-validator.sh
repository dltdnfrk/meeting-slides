#!/usr/bin/env bash
# Task 2 boundary validator - caret-clone-redesign
#
# Contract: refuse to perform ANY write when the invoking cwd is not the
# canonical Meeting Slides root. Every check runs BEFORE the single write
# at the end, so a boundary failure leaves the filesystem untouched.
#
# Usage:  boundary-validator.sh [--emit <receipt-path>]
# Exit:   0 = boundary valid (receipt written if --emit given)
#         2 = boundary violation (NOTHING written)
#         3 = usage error
set -o nounset
set -o pipefail

readonly CANONICAL_ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
readonly CANONICAL_ORIGIN="https://github.com/dltdnfrk/meeting-slides.git"
readonly CMD_TIMEOUT=20

EMIT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --emit) EMIT="${2-}"; [ -n "$EMIT" ] || { echo "usage: --emit needs a path" >&2; exit 3; }; shift 2 ;;
    *) echo "usage: $0 [--emit <receipt-path>]" >&2; exit 3 ;;
  esac
done

fail() { echo "BOUNDARY-FAIL: $1" >&2; echo "no-write: validator exited before any filesystem write" >&2; exit 2; }

# Bound every external command; a hung git must not hang the validator.
# macOS ships no coreutils `timeout`, so use a portable perl watchdog.
run() { perl -e 'my $t=shift; $SIG{ALRM}=sub{ exit 124 }; alarm $t; exec @ARGV or exit 127;' "$CMD_TIMEOUT" "$@" 2>/dev/null; }

phys_cwd="$(pwd -P)"
[ "$phys_cwd" = "$CANONICAL_ROOT" ] || fail "cwd '$phys_cwd' != canonical root '$CANONICAL_ROOT'"

git_root="$(run git rev-parse --show-toplevel)" || fail "git rev-parse failed from '$phys_cwd'"
[ -n "$git_root" ] || fail "no git top-level resolved from '$phys_cwd'"
git_root_phys="$(cd "$git_root" && pwd -P)"
[ "$git_root_phys" = "$CANONICAL_ROOT" ] || fail "git top-level '$git_root_phys' != canonical root '$CANONICAL_ROOT'"

origin="$(run git remote get-url origin)" || fail "origin remote unreadable"
[ "$origin" = "$CANONICAL_ORIGIN" ] || fail "origin '$origin' != '$CANONICAL_ORIGIN'"

head_sha="$(run git rev-parse HEAD)" || fail "HEAD unreadable"
branch="$(run git rev-parse --abbrev-ref HEAD)" || fail "branch unreadable"
status_count="$(run git status --porcelain=v1 -uall | wc -l | tr -d ' ')"

echo "BOUNDARY-OK cwd=$phys_cwd git_root=$git_root_phys origin=$origin branch=$branch head=$head_sha dirty_entries=$status_count"

# Single write, only reachable after every check passed.
if [ -n "$EMIT" ]; then
  printf '{\n  "verdict": "pass",\n  "physical_cwd": "%s",\n  "git_top_level": "%s",\n  "origin": "%s",\n  "branch": "%s",\n  "head": "%s",\n  "dirty_entries": %s,\n  "checked_at_utc": "%s"\n}\n' \
    "$phys_cwd" "$git_root_phys" "$origin" "$branch" "$head_sha" "$status_count" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$EMIT" || fail "receipt write failed at '$EMIT'"
  echo "receipt: $EMIT"
fi
exit 0
