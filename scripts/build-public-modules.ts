#!/usr/bin/env bun
// Builds the browser-consumable ESM artifacts for the canonical client reducers.
//
// Why this exists: `public/ui-state-machine.ts` and `public/transcript-state.ts`
// are the single source of truth for UI and transcript state, but the server
// (server.ts MIME map) serves an unknown extension as `application/octet-stream`
// with `x-content-type-options: nosniff`. A browser therefore REFUSES to execute
// a `.ts` module. Rather than weaken the server's MIME policy or fork the
// reducers into hand-written JS, this script transpiles each reducer into
// `public/generated/<name>.js`, which the MIME map already serves as
// `application/javascript; charset=utf-8`.
//
// Determinism: the transpile is type-erasure only (no minify, no bundling of
// external deps, no hashed names, no timestamps), so building twice from the
// same sources yields byte-identical output. `tests/public-caret-library.test.ts`
// rebuilds into a temporary directory and fails on any drift between the
// committed artifact and a fresh build, so a stale artifact can never ship.
//
// Usage:
//   bun run scripts/build-public-modules.ts          # write artifacts
//   bun run scripts/build-public-modules.ts --check   # verify, never write
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Reducer sources that the browser shell imports at runtime. */
export const PUBLIC_MODULE_SOURCES = ["ui-state-machine.ts", "transcript-state.ts", "protocol-values.ts"] as const;

/** Directory (relative to public/) that holds every generated artifact. */
export const GENERATED_DIR = "generated";

export interface BuiltModule {
  /** Source file relative to public/, e.g. "ui-state-machine.ts". */
  readonly source: string;
  /** Output file relative to public/, e.g. "generated/ui-state-machine.js". */
  readonly output: string;
  readonly code: string;
  readonly sourceSha256: string;
  readonly outputSha256: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Banner stamped into every artifact. It names the generator and the exact
 * source so a reader who opens the artifact first is told not to edit it.
 * It carries no timestamp: a timestamp would break byte-level reproducibility.
 */
function banner(source: string): string {
  return [
    "// GENERATED FILE - DO NOT EDIT.",
    `// Source: public/${source}`,
    "// Generator: scripts/build-public-modules.ts",
    "// Rebuild: bun run scripts/build-public-modules.ts",
    "",
  ].join("\n");
}

/**
 * Transpiles one reducer to browser ESM. Uses Bun's transpiler directly rather
 * than `Bun.build`, so the output is pure type erasure of a single file: no
 * module wrapper, no dependency inlining, no name mangling.
 */
export async function buildPublicModule(publicDir: string, source: string): Promise<BuiltModule> {
  const sourcePath = join(publicDir, source);
  const sourceText = await readFile(sourcePath, "utf8");
  const transpiler = new Bun.Transpiler({
    loader: "ts",
    target: "browser",
    // Keep the emitted module ESM and side-effect free; the reducers export only
    // pure functions, types and frozen constants.
    trimUnusedImports: false,
  });
  const transpiled = await transpiler.transform(sourceText);
  const code = `${banner(source)}${transpiled.trimStart()}`;
  const output = `${GENERATED_DIR}/${source.replace(/\.ts$/, ".js")}`;
  return {
    source,
    output,
    code,
    sourceSha256: sha256(sourceText),
    outputSha256: sha256(code),
  };
}

/** Builds every reducer artifact in declared order. Pure: writes nothing. */
export async function buildPublicModules(publicDir: string): Promise<BuiltModule[]> {
  const built: BuiltModule[] = [];
  for (const source of PUBLIC_MODULE_SOURCES) {
    built.push(await buildPublicModule(publicDir, source));
  }
  return built;
}

export interface DriftReport {
  readonly output: string;
  /** "ok" | "missing" | "stale" */
  readonly status: "ok" | "missing" | "stale";
  readonly expectedSha256: string;
  readonly actualSha256: string | null;
}

/** Compares committed artifacts against a fresh build without writing. */
export async function checkPublicModules(publicDir: string): Promise<DriftReport[]> {
  const built = await buildPublicModules(publicDir);
  const reports: DriftReport[] = [];
  for (const module of built) {
    const onDisk = await readFile(join(publicDir, module.output), "utf8").catch(() => null);
    reports.push({
      output: module.output,
      status: onDisk === null ? "missing" : onDisk === module.code ? "ok" : "stale",
      expectedSha256: module.outputSha256,
      actualSha256: onDisk === null ? null : sha256(onDisk),
    });
  }
  return reports;
}

/** Writes every artifact plus a manifest recording source/output hashes. */
export async function writePublicModules(publicDir: string): Promise<BuiltModule[]> {
  const built = await buildPublicModules(publicDir);
  for (const module of built) {
    const target = join(publicDir, module.output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, module.code, "utf8");
  }
  const manifest = {
    $comment:
      "Generated by scripts/build-public-modules.ts. Records which reducer source produced which browser artifact. Verified by tests/public-caret-library.test.ts.",
    generator: "scripts/build-public-modules.ts",
    modules: built.map((module) => ({
      source: `public/${module.source}`,
      output: `public/${module.output}`,
      sourceSha256: module.sourceSha256,
      outputSha256: module.outputSha256,
    })),
  };
  await writeFile(
    join(publicDir, GENERATED_DIR, "module-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return built;
}

if (import.meta.main) {
  const publicDir = join(import.meta.dir, "..", "public");
  if (process.argv.includes("--check")) {
    const reports = await checkPublicModules(publicDir);
    for (const report of reports) {
      console.log(`${report.status.padEnd(7)} public/${report.output}`);
    }
    const drifted = reports.filter((report) => report.status !== "ok");
    if (drifted.length > 0) {
      console.error(
        `\n${drifted.length} generated artifact(s) out of date. Run: bun run scripts/build-public-modules.ts`,
      );
      process.exit(1);
    }
    console.log("\nAll generated artifacts match their sources.");
  } else {
    const built = await writePublicModules(publicDir);
    for (const module of built) {
      console.log(`public/${module.source} -> public/${module.output} (${module.outputSha256.slice(0, 12)})`);
    }
  }
}
