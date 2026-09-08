import type { TextFitPolicy, TextMeasurer } from "./contract.ts";

export class ScriptAwareTextMeasurer implements TextMeasurer {
  measure(input: { readonly text: string; readonly fontFamily: string; readonly fontSize: number }) {
    let ems = 0;
    for (const character of input.text) {
      if (/\s/u.test(character)) ems += 0.32;
      else if (/\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) ems += 1;
      else if (/\p{P}|\p{S}/u.test(character)) ems += 0.5;
      else if (/\p{Lu}/u.test(character)) ems += 0.62;
      else ems += 0.56;
    }
    return { width: ems * input.fontSize, height: input.fontSize };
  }
}

const ROLES = ["title", "statement", "quote", "summary-marker", "summary-item", "decision", "rationale", "comparison-marker", "comparison-label", "comparison-item", "event-label", "event", "metric-label", "metric-value", "metric-detail", "action-task", "action-owner", "action-due"] as const;
const LABELS = new Set<string>(["summary-marker", "comparison-marker", "comparison-label", "event-label", "metric-label", "action-owner", "action-due"]);
const PROMINENT = new Set<string>(["statement", "quote", "decision", "metric-value", "action-task"]);

export function productionTextPolicies(): Readonly<Record<string, TextFitPolicy>> {
  return Object.freeze(Object.fromEntries(ROLES.map((role) => [role, Object.freeze({
    mode: role === "title" ? "shrink" as const : "wrap" as const,
    wordBreak: "keep-all" as const,
    overflowWrap: "break-word" as const,
    fontFloor: role === "title" ? 28 : LABELS.has(role) ? 14 : PROMINENT.has(role) ? 22 : 18,
  })])));
}
