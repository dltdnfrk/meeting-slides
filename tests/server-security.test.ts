import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
let child: ChildProcessWithoutNullStreams;
let tempDir = "";
let origin = "";

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-security-"));
  const fakeCli = join(tempDir, "fake-cli");
  const fakeWhisper = join(tempDir, "fake-whisper");
  writeFileSync(fakeCli, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; else echo "{}"; fi\n');
  writeFileSync(fakeWhisper, "#!/bin/sh\nsleep 30\n");
  chmodSync(fakeCli, 0o755); chmodSync(fakeWhisper, 0o755);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port; reservation.stop();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HTTP_PORT: String(port), OPEN_BROWSER: "false", MEETINGS_DB_PATH: join(tempDir, "meetings.db"),
      MEETING_SLIDES_SETTINGS_ROOT: tempDir, LLM_PROVIDER: "cli", LLM_CLI_BIN: fakeCli,
      LLM_CLI_PRESET: "claude", MEETING_SLIDES_AUTOMATION_TOKEN: "test-secret-token", WHISPER_STREAM_BIN: fakeWhisper,
      WHISPER_MODEL_PATH: join(tempDir, "model.bin"), AUDIO_RECORDER_BIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = ""; const onData = (chunk: Buffer) => { output += chunk; if (output.includes(`HTTP: http://localhost:${port}`)) resolve(); };
    child.stdout.on("data", onData); child.stderr.on("data", onData); child.once("error", reject);
    setTimeout(() => reject(new Error(`server timeout: ${output}`)), 10_000).unref();
  });
}, 20_000);

afterAll(async () => {
  if (child?.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("close", resolve)); }
  rmSync(tempDir, { recursive: true, force: true });
});

test("static responses deny framing and apply local-app security headers", async () => {
  const response = await fetch(origin);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy")).toContain("sha256-CTSVlnPNqSQZ/c+SNJNy+TlsMKVz2bXM+yySIVG+qv0=");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("cross-origin or form-like auto-capture requests are rejected before microphone side effects", async () => {
  const evil = await fetch(`${origin}/api/auto-capture`, {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}",
  });
  expect(evil.status).toBe(403);
  const form = await fetch(`${origin}/api/auto-capture`, {
    method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}",
  });
  expect(form.status).toBe(403);
  const missingOriginAndToken = await fetch(`${origin}/api/auto-stop`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(missingOriginAndToken.status).toBe(403);
  const authorizedLauncher = await fetch(`${origin}/api/auto-stop`, {
    method: "POST", headers: { authorization: "Bearer test-secret-token", "content-type": "application/json" }, body: "{}",
  });
  expect(authorizedLauncher.status).toBe(200);
});



test("slide-plan artifact route rejects traversal and unknown publications without leaking files", async () => {
globalThis.traversal = await fetch(`${origin}/slide-plan-artifacts/plan-safe/%2e%2e/meetings.db`);
  expect(traversal.status).toBe(403);
  expect(traversal.headers.get("x-frame-options")).toBe("DENY");
globalThis.missing = await fetch(`${origin}/slide-plan-artifacts/unknown/standalone/index.html`);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
});

test("production websocket rejects an originless upgrade", async () => {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/ws");
  const result = await new Promise<"open" | "error">((resolve) => {
    socket.addEventListener("open", () => resolve("open"), { once: true });
    socket.addEventListener("error", () => resolve("error"), { once: true });
  });
  socket.close();
  expect(result).toBe("error");
});
