import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "public", "index.html");

type FakeNode = {
  href?: string;
  rel?: string;
  src?: string;
  type?: string;
};

async function loadRuntimeBootstrap(): Promise<string> {
  const html = await readFile(INDEX_PATH, "utf8");
  const match = html.match(/<script id="runtime-bootstrap">([\s\S]*?)<\/script>/);
  if (!match?.[1]) {
    throw new Error("runtime bootstrap script is missing");
  }
  return match[1];
}

function executeBootstrap(source: string, protocol: string) {
  const dataset: Record<string, string> = {};
  const headNodes: FakeNode[] = [];
  const bodyNodes: FakeNode[] = [];
  const readyListeners: Array<() => void> = [];
  const fakeDocument = {
    documentElement: { dataset },
    head: { append: (node: FakeNode) => headNodes.push(node) },
    body: { append: (node: FakeNode) => bodyNodes.push(node) },
    createElement: (_tagName: string): FakeNode => ({}),
  };
  const fakeWindow = {
    addEventListener: (_type: string, listener: () => void) => readyListeners.push(listener),
  };

  const bootstrap = new Function("location", "document", "window", source);
  bootstrap({ protocol }, fakeDocument, fakeWindow);

  return { dataset, headNodes, bodyNodes, readyListeners };
}

describe("operator runtime bootstrap", () => {
  test("Given a direct file URL, when the bootstrap runs, then server assets stay dormant", async () => {
    const source = await loadRuntimeBootstrap();

    const result = executeBootstrap(source, "file:");

    expect(result.dataset.runtime).toBe("file");
    expect(result.headNodes).toEqual([]);
    expect(result.readyListeners).toEqual([]);
    expect(result.bodyNodes).toEqual([]);
  });

  test("Given an HTTP URL, when the bootstrap runs, then the operator assets boot normally", async () => {
    const source = await loadRuntimeBootstrap();

    const result = executeBootstrap(source, "http:");
    for (const listener of result.readyListeners) listener();

    expect(result.dataset.runtime).toBe("server");
    expect(result.headNodes.map(({ href }) => href)).toEqual([
      "/style.css",
      "/workspace-shell.css",
    ]);
    expect(result.bodyNodes.map(({ src }) => src)).toEqual([
      "/workspace-split.js",
      "/transcript-resize.js",
      "/app.js",
    ]);
  });
});
