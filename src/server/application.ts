import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, type Config } from "../config.ts";
import { LLMClient, type ChatTransport, type MeetingLLM } from "../llm.ts";
import { CliLLMClient } from "../llm-cli.ts";
import { MeetingSession } from "../session.ts";

import type { ClientListener, ServerMessage } from "../protocol.ts";
import { MeetingStore } from "../store.ts";
import { MinutesStore } from "../minutes-store.ts";
import { SlidePlanStore } from "../slide-plan-store.ts";
import { TranscriptVersionWriter } from "../transcript-versioning.ts";
import { reconcileInterruptedMeetings } from "../startup-recovery.ts";
import { createHttpHandler } from "./http.ts";
import { createWebSocketController, type WsActionHandler } from "./websocket.ts";
import { createCaptureController, type CaptureRuntime } from "./capture.ts";
import { createReviewController } from "./review.ts";
import { createMeetingsController, type MeetingState } from "./meetings.ts";
import { createSlidesController, type ArtifactJobs } from "./slides.ts";
import { createImageExportController } from "./image-export.ts";
import { createProvidersController, type DetectorState } from "./providers.ts";
import { createAskController } from "./ask.ts";
import type { inspectSubscriptionProviders } from "../providers.ts";
import type { runSlidePlanServerAction } from "../slides/server-action.ts";
import type { runVisualReview } from "../visual-review.ts";

export interface ApplicationPaths {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly settingsRoot: string;
  readonly modelsRoot: string;
  readonly exportRoot: string;
  readonly bundleOutputRoot: string;
  readonly bundleTargetCommit: string;
  readonly publicRoot: string;
  readonly envPath: string;
}

export interface ApplicationOptions {
  readonly config?: Config;
  readonly paths?: Partial<ApplicationPaths>;
  readonly detector?: MeetingLLM & ChatTransport;
  readonly discoverProviders?: typeof inspectSubscriptionProviders;
  readonly createCapture?: (audio?: { outputPath: string; initialPrompt?: string }) => CaptureRuntime;
  readonly runSlidePlan?: typeof runSlidePlanServerAction;
  readonly visualReview?: typeof runVisualReview;
  readonly allowOriginlessWs?: boolean;
  readonly automationToken?: string;
}

/** Construction is inert. Only start acquires stores, capture adapters and a listener. */
export function createMeetingApplication(options: ApplicationOptions = {}) {
  let running: ReturnType<typeof startApplication> | undefined;
  return {
    start() {
      return (running ??= startApplication(options));
    },
    async close() {
      await running?.close();
    },
  };
}

function startApplication(options: ApplicationOptions) {
  const config = options.config ?? loadConfig();
  const projectRoot = options.paths?.projectRoot ?? join(import.meta.dir, "../..");
  const exportRoot =
    options.paths?.exportRoot ?? process.env.MEETING_SLIDES_EXPORT_ROOT ?? join(projectRoot, "exports");
  const paths: ApplicationPaths = {
    projectRoot,
    exportRoot,
    databasePath: process.env.MEETINGS_DB_PATH ?? join(projectRoot, "meetings.db"),
    settingsRoot: process.env.MEETING_SLIDES_SETTINGS_ROOT ?? projectRoot,
    modelsRoot: join(projectRoot, "models", "stt"),
    bundleOutputRoot: process.env.MEETING_BUNDLE_OUTPUT_ROOT ?? exportRoot,
    bundleTargetCommit:
      options.paths?.bundleTargetCommit ??
      process.env.MEETING_BUNDLE_TARGET_COMMIT ??
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim(),
    publicRoot: join(projectRoot, "public"),
    envPath: join(projectRoot, ".env"),
    ...options.paths,
  };
  mkdirSync(paths.bundleOutputRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.bundleOutputRoot, 0o700);
  const store = new MeetingStore(paths.databasePath);
  chmodSync(paths.databasePath, 0o600);
  const minutesStore = new MinutesStore(store.databaseHandle());
  const slidePlanStore = new SlidePlanStore(store.databaseHandle());
  const recovered = reconcileInterruptedMeetings(minutesStore);
  if (recovered.length) console.warn(`[recovery] finalized interrupted meetings: ${recovered.join(", ")}`);
  const client =
    options.detector ??
    (config.llm.cli
      ? new CliLLMClient(config.llm.cli)
      : config.llm.config
        ? new LLMClient(config.llm.config)
        : undefined);
  if (!client) {
    store.close();
    throw new Error("No LLM configuration");
  }
  const detector: DetectorState = {
    llm: client,
    extractionTransport: client,
    llmLabel: config.llm.cli
      ? `cli:${config.llm.cli.preset}(${config.llm.cli.bin})${config.llm.cli.model ? ` · ${config.llm.cli.model}` : ""}${config.llm.cli.effort ? ` · effort=${config.llm.cli.effort}` : ""}`
      : (config.llm.config?.model ?? config.llm.provider),
    currentProviderId: config.llm.cli ? `cli:${config.llm.cli.preset}` : config.llm.provider,
    currentModel: config.llm.cli?.model ?? config.llm.config?.model,
    currentEffort: config.llm.cli?.effort,
  };
  const listeners = new Set<ClientListener>();
  const broadcast: ClientListener = (message) => {
    for (const listener of listeners) listener(message);
  };
  const meeting: MeetingState = { currentMeetingId: null };
  const artifacts: ArtifactJobs = {
    activeJob: null,
    activeExportUpdate: null,
    lastSavedPath: null,
    pending: new Set(),
  };
  const meetingsMessage = (): ServerMessage => ({ type: "meetings", items: store.listMeetings() });
  const transcriptWriter = new TranscriptVersionWriter(minutesStore);
  const session = new MeetingSession(
    client,
    config.block.detectInterval,
    config.block.contextWindow,
    listeners,
    {
      onLine: (entry) => transcriptWriter.append(entry),
      onSlide: (slide) => {
        store.addSlide({ idx: slide.index, title: slide.title, bullets: slide.bullets, startedAt: slide.startedAt });
        broadcast(meetingsMessage());
      },
    },
    { automaticDetection: true },
  );
  const providers = createProvidersController({
    config,
    paths,
    detector,
    session,
    broadcast,
    discover: options.discoverProviders,
  });
  const capture = createCaptureController({
    config,
    paths,
    store,
    minutesStore,
    transcriptWriter,
    session,
    meeting,
    detector,
    broadcast,
    meetingsMessage,
    createCapture: options.createCapture,
  });
  const slides = createSlidesController({
    store,
    minutesStore,
    slidePlanStore,
    artifacts,
    detector,
    broadcast,
    runSlidePlan: options.runSlidePlan,
    slidePlanRuntime: {
      outputRoot: join(exportRoot, "slide-plans"),
      cacheRoot: join(exportRoot, ".slide-plan-cache"),
      fontSourcePath: join(paths.publicRoot, "fonts", "pretendard-variable.woff2"),
      tools: {
        slidesGrabPath: join(projectRoot, "node_modules", ".bin", "slides-grab"),
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(projectRoot, "vendor", "ms-playwright"),
        sandboxExecutable: "/usr/bin/sandbox-exec",
        sandboxProfile: "(version 1)(allow default)(deny network*)",
        timeoutMs: 120_000,
      },
    },
  });
  const meetings = createMeetingsController({
    store,
    minutesStore,
    slidePlanStore,
    meeting,
    artifacts,
    detector,
    capture,
    session,
    broadcast,
    paths,
    geometryForSlidePlan: slides.geometryForSlidePlan,
  });
  const review = createReviewController({ minutesStore, detector, capture, broadcast, paths });
  const imageExport = createImageExportController({ store, artifacts, broadcast, paths, review: options.visualReview });
  const ask = createAskController({ minutesStore, detector });
  const handlerMap = new Map<string, WsActionHandler>();
  for (const controller of [capture, slides, meetings, review, imageExport, providers, ask]) {
    for (const [action, handler] of controller.handlers) {
      if (handlerMap.has(action)) throw new Error(`Duplicate action: ${action}`);
      handlerMap.set(action, handler);
    }
  }
  handlerMap.set("status", ({ ws }) => ws.send(JSON.stringify({ type: "status", text: "서버 정상" })));
  handlerMap.set("transcript", ({ ws }) => ws.send(JSON.stringify(session.transcript("export"))));
  const websocket = createWebSocketController({
    listeners,
    handlerMap,
    mutationIdentity: review.reviewMutationIdentity,
    hydrate: () => [
      { type: "status", text: `연결됨. LLM provider=${config.llm.provider} model=${detector.llmLabel}` },
      providers.providersMessage(),
      capture.sttMessage(),
      capture.captureMessage(),
      session.snapshot(),
      session.transcript("snapshot"),
      ...(artifacts.activeExportUpdate
        ? [artifacts.activeExportUpdate]
        : artifacts.activeJob
          ? [
              {
                type: "compile" as const,
                status: "started" as const,
                jobId: artifacts.activeJob.id as `compile-${string}`,
                meetingId: artifacts.activeJob.meetingId,
              },
            ]
          : []),
      ...(artifacts.lastSavedPath ? [{ type: "saved" as const, path: artifacts.lastSavedPath }] : []),
    ],
  });
  const allowedOrigins = new Set<string>();
  const fetch = createHttpHandler({
    publicDir: paths.publicRoot,
    allowedOrigins,
    allowOriginlessWs: options.allowOriginlessWs ?? process.env.MEETING_SLIDES_ALLOW_ORIGINLESS_WS === "true",
    automationToken: options.automationToken ?? process.env.MEETING_SLIDES_AUTOMATION_TOKEN?.trim() ?? "",
    slidePlanStore,
    capture,
  });
  const server = Bun.serve({
    port: config.server.httpPort,
    hostname: "127.0.0.1",
    fetch,
    websocket: websocket.websocket,
  });
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) allowedOrigins.add(`http://${host}:${server.port}`);
  const providerDiscovery = providers.startDiscovery();
  if (config.input.mode === "file")
    void capture.startCapture().catch((error) => console.error("[capture] startup failed", error));
  let closing: Promise<void> | undefined;
  return {
    server,
    paths,
    handlerMap,
    providerDiscovery,
    slidePlanTranscriptFor: slides.slidePlanTranscriptFor,
    close() {
      return (closing ??= (async () => {
        websocket.close();
        const settled = await Promise.allSettled([
          server.stop(true),
          providers.close(),
          capture.close(),
          review.close(),
          ask.close(),
          ...artifacts.pending,
        ]);
        session.reset();
        listeners.clear();
        store.close();
        const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (failures.length) throw new AggregateError(failures, "Application shutdown failed");
      })());
    },
  };
}
