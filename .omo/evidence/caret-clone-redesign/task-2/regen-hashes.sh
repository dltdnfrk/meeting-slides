#!/usr/bin/env bash
# Regenerate the protected hash table in the exact same order/classes as the before-table.
H=".omo/evidence/caret-clone-redesign/task-2/hash-protected.sh"
{
printf '%s\n' src/providers.ts src/config.ts src/llm.ts src/provider-adapters.ts src/app-settings.ts src/minutes.ts .env.example server.ts README.md tests/providers.test.ts tests/app-settings.test.ts | $H provider-alibaba
printf '%s\n' models/ggml-large-v3-turbo.bin models/ggml-medium.bin models/stt/ggml-large-v3-turbo-q8_0.bin models/stt/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf | $H model-weights | tail -n +2
printf '%s\n' HANDOFF.md | $H handoff | tail -n +2
printf '%s\n' DESIGN.md .omo/plans/caret-clone-redesign.md .omo/drafts/caret-clone-redesign.md .omo/plans/tiro-operator-rebuild.md | $H redesign-input | tail -n +2
find .omo/ulw-research -type f | sort | $H research-artifact | tail -n +2
find .omo/ulw-loop -type f | sort | $H research-artifact | tail -n +2
printf '%s\n' public/index.html public/style.css public/workspace-shell.css public/operational-liquid.css public/caret-shell.css public/app.js public/operator-surface.js public/workspace-split.js public/transcript-resize.js public/review-panel.js public/review-panel-render.js | $H product-surface | tail -n +2
}
