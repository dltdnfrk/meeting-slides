import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { compileDeckOutline } from "./deck-compiler.js";
import { renderSlideSpec, type SlideFile } from "./deck.js";
import type { DeckPlanner } from "./llm.js";
import { parseDeckOutline, type DeckOutline } from "./slide-spec.js";
import type { CompileJobId, CompileUpdate, JobStage } from "./session.js";
import type { MeetingStore } from "./store.js";

export class CompileDeckActionError extends Error {
  constructor(readonly code: "invalid-meeting-id" | "meeting-not-found" | "publish-conflict", message: string) {
    super(message);
    this.name = "CompileDeckActionError";
  }
}

export interface CompileDeckDiskOptions {
  exportsDirectory: string;
  projectDirectory?: string;
  now?: () => Date;
  onProgress?: (progress: { stage: JobStage; completed?: number; total?: number }) => void;
}

export interface CompiledDeckResult {
  meetingId: number;
  outline: DeckOutline;
  files: SlideFile[];
  directory: string;
  relativePath: string;
  plannerError: string | null;
  usedFallback: boolean;
}

/** Validate the persisted contract before any filesystem writes, then render every spec via the registry. */
export function renderCompiledOutline(outlineValue: unknown): { outline: DeckOutline; files: SlideFile[] } {
  const outline = parseDeckOutline(outlineValue);
  return { outline, files: outline.slides.map(renderSlideSpec) };
}

/** Plan, persist, and atomically publish standalone HTML. PDF/PNG and review receipts are intentionally untouched. */
export async function compileDeckToDisk(
  store: MeetingStore,
  meetingId: number,
  planner: DeckPlanner,
  options: CompileDeckDiskOptions,
): Promise<CompiledDeckResult> {
  if (!Number.isSafeInteger(meetingId) || meetingId <= 0) {
    throw new CompileDeckActionError("invalid-meeting-id", "meetingId must be a positive safe integer");
  }
  if (store.meeting(meetingId) === null) {
    throw new CompileDeckActionError("meeting-not-found", `Meeting ${meetingId} was not found`);
  }

  options.onProgress?.({ stage: "planning" });
  const compiled = await compileDeckOutline(store, meetingId, planner);
  const rendered = renderCompiledOutline(compiled.outline);
  const projectDirectory = options.projectDirectory ?? join(import.meta.dir, "..");
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const directoryName = `deck-${stamp}`;
  const finalDirectory = join(options.exportsDirectory, directoryName);
  if (existsSync(finalDirectory)) {
    throw new CompileDeckActionError("publish-conflict", `Compile destination already exists: ${directoryName}`);
  }

  mkdirSync(options.exportsDirectory, { recursive: true });
  const stagingDirectory = join(options.exportsDirectory, `.${directoryName}.tmp-${randomUUID()}`);
  const slidesDirectory = join(stagingDirectory, "slides");
  try {
    mkdirSync(slidesDirectory, { recursive: true });
    copyFileSync(join(projectDirectory, "deck", "theme.css"), join(stagingDirectory, "theme.css"));
    copyFileSync(join(projectDirectory, "deck", "theme.css"), join(slidesDirectory, "theme.css"));
    for (const [index, file] of rendered.files.entries()) {
      writeFileSync(join(slidesDirectory, file.filename), file.html, "utf-8");
      options.onProgress?.({ stage: "render", completed: index + 1, total: rendered.files.length });
    }
    options.onProgress?.({ stage: "publish" });
    renameSync(stagingDirectory, finalDirectory);
    store.markDeckPublished(meetingId);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    meetingId,
    outline: rendered.outline,
    files: rendered.files,
    directory: finalDirectory,
    relativePath: join(basename(options.exportsDirectory), directoryName, "slides"),
    plannerError: compiled.plannerError,
    usedFallback: compiled.usedFallback,
  };
}

export interface CompileDeckActionInput extends CompileDeckDiskOptions {
  store: MeetingStore;
  planner: DeckPlanner;
  meetingId?: number;
  jobId?: CompileJobId;
  timeoutMs?: number;
  send(message: CompileUpdate): void;
}

/**
 * WebSocket protocol: one `compile:started`, followed by exactly one
 * `compile:success` or `compile:error`. The default target is the latest meeting.
 */
export async function runCompileDeckAction(input: CompileDeckActionInput): Promise<CompiledDeckResult | null> {
  const meetingId = input.meetingId ?? input.store.latestMeeting()?.id;
  const jobId = input.jobId ?? `compile-${randomUUID()}`;
  input.send({ type: "compile", status: "started", jobId, ...(meetingId === undefined ? {} : { meetingId }) });
  if (meetingId === undefined) {
    input.send({ type: "compile", status: "error", jobId, error: "No stored meeting was found" });
    return null;
  }

  let terminal = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = compileDeckToDisk(input.store, meetingId, input.planner, {
    ...input,
    onProgress: (progress) => {
      input.onProgress?.(progress);
      if (!terminal) input.send({ type: "compile", status: "progress", jobId, meetingId, ...progress });
    },
  });
  const timeoutMs = input.timeoutMs ?? 120_000;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      terminal = true;
      input.send({
        type: "compile", status: "timeout", jobId, meetingId,
        error: `Deck compile timed out after ${timeoutMs}ms`,
      });
      resolve(null);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([work, timeout]);
    if (result === null) return null;
    if (timer) clearTimeout(timer);
    terminal = true;
    input.send({
      type: "compile",
      status: "success",
      jobId,
      meetingId,
      path: result.relativePath,
      outline: {
        title: result.outline.title,
        style: result.outline.style,
        slideCount: result.files.length,
        usedFallback: result.usedFallback,
        plannerError: result.plannerError,
      },
    });
    return result;
  } catch (error) {
    if (timer) clearTimeout(timer);
    terminal = true;
    input.send({
      type: "compile",
      status: "error",
      jobId,
      meetingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
