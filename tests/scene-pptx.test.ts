import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

import { composeNarrativeDeck, type NarrativeDeck } from "../src/scene-graph.ts";
import { writeSceneDeckPptx } from "../src/scene-pptx.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native PPTX scene renderer", () => {
  test("writes editable OOXML text and shapes from the shared scene", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meeting-slides-pptx-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "meeting.pptx");
    const narrative: NarrativeDeck = {
      meetingId: 3,
      title: "제품 출시",
      slides: [
        { intent: "cover", title: "제품 출시", subtitle: "최종 운영안" },
        {
          intent: "comparison",
          title: "출시안 비교",
          left: { label: "A안", text: "빠른 출시" },
          right: { label: "B안", text: "품질 우선" },
        },
      ],
    };

    await writeSceneDeckPptx(composeNarrativeDeck(narrative), outputPath);

    const bytes = readFileSync(outputPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const archive = await JSZip.loadAsync(bytes);
    expect(archive.file("ppt/slides/slide1.xml")).not.toBeNull();
    expect(archive.file("ppt/slides/slide2.xml")).not.toBeNull();
    const secondSlide = await archive.file("ppt/slides/slide2.xml")!.async("string");
    expect(secondSlide).toContain("출시안 비교");
    expect(secondSlide).toContain("빠른 출시");
    expect(secondSlide).toContain("<a:t>");
    expect(secondSlide).not.toContain("bullets");
  });
});
