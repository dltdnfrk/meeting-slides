// Independent acceptance gate for Todo 1. Trusts NOTHING the capture drivers claimed:
// re-reads every file, re-hashes it, re-parses PNG dimensions, and re-checks state coverage.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { BASELINE_VIEWPORTS, TASK_ROOT, pngDimensions, sha256File, writeJson, isoNow } from "./capture-lib.mjs";

const manifest = JSON.parse(readFileSync(join(TASK_ROOT, "manifest.json"), "utf-8"));
// The packet records its canonical root, so the validator still checks the REAL repository
// even when the packet itself is copied to a sandbox for adversarial probing.
const REPO_ROOT = existsSync(join(manifest.canonicalRoot ?? "", ".git"))
  ? manifest.canonicalRoot
  : resolve(TASK_ROOT, "../../../..");

const failures = [];
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  if (!pass) failures.push(`${name}: ${detail}`);
};

// --- 1. Every state carries the full required record ---------------------------------
for (const state of manifest.states) {
  const label = `state:${state.id}`;
  check(`${label}/url`, typeof state.sourceUrl === "string" && state.sourceUrl.length > 0, state.sourceUrl);
  check(
    `${label}/viewport`,
    Number.isInteger(state.viewport?.width) && Number.isInteger(state.viewport?.height),
    JSON.stringify(state.viewport),
  );
  check(
    `${label}/timestamp`,
    typeof state.capturedAt === "string" && !Number.isNaN(Date.parse(state.capturedAt)),
    state.capturedAt,
  );

  const screenshotPath = join(TASK_ROOT, state.screenshot.path);
  const screenshotExists = existsSync(screenshotPath);
  check(`${label}/screenshot-exists`, screenshotExists, state.screenshot.path);
  if (screenshotExists) {
    const size = statSync(screenshotPath).size;
    check(`${label}/screenshot-nonzero`, size > 0 && size === state.screenshot.bytes, `${size} bytes`);
    const dimensions = pngDimensions(screenshotPath);
    check(
      `${label}/dimensions`,
      dimensions.width === state.screenshot.width && dimensions.height === state.screenshot.height,
      `${dimensions.width}x${dimensions.height} vs manifest ${state.screenshot.width}x${state.screenshot.height}`,
    );
    check(
      `${label}/screenshot-sha256`,
      sha256File(screenshotPath) === state.screenshot.sha256,
      state.screenshot.sha256,
    );
    // A screenshot must match the viewport it claims (deviceScaleFactor 1).
    check(
      `${label}/viewport-matches-image`,
      dimensions.width === state.viewport.width && dimensions.height === state.viewport.height,
      `${dimensions.width}x${dimensions.height} vs viewport ${state.viewport.width}x${state.viewport.height}`,
    );
  }

  const computedPath = join(TASK_ROOT, state.computed.path);
  const computedExists = existsSync(computedPath);
  check(`${label}/computed-exists`, computedExists, state.computed.path);
  if (computedExists) {
    check(
      `${label}/computed-sha256`,
      sha256File(computedPath) === state.computed.sha256,
      state.computed.sha256,
    );
    const computed = JSON.parse(readFileSync(computedPath, "utf-8"));
    const records = Object.values(computed.record ?? {}).filter(Boolean);
    check(`${label}/computed-nonempty`, records.length > 0, `${records.length} nodes`);
    // Typography / color / radius / material / motion must all be present runtime truth.
    const complete = records.every(
      (record) =>
        record.typography?.fontFamily &&
        record.typography?.fontSize &&
        record.color?.color &&
        record.color?.backgroundColor !== undefined &&
        record.radius?.borderTopLeftRadius !== undefined &&
        record.material?.backdropFilter !== undefined &&
        record.motion?.transitionDuration !== undefined,
    );
    check(`${label}/computed-complete`, complete, "typography+color+radius+material+motion");
    check(
      `${label}/no-missing-selector`,
      Array.isArray(computed.missing) && computed.missing.length === 0,
      JSON.stringify(computed.missing ?? null),
    );
  }
}

// --- 2. Official reference coverage ---------------------------------------------------
const referenceStates = manifest.states.filter((state) => state.packet === "official-caret-reference");
const officialUrls = new Set(referenceStates.map((state) => state.sourceUrl));
check(
  "reference/only-official-sources",
  [...officialUrls].every((url) => url === "https://caret.so/en" || url === "https://caret.so/en/changelog"),
  [...officialUrls].join(", "),
);
for (const required of [
  "home-hero",
  "home-live-suggestion",
  "home-before-the-call",
  "home-after-the-call",
  "changelog-index",
  "changelog-mini-recording-popup",
]) {
  check(
    `reference/has-${required}`,
    referenceStates.some((state) => state.id === required),
    "required official state",
  );
}
check(
  "reference/http-200",
  referenceStates.every((state) => state.httpStatus === 200),
  referenceStates.map((state) => `${state.id}:${state.httpStatus}`).join(" "),
);

// --- 3. Baseline viewport coverage ----------------------------------------------------
const baselineStates = manifest.states.filter(
  (state) => state.packet === "meeting-slides-current-baseline",
);
for (const viewport of BASELINE_VIEWPORTS) {
  const forViewport = baselineStates.filter((state) => state.viewport.name === viewport.name);
  check(
    `baseline/covers-${viewport.name}`,
    forViewport.length >= 1,
    `${forViewport.length} states`,
  );
  check(
    `baseline/${viewport.name}-library+live`,
    forViewport.some((state) => state.shell === "library") &&
      forViewport.some((state) => state.shell === "live"),
    forViewport.map((state) => state.shell).join(","),
  );
}

// --- 4. Measured reference tokens ------------------------------------------------------
const tokens = manifest.measuredReferenceTokens;
check(
  "tokens/surface-resolved-to-srgb",
  typeof tokens?.surface?.bodyBackgroundHex === "string" &&
    /^#[0-9a-f]{6}$/.test(tokens.surface.bodyBackgroundHex),
  tokens?.surface?.bodyBackgroundHex,
);
check(
  "tokens/contrast-measured",
  typeof tokens?.surface?.bodyContrastRatio === "number" && tokens.surface.bodyContrastRatio >= 4.5,
  String(tokens?.surface?.bodyContrastRatio),
);
check(
  "tokens/emerald-identity-measured",
  Array.isArray(tokens?.emeraldCandidates) && tokens.emeraldCandidates.length > 0,
  `${tokens?.emeraldCandidates?.length ?? 0} candidates`,
);
check("tokens/motion-measured", (tokens?.motion?.durations?.length ?? 0) > 0, "durations");
check("tokens/radius-measured", (tokens?.radiusSteps?.length ?? 0) > 0, "radii");
check("tokens/mono-measured", (tokens?.typography?.monoStacks?.length ?? 0) > 0, "mono stacks");

// --- 5. No evidence image under public/ ------------------------------------------------
const publicImages = execFileSync(
  "git",
  ["-C", REPO_ROOT, "status", "--porcelain", "--", "public"],
  { encoding: "utf-8" },
)
  .split("\n")
  .map((line) => line.slice(3).trim())
  .filter((path) => /\.(png|jpg|jpeg|webp|gif|avif)$/i.test(path));
check("public/no-new-evidence-image", publicImages.length === 0, publicImages.join(", ") || "none");

const evidenceHashes = new Set(
  manifest.states.map((state) => state.screenshot.sha256),
);
const publicFiles = execFileSync(
  "bash",
  ["-lc", `find ${JSON.stringify(join(REPO_ROOT, "public"))} -type f \\( -name '*.png' -o -name '*.jpg' -o -name '*.webp' -o -name '*.gif' \\) -print0 | xargs -0 -I{} shasum -a 256 {} 2>/dev/null || true`],
  { encoding: "utf-8" },
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split(/\s+/)[0]);
check(
  "public/no-evidence-hash-copied",
  publicFiles.every((hash) => !evidenceHashes.has(hash)),
  `${publicFiles.length} images under public/`,
);

// --- 6. Failure receipt ----------------------------------------------------------------
const failurePath = join(TASK_ROOT, "failure.json");
check("failure/receipt-exists", existsSync(failurePath), "failure.json");
if (existsSync(failurePath)) {
  const failure = JSON.parse(readFileSync(failurePath, "utf-8"));
  check("failure/result-pass", failure.result === "PASS", failure.result);
  const blocked = failure.scenarios?.find(
    (scenario) => scenario.scenario === "external-requests-blocked-after-navigation",
  );
  check("failure/names-missing-state", blocked?.namesMissingState === true, blocked?.reportedError);
  check("failure/no-silent-fallback", blocked?.falselyResolved === false, String(blocked?.falselyResolved));
  check(
    "failure/no-fallback-artifact",
    blocked?.wroteFallbackArtifact === false,
    String(blocked?.wroteFallbackArtifact),
  );
}

// --- 7. Freshness: timestamps must be from this packet, not stale ------------------------
const builtAt = Date.parse(manifest.builtAt);
const stale = manifest.states.filter((state) => builtAt - Date.parse(state.capturedAt) > 6 * 60 * 60 * 1000);
check("freshness/no-stale-state", stale.length === 0, stale.map((state) => state.id).join(", ") || "none");

// --- 8. Driver integrity ----------------------------------------------------------------
for (const driver of manifest.drivers) {
  const absolute = join(TASK_ROOT, driver.path);
  check(
    `driver/${driver.path}-sha256`,
    existsSync(absolute) && sha256File(absolute) === driver.sha256,
    driver.sha256,
  );
}

const result = failures.length === 0 ? "PASS" : "FAIL";
const receipt = writeJson(join(TASK_ROOT, "green", "validation.json"), {
  validator: "task-1 acceptance gate",
  ranAt: isoNow(),
  manifestSha256: sha256File(join(TASK_ROOT, "manifest.json")),
  totalChecks: checks.length,
  failed: failures.length,
  result,
  failures,
  checks,
});

console.log(`${result}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
}
console.log(`validation sha256=${receipt.sha256}`);
