import type { ChatTransport } from "../../llm.ts";
import type { PlanSlide, SlidePlan } from "../model/plan.ts";

export class RefineFieldError extends TypeError {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "RefineFieldError";
    this.code = code;
    this.path = path;
  }
}

export interface RefineSlideFieldInput {
  readonly plan: SlidePlan;
  readonly slideId: string;
  readonly path: string;
  readonly text: string;
  readonly instruction: string;
  readonly claimIds: readonly string[];
}

export interface RefineSlideFieldProposal {
  readonly slideId: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly claimIds: readonly string[];
  readonly instruction: string;
}

export const REFINE_FIELD_SYSTEM_PROMPT = `You rewrite one slide field from a confirmed meeting review.
Use only the evidence quotes and the current text. Do not add names, dates, numbers, or facts that are not already present.
Follow the instruction for tone, length, or structure only.
Return exactly one JSON object: {"text":"..."}`;

export function bindingKeyFor(path: string): string | null {
  if (path === "title") return "title";
  if (!path.startsWith("payload.")) return null;
  return path.slice("payload.".length);
}

export function fieldTextAt(slide: PlanSlide, path: string): string | null {
  if (path === "title") return slide.title;
  const key = bindingKeyFor(path);
  if (key === null) return null;
  let cursor: unknown = slide.payload;
  for (const match of key.matchAll(/([A-Za-z][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string | number, unknown>)[match[1] ?? Number(match[2])];
  }
  return typeof cursor === "string" ? cursor : null;
}

function parseProposal(content: string): string {
  const raw = content.trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  const parsed = JSON.parse(first >= 0 && last >= first ? raw.slice(first, last + 1) : raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RefineFieldError("INVALID_MODEL_OUTPUT", "text", "proposal must be a JSON object");
  }
  const value = parsed as Record<string, unknown>;
  const extra = Object.keys(value).find((key) => key !== "text");
  if (extra !== undefined) {
    throw new RefineFieldError("INVALID_MODEL_OUTPUT", extra, `key '${extra}' is not allowed`);
  }
  if (typeof value.text !== "string" || value.text.trim() === "") {
    throw new RefineFieldError("INVALID_MODEL_OUTPUT", "text", "text must be a non-empty string");
  }
  if (value.text.length > 2000) {
    throw new RefineFieldError("INVALID_MODEL_OUTPUT", "text", "text is too long");
  }
  return value.text.trim();
}

export async function refineSlideField(
  input: RefineSlideFieldInput,
  chat: ChatTransport,
): Promise<RefineSlideFieldProposal> {
  const instruction = input.instruction.trim();
  if (instruction.length === 0 || instruction.length > 200) {
    throw new RefineFieldError("INVALID_INSTRUCTION", "instruction", "instruction must be 1-200 characters");
  }
  const pathKey = bindingKeyFor(input.path);
  if (pathKey === null) {
    throw new RefineFieldError("INVALID_PATH", "path", "path must be title or payload.*");
  }
  const before = input.text.trim();
  if (before.length === 0) {
    throw new RefineFieldError("INVALID_TEXT", "text", "text must be a non-empty string");
  }
  const slide = input.plan.slides.find((item) => item.id === input.slideId);
  const claimIds = [...input.claimIds];
  if (slide !== undefined) {
    const stored = fieldTextAt(slide, input.path);
    const editorial = slide.editorialPaths.includes(pathKey);
    const bound = slide.bindings[pathKey] ?? [];
    if (stored !== null && !editorial && claimIds.length === 0) {
      throw new RefineFieldError("CLAIM_IDS_REQUIRED", "claimIds", "factual fields require claim IDs");
    }
    if (stored !== null && !editorial) {
      for (const [index, id] of claimIds.entries()) {
        if (!bound.includes(id)) {
          throw new RefineFieldError("UNBOUND_CLAIM", `claimIds[${index}]`, `claim '${id}' is not bound to this field`);
        }
      }
    }
  }
  const known = new Set(input.plan.claims.map((claim) => claim.id));
  for (const [index, id] of claimIds.entries()) {
    if (!known.has(id)) {
      throw new RefineFieldError("UNKNOWN_CLAIM", `claimIds[${index}]`, `unknown claim '${id}'`);
    }
  }
  const quotes = input.plan.claims
    .filter((claim) => claimIds.includes(claim.id))
    .flatMap((claim) => claim.sources.map((source) => `[${claim.id}] ${source.evidenceQuote}`));
  const raw = await chat.chat([
    `Path: ${input.path}`,
    `Current text:\n${before}`,
    `Instruction:\n${instruction}`,
    quotes.length === 0 ? "Evidence:\n(none)" : `Evidence:\n${quotes.join("\n")}`,
  ].join("\n\n"), {
    system: REFINE_FIELD_SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: 400,
    timeoutMs: 60_000,
  });
  return {
    slideId: input.slideId,
    path: input.path,
    before,
    after: parseProposal(raw),
    claimIds,
    instruction,
  };
}
