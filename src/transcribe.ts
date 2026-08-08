// ============================================================
// transcribe.ts - transcribe.cpp 백엔드 (Bun 네이티브 바인딩, Metal)
// ============================================================
// Nemotron 3.5 / Qwen3-ASR 등 transcribe.cpp 패밀리 GGUF 모델을
// transcribe-cpp npm 바인딩으로 직접 실행한다.
// 오디오 입력은 ffmpeg(avfoundation: 마이크, 파일 디코드: 파일)에서
// 16kHz mono float32 PCM으로 받아 세션에 공급한다.

import { spawn, type ChildProcess } from "node:child_process";

import { TranscribeModel, type Stream, type Session, type Backend } from "transcribe-cpp";

import type { TranscriptChunk, WhisperOptions } from "./whisper.js";
import type { WhisperConfig } from "./config.js";

export interface TranscribeConfig {
  modelPath: string;
  captureId: number;
  threads: number;
  gpu: boolean;
  ffmpegBin: string;
}

const modelCache = new Map<string, Promise<TranscribeModel>>();

function loadModel(modelPath: string, gpu: boolean): Promise<TranscribeModel> {
  const key = `${modelPath}:${gpu ? "gpu" : "cpu"}`;
  let cached = modelCache.get(key);
  if (!cached) {
    const backend: Backend = gpu ? "auto" : "cpu";
    cached = TranscribeModel.load(modelPath, { backend });
    cached.catch(() => modelCache.delete(key));
    modelCache.set(key, cached);
  }
  return cached;
}

function koreanLocale(languages: readonly string[]): string | undefined {
  return languages.find((lang) => lang.toLowerCase().startsWith("ko"));
}

function pcmArgs(config: TranscribeConfig, filePath: string | null): string[] {
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  const input = filePath !== null
    ? ["-i", filePath]
    : ["-f", "avfoundation", "-i", config.captureId < 0 ? ":default" : `:${config.captureId}`];
  return [...base, ...input, "-ar", "16000", "-ac", "1", "-acodec", "pcm_f32le", "-f", "f32le", "pipe:1"];
}

class PcmReader {
  private carry = Buffer.alloc(0);
  private readonly queue: Float32Array[] = [];
  private waiter: ((chunk: Float32Array | null) => void) | null = null;
  private done = false;

  constructor(private readonly proc: ChildProcess, onError: (err: Error) => void) {
    proc.stdout?.on("data", (data: Buffer) => {
      this.push(data);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString("utf-8").trim();
      if (line) onError(new Error(`[ffmpeg] ${line.slice(0, 300)}`));
    });
    proc.on("close", () => this.finish());
    proc.on("error", () => this.finish());
  }

  private push(data: Buffer): void {
    this.carry = Buffer.concat([this.carry, data]);
    // 0.5초 단위(8000샘플)로 나눠 세션에 공급
    const chunkBytes = 8000 * Float32Array.BYTES_PER_ELEMENT;
    while (this.carry.byteLength >= chunkBytes) {
      const slice = this.carry.subarray(0, chunkBytes);
      this.carry = this.carry.subarray(chunkBytes);
      this.enqueue(new Float32Array(slice.buffer, slice.byteOffset, 8000));
    }
  }

  private finish(): void {
    // 잔여 바이트는 4바이트 정렬까지만 사용 (f32 정수 배수)
    const aligned = this.carry.byteLength - (this.carry.byteLength % Float32Array.BYTES_PER_ELEMENT);
    if (aligned > 0) {
      const slice = this.carry.subarray(0, aligned);
      this.enqueue(new Float32Array(slice.buffer, slice.byteOffset, aligned / Float32Array.BYTES_PER_ELEMENT));
    }
    this.done = true;
    this.waiter?.(null);
  }

  private enqueue(chunk: Float32Array): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(chunk);
      return;
    }
    this.queue.push(chunk);
  }

  next(): Promise<Float32Array | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

abstract class TranscribeBase {
  protected proc: ChildProcess | null = null;
  protected session: Session | null = null;
  protected stream: Stream | null = null;

  constructor(protected config: TranscribeConfig) {}

  abstract start(opts: WhisperOptions): Promise<void>;

  async stop(): Promise<void> {
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()));
      await Promise.race([exited, Bun.sleep(1000)]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await exited;
      }
    }
    this.stream?.reset();
    this.stream = null;
    this.session?.dispose();
    this.session = null;
  }

  protected emitSentences(text: string, onChunk: (c: TranscriptChunk) => void): void {
    // 한국어/영어 문장 부호 기준 최소 분할 (whisper.ts 어셈블러와 동일 계열)
    for (const piece of text.split(/(?<=[.?!다요죠음임까]|는데)\s+/)) {
      const sentence = piece.trim();
      if (!sentence) continue;
      onChunk({ text: sentence, ts: Date.now() });
    }
  }
}

// ============================================================
// TranscribeStream - 라이브 마이크 입력 (ffmpeg PCM → stream)
// ============================================================

export class TranscribeStream extends TranscribeBase {
  async start(opts: WhisperOptions): Promise<void> {
    const model = await loadModel(this.config.modelPath, this.config.gpu);
    const language = koreanLocale(model.capabilities.languages);
    if (!model.capabilities.supportsStreaming) {
      throw new Error(`모델이 스트리밍을 지원하지 않습니다: ${model.variant}`);
    }
    opts.onStatus?.(
      `transcribe.cpp 시작: ${model.variant} (backend=${model.backend}, lang=${language ?? "auto"})`,
    );
    this.session = model.createSession({ nThreads: this.config.threads });
    this.stream = await this.session.stream({
      commitPolicy: "stable_prefix",
      ...(language ? { language } : {}),
      timestamps: "segment",
    });

    const args = pcmArgs(this.config, null);
    this.proc = spawn(this.config.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const reader = new PcmReader(this.proc, (err) => opts.onError?.(err));
    this.proc.on("error", (err) => opts.onError?.(err));

    let committed = "";
    try {
      for (;;) {
        const chunk = await reader.next();
        if (chunk === null) break;
        const update = await this.stream.feed(chunk);
        if (update.committedChanged) {
          const text = this.stream.text.committed;
          const delta = text.slice(committed.length);
          committed = text;
          this.emitSentences(delta, opts.onChunk);
        }
      }
      const final = await this.stream.finalize();
      if (final.committedChanged || this.stream.text.tentative) {
        const text = this.stream.text.committed + this.stream.text.tentative;
        const delta = text.slice(committed.length);
        this.emitSentences(delta, opts.onChunk);
      }
    } finally {
      await this.stop();
    }
  }
}

// ============================================================
// TranscribeCLI - 파일 입력 모드 (ffmpeg 디코드 → batch)
// ============================================================

export class TranscribeCLI extends TranscribeBase {
  constructor(config: TranscribeConfig, private filePath: string) {
    super(config);
  }

  async start(opts: WhisperOptions): Promise<void> {
    const model = await loadModel(this.config.modelPath, this.config.gpu);
    const language = koreanLocale(model.capabilities.languages);
    opts.onStatus?.(`transcribe.cpp 파일 전사 (파일: ${this.filePath}, backend=${model.backend})`);

    const args = pcmArgs(this.config, this.filePath);
    this.proc = spawn(this.config.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const reader = new PcmReader(this.proc, (err) => opts.onError?.(err));
    this.proc.on("error", (err) => opts.onError?.(err));

    const parts: Float32Array[] = [];
    for (;;) {
      const chunk = await reader.next();
      if (chunk === null) break;
      parts.push(chunk);
    }
    if (parts.length === 0) throw new Error("디코드된 오디오가 없습니다");
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      pcm.set(part, offset);
      offset += part.length;
    }

    this.session = model.createSession({ nThreads: this.config.threads });
    const result = await this.session.run(pcm, {
      ...(language ? { language } : {}),
      timestamps: "segment",
    });
    for (const segment of result.segments) {
      const text = segment.text.trim();
      if (!text) continue;
      opts.onChunk({ text, ts: Date.now() });
    }
    if (result.segments.length === 0 && result.text.trim()) {
      opts.onChunk({ text: result.text.trim(), ts: Date.now() });
    }
  }
}
