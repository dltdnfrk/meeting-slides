import type { AskUpdate } from "../protocol.ts";
import { MinutesStore } from "../minutes-store.ts";
import { askMeeting } from "../ask.ts";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { DetectorState } from "./providers.ts";
import { type WsActionHandler } from "./websocket.ts";

export function createAskController(deps: { readonly minutesStore: MinutesStore; readonly detector: DetectorState }) {
  const { minutesStore, detector } = deps;
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  function expire(key: string) {
    const timer = setTimeout(() => {
      completedAsks.delete(key);
      expiryTimers.delete(timer);
    }, 5 * 60000);
    timer.unref();
    expiryTimers.add(timer);
  }
  const askRuns = new Map<
    string,
    {
      question: string;
      requesters: Set<ServerWebSocket<undefined>>;
      run: Promise<void>;
    }
  >();
  const completedAsks = new Map<
    string,
    {
      question: string;
      update: AskUpdate;
    }
  >();
  const handleAsk: WsActionHandler = ({ ws, cmd }) => {
    const meetingId = Number(cmd.meeting_id ?? cmd.meetingId ?? 0);
    const question = typeof cmd.question === "string" ? cmd.question.trim() : "";
    const requestId = typeof cmd.requestId === "string" ? cmd.requestId : randomUUID();
    if (!Number.isSafeInteger(meetingId) || meetingId < 1) {
      ws.send(
        JSON.stringify({
          type: "ask" as const,
          requestId,
          answer: "",
          matchedCount: 0,
          error: "meetingId가 필요합니다",
        }),
      );
      return;
    }
    if (!question) {
      ws.send(
        JSON.stringify({ type: "ask" as const, requestId, answer: "", matchedCount: 0, error: "질문을 입력해 주세요" }),
      );
      return;
    }
    if (!detector.extractionTransport) {
      ws.send(
        JSON.stringify({
          type: "ask" as const,
          requestId,
          answer: "",
          matchedCount: 0,
          error: "사용 가능한 LLM 프로바이더가 없습니다",
        }),
      );
      return;
    }
    const key = `${meetingId}:${requestId}`;
    const completed = completedAsks.get(key);
    if (completed) {
      if (completed.question !== question) {
        ws.send(
          JSON.stringify({
            type: "ask" as const,
            requestId,
            answer: "",
            matchedCount: 0,
            error: "requestId가 다른 질문에 이미 사용되었습니다",
          }),
        );
      } else {
        ws.send(JSON.stringify(completed.update));
      }
      return;
    }
    const existing = askRuns.get(key);
    if (existing) {
      if (existing.question !== question) {
        ws.send(
          JSON.stringify({
            type: "ask" as const,
            requestId,
            answer: "",
            matchedCount: 0,
            error: "requestId가 다른 질문에 이미 사용되었습니다",
          }),
        );
      } else {
        existing.requesters.add(ws);
      }
      return;
    }
    const requesters = new Set<ServerWebSocket<undefined>>([ws]);
    const run = askMeeting(minutesStore, meetingId, question, detector.extractionTransport, { timeoutMs: 60000 })
      .then((result) => {
        const update: AskUpdate = {
          type: "ask",
          requestId,
          answer: result.answer,
          matchedCount: result.matchedSegments.length,
        };
        completedAsks.set(key, { question, update });
        expire(key);
        for (const requester of requesters) {
          if (requester.readyState === 1) requester.send(JSON.stringify(update));
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const update: AskUpdate = {
          type: "ask",
          requestId,
          answer: "",
          matchedCount: 0,
          error: `질문 처리 실패: ${message}`,
        };
        completedAsks.set(key, { question, update });
        expire(key);
        for (const requester of requesters) {
          if (requester.readyState === 1) requester.send(JSON.stringify(update));
        }
      })
      .finally(() => {
        askRuns.delete(key);
      });
    askRuns.set(key, { question, requesters, run });
  };
  return {
    handlers: new Map<string, WsActionHandler>([["ask", handleAsk]]),
    async close() {
      await Promise.all([...askRuns.values()].map((run) => run.run));
      for (const timer of expiryTimers) clearTimeout(timer);
      expiryTimers.clear();
      completedAsks.clear();
    },
  };
}
