import { expect, expectTypeOf, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerMessage } from "../src/protocol.ts";
import { KNOWN_MESSAGE_TYPES, isKnownMessageType, type KnownMessageType } from "../public/protocol-values.ts";
import { buildPublicModules, checkPublicModules } from "../scripts/build-public-modules.ts";

const root = join(import.meta.dir, "..");
const publicDir = join(root, "public");

test("the canonical browser list is exact, unique, immutable and rejects unknown discriminants", () => {
  expectTypeOf<KnownMessageType>().toEqualTypeOf<ServerMessage["type"]>();
  expect(new Set(KNOWN_MESSAGE_TYPES).size).toBe(KNOWN_MESSAGE_TYPES.length);
  expect(Object.isFrozen(KNOWN_MESSAGE_TYPES)).toBe(true);
  for (const type of KNOWN_MESSAGE_TYPES) expect(isKnownMessageType(type)).toBe(true);
  for (const type of ["", "Refine", "teleport", "constructor", "__proto__"]) {
    expect(isKnownMessageType(type)).toBe(false);
  }
});

test("all generated modules and manifest hashes match the official generator", async () => {
  const built = await buildPublicModules(publicDir);
  expect(built.map((module) => module.source)).toEqual([
    "ui-state-machine.ts", "transcript-state.ts", "protocol-values.ts",
  ]);
  expect((await checkPublicModules(publicDir)).map((report) => report.status)).toEqual(["ok", "ok", "ok"]);
  const manifest = JSON.parse(await readFile(join(publicDir, "generated/module-manifest.json"), "utf8"));
  expect(manifest.generator).toBe("scripts/build-public-modules.ts");
  expect(manifest.modules).toEqual(built.map((module) => ({
    source: `public/${module.source}`, output: `public/${module.output}`,
    sourceSha256: module.sourceSha256, outputSha256: module.outputSha256,
  })));
  const scan = new Bun.Transpiler({ loader: "js" });
  for (const module of built) {
    expect(scan.scan(module.code).imports.map((entry) => entry.path))
      .toEqual(module.source === "protocol-values.ts" ? [] : ["./protocol-values.js"]);
  }
});

test("shipped ESM imports without TypeScript resolution and ignores refine in both reducers", async () => {
  // Node with TS loading disabled cannot fall back to the sources the way Bun can.
  const script = `
    import { KNOWN_MESSAGE_TYPES } from './public/generated/protocol-values.js';
    import { initialUiState, parseServerEvent, reduce } from './public/generated/ui-state-machine.js';
    import { initialTranscriptState, parseTranscriptEvent, reduceTranscript } from './public/generated/transcript-state.js';
    const frame = { type: 'refine', requestId: 'refine-contract', slideId: 's1', path: 'title', before: 'BEFORE', after: 'AFTER', claimIds: [] };
    const ui = initialUiState();
    const transcript = initialTranscriptState();
    const a = parseServerEvent(frame), b = parseTranscriptEvent(frame);
    if (!a.ok || !b.ok) throw new Error('known frame rejected');
    console.log(JSON.stringify({ types: KNOWN_MESSAGE_TYPES,
      uiUnchanged: JSON.stringify(reduce(ui, a.event)) === JSON.stringify(ui),
      transcriptUnchanged: JSON.stringify(reduceTranscript(transcript, b.event)) === JSON.stringify(transcript),
      unknownRejected: !parseServerEvent({type: 'teleport'}).ok && !parseTranscriptEvent({type: 'teleport'}).ok }));
  `;
  const child = Bun.spawn(["node", "--no-experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ types: KNOWN_MESSAGE_TYPES,
    uiUnchanged: true, transcriptUnchanged: true, unknownRejected: true });
});
