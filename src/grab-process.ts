import { spawn } from "node:child_process";

export class GrabProcessTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "GrabProcessTimeoutError"; }
}

export class GrabProcessExitError extends Error {
  constructor(message: string) { super(message); this.name = "GrabProcessExitError"; }
}

export interface GrabProcessOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  killGraceMs?: number;
  tailBytes?: number;
}

function signalTree(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-proc.pid, signal); return; } catch { /* child may have exited; use direct fallback */ }
  }
  try { proc.kill(signal); } catch { /* already reaped */ }
}

export function runGrabProcess(command: string, args: readonly string[], options: GrabProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const grace = Math.max(1, options.killGraceMs ?? 750);
    const tailBytes = Math.max(100, options.tailBytes ?? 800);
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    let settled = false;
    let timedOut = false;
    let closeCode: number | null = null;
    let spawnError: Error | null = null;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const drain = (data: Buffer) => { tail = (tail + data.toString("utf8")).slice(-tailBytes); };
    proc.stdout?.on("data", drain);
    proc.stderr?.on("data", drain);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      if (timedOut) reject(new GrabProcessTimeoutError(`${args[0] ?? command} timed out`));
      else if (spawnError) reject(new GrabProcessExitError(spawnError.message));
      else if (closeCode === 0) resolve();
      else reject(new GrabProcessExitError(`${args[0] ?? command} failed: ${tail.trim() || `exit ${closeCode}`}`));
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalTree(proc, "SIGTERM");
      forceTimer = setTimeout(() => {
        signalTree(proc, "SIGKILL");
        settleTimer = setTimeout(finish, 250);
      }, grace);
    }, Math.max(1, options.timeoutMs));

    proc.once("error", (error) => {
      spawnError = error;
      if (proc.pid === undefined) finish();
    });
    proc.once("close", (code) => {
      closeCode = code;
      // close가 오면 TERM 순응 프로세스든 KILL 후든 즉시 정리한다.
      // close가 절대 오지 않는 경우는 SIGKILL 직후 250ms settle 타이머가 받는다.
      finish();
    });
  });
}
