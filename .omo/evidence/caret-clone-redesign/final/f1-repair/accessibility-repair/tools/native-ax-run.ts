// native-ax-run.ts — drives the REAL installed app to the states whose native
// accessibility behaviour the independent review asked to see proven, and takes
// an ax-capture receipt at each one.
//
// This never simulates the minibar. It talks to the installed app's own server
// over the real WebSocket the browser uses, so the AppKit surface reacts exactly
// as it does for a user, and then reads that surface through the public AX API.
//
// Usage: bun run native-ax-run.ts <port> <pid> <outputDir>

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [portRaw, pidRaw, outDir] = process.argv.slice(2);
if (!portRaw || !pidRaw || !outDir) {
  console.error("usage: bun run native-ax-run.ts <port> <pid> <outputDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const AX_CAPTURE = join(import.meta.dir, "ax-capture");

/** One AX receipt of the live process. Blocking by design: it owns a run loop. */
function capture(label: string, seconds: number): { status: number; stdout: string } {
  const result = spawnSync(AX_CAPTURE, [pidRaw, String(seconds), join(outDir, `ax-${label}.json`)], {
    encoding: "utf8",
  });
  const line = `${label}: exit=${result.status} ${(result.stdout ?? "").trim()}${(result.stderr ?? "").trim()}`;
  console.log(line);
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

/** Waits for a server frame that satisfies `match`, bounded, never timed. */
function awaitFrame(
  socket: WebSocket,
  match: (message: Record<string, unknown>) => boolean,
  ms: number,
  what: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
    }, ms);
    const onMessage = (event: MessageEvent) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(String(event.data)) as Record<string, unknown>; }
      catch { return; }
      if (!match(parsed)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(parsed);
    };
    socket.addEventListener("message", onMessage);
  });
}

const socket = new WebSocket(`ws://127.0.0.1:${portRaw}/ws`);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
});
console.log("connected to the installed app server");

// State 1: idle. Stop is gated, and the gate reason must be readable.
capture("idle", 2);

// State 2 and 3: the transition itself.
//
// An announcement is a NOTIFICATION, not an attribute: it exists only while an
// observer is attached. The observer therefore runs ACROSS the whole start ->
// live -> stop cycle, so what it records is every announcement the real surface
// actually posted for those state changes - which is also the only way to see
// whether a per-second timer tick re-announces a state already spoken.
const spanPath = join(outDir, "ax-transition.json");
const spanSeconds = 16;
const span = spawn(AX_CAPTURE, [pidRaw, String(spanSeconds), spanPath], { encoding: "utf8" });
let spanOut = "";
span.stdout.on("data", (chunk) => { spanOut += String(chunk); });
span.stderr.on("data", (chunk) => { spanOut += String(chunk); });
const spanDone = new Promise<number>((resolve) => span.on("exit", (code) => resolve(code ?? -1)));

const capturing = awaitFrame(
  socket,
  (m) => m.type === "capture" && m.capturing === true,
  12_000,
  "capture start",
);
socket.send(JSON.stringify({ action: "startCapture" }));
let captureStarted = false;
try {
  await capturing;
  captureStarted = true;
  console.log("capture started on the real server");
  // A second receipt DURING live proves role/help/enabled in the live state,
  // taken from a separate short-lived reader while the span observer runs on.
  capture("capturing", 2);
} catch (error) {
  console.log(`capture start unavailable: ${(error as Error).message}`);
}

if (captureStarted) {
  const stopped = awaitFrame(
    socket,
    (m) => m.type === "capture" && m.capturing === false,
    12_000,
    "capture stop",
  );
  socket.send(JSON.stringify({ action: "stopCapture" }));
  try {
    await stopped;
    console.log("capture stopped on the real server");
    capture("stopped", 2);
  } catch (error) {
    console.log(`capture stop unobserved: ${(error as Error).message}`);
  }
}

console.log(`transition observer exit=${await spanDone} ${spanOut.trim()}`);

socket.close();
console.log("NATIVE AX RUN COMPLETE");
