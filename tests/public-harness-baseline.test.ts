// Baseline characterization of the pre-existing public test harness lifecycle.
// Locks connection acceptance, broadcast fan-out, inbound client message ordering,
// disconnect, and static asset serving BEFORE the caret fixture extension lands,
// so later harness work cannot silently change the contract other suites rely on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();

interface RawSocketSession {
  socket: WebSocket;
  received: unknown[];
  nextServerMessage(): Promise<unknown>;
  close(): void;
}

/** Opens a raw WS client and subscribes to every frame before any trigger runs. */
async function openRawSocket(): Promise<RawSocketSession> {
  const socket = new WebSocket(`${harness.origin.replace("http:", "ws:")}/ws`);
  const received: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else received.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("baseline socket failed to open")), { once: true });
  });
  return {
    socket,
    received,
    nextServerMessage() {
      const buffered = received.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("baseline server message timeout")), 5_000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    close() {
      socket.close();
    },
  };
}

let session: RawSocketSession;

beforeAll(async () => {
  session = await openRawSocket();
  await harness.clientConnected;
});

afterAll(() => {
  session?.close();
  harness.stop();
});

describe("public test harness baseline lifecycle", () => {
  test("origin serves the shipped index and rejects traversal names", async () => {
    const index = await fetch(`${harness.origin}/`);
    const indexBody = await index.text();
    // Names outside [a-z0-9._-] are rejected outright; this is the shipped guard.
    const traversal = await fetch(`${harness.origin}/sub%2Fdir/app.js`);
    const favicon = await fetch(`${harness.origin}/favicon.ico`);

    expect(index.status).toBe(200);
    expect(indexBody).toContain('id="current-slide"');
    expect(traversal.status).toBe(404);
    expect(favicon.status).toBe(204);
  });

  test("clientConnected resolves once a websocket client is accepted", async () => {
    // Already awaited in beforeAll; resolving again must stay immediate and idempotent.
    await expect(harness.clientConnected).resolves.toBeUndefined();
  });

  test("pushMessage broadcasts the exact JSON payload to connected clients", async () => {
    const frame = session.nextServerMessage();
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", startedAt: 1_700_000_000_000 });

    expect(await frame).toEqual({
      type: "capture",
      capturing: true,
      mode: "mic",
      startedAt: 1_700_000_000_000,
    });
  });

  test("nextClientMessage resolves inbound client frames in FIFO order", async () => {
    const first = harness.nextClientMessage();
    const second = harness.nextClientMessage();
    session.socket.send(JSON.stringify({ action: "listMeetings" }));
    session.socket.send(JSON.stringify({ action: "startCapture", meeting_id: 7 }));

    expect(await first).toEqual({ action: "listMeetings" });
    expect(await second).toEqual({ action: "startCapture", meeting_id: 7 });
  });

  test("disconnectClients closes live sockets without stopping the server", async () => {
    const closed = new Promise<void>((resolve) => {
      session.socket.addEventListener("close", () => resolve(), { once: true });
    });
    harness.disconnectClients();
    await closed;

    const stillServing = await fetch(`${harness.origin}/app.js`);
    expect(stillServing.status).toBe(200);
    session = await openRawSocket();
  });
});
