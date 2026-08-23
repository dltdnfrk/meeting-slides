#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../../.."
scratch="$(mktemp -d)"
cp public/style.css public/caret-operator.css "$scratch/"
restore() {
  cp "$scratch/style.css" public/style.css
  cp "$scratch/caret-operator.css" public/caret-operator.css
}
cleanup() { restore; rm -rf "$scratch"; }
trap cleanup EXIT

run_red() {
  local log="$1" label="$2" file="$3" snippet="$4"
  restore
  PROBE_FILE="$file" PROBE_SNIPPET="$snippet" bun -e \
    'const p=process.env.PROBE_FILE; await Bun.write(p,(await Bun.file(p).text())+"\n"+process.env.PROBE_SNIPPET+"\n")'
  echo "## $label" >> "$log"
  echo "$snippet" >> "$log"
  set +e
  bun test tests/public-active-shell.test.ts >> "$log" 2>&1
  local code=$?
  set -e
  echo "EXIT=$code" >> "$log"
  if [[ $code -eq 0 ]]; then echo "UNEXPECTED_GREEN $label" >> "$log"; exit 1; fi
  echo "EXPECTED_RED $label" >> "$log"
}

is_log=.omo/evidence/caret-clone-redesign/task-18/repair-3/red/01-four-is-mutations.txt
adv_log=.omo/evidence/caret-clone-redesign/task-18/repair-3/red/02-adversarial-selector-mutations.txt
benign_log=.omo/evidence/caret-clone-redesign/task-18/repair-3/green/01-benign-lookalikes.txt
: > "$is_log"; : > "$adv_log"; : > "$benign_log"

run_red "$is_log" 'is-style-workspace' public/style.css ':is(.workspace) { color: red; }'
run_red "$is_log" 'is-style-workspace-prefix' public/style.css '.safe:is(.workspace--resizing) { color: red; }'
run_red "$is_log" 'is-operator-slide-root' public/caret-operator.css ':is(.slide__inner--live) { color: red; }'
run_red "$is_log" 'is-operator-review-root' public/caret-operator.css ':is(.review-panel) { color: red; }'

run_red "$adv_log" 'where' public/style.css ':where(.workspace) { color: red; }'
run_red "$adv_log" 'has-nested-functional' public/style.css '.safe:has(:not(:is(.document-surface))) { color: red; }'
run_red "$adv_log" 'comma' public/style.css '.safe, .workspace-grid { color: red; }'
run_red "$adv_log" 'escaped-operator-hex' public/style.css '.\77 orkspace { color: red; }'
run_red "$adv_log" 'comments-between-selector-tokens' public/style.css '.safe/**/.workspace { color: red; }'
run_red "$adv_log" 'escaped-generated-hex' public/caret-operator.css '.slide__inner--\6c ive { color: red; }'
run_red "$adv_log" 'nested-generated-functional' public/caret-operator.css ':has(:where(.review-panel__head)) { color: red; }'

restore
PROBE_STYLE='.safe[data-copy=".workspace :is(.review-panel)"] { --copy: ".workspace .slide__inner--live"; background: url("data:image/svg+xml;utf8,<svg>{/* .review-panel */}</svg>"); content: "} {"; }' \
PROBE_OPERATOR='.safe-two[data-copy=".slide__inner--live .review-panel"] { --copy: ".workspace"; background: url("data:text/plain,.workspace"); content: "/* } */"; }' \
bun -e 'await Bun.write("public/style.css",(await Bun.file("public/style.css").text())+"\n"+process.env.PROBE_STYLE+"\n"); await Bun.write("public/caret-operator.css",(await Bun.file("public/caret-operator.css").text())+"\n"+process.env.PROBE_OPERATOR+"\n")'
echo '## benign attribute/string/url/data/custom-property/quoted-brace lookalikes' >> "$benign_log"
bun test tests/public-active-shell.test.ts >> "$benign_log" 2>&1
echo 'EXPECTED_GREEN benign-lookalikes' >> "$benign_log"
restore
shasum -a 256 public/style.css public/caret-operator.css > .omo/evidence/caret-clone-redesign/task-18/repair-3/product-hashes-restored.txt
