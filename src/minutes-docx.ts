import JSZip from "jszip";

import {
  attendeeName,
  coordinateLabel,
  displayProvider,
  displayTimeZone,
  type MinutesInput,
  type MinutesSourceSegment,
} from "./minutes.ts";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

/** XML 텍스트 노드 이스케이프 — HTML esc와 같은 문자를 같은 순서로 치환해 양쪽 결과가 대응되게 한다. */
function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** HTML minutes의 좌표 스팬이 보여주는 값(라벨 + 튜플)을 DOCX 텍스트로 재현한다. */
function coordinateText(source: MinutesSourceSegment): string {
  return `${coordinateLabel(source)} (${source.transcript_version_id},${source.start_seq},${source.end_seq})`;
}

function run(text: string, bold = false, size?: number): string {
  // F23 analog: Wordproofing 언어를 run 단위로 지정해 한국어 맞춤법 검사가 동작하게 한다.
  const rPr = [bold ? "<w:b/>" : "", size ? `<w:sz w:val="${size}"/>` : "", '<w:lang w:val="ko-KR" w:eastAsia="ko-KR"/>'].filter(Boolean).join("");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

function paragraph(text: string, options: { bold?: boolean; size?: number; before?: number; after?: number } = {}): string {
  const spacing = [
    options.before ? `w:before="${options.before}"` : "",
    options.after ? `w:after="${options.after}"` : "",
  ].filter(Boolean).join(" ");
  return `<w:p>${spacing ? `<w:pPr><w:spacing ${spacing}/></w:pPr>` : ""}${run(text, options.bold, options.size)}</w:p>`;
}

function bullet(text: string): string {
  return `<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">• ${xmlText(text)}</w:t></w:r></w:p>`;
}

function heading(text: string, level: 1 | 2): string {
  return paragraph(text, { bold: true, size: level === 1 ? 36 : 28, before: 240, after: 120 });
}

function table(widths: number[], headers: string[], rows: string[][]): string {
  // A4 인쇄 폭(9638 twips) 안에서 열 너비 합이 실제 테이블 폭과 일치해야 Word가 열을 자르지 않는다.
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (value: string, header: boolean, index: number) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/></w:tcPr><w:p>${run(value, header)}</w:p></w:tc>`;
  const row = (values: string[], header: boolean) => `<w:tr>${values.map((value, index) => cell(value, header, index)).join("")}</w:tr>`;
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
    `${row(headers, true)}${rows.map((values) => row(values, false)).join("")}</w:tbl>`;
}

function decisionsTable(input: MinutesInput): string {
  const rows = input.decisions.map((item) => [
    item.description,
    attendeeName(input, item.attributedAttendeeId),
    coordinateText(item.sourceSegment),
  ]);
  return heading("결정 사항", 2) + (rows.length ? table([4800, 1600, 3200], ["결정", "발언자", "원문 위치"], rows) : paragraph("결정 사항 없음"));
}

function actionsTable(input: MinutesInput): string {
  const rows = input.actions.map((item) => {
    const deadline = item.deadline
      ? item.deadlineText ? `${item.deadline} (${item.deadlineText})` : item.deadline
      : item.deadlineText ?? "미정";
    return [
      item.description,
      attendeeName(input, item.attributedAttendeeId),
      attendeeName(input, item.assigneeAttendeeId),
      deadline,
      coordinateText(item.sourceSegment),
    ];
  });
  return heading("할 일", 2) + (rows.length ? table([3600, 1400, 1400, 1400, 1800], ["할 일", "발언자", "담당자", "기한", "원문 위치"], rows) : paragraph("할 일 없음"));
}

function openItems(input: MinutesInput): string {
  if (!input.open.length) return paragraph("미정 사항이나 다음 안건 없음");
  return input.open.map((item) =>
    bullet(`${item.description} — 발언자 ${attendeeName(input, item.attributedAttendeeId)} · ${coordinateText(item.sourceSegment)}`),
  ).join("");
}

function materials(input: MinutesInput): string {
  if (!input.referencedMaterials.length) return paragraph("참조 자료 없음");
  const typeLabel: Record<MinutesInput["referencedMaterials"][number]["materialType"], string> = {
    document: "문서", figure: "그림", link: "링크", data: "데이터", other: "기타",
  };
  return input.referencedMaterials.map((item) => {
    const detail = [item.uri, item.notes].filter((value): value is string => Boolean(value)).join(" · ");
    const source = item.sourceSegment ? ` · ${coordinateText(item.sourceSegment)}` : " · 원문 위치 없음";
    return bullet(`${typeLabel[item.materialType]} ${item.title ?? item.uri ?? "제목 없음"}${detail ? ` — ${detail}` : ""}${source}`);
  }).join("");
}

function transcript(input: MinutesInput): string {
  if (!input.transcript.length) return paragraph("전사 원문 없음");
  return input.transcript.map((line) => {
    const speaker = line.attributedAttendeeId
      ? attendeeName(input, line.attributedAttendeeId)
      : line.speakerTurn === null ? "화자 미상" : `화자 ${line.speakerTurn}`;
    const source: MinutesSourceSegment = { transcript_version_id: input.transcriptVersionId, start_seq: line.seq, end_seq: line.seq };
    return bullet(`${speaker} — ${line.text} · ${coordinateText(source)}`);
  }).join("");
}

function documentXml(input: MinutesInput): string {
  const meta = input.meta;
  const provider = meta.provider ? ` · ${displayProvider(meta.provider)}` : "";
  const attendeeList = input.attendees.length
    ? input.attendees.map((attendee) => attendee.displayName).join(", ")
    : "등록된 참석자 없음";
  const body = [
    paragraph("회의록", { size: 20, after: 60 }),
    paragraph(meta.title, { bold: true, size: 40, after: 120 }),
    ...(meta.purpose ? [paragraph(meta.purpose, { after: 120 })] : []),
    paragraph(`일시: ${meta.meetingDate} · ${displayTimeZone(meta.timeZone)}${provider}`),
    paragraph(`참석자: ${attendeeList}`),
    paragraph(`전사 원문: ${input.transcriptVersionId} (원문 연결됨)`),
    heading("결정 사항", 1),
    decisionsTable(input),
    actionsTable(input),
    heading("논의 및 근거 기록", 1),
    paragraph("각 항목은 전사 원문과 연결되어 있습니다", { size: 20 }),
    heading("논의 및 미정 사항", 2),
    openItems(input),
    heading("참조 자료", 2),
    materials(input),
    heading("발언자 및 최종 전사 원문", 2),
    transcript(input),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
  `<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOCUMENT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
  `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>`;

const FONT_TABLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:font w:name="Arial"/><w:font w:name="Malgun Gothic"/></w:fonts>`;

/** 확정된 minutes 데이터(HTML/JSON과 같은 MinutesInput)에서 최소 OPC(DOCX) 패키지를 만든다. */
export async function buildMinutesDocx(input: MinutesInput): Promise<Uint8Array> {
  const zip = new JSZip();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlText(input.meta.title)}</dc:title>` +
    `<dc:creator>Meeting Slides</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`;
  zip.file("[Content_Types].xml", CONTENT_TYPES, { date: FIXED_ZIP_DATE });
  zip.file("_rels/.rels", RELATIONSHIPS, { date: FIXED_ZIP_DATE });
  zip.file("docProps/core.xml", core, { date: FIXED_ZIP_DATE });
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELATIONSHIPS, { date: FIXED_ZIP_DATE });
  zip.file("word/styles.xml", STYLES, { date: FIXED_ZIP_DATE });
  zip.file("word/settings.xml", SETTINGS, { date: FIXED_ZIP_DATE });
  zip.file("word/fontTable.xml", FONT_TABLE, { date: FIXED_ZIP_DATE });
  zip.file("word/document.xml", documentXml(input), { date: FIXED_ZIP_DATE });
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}
