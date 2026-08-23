const port = Number(process.env.HTTP_PORT ?? "54745");
const receiptPath = process.env.RECEIPT_PATH!;
const readyFifo = process.env.READY_FIFO!;
const sockets = new Set<ServerWebSocket<unknown>>();
const events: Record<string, unknown>[] = [];

function record(kind: string, detail: Record<string, unknown> = {}) {
  const event = { sequence: events.length + 1, kind, ...detail };
  events.push(event);
  Bun.write(receiptPath, events.map((item) => JSON.stringify(item)).join("\n") + "\n");
}
function broadcast(frame: Record<string, unknown>) {
  const payload = JSON.stringify(frame);
  for (const socket of sockets) socket.send(payload);
  record("broadcast", { frame });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && server.upgrade(request)) return;
    if (url.pathname === "/control/capturing" && request.method === "POST") {
      const startedAt = Date.now();
      broadcast({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt });
      broadcast({ type: "line", text: "네이티브 시각 검증 문장입니다.", ts: startedAt, speaker: 1 });
      return new Response("capturing\n");
    }
    if (url.pathname === "/control/idle" && request.method === "POST") {
      broadcast({ type: "capture", capturing: false, mode: "mic", phase: "idle", startedAt: null });
      return new Response("idle\n");
    }
    if (url.pathname === "/receipt") return Response.json(events);
    if (url.pathname === "/") {
      record("workspace-get", {
        host: request.headers.get("host"),
        userAgent: request.headers.get("user-agent") ?? "",
      });
      return new Response(`<!doctype html><html><head><title>Meeting Slides - F3 isolated</title></head><body><main id="runtime-bootstrap"><h1>F3 isolated native visual endpoint</h1><p>http://localhost:${port}/</p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      record("websocket-open", { clients: sockets.size });
      socket.send(JSON.stringify({ type: "capture", capturing: false, mode: "mic", phase: "idle", startedAt: null }));
    },
    message(_socket, message) {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch {}
      record("client-command", { raw, parsed });
    },
    close(socket) {
      sockets.delete(socket);
      record("websocket-close", { clients: sockets.size });
    },
  },
});
record("server-ready", { hostname: server.hostname, port: server.port });
const fifo = Bun.file(readyFifo).writer();
fifo.write("ready\n");
await fifo.end();
