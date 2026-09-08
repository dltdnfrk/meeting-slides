import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundleFileSha256, hasBundleSignature, isSafeBundlePath, matchesBundleFile, readBundleFile } from "../src/bundle-integrity.ts";

describe("archival bundle file integrity primitives", () => {
  test.each(["", "/absolute", "../outside", "a/../b", "./a", "a/./b", "a//b", "a/", "a\\b"])(
    "rejects unsafe relative path %j", (path) => {
      expect(isSafeBundlePath(path)).toBe(false);
    },
  );

  test.each(["minutes.pdf", "deck/slides/slide-1.html", "a..b", "\ud55c\uae00.json"])(
    "accepts historical relative path %j", (path) => {
      expect(isSafeBundlePath(path)).toBe(true);
    },
  );

  test("matches exact UTF-8 bytes and both persisted size fields, including subarray views", () => {
    const bytes = Buffer.from("x\ud55c\uae00\ny").subarray(1, -1);
    const entry = { sha256: bundleFileSha256(bytes), byte_size: 7, byte_length: 7 };

    const matches = matchesBundleFile(bytes, entry);

    expect(matches).toBe(true);
    expect(matchesBundleFile(bytes, { ...entry, byte_size: 6 })).toBe(false);
    expect(matchesBundleFile(bytes, { ...entry, byte_length: 6 })).toBe(false);
    expect(matchesBundleFile(bytes, { ...entry, sha256: "0".repeat(64) })).toBe(false);
    expect(matchesBundleFile(bytes, { ...entry, sha256: entry.sha256.toUpperCase() })).toBe(false);
    expect(matchesBundleFile(Buffer.from("changed"), entry)).toBe(false);
  });

  test("hashes and accepts the empty file without adding a newline", () => {
    const bytes = new Uint8Array();
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    expect(bundleFileSha256(bytes)).toBe(emptyHash);
    expect(matchesBundleFile(bytes, { sha256: emptyHash, byte_size: 0, byte_length: 0 })).toBe(true);
  });

  test.each(["pdf", "docx"] as const)("checks only the complete leading %s signature", (kind) => {
    const signature = Buffer.from(kind === "pdf" ? "%PDF-" : "PK\x03\x04");

    expect(hasBundleSignature(signature, kind)).toBe(true);
    expect(hasBundleSignature(Buffer.concat([signature, Buffer.from("payload")]), kind)).toBe(true);
    expect(hasBundleSignature(signature.subarray(0, -1), kind)).toBe(false);
    expect(hasBundleSignature(Buffer.concat([Buffer.from("x"), signature]), kind)).toBe(false);
    expect(hasBundleSignature(new Uint8Array(), kind)).toBe(false);
  });

  test("reads nested file bytes and propagates filesystem errors for caller-specific mapping", async () => {
    const root = import.meta.dir;
    const bytes = readFileSync(join(root, "fixtures", "public-protocol-contract.json"));

    const actual = await readBundleFile(root, "fixtures/public-protocol-contract.json");

    expect(actual).toEqual(bytes);
    await expect(readBundleFile(root, "missing.bin")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
