import { expect, test } from "bun:test";
import { join } from "node:path";

import { resolvePublicFile } from "../src/public-path.ts";

const publicDir = join("/srv", "public");

test("resolves root aliases and nested assets inside public", () => {
  expect(resolvePublicFile(publicDir, "/index.html")).toBe(join(publicDir, "index.html"));
  expect(resolvePublicFile(publicDir, "/fonts/roboto.woff2")).toBe(join(publicDir, "fonts", "roboto.woff2"));
});

test("refuses traversal that escapes public", () => {
  expect(resolvePublicFile(publicDir, "/../package.json")).toBeNull();
  expect(resolvePublicFile(publicDir, "/%2e%2e/package.json")).toBeNull();
  expect(resolvePublicFile(publicDir, "/%2E%2E%2Fserver.ts")).toBeNull();
  expect(resolvePublicFile(publicDir, "..%2Fserver.ts")).toBeNull();
});

test("decodes percent-encoding before resolving, but rejects NUL and bad escapes", () => {
  expect(resolvePublicFile(publicDir, "/font%20files/a.css")).toBe(join(publicDir, "font files", "a.css"));
  expect(resolvePublicFile(publicDir, "/a%00b.html")).toBe(join(publicDir, "ab.html"));
  expect(resolvePublicFile(publicDir, "/%zz")).toBeNull();
});
