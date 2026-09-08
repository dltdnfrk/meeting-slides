// Locks the machine-consumed DOM and wire-protocol surface of the shipped client.
// Reads the shipped DOM/client and checks the public wire types — never a copy —
// so a duplicated binding ID, a moved #current-slide, a renamed payload key, or a
// removed server message type fails here before it reaches a browser test.
// Only machine-consumed names are asserted. No prose, copy, or CSS wording is pinned.
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";
import { startMeetingServer, bounded } from "./helpers/meeting-server.ts";
import { KNOWN_MESSAGE_TYPES, type KnownMessageType } from "../public/protocol-values.ts";
import { initialUiState, parseServerEvent, reduce } from "../public/ui-state-machine.ts";
import { initialTranscriptState, parseTranscriptEvent, reduceTranscript } from "../public/transcript-state.ts";
import { MeetingSession } from "../src/session.ts";
import type {
  ClientAction, ClientListener, CompileJobId, ExportJobId, MeetingDetailUpdate,
  ServerMessage, CaptureUpdate, CapturePhase, TranscriptUpdate,
} from "../src/protocol.ts";
import type * as LegacySession from "../src/session.ts";

import domContract from "./fixtures/public-dom-contract.json" with { type: "json" };
import protocolContract from "./fixtures/public-protocol-contract.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

// Follow actual ESM imports, including root-relative browser specifiers and cycles.
function shippedScriptGraph(): Map<string, string> {
  const sources = new Map<string, string>();
  const scanner = new Bun.Transpiler({ loader: "js" });
  const visit = (path: string) => {
    if (sources.has(path)) return;
    const code = read(path);
    sources.set(path, code);
    for (const entry of scanner.scan(code).imports) {
      const specifier = entry.path;
      if (specifier.startsWith("/")) visit(join("public", specifier.slice(1)));
      else if (specifier.startsWith(".")) visit(join(dirname(path), specifier));
      else throw new Error(`Unshipped browser dependency: ${specifier}`);
    }
  };
  for (const match of read(domContract.documents.html).matchAll(/<script\b[^>]*\ssrc="\/([^"]+)"/g)) {
    visit(`public/${match[1]}`);
  }
  return sources;
}
const scriptGraph = shippedScriptGraph();
let browser: Browser;
beforeAll(async () => { browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

async function withPublicPage(run: (page: Page, harness: PublicTestHarness) => Promise<void>) {
  const harness = createPublicTestHarness();
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(harness.origin, { waitUntil: "load" });
    await bounded(harness.clientConnected, "public socket");
    await run(page, harness);
  } finally { await page.close(); harness.stop(); }
}

// One socket's status sentinel fences all preceding frames; subscribe before send.
async function deliver(page: Page, harness: PublicTestHarness, ...frames: ServerMessage[]) {
  const marker = `contract-receipt-${harness.sentSequence}`;
  const receipt = await page.evaluateHandle((marker) => ({ done: new Promise<void>((resolve, reject) => {
    const node = document.getElementById("status-text");
    if (!node) throw new Error("status surface missing");
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(marker)); }, 5000);
    const observer = new MutationObserver(() => {
      if (node.textContent !== marker) return;
      clearTimeout(timeout); observer.disconnect(); resolve();
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
  }) }), marker);
  try {
    for (const frame of frames) harness.pushMessage(frame);
    harness.pushMessage({ type: "status", text: marker });
    await receipt.evaluate((receipt) => receipt.done);
  } finally { await receipt.dispose(); }
}


interface IdSpec {
  readonly id: string;
  readonly tag: string;
  readonly type?: string;
  readonly role?: string;
  readonly owner: string;
}

interface DomElement {
  readonly id: string;
  readonly tag: string;
  readonly type?: string;
  readonly role?: string;
  /** Ancestor ids from nearest to furthest. Elements without an identified ancestor get []. */
  readonly ancestorIds: readonly string[];
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Minimal, deterministic HTML element scanner. It walks tags in document order
 * while maintaining an open-element stack, which is enough to recover the id
 * ancestry the contract cares about without pulling in a DOM implementation.
 */
function parseHtmlElements(html: string): DomElement[] {
  const body = html.slice(html.indexOf("<body"));
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack: Array<{ tag: string; id?: string }> = [];
  const elements: DomElement[] = [];
  const attribute = (attrs: string, name: string): string | undefined =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];

  for (const match of body.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    const attrs = match[3] ?? "";
    const selfClosed = match[4] === "/";

    if (closing) {
      const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (index !== -1) stack.length = index;
      continue;
    }

    const id = attribute(attrs, "id");
    if (id !== undefined) {
      elements.push({
        id,
        tag,
        type: attribute(attrs, "type"),
        role: attribute(attrs, "role"),
        ancestorIds: stack
          .map((entry) => entry.id)
          .filter((entry): entry is string => entry !== undefined)
          .reverse(),
      });
    }
    if (!selfClosed && !VOID_TAGS.has(tag)) stack.push({ tag, id });
  }
  return elements;
}

const html = read(domContract.documents.html);
const elements = parseHtmlElements(html);
const byId = new Map<string, DomElement[]>();
for (const element of elements) {
  const bucket = byId.get(element.id);
  if (bucket) bucket.push(element);
  else byId.set(element.id, [element]);
}

const idSpecs = domContract.uniqueIds as readonly IdSpec[];

describe("shipped DOM contract", () => {
  test("the real public ESM graph loads and both generated parsers accept refine", async () => {
    await withPublicPage(async (page, harness) => {
      const result = await page.evaluate(async (paths) => {
        const [protocol, ui, transcript] = await Promise.all(paths.map((path) => import(path)));
        const frame = { type: "refine", requestId: "refine-contract", slideId: "s1", path: "title",
          before: "BEFORE", after: "AFTER", claimIds: [] };
        return { types: protocol.KNOWN_MESSAGE_TYPES,
          ui: ui.parseServerEvent(frame), transcript: transcript.parseTranscriptEvent(frame) };
      }, ["/generated/protocol-values.js", "/generated/ui-state-machine.js", "/generated/transcript-state.js"]);
      const accepted = { ok: true, event: { kind: "server", message: "other", type: "refine" } };
      expect(result).toEqual({ types: KNOWN_MESSAGE_TYPES, ui: accepted, transcript: accepted });
      for (const module of domContract.documents.modules) {
        expect(harness.servedPaths).toContain(module.replace(/^public/, ""));
      }
    });
  });

  test("the manifest itself lists each binding id exactly once", () => {
    // Guards the fixture against a duplicated entry, which would otherwise
    // collapse silently in any id-keyed comparison below.
    const listed = idSpecs.map((spec) => spec.id);
    const duplicated = listed.filter((id, index) => listed.indexOf(id) !== index);
    expect(duplicated).toEqual([]);
  });

  test("every binding id occurs exactly once in the shipped HTML", () => {
    const occurrences = idSpecs.map((spec) => ({
      id: spec.id,
      count: byId.get(spec.id)?.length ?? 0,
    }));
    expect(occurrences).toEqual(idSpecs.map((spec) => ({ id: spec.id, count: 1 })));
  });

  test("the final rebuild decision keeps its frozen semantic ids and control types", () => {
    expect([
      byId.get("slide-final-rebuild-dialog")?.[0],
      byId.get("btn-slide-final-rebuild-cancel")?.[0],
      byId.get("btn-slide-final-rebuild-confirm")?.[0],
    ].map((node) => node === undefined ? null : {
      id: node.id,
      tag: node.tag,
      type: node.type,
      role: node.role,
    })).toEqual([
      { id: "slide-final-rebuild-dialog", tag: "section", type: undefined, role: "dialog" },
      { id: "btn-slide-final-rebuild-cancel", tag: "button", type: "button", role: undefined },
      { id: "btn-slide-final-rebuild-confirm", tag: "button", type: "button", role: undefined },
    ]);
  });

  test("compile control updates its accessible purpose for a confirmed review", async () => {
    await withPublicPage(async (page, harness) => {
      await deliver(page, harness, messageSamples.capture, { type: "meetings", items: [
        { id: 7, title: "MEETING", started_at: 1, status: "ended" },
      ] });
      const selected = harness.nextClientMessage();
      await page.click('.session-row[data-meeting-id="7"]');
      expect(await selected).toEqual({ action: "selectMeeting", meetingId: 7 });
      await deliver(page, harness, messageSamples.meeting);
      const readControl = () => page.$eval("#btn-compile-deck", (node) => ({
        text: node.textContent, label: node.getAttribute("aria-label"), title: node.getAttribute("title"),
      }));
      const draft = await readControl();
      await deliver(page, harness, messageSamples.reviewConfirmed);
      const final = await readControl();
      expect(final.text).not.toBe(draft.text);
      expect(final.label).not.toBe(draft.label);
      expect(final.label).toBe(final.title);
      expect(final.label?.length).toBeGreaterThan(0);
      expect(await page.$$("#btn-compile-deck")).toHaveLength(1);
    });
  });

  test("no id in the shipped HTML is duplicated at all", () => {
    const duplicated = [...byId.entries()]
      .filter(([, nodes]) => nodes.length > 1)
      .map(([id, nodes]) => ({ id, count: nodes.length }));
    expect(duplicated).toEqual([]);
  });

  test("binding controls keep their element and control types", () => {
    const actual = idSpecs.map((spec) => {
      const node = byId.get(spec.id)?.[0];
      return {
        id: spec.id,
        tag: node?.tag ?? null,
        ...(spec.type === undefined ? {} : { type: node?.type ?? null }),
        ...(spec.role === undefined ? {} : { role: node?.role ?? null }),
      };
    });
    const expected = idSpecs.map((spec) => ({
      id: spec.id,
      tag: spec.tag,
      ...(spec.type === undefined ? {} : { type: spec.type }),
      ...(spec.role === undefined ? {} : { role: spec.role }),
    }));
    expect(actual).toEqual(expected);
  });

  test("required ancestry holds, including #current-slide beneath #stage-pane", () => {
    const violations = domContract.ancestry
      .filter(({ descendant, ancestor }) => {
        const node = byId.get(descendant)?.[0];
        return node === undefined || !node.ancestorIds.includes(ancestor);
      })
      .map(({ descendant, ancestor }) => `#${descendant} is not inside #${ancestor}`);
    expect(violations).toEqual([]);
  });

  test("panes that must not nest stay disjoint", () => {
    const violations = domContract.disjoint
      .filter(({ a, b }) => {
        const nodeA = byId.get(a)?.[0];
        const nodeB = byId.get(b)?.[0];
        return nodeA === undefined || nodeB === undefined
          || nodeA.ancestorIds.includes(b) || nodeB.ancestorIds.includes(a);
      })
      .map(({ a, b }) => `#${a} and #${b} are nested`);
    expect(violations).toEqual([]);
  });

  test("HTML entries and their reachable ESM graph load every contract module", () => {
    const loaded = [...html.matchAll(/<script\b[^>]*\ssrc="\/([^"]+)"/g)].map((match) => `public/${match[1]}`);
    expect(loaded).toEqual(domContract.documents.scripts);
    expect([...html.matchAll(/<script\b[^>]*type="module"[^>]*src="\/([^"]+)"/g)]
      .map((match) => `public/${match[1]}`)).toEqual([domContract.documents.moduleEntrypoint]);
    for (const module of domContract.documents.modules) expect(scriptGraph.has(module)).toBe(true);
    for (const module of protocolContract.documents.clientScripts) expect(scriptGraph.has(module)).toBe(true);
    expect([...scriptGraph.keys()].filter((path) => path.endsWith(".ts"))).toEqual([]);
  });

  test("scripts still resolve the binding ids they own", () => {
    const sources = scriptGraph;
    const missing = idSpecs
      .filter((spec) => spec.owner.endsWith(".js"))
      .filter((spec) => !(sources.get(spec.owner) ?? "").includes(`"${spec.id}"`))
      .map((spec) => `${spec.owner} no longer references #${spec.id}`);
    expect(missing).toEqual([]);
  });
});

describe("compatibility data attributes and persisted layout keys", () => {
  const appJs = read(domContract.compatibilityAttributes.documentElementDataset.writtenBy);
  const operatorJs = read("public/operator-surface.js");

  test("connection state attribute keeps its exact spelling and value set", () => {
    const spec = domContract.compatibilityAttributes.documentElementDataset;
    expect(spec.attribute).toBe("data-connection");
    const written = [...appJs.matchAll(/documentElement\.dataset\.connection\s*=\s*"([a-z]+)"/g)]
      .map((match) => match[1]!);
    expect([...new Set(written)].sort()).toEqual([...spec.values].sort());
  });

  test("detail tab attribute keeps its exact spelling and value set", () => {
    const [spec] = domContract.compatibilityAttributes.appDataset;
    expect(spec!.attribute).toBe("data-detail-tab");
    expect(html).toContain('data-detail-tab="overview"');
    for (const value of spec!.values) {
      expect({ value, declared: html.includes(`data-detail-tab="${value}"`) })
        .toEqual({ value, declared: true });
    }
    expect(operatorJs).toContain("app.dataset.detailTab = tab");
  });

  test("capture-state compatibility classes project authoritative capture frames", async () => {
    await withPublicPage(async (page, harness) => {
      for (const capturing of [true, false]) {
        await deliver(page, harness, { type: "capture", capturing, mode: "mic", phase: capturing ? "capturing" : "idle", startedAt: 1 });
        const projection = await page.evaluate(() => ({
          capturing: document.querySelector(".app")?.classList.contains("app--capturing"),
          recording: document.getElementById("btn-record")?.classList.contains("record-btn--on"),
          pressed: document.getElementById("btn-record")?.getAttribute("aria-pressed"),
        }));
        expect(projection).toEqual({ capturing, recording: capturing, pressed: String(capturing) });
      }
    });
  });

  test("output switcher targets exist and resolve to real ids", () => {
    const declared = [...html.matchAll(/data-output-target="([a-z-]+)"/g)].map((match) => match[1]!);
    expect(declared).toEqual([...domContract.compatibilityAttributes.outputTargets]);
    const unresolved = declared.filter((target) => !byId.has(target));
    expect(unresolved).toEqual([]);
  });

  test("persisted layout keys and their payload keys are unchanged", () => {
    const actual = domContract.persistedLayoutKeys.map((entry) => {
      const source = read(entry.source);
      return {
        key: entry.key,
        declared: source.includes(`"${entry.key}"`),
        payloadKeys: entry.payloadKeys.filter((payloadKey) =>
          new RegExp(`\\b${payloadKey}\\b`).test(source)),
      };
    });
    expect(actual).toEqual(
      domContract.persistedLayoutKeys.map((entry) => ({
        key: entry.key,
        declared: true,
        payloadKeys: [...entry.payloadKeys],
      })),
    );
  });
});

// These positive fixtures are also checked by tsc: Bun only erases their types.
const messageSamples = {
  slide: { type: "slide", current: null, history: [] },
  caption: { type: "caption", text: "CAPTION", ts: 1, speaker: 2 },
  line: { type: "line", text: "LINE", ts: 1 },
  transcript: { type: "transcript", entries: [], reason: "snapshot", truncated: false },
  status: { type: "status", text: "STATUS", mutationAction: "updateItem", meetingId: null, reviewId: null, itemId: null },
  providers: { type: "providers", list: [], current: "codex" },
  capture: { type: "capture", capturing: false, mode: "mic" },
  sttModels: { type: "sttModels", models: [], selectedModelId: null },
  meetings: { type: "meetings", items: [] },
  meeting: { type: "meeting", meetingId: 7, title: "MEETING", purpose: null, transcript: [], current: null, history: [], compiled: null },
  attendees: { type: "attendees", meeting_id: null, attendees: [] },
  review: { type: "review", meetingId: 7, reviewId: "r1", transcriptVersionId: "v1", attendees: [], transcript: { lines: [] }, items: [], status: "draft" },
  detect: { type: "detect", detecting: false },
  saved: { type: "saved", path: "/artifact.md" },
  compile: { type: "compile", status: "success", jobId: "compile-fixture", publicationStatus: "final" },
  export: { type: "export", status: "started", action: "exportPdf", jobId: "pdf-fixture" },
  ask: { type: "ask", requestId: "ask-fixture", answer: "ANSWER", matchedCount: 0 },
  refine: { type: "refine", requestId: "refine-fixture", slideId: "s1", path: "title", before: "BEFORE", after: "AFTER", claimIds: [] },
  reviewItemUpdated: { type: "reviewItemUpdated", meetingId: 7, reviewId: "r1", itemId: "i1", kind: "decision" },
  reviewConfirmed: { type: "reviewConfirmed", meetingId: 7, reviewId: "r1", transcriptVersionId: "v1", confirmedAt: 2 },
  meetingConcluded: { type: "meetingConcluded", concluded: true, meetingId: 7, reviewId: "r1", transcriptVersionId: "v1", bundleId: "b1", bundlePath: "/bundle", manifest: { sha256: "HASH", targetCommit: "COMMIT" }, concludedAt: 3 },
} satisfies { [K in ServerMessage["type"]]: Extract<ServerMessage, { type: K }> };

const actionSamples = [
  { action: "startCapture", meeting_id: 7 },
  { action: "audio", data: "AAAA" },
  { action: "setCaptureSource", source: "system" },
  { action: "stopCapture" }, { action: "reset" }, { action: "status" },
  { action: "listMeetings" }, { action: "transcript" },
  { action: "recheckProviders" }, { action: "recheckSttModels" }, { action: "attendees" },
  { action: "startReview", meetingId: 7, notes: "NOTES", retry: true },
  { action: "deleteMeeting", meetingId: 7 }, { action: "selectMeeting", meetingId: 7 },
  { action: "compileSlidePlan" }, { action: "exportDeck" }, { action: "exportPdf" },
  { action: "exportPng" }, { action: "saveNotes" }, { action: "saveTranscript" }, { action: "saveJson" },
  { action: "persistSlidePlan", plan: {} },
  { action: "setProvider", id: "codex", model: "MODEL", effort: "high" },
  { action: "connectProvider", id: "codex" }, { action: "setProviderKey", id: "codex", key: "FIXTURE" },
  { action: "setAttendees", purpose: null, attendees: [{ name: "ATTENDEE", attendeeId: "a1", crmPersonId: null }] },
  { action: "updateItem", reviewId: "r1", itemId: "i1", kind: "decision", patch: { reviewState: "confirmed" } },
  { action: "confirmReview", reviewId: "r1" },
  { action: "ask", meetingId: 7, question: "QUESTION", requestId: "ask-fixture" },
  { action: "refineSlideField", meetingId: 7, slideId: "s1", path: "title", text: "TEXT", instruction: "INSTRUCTION", claimIds: [], requestId: "refine-fixture" },
  { action: "installSttModel", modelId: "small" }, { action: "cancelSttModel", modelId: "small" },
  { action: "selectSttModel", modelId: "small" },
] satisfies ClientAction[];

const publicationSequence = { publicationSeq: 3 } satisfies
  Pick<NonNullable<MeetingDetailUpdate["slidePlan"]>, "publicationSeq">;
const jobIds = ["compile-fixture", "png-fixture", "pdf-fixture", "pptx-fixture"] satisfies
  [CompileJobId, ExportJobId, ExportJobId, ExportJobId];

describe("typed wire values and session compatibility", () => {
  test("browser values and serialized samples cover the exact canonical unions", () => {
    expectTypeOf<KnownMessageType>().toEqualTypeOf<ServerMessage["type"]>();
    expectTypeOf<(typeof actionSamples)[number]["action"]>().toEqualTypeOf<ClientAction["action"]>();
    expect(Object.keys(messageSamples).sort()).toEqual([...KNOWN_MESSAGE_TYPES].sort());
    expect(Object.isFrozen(KNOWN_MESSAGE_TYPES)).toBe(true);
  });

  test("every valid frame parses in both projections and irrelevant frames are no-ops", () => {
    const ui = initialUiState();
    const transcript = initialTranscriptState();
    for (const frame of Object.values(messageSamples)) {
      const uiParsed = parseServerEvent(frame);
      const transcriptParsed = parseTranscriptEvent(frame);
      expect({ type: frame.type, ui: uiParsed.ok, transcript: transcriptParsed.ok })
        .toEqual({ type: frame.type, ui: true, transcript: true });
      if (uiParsed.ok && uiParsed.event.message === "other") expect(reduce(ui, uiParsed.event)).toEqual(ui);
      if (transcriptParsed.ok && transcriptParsed.event.message === "other") {
        expect(reduceTranscript(transcript, transcriptParsed.event)).toEqual(transcript);
      }
    }
  });

  test("legacy type imports are identical to the canonical protocol", () => {
    expectTypeOf<LegacySession.ServerMessage>().toEqualTypeOf<ServerMessage>();
    expectTypeOf<LegacySession.ClientAction>().toEqualTypeOf<ClientAction>();
    expectTypeOf<LegacySession.ClientListener>().toEqualTypeOf<ClientListener>();
    expectTypeOf<LegacySession.CompileJobId>().toEqualTypeOf<CompileJobId>();
    expectTypeOf<LegacySession.ExportJobId>().toEqualTypeOf<ExportJobId>();
  });

  test("sample payloads match the accepted required and optional action keys", () => {
    for (const command of actionSamples) {
      const spec = protocolContract.clientActions.find((entry) => entry.action === command.action);
      if (!spec) throw new Error(`missing action contract: ${command.action}`);
      const keys = Object.keys(command).filter((key) => key !== "action");
      expect(keys.filter((key) => !spec.payloadKeys.includes(key))).toEqual([]);
      expect(spec.requiredKeys.filter((key) => !keys.includes(key))).toEqual([]);
    }
  });

  test("each declared message and action has a serialized fixture", () => {
    expect(protocolContract.serverMessages.map((message) => message.type).sort())
      .toEqual(Object.values(messageSamples).map((message) => message.type).sort());
    expect(protocolContract.clientActions.map((command) => command.action).sort())
      .toEqual(actionSamples.map((command) => command.action).sort());
  });

  test("existing nullable identities, correlation and publication values survive JSON", () => {
    expect(JSON.parse(JSON.stringify(messageSamples.attendees)))
      .toEqual({ type: "attendees", meeting_id: null, attendees: [] });
    expect(JSON.parse(JSON.stringify(publicationSequence))).toEqual({ publicationSeq: 3 });
    expect(jobIds.map((id) => id.split("-")[0])).toEqual(["compile", "png", "pdf", "pptx"]);
    expect(actionSamples.filter((command) => "requestId" in command).map((command) => command.requestId))
      .toEqual([messageSamples.ask.requestId, messageSamples.refine.requestId]);
  });

  test("legacy session imports retain listener, transcript, sink and snapshot behavior", async () => {
    // Given: subscribe before ingest; flush explicitly rather than waiting for a timer.
    const messages: ServerMessage[] = [];
    const listener: ClientListener = (message) => { messages.push(message); };
    const stored: unknown[] = [];
    const session = new MeetingSession({
      detectBlock: async () => { throw new Error("automatic detection must remain disabled"); },
      ping: async () => true,
    }, 3, 12, new Set([listener]), {
      onLine: (entry) => { stored.push(entry); },
      onSlide: () => { throw new Error("caption ingest must not create slides"); },
    }, { automaticDetection: false });
    const chunk = { text: "TRANSCRIPT_SENTINEL", ts: 11, audioStartMs: 2, audioEndMs: 8, speaker: 4 };

    // When
    session.onChunk(chunk);
    await session.flush();

    // Then
    expect(messages).toEqual([
      { type: "line", text: chunk.text, ts: 11, speaker: 4 },
      { type: "caption", text: chunk.text, ts: expect.any(Number), speaker: 4 },
    ]);
    expect(stored).toEqual([chunk]);
    expect(session.transcript("snapshot")).toEqual({ type: "transcript", entries: [chunk], reason: "snapshot", truncated: false });
    expect(session.snapshot()).toEqual(messageSamples.slide);
  });
});

describe("shipped wire protocol contract", () => {
  // Local editor command serializers are not socket traffic. Follow all reachable
  // users of the injected transport, rather than treating every action-shaped
  // object in a shared library as a frame the browser sends.
  const wireModules = [...scriptGraph.entries()].filter(([, code]) => /\btransport\.send\s*\(/.test(code));
  const clientSources = wireModules.map(([, code]) => code).join("\n");

  test("the fixture covers every reachable controller that sends socket traffic", () => {
    expect(wireModules.map(([path]) => path).sort()).toEqual([...protocolContract.documents.clientScripts].sort());
  });

  test("the protocol manifest lists each action and message type exactly once", () => {
    const actions = protocolContract.clientActions.map((entry) => entry.action);
    const messages = protocolContract.serverMessages.map((entry) => entry.type);
    expect({
      duplicateActions: actions.filter((a, i) => actions.indexOf(a) !== i),
      duplicateMessages: messages.filter((m, i) => messages.indexOf(m) !== i),
    }).toEqual({ duplicateActions: [], duplicateMessages: [] });
  });

  test("every contract action name is emitted or dispatched with its exact spelling", () => {
    const missing = protocolContract.clientActions
      .filter((entry) => !read(entry.source).includes(`"${entry.action}"`))
      .map((entry) => `${entry.source} no longer names action ${entry.action}`);
    expect(missing).toEqual([]);
  });

  test("client emits no action outside the contract", () => {
    const emitted = new Set<string>();
    for (const match of clientSources.matchAll(/action:\s*"([A-Za-z]+)"/g)) emitted.add(match[1]!);
    for (const match of clientSources.matchAll(/sendSttAction\("([A-Za-z]+)"/g)) emitted.add(match[1]!);
    const known = new Set(protocolContract.clientActions.map((entry) => entry.action));
    expect([...emitted].filter((action) => !known.has(action)).sort()).toEqual([]);
  });

  test("startCapture keeps the snake_case meeting_id payload spelling", () => {
    const parsed = parseServerEvent(messageSamples.capture);
    if (!parsed.ok) throw new Error(parsed.error.reason);
    const selected = reduce(reduce(initialUiState(), parsed.event), { kind: "selectMeeting", meetingId: 7 });
    expect(reduce(selected, { kind: "activateCapture" }).outbox)
      .toEqual([{ action: "startCapture", meeting_id: 7 }]);
    expect(protocolContract.clientActions.find((entry) => entry.action === "startCapture")?.payloadKeys)
      .toEqual(["meeting_id"]);
  });

  test("critical payload key spellings are present and their aliases absent", () => {
    // Each emission site is scoped to its own balanced object literal so a key
    // belonging to the next statement can never be mistaken for this payload.
    const emissionSites = (action: string): string[] => {
      const sites: string[] = [];
      const marker = `action: "${action}"`;
      for (let index = clientSources.indexOf(marker); index !== -1;
        index = clientSources.indexOf(marker, index + marker.length)) {
        const open = clientSources.lastIndexOf("{", index);
        if (open === -1) continue;
        let depth = 0;
        for (let cursor = open; cursor < clientSources.length; cursor += 1) {
          if (clientSources[cursor] === "{") depth += 1;
          else if (clientSources[cursor] === "}") {
            depth -= 1;
            if (depth === 0) {
              sites.push(clientSources.slice(open, cursor + 1));
              break;
            }
          }
        }
      }
      return sites;
    };
    const findings = protocolContract.criticalPayloadSpellings.map((entry) => {
      // sendSttAction(action, modelId) forwards the key from a shared helper.
      const sites = entry.action.endsWith("SttModel")
        ? [/sendSttAction\([^)]*\)\s*\{[\s\S]{0,200}?\}/.exec(clientSources)?.[0] ?? ""]
        : emissionSites(entry.action);
      // Key position only: `meeting_id: attendeeState.meetingId` emits the
      // contracted key even though a local read carries the camelCase name.
      // Matches `name:` and the ES shorthand `{ ..., name }` / `{ ..., name,`.
      const asKey = (name: string) =>
        new RegExp(`(^|[{,\\s])${name}\\s*(:|,|\\}|$)`);
      const emitsKey = sites.some((site) => asKey(entry.key).test(site));
      const emitsAlias = entry.mustNotUse.filter((alias) =>
        sites.some((site) => asKey(alias).test(site)));
      return { action: entry.action, emitsKey, emitsAlias };
    });
    expect(findings).toEqual(
      protocolContract.criticalPayloadSpellings.map((entry) => ({
        action: entry.action,
        emitsKey: true,
        emitsAlias: [],
      })),
    );
  });

  test("retired actions are absent from the live typed and emitted contracts", () => {
    const actions = actionSamples.map((sample) => sample.action);
    for (const retired of protocolContract.retiredActions) {
      expect(actions.some((action) => action === retired)).toBe(false);
      expect(clientSources).not.toMatch(new RegExp(`action:\\s*["']${retired}["']`));
    }
  });

  test("the client still handles every message type it is contracted to handle", () => {
    const handled = new Set(
      [...clientSources.matchAll(/msg\.type === "([A-Za-z]+)"/g)].map((match) => match[1]!),
    );
    const expectedHandled = protocolContract.serverMessages
      .filter((entry) => entry.handledByClient)
      .map((entry) => entry.type);
    expect(expectedHandled.filter((type) => !handled.has(type))).toEqual([]);
  });

  test("every server message handled by the client is marked handled", () => {
    const handled = new Set(
      [...clientSources.matchAll(/msg\.type === "([A-Za-z]+)"/g)].map((match) => match[1]!),
    );
    const markedUnhandled = protocolContract.serverMessages
      .filter((entry) => handled.has(entry.type) && !entry.handledByClient)
      .map((entry) => entry.type);
    expect(markedUnhandled).toEqual([]);
  });

  test("review actions include meetingId in their payload contracts", () => {
    const reviewActions = ["startReview", "updateItem", "confirmReview"];
    for (const action of reviewActions) {
      const contract = protocolContract.clientActions.find((entry) => entry.action === action);
      expect(contract?.payloadKeys).toContain("meetingId");
    }
  });

  test("capture and transcript keys and optional values match typed wire shapes", () => {
    type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
    type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;
    const captureRequired = ["capturing", "mode"] as const;
    const captureOptional = ["phase", "modelPath", "selectedModelId", "startedAt", "audioSource"] as const;
    const transcriptRequired = ["entries"] as const;
    const transcriptOptional = ["reason", "truncated"] as const;
    const phases = ["idle", "starting", "capturing", "stopping", "switching-model"] as const;
    const reasons = ["snapshot", "export"] as const;
    expectTypeOf<(typeof captureRequired)[number]>().toEqualTypeOf<RequiredKeys<Omit<CaptureUpdate, "type">>>();
    expectTypeOf<(typeof captureOptional)[number]>().toEqualTypeOf<OptionalKeys<CaptureUpdate>>();
    expectTypeOf<(typeof transcriptRequired)[number]>().toEqualTypeOf<RequiredKeys<Omit<TranscriptUpdate, "type">>>();
    expectTypeOf<(typeof transcriptOptional)[number]>().toEqualTypeOf<OptionalKeys<TranscriptUpdate>>();
    expectTypeOf<(typeof phases)[number]>().toEqualTypeOf<CapturePhase>();
    expectTypeOf<(typeof reasons)[number]>().toEqualTypeOf<NonNullable<TranscriptUpdate["reason"]>>();
    expect(protocolContract.captureMessage.requiredKeys).toEqual([...captureRequired]);
    expect(protocolContract.captureMessage.optionalKeys).toEqual([...captureOptional]);
    expect(protocolContract.captureMessage.phases).toEqual([...phases]);
    expect(protocolContract.transcriptMessage.requiredKeys).toEqual([...transcriptRequired]);
    expect(protocolContract.transcriptMessage.optionalKeys).toEqual([...transcriptOptional]);
    expect(protocolContract.transcriptMessage.reasons).toEqual([...reasons]);
    for (const phase of phases) expect(parseServerEvent({ ...messageSamples.capture, phase }).ok).toBe(true);
    for (const reason of reasons) expect(parseTranscriptEvent({ ...messageSamples.transcript, reason }).ok).toBe(true);
  });

  test("the imported application registry owns all 33 contracted actions and no retired action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "public-contract-registry-"));
    console.log(`contract registry fixture: ${directory}`);
    let running: ReturnType<typeof startMeetingServer> | undefined;
    try {
      running = startMeetingServer({ ...process.env, LLM_PROVIDER: "cli", LLM_CLI_BIN: "/usr/bin/false",
        LLM_CLI_PRESET: "claude", MEETINGS_DB_PATH: join(directory, "meetings.db"), MEETING_SLIDES_SETTINGS_ROOT: directory });
      const actions = [...running.handlerMap.keys()].sort();
      expect(actions).toEqual(protocolContract.serverHandlerMapActions);
      expect(actions).toEqual(protocolContract.clientActions.map((entry) => entry.action).sort());
      expect(actions).toHaveLength(33);
      for (const action of actions) expect(typeof running.handlerMap.get(action)).toBe("function");
      for (const action of protocolContract.retiredActions) expect(running.handlerMap.has(action)).toBe(false);
    } finally {
      try { await running?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
