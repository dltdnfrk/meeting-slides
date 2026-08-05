import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { ChatTransport } from "./llm.js";
import { compileNarrativeDeck } from "./narrative-compiler.js";
import { composeNarrativeDeck, type SceneDeck } from "./scene-graph.js";
import { renderSceneSlideDocument } from "./scene-html.js";
import { writeSceneDeckPptx } from "./scene-pptx.js";
import { saveScenePublication } from "./scene-store.js";
import type { CompileJobId, CompileUpdate } from "./session.js";
import type { MeetingStore } from "./store.js";

export interface SceneCompileResult {
  readonly meetingId: number;
  readonly directory: string;
  readonly relativePath: string;
  readonly pptxPath: string;
  readonly scene: SceneDeck;
  readonly usedFallback: boolean;
  readonly plannerError: string | null;
}

export interface SceneCompileOptions {
  readonly exportsDirectory?: string;
  readonly now?: () => Date;
  readonly onProgress?: (progress: { stage: "planning" | "render" | "publish"; completed?: number; total?: number }) => void;
}

function shell(title: string, count: number): string {
  const sections = Array.from({ length: count }, (_, index) => {
    const filename = `slide-${String(index).padStart(2, "0")}.html`;
    return `<section><iframe src="./slides/${filename}" title="Slide ${index + 1}"></iframe></section>`;
  }).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reset.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.css">
<style>.reveal .slides section{height:100%;padding:0}.reveal iframe{width:100%;aspect-ratio:16/9;border:0}</style></head>
<body><div class="reveal"><div class="slides">${sections}</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.js"></script><script>Reveal.initialize({hash:true});</script></body></html>`;
}

export async function compileSceneDeckToDisk(
  store: MeetingStore,
  meetingId: number,
  transport: ChatTransport,
  options: SceneCompileOptions = {},
): Promise<SceneCompileResult> {
  options.onProgress?.({ stage: "planning" });
  const transcriptSnapshot = store.lines(meetingId);
  const compiled = await compileNarrativeDeck(store, meetingId, transport, transcriptSnapshot);
  const scene = composeNarrativeDeck(compiled.narrative);
  const now = options.now?.() ?? new Date();
  const exportsDirectory = options.exportsDirectory ?? join(process.cwd(), "exports");
  const directoryName = `scene-${now.toISOString().replace(/[:.]/g, "-")}`;
  const finalDirectory = join(exportsDirectory, directoryName);
  const stagingDirectory = join(exportsDirectory, `.${directoryName}-${randomUUID()}`);
  const slidesDirectory = join(stagingDirectory, "slides");
  mkdirSync(slidesDirectory, { recursive: true });
  try {
    for (const [index, slide] of scene.slides.entries()) {
      const filename = `slide-${String(index).padStart(2, "0")}.html`;
      writeFileSync(join(slidesDirectory, filename), renderSceneSlideDocument(slide), "utf-8");
      options.onProgress?.({ stage: "render", completed: index + 1, total: scene.slides.length });
    }
    writeFileSync(join(stagingDirectory, "index.html"), shell(scene.title, scene.slides.length), "utf-8");
    writeFileSync(join(stagingDirectory, "narrative.json"), JSON.stringify(compiled.narrative, null, 2), "utf-8");
    writeFileSync(join(stagingDirectory, "scene.json"), JSON.stringify(scene, null, 2), "utf-8");
    const stagingPptx = join(stagingDirectory, "presentation.pptx");
    await writeSceneDeckPptx(scene, stagingPptx);
    options.onProgress?.({ stage: "publish" });
    mkdirSync(exportsDirectory, { recursive: true });
    if (existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, finalDirectory);
    const result: SceneCompileResult = {
      meetingId,
      directory: finalDirectory,
      relativePath: join("exports", basename(finalDirectory), "index.html"),
      pptxPath: join(finalDirectory, "presentation.pptx"),
      scene,
      usedFallback: compiled.usedFallback,
      plannerError: compiled.plannerError,
    };
    saveScenePublication(store.databaseHandle(), {
      meetingId,
      narrative: compiled.narrative,
      scene,
      directory: finalDirectory,
      pptxPath: result.pptxPath,
      publishedAt: now.getTime(),
    });
    return result;
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function runSceneCompileAction(input: {
  readonly store: MeetingStore;
  readonly transport: ChatTransport;
  readonly send: (message: CompileUpdate) => void;
  readonly meetingId?: number;
  readonly jobId?: CompileJobId;
  readonly exportsDirectory?: string;
}): Promise<SceneCompileResult | null> {
  const meetingId = input.meetingId ?? input.store.latestMeeting()?.id;
  const jobId = input.jobId ?? `compile-${randomUUID()}`;
  input.send({ type: "compile", status: "started", jobId, ...(meetingId === undefined ? {} : { meetingId }) });
  if (meetingId === undefined) {
    input.send({ type: "compile", status: "error", jobId, error: "No meeting is available to compile" });
    return null;
  }
  try {
    const result = await compileSceneDeckToDisk(input.store, meetingId, input.transport, {
      ...(input.exportsDirectory ? { exportsDirectory: input.exportsDirectory } : {}),
      onProgress: (progress) => input.send({ type: "compile", status: "progress", jobId, meetingId, ...progress }),
    });
    input.send({
      type: "compile",
      status: "success",
      jobId,
      meetingId,
      path: result.relativePath,
      outline: {
        title: result.scene.title,
        style: "scene-graph",
        slideCount: result.scene.slides.length,
        usedFallback: result.usedFallback,
        plannerError: result.plannerError,
      },
      scene: result.scene,
    });
    return result;
  } catch (error) {
    input.send({ type: "compile", status: "error", jobId, meetingId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
