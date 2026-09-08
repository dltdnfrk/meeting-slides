import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export const PCM_SAMPLE_RATE = 16_000;
export const PCM_CHUNK_SAMPLES = 8_000;
const MAX_PAYLOAD_BYTES = PCM_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 2;
const WAV_HEADER_BYTES = 44;

export interface PcmSource {
  next(): Promise<Float32Array | null>;
}

/**
 * Decode little-endian float32 bytes into an aligned Float32Array.
 *
 * The copy is deliberate. A base64 Buffer starts at an arbitrary offset inside
 * the shared allocation pool, and the zero-copy alternative
 * `new Float32Array(raw.buffer, raw.byteOffset, n)` throws outright whenever
 * that offset is not 4-byte aligned.
 */
function decodeFloat32LE(raw: Buffer): Float32Array {
  const values = new Float32Array(raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
  Buffer.from(values.buffer, values.byteOffset, values.byteLength).set(raw);
  return values;
}

/** Clamp to [-1, 1] and quantize to signed 16-bit PCM in one typed-array pass. */
function encodeInt16LE(samples: Float32Array): Buffer {
  const quantized = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    quantized[index] = Math.round(clamped * 32767);
  }
  return Buffer.from(quantized.buffer, quantized.byteOffset, quantized.byteLength);
}

export class PcmIngest implements PcmSource {
  /** Frames received but not yet cut into a live chunk. Never re-concatenated. */
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private queue: Array<Float32Array | undefined> = [];
  private head = 0;
  private waiter: ((chunk: Float32Array | null) => void) | null = null;
  private done = false;
  private wavFd: number | null = null;
  private dataBytes = 0;
  private receivedBytes = 0;

  constructor(options: { readonly outputPath?: string } = {}) {
    if (options.outputPath) {
      this.wavFd = openSync(options.outputPath, "w");
      writeSync(this.wavFd, Buffer.alloc(WAV_HEADER_BYTES));
    }
  }

  /**
   * One decode per frame: the archive and the live queue read the same
   * Float32Array instead of walking the payload bytes twice.
   */
  appendBase64(encoded: string): void {
    if (this.done) return;
    // Base64 decoding never throws; it drops invalid characters, so a garbage
    // payload arrives here as a length the frame contract rejects.
    const raw = Buffer.from(encoded, "base64");
    if (raw.byteLength === 0 || raw.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("Invalid PCM payload");
    }
    if (raw.byteLength > MAX_PAYLOAD_BYTES) throw new Error("PCM payload too large");
    this.receivedBytes += raw.byteLength;
    const samples = decodeFloat32LE(raw);
    this.archive(samples);
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    this.drainPending();
  }

  get hasAudio(): boolean {
    return this.receivedBytes > 0;
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.drainPending();
    if (this.pendingSamples > 0) this.enqueue(this.take(this.pendingSamples));
    this.pending = [];
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
  }

  finalizeWav(): void {
    if (this.wavFd === null) throw new Error("PCM archive is not configured");
    const header = wavHeader(this.dataBytes);
    writeSync(this.wavFd, header, 0, header.byteLength, 0);
    fsyncSync(this.wavFd);
    closeSync(this.wavFd);
    this.wavFd = null;
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
      return Promise.resolve(chunk);
    }
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  private unread(): number { return this.queue.length - this.head; }

  private drainPending(): void {
    while (this.pendingSamples >= PCM_CHUNK_SAMPLES) this.enqueue(this.take(PCM_CHUNK_SAMPLES));
  }

  /** Move `count` samples out of the pending frames, copying only what is cut. */
  private take(count: number): Float32Array {
    const first = this.pending[0];
    if (first !== undefined && first.length === count) {
      this.pending.shift();
      this.pendingSamples -= count;
      return first;
    }
    const chunk = new Float32Array(count);
    let filled = 0;
    while (filled < count) {
      const frame = this.pending[0]!;
      const taken = Math.min(count - filled, frame.length);
      chunk.set(taken === frame.length ? frame : frame.subarray(0, taken), filled);
      filled += taken;
      if (taken === frame.length) this.pending.shift();
      else this.pending[0] = frame.subarray(taken);
    }
    this.pendingSamples -= count;
    return chunk;
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

  private archive(samples: Float32Array): void {
    if (this.wavFd === null) return;
    const quantized = encodeInt16LE(samples);
    writeSync(this.wavFd, quantized);
    this.dataBytes += quantized.byteLength;
  }
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Write a complete mono 16 kHz WAV in one pass.
 *
 * Deliberately independent of `PcmIngest`: routing a transcription window
 * through `appendBase64` re-encoded the samples to base64 only to decode them
 * again, and every window longer than the per-frame payload cap was rejected
 * outright.
 */
export function writeMonoWav(path: string, samples: Float32Array): void {
  const quantized = encodeInt16LE(samples);
  const fd = openSync(path, "w");
  try {
    writeSync(fd, wavHeader(quantized.byteLength));
    writeSync(fd, quantized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
