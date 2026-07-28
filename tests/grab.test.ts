import { describe, expect, test } from "bun:test";

import { assertReviewedForProceed, buildPassAReport, buildPassBReport } from "../src/grab.ts";

const base = {
  slideFiles: [{ file: "slide-00.html", sha256: "abc123" }],
  previewFiles: ["slide-00.png"],
  slideCount: 1,
  maxBullets: 3,
  lineCount: 4,
};

describe("grab design-gate helpers", () => {
  test("reviewed=false면 proceed 리포트 생성 거부", () => {
    expect(() => assertReviewedForProceed({ ...base, reviewed: false })).toThrow(/실제 시각 리뷰/);
    expect(() => buildPassAReport({ ...base, reviewed: false })).toThrow(/실제 시각 리뷰/);
    expect(() => buildPassBReport({ ...base, reviewed: false })).toThrow(/실제 시각 리뷰/);
  });

  test("reviewed=true면 계약 문구를 포함한 마크다운 생성", () => {
    const a = buildPassAReport({ ...base, reviewed: true });
    const b = buildPassBReport({ ...base, reviewed: true });
    for (const report of [a, b]) {
      expect(report).toContain("VERDICT: PASS");
      expect(report).toContain("Unresolved Critical: 0");
      expect(report).toContain("Blocking findings: None");
      expect(report).toContain("slide-00.html: abc123");
      expect(report).toContain("slide-00.png");
      expect(report).toMatch(/\| Slide \| Finding \| Severity \| Fix \| Status \|/);
    }
    expect(a).toContain("Pass A System Contract / Constraint Integrity");
    expect(b).toContain("Pass B Audience Impact / Expressive Readability");
  });
});
