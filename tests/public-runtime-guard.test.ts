import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "public", "index.html");

describe("operator runtime bootstrap", () => {
  test("health signature and static shell assets are present", async () => {
    const html = await readFile(INDEX_PATH, "utf8");
    expect(html).toContain("<title>Meeting Slides");
    expect(html).toContain("runtime-bootstrap");
    expect(html).toContain('href="/style.css"');
    expect(html).toContain('href="/workspace-shell.css"');
    expect(html).toContain('src="/workspace-split.js"');
    expect(html).toContain('src="/transcript-resize.js"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('id="btn-record"');
  });

  test("bootstrap sets file/server runtime flag", async () => {
    const html = await readFile(INDEX_PATH, "utf8");
    const match = html.match(/<script id="runtime-bootstrap">([\s\S]*?)<\/script>/);
    expect(match?.[1]).toBeTruthy();
    const source = match![1];
    for (const [protocol, expected] of [["file:", "file"], ["http:", "server"]] as const) {
      const dataset: Record<string, string> = {};
      const bootstrap = new Function("location", "document", source);
      bootstrap({ protocol }, { documentElement: { dataset } });
      expect(dataset.runtime).toBe(expected);
    }
  });
});
