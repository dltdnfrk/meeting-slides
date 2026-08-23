#!/usr/bin/env node
// Bounded structural validator for the active operator design contract in DESIGN.md.
// Checks machine-consumed structure only: required headings, sentinel identifiers,
// forbidden ACTIVE claims, and the presence + hash identity of the task evidence it cites.
// It never asserts prose wording, tone, or sentence content.
//
// Usage: node .omo/evidence/caret-clone-redesign/task-6/check-design-contract.mjs [designPath]
// Exit 0 = all checks pass. Exit 1 = at least one check failed. Exit 2 = harness error.

import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const DESIGN = resolve(process.argv[2] ?? resolve(ROOT, "DESIGN.md"));

const results = [];
const record = (id, ok, detail) => results.push({ id, ok, detail });

if (!existsSync(DESIGN)) {
  console.error(`harness error: DESIGN file not found at ${DESIGN}`);
  process.exit(2);
}
const raw = readFileSync(DESIGN, "utf8");

// ---------------------------------------------------------------- structure

const CONTRACT_SENTINEL = "<!-- OMO-CONTRACT-ID: operator-contract-v2-caret-grade -->";
const ACTIVE_HEADING = "## 9. Operator Surface: Active Contract";
const PROVENANCE_HEADING = "## 10. Superseded provenance (historical, non-binding)";

record(
  "sentinel/contract-id-unique",
  raw.split(CONTRACT_SENTINEL).length === 2,
  `expected exactly 1 occurrence of ${CONTRACT_SENTINEL}`,
);
record(
  "sentinel/active-heading-unique",
  raw.split(ACTIVE_HEADING).length === 2,
  `expected exactly 1 heading starting "${ACTIVE_HEADING}"`,
);
record(
  "sentinel/provenance-heading-unique",
  raw.split(PROVENANCE_HEADING).length === 2,
  `expected exactly 1 heading "${PROVENANCE_HEADING}"`,
);

const activeStart = raw.indexOf(ACTIVE_HEADING);
const provenanceStart = raw.indexOf(PROVENANCE_HEADING);
record(
  "structure/active-precedes-provenance",
  activeStart > -1 && provenanceStart > activeStart,
  "the active contract must appear before the superseded provenance section",
);

const activeSection = activeStart > -1 && provenanceStart > activeStart
  ? raw.slice(activeStart, provenanceStart)
  : "";
const provenanceSection = provenanceStart > -1 ? raw.slice(provenanceStart) : "";

const REQUIRED_HEADINGS = [
  "### 9.1 Product intent and reference posture",
  "### 9.2 Brand, asset, and privacy boundaries",
  "### 9.3 Canonical state model",
  "### 9.4 Visual hierarchy",
  "### 9.5 Color, material, and typography",
  "### 9.6 Motion budget",
  "### 9.7 Library shell anatomy",
  "### 9.8 Live shell anatomy",
  "### 9.9 Geometry: wide and narrow",
  "### 9.10 Browser and native minibar division",
  "### 9.11 Progressive disclosure and real capability placement",
  "### 9.12 Focus, keyboard, and accessibility",
  "### 9.13 Loading, empty, and failure states",
  "### 9.14 Preserved DOM, protocol, and product capability",
  "### 9.15 Layer replacement order",
  "### 9.16 Direct-file guard",
  "### 9.17 Accepted operator debt",
];
for (const heading of REQUIRED_HEADINGS) {
  record(
    `heading/${heading.slice(4, 8).trim()}`,
    activeSection.includes(heading),
    `missing required active heading "${heading}"`,
  );
}

// ------------------------------------------------- required machine tokens

// Every entry is a machine-consumed identifier, measured value, or exact geometry
// that a downstream implementation todo reads out of this contract.
const REQUIRED_TOKENS = [
  // canonical state attributes (task-3 compatibility attributes)
  "data-connection", "data-capture-phase", "data-shell", "data-detail-tab",
  "data-stage-state", ".app--capturing",
  // capture phases (task-3 protocol contract)
  "`switching-model`", "`starting`", "`stopping`", "`reconnecting`",
  // measured task-1 reference values
  "#09090b", "#fafafa", "19.06:1",
  "rgba(255, 255, 255, 0.078)", "rgb(39, 39, 42)", "rgba(255, 255, 255, 0.298)",
  "#00c950", "#05df72", "#00a63e", "#e85d4c",
  "16px/400/24px", "14px/500/20px", "24px/500/30px", "18px/400/24.75px",
  "12px/500/16px", "20px/500/25px", "16px/500/24px",
  "Figtree", "Pretendard", "DM Mono", "0.7px",
  // shipped font location (Todo 9 actual: public/fonts/, served same-origin from /fonts/)
  "public/fonts/", "public/fonts/font-manifest.json", "`/fonts/`",
  "cubic-bezier(0.4, 0, 0.2, 1)", "150ms", "200ms",
  // browser geometry matrix (task-1 baseline viewports)
  "1440x900", "1244x836", "960x760", "820x900", "375x812", "320x667",
  // native minibar geometry
  "360x56", "560x220", "16px",
  // binding DOM ids (task-3 dom contract)
  "#current-slide", "#slide-frame", "#stage-pane", "#transcript-pane",
  "#transcript-card", "#transcript-body", "#transcript-stream", "#transcript-empty",
  "#transcript-trunc", "#session-rail", "#session-list", "#notes-input", "#notes-box",
  "#btn-record", "#btn-live-stop", "#live-topbar", "#live-topbar-timer",
  "#detail-tab-overview", "#detail-tab-notes", "#detail-tab-transcript",
  // frozen payload spellings
  "meeting_id", "meetingId", "modelId",
  "workspace.layout.v1", "workspace.transcript.v1",
  // deletion order (task-2 ledger F)
  "public/operational-liquid.css", "public/style.css:1377-1960",
  "public/workspace-shell.css", "public/caret-shell.css",
  // evidence provenance
  ".omo/evidence/caret-clone-redesign/task-1/manifest.json",
  ".omo/evidence/caret-clone-redesign/task-2/green/ledger.md",
  "tests/fixtures/public-dom-contract.json",
  "tests/fixtures/public-protocol-contract.json",
];
for (const token of REQUIRED_TOKENS) {
  record(
    `token/${token}`,
    activeSection.includes(token),
    `active contract must name "${token}"`,
  );
}

// --------------------------------------------------- forbidden ACTIVE claims

// Each rule scans ONLY the active contract. Historical mentions inside section 10
// are allowed by design, which is why the provenance section is sliced off first.
const FORBIDDEN_ACTIVE = [
  { id: "no-tiro-inspired", re: /TIRO[- ]inspired|inspired by TIRO|borrows TIRO/gi },
  { id: "no-liquid-glass-material", re: /Liquid Glass|glassmorphism|translucent zinc glass/gi },
  { id: "no-not-a-clone-endpoint", re: /not a (?:brand )?clone|not a native CEF clone|non-clone/gi },
  { id: "no-universal-screenshare-claim", re: /hidden during screen[- ]shar|invisible during screen[- ]shar|screen[- ]share invisib/gi },
  { id: "no-caret-private-assets", re: /Casper|caret logo|caret wordmark|caret mascot/gi },
  { id: "no-wkwebview-adoption", re: /adopt \w*\s?WKWebView|migrate to WKWebView|embed the (?:main )?workspace in (?:a )?WKWebView/gi },
  { id: "no-fake-pause", re: /\bPause control\b/gi },
  // Todo 9 ships fonts to public/fonts/. Any assets/fonts path in the active contract is
  // stale, and no phrasing makes it correct, so this rule ignores the negation window.
  { id: "no-stale-font-path", re: /public\/assets\/fonts|assets\/fonts\//gi, always: true },
];
// A forbidden phrase is tolerated ONLY when the same sentence prohibits it. Every
// occurrence is checked independently, so a legitimate prohibition earlier in the
// document can never mask a later contradictory claim.
const NEGATION = /\bno\b|\bnever\b|\bnot\b|prohibit|forbidden|may not|must not|unstated|absent|retired|superseded|no longer/i;
const sentenceAround = (text, index) => {
  const start = Math.max(
    text.lastIndexOf(".", index) + 1,
    text.lastIndexOf("\n\n", index) + 1,
    text.lastIndexOf("|", index) + 1,
  );
  const dot = text.indexOf(".", index);
  const bar = text.indexOf("|", index);
  const ends = [dot, bar, text.indexOf("\n\n", index)].filter((n) => n > -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end);
};
for (const rule of FORBIDDEN_ACTIVE) {
  const offenders = [];
  for (const hit of activeSection.matchAll(rule.re)) {
    const sentence = sentenceAround(activeSection, hit.index);
    if (rule.always || !NEGATION.test(sentence)) {
      offenders.push(`"${hit[0]}" in: ${sentence.trim().slice(0, 120)}`);
    }
  }
  record(
    `forbidden/${rule.id}`,
    offenders.length === 0,
    offenders.join(" || "),
  );
}

record(
  "provenance/marks-superseded",
  /superseded/i.test(provenanceSection) &&
    /non-binding|carr(?:y|ies) no authority|Nothing in this section is an active rule/i.test(provenanceSection),
  "section 10 must mark prior systems superseded and non-binding",
);
record(
  "provenance/names-retired-systems",
  /TIRO/.test(provenanceSection) && /Liquid Glass/.test(provenanceSection),
  "section 10 must name the retired TIRO and Liquid Glass systems",
);

// ------------------------------------------------------- evidence integrity

// The contract cites task evidence. If a cited artifact vanishes or its content
// hash drifts from the recorded value, the contract's measured values are stale.
const EVIDENCE = [
  {
    // Cited by 9.2 as the license/SHA-256 receipt for the vendored operator fonts. Existence
    // only: this file is owned and regenerated by Todo 9, so pinning its content here would
    // couple this check to a sibling task's legitimate regeneration.
    path: "public/fonts/font-manifest.json",
    existsOnly: true,
  },
  {
    path: ".omo/evidence/caret-clone-redesign/task-1/manifest.json",
    sha256: "95b8246a0afaf64ac87d7567278358ba9f1cc8ca5e0c3e2e06b78b0a502dcfd9",
  },
  {
    path: ".omo/evidence/caret-clone-redesign/task-2/green/ledger.md",
    sha256: "b545c7724732921e6a7ecfce27b3474d10a80514c4f96319b14eb61555d08d7b",
  },
  {
    path: "tests/fixtures/public-dom-contract.json",
    sha256: "1b1707078b2deafd1e12f66d5d9c5a1bdfd1f025cf9e9aa18abde433b0102f57",
  },
  {
    path: "tests/fixtures/public-protocol-contract.json",
    sha256: "2c999d76e5e5ae309f563252e64e4921e65a0749530e472c71fa9e82d5642bd7",
  },
];
for (const entry of EVIDENCE) {
  const abs = resolve(ROOT, entry.path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    record(`evidence/${entry.path}`, false, "cited evidence artifact is missing");
    continue;
  }
  if (entry.existsOnly) {
    record(`evidence/${entry.path}`, true, "");
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
  record(
    `evidence/${entry.path}`,
    actual === entry.sha256,
    `hash drift: expected ${entry.sha256}, found ${actual}`,
  );
}

// ------------------------------------------------------------------ report

const failed = results.filter((r) => !r.ok);
const report = {
  design: DESIGN,
  designSha256: createHash("sha256").update(raw).digest("hex"),
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((f) => ({ id: f.id, detail: f.detail })),
};
console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
