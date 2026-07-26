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

export interface BlockDetectionResult {
  shouldAdvance: boolean;
  blockTitle: string;
  bullets: string[];
}

/** HTTP든 CLI든 블록 감지 클라이언트가 만족해야 하는 공통 인터페이스. */
export interface BlockDetector {
  detectBlock(sentences: string[]): Promise<BlockDetectionResult>;
  ping(): Promise<boolean>;
}

/**
 * 모델 출력에서 블록 감지 JSON을 추출한다. GLM reasoning_content처럼 앞뒤에
 * 사고 과정이 붙은 출력도 첫 { 부터 마지막 } 까지 잘라 파싱한다.
 */
export function parseBlockDetectionJson(content: string): BlockDetectionResult {
  const raw = content.trim().length > 0 ? content : "{}";
  try {
    const jsonStr = raw.includes("{")
      ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
      : raw;
    const parsed = JSON.parse(jsonStr) as Partial<BlockDetectionResult>;
    const bulletsRaw = Array.isArray(parsed.bullets) ? parsed.bullets : [];
    return {
      shouldAdvance: Boolean(parsed.shouldAdvance),
      blockTitle: String(parsed.blockTitle ?? "").slice(0, 50),
      bullets: bulletsRaw.map((b) => String(b).slice(0, 80)).slice(0, 6),
    };
  } catch {
    console.error("[LLM] JSON 파싱 실패:", raw.slice(0, 200));
    return { shouldAdvance: false, blockTitle: "(파싱 실패)", bullets: [] };
  }
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

export const SYSTEM_PROMPT = `당신은 실시간 한국어 회의 전사를 분석하는 어시스턴트입니다.

입력: 최근 회의 발언 문장들
출력: JSON 객체 (reasoning_content 없이 content에 JSON만)

역할:
1. 현재 다루고 있는 주제 블록의 제목을 10-15자 이내로 요약
2. 블록의 핵심 요점 3-5개를 불렛으로 추출 (각 25자 이내)
3. 주제가 바뀌었는지 판단 (shouldAdvance=true: 새 주제 블록 시작)

주제 전환 판단 기준:
- 완전히 다른 안건으로 넘어감 (예: 일정 → 기술 설계)
- 이전 결론을 맺고 새 논의 시작
- 단순한 화자 교체나 부가 설명은 전환 아님

반드시 JSON만 출력 (사고 과정 금지):
{"shouldAdvance": false, "blockTitle": "...", "bullets": ["...", "..."]}`;

// GLM-5.2 reasoning 모델은 thinking 토큰 때문에 응답이 느릴 수 있음.
// 행잉 요청이 session.detecting을 영원히 고정하지 않도록 요청에 상한을 둔다.
const DETECT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

export class LLMClient {
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
      return { shouldAdvance: false, blockTitle: "", bullets: [] };
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
