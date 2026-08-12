import { file } from "bun";
import { join } from "node:path";

export interface PublicTestHarness {
  origin: string;
  clientConnected: Promise<void>;
  pushMessage(payload: unknown): void;
  /**
   * Broadcasts a raw string with no JSON encoding, so a suite can prove what
   * the client does with a frame that is not parseable at all. `pushMessage`
   * can only ever produce well-formed JSON, so without this the malformed-frame
   * contract could only be tested one level up (a valid envelope with an
   * invalid body) and never at the parser itself.
   */
  pushRaw(data: string): void;
  nextClientMessage(): Promise<unknown>;
  disconnectClients(): void;
  stop(): void;
  /** Monotonic count of frames broadcast so far; used to order subscribe/trigger. */
  readonly sentSequence: number;
  /** Resolves as soon as at least one client socket is connected (idempotent). */
  waitForClient(): Promise<void>;
  /** Every URL path the harness served, in order (external URLs never appear). */
  readonly servedPaths: readonly string[];
}

export function createPublicTestHarness(): PublicTestHarness {
  const publicDirectory = join(import.meta.dir, "..", "public");
  const sockets = new Set<{ send(data: string): void; close(): void }>();
  const clientMessageWaiters: Array<(message: unknown) => void> = [];
  const connectionWaiters: Array<() => void> = [];
  const servedPaths: string[] = [];
  let sentSequence = 0;
  let resolveClientConnected: (() => void) | null = null;
  const clientConnected = new Promise<void>((resolve) => { resolveClientConnected = resolve; });

  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        return bunServer.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      servedPaths.push(url.pathname);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      // One level of subdirectory is allowed so bundled assets (public/fonts/*)
      // are served exactly as in production; traversal is still refused outright.
      if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/i.test(name) || name.includes("..")) {
        return new Response("not found", { status: 404 });
      }
      const asset = file(join(publicDirectory, name));
      // Resolve existence before responding: streaming a missing file rejects
      // inside the server and tears the fixture down instead of returning 404.
      return asset.exists().then((exists) =>
        exists ? new Response(asset) : new Response("not found", { status: 404 }),
      );
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        resolveClientConnected?.();
        while (connectionWaiters.length > 0) connectionWaiters.shift()!();
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(_socket, data) {
        const message = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as unknown;
        clientMessageWaiters.shift()?.(message);
      },
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    clientConnected,
    get sentSequence() {
      return sentSequence;
    },
    get servedPaths() {
      return servedPaths;
    },
    waitForClient() {
      if (sockets.size > 0) return Promise.resolve();
      return new Promise<void>((resolve) => { connectionWaiters.push(resolve); });
    },
    pushMessage(payload) {
      const data = JSON.stringify(payload);
      sentSequence += 1;
      for (const socket of sockets) socket.send(data);
    },
    pushRaw(data) {
      sentSequence += 1;
      for (const socket of sockets) socket.send(data);
    },
    nextClientMessage() {
      return new Promise((resolve, reject) => {
        const waiter = (message: unknown) => {
          clearTimeout(timer);
          resolve(message);
        };
        // A timed-out waiter must also leave the queue. Leaving it in place made
        // an already-rejected promise swallow the NEXT test's first frame, so one
        // slow test silently corrupted its successor instead of failing alone.
        const timer = setTimeout(() => {
          const index = clientMessageWaiters.indexOf(waiter);
          if (index !== -1) clientMessageWaiters.splice(index, 1);
          reject(new Error("client message timeout"));
        }, 5_000);
        clientMessageWaiters.push(waiter);
      });
    },
    disconnectClients() {
      for (const socket of sockets) socket.close();
    },
    stop() {
      server.stop(true);
    },
  };
}
