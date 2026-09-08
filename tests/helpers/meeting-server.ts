import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createMeetingApplication, type ApplicationOptions } from "../../src/server/application.ts";

const projectRoot = join(import.meta.dir, "../..");

/** Only config parsing sees fixture environment; application resources have explicit paths. */
export function startMeetingServer(environment: NodeJS.ProcessEnv, overrides: ApplicationOptions = {}) {
  const previous = { ...process.env };
  let config;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    config = loadConfig();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  const settingsRoot = environment.MEETING_SLIDES_SETTINGS_ROOT ?? join(environment.MEETINGS_DB_PATH ?? "", "..");
  const application = createMeetingApplication({
    config: { ...config, server: { httpPort: 0, openBrowser: false } },
    paths: {
      projectRoot, databasePath: environment.MEETINGS_DB_PATH,
      settingsRoot, modelsRoot: join(settingsRoot, "models"), exportRoot: join(settingsRoot, "exports"),
      bundleOutputRoot: environment.MEETING_BUNDLE_OUTPUT_ROOT ?? join(settingsRoot, "exports"),
      bundleTargetCommit: environment.MEETING_BUNDLE_TARGET_COMMIT ?? "0123456789abcdef0123456789abcdef01234567",
    },
    automationToken: environment.MEETING_SLIDES_AUTOMATION_TOKEN ?? "",
    allowOriginlessWs: false,
    discoverProviders: async () => [],
    ...overrides,
  });
  return application.start();
}
export type RunningMeetingServer = ReturnType<typeof startMeetingServer>;

export function bounded<T>(promise: Promise<T>, label = "event", timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export function deferred<T>() { return Promise.withResolvers<T>(); }

export function localWebSocket(port: number): WebSocket {
  // lib.dom shadows Bun's documented headers overload. Check the runtime boundary without a cast.
  const socket: unknown = Reflect.construct(WebSocket, [`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  } satisfies Bun.WebSocketOptions]);
  if (!(socket instanceof WebSocket)) throw new TypeError("Bun WebSocket constructor returned an invalid client");
  return socket;
}

export async function connectMeetingServer(port: number, timeoutMs = 10_000) {
  const socket = localWebSocket(port);
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  await bounded(new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  }), "WebSocket open");
  const next = (predicate: (message: Record<string, unknown>) => boolean) => {
    let listener: (event: MessageEvent) => void;
    return bounded(new Promise<Record<string, unknown>>(resolve => {
      listener = event => { const message = JSON.parse(String(event.data)); if (predicate(message)) resolve(message); };
      socket.addEventListener("message", listener);
    }), "WebSocket message", timeoutMs).finally(() => socket.removeEventListener("message", listener));
  };
  return {    
socket, messages, next, async send(command: object, predicate: (message: Record<string, unknown>) => boolean) {
      const pending = next(predicate); socket.send(JSON.stringify(command)); return pending;
    }  
};
}

export function launchModelOutput(transcriptVersionId: string) {
  const bindings = ["claim-launch"];
  const base = (id: string, layout: string, title: string) => ({ id, layout, storyRole: "argument", title, editorialPaths: [], assetIds: [] });
  return JSON.stringify({    
schemaVersion: 1, revision: 0, title: "Friday beta launch", claims: [{
      id: "claim-launch", kind: "decision", text: "The beta launches Friday.", method: "reviewed",
      sources: [{ transcriptVersionId, startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }],
    }], assets: [], slides: [
      { ...base("opening", "hero", "The beta launches Friday"), storyRole: "opening", payload: { variant: "cover", statement: "Friday launch" }, bindings: { title: bindings, statement: bindings } },
      { ...base("summary", "summary", "The launch has a clear owner"), payload: { mode: "overview", items: ["Mina owns release notes"] }, bindings: { title: bindings, "items[0]": bindings } },
      { ...base("decision", "decision", "Friday is the launch date"), storyRole: "decision", payload: { decision: "Launch Friday", rationale: ["The team chose Friday"] }, bindings: { title: bindings, decision: bindings, "rationale[0]": bindings } },
      { ...base("comparison", "comparison", "Ownership removes the release gap"), payload: { sides: [{ label: "Before", items: ["No owner"] }, { label: "After", items: ["Mina owns notes"] }] }, bindings: { title: bindings, "sides[0].items[0]": bindings, "sides[1].items[0]": bindings }, editorialPaths: ["sides[0].label", "sides[1].label"] },
      { ...base("timeline", "timeline", "The release moves toward Friday"), payload: { mode: "process", events: [{ label: "Friday", text: "Beta launches" }] }, bindings: { title: bindings, "events[0].text": bindings }, editorialPaths: ["events[0].label"] },
      { ...base("metrics", "metrics", "One date focuses the launch"), payload: { mode: "cards", metrics: [{ label: "Launch", value: "Friday", detail: "Beta release" }] }, bindings: { title: bindings, "metrics[0].label": bindings, "metrics[0].value": bindings, "metrics[0].detail": bindings } },
      { ...base("actions", "actions", "Mina closes the release loop"), storyRole: "commitment", payload: { items: [{ task: "Publish release notes", owner: "Mina", due: "Friday" }] }, bindings: { title: bindings, "items[0].task": bindings, "items[0].owner": bindings, "items[0].due": bindings } },
    ]  
});
}
