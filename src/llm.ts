// ============================================================
// llm.ts - OpenAI-compatible API 클라이언트 + 블록 감지
// ============================================================
// 어떤 프로바이더든 동일한 chat/completions 인터페이스로 호출.
// 한국어 회의 컨텍스트에서 주제 블록을 감지하고 슬라이드를 생성한다.
//
// 주의: Alibaba Token Plan은 /v1이 아니라 /compatible-mode/v1 사용.
// config.ts에서 baseURL은 /compatible-mode/v1까지 포함한다.
// 주의: GLM-5.2는 reasoning 모델 — thinking 토큰이 별도 소모되므로
// max_tokens를 충분히 잡고, content가 비면 reasoning_content에서 JSON 추출.

import { LLMProviderConfig } from "./config.js";
import { parseLiveMeetingCard, type LiveMeetingCard } from "./slide-spec.js";

export interface BlockDetectionResult extends LiveMeetingCard {
  shouldAdvance: boolean;
}

/** HTTP든 CLI든 블록 감지 클라이언트가 만족해야 하는 공통 인터페이스. */
export interface BlockDetector {
  detectBlock(sentences: string[]): Promise<BlockDetectionResult>;
  ping(): Promise<boolean>;
}

export interface DeckPlannerInput {
  meetingId: number;
  transcript: Array<{ seq: number; ts: number; speaker: number | null; text: string }>;
  liveSlideAnchors: Array<{ idx: number; title: string; bullets: string[]; startedAt: number }>;
}

export interface DeckPlannerRepair {
  validationError: string;
}

/** HTTP and CLI model clients share this batch-planning contract. */
export interface DeckPlanner {
  planDeck(input: DeckPlannerInput, repair?: DeckPlannerRepair): Promise<unknown>;
}

export type MeetingLLM = BlockDetector & DeckPlanner;

/**
 * 모델 출력에서 MeetingCard JSON을 추출하고 엄격히 검증한다. GLM의
 * reasoning_content처럼 앞뒤에 텍스트가 붙어도 JSON 객체 자체는 추출한다.
 * 잘못된 출력은 예외로 올려 세션의 provider failure/fallback 경로를 사용한다.
 */
export function parseBlockDetectionJson(content: string): BlockDetectionResult {
  const raw = content.trim();
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  const jsonStr = firstBrace >= 0 && lastBrace >= firstBrace
    ? raw.slice(firstBrace, lastBrace + 1)
    : raw;
  const parsed = JSON.parse(jsonStr) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("detection must be a JSON object");
  }

  const value = parsed as Record<string, unknown>;
  const allowed = new Set(["shouldAdvance", "title", "kicker", "bullets", "emphasis"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`detection.${unknown} is not allowed`);
  if (typeof value.shouldAdvance !== "boolean") {
    throw new TypeError("detection.shouldAdvance must be a boolean");
  }

  const card = parseLiveMeetingCard({
    title: value.title,
    ...(value.kicker === undefined ? {} : { kicker: value.kicker }),
    bullets: value.bullets,
    ...(value.emphasis === undefined ? {} : { emphasis: value.emphasis }),
  });
  if (card.bullets.length < 1) {
    throw new TypeError("detection.bullets must contain 1-6 items");
  }
  return { shouldAdvance: value.shouldAdvance, ...card };
}

interface ChatChoice {
  message?: {
    content?: string;
    reasoning_content?: string;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

export const SYSTEM_PROMPT = `당신은 실시간 한국어 회의를 화면용 MeetingCard로 구조화합니다.
최근 발언에 실제로 나온 정보만 사용하고, 아래 JSON 스키마를 정확히 따르세요.

{
  "shouldAdvance": boolean,
  "title": string,
  "kicker"?: string,
  "bullets": string[1..6],
  "emphasis"?: string
}

필드 작성 규칙:
- title: 현재 안건을 분명하게 요약한 짧은 한국어 제목
- kicker: 회의 단계나 맥락이 유용할 때만 쓰는 짧은 라벨
- bullets: 핵심 사실, 논점, 합의 또는 할 일을 1~6개의 간결한 한국어 문장으로 정리
- emphasis: 결정, 위험 또는 다음 행동 중 특히 강조할 한 줄이 있을 때만 작성
- 선택 필드는 근거가 없으면 키 자체를 생략

shouldAdvance 판단 규칙:
- 완전히 다른 안건으로 넘어가거나, 이전 논의를 맺고 새 논의를 시작하면 true
- 같은 안건의 보충 설명, 화자 교체, 세부 질문은 false
- 확신이 없으면 false

반드시 유효한 JSON 객체만 출력하세요. 마크다운, 설명, 사고 과정, 추가 키는 금지합니다.`;

export const DECK_PLANNER_SYSTEM_PROMPT = `당신은 전체 한국어 회의 전사와 실시간 슬라이드 앵커를 바탕으로 발표용 DeckOutline을 설계합니다.
모델은 HTML/CSS/마크다운을 절대 출력하지 않고 아래 JSON 객체만 출력합니다.

최상위 필드: meetingId(number), title(string), style(string), slides(array), source(optional object).
슬라이드 kind와 필드:
- cover: {kind,title,subtitle?,kicker?}
- section: {kind,title,kicker?,bullets:[1..6]}
- summary: {kind,title,bullets:[1..6],emphasis?}
- decision: {kind,title,decision,rationale?:[0..6]}
- actions: {kind,title,actions:[{text,owner?,due?}]}
- closing: {kind,title,bullets:[0..6],emphasis?}

첫 슬라이드는 cover, 마지막은 closing이며 그 사이에 최소 한 장의 내용 슬라이드를 둡니다.
전사에 근거한 결정과 액션만 사용하고, liveSlideAnchors는 논의 구간과 제목을 잡는 보조 근거로 사용합니다.
추가 키와 렌더링 코드는 금지합니다.`;

export function buildDeckPlannerUserPrompt(input: DeckPlannerInput, repair?: DeckPlannerRepair): string {
  const repairText = repair === undefined
    ? ""
    : `\n이전 응답이 다음 검증 오류로 거부되었습니다: ${repair.validationError}\n스키마에 맞게 새 JSON 객체를 작성하세요.\n`;
  return `요청 meetingId: ${input.meetingId}${repairText}\n전체 입력:\n${JSON.stringify(input)}\n\nJSON 객체로만 응답하세요.`;
}

// GLM-5.2 reasoning 모델은 thinking 토큰 때문에 응답이 느릴 수 있음.
// 행잉 요청이 session.detecting을 영원히 고정하지 않도록 요청에 상한을 둔다.
const DETECT_TIMEOUT_MS = 30_000;
const PLAN_TIMEOUT_MS = 120_000;
const PING_TIMEOUT_MS = 10_000;

export class LLMClient implements MeetingLLM {
  constructor(private cfg: LLMProviderConfig) {}

  private chatURL(): string {
    const base = this.cfg.baseURL.replace(/\/$/, "");
    if (/\/v1$/.test(base) || /\/compatible-mode\/v1$/.test(base)) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }

  async detectBlock(sentences: string[]): Promise<BlockDetectionResult> {
    if (sentences.length === 0) {
      return { shouldAdvance: false, title: "", bullets: [] };
    }

    const userPrompt = `최근 회의 문장들:
${sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}

JSON으로만 응답하세요.`;

    // GLM-5.2 reasoning 모델: thinking 토큰이 별도 소모 → max_tokens 충분히.
    const body = {
      model: this.cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" as const },
    };

    const resp = await fetch(this.chatURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`LLM API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as ChatResponse;
    const msg = data.choices?.[0]?.message;
    // content 우선; 비어있으면 reasoning_content에서 JSON 추출 (GLM reasoning 대응)
    const raw = msg?.content ?? msg?.reasoning_content ?? "";
    return parseBlockDetectionJson(raw);
  }

  async planDeck(input: DeckPlannerInput, repair?: DeckPlannerRepair): Promise<unknown> {
    const resp = await fetch(this.chatURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: "system", content: DECK_PLANNER_SYSTEM_PROMPT },
          { role: "user", content: buildDeckPlannerUserPrompt(input, repair) },
        ],
        temperature: 0.2,
        max_tokens: 6000,
        response_format: { type: "json_object" as const },
      }),
      signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`LLM API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResponse;
    const msg = data.choices?.[0]?.message;
    return msg?.content ?? msg?.reasoning_content ?? "";
  }

  async ping(): Promise<boolean> {
    // chat/completions가 실제 작동 엔드포인트이므로 이것으로 핑.
    try {
      const resp = await fetch(this.chatURL(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 50,
        }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
