// Track 1: historical sessions + exports through the real browser UI.
import { writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  launch, openApp, shot, frameCursor, waitForFrame, collectFrames,
  readMainState, selectMeeting, DESKTOP,
} from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const SHOTS = join(EV, "screens");
const results = [];
const rec = (id, status, detail) => {
  results.push({ id, status, detail });
  console.log(`[${status}] ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const exportsDir = join(ROOT, "exports");
const snapExports = () => new Set(readdirSync(exportsDir));

const browser = await launch();
const page = await openApp(browser, DESKTOP);

try {
  // ── 1.1 enumerate historical meetings ──
  const initial = await readMainState(page);
  await shot(page, join(SHOTS, "t1-01-initial-desktop.png"));
  rec("T1.1-enumerate-sessions",
    Number(initial.sessionCount) > 0 && initial.sessionRows.length > 0 ? "PASS" : "FAIL",
    { sessionCount: initial.sessionCount, rows: initial.sessionRows.length, firstThree: initial.sessionRows.slice(0, 3) });

  // ── 1.2 select a historical meeting with multiple slides (28) ──
  // Meeting 28 has 2 slides / 18 lines in the store -> exercises current+history split.
  const target = 28;
  const hasTarget = initial.sessionRows.some((r) => Number(r.id) === target);
  if (!hasTarget) throw new Error(`meeting ${target} not listed in UI`);
  const frame28 = await selectMeeting(page, target);
  const st28 = await readMainState(page);
  await shot(page, join(SHOTS, "t1-02-meeting28-hydrated.png"));

  const serverSlides = (frame28.history?.length ?? 0) + (frame28.current ? 1 : 0);
  rec("T1.2-select-historical-meeting",
    st28.sessionRows.find((r) => Number(r.id) === target)?.selected === true ? "PASS" : "FAIL",
    { selected: true, title: st28.docTitle, wsFrameMeetingId: frame28.meetingId });

  rec("T1.3-transcript-hydration",
    frame28.transcript.length > 0 && Number(st28.transcriptCount) === frame28.transcript.length ? "PASS" : "FAIL",
    { wsTranscriptLines: frame28.transcript.length, uiTranscriptCount: st28.transcriptCount, uiRendered: st28.transcriptLines.length });

  rec("T1.4-current-slide-hydration",
    frame28.current !== null && st28.currentSlideTitle === frame28.current.title && !st28.currentSlidePlaceholder ? "PASS" : "FAIL",
    { wsCurrentTitle: frame28.current?.title, uiCurrentTitle: st28.currentSlideTitle, placeholder: st28.currentSlidePlaceholder });

  rec("T1.5-history-slides-hydration",
    Array.isArray(frame28.history) && frame28.history.length > 0 ? "PASS" : "FAIL",
    { wsHistoryLen: frame28.history.length, wsHistoryIdx: frame28.history.map((h) => h.index) });

  // filmstrip total must equal history + current (current included in totals)
  rec("T1.6-filmstrip-total-includes-current",
    Number(st28.historyCount) === serverSlides && st28.thumbnails.length === serverSlides ? "PASS" : "FAIL",
    { serverHistory: frame28.history.length, serverCurrent: frame28.current ? 1 : 0, expectedTotal: serverSlides,
      uiHistoryCount: st28.historyCount, uiThumbnails: st28.thumbnails.length,
      thumbIdx: st28.thumbnails.map((t) => t.index),
      currentIncluded: st28.thumbnails.some((t) => Number(t.index) === frame28.current?.index) });

  // ── 1.3 cross-check hydration switches all panes on a second meeting ──
  const target2 = 43; // 1 slide / 5 lines / compiled outline present
  const frame43 = await selectMeeting(page, target2);
  const st43 = await readMainState(page);
  await shot(page, join(SHOTS, "t1-03-meeting43-hydrated-compiled.png"));
  rec("T1.7-selection-switches-all-panes",
    st43.docTitle !== st28.docTitle
      && Number(st43.transcriptCount) === frame43.transcript.length
      && st43.currentSlideTitle === frame43.current?.title
      && Number(st43.historyCount) === (frame43.history.length + (frame43.current ? 1 : 0))
      ? "PASS" : "FAIL",
    { m28: { title: st28.docTitle, tc: st28.transcriptCount, hc: st28.historyCount },
      m43: { title: st43.docTitle, tc: st43.transcriptCount, hc: st43.historyCount, current: st43.currentSlideTitle } });

  rec("T1.8-compiled-state-hydration",
    frame43.compiled && st43.compileStatus.hidden === false && st43.compileStatus.state === "success"
      && st43.compileStatus.text.includes(String(frame43.compiled.slideCount))
      ? "PASS" : "FAIL",
    { wsCompiled: frame43.compiled, uiCompileStatus: st43.compileStatus });

  // ── 1.4 transcript export (dedicated action, must differ from MD notes) ──
  const before = snapExports();
  let cur = await frameCursor(page);
  await page.click("#btn-export-transcript");
  const savedT = await waitForFrame(page, cur, `(f) => f.type === "saved" && /transcript-/.test(f.path)`, 20_000);
  await page.waitForFunction((p) => document.getElementById("last-saved")?.textContent?.includes(p),
    { timeout: 5_000, polling: "mutation" }, savedT.path);
  const stT = await readMainState(page);
  await shot(page, join(SHOTS, "t1-04-transcript-exported.png"));
  const tPath = join(ROOT, savedT.path);
  rec("T1.9-transcript-export-ui",
    existsSync(tPath) && statSync(tPath).size > 0 && savedT.path.includes("transcript-") ? "PASS" : "FAIL",
    { wsPath: savedT.path, absPath: tPath, bytes: existsSync(tPath) ? statSync(tPath).size : null, uiLastSaved: stT.lastSaved.text });

  // ── 1.5 markdown notes export for the differ-check ──
  cur = await frameCursor(page);
  await page.click("#btn-export-md");
  const savedM = await waitForFrame(page, cur, `(f) => f.type === "saved" && /meeting-.*\\.md$/.test(f.path)`, 20_000);
  const mPath = join(ROOT, savedM.path);
  rec("T1.10-transcript-differs-from-md-notes",
    existsSync(mPath) && existsSync(tPath) ? "PENDING-DIFF" : "FAIL",
    { transcriptPath: savedT.path, notesPath: savedM.path });

  // ── 1.6 JSON export ──
  cur = await frameCursor(page);
  await page.click("#btn-export-json");
  const savedJ = await waitForFrame(page, cur, `(f) => f.type === "saved" && /\\.json$/.test(f.path)`, 20_000);
  rec("T1.11-json-export-ui", existsSync(join(ROOT, savedJ.path)) ? "PASS" : "FAIL", { path: savedJ.path });

  // ── 1.7 deck export (HTML deck) through UI ──
  cur = await frameCursor(page);
  await page.click("#btn-export-deck");
  const savedD = await waitForFrame(page, cur, `(f) => f.type === "saved" && /deck-.*index\\.html$/.test(f.path)`, 30_000);
  const dPath = join(ROOT, savedD.path);
  await shot(page, join(SHOTS, "t1-05-deck-exported.png"));
  rec("T1.12-deck-export-ui",
    existsSync(dPath) ? "PASS" : "FAIL",
    { path: savedD.path, abs: dPath, bytes: existsSync(dPath) ? statSync(dPath).size : null });

  writeFileSync(join(EV, "artifacts/track1-export-paths.json"), JSON.stringify({
    meeting28: { frame: frame28 }, meeting43: { frame: frame43 },
    transcript: savedT.path, notes: savedM.path, json: savedJ.path, deck: savedD.path,
    exportsAdded: [...snapExports()].filter((n) => !before.has(n)),
  }, null, 2));

  // ── 1.8 PDF export: progress + disabled-conflict + terminal recovery ──
  cur = await frameCursor(page);
  await page.click("#btn-export-pdf");
  // Armed on the real started frame, then immediately assert the disabled conflict state.
  const pdfStart = await waitForFrame(page, cur, `(f) => f.type === "export" && f.action === "exportPdf" && f.status === "started"`, 20_000);
  await page.waitForFunction(() => document.getElementById("btn-export-png")?.disabled === true,
    { timeout: 5_000, polling: "mutation" });
  const busyState = await readMainState(page);
  await shot(page, join(SHOTS, "t1-06-pdf-export-busy-disabled.png"));
  rec("T1.13-export-progress-started",
    pdfStart.status === "started" && !!pdfStart.jobId ? "PASS" : "FAIL",
    { jobId: pdfStart.jobId, stage: pdfStart.stage, uiStatus: busyState.statusText });
  rec("T1.14-conflicting-controls-disabled-while-busy",
    busyState.jobControls.every((c) => c.disabled === true) ? "PASS" : "FAIL",
    busyState.jobControls);

  // While busy, clicking a conflicting export must surface a real job-busy error.
  const cur2 = await frameCursor(page);
  await page.evaluate(() => {
    // The button is disabled in the UI (correct), so exercise the server guard
    // through the same socket the UI uses to prove the server-side conflict path.
    window.__qa.socket.send(JSON.stringify({ action: "exportPng" }));
  });
  const busyErr = await waitForFrame(page, cur2,
    `(f) => f.type === "export" && f.action === "exportPng" && f.status === "error" && f.code === "job-busy"`, 15_000);
  rec("T1.15-server-rejects-conflicting-job",
    busyErr.code === "job-busy" ? "PASS" : "FAIL", { code: busyErr.code, error: busyErr.error });

  // Wait for the PDF job to reach ANY terminal state (bounded), collecting progress frames.
  const pdfTerm = await waitForFrame(page, cur,
    `(f) => f.type === "export" && f.action === "exportPdf" && f.jobId === "${pdfStart.jobId}" && ["success","error","timeout"].includes(f.status)`,
    180_000);
  const progressFrames = await collectFrames(page, cur,
    `(f) => f.type === "export" && f.action === "exportPdf" && f.jobId === "${pdfStart.jobId}"`);
  // Controls must be restored on every terminal state.
  await page.waitForFunction(() => document.getElementById("btn-export-pdf")?.disabled === false,
    { timeout: 10_000, polling: "mutation" });
  const termState = await readMainState(page);
  await shot(page, join(SHOTS, "t1-07-pdf-export-terminal.png"));

  rec("T1.16-export-deterministic-progress",
    progressFrames.filter((f) => f.status === "progress").length > 0 ? "PASS" : "FAIL",
    { stages: progressFrames.map((f) => `${f.status}:${f.stage ?? "-"}${f.total !== undefined ? `(${f.completed}/${f.total})` : ""}`) });
  rec("T1.17-controls-restored-on-terminal-state",
    termState.jobControls.every((c) => c.disabled === false) ? "PASS" : "FAIL",
    { terminalStatus: pdfTerm.status, jobControls: termState.jobControls });
  rec("T1.18-terminal-state-observable",
    ["success", "error", "timeout"].includes(pdfTerm.status) ? "PASS" : "FAIL",
    { status: pdfTerm.status, code: pdfTerm.code ?? null, error: pdfTerm.error ?? null, path: pdfTerm.path ?? null,
      retryOffered: termState.retryButton, uiStatus: termState.statusText });

  // ── 1.9 bad-input terminal error recovery (safe: invalid meetingId, no state mutated) ──
  const cur3 = await frameCursor(page);
  await page.evaluate(() => window.__qa.socket.send(JSON.stringify({ action: "exportPdf", meetingId: -1 })));
  const badErr = await waitForFrame(page, cur3,
    `(f) => f.type === "export" && f.action === "exportPdf" && f.status === "error" && f.code === "invalid-meeting-id"`, 15_000);
  await page.waitForFunction(() => !!document.querySelector(".job-retry"), { timeout: 8_000, polling: "mutation" });
  const badState = await readMainState(page);
  await shot(page, join(SHOTS, "t1-08-bad-input-error-recovery.png"));
  rec("T1.19-bad-input-terminal-error",
    badErr.code === "invalid-meeting-id" ? "PASS" : "FAIL", { code: badErr.code, error: badErr.error });
  rec("T1.20-error-recovery-retry-and-controls",
    badState.retryButton?.action === "exportPdf" && badState.jobControls.every((c) => c.disabled === false) ? "PASS" : "FAIL",
    { retry: badState.retryButton, jobControls: badState.jobControls, status: badState.statusText });

  // Missing-meeting terminal path (nonexistent but valid id).
  const cur4 = await frameCursor(page);
  await page.evaluate(() => window.__qa.socket.send(JSON.stringify({ action: "exportPdf", meetingId: 999999 })));
  const nfErr = await waitForFrame(page, cur4,
    `(f) => f.type === "export" && f.action === "exportPdf" && ["error","timeout"].includes(f.status)`, 30_000);
  rec("T1.21-missing-meeting-terminal-error",
    ["meeting-not-found", "process-failed"].includes(nfErr.code) ? "PASS" : "FAIL",
    { code: nfErr.code, error: nfErr.error });

  writeFileSync(join(EV, "artifacts/track1-results.json"), JSON.stringify({
    results, pdfTerminal: pdfTerm, progressFrames,
    exportsAdded: [...snapExports()].filter((n) => !before.has(n)),
  }, null, 2));
} catch (err) {
  rec("T1-FATAL", "FAIL", err.message);
  writeFileSync(join(EV, "artifacts/track1-results.json"), JSON.stringify({ results, fatal: err.message, stack: err.stack }, null, 2));
  await shot(page, join(SHOTS, "t1-99-fatal.png")).catch(() => {});
} finally {
  await browser.close();
}

console.log("\n=== TRACK 1 SUMMARY ===");
for (const r of results) console.log(`${r.status.padEnd(13)} ${r.id}`);
