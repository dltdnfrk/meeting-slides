import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMinutesDocx } from "../src/minutes-docx.ts";
import { buildMinutesHtml, type MinutesInput } from "../src/minutes.ts";

function fixture(): MinutesInput {
  return {
    meta: {
      title: "Meeting Notes",
      meetingDate: "2026-08-07T00:00:00.000Z",
      timeZone: "Asia/Seoul",
      purpose: "CRM handoff",
      provider: "cli:test",
    },
    attendees: [
      { attendeeId: "alice", displayName: "Alice" },
      { attendeeId: "bob", displayName: "Bob" },
    ],
    decisions: [{
      description: "Launch approved",
      attributedAttendeeId: "bob",
      sourceSegment: { transcript_version_id: "transcript-version-v1", start_seq: 2, end_seq: 2 },
    }],
    actions: [{
      description: "Ship CRM bundle",
      attributedAttendeeId: "alice",
      assigneeAttendeeId: "alice",
      deadline: "2026-08-07",
      deadlineText: "by August 7",
      sourceSegment: { transcript_version_id: "transcript-version-v1", start_seq: 1, end_seq: 1 },
    }],
    open: [{
      description: "Pricing remains open",
      attributedAttendeeId: "bob",
      sourceSegment: { transcript_version_id: "transcript-version-v1", start_seq: 3, end_seq: 3 },
    }],
    referencedMaterials: [{
      materialType: "link",
      title: "CRM spec",
      uri: "https://example.test/spec",
      sourceSegment: { transcript_version_id: "transcript-version-v1", start_seq: 1, end_seq: 2 },
    }],
    transcript: [
      { seq: 1, speakerTurn: 1, text: "Alice will ship the CRM bundle." },
      { seq: 2, speakerTurn: 2, text: "Bob approved launch." },
      { seq: 3, speakerTurn: null, text: "Pricing remains open." },
    ],
    transcriptVersionId: "transcript-version-v1",
  };
}

function docxText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&(lt|gt|quot|apos|amp);/g, (entity, name: string) => ({
      lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
    })[name] ?? entity);
}

describe("buildMinutesDocx", () => {
  test("opens in the macOS textutil DOCX consumer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minutes-docx-consumer-"));
    const path = join(directory, "minutes.docx");
    try {
      writeFileSync(path, await buildMinutesDocx(fixture()));
      const opened = spawnSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", path], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(opened.status, opened.stderr).toBe(0);
      expect(opened.stdout).toContain("Launch approved");
      expect(opened.stdout).toContain("Ship CRM bundle");
      expect(opened.stdout).toContain("(transcript-version-v1,2,2)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("emits a real OPC package (PK signature) with document and relationships parts", async () => {
    const bytes = await buildMinutesDocx(fixture());

    expect(Buffer.from(bytes.subarray(0, 4)).toString("latin1")).toBe("PK\x03\x04");

    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(archive.files)).toEqual(expect.arrayContaining([
      "[Content_Types].xml", "_rels/.rels", "word/document.xml",
    ]));
    const document = await archive.file("word/document.xml")!.async("string");
    expect(document).toContain('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">');
  });

  test("preserves every evidence field and coordinate the confirmed minutes HTML shows", async () => {
    const input = fixture();
    const html = buildMinutesHtml(input);
    const bytes = await buildMinutesDocx(input);
    const archive = await JSZip.loadAsync(bytes);
    const text = docxText(await archive.file("word/document.xml")!.async("string"));

    // 문서 메타 — HTML에 보이는 값과 동일해야 한다.
    for (const fragment of ["Meeting Notes", "CRM handoff", "Alice", "Bob", "원문 연결됨", "transcript-version-v1"]) {
      expect(html).toContain(fragment);
      expect(text).toContain(fragment);
    }
    // 결정/할 일/미정 항목 — 설명, 발언자, 기한, 좌표(라벨 + 튜플)를 빠뜨리지 않는다.
    for (const fragment of [
      "Launch approved", "Ship CRM bundle", "Pricing remains open",
      "1번째 문장", "2번째 문장", "3번째 문장",
      "(transcript-version-v1,1,1)", "(transcript-version-v1,2,2)", "(transcript-version-v1,3,3)",
      "by August 7",
    ]) {
      expect(text).toContain(fragment);
    }
    // 참조 자료 — 유형, 제목, URI, 좌표.
    for (const fragment of ["링크", "CRM spec", "https://example.test/spec", "(transcript-version-v1,1,2)"]) {
      expect(text).toContain(fragment);
    }
    // 전사 원문 — 화자와 원문 텍스트.
    for (const fragment of ["화자 1", "화자 2", "화자 미상", "Alice will ship the CRM bundle.", "Bob approved launch.", "Pricing remains open."]) {
      expect(text).toContain(fragment);
    }
  });


  test("marks every run with ko-KR proofing language so Word spells Korean text correctly (F23 analog)", async () => {
    const bytes = await buildMinutesDocx(fixture());
    const archive = await JSZip.loadAsync(bytes);
    const xml = await archive.file("word/document.xml")!.async("string");

    expect(xml).toContain('<w:rPr><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr>');
    // 제목/헤더/본문/전사에 걸쳐 run 단위로 적용되어야 한다 (단일 지점이 아님).
    const occurrences = xml.match(/<w:lang w:val="ko-KR" w:eastAsia="ko-KR"\/>/g)?.length ?? 0;
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  test("keeps table column widths inside the A4 printable width", async () => {
    const bytes = await buildMinutesDocx(fixture());
    const archive = await JSZip.loadAsync(bytes);
    const xml = await archive.file("word/document.xml")!.async("string");
    const tables = [...xml.matchAll(/<w:tbl>(.*?)<\/w:tbl>/g)].map((match) => match[1]);
    expect(tables).toHaveLength(2); // 결정 3열 + 할 일 5열
    for (const tableXml of tables) {
      const total = Number(tableXml.match(/<w:tblW w:w="(\d+)" w:type="dxa"\/>/)?.[1] ?? 0);
      // 행마다 동일한 열 너비를 갖는다 — 첫 행(헤더)의 열만 합산한다.
      const firstRow = tableXml.match(/<w:tr>(.*?)<\/w:tr>/s)?.[1] ?? "";
      const columns = [...firstRow.matchAll(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/g)].map((match) => Number(match[1]));
      // A4 11906 twips - 좌우 여백 1134*2 = 9638이 넘으면 Word가 잘라낸다.
      expect(total).toBeLessThanOrEqual(9638);
      expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
      expect(columns.every((width) => width > 0)).toBe(true);
    }
  });
});
