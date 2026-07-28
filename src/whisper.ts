// ============================================================
// whisper.ts - whisper-stream(마이크) / whisper-cli(파일) + stdout 파서
// ============================================================
// whisper-stream은 터미널 제어 문자(\r, ANSI \x1b[2K 등)와 함께 실시간 전사를 stdout에 출력.
// whisper-cli는 파일을 전사하고 stdout에 타임스탬프 라인을 출력.
// 두 포맷 모두 같은 TranscriptChunk 스트림으로 변환.

import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { WhisperConfig } from "./config.js";

// 디버그: WHISPER_RAW_LOG 경로가 있으면 whisper의 원시 출력을 전부 기록한다.
// (서버 필터를 통과하지 못하는 SDL/장치 에러를 잡기 위함)
function rawLog(data: string): void {
  const path = process.env.WHISPER_RAW_LOG;
  if (path) {
    try {
      appendFileSync(path, data);
    } catch {
      // 로그 실패는 무시
    }
  }
}

function rawLogReset(): void {
  const path = process.env.WHISPER_RAW_LOG;
  if (path) {
    try {
      writeFileSync(path, "");
    } catch {
      // 로그 실패는 무시
    }
  }
}

export interface TranscriptChunk {
  text: string;
  ts: number;
  speaker?: number;  // tinydiarize 활성 시 1부터 시작하는 발화(턴) 번호
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

/**
 * 라인에 붙은 [SPEAKER_TURN] 마커를 분리한다. tinydiarize가 화자 전환 지점에
 * 찍는 마커로, 이 마커가 나오면 "다음 발화부터" 화자가 바뀐다는 뜻이다.
 * 주의: tinydiar는 화자 '식별'이 아니라 '전환 감지'라 번호가 드리프트할 수 있다.
 */
export function extractSpeakerTurn(line: string): { text: string; turn: boolean } {
  const turn = line.includes("[SPEAKER_TURN]");
  return { text: turn ? line.replace("[SPEAKER_TURN]", "").trim() : line, turn };
}

// 미완결 조각을 이 길이까지 모으면 강제 방출 (실시간성 하한)
export const ASSEMBLER_MAX_HOLD_CHARS = 60;

/**
 * 한국어 STT는 문장부호가 자주 빠진다. 구두점 없이 잘린 조각을 그대로 문장으로
 * 방출하면 "그래서 저는" / "가보겠습니다"처럼 반쪽 문장이 LLM 컨텍스트와
 * 전사본에 쌓인다. 이 조립기는 미완결 조각을 보류해 다음 조각과 병합하고,
 * 완결 구두점·화자 전환·길이 상한·종료 중 하나에서만 방출한다.
 */
export class SentenceAssembler {
  private pending = "";

  /**
   * 조각을 넣는다. 방출 가능한 문장 배열(0~1개)을 반환.
   * complete = 구두점으로 끝나는 등 완결 신호.
   */
  push(piece: string, complete: boolean): string[] {
    const merged = this.pending ? this.pending + piece : piece;
    if (!merged) return [];
    if (complete || merged.length >= ASSEMBLER_MAX_HOLD_CHARS) {
      this.pending = "";
      return [merged];
    }
    this.pending = merged;
    return [];
  }

  /** 종료·화자 전환 시 보류분 강제 방출 */
  flush(): string | null {
    const out = this.pending || null;
    this.pending = "";
    return out;
  }
}

/**
 * 반복 루프 환각 필터. whisper가 무음/노이즈에서 내는 전형적 패턴:
 * 같은 토큰이 4회 이상 연속 반복되는 문장 ("노시들대원 노시들대원 …")은
 * 실제 발화가 아니라 루프 환각이다. 실제 강조("그래서 그래서 그래서")는
 * 3회 이하가 대부분이라 4회부터 잡는다.
 */
export function isHallucinationLoop(sentence: string): boolean {
  const tokens = sentence.split(/\s+/).filter(Boolean);
  let run = 1;
  for (let i = 1; i < tokens.length; i++) {
    run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

abstract class WhisperBase {
  protected proc: ChildProcess | null = null;
  protected buf = "";
  protected sentenceEnd = /([.!?。？！])/;
  // 최근 방출한 문장 링버퍼 — whisper-stream 오디오 윈도우 겹침으로 인한
  // 반복 출력을 걸러낸다. (step=3s, length=5s → 2s 겹침)
  private recentSentences: string[] = [];
  // tinydiarize 발화(턴) 카운터 — [SPEAKER_TURN] 마커마다 증가
  private speakerTurn = 0;
  // 구두점 없이 잘린 조각 병합기 (문장 분할 품질)
  private assembler = new SentenceAssembler();

  constructor(protected config: WhisperConfig) {}

  abstract start(opts: WhisperOptions): Promise<void>;

  /** diarize 모드면 tdrz 모델로, 아니면 기본 모델로. */
  protected effectiveModelPath(): string {
    return this.config.diarize ? this.config.tdrzModelPath : this.config.modelPath;
  }

  /** diarize 모드 가드: tdrz 모델 파일이 없으면 다운로드 방법과 함께 실패. */
  protected assertDiarizeReady(): void {
    if (!this.config.diarize) return;
    if (!existsSync(this.config.tdrzModelPath)) {
      throw new Error(
        `tdrz 모델 없음: ${this.config.tdrzModelPath}\n` +
        "다운로드: curl -L -o models/ggml-small.en-tdrz.bin " +
        "https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin"
      );
    }
  }

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
      const rawText = tsMatch ? tsMatch[1].trim() : line;
      if (!rawText) continue;
      if (this.isMeta(rawText)) continue;

      const { text, turn } = extractSpeakerTurn(rawText);
      if (text) {
        // 문장 분할 → 미완결 조각은 조립기에 보류했다가 다음 조각과 병합
        const parts = text.split(this.sentenceEnd);
        for (let i = 0; i < parts.length; i += 2) {
          const frag = (parts[i] ?? "").trim();
          const sep = parts[i + 1] ?? "";
          const piece = (frag + sep).trim();
          if (!piece) continue;
          for (const sentence of this.assembler.push(piece, sep.length > 0)) {
            this.emitSentence(sentence, onChunk);
          }
        }
      }
      // [SPEAKER_TURN]은 "이 라인 이후"부터 화자가 바뀐다는 마커.
      // 보류 조각은 이전 화자의 것이므로 턴 증가 전에 방출한다.
      if (turn) {
        const rest = this.assembler.flush();
        if (rest) this.emitSentence(rest, onChunk);
        this.speakerTurn++;
      }
    }
  }

  private static readonly NEAR_DUP_THRESHOLD = 0.5;

  private emitSentence(sentence: string, onChunk: (c: TranscriptChunk) => void): void {
    if (!sentence || this.isMeta(sentence)) return;
    // 반복 루프 환각 차단 (노이즈/무음 구간의 토큰 연쇄 반복)
    if (isHallucinationLoop(sentence)) return;
    // 최근 3문장 내 완전 일치 또는 bigram 유사 시 중복으로 판단
    if (this.isDuplicate(sentence)) return;
    this.recentSentences.push(sentence);
    if (this.recentSentences.length > 3) this.recentSentences.shift();
    onChunk({
      text: sentence,
      ts: Date.now(),
      speaker: this.config.diarize ? this.speakerTurn + 1 : undefined,
    });
  }

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
      rawLog(data.toString("utf-8"));
      this.buf += data.toString("utf-8");
      this.drain(opts.onChunk);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const s = data.toString("utf-8");
      rawLog(s);
      // 장치/권한/바이너리 실패 포괄 — no audio device, permission denied 등.
      if (/error|fail|cannot|not found|no such|no audio|device|permission|denied|unavailable|no capture/i.test(s)) {
        opts.onStatus?.(`[whisper stderr] ${s.trim()}`);
      }
    });
    // spawn 실패(바이너리 없음/권한) 시 onError 호출 → start() Promise reject로 전파.
    proc.on("error", (err) => {
      opts.onError?.(err);
    });
  }

  protected waitForExit(proc: ChildProcess, opts: WhisperOptions, label: string, timeoutMs = 0): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    proc.on("close", (code) => {
      this.buf += "\n";
      this.drain(opts.onChunk);
      const rest = this.assembler.flush();
      if (rest) this.emitSentence(rest, opts.onChunk);
      opts.onStatus?.(`${label} 종료 (code=${code})`);
      finish();
    });
    proc.on("error", () => {
      // attachStdio에서 onError를 이미 호출했으므로 여기서는 회수만.
      opts.onStatus?.(`${label} spawn 실패 — 프로세스 회수`);
      finish();
    });
    if (timeoutMs > 0) {
      setTimeout(() => { if (!settled) { finish(); opts.onStatus?.(`${label} 타임아웃 (${timeoutMs}ms)`); } }, timeoutMs);
    }
    return promise;
  }
}

// ============================================================
// WhisperStream - 마이크 입력 (whisper-stream)
// ============================================================

export class WhisperStream extends WhisperBase {
  async start(opts: WhisperOptions): Promise<void> {
    this.assertDiarizeReady();
    rawLogReset();
    const args = [
      "-m", this.effectiveModelPath(),
      "-l", "ko",
      "-t", String(this.config.threads),
      "--step", String(this.config.stepMs),
      "--length", String(this.config.stepMs + 2000),
      "--keep", "200",
      "-c", String(this.config.captureId),
      "-fa",
      "-kc",
    ];
    if (this.config.diarize) {
      args.push("-tdrz");
      opts.onStatus?.("⚠️ tinydiarize 모델은 현재 영어 전용입니다 — 한국어 회의는 전사 품질이 크게 떨어집니다");
    }
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
    this.assertDiarizeReady();
    // -nt: 타임스탬프 포함, -l ko: 한국어, -m: 모델
    const args = [
      "-m", this.effectiveModelPath(),
      "-l", "ko",
      "-t", String(this.config.threads),
      "-nt",
      "-f", this.filePath,
    ];
    if (this.config.diarize) {
      args.push("-tdrz");
      opts.onStatus?.("⚠️ tinydiarize 모델은 현재 영어 전용입니다 — 한국어 회의는 전사 품질이 크게 떨어집니다");
    }
    opts.onStatus?.(`whisper-cli 시작 (파일: ${this.filePath})`);
    this.proc = spawn(this.config.cliBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.attachStdio(this.proc, opts);
    await this.waitForExit(this.proc, opts, "whisper-cli");
  }
}
