import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishPdfFile, validatePdfFile } from "../src/pdf-artifact.ts";

const validPdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog >>
endobj
${"% padding\n".repeat(8)}startxref
9
%%EOF
`, "ascii");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pdf-artifact-"));
  return { dir, temporary: join(dir, ".deck.tmp"), final: join(dir, "deck.pdf") };
}

describe("atomic PDF publication", () => {
  test("validates, hashes, and publishes a private regular file", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.temporary, validPdf);
      const receipt = publishPdfFile(paths.temporary, paths.final);
      expect(existsSync(paths.temporary)).toBe(false);
      expect(readFileSync(paths.final)).toEqual(validPdf);
      expect(receipt).toEqual({
        path: paths.final,
        byteLength: validPdf.length,
        sha256: createHash("sha256").update(validPdf).digest("hex"),
      });
      expect(lstatSync(paths.final).mode & 0o777).toBe(0o600);
    } finally { rmSync(paths.dir, { recursive: true, force: true }); }
  });

  test("rejects truncated, malformed, and symlink inputs without exposing a final file", () => {
    for (const content of [Buffer.from("%PDF-1.4\n"), Buffer.from(`${"x".repeat(80)}%%EOF`), Buffer.from(`%PDF-1.4\n${"x".repeat(80)}`)]) {
      const paths = fixture();
      try {
        writeFileSync(paths.temporary, content);
        expect(() => publishPdfFile(paths.temporary, paths.final)).toThrow();
        expect(existsSync(paths.temporary)).toBe(false);
        expect(existsSync(paths.final)).toBe(false);
      } finally { rmSync(paths.dir, { recursive: true, force: true }); }
    }
    const paths = fixture();
    try {
      const target = join(paths.dir, "target.pdf");
      writeFileSync(target, validPdf);
      symlinkSync(target, paths.temporary);
      expect(() => validatePdfFile(paths.temporary)).toThrow("regular file");
    } finally { rmSync(paths.dir, { recursive: true, force: true }); }
  });

  test("does not overwrite an existing final artifact", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.temporary, validPdf);
      writeFileSync(paths.final, "existing");
      expect(() => publishPdfFile(paths.temporary, paths.final)).toThrow();
      expect(readFileSync(paths.final, "utf8")).toBe("existing");
      expect(existsSync(paths.temporary)).toBe(false);
    } finally { rmSync(paths.dir, { recursive: true, force: true }); }
  });
});
