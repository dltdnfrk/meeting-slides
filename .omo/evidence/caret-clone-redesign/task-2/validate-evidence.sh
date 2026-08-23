#!/usr/bin/env bash
# Task 2 evidence validator.
# Verifies: boundary receipt, pre-work status, protected hash table shape,
# every path named in the ledger/load-order actually exists, and that no
# protected file changed content between the before and after hash tables.
# Exit 0 = all checks pass; 1 = at least one check failed.
set -o nounset
set -o pipefail

readonly CANONICAL_ROOT="/Users/hyunjun/Documents/MUNI/meeting-slides"
[ "$(pwd -P)" = "$CANONICAL_ROOT" ] || { echo "FAIL: must run from $CANONICAL_ROOT" >&2; exit 1; }

D=".omo/evidence/caret-clone-redesign/task-2"
G="$D/green"
fails=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fails=$((fails+1)); }

echo "== 1. required artifacts present =="
for f in \
  "$D/boundary-validator.sh" \
  "$G/boundary-receipt.json" "$G/boundary-happy.log" \
  "$G/pre-work-status.txt" "$G/protected-hashes-before.tsv" \
  "$G/active-load-order.md" "$G/ledger.md" \
  "$G/css-rule-map.tsv" "$G/layer-overlap.txt" \
  "$G/unreferenced-selector-candidates.tsv" \
  "$D/failure/boundary-failure.log"; do
  if [ -s "$f" ]; then ok "$f"; else bad "missing or empty: $f"; fi
done

echo "== 2. boundary receipt says pass and matches live repo =="
if grep -q '"verdict": "pass"' "$G/boundary-receipt.json"; then ok "verdict=pass"; else bad "verdict not pass"; fi
live_root="$(git rev-parse --show-toplevel)"
grep -q "\"git_top_level\": \"$live_root\"" "$G/boundary-receipt.json" && ok "git_top_level matches live repo" || bad "git_top_level mismatch"
grep -q "\"origin\": \"$(git remote get-url origin)\"" "$G/boundary-receipt.json" && ok "origin matches live repo" || bad "origin mismatch"

echo "== 3. failure log proves non-zero exit with no write =="
grep -q 'exit=2' "$D/failure/boundary-failure.log" && ok "recorded exit=2" || bad "no exit=2 recorded"
grep -q 'PASS no file created' "$D/failure/boundary-failure.log" && ok "no-write proven" || bad "no-write not proven"
for leak in "$D/SHOULD-NOT-EXIST.json" "$D/SHOULD-NOT-EXIST-2.json"; do
  [ -e "$leak" ] && bad "probe artifact leaked: $leak" || ok "absent: $(basename "$leak")"
done

echo "== 4. protected hash table shape =="
hdr="$(head -1 "$G/protected-hashes-before.tsv")"
[ "$hdr" = "$(printf 'path\tclass\tbytes\tmtime_utc\tidentity_kind\tidentity')" ] && ok "header" || bad "bad header: $hdr"
rows=$(tail -n +2 "$G/protected-hashes-before.tsv" | grep -cv '^path\b')
echo "  rows: $rows"
[ "$rows" -ge 200 ] && ok "row count >= 200" || bad "row count too low: $rows"
badcols=$(awk -F'\t' 'NR>1 && $0!~/^path\t/ && NF!=6' "$G/protected-hashes-before.tsv" | wc -l | tr -d ' ')
[ "$badcols" = "0" ] && ok "every row has 6 columns" || bad "$badcols malformed rows"
missing=0
while IFS=$'\t' read -r p _rest; do
  [ "$p" = "path" ] && continue
  [ -f "$p" ] || { echo "    missing protected path: $p"; missing=$((missing+1)); }
done < "$G/protected-hashes-before.tsv"
[ "$missing" = "0" ] && ok "every protected path still exists" || bad "$missing protected paths vanished"

echo "== 5. paths referenced by the ledger exist =="
# Collect both fully-qualified paths (`public/style.css:726`) and bare
# filenames (`app.js:927`, `style.css:1377-1960`); bare names resolve
# against public/, which is where every shipped asset lives.
refs=$(mktemp)
{
  grep -ohE '`(public|tests|src|macos|scripts|\.omo)/[A-Za-z0-9._/-]+' "$G/ledger.md" "$G/active-load-order.md" | tr -d '`'
  # Bare shipped-asset names only; sibling evidence docs (*.md) are not under public/.
  grep -ohE '`[A-Za-z0-9_-]+\.(css|js|html)[`:]' "$G/ledger.md" "$G/active-load-order.md" \
    | tr -d '`:' | sed 's|^|public/|'
} | sed 's/:.*$//' | sort -u > "$refs"
lref=0; lbad=0
while read -r p; do
  [ -n "$p" ] || continue
  lref=$((lref+1))
  [ -e "$p" ] || { echo "    ledger references missing path: $p"; lbad=$((lbad+1)); }
done < "$refs"
echo "  distinct referenced paths: $lref"
rm -f "$refs"
[ "$lbad" = "0" ] && ok "all ledger/load-order paths exist" || bad "$lbad referenced paths missing"

echo "== 5b. every line range cited in the ledger is within its file =="
# Citations look like `public/style.css:1377-1960` or `app.js:927`.
# Parse path / low / high with awk so multi-digit ranges survive intact.
rbad=0; rtot=0
while read -r f lo hi; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  rtot=$((rtot+1))
  n=$(wc -l < "$f" | tr -d ' ')
  [ "$hi" -le "$n" ] && [ "$lo" -le "$hi" ] || {
    echo "    out-of-range citation: $f:$lo-$hi (file has $n lines)"; rbad=$((rbad+1)); }
done < <(grep -ohE '`(public/)?[A-Za-z0-9._/-]+\.(css|js|html|ts):[0-9]+(-[0-9]+)?' \
            "$G/ledger.md" "$G/active-load-order.md" \
  | tr -d '`' \
  | awk -F: '{
      p = $1; r = $2;
      if (p !~ /\//) p = "public/" p;
      lo = r; hi = r;
      if (index(r, "-") > 0) { split(r, a, "-"); lo = a[1]; hi = a[2]; }
      print p, lo, hi;
    }' | sort -u)
echo "  citations checked: $rtot"
[ "$rbad" = "0" ] && ok "all cited line ranges are in range" || bad "$rbad out-of-range citations"

echo "== 6. protected content unchanged (before vs after) =="
# Asserted on CONTENT, not mtime. Sibling wave-1 todos mutate and restore
# product files during their RED/GREEN proofs, which advances mtime while
# leaving bytes identical; that must not be reported as a protected change.
after="$G/protected-hashes-after.tsv"
if [ -s "$after" ]; then
  diff -u "$G/protected-hashes-before.tsv" "$after" > "$G/protected-hashes-diff.txt" 2>&1 || true

  cmis=$(join -t$'\t' -j1 \
    <(awk -F'\t' '$5=="sha256"{print $1"\t"$6}' "$G/protected-hashes-before.tsv" | sort) \
    <(awk -F'\t' '$5=="sha256"{print $1"\t"$6}' "$after" | sort) \
    | awk -F'\t' '$2!=$3' | tee "$G/protected-content-mismatches.txt" | wc -l | tr -d ' ')
  [ "$cmis" = "0" ] && ok "sha256 identical for every content-hashed path" \
                     || bad "$cmis content-hashed paths changed (see protected-content-mismatches.txt)"

  smis=$(join -t$'\t' -j1 \
    <(awk -F'\t' '$5!="sha256" && NR>1{print $1"\t"$3}' "$G/protected-hashes-before.tsv" | sort) \
    <(awk -F'\t' '$5!="sha256" && NR>1{print $1"\t"$3}' "$after" | sort) \
    | awk -F'\t' '$2!=$3' | wc -l | tr -d ' ')
  [ "$smis" = "0" ] && ok "size identical for every dataless path" \
                     || bad "$smis dataless paths changed size"

  if diff -q "$G/protected-hashes-before.tsv" "$after" >/dev/null 2>&1; then
    ok "tables byte-identical (no mtime drift either)"
  else
    echo "  NOTE  mtime-only drift from concurrent sibling tasks:"
    grep -E '^[+-](public|src|tests)/' "$G/protected-hashes-diff.txt" | head -6 | sed 's/^/        /'
  fi
else
  echo "  SKIP  after-table not generated yet"
fi

echo
if [ "$fails" = "0" ]; then echo "EVIDENCE-VALID: all checks passed"; exit 0; fi
echo "EVIDENCE-INVALID: $fails check(s) failed"; exit 1
