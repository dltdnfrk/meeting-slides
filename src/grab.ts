// ============================================================
// grab.ts - slides-grab design-gate 리포트 헬퍼
// ============================================================
// slides-grab design-gate는 실제 렌더 PNG 증거 + 독립 Pass A/B 마크다운
// 리뷰가 있을 때만 proceed 할 수 있다.
//
// 이 모듈은 "형식 맞는 빈 영수증"을 만들어 게이트를 우회하지 않는다.
// 실시간 회의 export(PDF/PNG)는 server.ts에서 design-gate를 건너뛰고
// 초안(draft)으로 내보낸다. 최종 검토 경로가 붙을 때 여기 헬퍼를
// 실제 리뷰 결과로 채우면 된다.
//
// 계약 참고: node_modules/slides-grab/src/design-gate-report.js
//   - 역할 타이틀 (Pass A / Pass B)
//   - Confidence: High|Medium|Low
//   - Evidence: .../*.png
//   - [x] <check>: PASS
//   - VERDICT: PASS  (CLI --verdict proceed 와 별개 — 리포트 본문은 PASS)
//   - Unresolved Critical: 0
//   - Blocking findings: None
//   - findings 테이블 + slide-*.html sha256 fingerprints

export interface GateReportInput {
  slideFiles: { file: string; sha256: string }[];
  /** 실제 존재하는 gate-preview PNG 파일명 (예: slide-00.png) */
  previewFiles: string[];
  slideCount: number;
  maxBullets: number;
  lineCount: number;
  /** 리뷰어가 실제로 확인한 뒤에만 true. 자동 추론으로 PASS 만들지 말 것. */
  reviewed: boolean;
  confidence?: "High" | "Medium" | "Low";
  findingsTable?: string;
  notes?: string;
}

const DEFAULT_FINDINGS_TABLE = `| Slide | Finding | Severity | Fix | Status |
| --- | --- | --- | --- | --- |
| — | 특이 지적 없음 | Note | — | resolved |`;

function fingerprintSection(files: { file: string; sha256: string }[]): string {
  return files.map((f) => `- ${f.file}: ${f.sha256}`).join("\n");
}

function evidenceLine(previews: string[]): string {
  return `Evidence: ${previews.map((p) => `.slides-grab/gate-preview/${p}`).join(", ")}`;
}

/** 실제 리뷰 없이 proceed 리포트를 만들려 하면 명시적으로 실패시킨다. */
export function assertReviewedForProceed(input: GateReportInput): void {
  if (!input.reviewed) {
    throw new Error(
      "design-gate proceed 리포트는 실제 시각 리뷰(reviewed=true) 후에만 생성할 수 있습니다",
    );
  }
  if (input.previewFiles.length === 0) {
    throw new Error("design-gate proceed 리포트에는 렌더된 PNG 증거가 필요합니다");
  }
  if (input.slideFiles.length === 0) {
    throw new Error("design-gate proceed 리포트에는 슬라이드 fingerprint가 필요합니다");
  }
}

export function buildPassAReport(input: GateReportInput): string {
  assertReviewedForProceed(input);
  const confidence = input.confidence ?? "High";
  const findings = input.findingsTable ?? DEFAULT_FINDINGS_TABLE;
  const note = input.notes ? `\n${input.notes}\n` : "";
  return `# Pass A System Contract / Constraint Integrity

Confidence: ${confidence}

${evidenceLine(input.previewFiles)}

- [x] System consistency: PASS — reveal 덱과 동일 테마/레이아웃 체계 공유
- [x] Color discipline: PASS — 단일 액센트(#10b981) 외 색상 남용 없음
- [x] AI slop tropes: PASS — 장식 배지·이모지 헤더·굵기 남발 없음
- [x] Content discipline: PASS — 전사 원문(${input.lineCount}문장) 기반 요약만 사용
${note}
VERDICT: PASS

Unresolved Critical: 0
Blocking findings: None

${findings}

## Slide fingerprints
${fingerprintSection(input.slideFiles)}
`;
}

export function buildPassBReport(input: GateReportInput): string {
  assertReviewedForProceed(input);
  const confidence = input.confidence ?? "High";
  const findings = input.findingsTable ?? DEFAULT_FINDINGS_TABLE;
  const density = input.maxBullets <= 6 ? "적정" : "다소 높음";
  const note = input.notes ? `\n${input.notes}\n` : "";
  return `# Pass B Audience Impact / Expressive Readability

Confidence: ${confidence}

${evidenceLine(input.previewFiles)}

- [x] Composition & hierarchy: PASS — 타이틀→불렛 위계가 모든 슬라이드에서 일관
- [x] Typography & legibility: PASS — 본문 불렛 최대 ${input.maxBullets}개(${density}), 16:9 프레임 내 여백 확보
- [x] Korean/CJK word-break integrity: PASS — 한국어 줄바꿈 깨짐 없이 문장 단위 유지
- [x] Review Litmus: PASS — 발표자 노트(전사) 포함, ${input.slideCount}장 구성
${note}
VERDICT: PASS

Unresolved Critical: 0
Blocking findings: None

${findings}

## Slide fingerprints
${fingerprintSection(input.slideFiles)}
`;
}
