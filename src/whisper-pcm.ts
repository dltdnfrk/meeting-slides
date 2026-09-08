import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeStoppedAudio, type AudioRetranscription, type StoppedAudioRecording } from "./audio-recorder.ts";
import type { WhisperConfig } from "./config.ts";
import { PcmIngest, writeMonoWav, PCM_SAMPLE_RATE } from "./pcm-ingest.ts";
import { WhisperCLI, type WhisperOptions } from "./whisper.ts";

const WINDOW_SAMPLES = PCM_SAMPLE_RATE * 5;
const STEP_SAMPLES = PCM_SAMPLE_RATE * 3;
const MIN_SAMPLES = PCM_SAMPLE_RATE * 2;

export class WhisperPcmStream {
  private running = false;
  /**
   * Fixed-capacity window. A growing array re-copied the whole 5 s window on
   * every 0.5 s frame; this keeps appends proportional to the frame instead.
   */
  private readonly ring = new Float32Array(WINDOW_SAMPLES);
  private ringStart = 0;
  private ringLength = 0;
  /** Samples appended since the last window was handed to whisper.cpp. */
  private sinceWindow = 0;
  private transcribing: Promise<void> | null = null;

  constructor(
    private readonly config: WhisperConfig,
    private readonly ingest: PcmIngest,
    private readonly audio?: { outputPath: string; initialPrompt?: string },
  ) {}

  async start(opts: WhisperOptions): Promise<void> {
    this.running = true;
    opts.onStatus?.("컴퓨터 소리 전사 시작 (whisper.cpp PCM)");
    for (;;) {
      const chunk = await this.ingest.next();
      if (chunk === null) break;
      this.append(chunk);
      if (this.sinceWindow < STEP_SAMPLES || this.ringLength < MIN_SAMPLES) continue;
      if (this.transcribing) continue;
      this.sinceWindow = 0;
      const window = this.snapshot();
      this.transcribing = this.transcribeWindow(window, opts).finally(() => {
        this.transcribing = null;
      });
    }
    if (this.transcribing) await this.transcribing;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ingest.finish();
    if (this.transcribing) await this.transcribing;
  }

  stoppedAudio(): StoppedAudioRecording {
    if (!this.audio) throw new Error("whisper PCM audio saving is not configured");
    this.ingest.finalizeWav();
    return describeStoppedAudio(this.audio.outputPath);
  }

  async retranscribe(recording: StoppedAudioRecording): Promise<AudioRetranscription> {
    const lines: AudioRetranscription["lines"][number][] = [];
    const cli = new WhisperCLI(this.config, recording.path);
    await cli.start({
      initialPrompt: this.audio?.initialPrompt,
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
      engine: "whisper.cpp",
      engineModel: this.config.modelPath,
      lines,
    };
  }

  /** Append into the ring, overwriting the oldest samples once it is full. */
  private append(chunk: Float32Array): void {
    this.sinceWindow += chunk.length;
    if (chunk.length >= WINDOW_SAMPLES) {
      this.ring.set(chunk.subarray(chunk.length - WINDOW_SAMPLES));
      this.ringStart = 0;
      this.ringLength = WINDOW_SAMPLES;
      return;
    }
    const writeAt = (this.ringStart + this.ringLength) % WINDOW_SAMPLES;
    const head = Math.min(chunk.length, WINDOW_SAMPLES - writeAt);
    this.ring.set(chunk.subarray(0, head), writeAt);
    if (head < chunk.length) this.ring.set(chunk.subarray(head), 0);
    const overflow = this.ringLength + chunk.length - WINDOW_SAMPLES;
    if (overflow > 0) {
      this.ringStart = (this.ringStart + overflow) % WINDOW_SAMPLES;
      this.ringLength = WINDOW_SAMPLES;
    } else {
      this.ringLength += chunk.length;
    }
  }

  /** The buffered window, oldest sample first. */
  private snapshot(): Float32Array {
    const window = new Float32Array(this.ringLength);
    const head = Math.min(this.ringLength, WINDOW_SAMPLES - this.ringStart);
    window.set(this.ring.subarray(this.ringStart, this.ringStart + head), 0);
    if (head < this.ringLength) window.set(this.ring.subarray(0, this.ringLength - head), head);
    return window;
  }

  private async transcribeWindow(window: Float32Array, opts: WhisperOptions): Promise<void> {
    if (!this.running || window.length === 0) return;
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-pcm-"));
    const path = join(directory, "window.wav");
    try {
      writeMonoWav(path, window);
      const cli = new WhisperCLI(this.config, path);
      await cli.start({
        initialPrompt: this.audio?.initialPrompt,
        onChunk: opts.onChunk,
        onStatus: opts.onStatus,
        onError: opts.onError,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

