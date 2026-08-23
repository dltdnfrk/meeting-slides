// Local deterministic harness: serves ./public and speaks the real WebSocket protocol.
// No external network is required or permitted for the baseline packet.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export async function startHarness(publicDir) {
  const clientMessages = [];
  const sockets = new Set();
  let onConnect = null;
  const connected = new Promise((resolve) => {
    onConnect = resolve;
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (name === "favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const resolved = normalize(join(publicDir, name));
    if (!resolved.startsWith(publicDir)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(resolved);
      response.writeHead(200, { "content-type": MIME[extname(resolved)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (data) => clientMessages.push(JSON.parse(data.toString("utf-8"))));
      ws.on("close", () => sockets.delete(ws));
      onConnect?.();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    connected,
    clientMessages,
    push(payload) {
      const data = JSON.stringify(payload);
      for (const socket of sockets) socket.send(data);
    },
    async stop() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
