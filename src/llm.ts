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

export interface ChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatTransport {
  chat(prompt: string, options?: ChatOptions): Promise<string>;
}

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

  // 구 프롬프트 호환: isNewBlock → shouldAdvance
  if (!("shouldAdvance" in value) && typeof value.isNewBlock === "boolean") {
    value.shouldAdvance = value.isNewBlock;
    delete value.isNewBlock;
  }

  const allowed = new Set(["shouldAdvance", "title", "kicker", "bullets", "emphasis", "kind"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`detection.${unknown} is not allowed`);
  if (typeof value.shouldAdvance !== "boolean") {
    throw new TypeError("detection.shouldAdvance must be a boolean");
  }

  if (!value.shouldAdvance) {
    return { shouldAdvance: false, title: "", bullets: [] };
  }

  const card = parseLiveMeetingCard({
    title: value.title,
    bullets: value.bullets,
    kicker: value.kicker,
    emphasis: value.emphasis,
    kind: value.kind,
  });

  if (isLowQualityMeetingCard(card)) {
    return { shouldAdvance: false, title: "", bullets: [] };
  }

  return { shouldAdvance: true, ...card };
}

/** 스크린샷의 "회의 종료 / 회의가 종료되었습니다" 류 메타 카드 하드 차단. */
const META_TITLE = /^(회의\s*(시작|종료|재개|진행|안내|정리)|인사|테스트|녹음|연결|대기|마무리|클로징|오프닝|안건\s*없음|논의\s*진행)$/i;
const META_BULLET = /(회의[가이를를]?\s*(시작|종료)|녹음을\s*(시작|중지)|안녕하세요|반갑습니다|수고하셨습니다|테스트입니다|들(?:리|리시)나요|접속(?:됐| 됐)|슬라이드\s*앱|논의를\s*진행|종료합니다|종료되었습니다)/i;
const HOLLOW_BULLET = /^(네|좋아요|알겠습니다|좋습니다|그렇습니다|진행합니다|논의합니다|확인합니다|확인이 필요합니다|수고하셨습니다)[.!…]?$/i;

export function isLowQualityMeetingCard(card: LiveMeetingCard): boolean {
  const title = card.title.trim();
  if (!title || META_TITLE.test(title)) return true;
  if (/^(회의|미팅)/.test(title) && /(종료|시작|재개|진행)/.test(title)) return true;

  const bullets = card.bullets.map((b) => b.trim()).filter(Boolean);
  if (bullets.length === 0) return true;
  if (bullets.every((b) => META_BULLET.test(b) || HOLLOW_BULLET.test(b))) return true;
  // 극단적으로 짧은 불릿만 거부 (한글 2~4자도 유효 요점일 수 있음)
  if (bullets.every((b) => b.length < 2)) return true;

  const norm = (s: string) => s.replace(/[\s.。·]/g, "");
  // 제목과 불릿이 사실상 동일할 때만 반복으로 본다 (includes 오탐 금지)
  if (bullets.length === 1 && title.length >= 4) {
    const nb = norm(bullets[0]);
    const nt = norm(title);
    if (nb === nt || nb === nt + "입니다" || nb === nt + "다") return true;
  }
  if (bullets.length === 1 && /되었습니다\.?$/.test(bullets[0]) && bullets[0].length < 24) return true;
  return false;
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

export const SYSTEM_PROMPT = `당신은 실시간 회의 서기입니다. 대화에 실제로 나온 사실·결정·액션만 MeetingCard JSON으로 정리합니다.

스키마 (키 이름 절대 변경 금지):
{
  "shouldAdvance": boolean,
  "title": string,
  "kicker"?: string,
  "bullets": string[],
  "emphasis"?: string,
  "kind"?: "cover" | "section" | "topic" | "decision" | "actions" | "summary"
}

## shouldAdvance=true 조건
원문에 구체 정보(결정/액션/수치/담당/기한/리스크)가 있고 아래 중 하나일 때만 true:
1) 주제가 바뀜  2) 다음 안건으로 명시 전환  3) 결론 후 새 논의 시작
부연·동의·한두 문장·주제 불명이면 false.

## 절대 금지 → shouldAdvance=false, title="", bullets=[]
- 회의 메타: 시작/종료/휴식/재개/녹음/테스트/연결 (예: "회의 종료", "회의 시작")
- 인사·잡담·리액션만 ("안녕하세요", "네", "들리나요")
- 앱/버튼/프롬프트/에러 등 도구 이야기
- 원문에 없는 창작, 상투적 마무리, 제목 반복 불릿
- 공허 서술: "~되었습니다", "논의를 진행합니다"

나쁜 예 (절대 출력 금지):
{"shouldAdvance":true,"title":"회의 종료","bullets":["회의가 종료되었습니다."]}
{"shouldAdvance":true,"title":"인사","bullets":["안녕하세요"]}
{"shouldAdvance":true,"title":"논의 진행","bullets":["논의를 진행합니다"]}

## 카드 작성 (shouldAdvance=true일 때만)

## kind (shouldAdvance=true일 때 권장)
라이브 무대가 바로 쓰는 레이아웃. 내용에 맞게 하나만 고른다:
- cover: 오프닝·아젠다 소개
- section: 큰 구간 전환(불릿 거의 없음)
- topic: 일반 논의(기본)
- decision: 합의/확정 핵심 (emphasis는 "결정: "으로)
- actions: 담당·기한·할 일
- summary: 여러 포인트 묶음 정리
불명확하면 topic.

- title: 8~18자 명사구. 동사 종결·감탄·메타 제목 금지.
- bullets: 1~4개, 각 18~40자. 결정/액션/수치/담당/기한/리스크만.
- kicker?: 2~8자 안건 분류
- emphasis?: "결정: "|"액션: "|"리스크: "로 시작
shouldAdvance=false면 반드시 {"shouldAdvance":false,"title":"","bullets":[]}.
JSON 객체 하나만. 코드펜스·설명 금지.

좋은 예:
{"shouldAdvance":true,"title":"베타 배포 일정","kicker":"일정","bullets":["금요일 베타 배포로 확정","QA 마감 수요일 18시","릴리스 노트 민수 담당"],"emphasis":"결정: 금요일 베타 배포","kind":"decision"}
{"shouldAdvance":false,"title":"","bullets":[]}
`;

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
// 범용 chat은 긴 추출 프롬프트를 다룰 수 있어 감지보다 여유 있게 잡는다.
const CHAT_TIMEOUT_MS = 60_000;

export class LLMClient implements MeetingLLM, ChatTransport {
  constructor(private cfg: LLMProviderConfig) {}

  private chatURL(): string {
    const base = this.cfg.baseURL.replace(/\/$/, "");
    if (/\/v1$/.test(base) || /\/compatible-mode\/v1$/.test(base)) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }

  async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
    const messages = [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      { role: "user" as const, content: prompt },
    ];
    const resp = await fetch(this.chatURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 6000,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? CHAT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`LLM API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResponse;
    const message = data.choices?.[0]?.message;
    return message?.content ?? message?.reasoning_content ?? "";
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
