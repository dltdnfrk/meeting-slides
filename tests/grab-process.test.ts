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

test("settles on close without waiting out the kill grace when the child obeys SIGTERM", async () => {
  if (process.platform === "win32") return;
  // 실제 자식 프로세스의 SIGTERM→close 타이밍을 검증하는 통합 테스트라 fake
  // timer로는 재현할 수 없다. killGraceMs를 5s로 크게 두어 TERM 준수 종료가
  // grace 대기 없이 즉시 settle됨을 1s 안에 확인한다.
  const started = Date.now();
  await expect(runGrabProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    timeoutMs: 80,
    killGraceMs: 5_000,
  })).rejects.toBeInstanceOf(GrabProcessTimeoutError);
  expect(Date.now() - started).toBeLessThan(1_000);
});
