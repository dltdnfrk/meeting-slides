import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import JSZip, { type JSZipObject } from "jszip";

import type { ResolvedAssetLayer } from "../../src/slides/assets/integration.ts";
import type {
  CompileIssue,
  FitTrace,
  GeometryElement,
  GeometryPreflightResult,
  GeometrySlide,
} from "../../src/slides/geometry/contract.ts";
import type { SlidePlan, Theme } from "../../src/slides/model/plan.ts";
import {
  EditablePptxError,
  publishEditablePptx,
  renderEditablePptx,
  type EditablePptxArtifact,
  type EditablePptxRenderRequest,
} from "../../src/slides/render/editable-pptx.ts";
import type { PipelinePublisherRequest } from "../../src/slides/server-pipeline-types.ts";
import { createEditablePptxPublisher } from "../../src/slides/server-publishers.ts";

const temporaryDirectories: string[] = [];
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const FONT_BYTES = Buffer.from("deterministic-fixture-font-v1\n", "utf8");
const PPTXGENJS_VERSION = "3.12.0";

interface Fixture {
  readonly rootDirectory: string;
  readonly request: EditablePptxRenderRequest;
  readonly assetPath: string;
  readonly fontPath: string;
  readonly assetHash: string;
  readonly fontHash: string;
}

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly targetMode: string | null;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function xmlDecode(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (entity, name: string) => ({
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    amp: "&",
  })[name] ?? entity);
}

function relationships(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)].map((match) => {
    const attributes = match[1] ?? "";
    const get = (name: string): string | null => {
      const found = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
      return found === null ? null : xmlDecode(found[1]!);
    };
    return {
      id: get("Id") ?? "",
      type: get("Type") ?? "",
      target: get("Target") ?? "",
      targetMode: get("TargetMode"),
    };
  });
}

function relationshipSourcePath(relsPath: string): string {
  if (relsPath === "_rels/.rels") return "";
  const match = relsPath.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  if (match === null) throw new Error(`invalid OPC relationships part path: ${relsPath}`);
  return posix.join(match[1]!, match[2]!);
}

function resolveRelationshipTarget(relsPath: string, target: string): string {
  if (target.startsWith("/")) return posix.normalize(target.slice(1));
  return posix.normalize(posix.join(posix.dirname(relationshipSourcePath(relsPath)), target));
}

async function textPart(archive: JSZip, path: string): Promise<string> {
  const part = archive.file(path);
  expect(part, `missing OOXML part ${path}`).not.toBeNull();
  return part!.async("string");
}

function geometryElement(
  slideId: string,
  suffix: string,
  options: {
    readonly role: "title" | "body" | "decoration";
    readonly text: string;
    readonly lines: readonly string[];
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly fontSize: number;
    readonly color: string;
    readonly readingOrder: number;
    readonly claimIds?: readonly string[];
  },
): GeometryElement {
  const fitTrace: FitTrace = {
    policy: "wrap",
    requestedFontSize: options.fontSize,
    finalFontSize: options.fontSize,
    fontFloor: options.role === "title" ? 28 : 18,
    outcome: "fit",
    lines: [...options.lines],
    attempts: [{
      fontSize: options.fontSize,
      lines: [...options.lines],
      width: options.width,
      height: options.height,
      fits: true,
    }],
  };
  const semantic = options.role !== "decoration";
  return {
    id: `${slideId}:${suffix}`,
    role: options.role,
    text: options.text,
    box: { x: options.x, y: options.y, width: options.width, height: options.height },
    tokens: semantic
      ? { font: "font.family", size: options.role === "title" ? "typography.heading.size" : "typography.body.size", color: "colors.ink" }
      : { color: "colors.coral" },
    resolvedTokens: semantic
      ? { font: "Fixture Sans", size: options.fontSize, color: options.color }
      : { color: options.color },
    accessibility: semantic
      ? { role: options.role, label: `${slideId}:${suffix}`, readingOrder: options.readingOrder }
      : { role: "presentation", label: "", readingOrder: options.readingOrder },
    evidence: semantic
      ? { fieldPath: `${slideId}.${suffix}`, claimIds: [...(options.claimIds ?? [])] }
      : null,
    lines: [...options.lines],
    fitTrace,
  };
}

function geometrySlide(slideId: string, variant: string, bodyLines: readonly string[]): GeometrySlide {
  return {
    id: `${slideId}:geometry`,
    slideId,
    layout: slideId === "slide-alpha" ? "hero" : "summary",
    canvas: { width: 1280, height: 720 },
    variant,
    elements: [
      geometryElement(slideId, "title", {
        role: "title",
        text: slideId === "slide-alpha" ? "Alpha decision" : "Beta actions",
        lines: [slideId === "slide-alpha" ? "Alpha decision" : "Beta actions"],
        x: 80,
        y: 64,
        width: 560,
        height: 72,
        fontSize: 36,
        color: "14213D",
        readingOrder: 1,
        claimIds: [slideId === "slide-alpha" ? "claim-alpha" : "claim-beta"],
      }),
      geometryElement(slideId, "body", {
        role: "body",
        text: bodyLines.join(" "),
        lines: bodyLines,
        x: 80,
        y: 176,
        width: 520,
        height: 120,
        fontSize: 22,
        color: "5B6475",
        readingOrder: 2,
        claimIds: [slideId === "slide-alpha" ? "claim-alpha" : "claim-beta"],
      }),
      geometryElement(slideId, "accent", {
        role: "decoration",
        text: "",
        lines: [],
        x: 80,
        y: 328,
        width: 160,
        height: 12,
        fontSize: 1,
        color: slideId === "slide-alpha" ? "AD4B2F" : "335C81",
        readingOrder: 3,
      }),
    ],
  };
}

function publishable(slide: GeometrySlide): GeometryPreflightResult {
  return { slide, issues: [], status: "publishable" };
}

function fixture(): Fixture {
  const rootDirectory = mkdtempSync(join(tmpdir(), "editable-pptx-contract-"));
  temporaryDirectories.push(rootDirectory);
  const assetHash = sha256(PNG_BYTES);
  const fontHash = sha256(FONT_BYTES);
  const assetRelativePath = `assets/${assetHash}.png`;
  const fontRelativePath = "fonts/fixture-sans.woff2";
  const assetPath = join(rootDirectory, assetRelativePath);
  const fontPath = join(rootDirectory, fontRelativePath);
  mkdirSync(dirname(assetPath), { recursive: true });
  mkdirSync(dirname(fontPath), { recursive: true });
  writeFileSync(assetPath, PNG_BYTES);
  writeFileSync(fontPath, FONT_BYTES);

  const theme: Theme = {
    id: "fixture-theme-v1",
    canvas: { width: 1280, height: 720 },
    font: { family: "Fixture Sans", localPath: fontRelativePath, sha256: fontHash },
    colors: {
      paper: "F6F1E8",
      raised: "FFFDF8",
      ink: "14213D",
      muted: "5B6475",
      rule: "D9D2C4",
      coral: "AD4B2F",
      blue: "335C81",
      focus: "1E5AA8",
    },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: {
      display: { size: 64, lineHeight: 68, weight: 700 },
      heading: { size: 36, lineHeight: 42, weight: 700 },
      body: { size: 22, lineHeight: 30, weight: 400 },
      label: { size: 16, lineHeight: 20, weight: 600 },
    },
    stroke: { thin: 1, strong: 3 },
    radius: { small: 8, large: 24 },
  };

  const alphaGeometry = geometrySlide("slide-alpha", "hero-with-local-image", ["First resolved line", "Second resolved line"]);
  const betaGeometry = geometrySlide("slide-beta", "summary-native", ["Owner Mina", "Due Friday"]);
  const alphaAssets: ResolvedAssetLayer = {
    id: "slide-alpha:assets",
    slideId: "slide-alpha",
    canvas: { width: 1280, height: 720 },
    placements: [{
      id: "slide-alpha:asset:fixture-image",
      assetId: "fixture-image",
      purpose: "informative",
      kind: "image",
      localPath: assetRelativePath,
      sha256: assetHash,
      mediaType: "image/png",
      sourceWidth: 1,
      sourceHeight: 1,
      byteLength: PNG_BYTES.byteLength,
      box: { x: 704, y: 0, width: 576, height: 720 },
      fit: "cover",
      accessibility: { role: "img", label: "fixture-image-alt" },
      evidence: { claimIds: ["claim-alpha"] },
    }],
  };
  const betaAssets: ResolvedAssetLayer = {
    id: "slide-beta:assets",
    slideId: "slide-beta",
    canvas: { width: 1280, height: 720 },
    placements: [],
  };

  return {
    rootDirectory,
    assetPath,
    fontPath,
    assetHash,
    fontHash,
    request: {
      deckId: "deck-editable-fixture",
      rootDirectory,
      theme,
      slides: [
        { geometry: publishable(alphaGeometry), assets: alphaAssets },
        { geometry: publishable(betaGeometry), assets: betaAssets },
      ],
    },
  };
}

function cloneRequest(request: EditablePptxRenderRequest): EditablePptxRenderRequest {
  return structuredClone(request);
}

async function expectEditableFailure(
  operation: () => Promise<unknown>,
  expected: { readonly code: string; readonly path: string },
): Promise<void> {
  try {
    await operation();
    throw new Error("expected editable PPTX operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(EditablePptxError);
    const failure = error as EditablePptxError;
    expect(failure.code).toBe(expected.code);
    expect(failure.path).toBe(expected.path);
    expect(failure.message).toContain(`[${expected.code}]`);
    expect(failure.message).toContain(expected.path);
  }
}

async function archiveEntries(archive: JSZip): Promise<Array<[string, JSZipObject]>> {
  return Object.entries(archive.files).filter(([, entry]) => !entry.dir);
}

async function assertClosedInternalRelationshipGraph(archive: JSZip): Promise<void> {
  const entries = await archiveEntries(archive);
  const relParts = entries.filter(([path]) => path.endsWith(".rels"));
  expect(relParts.length).toBeGreaterThan(0);
  for (const [relsPath, part] of relParts) {
    const parsed = relationships(await part.async("string"));
    expect(new Set(parsed.map((entry) => entry.id)).size, relsPath).toBe(parsed.length);
    for (const relationship of parsed) {
      expect(relationship.id, relsPath).toMatch(/^rId\d+$/);
      expect(relationship.type, `${relsPath}:${relationship.id}`).toMatch(/^https?:\/\//);
      expect(relationship.targetMode, `${relsPath}:${relationship.id}`).not.toBe("External");
      expect(relationship.target, `${relsPath}:${relationship.id}`).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
      const target = resolveRelationshipTarget(relsPath, relationship.target);
      expect(target.startsWith("../"), `${relsPath}:${relationship.id}`).toBe(false);
      expect(archive.file(target), `dangling ${relsPath}:${relationship.id} -> ${target}`).not.toBeNull();
    }
  }
}

function namedShapeXml(slideXml: string, objectName: string): string {
  const escaped = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = slideXml.match(new RegExp(`<p:sp>.*?<p:cNvPr[^>]*name="${escaped}"[\\s\\S]*?</p:sp>`));
  expect(found, `missing named shape ${objectName}`).not.toBeNull();
  return found![0];
}

function textRuns(shapeXml: string): string[] {
  return [...shapeXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => xmlDecode(match[1]!));
}

function notesPlaceholderText(notesXml: string): string {
  const body = notesXml.match(/<p:ph type="body"[^/]*\/>[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/);
  if (body === null || body[1] === undefined) {
    throw new Error("missing notes body placeholder text");
  }
  return xmlDecode(body[1]).replace(/\r\n/g, "\n");
}

function drawingMlFontSize(fitPx: number): number {
  return Math.round(fitPx * 0.75 * 100);
}

function publicationRequest(source: Fixture, speakerNotes: string): PipelinePublisherRequest {
  const alpha = source.request.slides[0];
  const beta = source.request.slides[1];
  if (alpha === undefined || beta === undefined) {
    throw new Error("fixture must contain two slides");
  }
  const plan: SlidePlan = {
    schemaVersion: 1,
    planId: "plan-editable",
    revision: 1,
    snapshot: {
      meetingId: 1,
      transcriptVersionId: "transcript-v1",
      contentSha256: "a".repeat(64),
      lineCount: 1,
    },
    title: "Editable fixture",
    theme: source.request.theme,
    claims: [],
    assets: [],
    slides: [
      {
        id: alpha.geometry.slide.slideId,
        layout: "hero",
        storyRole: "opening",
        title: "Alpha decision",
        payload: { variant: "cover", statement: "Alpha decision" },
        bindings: {},
        editorialPaths: [],
        assetIds: [],
        notes: speakerNotes,
      },
      {
        id: beta.geometry.slide.slideId,
        layout: "summary",
        storyRole: "argument",
        title: "Beta actions",
        payload: { mode: "overview", items: ["Owner Mina"] },
        bindings: {},
        editorialPaths: [],
        assetIds: [],
      },
    ],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
  return {
    identity: {
      planId: plan.planId,
      deckId: source.request.deckId,
      snapshot: plan.snapshot,
      slideIds: [alpha.geometry.slide.slideId, beta.geometry.slide.slideId],
      geometryIds: [alpha.geometry.slide.id, beta.geometry.slide.id],
      claimIds: ["claim-alpha"],
    },
    plan,
    assetManifest: { schemaVersion: 1, assets: [] },
    drafts: [],
    slides: [alpha.geometry, beta.geometry],
    assetLayers: [alpha.assets, beta.assets],
    managedAssetRoot: source.rootDirectory,
    priorArtifacts: [],
    outputDirectory: source.rootDirectory,
  };
}

describe("editable Geometry/Assets PPTX renderer", () => {
  test("emits a valid wide OPC package in exact slide order with editable DrawingML and local image relationships", async () => {
    const source = fixture();
    const artifact = await renderEditablePptx(source.request);

    expect(Buffer.from(artifact.bytes.subarray(0, 4))).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const archive = await JSZip.loadAsync(artifact.bytes, { checkCRC32: true });
    const names = Object.keys(archive.files);
    expect(names).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/notesSlides/notesSlide1.xml",
      "ppt/notesSlides/notesSlide2.xml",
      "ppt/theme/theme1.xml",
    ]));
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);

    const contentTypes = await textPart(archive, "[Content_Types].xml");
    expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
    expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.presentationml.slide+xml");
    const presentation = await textPart(archive, "ppt/presentation.xml");
    expect(presentation).toMatch(/<p:sldSz\s+cx="12192000"\s+cy="6858000"\s*\/>/);
    const slideIds = [...presentation.matchAll(/<p:sldId\s+id="(\d+)"\s+r:id="([^"]+)"\s*\/>/g)];
    expect(slideIds.map((entry) => Number(entry[1]))).toEqual([256, 257]);
    const presentationRels = relationships(await textPart(archive, "ppt/_rels/presentation.xml.rels"));
    const slideTargets = slideIds.map((entry) => {
      const relationship = presentationRels.find((candidate) => candidate.id === entry[2]);
      expect(relationship?.type).toEndWith("/slide");
      return relationship?.target;
    });
    expect(slideTargets).toEqual(["slides/slide1.xml", "slides/slide2.xml"]);

    const first = await textPart(archive, "ppt/slides/slide1.xml");
    const second = await textPart(archive, "ppt/slides/slide2.xml");
    const alphaTitle = namedShapeXml(first, "slide-alpha:title");
    const alphaBody = namedShapeXml(first, "slide-alpha:body");
    const alphaAccent = namedShapeXml(first, "slide-alpha:accent");
    expect(textRuns(alphaTitle)).toEqual(["Alpha decision"]);
    expect(textRuns(alphaBody)).toEqual(["First resolved line", "Second resolved line"]);
    expect(alphaTitle).toMatch(new RegExp(`<a:rPr\\b[^>]*\\bsz="${drawingMlFontSize(36)}"`));
    expect(alphaBody.match(new RegExp(`<a:rPr\\b[^>]*\\bsz="${drawingMlFontSize(22)}"`, "g"))).toHaveLength(2);
    expect(alphaBody).toMatch(/<a:br\s*\/>|<\/a:p>\s*<a:p>/);
    expect(alphaAccent).toContain('<a:prstGeom prst="rect">');
    expect(alphaAccent).toContain('<a:srgbClr val="AD4B2F"');
    expect(textRuns(namedShapeXml(second, "slide-beta:title"))).toEqual(["Beta actions"]);
    expect(textRuns(namedShapeXml(second, "slide-beta:body"))).toEqual(["Owner Mina", "Due Friday"]);

    expect(first).toContain("<p:pic>");
    expect(first).toContain('name="slide-alpha:asset:fixture-image"');
    expect(first).toContain('descr="fixture-image-alt"');
    expect(second).not.toContain("<p:pic>");
    const imageRelationships = relationships(await textPart(archive, "ppt/slides/_rels/slide1.xml.rels"))
      .filter((entry) => entry.type.endsWith("/image"));
    expect(imageRelationships).toHaveLength(1);
    expect(imageRelationships[0]!.targetMode).toBeNull();
    expect(imageRelationships[0]!.target).toMatch(/^\.\.\/media\/image\d+\.png$/);
    const packagedImagePath = resolveRelationshipTarget("ppt/slides/_rels/slide1.xml.rels", imageRelationships[0]!.target);
    const packagedImage = archive.file(packagedImagePath);
    expect(packagedImage).not.toBeNull();
    expect(Buffer.from(await packagedImage!.async("uint8array"))).toEqual(PNG_BYTES);
    expect(Buffer.from(await packagedImage!.async("uint8array")).includes(Buffer.from("Alpha decision"))).toBe(false);

    for (const [, entry] of await archiveEntries(archive)) {
      if (!/\.(xml|rels)$/i.test(entry.name)) continue;
      const xml = await entry.async("string");
      expect(xml, entry.name).not.toMatch(/<a:(?:normAutofit|spAutoFit)\b/);
      expect(xml, entry.name).not.toMatch(/\b(?:fit|autofit|shrinkText)="(?:shrink|true|1)"/i);
    }
    await assertClosedInternalRelationshipGraph(archive);
  });

  test("marks slide text run properties as ko-KR when the deck is compiled", async () => {
    const source = fixture();
    const artifact = await renderEditablePptx(source.request);
    const archive = await JSZip.loadAsync(artifact.bytes, { checkCRC32: true });
    const first = await textPart(archive, "ppt/slides/slide1.xml");
    const title = namedShapeXml(first, "slide-alpha:title");
    const body = namedShapeXml(first, "slide-alpha:body");
    const runProps = [...title.matchAll(/<a:rPr\b([^>]*)\/?>/g), ...body.matchAll(/<a:rPr\b([^>]*)\/?>/g)];
    expect(runProps.length).toBeGreaterThan(0);
    for (const match of runProps) {
      expect(match[1]).toMatch(/\blang="ko-KR"/);
    }
  });

  test("marks notes slide runs and master default run properties as ko-KR", async () => {
    const source = fixture();
    const artifact = await renderEditablePptx(source.request);
    const archive = await JSZip.loadAsync(artifact.bytes, { checkCRC32: true });
    const notes = await textPart(archive, "ppt/notesSlides/notesSlide1.xml");
    const noteRuns = [...notes.matchAll(/<a:rPr\b([^>]*)\/?>/g)];
    expect(noteRuns.length).toBeGreaterThan(0);
    for (const match of noteRuns) {
      expect(match[1]).toMatch(/\blang="ko-KR"/);
    }
    const master = await textPart(archive, "ppt/slideMasters/slideMaster1.xml");
    const defRuns = [...master.matchAll(/<a:defRPr\b([^>]*)>/g)];
    expect(defRuns.length).toBeGreaterThan(0);
    for (const match of defRuns) {
      expect(match[1]).toMatch(/\blang="ko-KR"/);
    }
  });

  test("binds notes to slide IDs and evidence, applies theme fonts/colors, and returns a deterministic semantic manifest and receipt", async () => {
    const source = fixture();
    const first = await renderEditablePptx(source.request);
    const second = await renderEditablePptx(cloneRequest(source.request));
    const archive = await JSZip.loadAsync(first.bytes, { checkCRC32: true });

    const firstSlide = await textPart(archive, "ppt/slides/slide1.xml");
    const firstSlideRels = relationships(await textPart(archive, "ppt/slides/_rels/slide1.xml.rels"));
    const firstNotesRel = firstSlideRels.find((entry) => entry.type.endsWith("/notesSlide"));
    expect(firstNotesRel).toBeDefined();
    expect(firstNotesRel!.target).toBe("../notesSlides/notesSlide1.xml");
    expect(firstSlide).not.toContain("claim-alpha");
    const firstNotes = await textPart(archive, "ppt/notesSlides/notesSlide1.xml");
    expect(firstNotes).toContain("slide-id=slide-alpha");
    expect(firstNotes).toContain("element-id=slide-alpha:title");
    expect(firstNotes).toContain("field-path=slide-alpha.title");
    expect(firstNotes).toContain("claim-id=claim-alpha");
    expect(firstNotes).toContain("asset-id=fixture-image");
    const notesRels = relationships(await textPart(archive, "ppt/notesSlides/_rels/notesSlide1.xml.rels"));
    expect(notesRels.find((entry) => entry.type.endsWith("/slide"))?.target).toBe("../slides/slide1.xml");

    const secondNotes = await textPart(archive, "ppt/notesSlides/notesSlide2.xml");
    expect(secondNotes).toContain("slide-id=slide-beta");
    expect(secondNotes).toContain("claim-id=claim-beta");
    expect(secondNotes).not.toContain("claim-alpha");

    const themeXml = await textPart(archive, "ppt/theme/theme1.xml");
    expect(themeXml).toMatch(/<a:majorFont>[\s\S]*?<a:latin typeface="Fixture Sans"/);
    expect(themeXml).toMatch(/<a:minorFont>[\s\S]*?<a:latin typeface="Fixture Sans"/);
    for (const color of Object.values(source.request.theme.colors)) {
      expect(themeXml, `theme color ${color}`).toContain(`val="${color}"`);
    }

    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      format: "editable-pptx",
      deckId: "deck-editable-fixture",
      renderer: { name: "pptxgenjs", version: PPTXGENJS_VERSION },
      canvas: { width: 1280, height: 720, layout: "LAYOUT_WIDE" },
      slideIds: ["slide-alpha", "slide-beta"],
      counts: { slides: 2, textObjects: 4, nativeShapes: 2, images: 1, notes: 2 },
    });
    expect(first.manifest.slides.map((entry) => ({
      slideId: entry.slideId,
      slideNumber: entry.slideNumber,
      geometryId: entry.geometryId,
      objectIds: entry.objectIds,
      assetIds: entry.assetIds,
      evidenceClaimIds: entry.evidenceClaimIds,
    }))).toEqual([
      {
        slideId: "slide-alpha",
        slideNumber: 1,
        geometryId: "slide-alpha:geometry",
        objectIds: ["slide-alpha:title", "slide-alpha:body", "slide-alpha:accent", "slide-alpha:asset:fixture-image"],
        assetIds: ["fixture-image"],
        evidenceClaimIds: ["claim-alpha"],
      },
      {
        slideId: "slide-beta",
        slideNumber: 2,
        geometryId: "slide-beta:geometry",
        objectIds: ["slide-beta:title", "slide-beta:body", "slide-beta:accent"],
        assetIds: [],
        evidenceClaimIds: ["claim-beta"],
      },
    ]);
    expect(first.manifest.assets).toEqual([{
      assetId: "fixture-image",
      placementId: "slide-alpha:asset:fixture-image",
      slideId: "slide-alpha",
      mediaType: "image/png",
      byteLength: PNG_BYTES.byteLength,
      sha256: source.assetHash,
      alternativeText: "fixture-image-alt",
      evidenceClaimIds: ["claim-alpha"],
    }]);
    expect(first.manifestJson).toBe(`${JSON.stringify(first.manifest)}\n`);
    expect(first.manifestJson).toBe(second.manifestJson);

    expect(first.receipt).toMatchObject({
      schemaVersion: 1,
      deckId: "deck-editable-fixture",
      byteLength: first.bytes.byteLength,
      pptxSha256: sha256(first.bytes),
      manifestSha256: sha256(first.manifestJson),
      counts: first.manifest.counts,
    });
    expect(first.receiptJson).toBe(`${JSON.stringify(first.receipt)}\n`);
    expect(first.receiptJson).toBe(second.receiptJson);
    expect(Buffer.from(first.bytes)).toEqual(Buffer.from(second.bytes));
  });

  test("keeps PlanSlide speaker notes before the identity string in the notes slide", async () => {
    const source = fixture();
    const speakerNotes = "State the Friday launch decision.";
    const published = await createEditablePptxPublisher()(publicationRequest(source, speakerNotes));
    const pptx = published.files.find((file) => file.relativePath === "editable/deck.pptx");
    if (pptx === undefined) throw new Error("publisher did not emit editable/deck.pptx");
    const archive = await JSZip.loadAsync(pptx.bytes, { checkCRC32: true });
    const notesXml = await textPart(archive, "ppt/notesSlides/notesSlide1.xml");
    const identity = "plan-editable; slide-alpha:geometry; slide-alpha";
    const [firstLine, secondLine] = notesPlaceholderText(notesXml).split("\n");
    expect(firstLine).toBe(speakerNotes);
    expect(secondLine).toBe(identity);
  });

  test("rejects blocked geometry, missing or mutated assets, unsupported media, duplicate IDs, and unresolved fonts with typed paths", async () => {
    const blockedFixture = fixture();
    const blocked = cloneRequest(blockedFixture.request);
    const blockedIssue: CompileIssue = {
      code: "text-overflow",
      severity: "error",
      path: "elements[1].fitTrace",
      elementIds: ["slide-alpha:body"],
      message: "fixture overflow",
    };
    blocked.slides[0]!.geometry = {
      ...blocked.slides[0]!.geometry,
      issues: [blockedIssue],
      status: "blocked",
    };
    await expectEditableFailure(
      () => renderEditablePptx(blocked),
      { code: "PPTX_GEOMETRY_BLOCKED", path: "slides[0].geometry" },
    );

    const missingFixture = fixture();
    rmSync(missingFixture.assetPath);
    await expectEditableFailure(
      () => renderEditablePptx(missingFixture.request),
      { code: "PPTX_ASSET_MISSING", path: "slides[0].assets.placements[0].localPath" },
    );

    const changedFixture = fixture();
    writeFileSync(changedFixture.assetPath, Buffer.concat([PNG_BYTES, Buffer.from([0])]));
    await expectEditableFailure(
      () => renderEditablePptx(changedFixture.request),
      { code: "PPTX_ASSET_HASH_MISMATCH", path: "slides[0].assets.placements[0].sha256" },
    );

    const mediaFixture = fixture();
    const unsupported = cloneRequest(mediaFixture.request);
    unsupported.slides[0]!.assets.placements[0]!.mediaType = "video/mp4" as never;
    await expectEditableFailure(
      () => renderEditablePptx(unsupported),
      { code: "PPTX_UNSUPPORTED_MEDIA", path: "slides[0].assets.placements[0].mediaType" },
    );

    const duplicateFixture = fixture();
    const duplicate = cloneRequest(duplicateFixture.request);
    duplicate.slides[1]!.geometry.slide = {
      ...duplicate.slides[1]!.geometry.slide,
      slideId: "slide-alpha",
    };
    duplicate.slides[1]!.assets = {
      ...duplicate.slides[1]!.assets,
      slideId: "slide-alpha",
    };
    await expectEditableFailure(
      () => renderEditablePptx(duplicate),
      { code: "PPTX_DUPLICATE_ID", path: "slides[1].geometry.slide.slideId" },
    );

    const fontFixture = fixture();
    rmSync(fontFixture.fontPath);
    await expectEditableFailure(
      () => renderEditablePptx(fontFixture.request),
      { code: "PPTX_FONT_UNRESOLVED", path: "theme.font.localPath" },
    );
  });

  test("publishes only a complete hash-bound artifact and never leaves a partial final or temporary file", async () => {
    const source = fixture();
    const artifact = await renderEditablePptx(source.request);
    const outputDirectory = join(source.rootDirectory, "published");
    mkdirSync(outputDirectory);
    const outputPath = join(outputDirectory, "meeting.pptx");
    const corrupted: EditablePptxArtifact = {
      ...artifact,
      bytes: artifact.bytes.subarray(0, 31),
    };

    await expectEditableFailure(
      () => publishEditablePptx(corrupted, outputPath),
      { code: "PPTX_PARTIAL_PUBLICATION", path: "artifact.bytes" },
    );
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(outputDirectory)).toEqual([]);

    const publication = await publishEditablePptx(artifact, outputPath);
    expect(publication).toEqual({
      outputPath,
      byteLength: artifact.bytes.byteLength,
      pptxSha256: artifact.receipt.pptxSha256,
      manifestSha256: artifact.receipt.manifestSha256,
    });
    expect(readFileSync(outputPath)).toEqual(Buffer.from(artifact.bytes));
    expect(readdirSync(outputDirectory)).toEqual(["meeting.pptx"]);
    expect(relative(source.rootDirectory, publication.outputPath)).toBe("published/meeting.pptx");
  });
});
