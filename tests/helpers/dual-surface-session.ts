// One local Bun session driving BOTH product surfaces (plan caret-clone-redesign, Todo 16).
//
// This is the fixture counterpart of `server.ts` for the cross-surface contract:
// it serves the real `public/` assets, accepts real WebSocket clients (the
// Chromium workspace AND the compiled native minibar driver), and reproduces the
// server's capture lifecycle message-for-message, including:
//
//   * the exact per-connection hydration order of `server.ts:1049-1060`
//     (status, providers, sttModels, capture, slide snapshot, transcript
//     snapshot) so a reconnecting or reloaded client re-enters the same state;
//   * `captureMessage()` byte-shape: `type`, `capturing`, `mode`, the optional
//     `startedAt`, and the optional `phase` this task adds additively;
//   * the trailing `line` frames the real `stopCapture()` flush emits AFTER the
//     stop has been broadcast;
//   * `startCapture` / `stopCapture` / `selectMeeting` / `listMeetings` handling
//     under their existing action and payload spellings.
//
// What it deliberately does NOT do: run whisper, an LLM, SQLite or the deck
// engine. Todo 16 is about state synchronisation between the two clients over
// the existing wire, not about the capture engine.
//
// Determinism rules: no timer drives anything. Every transition happens because
// the test asked for it, and `startedAt` is an injected constant, so both
// surfaces derive identical timer text from identical server truth.

import { file } from "bun";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";

export interface DualSurfaceMeeting {
  id: number;
  title: string;
  started_at: number;
  status: "open" | "ended";
}

export interface TranscriptEntryFixture {
  text: string;
  ts: number;
  speaker?: number;
}

export type CapturePhaseWire = "idle" | "starting" | "capturing" | "stopping" | "switching-model";

export interface ClientRecord {
  /** Stable identity so a test can disconnect one surface and not the other. */
  label: string;
  socket: ServerWebSocket<{ label: string }>;
}

export interface RecordedCommand {
  label: string;
  raw: string;
  parsed: unknown;
}

export interface DualSurfaceSessionOptions {
  /** Server-authoritative capture origin, in epoch milliseconds. */
  startedAt: number;
  meetings?: DualSurfaceMeeting[];
  /** When false the fixture emits phase-less capture frames (compatibility). */
  emitPhase?: boolean;
  mode?: string;
}

export interface DualSurfaceSession {
  readonly origin: string;
  readonly port: number;
  readonly wsUrl: string;
  /** Every client command received, in arrival order, with its sender label. */
  readonly commands: readonly RecordedCommand[];
  /** Commands filtered to one action name. */
  commandsOf(action: string): RecordedCommand[];
  /**
   * Resolves on the NEXT command with this action to arrive after the call.
   * Armed before the trigger, settled by the socket's own message handler, and
   * bounded: there is no polling loop anywhere in this path.
   */
  nextCommand(action: string, timeoutMs?: number): Promise<RecordedCommand>;
  readonly clientLabels: readonly string[];
  /** Resolves once a client with this label has completed hydration. */
  waitForClient(label: string): Promise<void>;
  /** Drop exactly one client's socket. The other surface keeps its own. */
  disconnectClient(label: string): void;
  disconnectAll(): void;

  // ── capture lifecycle, mirroring server.ts ──
  startCapture(options?: { phase?: CapturePhaseWire }): void;
  /** Broadcasts the stop-in-flight snapshot; trailing lines may still follow. */
  beginStop(): void;
  /** Broadcasts the authoritative idle snapshot that ends the meeting. */
  finishStop(options?: { endedNaturally?: boolean }): void;
  /** The natural recorder failure path: no stop was requested. */
  recorderFailed(reason: string): void;

  // ── raw emission ──
  broadcast(message: unknown): void;
  broadcastRaw(payload: string): void;
  sendTo(label: string, message: unknown): void;
  line(entry: TranscriptEntryFixture): void;
  caption(entry: TranscriptEntryFixture): void;
  setMeetings(meetings: DualSurfaceMeeting[]): void;
  readonly capturing: boolean;
  readonly phase: CapturePhaseWire;
  /** Frames broadcast so far; orders a trigger against a subscription. */
  readonly sentSequence: number;

  stop(): void;
}

export function createDualSurfaceSession(options: DualSurfaceSessionOptions): DualSurfaceSession {
  const publicDirectory = join(import.meta.dir, "..", "..", "public");
  const emitPhase = options.emitPhase ?? true;
  const mode = options.mode ?? "mic";

  const clients = new Map<string, ServerWebSocket<{ label: string }>>();
  const hydrationWaiters = new Map<string, Array<() => void>>();
  const commands: RecordedCommand[] = [];
  const commandWaiters = new Set<{
    action: string;
    resolve(command: RecordedCommand): void;
  }>();
  let meetings: DualSurfaceMeeting[] = options.meetings ? [...options.meetings] : [];
  let transcript: TranscriptEntryFixture[] = [];
  let capturing = false;
  let phase: CapturePhaseWire = "idle";
  let startedAt: number | null = null;
  let sentSequence = 0;

  /**
   * The exact shape of `server.ts:captureMessage()`. `phase` is additive and
   * omitted entirely when the fixture is asked to behave like a phase-less
   * server, which is how the compatibility contract is proven.
   */
  function captureMessage(): Record<string, unknown> {
    // Byte-for-byte the shape of `server.ts:captureMessage()`: the recording
    // origin stays on the wire for as long as the server still owns a capture,
    // which includes the whole `stopping` window, so neither surface has to
    // invent a stopwatch to keep the timer alive while the tail flushes.
    const serverOwnsCapture = capturing || phase === "stopping";
    return {
      type: "capture",
      capturing,
      mode,
      ...(emitPhase ? { phase } : {}),
      ...(serverOwnsCapture && startedAt !== null ? { startedAt } : {}),
    };
  }

  function meetingsMessage(): Record<string, unknown> {
    return { type: "meetings", items: meetings };
  }

  function send(socket: ServerWebSocket<{ label: string }>, message: unknown): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  function broadcast(message: unknown): void {
    sentSequence += 1;
    for (const socket of clients.values()) send(socket, message);
  }

  function broadcastRaw(payload: string): void {
    sentSequence += 1;
    for (const socket of clients.values()) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  // The single generic is the per-socket data type; that is what carries the
  // client label so one surface can be severed without touching the other.
  const server = Bun.serve<{ label: string }>({
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        // The label identifies the surface so one client can be severed alone.
        // `public/app.js` builds its socket URL from `location.host` alone and
        // carries no query, so an unlabelled upgrade IS the browser workspace;
        // the native driver always states its label explicitly.
        const label = url.searchParams.get("client") ?? "browser";
        return bunServer.upgrade(request, { data: { label } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/i.test(name) || name.includes("..")) {
        return new Response("not found", { status: 404 });
      }
      const asset = file(join(publicDirectory, name));
      return asset.exists().then((exists) =>
        exists ? new Response(asset) : new Response("not found", { status: 404 }),
      );
    },
    websocket: {
      open(socket) {
        clients.set(socket.data.label, socket);
        // Hydration order copied from `server.ts` websocket.open.
        send(socket, { type: "status", text: "연결됨" });
        send(socket, { type: "providers", list: [], current: "" });
        send(socket, { type: "sttModels", models: [], selectedModelId: null });
        send(socket, captureMessage());
        send(socket, { type: "slide", current: null, history: [] });
        send(socket, {
          type: "transcript",
          entries: [...transcript],
          reason: "snapshot",
          truncated: false,
        });
        send(socket, meetingsMessage());
        const waiters = hydrationWaiters.get(socket.data.label);
        if (waiters) {
          hydrationWaiters.delete(socket.data.label);
          for (const resolve of waiters) resolve();
        }
      },
      close(socket) {
        if (clients.get(socket.data.label) === socket) clients.delete(socket.data.label);
      },
      message(socket, data) {
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const record: RecordedCommand = { label: socket.data.label, raw, parsed };
        commands.push(record);

        const action = (parsed as { action?: unknown } | null)?.action;
        for (const waiter of [...commandWaiters]) {
          if (waiter.action !== action) continue;
          commandWaiters.delete(waiter);
          waiter.resolve(record);
        }
        if (action === "listMeetings") {
          send(socket, meetingsMessage());
        } else if (action === "selectMeeting") {
          const meetingId = (parsed as { meetingId?: number }).meetingId;
          const meeting = meetings.find((item) => item.id === meetingId);
          send(socket, {
            type: "meeting",
            meetingId,
            title: meeting?.title ?? `회의 #${meetingId}`,
            transcript: [...transcript],
            current: null,
            history: [],
            compiled: null,
          });
        }
        // startCapture / stopCapture are NOT auto-answered: the test drives the
        // authoritative lifecycle so every snapshot is an explicit act.
      },
    },
  });

  // `Bun.serve({ port: 0 })` always resolves a concrete port; the type is
  // optional only because a unix-socket server has none.
  const port = server.port ?? 0;

  const api: DualSurfaceSession = {
    origin: `http://localhost:${port}`,
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    get commands() {
      return commands;
    },
    commandsOf(action) {
      return commands.filter((entry) => (entry.parsed as { action?: string } | null)?.action === action);
    },
    nextCommand(action, timeoutMs = 5_000) {
      return new Promise<RecordedCommand>((resolveCommand, reject) => {
        const waiter = {
          action,
          resolve(command: RecordedCommand) {
            clearTimeout(timer);
            resolveCommand(command);
          },
        };
        const timer = setTimeout(() => {
          commandWaiters.delete(waiter);
          reject(new Error(`dual-surface session never received a "${action}" command within ${timeoutMs}ms`));
        }, timeoutMs);
        commandWaiters.add(waiter);
      });
    },
    get clientLabels() {
      return [...clients.keys()];
    },
    get capturing() {
      return capturing;
    },
    get phase() {
      return phase;
    },
    get sentSequence() {
      return sentSequence;
    },
    waitForClient(label) {
      if (clients.has(label)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = hydrationWaiters.get(label) ?? [];
        waiters.push(resolve);
        hydrationWaiters.set(label, waiters);
      });
    },
    disconnectClient(label) {
      clients.get(label)?.close();
    },
    disconnectAll() {
      for (const socket of clients.values()) socket.close();
    },
    startCapture({ phase: requested } = {}) {
      capturing = true;
      phase = requested ?? "capturing";
      startedAt = options.startedAt;
      broadcast(captureMessage());
      broadcast(meetingsMessage());
      broadcast({ type: "status", text: "녹음을 시작했습니다. 말씀해 주세요" });
    },
    beginStop() {
      // `server.ts:stopCapture()` sets `capturing = false` and broadcasts BEFORE
      // the flush that produces trailing lines. `phase: "stopping"` is the
      // additive metadata that keeps both surfaces truthful in that window, and
      // `startedAt` deliberately survives it.
      capturing = false;
      phase = "stopping";
      broadcast(captureMessage());
    },
    finishStop({ endedNaturally = false } = {}) {
      capturing = false;
      phase = "idle";
      startedAt = null;
      broadcast(captureMessage());
      broadcast(meetingsMessage());
      broadcast({
        type: "status",
        text: endedNaturally
          ? "음성 입력이 종료되었습니다"
          : "녹음 중지 완료. 슬라이드와 전사 원문을 저장할 수 있습니다",
      });
    },
    recorderFailed(reason) {
      // The natural-failure path: no client asked for a stop, the recorder died.
      capturing = false;
      phase = "idle";
      startedAt = null;
      broadcast(captureMessage());
      broadcast({ type: "status", text: reason });
    },
    broadcast,
    broadcastRaw,
    sendTo(label, message) {
      const socket = clients.get(label);
      if (socket) {
        sentSequence += 1;
        send(socket, message);
      }
    },
    line(entry) {
      transcript.push(entry);
      broadcast({ type: "line", ...entry });
    },
    caption(entry) {
      broadcast({ type: "caption", ...entry });
    },
    setMeetings(next) {
      meetings = [...next];
      broadcast(meetingsMessage());
    },
    stop() {
      server.stop(true);
    },
  };

  return api;
}
