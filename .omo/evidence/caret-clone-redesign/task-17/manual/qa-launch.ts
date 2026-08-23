// Manual QA harness for the rebuilt installed Meeting Slides.app (Todo 17).
//
// Launches the real installed bundle and waits on the exact readiness log lines
// the launcher emits. There is no sleep and no polling delay: the harness
// subscribes to log growth and to process exit, and every wait is bounded by a
// deadline that only fires as a failure.
//
// Usage: bun .omo/evidence/.../manual/qa-launch.ts

import { spawn } from "node:child_process";
import { openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME!;
const APP = join(HOME, "Applications", "Meeting Slides.app");
const LOG = join(HOME, "Library", "Logs", "Meeting Slides", "launcher.log");

/** Byte offset the log had before launch: only new lines count as evidence. */
const startOffset = statSync(LOG).size;

interface Waiter {
  pattern: RegExp;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters: Waiter[] = [];
const seen: string[] = [];
let offset = startOffset;

/** Read whatever is new in the log and dispatch it to subscribers. */
function drain(): void {
  const size = statSync(LOG).size;
  if (size <= offset) return;
  const fd = openSync(LOG, "r");
  const buffer = Buffer.alloc(size - offset);
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  offset = size;
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    seen.push(line);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pattern.test(line)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(line);
        waiters.splice(i, 1);
      }
    }
  }
}

// The log is appended by another process, so subscribe to filesystem change
// notifications rather than a timer.
const watcher = (await import("node:fs")).watch(LOG, { persistent: true }, drain);

function awaitLine(pattern: RegExp, label: string, ms = 60_000): Promise<string> {
  drain();
  const already = seen.find((line) => pattern.test(line));
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${label} (${pattern})`));
    }, ms);
    waiters.push({ pattern, resolve, reject, timer });
  });
}

const receipts: Record<string, unknown> = {};
let launcherPid = -1;

try {
  const launched = spawn("open", ["-a", APP], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    launched.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`open exited ${code}`)),
    );
  });
  receipts.launchCommand = `open -a "${APP}"`;

  receipts.projectLine = await awaitLine(/프로젝트: /, "project resolution");
  receipts.portLine = await awaitLine(/HTTP_PORT=/, "port resolution");
  receipts.serverReady = await awaitLine(/웹앱 ready → 브라우저 오픈/, "server-ready");
  receipts.minibarReady = await awaitLine(/미니바 준비됨/, "menu-bar + panel ready");

  // Real AX state of the running app: menu-bar item and panel bounds.
  const ax = spawn("osascript", [
    "-e",
    `tell application "System Events" to tell process "Meeting Slides"
       set out to ""
       repeat with w in windows
         set out to out & (name of w) & "|" & (size of w as string) & "|" & (position of w as string) & linefeed
       end repeat
       set out to out & "menubar:" & (count of menu bars) & linefeed
       return out
     end tell`,
  ]);
  receipts.accessibility = await new Promise<string>((resolve) => {
    let out = "";
    ax.stdout.on("data", (chunk) => (out += chunk));
    ax.stderr.on("data", (chunk) => (out += chunk));
    ax.on("exit", () => resolve(out.trim()));
  });

  const pid = spawn("pgrep", ["-f", "Meeting Slides.app/Contents/MacOS/meeting-slides"]);
  launcherPid = Number(
    await new Promise<string>((resolve) => {
      let out = "";
      pid.stdout.on("data", (chunk) => (out += chunk));
      pid.on("exit", () => resolve(out.trim().split("\n")[0] ?? ""));
    }),
  );
  receipts.launcherPid = launcherPid;
} finally {
  watcher.close();
}

receipts.newLogLines = seen;
console.log(JSON.stringify(receipts, null, 2));
