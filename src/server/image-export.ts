import type { ClientListener, ExportUpdate } from "../protocol.ts";
import { MeetingStore } from "../store.ts";
import { prepareExportDeck, SlidePlanRequiredError } from "../deck-export.ts";
import { buildPassAReport, buildPassBReport } from "../grab.ts";
import { buildReviewPrompt, runVisualReview } from "../visual-review.ts";
import { publishPngDirectory } from "../png-artifact.ts";
import { fitSlidesGrabViewport } from "../slides/render/standalone-presentation.ts";
import { publishPdfFile } from "../pdf-artifact.ts";
import { GrabProcessExitError, GrabProcessTimeoutError, runGrabProcess } from "../grab-process.ts";
import { createHash, randomUUID } from "node:crypto";
import type { ExportJobId } from "../protocol.ts";
import { join, sep } from "node:path";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ApplicationPaths } from "./application.ts";
import type { ArtifactJobs } from "./slides.ts";
import { validMeetingId, type WsActionHandler } from "./websocket.ts";

export function createImageExportController(deps: {
  readonly store: MeetingStore;
  readonly artifacts: ArtifactJobs;
  readonly broadcast: ClientListener;
  readonly paths: ApplicationPaths;
  readonly review?: typeof runVisualReview;
}) {
  const { store, artifacts, broadcast, paths } = deps;
  const { bundleOutputRoot } = paths;
  class ExportJobError extends Error {
    constructor(
      readonly code: NonNullable<ExportUpdate["code"]>,
      message: string,
    ) {
      super(message);
      this.name = "ExportJobError";
    }
  }
  async function runGrab(args: string[], timeoutMs: number): Promise<void> {
    const { FORCE_COLOR: _forceColor, ...grabEnv } = process.env;
    try {
      await runGrabProcess(process.execPath, ["x", "slides-grab", ...args], {
        timeoutMs: Math.max(1, timeoutMs),
        env: {
          ...grabEnv,
          NO_COLOR: "1",
          PLAYWRIGHT_BROWSERS_PATH: join(paths.projectRoot, "vendor", "ms-playwright"),
        },
      });
    } catch (error) {
      if (error instanceof GrabProcessTimeoutError) {
        throw new ExportJobError("timeout", `slides-grab ${args[0]} timed out`);
      }
      if (error instanceof GrabProcessExitError) {
        throw new ExportJobError("process-failed", error.message);
      }
      throw error;
    }
  }
  function savedArtifactPath(path: string): string {
    const rootPrefix = `${paths.projectRoot}${sep}`;
    return path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
  }
  async function beforeDeadline<T>(work: Promise<T>, deadline: number, label: string): Promise<T> {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (remaining <= 0) throw new ExportJobError("timeout", `${label} timed out`);
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ExportJobError("timeout", `${label} timed out`)), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // The reviewer owns a subprocess. A deadline cannot abandon its cleanup.
      await Promise.allSettled([work]);
    }
  }
  async function runImageExport(
    action: "exportPdf" | "exportPng",
    meetingId: number,
    jobId: ExportJobId,
  ): Promise<void> {
    const started = Date.now();
    const deadline = started + 120000;
    const send = (message: Omit<ExportUpdate, "type" | "action" | "jobId" | "meetingId">) => {
      const update: ExportUpdate = { type: "export", action, jobId, meetingId, ...message };
      artifacts.activeExportUpdate = update;
      broadcast(update);
    };
    send({ status: "started", stage: "prepare" });
    try {
      if (store.meeting(meetingId) === null)
        throw new ExportJobError("meeting-not-found", `Meeting ${meetingId} was not found`);
      let material;
      try {
        material = prepareExportDeck(store, meetingId, { requireSlidePlan: true });
      } catch (error) {
        if (error instanceof SlidePlanRequiredError) {
          throw new ExportJobError("slide-plan-required", error.message);
        }
        throw error;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      // slides-grab discovers slide-*.html, not arbitrary persisted SlidePlan IDs.
      const files = material.files.map((file, index) => ({
        ...file,
        filename: `slide-${String(index + 1).padStart(2, "0")}.html`,
        html: fitSlidesGrabViewport(file.html),
      }));
      const dir = join(paths.exportRoot, `deck-${stamp}`);
      const slidesDir = join(dir, "slides");
      mkdirSync(slidesDir, { recursive: true });
      copyFileSync(join(paths.projectRoot, "deck", "theme.css"), join(dir, "theme.css"));
      copyFileSync(join(paths.projectRoot, "deck", "theme.css"), join(slidesDir, "theme.css"));
      writeFileSync(join(dir, "index.html"), material.indexHtml, "utf-8");
      for (const file of files) writeFileSync(join(slidesDir, file.filename), file.html, "utf-8");
      send({ status: "progress", stage: "validate", completed: 0, total: 1 });
      await runGrab(["validate", "--slides-dir", slidesDir], deadline - Date.now());
      send({ status: "progress", stage: "validate", completed: 1, total: 1 });
      if (action === "exportPng") {
        const finalName = `deck-${stamp}-png`;
        const out = join(bundleOutputRoot, finalName);
        const temporaryOut = join(bundleOutputRoot, `.${finalName}.tmp-${randomUUID()}`);
        send({ status: "progress", stage: "render", completed: 0, total: material.slideCount });
        try {
          await runGrab(["png", "--slides-dir", slidesDir, "--output-dir", temporaryOut], deadline - Date.now());
          publishPngDirectory({
            temporaryDirectory: temporaryOut,
            finalDirectory: out,
            expectedCount: material.slideCount,
            meetingId,
          });
        } catch (error) {
          rmSync(temporaryOut, { recursive: true, force: true });
          throw error;
        }
        artifacts.lastSavedPath = savedArtifactPath(out);
        broadcast({ type: "saved", path: artifacts.lastSavedPath });
        send({
          status: "success",
          stage: "publish",
          completed: material.slideCount,
          total: material.slideCount,
          path: artifacts.lastSavedPath,
        });
        return;
      }
      const previewDir = join(slidesDir, ".slides-grab", "gate-preview");
      send({ status: "progress", stage: "preview", completed: 0, total: material.slideCount });
      await runGrab(["png", "--slides-dir", slidesDir, "--output-dir", previewDir], deadline - Date.now());
      const previewFiles = readdirSync(previewDir).filter((file) => file.endsWith(".png"))
        .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
      send({ status: "progress", stage: "review", completed: 0, total: 1 });
      const reviewOpts = {
        images: previewFiles.map((file) => join(previewDir, file)),
        timeoutMs: Math.max(1, deadline - Date.now()),
      };
      const review = await beforeDeadline(
        (deps.review ?? runVisualReview)(buildReviewPrompt(reviewOpts), reviewOpts),
        deadline,
        "visual review",
      );
      if (review.verdict !== "proceed") {
        throw new ExportJobError("review-failed", review.blockingFindings.join("; ") || review.summary);
      }
      const fingerprints = files.map((file) => ({
        file: file.filename,
        sha256: createHash("sha256").update(file.html, "utf-8").digest("hex"),
      }));
      const gateInput = {
        slideFiles: fingerprints,
        previewFiles,
        slideCount: material.slideCount,
        maxBullets: material.maxBullets,
        lineCount: material.lineCount,
        reviewed: true,
        confidence: review.confidence,
        notes: `독립 시각 리뷰 요약: ${review.summary}`,
      };
      writeFileSync(join(slidesDir, ".pass-a.md"), buildPassAReport(gateInput), "utf-8");
      writeFileSync(join(slidesDir, ".pass-b.md"), buildPassBReport(gateInput), "utf-8");
      send({ status: "progress", stage: "design-gate", completed: 0, total: 1 });
      await runGrab(
        [
          "design-gate",
          "--slides-dir",
          slidesDir,
          "--verdict",
          "proceed",
          "--pass-a-report",
          join(slidesDir, ".pass-a.md"),
          "--pass-b-report",
          join(slidesDir, ".pass-b.md"),
        ],
        deadline - Date.now(),
      );
      const finalName = `deck-${stamp}.pdf`;
      const out = join(bundleOutputRoot, finalName);
      const temporaryOut = join(bundleOutputRoot, `.${finalName}.tmp-${randomUUID()}`);
      send({ status: "progress", stage: "render", completed: 0, total: material.slideCount });
      try {
        await runGrab(["pdf", "--slides-dir", slidesDir, "--output", temporaryOut], deadline - Date.now());
        publishPdfFile(temporaryOut, out);
      } catch (error) {
        rmSync(temporaryOut, { force: true });
        throw error;
      }
      artifacts.lastSavedPath = savedArtifactPath(out);
      broadcast({ type: "saved", path: artifacts.lastSavedPath });
      send({
        status: "success",
        stage: "publish",
        completed: material.slideCount,
        total: material.slideCount,
        path: artifacts.lastSavedPath,
      });
    } catch (error) {
      const code = error instanceof ExportJobError ? error.code : "process-failed";
      const message = error instanceof Error ? error.message : String(error);
      send({ status: code === "timeout" ? "timeout" : "error", code, error: message });
    }
  }
  const handleImageExport: WsActionHandler = ({ ws, cmd }) => {
    if (cmd.action !== "exportPdf" && cmd.action !== "exportPng") return;
    const requestedMeetingId = validMeetingId(cmd.meetingId)
      ? cmd.meetingId
      : cmd.meetingId === undefined
        ? store.latestMeeting()?.id
        : undefined;
    if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
      if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
        const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
        const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
        broadcast({
          type: "export",
          status: "error",
          action: cmd.action,
          jobId,
          code: "invalid-meeting-id",
          error: "meetingId must be a positive safe integer",
        });
      } else {
        broadcast({ type: "status", text: "meetingId must be a positive safe integer" });
      }
    } else if (requestedMeetingId === undefined) {
      if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
        const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
        const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
        broadcast({
          type: "export",
          status: "error",
          action: cmd.action,
          jobId,
          code: "meeting-not-found",
          error: "No stored meeting was found",
        });
      } else {
        broadcast({ type: "status", text: "저장된 회의가 없습니다" });
      }
    } else if (artifacts.activeJob !== null) {
      if (cmd.action === "exportPdf" || cmd.action === "exportPng") {
        const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
        const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
        broadcast({
          type: "export",
          status: "error",
          action: cmd.action,
          jobId,
          meetingId: requestedMeetingId,
          code: "job-busy",
          error: `A conflicting ${artifacts.activeJob.action} job is already in progress`,
        });
      } else {
        broadcast({ type: "status", text: `A conflicting ${artifacts.activeJob.action} job is already in progress` });
      }
    } else {
      const prefix = cmd.action === "exportPdf" ? "pdf" : "png";
      const jobId = `${prefix}-${randomUUID()}` as ExportJobId;
      artifacts.activeJob = { id: jobId, meetingId: requestedMeetingId, action: cmd.action };
      const work = runImageExport(cmd.action, requestedMeetingId, jobId).finally(() => {
        if (artifacts.activeJob?.id === jobId) artifacts.activeJob = null;
        if (artifacts.activeExportUpdate?.jobId === jobId) artifacts.activeExportUpdate = null;
        artifacts.pending.delete(work);
      });
      artifacts.pending.add(work);
    }
  };
  return {
    handlers: new Map<string, WsActionHandler>([
      ["exportPdf", handleImageExport],
      ["exportPng", handleImageExport],
    ]),
  };
}
