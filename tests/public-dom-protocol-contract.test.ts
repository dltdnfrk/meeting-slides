// Locks the machine-consumed DOM and wire-protocol surface of the shipped client.
// Parses the real public/index.html, public/*.js and src/session.ts — never a copy —
// so a duplicated binding ID, a moved #current-slide, a renamed payload key, or a
// removed server message type fails here before it reaches a browser test.
// Only machine-consumed names are asserted. No prose, copy, or CSS wording is pinned.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import domContract from "./fixtures/public-dom-contract.json" with { type: "json" };
import protocolContract from "./fixtures/public-protocol-contract.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

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

  test("shipped HTML loads every contract script exactly once", () => {
    // Matches any <script> that carries a src, whatever other attributes it
    // declares first (`type="module"`, `defer`, ...). Only the src identity and
    // its multiplicity are contracted; the loading mode is not.
    const loaded = [...html.matchAll(/<script\b[^>]*\ssrc="\/([^"]+)"/g)].map((match) => `public/${match[1]}`);
    for (const script of domContract.documents.scripts) {
      expect({ script, count: loaded.filter((entry) => entry === script).length })
        .toEqual({ script, count: 1 });
    }
  });

  test("scripts still resolve the binding ids they own", () => {
    const sources = new Map(
      domContract.documents.scripts.map((script) => [script, read(script)] as const),
    );
    const missing = idSpecs
      .filter((spec) => spec.owner.endsWith(".js"))
      .filter((spec) => !(sources.get(spec.owner) ?? "").includes(`"${spec.id}"`))
      .map((spec) => `${spec.owner} no longer references #${spec.id}`);
    expect(missing).toEqual([]);
  });
});

describe("compatibility data attributes and persisted layout keys", () => {
  const appJs = read("public/app.js");
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

  test("capture-state classes stay readable across shipped scripts", () => {
    const capturing = domContract.compatibilityAttributes.appClasses
      .find((entry) => entry.class === "app--capturing")!;
    expect(appJs).toContain(`classList.add("${capturing.class}")`);
    expect(appJs).toContain(`classList.remove("${capturing.class}")`);
    expect(operatorJs).toContain(`classList.contains("${capturing.class}")`);

    const recording = domContract.compatibilityAttributes.controlClasses
      .find((entry) => entry.class === "record-btn--on")!;
    expect(appJs).toContain(`classList.toggle("${recording.class}"`);
    expect(operatorJs).toContain(`classList.contains("${recording.class}")`);
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

describe("shipped wire protocol contract", () => {
  const clientSources = protocolContract.documents.clientScripts
    .map((script) => read(script))
    .join("\n");
  const sessionTypes = read(protocolContract.documents.serverTypes);
  const serverSource = read(protocolContract.documents.serverDispatch);

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
    const startCapture = protocolContract.clientActions
      .find((entry) => entry.action === "startCapture")!;
    expect(startCapture.payloadKeys).toEqual(["meeting_id"]);
    const appJs = read("public/app.js");
    const emitted = /\{\s*action:\s*"startCapture",\s*([A-Za-z_]+):/.exec(appJs)?.[1];
    expect(emitted).toBe("meeting_id");
    expect(sessionTypes).toContain('action: "startCapture"; meeting_id?: number');
    expect(serverSource).toContain("cmd.meeting_id");
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

  test("every server message type is declared in src/session.ts and in ServerMessage", () => {
    const declared = new Set(
      [...sessionTypes.matchAll(/^\s+type:\s*"([A-Za-z]+)";/gm)].map((match) => match[1]!),
    );
    const union = sessionTypes.slice(
      sessionTypes.indexOf("export type ServerMessage ="),
      sessionTypes.indexOf(";", sessionTypes.indexOf("export type ServerMessage =")),
    );
    const findings = protocolContract.serverMessages.map((entry) => ({
      type: entry.type,
      declared: declared.has(entry.type),
      inUnion: union.length > 0,
    }));
    expect(findings).toEqual(
      protocolContract.serverMessages.map((entry) => ({
        type: entry.type,
        declared: true,
        inUnion: true,
      })),
    );
  });

  test("the client still handles every message type it is contracted to handle", () => {
    const handled = new Set(
      [...read("public/app.js").matchAll(/msg\.type === "([A-Za-z]+)"/g)].map((match) => match[1]!),
    );
    const expectedHandled = protocolContract.serverMessages
      .filter((entry) => entry.handledByClient)
      .map((entry) => entry.type);
    expect(expectedHandled.filter((type) => !handled.has(type))).toEqual([]);
  });

  test("capture and transcript message shapes keep their key spellings", () => {
    const capture = protocolContract.captureMessage;
    const captureBlock = sessionTypes.slice(
      sessionTypes.indexOf("export interface CaptureUpdate"),
      sessionTypes.indexOf("}", sessionTypes.indexOf("export interface CaptureUpdate")),
    );
    expect(captureBlock.length).toBeGreaterThan(0);
    for (const key of capture.requiredKeys) expect(captureBlock).toContain(`${key}:`);
    for (const key of capture.optionalKeys) expect(captureBlock).toContain(`${key}?:`);
    expect(sessionTypes).toContain(
      `export type CapturePhase = ${capture.phases.map((phase) => `"${phase}"`).join(" | ")};`,
    );

    const transcript = protocolContract.transcriptMessage;
    const transcriptBlock = sessionTypes.slice(
      sessionTypes.indexOf("export interface TranscriptUpdate"),
      sessionTypes.indexOf("}", sessionTypes.indexOf("export interface TranscriptUpdate")),
    );
    for (const key of transcript.requiredKeys) expect(transcriptBlock).toContain(`${key}:`);
    for (const key of transcript.optionalKeys) expect(transcriptBlock).toContain(`${key}?:`);
    for (const reason of transcript.reasons) expect(transcriptBlock).toContain(`"${reason}"`);
  });

  test("the server handler map registers exactly the contracted actions", () => {
    const registry = serverSource.slice(
      serverSource.indexOf("export const handlerMap = new Map"),
      serverSource.indexOf("]);", serverSource.indexOf("export const handlerMap = new Map")),
    );
    const registered = [...registry.matchAll(/\["([A-Za-z]+)",/g)].map((match) => match[1]!);
    expect(registered).toEqual([...protocolContract.serverHandlerMapActions]);
  });

  test("actions not in the handler map still have an explicit dispatch branch", () => {
    const inMap = new Set(protocolContract.serverHandlerMapActions);
    const missing = protocolContract.clientActions
      .map((entry) => entry.action)
      .filter((action) => !inMap.has(action))
      .filter((action) => !serverSource.includes(`cmd.action === "${action}"`));
    expect(missing).toEqual([]);
  });
});
