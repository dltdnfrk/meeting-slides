import { file } from "bun";
import { join } from "node:path";

export interface PublicTestHarness {
  origin: string;
  clientConnected: Promise<void>;
  pushMessage(payload: unknown): void;
  nextClientMessage(): Promise<unknown>;
  disconnectClients(): void;
  stop(): void;
}

export function createPublicTestHarness(): PublicTestHarness {
  const publicDirectory = join(import.meta.dir, "..", "public");
  const sockets = new Set<{ send(data: string): void; close(): void }>();
  const clientMessageWaiters: Array<(message: unknown) => void> = [];
  let resolveClientConnected: (() => void) | null = null;
  const clientConnected = new Promise<void>((resolve) => { resolveClientConnected = resolve; });

  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        return bunServer.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[a-z0-9._-]+$/i.test(name)) return new Response("not found", { status: 404 });
      return new Response(file(join(publicDirectory, name)));
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        resolveClientConnected?.();
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
    pushMessage(payload) {
      const data = JSON.stringify(payload);
      for (const socket of sockets) socket.send(data);
    },
    nextClientMessage() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("client message timeout")), 5_000);
        clientMessageWaiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
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
