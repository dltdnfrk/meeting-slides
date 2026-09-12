import { posix } from "node:path";
import JSZip from "jszip";

import type { EditablePptxRenderRequest } from "./editable-pptx-types.ts";
import { pptxFailure } from "./editable-pptx-types.ts";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlDecode(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (entity, name: string) => ({
    lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
  })[name] ?? entity);
}

function themeColorScheme(request: EditablePptxRenderRequest): string {
  const color = request.theme.colors;
  return `<a:clrScheme name="${xmlEscape(request.theme.id)}">` +
    `<a:dk1><a:srgbClr val="${color.ink}"/></a:dk1>` +
    `<a:lt1><a:srgbClr val="${color.paper}"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="${color.muted}"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="${color.raised}"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${color.coral}"/></a:accent1>` +
    `<a:accent2><a:srgbClr val="${color.blue}"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="${color.focus}"/></a:accent3>` +
    `<a:accent4><a:srgbClr val="${color.rule}"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="${color.paper}"/></a:accent5>` +
    `<a:accent6><a:srgbClr val="${color.raised}"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="${color.focus}"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="${color.blue}"/></a:folHlink></a:clrScheme>`;
}

export async function canonicalizeEditablePptx(bytes: Uint8Array, request: EditablePptxRenderRequest): Promise<Uint8Array> {
  let source: JSZip;
  try {
    source = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (error) {
    pptxFailure("PPTX_INVALID_PACKAGE", "artifact.bytes", error instanceof Error ? error.message : "invalid ZIP package");
  }
  const target = new JSZip();
  const mediaNames = Object.keys(source.files).filter((name) => /^ppt\/media\/image-.+\.[a-z\d]+$/i.test(name));
  const renamedMedia = new Map(mediaNames.map((name, index) => {
    const extension = name.slice(name.lastIndexOf("."));
    return [name, `ppt/media/image${index + 1}${extension}`] as const;
  }));
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name]!;
    if (entry.dir) continue;
    const outputName = renamedMedia.get(name) ?? name;
    let data: Uint8Array | string = await entry.async("uint8array");
    if (name === "ppt/theme/theme1.xml") {
      const xml = Buffer.from(data).toString("utf8");
      const normalized = xml.replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, themeColorScheme(request));
      if (normalized === xml) pptxFailure("PPTX_INVALID_PACKAGE", name, "theme color scheme is missing");
      data = normalized;
    } else if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      data = Buffer.from(data).toString("utf8").replace(/<\/(p:sp|p:pic)>(?=<p:(?:sp|pic)>)/g, "</$1>\n");
    } else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) {
      data = Buffer.from(data).toString("utf8").replaceAll('lang="en-US"', 'lang="ko-KR"');
    } else if (name === "ppt/slideMasters/slideMaster1.xml") {
      data = Buffer.from(data).toString("utf8").replace(/<a:defRPr\b/g, '<a:defRPr lang="ko-KR"');
    } else if (name.endsWith(".rels")) {
      let xml = Buffer.from(data).toString("utf8");
      for (const [original, replacement] of renamedMedia) {
        xml = xml.replaceAll(posix.basename(original), posix.basename(replacement));
      }
      data = xml;
    }
    target.file(outputName, data, { date: FIXED_ZIP_DATE, createFolders: false });
  }
  return target.generateAsync({ type: "uint8array", compression: "STORE" });
}

interface Relationship {
  readonly id: string;
  readonly target: string;
  readonly targetMode: string | null;
}

function parseRelationships(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)].map((match) => {
    const attributes = match[1] ?? "";
    const attribute = (name: string): string | null => {
      const found = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
      return found === null ? null : xmlDecode(found[1]!);
    };
    return { id: attribute("Id") ?? "", target: attribute("Target") ?? "", targetMode: attribute("TargetMode") };
  });
}

function sourcePart(relationshipsPath: string): string {
  if (relationshipsPath === "_rels/.rels") return "";
  const match = relationshipsPath.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  return match === null ? "" : posix.join(match[1]!, match[2]!);
}

function relationshipTarget(relationshipsPath: string, target: string): string {
  if (target.startsWith("/")) return posix.normalize(target.slice(1));
  return posix.normalize(posix.join(posix.dirname(sourcePart(relationshipsPath)), target));
}

export async function validateEditablePptxPackage(bytes: Uint8Array, request?: EditablePptxRenderRequest): Promise<void> {
  if (bytes.byteLength < 4 || !Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    pptxFailure("PPTX_INVALID_PACKAGE", "artifact.bytes", "artifact is not an OPC ZIP package");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (error) {
    pptxFailure("PPTX_INVALID_PACKAGE", "artifact.bytes", error instanceof Error ? error.message : "invalid ZIP package");
  }
  for (const required of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]) {
    if (archive.file(required) === null) pptxFailure("PPTX_INVALID_PACKAGE", required, "required OPC part is missing");
  }

  for (const [path, entry] of Object.entries(archive.files)) {
    if (entry.dir || !path.endsWith(".rels")) continue;
    const parsed = parseRelationships(await entry.async("string"));
    if (new Set(parsed.map((relationship) => relationship.id)).size !== parsed.length) {
      pptxFailure("PPTX_INVALID_PACKAGE", path, "relationship IDs are not unique");
    }
    for (const relationship of parsed) {
      if (relationship.targetMode === "External" || /^[a-z][a-z\d+.-]*:/i.test(relationship.target)) {
        pptxFailure("PPTX_EXTERNAL_RELATIONSHIP", `${path}:${relationship.id}`, "external relationships are prohibited");
      }
      const target = relationshipTarget(path, relationship.target);
      if (target.startsWith("../") || archive.file(target) === null) {
        pptxFailure("PPTX_DANGLING_RELATIONSHIP", `${path}:${relationship.id}`, `relationship target '${relationship.target}' is missing`);
      }
    }
  }

  if (request === undefined) return;
  for (let slideIndex = 0; slideIndex < request.slides.length; slideIndex++) {
    const path = `ppt/slides/slide${slideIndex + 1}.xml`;
    const part = archive.file(path);
    if (part === null) pptxFailure("PPTX_INVALID_PACKAGE", path, "rendered slide is missing");
    const xml = await part.async("string");
    for (const element of request.slides[slideIndex]!.geometry.slide.elements) {
      if (element.lines.length === 0 && element.text === "") continue;
      if (!xml.includes(`name="${xmlEscape(element.id)}"`) || element.lines.some((line) => !xml.includes(`<a:t>${xmlEscape(line)}</a:t>`))) {
        pptxFailure("PPTX_TEXT_RASTERIZED", path, `meaningful text element '${element.id}' is not editable DrawingML text`);
      }
    }
  }
}
