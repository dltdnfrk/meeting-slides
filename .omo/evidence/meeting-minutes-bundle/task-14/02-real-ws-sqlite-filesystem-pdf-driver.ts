import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = "/Users/hyunjun/Documents/MUNI/meeting-slides-worktree-meeting-minutes";
const work = mkdtempSync(join(tmpdir(), "meeting-conclusion-driver-"));
const db = join(work, "meetings.db");
const out = join(work, "exports");
const port = 19991;

const server = spawn("bun", ["server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    HTTP_PORT: String(port),
    OPEN_BROWSER: "false",
    MEETINGS_DB_PATH: db,
    MEETING_BUNDLE_OUTPUT_ROOT: out,
    MEETING_BUNDLE_TARGET_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    LLM_PROVIDER: "cli",
    LLM_CLI_BIN: "/usr/bin/true",
    LLM_CLI_PRESET: "claude",
    WHISPER_INPUT_MODE: "mic",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverReady = false;
server.stdout.on("data", (d) => {
  const t = d.toString();
  if (t.includes("HTTP: http://localhost:")) serverReady = true;
  process.stdout.write(t);
});
server.stderr.on("data", (d) => process.stderr.write(d));

for (let i = 0; i < 100 && !serverReady; i++) await delay(100);
if (!serverReady) throw new Error("server did not start");

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const messages: any[] = [];
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ action: "confirmReview", reviewId: "review-001" }));
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    messages.push(msg);
    if (msg.type === "meetingConcluded") resolve();
  };
  ws.onerror = reject;
});

await delay(500);
const bundleDir = readdirSync(out).find((name) => name.startsWith("bundle-"));
if (!bundleDir) throw new Error("missing bundle output");
const bundlePath = join(out, bundleDir);
const manifest = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8"));
const receipt = {
  wsMessages: messages.map((m) => m.type),
  bundleDir,
  manifestTargetCommit: manifest.target_commit,
  artifactCount: manifest.entries.length,
  pdfSignature: readFileSync(join(bundlePath, "minutes.pdf")).subarray(0, 5).toString(),
};
console.log(JSON.stringify(receipt, null, 2));
ws.close();
server.kill("SIGTERM");
