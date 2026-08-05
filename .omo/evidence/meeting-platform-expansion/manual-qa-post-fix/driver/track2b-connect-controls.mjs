// Track 2b: connect controls exercised without altering real external accounts.
//
// Constraint discovered and honoured:
//   providerConnectCommand() for cli:codex / cli:grok / cli:claude resolves to
//   `codex login`, `grok login`, `claude auth login` — real interactive vendor
//   logins that write the live credential store. Clicking those is an external
//   account mutation, so they are NOT clicked. The exact command each control
//   would spawn is captured in logs/provider-connect-commands.txt instead.
//
// What IS exercised end-to-end here:
//   - the connect control is present, labelled truthfully, and wired for all 4 CLIs
//   - cli:gemini connect: declares NO login args -> spawning it cannot mutate
//     credentials, so the real control is clicked and the server response observed
//   - non-CLI connect controls (openai / alibaba / local) only open a URL or emit
//     guidance, so they are clicked and their real status responses observed
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, shot, frameCursor, waitForFrame, readSettingsState, openSettings, DESKTOP } from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const SHOTS = join(EV, "screens");
const results = [];
const rec = (id, ok, detail) => {
  const status = ok === true ? "PASS" : ok === false ? "FAIL" : String(ok);
  results.push({ id, status, detail });
  console.log(`[${status}] ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

// Controls that spawn a real vendor login -> must NOT be clicked.
const EXTERNAL_WRITE = new Set(["cli:codex", "cli:grok", "cli:claude"]);
// Safe: no login args declared, or URL-open/guidance only.
const SAFE_TO_CLICK = ["cli:gemini", "openai", "alibaba", "local"];

const browser = await launch();
const page = await openApp(browser, DESKTOP);

try {
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#provider-list .provider-row").length >= 4,
    { timeout: 10_000, polling: "mutation" });
  const s = await readSettingsState(page);

  // Connect control present + truthfully labelled for every CLI provider.
  const cliRows = s.providers.filter((p) => p.id.startsWith("cli:"));
  rec("T2B.1-connect-control-present-all-cli",
    cliRows.length === 4 && cliRows.every((p) => p.connectLabel !== null),
    cliRows.map((p) => ({ id: p.id, auth: p.auth, connectLabel: p.connectLabel })));

  // Label must reflect real auth: connected -> 재인증, otherwise 연결.
  rec("T2B.2-connect-label-matches-real-auth",
    cliRows.every((p) => p.connectLabel === (p.auth === "connected" ? "재인증" : "연결")),
    cliRows.map((p) => ({ id: p.id, auth: p.auth, label: p.connectLabel })));

  // Non-CLI providers expose key entry, not a subscription login.
  const httpRows = s.providers.filter((p) => p.id === "openai" || p.id === "alibaba");
  rec("T2B.3-http-provider-key-control-matches-state",
    httpRows.length === 2 && httpRows.every((p) => p.auth === "connected" || p.hasKeyInput === true),
    httpRows.map((p) => ({ id: p.id, auth: p.auth, hasKeyInput: p.hasKeyInput, badge: p.badge })));

  // Record the deliberate non-click limitation.
  rec("T2B.4-external-write-controls-not-clicked", "BLOCKED-BY-DESIGN",
    { notClicked: [...EXTERNAL_WRITE],
      reason: "codex login / grok login / claude auth login are real interactive vendor logins that rewrite the live credential store; clicking them alters real external accounts",
      evidence: "logs/provider-connect-commands.txt records the exact executable+args each control would spawn" });

  // Click the safe connect controls and observe the real server response.
  const clicked = [];
  for (const id of SAFE_TO_CLICK) {
    const row = s.providers.find((p) => p.id === id);
    if (!row) { rec(`T2B.5-connect-${id}`, "SKIP", "row not rendered"); continue; }
    const cur = await frameCursor(page);
    const has = await page.$(`.provider-row[data-id="${id}"] .provider-row__connect`);
    if (!has) { rec(`T2B.5-connect-${id}`, "SKIP", "no connect control rendered"); continue; }
    await page.click(`.provider-row[data-id="${id}"] .provider-row__connect`);
    // Armed on the real status frame the server emits for this control.
    const frame = await waitForFrame(page, cur, `(f) => f.type === "status"`, 15_000);
    await page.waitForFunction((t) => document.getElementById("status-text")?.textContent?.trim() === t,
      { timeout: 6_000, polling: "mutation" }, frame.text).catch(() => {});
    const st = await readSettingsState(page);
    clicked.push({ id, serverStatus: frame.text, uiStatus: st.statusText });
    await shot(page, join(SHOTS, `t2b-connect-${id.replace(":", "-")}.png`));
    rec(`T2B.5-connect-${id}`, typeof frame.text === "string" && frame.text.length > 0,
      { serverStatus: frame.text, uiStatus: st.statusText });
  }

  // Auth state must not have optimistically flipped to connected from a click.
  const after = await readSettingsState(page);
  const flipped = after.providers.filter((p) => p.id.startsWith("cli:") && p.auth === "connected")
    .map((p) => p.id).sort();
  rec("T2B.6-no-optimistic-auth-flip-after-connect",
    JSON.stringify(flipped) === JSON.stringify(["cli:claude", "cli:codex"]),
    { connectedAfterClicks: flipped, expected: ["cli:claude", "cli:codex"] });

  await shot(page, join(SHOTS, "t2b-after-connect-clicks.png"));
  writeFileSync(join(EV, "artifacts/track2b-connect-results.json"),
    JSON.stringify({ results, clicked, externalWriteNotClicked: [...EXTERNAL_WRITE] }, null, 2));
} catch (err) {
  rec("T2B-FATAL", false, err.message);
  writeFileSync(join(EV, "artifacts/track2b-connect-results.json"), JSON.stringify({ results, fatal: err.message, stack: err.stack }, null, 2));
} finally {
  await browser.close();
}

console.log("\n=== TRACK 2B SUMMARY ===");
for (const r of results) console.log(`${String(r.status).padEnd(18)} ${r.id}`);
