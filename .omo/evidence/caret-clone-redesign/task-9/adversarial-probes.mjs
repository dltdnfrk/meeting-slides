// Task-9 adversarial probes.
//
// Each probe temporarily mutates a real input, runs ONLY the focused foundation
// test, records the RED, then restores the original bytes and confirms GREEN.
// Nothing is committed, staged or left mutated: every probe restores in `finally`.
//
// Probes:
//   1. blocked-network        - all off-origin requests refused; foundation must still be GREEN.
//   2. corrupt-font           - truncate a bundled woff2; the asset test must fail loudly.
//   3. missing-font           - remove a bundled woff2; the asset test must fail loudly.
//   4. stale-hash             - flip one manifest SHA-256; the receipt test must fail.
//   5. remove-token           - delete a semantic token; the token test must fail.
//   6. remove-motion          - delete the motion tokens; the motion test must fail.
//   7. remove-reduced-motion  - delete the reduced-motion block; that test must fail.
//   8. network-font-url       - point a face at fonts.gstatic.com; the no-external test must fail.
//   9. geometry-rounding      - shift a viewport by 1px; the suite must STAY GREEN
//                               (1px rounding is not a golden failure).
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const css = join(repoRoot, "public/caret-foundation.css");
const manifest = join(repoRoot, "public/fonts/font-manifest.json");
const figtree = join(repoRoot, "public/fonts/figtree-latin.woff2");
const testFile = "tests/public-caret-foundation.test.ts";

function runFocused(filter) {
  const args = ["test", testFile];
  if (filter) args.push("-t", filter);
  const result = spawnSync("bun", args, { cwd: repoRoot, encoding: "utf-8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass = Number(output.match(/^\s*(\d+) pass/m)?.[1] ?? 0);
  const fail = Number(output.match(/^\s*(\d+) fail/m)?.[1] ?? 0);
  return { status: result.status, pass, fail, output };
}

const results = [];

function probe(name, expectation, mutate, filter) {
  const backups = new Map();
  const save = (path) => backups.set(path, readFileSync(path));
  const restore = () => {
    for (const [path, bytes] of backups) writeFileSync(path, bytes);
  };
  let red;
  try {
    mutate({ save, remove: (path) => { save(path); rmSync(path); } });
    red = runFocused(filter);
  } finally {
    restore();
  }
  const green = runFocused(filter);
  const satisfied = expectation === "must-fail"
    ? red.fail > 0 && green.fail === 0
    : red.fail === 0 && green.fail === 0;
  results.push({
    probe: name,
    expectation,
    filter: filter ?? "(whole focused file)",
    mutated: { pass: red.pass, fail: red.fail, exitStatus: red.status },
    restored: { pass: green.pass, fail: green.fail, exitStatus: green.status },
    satisfied,
  });
  console.log(`${satisfied ? "OK  " : "MISS"} ${name}: mutated ${red.pass}p/${red.fail}f -> restored ${green.pass}p/${green.fail}f`);
}

// 1. Baseline under a fully blocked network: the probe already aborts every
//    off-origin request, so a GREEN run here IS the blocked-network proof.
{
  const run = runFocused(null);
  results.push({
    probe: "blocked-network",
    expectation: "must-pass",
    filter: "(whole focused file)",
    note: "the foundation probe aborts every off-origin request unconditionally; this GREEN run is taken with all external network refused",
    mutated: null,
    restored: { pass: run.pass, fail: run.fail, exitStatus: run.status },
    satisfied: run.fail === 0 && run.pass > 0,
  });
  console.log(`${run.fail === 0 ? "OK  " : "MISS"} blocked-network: ${run.pass}p/${run.fail}f with all external requests aborted`);
}

// 2. Corrupt a bundled font: truncated bytes must fail loudly, never fall back.
probe("corrupt-font", "must-fail", ({ save }) => {
  save(figtree);
  writeFileSync(figtree, readFileSync(figtree).subarray(0, 512));
}, "recorded size and SHA-256");

// 3. Remove a bundled font entirely.
probe("missing-font", "must-fail", ({ remove }) => {
  remove(figtree);
}, "recorded size and SHA-256");

// 4. Stale asset hash in the manifest.
probe("stale-asset-hash", "must-fail", ({ save }) => {
  save(manifest);
  const doc = JSON.parse(readFileSync(manifest, "utf-8"));
  doc.assets[0].sha256 = "0".repeat(64);
  writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`);
}, "recorded size and SHA-256");

// 5. Remove one semantic token from the layer.
probe("remove-token", "must-fail", ({ save }) => {
  save(css);
  writeFileSync(css, readFileSync(css, "utf-8").replace(/^\s*--cf-accent-soft:[^;]+;$/m, ""));
}, "every required semantic token");

// 6. Remove the motion tokens.
probe("remove-motion-token", "must-fail", ({ save }) => {
  save(css);
  writeFileSync(css, readFileSync(css, "utf-8").replace(/^\s*--cf-motion-state:[^;]+;$/m, ""));
}, "motion budget");

// 7. Remove the reduced-motion rule.
probe("remove-reduced-motion", "must-fail", ({ save }) => {
  save(css);
  const source = readFileSync(css, "utf-8");
  const start = source.indexOf("@media (prefers-reduced-motion: reduce)");
  writeFileSync(css, source.slice(0, start));
}, "prefers-reduced-motion");

// 8. Reintroduce a network font dependency.
probe("network-font-url", "must-fail", ({ save }) => {
  save(css);
  writeFileSync(css, readFileSync(css, "utf-8").replace(
    'url("/fonts/figtree-latin.woff2")',
    'url("https://fonts.gstatic.com/s/figtree/v9/_Xms-HUzqDCFdgfMm4S9DaRvzig.woff2")',
  ));
}, "only same-origin font sources");

// 9. A 1px viewport shift must NOT be treated as a failure: this foundation
//    asserts semantics and overflow, never exact pixel geometry.
{
  const backup = readFileSync(join(repoRoot, testFile));
  let shifted;
  try {
    const source = readFileSync(join(repoRoot, testFile), "utf-8");
    writeFileSync(
      join(repoRoot, testFile),
      source.replace('{ name: "library", width: 1244, height: 836 }', '{ name: "library", width: 1245, height: 837 }'),
    );
    shifted = runFocused("canonical viewport");
  } finally {
    writeFileSync(join(repoRoot, testFile), backup);
  }
  const restored = runFocused("canonical viewport");
  results.push({
    probe: "geometry-1px-rounding",
    expectation: "must-pass",
    filter: "canonical viewport",
    note: "a 1px viewport change is not a golden failure: the foundation pins semantics, tokens and zero root overflow, never exact pixel geometry",
    mutated: { pass: shifted.pass, fail: shifted.fail, exitStatus: shifted.status },
    restored: { pass: restored.pass, fail: restored.fail, exitStatus: restored.status },
    satisfied: shifted.fail === 0 && restored.fail === 0,
  });
  console.log(`${shifted.fail === 0 ? "OK  " : "MISS"} geometry-1px-rounding: shifted ${shifted.pass}p/${shifted.fail}f (must stay green)`);
}

const outPath = join(repoRoot, ".omo/evidence/caret-clone-redesign/task-9/adversarial-probes.json");
const summary = { probes: results, allSatisfied: results.every((r) => r.satisfied) };
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nall probes satisfied: ${summary.allSatisfied}`);
if (!summary.allSatisfied) process.exit(1);
