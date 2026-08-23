#!/usr/bin/env bash
# Emit a protected path/hash table. Content SHA-256 for normal files;
# metadata identity (size+mtime) for two cases that cannot be content-hashed
# honestly in a bounded read-only inventory:
#
#   1. multi-GB model weights - full content hashing is unbounded work.
#   2. macOS `dataless` files (iCloud/cloud-evicted). Reading one returns
#      ZERO bytes with no error, so shasum silently emits the empty-string
#      digest e3b0c442...b855 for a file that is not empty. Hashing them
#      would also force a multi-GB cloud download as a side effect.
#
# Both are labeled `size+mtime` so no reader mistakes them for content proof.
set -o pipefail
LARGE_LIMIT=$((64*1024*1024))
printf 'path\tclass\tbytes\tmtime_utc\tidentity_kind\tidentity\n'
while IFS= read -r p; do
  [ -f "$p" ] || continue
  bytes=$(stat -f %z "$p")
  mtime=$(date -u -r "$(stat -f %m "$p")" +%Y-%m-%dT%H:%M:%SZ)
  flags=$(stat -f '%Sf' "$p")
  cls="$1"
  case "$flags" in
    *dataless*)
      printf '%s\t%s\t%s\t%s\tsize+mtime(dataless)\t%s\n' "$p" "$cls" "$bytes" "$mtime" "bytes=$bytes;mtime=$mtime"
      continue ;;
  esac
  if [ "$bytes" -gt "$LARGE_LIMIT" ]; then
    printf '%s\t%s\t%s\t%s\tsize+mtime\t%s\n' "$p" "$cls" "$bytes" "$mtime" "bytes=$bytes;mtime=$mtime"
  else
    # </dev/null is mandatory: without it shasum inherits and drains the
    # while-read stdin, silently emitting the empty-string digest.
    h=$(shasum -a 256 "$p" </dev/null | awk '{print $1}')
    printf '%s\t%s\t%s\t%s\tsha256\t%s\n' "$p" "$cls" "$bytes" "$mtime" "$h"
  fi
done
