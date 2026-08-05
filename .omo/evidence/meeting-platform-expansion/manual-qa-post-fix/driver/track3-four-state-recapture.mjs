// Continuation-only recapture for states 15-18.
// Drives the real signed launcher and live browser UI. No product code is changed.
// All synchronization is event-based and bounded; there are no sleeps or timer polling loops.
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  launch, openApp, shot, frameCursor, waitForFrame,
  readSettingsState, openSettings, DESKTOP,
} from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const APP = "/Users/hyunjun/Applications/Meeting Slides.app/Contents/MacOS/meeting-slides";
const SETTINGS = join(ROOT, ".meeting-slides/stt-settings.json");
const ORDER = ["small", "medium", "large-v3-turbo", "large-v3"];
const ledger = { startedAt: new Date().toISOString(), launches: [], captures: [], assertions: [] };

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function lineEvents(stream, onLine) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let split;
    while ((split = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, split);
      pending = pending.slice(split + 1);
      onLine(line);
    }
  });
}

async function startSignedApp(sequence) {
  const logPath = join(EV, "logs", `continuation-launch-${sequence}.log`);
  const log = createWriteStream(logPath, { flags: "w" });
  const child = spawn(APP, [], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const launch = { sequence, launcherPid: child.pid, serverPid: null, logPath, startedAt: new Date().toISOString() };
  ledger.launches.push(launch);

  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const consume = (source) => (line) => {
    log.write(`[${source}] ${line}\n`);
    const pidMatch = line.match(/서버 시작 pid=(\d+) port=8787/);
    if (pidMatch) launch.serverPid = Number(pidMatch[1]);
    if (line.includes("웹앱 ready → 브라우저 오픈") && launch.serverPid) {
      launch.readyAt = new Date().toISOString();
      resolveReady();
    }
  };
  lineEvents(child.stdout, consume("stdout"));
  lineEvents(child.stderr, consume("stderr"));
  child.once("error", rejectReady);
  child.once("exit", (code, signal) => {
    launch.exitedAt = new Date().toISOString();
    launch.exitCode = code;
    launch.exitSignal = signal;
    if (!launch.readyAt) rejectReady(new Error(`launcher exited before readiness: code=${code} signal=${signal}`));
    log.end();
  });
  await bounded(ready, 45_000, `signed app launch ${sequence}`);
  return { child, launch };
}

async function stopSignedApp(owned) {
  const { child, launch } = owned;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  launch.termRequestedAt = new Date().toISOString();
  launch.termTargetServerPid = launch.serverPid;
  process.kill(launch.serverPid, "SIGTERM");
  await bounded(exited, 20_000, `launcher ${launch.launcherPid} exit after server ${launch.serverPid} SIGTERM`);
  launch.terminatedOnlyOwnedPids = [launch.serverPid, launch.launcherPid];
}

async function showWholeSttSection(page) {
  await page.evaluate(() => {
    const section = document.querySelector(".settings-section--stt");
    section?.scrollIntoView({ block: "start", inline: "nearest" });
  });
  await page.waitForFunction(() => {
    const title = document.getElementById("stt-section-title")?.getBoundingClientRect();
    const cards = [...document.querySelectorAll("#stt-list .stt-row")].map((row) => row.getBoundingClientRect());
    return document.getElementById("stt-section-title")?.textContent?.trim() === "음성 인식 모델"
      && cards.length === 4
      && title && title.top >= 0 && title.bottom <= innerHeight
      && cards.every((box) => box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth);
  }, { timeout: 10_000, polling: "mutation" });
}

async function visibleProof(page) {
  return page.evaluate(() => {
    const title = document.getElementById("stt-section-title");
    const rows = [...document.querySelectorAll("#stt-list .stt-row")];
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
    };
    return {
      heading: title?.textContent?.trim(),
      headingVisible: !!title && visible(title),
      cards: rows.map((row) => ({
        id: row.dataset.id,
        status: row.dataset.status,
        badge: row.querySelector(".stt-row__badge")?.textContent?.trim(),
        action: row.querySelector(".stt-row__actions button")?.textContent?.trim(),
        actionDisabled: row.querySelector(".stt-row__actions button")?.disabled,
        visible: visible(row),
      })),
      panelScrollTop: document.getElementById("provider-panel")?.scrollTop,
    };
  });
}

async function capture(page, file, state, predicate) {
  await showWholeSttSection(page);
  const proof = await visibleProof(page);
  const pass = proof.heading === "음성 인식 모델" && proof.headingVisible
    && proof.cards.length === 4 && proof.cards.every((card) => card.visible) && predicate(proof);
  ledger.assertions.push({ state, pass, proof });
  if (!pass) throw new Error(`visual proof failed for state ${state}: ${JSON.stringify(proof)}`);
  const path = join(EV, "screens", file);
  await shot(page, path);
  ledger.captures.push({ state, file: `screens/${file}`, capturedAt: new Date().toISOString(), proof });
}

let first;
let second;
try {
  first = await startSignedApp(1);
  const browser = await launch();
  first.launch.puppeteerPid = browser.process()?.pid ?? null;
  try {
    const page = await openApp(browser, DESKTOP);
    await openSettings(page);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#stt-list .stt-row")].length === 4
        && [...document.querySelectorAll("#stt-list .stt-row")].every((row) => ["installed", "selected"].includes(row.dataset.status)),
      { timeout: 20_000, polling: "mutation" },
    );

    await capture(page, "t3-05-stt-all-installed.png", 15,
      (proof) => proof.cards.every((card) => card.status === "installed" && card.badge === "설치됨"));

    const selectionCycle = [];
    for (const id of ORDER) {
      const cursor = await frameCursor(page);
      await page.click(`.stt-row[data-id="${id}"] .stt-row__select`);
      await waitForFrame(page, cursor,
        `(f) => f.type === "sttModels" && f.models.filter((m) => m.status === "selected").length === 1 && f.models.some((m) => m.id === "${id}" && m.status === "selected")`,
        30_000);
      await page.waitForFunction((selectedId) => {
        const rows = [...document.querySelectorAll("#stt-list .stt-row")];
        return rows.filter((row) => row.dataset.status === "selected").length === 1
          && rows.find((row) => row.dataset.id === selectedId)?.dataset.status === "selected";
      }, { timeout: 10_000, polling: "mutation" }, id);
      selectionCycle.push({ id, persisted: JSON.parse(readFileSync(SETTINGS, "utf8")), ui: (await readSettingsState(page)).stt.map(({ id, status }) => ({ id, status })) });
    }
    ledger.selectionCycle = selectionCycle;
    await capture(page, "t3-06-stt-all-model-selection-final.png", 16,
      (proof) => proof.cards.filter((card) => card.status === "selected").length === 1
        && proof.cards.find((card) => card.id === "large-v3")?.badge === "사용 중"
        && proof.cards.find((card) => card.id === "large-v3")?.action === "선택됨"
        && proof.cards.find((card) => card.id === "large-v3")?.actionDisabled === true);

    const cursor = await frameCursor(page);
    await page.click("#btn-recheck-stt");
    await waitForFrame(page, cursor,
      `(f) => f.type === "sttModels" && f.models.length === 4 && f.models.filter((m) => m.status === "selected").length === 1 && f.models.some((m) => m.id === "large-v3" && m.status === "selected")`,
      30_000);
    await capture(page, "t3-08-stt-after-recheck.png", 17,
      (proof) => proof.cards.every((card) => ["installed", "selected"].includes(card.status))
        && proof.cards.filter((card) => card.status === "selected").length === 1
        && proof.cards.find((card) => card.id === "large-v3")?.badge === "사용 중");
  } finally {
    await browser.close();
    first.launch.puppeteerClosedAt = new Date().toISOString();
  }
  await stopSignedApp(first);

  second = await startSignedApp(2);
  const restartBrowser = await launch();
  second.launch.puppeteerPid = restartBrowser.process()?.pid ?? null;
  try {
    const page = await openApp(restartBrowser, DESKTOP);
    await openSettings(page);
    await page.waitForFunction(
      () => document.querySelector('.stt-row[data-id="large-v3"]')?.dataset.status === "selected",
      { timeout: 20_000, polling: "mutation" },
    );
    await capture(page, "t3-09-stt-selection-after-restart.png", 18,
      (proof) => proof.cards.filter((card) => card.status === "selected").length === 1
        && proof.cards.find((card) => card.id === "large-v3")?.badge === "사용 중"
        && proof.cards.find((card) => card.id === "large-v3")?.action === "선택됨"
        && proof.cards.find((card) => card.id === "large-v3")?.actionDisabled === true);
  } finally {
    await restartBrowser.close();
    second.launch.puppeteerClosedAt = new Date().toISOString();
  }
  await stopSignedApp(second);
  ledger.completedAt = new Date().toISOString();
  ledger.status = "PASS";
} catch (error) {
  ledger.completedAt = new Date().toISOString();
  ledger.status = "FAIL";
  ledger.error = { message: error.message, stack: error.stack };
  for (const owned of [second, first]) {
    if (!owned?.child || owned.child.exitCode !== null) continue;
    try { if (owned.launch.serverPid) process.kill(owned.launch.serverPid, "SIGTERM"); } catch {}
    try { owned.child.kill("SIGTERM"); } catch {}
  }
  throw error;
} finally {
  writeFileSync(join(EV, "artifacts/track3-four-state-recapture.json"), JSON.stringify(ledger, null, 2) + "\n");
  writeFileSync(join(EV, "state/continuation-process-ledger.json"), JSON.stringify({
    signedExecutable: APP,
    launches: ledger.launches,
    note: "Only the recorded QA-owned launcher/server PIDs received SIGTERM; Puppeteer browser processes were closed through their owning API.",
  }, null, 2) + "\n");
}
