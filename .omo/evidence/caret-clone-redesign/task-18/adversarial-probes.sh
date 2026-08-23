#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
out=.omo/evidence/caret-clone-redesign/task-18/adversarial-probes.txt
scratch="$(mktemp -d)"
cp public/index.html public/style.css public/caret-operator.css README.md DESIGN.md "$scratch/"
cleanup() {
  cp "$scratch/index.html" public/index.html
  cp "$scratch/style.css" public/style.css
  cp "$scratch/caret-operator.css" public/caret-operator.css
  cp "$scratch/README.md" README.md
  cp "$scratch/DESIGN.md" DESIGN.md
  for f in public/workspace-shell.css public/operational-liquid.css public/caret-shell.css \
    public/caret-foundation.css public/transcript-overlay.css public/transcript-overlay.js \
    'public/transcript-overlay 2.css' 'public/transcript-overlay 2.js' \
    'public/review-panel 2.js' 'public/review-panel-render 2.js'; do rm -f "$f"; done
  rm -rf "$scratch"
}
trap cleanup EXIT
: > "$out"
probe() {
  local name="$1"
  shift
  cleanup_one() { :; }
  "$@"
  if bun test tests/public-active-shell.test.ts >>"$out" 2>&1; then
    echo "UNEXPECTED_GREEN $name" | tee -a "$out"
    exit 1
  fi
  echo "EXPECTED_RED $name" | tee -a "$out"
  cp "$scratch/index.html" public/index.html
  cp "$scratch/style.css" public/style.css
  cp "$scratch/caret-operator.css" public/caret-operator.css
  cp "$scratch/README.md" README.md
  cp "$scratch/DESIGN.md" DESIGN.md
}
add_ref() { PROBE_SNIPPET="$1" bun -e 'const p="public/index.html";let s=await Bun.file(p).text();s=s.replace("</head>",`  ${process.env.PROBE_SNIPPET}\n</head>`);await Bun.write(p,s)'; }
append_file() { mkdir -p "$(dirname "$1")"; printf 'obsolete probe\n' > "$1"; }
remove_css() { PROBE_SNIPPET="$1" bun -e 'const p="public/caret-operator.css";let s=await Bun.file(p).text();s=s.replace(process.env.PROBE_SNIPPET,"");await Bun.write(p,s)'; }
append_doc() { printf '\n%s\n' "$2" >> "$1"; }

for ref in workspace-shell.css operational-liquid.css caret-shell.css caret-foundation.css; do
  probe "active-reference:$ref" add_ref "<link rel=\"stylesheet\" href=\"/$ref\">"
done
probe "active-reference:transcript-overlay.js" add_ref '<script src="/transcript-overlay.js"></script>'
for file in public/workspace-shell.css public/operational-liquid.css public/caret-shell.css \
  public/caret-foundation.css public/transcript-overlay.css public/transcript-overlay.js \
  'public/transcript-overlay 2.css' 'public/transcript-overlay 2.js' \
  'public/review-panel 2.js' 'public/review-panel-render 2.js'; do
  probe "deleted-file:$file" append_file "$file"
  rm -f "$file"
done
probe "duplicate-app-owner" add_ref '<div class="app"></div>'
probe "obsolete-selector" bash -c 'printf "\nbody.caret-shell .app { display:block }\n" >> public/caret-operator.css'
probe "style-cross-owns-operator" bash -c 'printf "\n.app[data-shell=\"live\"] .workspace { grid-template-columns: 1fr; }\n" >> public/style.css'
probe "operator-cross-owns-generated" bash -c 'printf "\n.slide__inner--live { display:grid; } .review-panel { color:white; }\n" >> public/caret-operator.css'
probe "remove-target-token" remove_css '--cf-target-min: 44px;'
probe "remove-narrow-status" remove_css '.app .topbar__status > #status-text'
probe "remove-reduced-transition" remove_css 'transition-duration: 0s !important;'
probe "remove-reduced-animation" remove_css 'animation-duration: 0s !important;'
probe "stale-browser-launcher" append_doc README.md 'This is a browser-only launcher.'
probe "stale-privacy-claim" append_doc README.md 'Screen share hides and excludes the private window.'
probe "stale-privacy-rationale" append_doc DESIGN.md 'NSWindow.SharingType.none is legacy and unhonored.'

echo "ALL_ADVERSARIAL_PROBES_RED" | tee -a "$out"
