#!/bin/bash
# Restore iCloud/File Provider-evicted files before builds or tests.
#
# Usage:
#   scripts/ensure-resident.sh             # request downloads
#   scripts/ensure-resident.sh --dry-run   # report evicted files only
#   scripts/ensure-resident.sh --wait      # request downloads and wait for completion
#
# The scan uses Foundation's ubiquitous-item status rather than reading files;
# this avoids blocking on compressed,dataless File Provider nodes.
set -euo pipefail

case "${1:-}" in
  ""|--wait|--dry-run) mode="${1:---request}" ;;
  -h|--help)
    sed -n '2,9p' "$0"
    exit 0
    ;;
  *)
    echo "usage: $0 [--dry-run|--wait]" >&2
    exit 2
    ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
paths=()
for name in node_modules models vendor; do
  [[ -d "$root/$name" ]] && paths+=("$root/$name")
done
if ((${#paths[@]} == 0)); then
  echo "No resident-data directories found."
  exit 0
fi

helper=$(mktemp "${TMPDIR:-/tmp}/ensure-resident.XXXXXX.swift")
binary="${helper%.swift}"
trap 'rm -f "$helper" "$binary"' EXIT
cat >"$helper" <<'SWIFT'
import Foundation

let dryRun = CommandLine.arguments.contains("--dry-run")
let keys: Set<URLResourceKey> = [
  .isRegularFileKey, .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey
]
var found = 0
var requested = 0
var errors = 0
for path in CommandLine.arguments.dropFirst().filter({ $0 != "--dry-run" }) {
  let root = URL(fileURLWithPath: path)
  guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys)) else { continue }
  for case let url as URL in enumerator {
    do {
      let values = try url.resourceValues(forKeys: keys)
      guard values.isRegularFile == true,
            values.isUbiquitousItem == true,
            values.ubiquitousItemDownloadingStatus != .current else { continue }
      found += 1
      print("\(dryRun ? "EVICTED" : "DOWNLOAD_REQUEST") \(url.path)")
      if !dryRun {
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        requested += 1
      }
    } catch {
      errors += 1
      fputs("ERROR \(url.path): \(error)\n", stderr)
    }
  }
}
print("FOUND \(found) REQUESTED \(requested) ERRORS \(errors)")
exit(errors == 0 ? 0 : 1)
SWIFT

swiftc "$helper" -o "$binary"
if [[ "$mode" == "--dry-run" ]]; then
  "$binary" --dry-run "${paths[@]}"
else
  "$binary" "${paths[@]}"
fi

if [[ "$mode" == "--wait" ]]; then
  echo "Waiting for requested files to finish downloading..."
  while "$binary" --dry-run "${paths[@]}" | grep -q '^EVICTED '; do
    sleep 1
  done
  echo "All files are resident."
fi
