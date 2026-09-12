#!/usr/bin/env bun
// bench-stt-ko.ts — 한국어 회의 STT 백엔드 CER/RTF 벤치마크
//
// 사용: bun scripts/bench-stt-ko.ts <audio.wav> <reference.txt> [--models small,large-v3-turbo,nemotron-3.5,qwen3-asr-0.6b]
//
// 각 모델에 대해:
//   - whisper 백엔드: whisper-cli -m <model> -f <audio> -l ko
//   - transcribe 백엔드: transcribe-cpp 네이티브 바인딩 (PCM 스트리밍)
// 출력: 모델별 CER, RTF, 첫-partial 지연, 전사 텍스트

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sttModelArtifact, type SttModelId } from "../src/stt-model-catalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = resolve(ROOT, "models/stt");

// ---------- CER ----------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n]!;
}

function normalize(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[.,!?;:'"()\[\]{}<>«»「」『』【】〈〉《》—–\-…·]/g, "")
    .toLowerCase();
}

function cer(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

// ---------- whisper-cli ----------

async function runWhisperCli(modelPath: string, audioPath: string): Promise<{ text: string; elapsedMs: number }> {
  const cli = process.env.WHISPER_CLI_BIN ?? "/opt/homebrew/bin/whisper-cli";
  if (!existsSync(cli)) throw new Error(`whisper-cli not found: ${cli}`);
  const start = Date.now();
  const proc = spawn(cli, ["-m", modelPath, "-f", audioPath, "-l", "ko", "--no-timestamps"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`whisper-cli exited ${code}`)));
    proc.on("error", reject);
  });
  const elapsedMs = Date.now() - start;
  // whisper-cli --no-timestamps는 순수 텍스트만 출력
  const text = stdout.trim().split("\n").filter((line) => !line.startsWith("[")).join(" ");
  return { text, elapsedMs };
}

// ---------- transcribe.cpp ----------

async function runTranscribeCpp(modelPath: string, audioPath: string): Promise<{ text: string; elapsedMs: number; firstPartialMs: number | null }> {
  const { TranscribeModel } = await import("transcribe-cpp");
  const start = Date.now();
  const model = await TranscribeModel.load(modelPath, { backend: "auto" });
  const session = model.createSession({ nThreads: 8 });
  const stream = await session.stream({ language: "ko" });

  const pcm = readFileSync(audioPath);
  const chunkSize = 16000 * 4 * 5;
  let firstPartialMs: number | null = null;

  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
    await stream.feed(new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4));
    const partial = stream.text.full;
    if (firstPartialMs === null && partial.trim()) firstPartialMs = Date.now() - start;
  }
  await stream.finalize();
  const text = stream.text.full;
  const elapsedMs = Date.now() - start;
  session.dispose();
  model.dispose();
  return { text, elapsedMs, firstPartialMs };
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const audioPath = args[0] ? resolve(args[0]) : null;
  const refPath = args[1] ? resolve(args[1]) : null;
  if (!audioPath || !refPath) {
    console.error("usage: bun scripts/bench-stt-ko.ts <audio.wav> <reference.txt> [--models id1,id2,...]");
    process.exit(1);
  }
  const modelsArg = args.find((a) => a.startsWith("--models="));
  const modelIds: SttModelId[] = modelsArg
    ? modelsArg.slice("--models=".length).split(",") as SttModelId[]
    : ["large-v3-turbo", "nemotron-3.5", "qwen3-asr-0.6b"];

  const reference = readFileSync(refPath, "utf8").trim();
  const audioBytes = readFileSync(audioPath).length;
  const audioSec = audioBytes / (16000 * 4); // f32le 16kHz mono 가정

  console.log(`audio: ${audioPath} (${(audioSec).toFixed(1)}s)`);
  console.log(`reference: ${refPath} (${reference.length} chars)`);
  console.log("");

  const results: Array<{ model: string; cer: number; rtf: number; firstPartialMs: number | null; text: string }> = [];

  for (const id of modelIds) {
    const artifact = sttModelArtifact(id);
    const modelPath = resolve(MODELS_DIR, artifact.fileName);
    if (!existsSync(modelPath)) {
      console.log(`[${id}] model not found: ${modelPath} — skipping`);
      continue;
    }
    console.log(`[${id}] ${artifact.label} (${artifact.backend})`);
    try {
      if (artifact.backend === "whisper") {
        const { text, elapsedMs } = await runWhisperCli(modelPath, audioPath);
        const c = cer(reference, text);
        const rtf = elapsedMs / 1000 / audioSec;
        results.push({ model: id, cer: c, rtf, firstPartialMs: null, text });
        console.log(`  CER=${(c * 100).toFixed(2)}% RTF=${rtf.toFixed(3)} elapsed=${elapsedMs}ms`);
      } else {
        const { text, elapsedMs, firstPartialMs } = await runTranscribeCpp(modelPath, audioPath);
        const c = cer(reference, text);
        const rtf = elapsedMs / 1000 / audioSec;
        results.push({ model: id, cer: c, rtf, firstPartialMs, text });
        console.log(`  CER=${(c * 100).toFixed(2)}% RTF=${rtf.toFixed(3)} firstPartial=${firstPartialMs ?? "n/a"}ms elapsed=${elapsedMs}ms`);
      }
    } catch (error) {
      console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\n=== summary ===");
  for (const r of results) {
    console.log(`${r.model}: CER=${(r.cer * 100).toFixed(2)}% RTF=${r.rtf.toFixed(3)} firstPartial=${r.firstPartialMs ?? "n/a"}ms`);
  }

  const outPath = resolve(ROOT, ".omo/evidence/bench-stt-ko.json");
  writeFileSync(outPath, JSON.stringify({ audioPath, refPath, audioSec, results, at: new Date().toISOString() }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

await main();
