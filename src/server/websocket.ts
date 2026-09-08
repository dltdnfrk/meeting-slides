import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ClientListener, ServerMessage } from "../protocol.ts";

export interface WsCommand {
  action?: string;
  id?: string;
  key?: string;
  model?: string;
  effort?: string;
  meeting_id?: unknown;
  meetingId?: unknown;
  purpose?: unknown;
  attendees?: unknown;
  reviewId?: unknown;
  itemId?: unknown;
  kind?: unknown;
  patch?: unknown;
  question?: unknown;
  requestId?: unknown;
  notes?: unknown;
  retry?: unknown;
  slideId?: unknown;
  path?: unknown;
  text?: unknown;
  instruction?: unknown;
  claimIds?: unknown;
  source?: unknown;
  data?: unknown;
  modelId?: unknown;
  plan?: unknown;
}
export type ReviewMutationIdentity = {
  mutationAction: "updateItem" | "confirmReview";
  meetingId: number | null;
  reviewId: string | null;
  itemId?: string | null;
};
export type WsActionHandler = (ctx: { ws: ServerWebSocket<undefined>; cmd: WsCommand }) => void;
export function requestError(ws: ServerWebSocket<undefined>, error: unknown, identity?: ReviewMutationIdentity): void {
  if (ws.readyState !== 1) return;
  const message = error instanceof Error ? error.message : String(error);
  ws.send(JSON.stringify({ type: "status" as const, text: `요청 처리 실패: ${message}`, ...identity }));
}
export function validMeetingId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function createWebSocketController(deps: {
  readonly listeners: Set<ClientListener>;
  readonly handlerMap: ReadonlyMap<string, WsActionHandler>;
  readonly hydrate: () => readonly ServerMessage[];
  readonly mutationIdentity: (cmd: WsCommand) => ReviewMutationIdentity;
}) {
  const sockets = new Map<ServerWebSocket<undefined>, ClientListener>();
  const websocket: WebSocketHandler<undefined> = {
    open(ws) {
      const listener: ClientListener = (message) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(message));
      };
      deps.listeners.add(listener);
      sockets.set(ws, listener);
      for (const message of deps.hydrate()) ws.send(JSON.stringify(message));
    },
    message(ws, data) {
      let cmd: WsCommand | undefined;
      try {
        const value: unknown = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new TypeError("command must be an object");
        cmd = value;
        deps.handlerMap.get(cmd.action ?? "")?.({ ws, cmd });
      } catch (error) {
        console.error("[ws] 메시지 처리 실패:", error instanceof Error ? error.message : String(error));
        if (ws.readyState === 1)
          requestError(
            ws,
            error,
            cmd?.action === "updateItem" || cmd?.action === "confirmReview" ? deps.mutationIdentity(cmd) : undefined,
          );
      }
    },
    close(ws) {
      const listener = sockets.get(ws);
      if (listener) deps.listeners.delete(listener);
      sockets.delete(ws);
    },
  };
  return {
    websocket,
    close() {
      for (const [ws, listener] of sockets) {
        deps.listeners.delete(listener);
        ws.close(1001, "Server closing");
      }
      sockets.clear();
    },
    get size() {
      return sockets.size;
    },
  };
}
