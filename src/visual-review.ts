// ============================================================
// visual-review.ts - design-gate용 실제 시각 리뷰 (독립 리뷰어)
// ============================================================
// slides-grab의 design 철학과 동일하게, proceed 영수증은 "리뷰어가 실제로
// 확인"한 뒤에만 발급한다. 자동화에서는 독립 비전 리뷰어가 렌더된 슬라이드
// PNG를 직접 보고 판정한다 — 리포트를 스스로 지어내지 않는다.
//   codex:  -i 플래그로 이미지 직접 첨부 (기본, 구독 쿼터 가용)
//   claude: 프롬프트 경로로 파일을 읽게 함 (폴백)

import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface VisualReviewVerdict {
  verdict: "proceed" | "revise";
  confidence: "High" | "Medium" | "Low";
  passAChecks: { name: string; pass: boolean; note: string }[];
  passBChecks: { name: string; pass: boolean; note: string }[];
  unresolvedCritical: number;
  blockingFindings: string[];
  summary: string;
}

const REVIEW_PROMPT = `당신은 슬라이드 덱의 독립 시각 리뷰어입니다 (제작자가 아닙니다).
첨부된 슬라이드 렌더 이미지를 보고, 두 관점으로 평가하세요.

Pass A (System Contract / Constraint Integrity):
- System consistency / Color discipline / AI slop tropes / Content discipline

Pass B (Audience Impact / Expressive Readability):
- Composition & hierarchy / Typography & legibility / Korean-CJK word-break integrity / Review Litmus

반드시 JSON만으로 응답하세요 (마크다운 코드펜스 없이):
{
  "verdict": "proceed" | "revise",
  "confidence": "High" | "Medium" | "Low",
  "passAChecks": [{"name": "...", "pass": true, "note": "..."}],
  "passBChecks": [{"name": "...", "pass": true, "note": "..."}],
  "unresolvedCritical": 0,
  "blockingFindings": ["..."],
  "summary": "한 줄 총평"
}

판정 규칙:
- Critical(읽기 불가/팔레트 위반/슬래프)이 하나라도 있으면 revise + blockingFindings에 기록
- 자세한 관찰 없는 추측성 통과는 금지 — 실제로 보이는 것만 쓸 것`;

export interface ReviewOptions {
  preset?: "codex" | "claude";
  model?: string;
  timeoutMs?: number;
  images?: string[];   // 리뷰할 PNG 절대 경로 (codex는 -i로 직접 첨부)
  slidesDir?: string;  // claude 경로 읽기용
  previewNames?: string[];
}

export function buildReviewPrompt(opts: ReviewOptions): string {
  if (opts.preset === "claude" && opts.slidesDir && opts.previewNames) {
    const paths = opts.previewNames
      .map((f) => `${opts.slidesDir}/.slides-grab/gate-preview/${f}`)
      .join("\n");
    return `${REVIEW_PROMPT}\n\n리뷰할 파일 (Read로 직접 확인):\n${paths}`;
  }
  return REVIEW_PROMPT;
}

function parseVerdict(stdout: string): VisualReviewVerdict {
  const raw = stdout.trim();
  const json = raw.includes("{") ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) : raw;
  const parsed = JSON.parse(json) as VisualReviewVerdict;
  if (parsed.verdict !== "proceed" && parsed.verdict !== "revise") {
    throw new Error(`리뷰 결과 verdict 이상: ${String(parsed.verdict)}`);
  }
  return parsed;
}

/** 독립 비전 리뷰 실행. 기본 codex(-i 이미지 첨부), 폴백 claude(경로 읽기). */
export function runVisualReview(prompt: string, opts: ReviewOptions = {}): Promise<VisualReviewVerdict> {
  const preset = opts.preset ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 180_000;

  let bin: string;
  let args: string[];
  let outFile: string | null = null;
  let tmpDir: string | null = null;

  if (preset === "codex") {
    bin = "codex";
    tmpDir = mkdtempSync(join(tmpdir(), "ms-review-"));
    outFile = join(tmpDir, "last.txt");
    args = ["exec", "--skip-git-repo-check"];
    if (opts.model) args.push("-m", opts.model);
    for (const img of opts.images ?? []) args.push("-i", img);
    args.push("-o", outFile, prompt);
  } else {
    bin = "claude";
    const settingsFile = join(tmpdir(), "meeting-slides-claude-settings.json");
    try {
      writeFileSync(settingsFile, "{}", "utf-8");
    } catch { /* 무시 */ }
    args = ["-p", prompt, "--output-format", "text"];
    if (existsSync(settingsFile)) args.push("--settings", settingsFile);
    if (opts.model) args.push("--model", opts.model);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    const cleanup = () => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      cleanup();
      reject(new Error(`시각 리뷰 타임아웃 (${timeoutMs}ms)`));
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf-8")).slice(-400); });
    proc.on("error", (err) => { clearTimeout(timer); cleanup(); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          reject(new Error(`리뷰어 종료 코드 ${code}: ${stderrTail.trim() || "(stderr 없음)"}`));
          return;
        }
        const text = outFile ? readFileSync(outFile, "utf-8") : stdout;
        resolve(parseVerdict(text));
      } catch (e) {
        reject(new Error(`리뷰 파싱 실패: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        cleanup();
      }
    });
  });
}
