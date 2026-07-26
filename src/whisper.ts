// ============================================================
// whisper.ts - whisper-stream(마이크) / whisper-cli(파일) + stdout 파서
// ============================================================
// whisper-stream은 터미널 제어 문자(\r, ANSI \x1b[2K 등)와 함께 실시간 전사를 stdout에 출력.
// whisper-cli는 파일을 전사하고 stdout에 타임스탬프 라인을 출력.
// 두 포맷 모두 같은 TranscriptChunk 스트림으로 변환.

import { spawn, type ChildProcess } from "child_process";
import type { WhisperConfig } from "./config.js";

export interface TranscriptChunk {
  text: string;
  ts: number;
}

export interface WhisperOptions {
  onChunk: (chunk: TranscriptChunk) => void;
  onStatus?: (status: string) => void;
  onError?: (err: Error) => void;
}

export interface CaptureDevice {
  id: number;
  name: string;
}

export function parseCaptureDevices(output: string): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/Capture device #(\d+): '(.+)'/);
    if (match) {
      devices.push({ id: Number(match[1]), name: match[2] });
    }
  }
  return devices;
}

export async function listCaptureDevices(config: WhisperConfig): Promise<CaptureDevice[]> {
  const proc = spawn(config.streamBin, [
    "-m", config.modelPath,
    "-l", "ko",
    "-c", "999",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout?.on("data", (data: Buffer) => {
    output += data.toString("utf-8");
  });
  proc.stderr?.on("data", (data: Buffer) => {
    output += data.toString("utf-8");
  });
  for (let waited = 0; waited < 6000 && !output.includes("Capture device #"); waited += 100) {
    await Bun.sleep(100);
  }
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await Bun.sleep(150);
  }
  return parseCaptureDevices(output);
}

// whisper 메타 마커 — 실제 발언 아님.
//   [Start speaking], [끝], [감사합니다], [blabber], [BLANK_AUDIO], (silence), (blank)
// bracket-only 짧은 라인은 whisper-stream idle hallucination인 경우가 많아 필터링.
const META_PATTERNS: readonly RegExp[] = [
  /^\[Start speaking\]$/,
  /^\[끝\]$/,
  /^\[감사합니다\]$/,
  /^\[blabber\]$/,
  /^\[BLANK_AUDIO\]$/,
  /^\(silence\)$/i,
  /^\(blank\)$/i,
  /^\[[^\]]{1,20}\]$/,
];

// whisper-cli/ggml 배너 라인
const BANNER_PATTERNS: readonly RegExp[] = [
  /^--/,
  /^ggml/,
  /^load_/i,
  /^whisper_/i,
  /^system_info/i,
  /^attestation/i,
  /^mel_/i,
  /^sample_/i,
  /^cmd_/i,
  /^main:/i,
  /^whisper-cli\b/i,
  /^Loading/i,
  /^Logiterb/i,
  /^0x[0-9a-f]+ +[0-9.]+ +[0-9.]+ +[0-9.]+/,
];

// ── 유사 문장 판정 (whisper 윈도우 겹침/리비전 중복 제거용) ──
// 예전 방식은 문자 "존재 여부"만 세어서, 어순이 완전히 다른 문장도
// "습니다" 같은 공통 어미 때문에 70% 겹침으로 오탐됐다.
// bigram Jaccard는 문자 2-gram의 순서 정보를 쓰므로 이 오탐이 없다.

function normalizeForSim(s: string): string {
  // 띄어쓰기·대소문자 차이는 전사 리비전에서 흔하므로 제거하고 비교.
  return s.toLowerCase().replace(/\s+/g, "");
}

function bigrams(s: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

/** bigram Jaccard 유사도 (0~1). 같은 전사 리비전은 대략 0.7+, 무관한 문장은 0.2 이하로 나온다. */
export function bigramSimilarity(a: string, b: string): number {
  const na = normalizeForSim(a);
  const nb = normalizeForSim(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const g of A) {
    if (B.has(g)) inter++;
  }
  return inter / (A.size + B.size - inter);
}

abstract class WhisperBase {
  protected proc: ChildProcess | null = null;
  protected buf = "";
  protected sentenceEnd = /([.!?。？！])/;
  // 최근 방출한 문장 링버퍼 — whisper-stream 오디오 윈도우 겹침으로 인한
  // 반복 출력을 걸러낸다. (step=3s, length=5s → 2s 겹침)
  private recentSentences: string[] = [];

  constructor(protected config: WhisperConfig) {}

  abstract start(opts: WhisperOptions): Promise<void>;

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    // 1초 안에 안 죽으면 SIGKILL로 확실히 회수 (마이크 장치 점유 고아 방지).
    await Promise.race([exited, Bun.sleep(1000)]);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await exited;
    }
  }

  private isMeta(line: string): boolean {
    for (const re of META_PATTERNS) {
      if (re.test(line)) return true;
    }
    return false;
  }

  private isBanner(line: string): boolean {
    for (const re of BANNER_PATTERNS) {
      if (re.test(line)) return true;
    }
    return false;
  }

  protected drain(onChunk: (c: TranscriptChunk) => void): void {
    // ANSI 시퀀스(\x1b[2K, \x1b[...m) + CR 제거 → 줄 분할
    const cleaned = this.buf
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\r/g, "\n");
    const lines = cleaned.split("\n");
    this.buf = lines.pop() ?? "";

    for (const raw of lines) {
      let line = raw.trim();
      // 중복 공백 제거
      line = line.replace(/\s+/g, " ").trim();
      if (!line) continue;
      if (this.isBanner(line)) continue;
      if (this.isMeta(line)) continue;

      // 타임스탬프 라인이면 텍스트만 추출:
      //   [00:00:00.000 --> 00:00:05.000]  안녕하세요
      //   00:00:00.000-->00:00:05.000  안녕하세요
      const tsMatch = line.match(/^\s*\[?\s*\d{2}:\d{2}:\d{2}[.\d]*\s*-->\s*\d{2}:\d{2}:\d{2}[.\d]*\s*\]?\s*(.+)$/);
      const text = tsMatch ? tsMatch[1].trim() : line;
      if (!text) continue;
      if (this.isMeta(text)) continue;

      // 문장 분할 + 중복 제거
      const parts = text.split(this.sentenceEnd);
      for (let i = 0; i < parts.length; i += 2) {
        const frag = (parts[i] ?? "").trim();
        const sep = parts[i + 1] ?? "";
        const sentence = (frag + sep).trim();
        if (!sentence || this.isMeta(sentence)) continue;
        // 최근 3문장 내 완전 일치 또는 70% 이상 겹치면 중복으로 판단
        if (this.isDuplicate(sentence)) continue;
        this.recentSentences.push(sentence);
        if (this.recentSentences.length > 3) this.recentSentences.shift();
        onChunk({ text: sentence, ts: Date.now() });
      }
    }
  }

  private static readonly NEAR_DUP_THRESHOLD = 0.5;

  private isDuplicate(sentence: string): boolean {
    for (const prev of this.recentSentences) {
      if (prev === sentence) return true;
      // 짧은 문장은 완전 일치만 체크
      if (sentence.length < 8) continue;
      // 한쪽이 다른 쪽의 prefix/suffix이면 중복 (리비전)
      if (prev.startsWith(sentence) || sentence.startsWith(prev)) return true;
      // bigram Jaccard로 어순까지 비교 — 같은 발화의 재전사/부분 수정을 잡는다
      const shorter = prev.length < sentence.length ? prev : sentence;
      if (shorter.length > 10 && bigramSimilarity(prev, sentence) >= WhisperBase.NEAR_DUP_THRESHOLD) return true;
    }
    return false;
  }

  protected attachStdio(proc: ChildProcess, opts: WhisperOptions): void {
    proc.stdout?.on("data", (data: Buffer) => {
      this.buf += data.toString("utf-8");
      this.drain(opts.onChunk);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const s = data.toString("utf-8");
      if (/error|fail|cannot|not found|no such/i.test(s)) {
        opts.onStatus?.(`[whisper stderr] ${s.trim()}`);
      }
    });
    proc.on("error", (err) => opts.onError?.(err));
  }

  protected waitForExit(proc: ChildProcess, opts: WhisperOptions, label: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    // "close"는 stdio 스트림이 모두 닫힌 후 fire — "exit"는 stdout 데이터가
    // 아직 도착 전일 수 있어 전사 출력을 잃을 수 있음.
    proc.on("close", (code) => {
      this.buf += "\n";
      this.drain(opts.onChunk);
      opts.onStatus?.(`${label} 종료 (code=${code})`);
      resolve();
    });
    return promise;
  }
}

// ============================================================
// WhisperStream - 마이크 입력 (whisper-stream)
// ============================================================

export class WhisperStream extends WhisperBase {
  async start(opts: WhisperOptions): Promise<void> {
    const args = [
      "-m", this.config.modelPath,
      "-l", "ko",
      "-t", String(this.config.threads),
      "--step", String(this.config.stepMs),
      "--length", String(this.config.stepMs + 2000),
      "--keep", "200",
      "-c", String(this.config.captureId),
      "-fa",
      "-kc",
    ];
    opts.onStatus?.(`whisper-stream 시작: ${this.config.streamBin} ${args.join(" ")}`);
    this.proc = spawn(this.config.streamBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.attachStdio(this.proc, opts);
    await this.waitForExit(this.proc, opts, "whisper-stream");
  }
}

// ============================================================
// WhisperCLI - 파일 입력 모드 (whisper-cli)
// ============================================================
// 오디오 파일을 whisper-cli로 전사 → stdout 타임스탬프 라인을 파싱.
// 마이크 없이 재현 가능한 데모/테스트용.

export class WhisperCLI extends WhisperBase {
  constructor(config: WhisperConfig, private filePath: string) {
    super(config);
  }

  async start(opts: WhisperOptions): Promise<void> {
    // -nt: 타임스탬프 포함, -l ko: 한국어, -m: 모델
    const args = [
      "-m", this.config.modelPath,
      "-l", "ko",
      "-t", String(this.config.threads),
      "-nt",
      "-f", this.filePath,
    ];
    opts.onStatus?.(`whisper-cli 시작 (파일: ${this.filePath})`);
    this.proc = spawn(this.config.cliBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.attachStdio(this.proc, opts);
    await this.waitForExit(this.proc, opts, "whisper-cli");
  }
}
