import type { ChatTransport } from "./llm.js";
import { parseNarrativeDeck, type NarrativeDeck } from "./scene-graph.js";
import type { MeetingStore, StoredLine } from "./store.js";

export interface NarrativeCompileResult {
  readonly narrative: NarrativeDeck;
  readonly plannerError: string | null;
  readonly usedFallback: boolean;
}

const SYSTEM_PROMPT = `You design editable meeting presentations.
Return one JSON object only. Never return HTML, Markdown, bullets, bullet lists, or layout coordinates.

Schema:
{"meetingId":number,"title":string,"slides":[
  {"intent":"cover","title":string,"subtitle"?:string} |
  {"intent":"statement","title":string,"statement":string,"support"?:string} |
  {"intent":"comparison","title":string,"left":{"label":string,"text":string},"right":{"label":string,"text":string}} |
  {"intent":"timeline","title":string,"events":[{"label":string,"text":string}]} |
  {"intent":"decision","title":string,"decision":string,"rationale"?:string} |
  {"intent":"actions","title":string,"items":[{"task":string,"owner"?:string,"due"?:string}]} |
  {"intent":"quote","title":string,"quote":string,"attribution"?:string} |
  {"intent":"closing","title":string,"statement"?:string}
]}

Build a narrative, not a transcript summary. Use the strongest semantic intent for each slide.
Every factual claim must come from the transcript. Use 4-10 slides, including one cover.
Match the transcript language. For a Korean transcript, write natural Korean without translated English jargon.
Never create slides about greetings, recording, chat questions, the meeting ending, or other meeting mechanics.
Never add generic filler such as "discussion complete", "next steps", or motivational closing copy unless the transcript states a concrete next step.
Do not repeat schema intent names in titles or visible content.`;

function jsonObject(raw: string): unknown {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("planner did not return a JSON object");
  return JSON.parse(raw.slice(first, last + 1));
}

const NOISE_LINE = /^(?:네+|예+|음+|어+|아+|아이고+|감사합니다?|수고하셨습니다?|고맙습니다?|알겠습니다?|좋아요|좋습니다|괜찮습니다|안녕하세요|안녕히\s*계세요|ㅋㅋ+|ㅎㅎ+|sorry|ok|okay|thank(?:s| you)|[-–—.=·…\s]+)$/iu;
const NOISE_FRAGMENT = /(?:아이고|두두두|맞춘다|안\s*멘트|엄마한테|誰を|逆じゃん|시이티\s*파프)/u;

function cleanLine(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/([가-힣])(?=[A-Za-z0-9])/gu, "$1 ")
    .replace(/([A-Za-z0-9])(?=[가-힣])/gu, "$1 ")
    .trim();
}

function isUsefulLine(text: string): boolean {
  const value = cleanLine(text);
  if (value.length < 12) return false;
  if (NOISE_LINE.test(value)) return false;
  if (NOISE_FRAGMENT.test(value)) return false;
  const uniqueRatio = new Set([...value.replace(/\s+/gu, "")]).size / Math.max(1, value.replace(/\s+/gu, "").length);
  if (uniqueRatio < 0.18 && value.length > 20) return false;
  const hangul = (value.match(/[가-힣]/gu) ?? []).length;
  if (hangul < 8 && !/[A-Za-z]{4,}/.test(value)) return false;
  return true;
}

function titleFromText(text: string, max = 28): string {
  const cleaned = cleanLine(text)
    .replace(/^[\s·\-–—]+/u, "")
    .replace(/[.!?。…]+$/u, "")
    .trim();
  if (cleaned.length <= max) return cleaned || "회의 기록";
  const cut = cleaned.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","), cut.lastIndexOf("·"));
  return `${(boundary > 12 ? cut.slice(0, boundary) : cut).trim()}…`;
}

function chunkLines(lines: readonly string[], size: number): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < lines.length; index += size) groups.push(lines.slice(index, index + size));
  return groups;
}

/** Planner failure path: keep only substantive speech and cap the deck so noise cannot explode slide count. */
export function fallbackNarrative(store: MeetingStore, meetingId: number, snapshot: readonly StoredLine[]): NarrativeDeck {
  const useful = snapshot.map((line) => cleanLine(line.text)).filter(isUsefulLine);
  const meeting = store.meeting(meetingId);
  const storedTitle = store.slides(meetingId)[0]?.title?.trim();
  const source = useful.length > 0 ? useful : snapshot.map((line) => cleanLine(line.text)).filter(Boolean);
  const ranked = [...source].sort((a, b) => {
    const score = (text: string) => {
      let value = Math.min(text.length, 80);
      if (/투자|팀 구성|고객사|계약|실습|IR|지표|발표|피드백|비즈니스 모델|지분|핵심 인력/.test(text)) value += 55;
      if (/신청을 해주셨|안내 드릴|메일로 안내|늦은 시간까지/.test(text)) value -= 25;
      if (/같기는|한데|일단|기본적으로|감사합니다|것것|행보성|네 하겠습니다/.test(text)) value -= 45;
      if (/^[가-힣]{1,4}(?:습니다|해요|이다)?[.!…]?$/.test(text)) value -= 40;
      if (text.length < 18) value -= 20;
      return value;
    };
    return score(b) - score(a);
  });
  const title = storedTitle && storedTitle.length >= 4 && !/^회의\s*#\d+$/u.test(storedTitle)
    ? storedTitle.slice(0, 42)
    : titleFromText(ranked[0] ?? source[0] ?? "회의 기록", 32);
  const maxBodySlides = 6;
  const groupSize = Math.max(2, Math.ceil(source.length / maxBodySlides));
  const statements = chunkLines(source, groupSize).slice(0, maxBodySlides).map((group, index) => {
    const statement = group.join(" ");
    return {
      intent: "statement" as const,
      title: titleFromText(group[0] ?? `논의 ${index + 1}`, 28),
      statement: statement.slice(0, 220) || "기록된 논의가 없습니다.",
      ...(group[1] ? { support: group.slice(1).join(" ").slice(0, 160) } : {}),
    };
  });
  return {
    meetingId,
    title,
    slides: [
      {
        intent: "cover",
        title,
        subtitle: meeting
          ? new Date(meeting.started_at).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
          : undefined,
      },
      ...statements,
    ],
  };
}

function plannerPrompt(meetingId: number, snapshot: readonly StoredLine[], repair?: string): string {
  const transcript = snapshot.map((line) => ({
    seq: line.seq,
    speaker: line.speaker,
    text: line.text,
  }));
  return `Meeting ID: ${meetingId}
Transcript JSON:
${JSON.stringify(transcript)}
${repair ? `Previous output failed validation: ${repair}\nReturn a corrected full object.` : ""}`;
}

function trimSnapshot(snapshot: readonly StoredLine[]): StoredLine[] {
  const rows = snapshot.map((line) => ({ ...line, text: cleanLine(line.text) })).filter((line) => line.text);
  // Drop trailing closing chatter so both planner and fallback stay on the meeting body.
  let end = rows.length;
  while (end > 3) {
    const tail = rows.slice(Math.max(0, end - 4), end);
    if (tail.every((line) => !isUsefulLine(line.text) || /감사|수고|종료|마치|bye|thank/i.test(line.text))) {
      end -= 1;
      continue;
    }
    break;
  }
  return rows.slice(0, end);
}

export async function compileNarrativeDeck(
  store: MeetingStore,
  meetingId: number,
  transport: ChatTransport,
  snapshot: readonly StoredLine[] = store.lines(meetingId),
): Promise<NarrativeCompileResult> {
  if (store.meeting(meetingId) === null) throw new Error(`Meeting ${meetingId} was not found`);
  const workingSnapshot = trimSnapshot(snapshot);
  let repair: string | undefined;
  const failures: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await transport.chat(plannerPrompt(meetingId, workingSnapshot, repair), {
        system: SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 6000,
        timeoutMs: 120_000,
      });
      const parsed = parseNarrativeDeck(jsonObject(raw));
      return {
        narrative: { ...parsed, meetingId },
        plannerError: null,
        usedFallback: false,
      };
    } catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      failures.push(repair);
      console.warn(`[deck-planner] attempt ${attempt + 1} failed: ${repair}`);
    }
  }
  console.warn(`[deck-planner] using fallback narrative for meeting ${meetingId}`);
  return {
    narrative: fallbackNarrative(store, meetingId, workingSnapshot),
    plannerError: failures.join(" | "),
    usedFallback: true,
  };
}
