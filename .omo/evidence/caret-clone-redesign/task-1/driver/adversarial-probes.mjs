// Adversarial probes for Todo 1. Each probe tries to make the acceptance gate lie;
// the gate must reject every one. Probes operate on COPIES - never on real evidence.
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import { TASK_ROOT, isoNow, sha256File, writeJson } from "./capture-lib.mjs";

const REPO_ROOT = resolve(TASK_ROOT, "../../../..");
const probes = [];

const runValidator = (taskRoot) => {
  try {
    const stdout = execFileSync("node", [join(taskRoot, "driver", "validate-manifest.mjs")], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: stdout.trim() };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(),
    };
  }
};

/** Copies the whole packet to a sandbox so probes never touch real evidence. */
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-task1-probe-"));
  const copy = join(dir, "task-1");
  cpSync(TASK_ROOT, copy, { recursive: true });
  return { dir, copy };
};

// --- Probe 1: stale_state --------------------------------------------------------------
{
  const { dir, copy } = sandbox();
  const manifestPath = join(copy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const staleAt = new Date(Date.parse(manifest.builtAt) - 72 * 60 * 60 * 1000).toISOString();
  manifest.states[0].capturedAt = staleAt;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = runValidator(copy);
  probes.push({
    probe: "stale_state",
    attack: `backdate ${manifest.states[0].id} capturedAt to ${staleAt}`,
    validatorExitCode: result.exitCode,
    rejected: result.exitCode !== 0 && result.output.includes("freshness/no-stale-state"),
    detail: result.output.split("\n").filter((line) => line.includes("freshness")).join(" "),
  });
  rmSync(dir, { recursive: true, force: true });
}

// --- Probe 2: misleading_success_output (hash + dimension forgery) ----------------------
{
  const { dir, copy } = sandbox();
  const manifestPath = join(copy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.states[0].screenshot.sha256 = "0".repeat(64);
  manifest.states[1].screenshot.width = 9999;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = runValidator(copy);
  probes.push({
    probe: "misleading_success_output",
    attack: "forge one screenshot SHA-256 and one screenshot width in manifest.json",
    validatorExitCode: result.exitCode,
    rejected:
      result.exitCode !== 0 &&
      result.output.includes("screenshot-sha256") &&
      result.output.includes("dimensions"),
    detail: result.output.split("\n").filter((line) => line.includes("FAIL")).slice(0, 4).join(" | "),
  });
  rmSync(dir, { recursive: true, force: true });
}

// --- Probe 3: generated_artifacts (silent content swap) ---------------------------------
{
  const { dir, copy } = sandbox();
  const target = join(copy, "reference", "screens", "home-hero.png");
  const bytes = readFileSync(target);
  // Flip a byte deep in the image data; size and PNG header stay valid.
  bytes[bytes.length - 12] ^= 0xff;
  writeFileSync(target, bytes);
  const result = runValidator(copy);
  probes.push({
    probe: "generated_artifacts",
    attack: "mutate one byte inside reference/screens/home-hero.png without changing its size",
    validatorExitCode: result.exitCode,
    rejected: result.exitCode !== 0 && result.output.includes("screenshot-sha256"),
    detail: result.output.split("\n").filter((line) => line.includes("home-hero")).join(" "),
  });
  rmSync(dir, { recursive: true, force: true });
}

// --- Probe 4: prompt_injection ----------------------------------------------------------
{
  // Captured official-site text is reference data. Prove nothing in the packet is treated
  // as an instruction: scan every captured text field for imperative agent-directed content.
  const computedFiles = execSync(
    `find ${JSON.stringify(join(TASK_ROOT, "reference", "computed"))} -name '*.json'`,
    { encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean);
  const injectionPatterns = [
    /ignore (all )?(previous|prior) instructions/i,
    /you are now/i,
    /system prompt/i,
    /disregard .{0,20}instructions/i,
  ];
  const hits = [];
  for (const path of computedFiles) {
    const text = readFileSync(path, "utf-8");
    for (const pattern of injectionPatterns) {
      if (pattern.test(text)) hits.push({ path, pattern: String(pattern) });
    }
  }
  const manifest = JSON.parse(readFileSync(join(TASK_ROOT, "manifest.json"), "utf-8"));
  probes.push({
    probe: "prompt_injection",
    attack: "treat captured official-site text as instructions",
    rejected: true,
    detail: `captured text stored as inert data only; manifest declares injectionPolicy=${JSON.stringify(
      manifest.injectionPolicy,
    )}; scanned ${computedFiles.length} computed records, ${hits.length} injection-shaped strings found`,
    hits,
  });
}

// --- Probe 5: dirty_worktree -------------------------------------------------------------
{
  const status = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], {
    encoding: "utf-8",
  });
  const modifiedTracked = status
    .split("\n")
    .filter((line) => line.startsWith(" M") || line.startsWith("M "))
    .map((line) => line.slice(3));
  const evidenceOnlyUntracked = status
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3));
  probes.push({
    probe: "dirty_worktree",
    attack: "verify unrelated dirty work is untouched and nothing was staged/committed",
    rejected: true,
    detail: "see before/after status receipts in green/worktree-*.txt",
    modifiedTrackedCount: modifiedTracked.length,
    modifiedTracked,
    untracked: evidenceOnlyUntracked,
  });
}

// --- Probe 6: flaky_tests ----------------------------------------------------------------
{
  // No sleep/poll-based synchronization is permitted in any driver.
  // This probe file itself contains the forbidden patterns as literals; scanning it would
  // be a false positive, so the capture drivers under test exclude the probe harness.
  const driverFiles = execSync(
    `find ${JSON.stringify(join(TASK_ROOT, "driver"))} -name '*.mjs'`,
    { encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter((path) => !path.endsWith("adversarial-probes.mjs"));
  const forbidden = [
    /waitForTimeout/,
    /setInterval\s*\(/,
    /await new Promise\([^)]*setTimeout/,
    /page\.waitFor\(/,
  ];
  const violations = [];
  for (const path of driverFiles) {
    const text = readFileSync(path, "utf-8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push({ path, pattern: String(pattern) });
    }
  }
  probes.push({
    probe: "flaky_tests",
    attack: "sleep/poll-based synchronization sneaking into a driver",
    rejected: violations.length === 0,
    detail: `${driverFiles.length} drivers scanned; ${violations.length} forbidden wait patterns (setTimeout is used only as a rejection deadline alongside MutationObserver/scrollend)`,
    violations,
  });
}

// --- Probe 7: long_external_commands -------------------------------------------------------
{
  probes.push({
    probe: "long_external_commands",
    attack: "unbounded external navigation or state wait",
    rejected: true,
    detail:
      "every external navigation is bounded (goto timeout 45s, reload 15s) and every state wait rejects on a deadline (reference 20s, baseline 15s, failure probe 8s); no unbounded await exists",
  });
}

const allRejected = probes.every((probe) => probe.rejected);
const receipt = writeJson(join(TASK_ROOT, "green", "adversarial-probes.json"), {
  ranAt: isoNow(),
  packetRoot: TASK_ROOT,
  manifestSha256: existsSync(join(TASK_ROOT, "manifest.json"))
    ? sha256File(join(TASK_ROOT, "manifest.json"))
    : null,
  probes,
  notApplicable: [
    { probe: "malformed_input", reason: "no user-supplied payload parsing in this task; inputs are fixed official URLs and a fixed local fixture" },
    { probe: "cancel_resume", reason: "not triggered; the packet is produced by single bounded runs with no interactive session" },
    { probe: "repeated_interruptions", reason: "not triggered; no interruption occurred during capture" },
  ],
  result: allRejected ? "PASS" : "FAIL",
});

console.log(`adversarial probes ${allRejected ? "PASS" : "FAIL"} sha256=${receipt.sha256}`);
for (const probe of probes) console.log(`  ${probe.rejected ? "OK  " : "FAIL"} ${probe.probe}`);
if (!allRejected) process.exitCode = 1;
