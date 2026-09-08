// ============================================================
// transcribe.ts - transcribe.cpp 백엔드 (Bun 네이티브 바인딩, Metal)
// ============================================================
// Nemotron 3.5 / Qwen3-ASR 등 transcribe.cpp 패밀리 GGUF 모델을
// transcribe-cpp npm 바인딩으로 직접 실행한다.
// 오디오 입력은 ffmpeg(avfoundation: 마이크, 파일 디코드: 파일)에서
// 16kHz mono float32 PCM으로 받아 세션에 공급한다.

import { spawn, type ChildProcess } from "node:child_process";

import { TranscribeModel, type Stream, type Session, type Backend } from "transcribe-cpp";

import {
  describeStoppedAudio,
  type AudioRetranscription,
  type StoppedAudioRecording,
} from "./audio-recorder.js";
import type { TranscriptChunk, WhisperOptions } from "./whisper.js";
import { PcmIngest, type PcmSource } from "./pcm-ingest.ts";
import type { WhisperConfig } from "./config.js";

export interface TranscribeConfig {
  modelPath: string;
  captureId: number;
  threads: number;
  gpu: boolean;
  ffmpegBin: string;
  audioOutputPath?: string;
  pcmSource?: PcmSource;
}

interface ModelCacheEntry {
  promise: Promise<TranscribeModel>;
  refs: number;
}

const modelCache = new Map<string, ModelCacheEntry>();
let preferredModelKey: string | null = null;

function evictUnusedModels(): void {
  for (const [key, entry] of modelCache) {
    if (key === preferredModelKey || entry.refs > 0) continue;
    modelCache.delete(key);
    void entry.promise.then((model) => model.dispose(), () => undefined);
  }
}

async function acquireModel(modelPath: string, gpu: boolean): Promise<{ model: TranscribeModel; release: () => void }> {
  const key = `${modelPath}:${gpu ? "gpu" : "cpu"}`;
  const previousPreferred = preferredModelKey;
  preferredModelKey = key;
  let entry = modelCache.get(key);
  if (!entry) {
    const backend: Backend = gpu ? "auto" : "cpu";
    entry = { promise: TranscribeModel.load(modelPath, { backend }), refs: 0 };
    modelCache.set(key, entry);
  }
  entry.refs += 1; // Reserve before awaiting so a concurrent model switch cannot dispose it.
  let model: TranscribeModel;
  try {
    model = await entry.promise;
  } catch (error) {
    entry.refs -= 1;
    if (modelCache.get(key) === entry) modelCache.delete(key);
    if (preferredModelKey === key) preferredModelKey = previousPreferred;
    evictUnusedModels();
    throw error;
  }
  evictUnusedModels();
  let released = false;
  return {
    model,
    release: () => {
      if (released) return;
      released = true;
      entry!.refs -= 1;
      evictUnusedModels();
    },
  };
}

export function disposeTranscribeModelCache(): void {
  preferredModelKey = null;
  evictUnusedModels();
}

function koreanLocale(languages: readonly string[]): string | undefined {
  return languages.find((lang) => lang.toLowerCase().startsWith("ko"));
}

export function transcribePcmArgs(config: TranscribeConfig, filePath: string | null): string[] {
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  const input = filePath !== null
    ? ["-i", filePath]
    : ["-f", "avfoundation", "-i", config.captureId < 0 ? ":default" : `:${config.captureId}`];
  if (filePath === null && config.audioOutputPath) {
    return [
      ...base,
      ...input,
      "-filter_complex", "[0:a]asplit=2[stt][archive]",
      "-map", "[stt]", "-ar", "16000", "-ac", "1", "-acodec", "pcm_f32le", "-f", "f32le", "pipe:1",
      "-map", "[archive]", "-ac", "1", "-acodec", "pcm_s16le", "-y", config.audioOutputPath,
    ];
  }
  return [...base, ...input, "-ar", "16000", "-ac", "1", "-acodec", "pcm_f32le", "-f", "f32le", "pipe:1"];
}

export const PCM_READER_HIGH_WATER_CHUNKS = 16;
export const PCM_READER_LOW_WATER_CHUNKS = 8;
const PCM_CHUNK_SAMPLES = 8_000;
const PCM_CHUNK_BYTES = PCM_CHUNK_SAMPLES * Float32Array.BYTES_PER_ELEMENT;

export class PcmReader {
  private carry = Buffer.alloc(0);
  private queue: Array<Float32Array | undefined> = [];
  private head = 0;
  private waiter: ((chunk: Float32Array | null) => void) | null = null;
  private done = false;
  private paused = false;

  constructor(private readonly proc: ChildProcess, onError: (err: Error) => void) {
    proc.stdout?.on("data", (data: Buffer) => this.push(data));
    proc.stdout?.once("end", () => this.finish());
    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString("utf-8").trim();
      if (line) onError(new Error(`[ffmpeg] ${line.slice(0, 300)}`));
    });
    if (!proc.stdout) proc.once("close", () => this.finish());
    proc.once("error", () => this.finish());
  }

  private unread(): number { return this.queue.length - this.head; }

  private samples(bytes: Buffer, count: number): Float32Array {
    const values = new Float32Array(count);
    Buffer.from(values.buffer).set(bytes.subarray(0, count * Float32Array.BYTES_PER_ELEMENT));
    return values;
  }

  private push(data: Buffer): void {
    if (this.done) return;
    this.carry = this.carry.length === 0 ? Buffer.from(data) : Buffer.concat([this.carry, data]);
    this.drainCarry();
  }

  private drainCarry(): void {
    while (this.carry.byteLength >= PCM_CHUNK_BYTES && this.unread() < PCM_READER_HIGH_WATER_CHUNKS) {
      const slice = this.carry.subarray(0, PCM_CHUNK_BYTES);
      this.carry = this.carry.subarray(PCM_CHUNK_BYTES);
      this.enqueue(this.samples(slice, PCM_CHUNK_SAMPLES));
    }
    if (!this.done && this.unread() >= PCM_READER_HIGH_WATER_CHUNKS && !this.paused) {
      this.proc.stdout?.pause();
      this.paused = true;
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    while (this.carry.byteLength >= PCM_CHUNK_BYTES) {
      this.enqueue(this.samples(this.carry, PCM_CHUNK_SAMPLES));
      this.carry = this.carry.subarray(PCM_CHUNK_BYTES);
    }
    const aligned = this.carry.byteLength - (this.carry.byteLength % Float32Array.BYTES_PER_ELEMENT);
    if (aligned > 0) this.enqueue(this.samples(this.carry, aligned / Float32Array.BYTES_PER_ELEMENT));
    this.carry = Buffer.alloc(0);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
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

  private resumeIfNeeded(): void {
    if (this.paused && this.unread() <= PCM_READER_LOW_WATER_CHUNKS) {
      this.paused = false;
      this.proc.stdout?.resume();
      this.drainCarry();
    }
  }

  next(): Promise<Float32Array | null> {
    if (this.unread() > 0) {
      const chunk = this.queue[this.head]!;
      this.queue[this.head] = undefined;
      this.head += 1;
      if (this.head >= 1_024 || this.head * 2 >= this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      this.resumeIfNeeded();
      return Promise.resolve(chunk);
    }
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}

abstract class TranscribeBase {
  protected proc: ChildProcess | null = null;
  protected session: Session | null = null;
  protected stream: Stream | null = null;

  constructor(protected config: TranscribeConfig) {}

  abstract start(opts: WhisperOptions): Promise<void>;

  async stop(): Promise<void> {
    if (this.config.pcmSource instanceof PcmIngest) this.config.pcmSource.finish();
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
    // 문장 종결 부호(.!?。？！)와 줄바꿈 경계에서만 분할한다. 한국어 어미(다/요/죠 등)로
    // 자르면 '감사합니다 여러분' 같은 문장이 반으로 갈라지므로 어미로는 분할하지 않는다.
    for (const piece of text.split(/(?<=[.!?。？！\n])/)) {
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
    const lease = await acquireModel(this.config.modelPath, this.config.gpu);
    const model = lease.model;
    try {
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

      const reader = this.config.pcmSource ?? (() => {
        const args = transcribePcmArgs(this.config, null);
        this.proc = spawn(this.config.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        const pcmReader = new PcmReader(this.proc, (err) => opts.onError?.(err));
        this.proc.on("error", (err) => opts.onError?.(err));
        return pcmReader;
      })();

      let committed = "";
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
      if (final.committedChanged) {
        const delta = this.stream.text.committed.slice(committed.length);
        this.emitSentences(delta, opts.onChunk);
      }
    } finally {
      await this.stop();
      lease.release();
    }
  }

  stoppedAudio(): StoppedAudioRecording {
    if (!this.config.audioOutputPath) throw new Error("transcribe audio saving is not configured");
    if (this.config.pcmSource instanceof PcmIngest) this.config.pcmSource.finalizeWav();
    return describeStoppedAudio(this.config.audioOutputPath);
  }

  async retranscribe(recording: StoppedAudioRecording): Promise<AudioRetranscription> {
    const lines: AudioRetranscription["lines"][number][] = [];
    const cli = new TranscribeCLI({ ...this.config, audioOutputPath: undefined }, recording.path);
    await cli.start({
      onChunk: (chunk) => {
        if (chunk.audioStartMs === undefined || chunk.audioEndMs === undefined) return;
        lines.push({
          capturedAtMs: null,
          audioStartMs: chunk.audioStartMs,
          audioEndMs: chunk.audioEndMs,
          speakerTurn: chunk.speaker ?? null,
          text: chunk.text,
        });
      },
    });
    return {
      engine: "transcribe.cpp",
      engineModel: this.config.modelPath,
      lines,
    };
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
    const lease = await acquireModel(this.config.modelPath, this.config.gpu);
    const model = lease.model;
    try {
      const language = koreanLocale(model.capabilities.languages);
      opts.onStatus?.(`transcribe.cpp 파일 전사 (파일: ${this.filePath}, backend=${model.backend})`);

      this.session = model.createSession({ nThreads: this.config.threads });
      const maxAudioMs = this.session.limits.effectiveMaxAudioMs;
      const maxSamples = maxAudioMs > 0 ? Math.floor(maxAudioMs * 16) : Infinity;
      const args = transcribePcmArgs(this.config, this.filePath);
      this.proc = spawn(this.config.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const reader = new PcmReader(this.proc, (err) => opts.onError?.(err));
      this.proc.on("error", (err) => opts.onError?.(err));

      const parts: Float32Array[] = [];
      let total = 0;
      for (;;) {
        const chunk = await reader.next();
        if (chunk === null) break;
        total += chunk.length;
        // Reject before retaining the overflowing chunk or allocating contiguous PCM.
        if (total > maxSamples) {
          throw new Error(`오디오가 모델 처리 한도를 초과합니다: ${Math.ceil(total / 16)}ms > ${maxAudioMs}ms`);
        }
        parts.push(chunk);
      }
      if (parts.length === 0) throw new Error("디코드된 오디오가 없습니다");
      const pcm = new Float32Array(total);
      let offset = 0;
      for (const part of parts) {
        pcm.set(part, offset);
        offset += part.length;
      }
      parts.length = 0;

      const durationMs = (pcm.length / 16_000) * 1_000;
      const result = await this.session.run(pcm, {
        ...(language ? { language } : {}),
        timestamps: "segment",
      });
      for (const segment of result.segments) {
        const text = segment.text.trim();
        if (!text) continue;
        opts.onChunk({
          text,
          ts: Date.now(),
          audioStartMs: segment.t0Ms,
          audioEndMs: segment.t1Ms,
        });
      }
      if (result.segments.length === 0 && result.text.trim()) {
        opts.onChunk({
          text: result.text.trim(),
          ts: Date.now(),
          audioStartMs: 0,
          audioEndMs: Math.round(durationMs),
        });
      }
    } finally {
      await this.stop();
      lease.release();
    }
  }
}
