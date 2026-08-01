export interface MinutesMeta {
  title: string;
  meetingDate: string;
  timeZone: string;
  purpose?: string | null;
  provider?: string | null;
}

export interface MinutesAttendee {
  attendeeId: string;
  displayName: string;
}

export interface MinutesSourceSegment {
  transcript_version_id: string;
  start_seq: number;
  end_seq: number;
}

interface MinutesItem {
  description: string;
  sourceSegment: MinutesSourceSegment;
  attributedAttendeeId?: string | null;
}

export interface MinutesDecision extends MinutesItem {}

export interface MinutesAction extends MinutesItem {
  assigneeAttendeeId?: string | null;
  deadline?: string | null;
  deadlineText?: string | null;
}

export interface MinutesOpenItem extends MinutesItem {}

export interface MinutesReferencedMaterial {
  materialType: "document" | "figure" | "link" | "data" | "other";
  title?: string | null;
  uri?: string | null;
  notes?: string | null;
  sourceSegment?: MinutesSourceSegment | null;
}

export interface MinutesTranscriptLine {
  seq: number;
  speakerTurn: number | null;
  text: string;
  attributedAttendeeId?: string | null;
  capturedAtMs?: number | null;
}

export interface MinutesInput {
  meta: MinutesMeta;
  attendees: MinutesAttendee[];
  decisions: MinutesDecision[];
  actions: MinutesAction[];
  open: MinutesOpenItem[];
  referencedMaterials: MinutesReferencedMaterial[];
  transcript: MinutesTranscriptLine[];
  transcriptVersionId: string;
}

function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character] ?? character));
}

function coordinate(source: MinutesSourceSegment): string {
  return `<span class="source-coordinate" data-transcript-version-id="${esc(source.transcript_version_id)}" data-start-seq="${esc(source.start_seq)}" data-end-seq="${esc(source.end_seq)}">(${esc(source.transcript_version_id)}, ${esc(source.start_seq)}, ${esc(source.end_seq)})</span>`;
}

function attendeeName(input: MinutesInput, attendeeId: string | null | undefined): string {
  if (!attendeeId) return "미지정";
  return input.attendees.find((attendee) => attendee.attendeeId === attendeeId)?.displayName ?? attendeeId;
}

function decisionsTable(input: MinutesInput): string {
  const rows = input.decisions.length
    ? input.decisions.map((item) => `          <tr>
            <td>${esc(item.description)}</td>
            <td>${esc(attendeeName(input, item.attributedAttendeeId))}</td>
            <td>${coordinate(item.sourceSegment)}</td>
          </tr>`).join("\n")
    : '          <tr><td class="empty" colspan="3">결정 사항 없음</td></tr>';
  return `<div class="minutes-block decisions-block">
        <h2>결정 사항</h2>
        <table>
          <thead><tr><th>결정</th><th>발언자</th><th>근거 좌표</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function actionsTable(input: MinutesInput): string {
  const rows = input.actions.length
    ? input.actions.map((item) => `          <tr>
            <td>${esc(item.description)}</td>
            <td>${esc(attendeeName(input, item.assigneeAttendeeId))}</td>
            <td>${esc(item.deadline ?? item.deadlineText ?? "미정")}</td>
            <td>${coordinate(item.sourceSegment)}</td>
          </tr>`).join("\n")
    : '          <tr><td class="empty" colspan="4">액션 항목 없음</td></tr>';
  return `<div class="minutes-block actions-block">
        <h2>액션 항목</h2>
        <table>
          <thead><tr><th>액션</th><th>담당자</th><th>기한</th><th>근거 좌표</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function openItems(input: MinutesInput): string {
  if (!input.open.length) return '<p class="empty">미결 또는 다음 안건 없음</p>';
  return `<ol class="document-list">
${input.open.map((item) => `          <li><p>${esc(item.description)}</p><p class="item-meta">발언자 ${esc(attendeeName(input, item.attributedAttendeeId))} · ${coordinate(item.sourceSegment)}</p></li>`).join("\n")}
        </ol>`;
}

function materials(input: MinutesInput): string {
  if (!input.referencedMaterials.length) return '<p class="empty">참조 자료 없음</p>';
  return `<ul class="document-list">
${input.referencedMaterials.map((item) => {
    const heading = item.title ?? item.uri ?? "제목 없음";
    const detail = [item.uri, item.notes].filter((value): value is string => Boolean(value)).map(esc).join(" · ");
    const source = item.sourceSegment ? ` · ${coordinate(item.sourceSegment)}` : "";
    return `          <li><p><span class="material-type">${esc(item.materialType)}</span> ${esc(heading)}</p>${detail ? `<p>${detail}</p>` : ""}<p class="item-meta">${source || "근거 좌표 없음"}</p></li>`;
  }).join("\n")}
        </ul>`;
}

function transcript(input: MinutesInput): string {
  if (!input.transcript.length) return '<p class="empty">전사 원문 없음</p>';
  return `<ol class="transcript-list">
${input.transcript.map((line) => {
    const speaker = line.attributedAttendeeId
      ? attendeeName(input, line.attributedAttendeeId)
      : line.speakerTurn === null ? "화자 미상" : `화자 ${line.speakerTurn}`;
    return `          <li value="${esc(line.seq)}"><span class="speaker">${esc(speaker)}</span><span>${esc(line.text)}</span></li>`;
  }).join("\n")}
        </ol>`;
}

export function buildMinutesHtml(input: MinutesInput): string {
  const purpose = input.meta.purpose ? `<p class="purpose">${esc(input.meta.purpose)}</p>` : "";
  const provider = input.meta.provider ? ` · ${esc(input.meta.provider)}` : "";
  const attendeeList = input.attendees.length
    ? input.attendees.map((attendee) => esc(attendee.displayName)).join(", ")
    : "등록된 참석자 없음";

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${esc(input.meta.title)} · 회의록</title>
    <link rel="stylesheet" href="minutes.css" />
  </head>
  <body>
    <main class="minutes-document">
      <section class="first-page" aria-label="결정 및 액션 요약">
        <header class="minutes-header">
          <p class="eyebrow">MEETING MINUTES</p>
          <h1>${esc(input.meta.title)}</h1>
          ${purpose}
          <dl class="meeting-meta">
            <div><dt>일시</dt><dd>${esc(input.meta.meetingDate)} · ${esc(input.meta.timeZone)}${provider}</dd></div>
            <div><dt>참석자</dt><dd>${attendeeList}</dd></div>
            <div><dt>전사 버전</dt><dd><span class="transcript-version">${esc(input.transcriptVersionId)}</span></dd></div>
          </dl>
        </header>
        ${decisionsTable(input)}
        ${actionsTable(input)}
      </section>
      <section class="appendix-page" aria-label="회의록 부록">
        <header class="appendix-header">
          <p class="eyebrow">APPENDIX</p>
          <h2>논의 및 근거 기록</h2>
          <p>정본 전사 버전 <span class="transcript-version">${esc(input.transcriptVersionId)}</span></p>
        </header>
        <div class="minutes-block">
          <h2>논의 및 미결 사항</h2>
          ${openItems(input)}
        </div>
        <div class="minutes-block">
          <h2>참조 자료</h2>
          ${materials(input)}
        </div>
        <div class="minutes-block transcript-block">
          <h2>발언 귀속 및 전사 원문</h2>
          ${transcript(input)}
        </div>
      </section>
    </main>
  </body>
</html>
`;
}
