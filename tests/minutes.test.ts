import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildMinutesHtml, type MinutesInput } from "../src/minutes.ts";

const transcriptVersionId = "transcript-v1";

function input(overrides: Partial<MinutesInput> = {}): MinutesInput {
  return {
    meta: {
      title: "Release planning",
      meetingDate: "2026-08-01",
      timeZone: "Asia/Seoul",
      purpose: "Approve the release",
    },
    attendees: [
      { attendeeId: "alice", displayName: "Alice" },
      { attendeeId: "bob", displayName: "Bob" },
    ],
    decisions: [{
      description: "Ship on Friday",
      attributedAttendeeId: "alice",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: 1, end_seq: 2 },
    }],
    actions: [{
      description: "Run final QA",
      assigneeAttendeeId: "bob",
      attributedAttendeeId: "alice",
      deadline: "2026-08-07",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: 2, end_seq: 2 },
    }],
    open: [{
      description: "Confirm launch budget",
      attributedAttendeeId: "bob",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: 3, end_seq: 3 },
    }],
    referencedMaterials: [{
      materialType: "link",
      title: "Launch plan",
      uri: "https://example.test/launch",
      sourceSegment: { transcript_version_id: transcriptVersionId, start_seq: 3, end_seq: 4 },
    }],
    transcript: [
      { seq: 1, speakerTurn: 1, attributedAttendeeId: "alice", text: "We will ship on Friday." },
      { seq: 2, speakerTurn: 2, attributedAttendeeId: "bob", text: "I will run final QA." },
    ],
    transcriptVersionId,
    ...overrides,
  };
}

describe("buildMinutesHtml", () => {
  test("keeps metadata, every decision, and every action in the first-page section, including empty states", () => {
    const html = buildMinutesHtml(input());
    const firstPage = html.match(/<section class="first-page"[\s\S]*?<\/section>/)?.[0] ?? "";

    expect(firstPage).toContain("Release planning");
    expect(firstPage).toContain("Ship on Friday");
    expect(firstPage).toContain("Run final QA");
    expect(firstPage).toContain("담당자");
    expect(firstPage).toContain("기한");
    expect(firstPage).not.toContain("Confirm launch budget");

    const emptyFirstPage = buildMinutesHtml(input({ decisions: [], actions: [] }))
      .match(/<section class="first-page"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(emptyFirstPage).toContain("결정 사항 없음");
    expect(emptyFirstPage).toContain("액션 항목 없음");
  });

  test("starts appendix content after a forced page break", () => {
    const html = buildMinutesHtml(input());
    const css = readFileSync(join(import.meta.dir, "..", "deck", "minutes.css"), "utf8");

    expect(html).toMatch(/<\/section>\s*<section class="appendix-page"/);
    expect(css).toMatch(/\.first-page\s*\{[^}]*break-after:\s*page/s);
    expect(css).toMatch(/\.appendix-page\s*\{[^}]*break-before:\s*page/s);
    expect(html).toContain("논의 및 미결 사항");
    expect(html).toContain("발언 귀속 및 전사 원문");
    expect(html).toContain("참조 자료");
  });

  test("prints immutable provenance coordinates for every sourced item", () => {
    const html = buildMinutesHtml(input());
    const coordinates = [...html.matchAll(/<span class="source-coordinate"[^>]*>\(([^<]+)\)<\/span>/g)]
      .map((match) => match[1]);

    expect(coordinates).toEqual([
      "transcript-v1, 1, 2",
      "transcript-v1, 2, 2",
      "transcript-v1, 3, 3",
      "transcript-v1, 3, 4",
    ]);
  });

  test("displays the canonical transcript version independently of item coordinates", () => {
    const html = buildMinutesHtml(input({
      decisions: [], actions: [], open: [], referencedMaterials: [],
      transcriptVersionId: "canonical-retranscription-v2",
    }));

    expect(html).toContain('<span class="transcript-version">canonical-retranscription-v2</span>');
  });

  test("escapes all untrusted text and attribute values", () => {
    const malicious = `<script>alert("x")</script> & 'quoted'`;
    const html = buildMinutesHtml(input({
      meta: { title: malicious, meetingDate: malicious, timeZone: malicious, purpose: malicious },
      attendees: [{ attendeeId: malicious, displayName: malicious }],
      decisions: [{
        description: malicious,
        attributedAttendeeId: malicious,
        sourceSegment: { transcript_version_id: malicious, start_seq: 1, end_seq: 1 },
      }],
      actions: [{
        description: malicious,
        assigneeAttendeeId: malicious,
        attributedAttendeeId: malicious,
        deadline: malicious,
        deadlineText: malicious,
        sourceSegment: { transcript_version_id: malicious, start_seq: 1, end_seq: 1 },
      }],
      open: [{
        description: malicious,
        sourceSegment: { transcript_version_id: malicious, start_seq: 1, end_seq: 1 },
      }],
      referencedMaterials: [{
        materialType: "link", title: malicious, uri: malicious, notes: malicious,
        sourceSegment: { transcript_version_id: malicious, start_seq: 1, end_seq: 1 },
      }],
      transcript: [{ seq: 1, speakerTurn: 1, attributedAttendeeId: malicious, text: malicious }],
      transcriptVersionId: malicious,
    }));

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('alert("x")');
    expect(html).not.toContain(`data-transcript-version-id="${malicious}"`);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;");
  });
});
