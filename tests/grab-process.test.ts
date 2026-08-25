import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrabProcessExitError, GrabProcessTimeoutError, runGrabProcess } from "../src/grab-process.ts";

test("drains output larger than an OS pipe buffer", async () => {
  await runGrabProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2_000_000))"], { timeoutMs: 5_000 });
});

test("includes bounded process output in nonzero failures", async () => {
  await expect(runGrabProcess(process.execPath, ["-e", "console.error('render exploded'); process.exit(7)"], {
    timeoutMs: 5_000,
  })).rejects.toBeInstanceOf(GrabProcessExitError);
  try {
    await runGrabProcess(process.execPath, ["-e", "console.error('render exploded'); process.exit(7)"], { timeoutMs: 5_000 });
  } catch (error) {
    expect((error as Error).message).toContain("render exploded");
  }
});

test("waits through the kill grace period and reaps a TERM-resistant process", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "grab-process-"));
  const pidPath = join(dir, "pid");
  const started = Date.now();
  try {
    await expect(runGrabProcess(process.execPath, ["-e", `
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `], { timeoutMs: 80, killGraceMs: 120 })).rejects.toBeInstanceOf(GrabProcessTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
