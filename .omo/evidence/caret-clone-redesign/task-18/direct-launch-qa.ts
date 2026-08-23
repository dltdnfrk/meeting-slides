import { watch } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";

const root = join(import.meta.dir, "../../../..");
const executable = join(process.env.HOME!, "Applications/Meeting Slides.app/Contents/MacOS/meeting-slides");
const log = join(process.env.HOME!, "Library/Logs/Meeting Slides/launcher.log");
const db = join(root, "meetings.db");
const dbRows = () => Bun.spawnSync(["sqlite3", "-json", db, "select count(*) as count, coalesce(max(id),0) as maxId from meetings;"], { cwd: root }).stdout.toString().trim();
const beforeRows = dbRows();
const beforeLogSize = (await stat(log).catch(() => ({ size: 0 }))).size;
let seen = "";
let resolveReady!: () => void;
const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
const watcher = watch(log, async () => {
  const bytes = await readFile(log);
  seen = bytes.subarray(beforeLogSize).toString("utf8");
  if (seen.includes("미니바 준비됨")) resolveReady();
});
const child = Bun.spawn([executable], { cwd: root, stdout: "pipe", stderr: "pipe" });
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("installed executable readiness timeout")), 20_000); })]);
  const match = seen.match(/미니바 준비됨 port=(\d+)/);
  if (!match) throw new Error("ready line lacked port");
  const port = Number(match[1]);
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(origin);
  const html = await response.text();
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "load" });
  const browserTruth = await page.evaluate(() => ({
    title: document.title,
    runtime: document.documentElement.dataset.runtime,
    styles: [...document.styleSheets].filter((sheet) => sheet.href !== null).map((sheet) => new URL(sheet.href!).pathname),
    scripts: [...document.querySelectorAll("script[src]")].map((node) => (node as HTMLScriptElement).getAttribute("src")),
    shellCount: document.querySelectorAll(".app[data-shell]").length,
    removedReferences: document.documentElement.innerHTML.match(/workspace-shell|operational-liquid|caret-shell|caret-foundation|transcript-overlay/g) ?? [],
  }));
  const wsTruth = await page.evaluate(() => new Promise<{ opened: boolean; firstType: string | null }>((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    let opened = false;
    const timeout = setTimeout(() => reject(new Error("installed websocket timeout")), 5_000);
    socket.addEventListener("open", () => { opened = true; });
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      const payload = JSON.parse(String(event.data));
      socket.close();
      resolve({ opened, firstType: payload.type ?? null });
    }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("installed websocket error")); }, { once: true });
  }));
  await browser.close();
  const afterRows = dbRows();
  const report = {
    executable, port, httpStatus: response.status,
    healthSignature: html.includes("runtime-bootstrap") && html.includes("<title>Meeting Slides"),
    browserTruth, wsTruth, meetingRows: { before: beforeRows, after: afterRows, unchanged: beforeRows === afterRows },
    noMicCommandSent: true,
  };
  await writeFile(join(import.meta.dir, "direct-launch-qa.json"), JSON.stringify(report, null, 2));
  if (response.status !== 200 || !report.healthSignature || browserTruth.runtime !== "server" || browserTruth.styles.join(",") !== "/style.css,/caret-operator.css" || browserTruth.shellCount !== 1 || browserTruth.removedReferences.length || !wsTruth.opened || !report.meetingRows.unchanged) throw new Error(`direct launch truth failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report));
} finally {
  if (timer) clearTimeout(timer);
  watcher.close();
  child.kill("SIGTERM");
  await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}
