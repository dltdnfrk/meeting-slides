import { inflateSync } from "node:zlib";

export interface BrowserBox { x: number; y: number; width: number; height: number }
export interface BrowserLine { text: string; designBox: BrowserBox; containedInElement: boolean; containedInSlide: boolean }
export interface BrowserElementInspection {
  elementId: string; designBox: BrowserBox; fontSizeDesignPx: number; fontFamily: string;
  lines: BrowserLine[]; containedInSlide: boolean; clippedByAncestors: string[];
  scrollOverflow: { x: number; y: number };
}
export interface BrowserAssetInspection {
  placementId: string; designBox: BrowserBox; containedInSlide: boolean; loaded: boolean;
  naturalWidth: number; naturalHeight: number;
}
export interface BrowserInspection {
  viewportBox: BrowserBox; designBox: BrowserBox; rootOverflow: { x: number; y: number };
  elements: BrowserElementInspection[]; assets: BrowserAssetInspection[];
  textContainment: { korean: { text: string; contained: boolean }; english: { text: string; contained: boolean } };
}

export async function readyAndInspect(slideId: string, scale: number): Promise<BrowserInspection> {
  await document.fonts.ready;
  const images = Array.from(document.images);
  await Promise.all(images.map(async (image) => {
    if (!image.complete) await image.decode();
    else if (image.naturalWidth === 0) throw new Error(`asset '${image.dataset.placementId ?? image.src}' did not load`);
    else await image.decode();
  }));
  if (document.readyState !== "complete" || document.fonts.status !== "loaded") {
    throw new Error(`document readiness is '${document.readyState}', fonts are '${document.fonts.status}'`);
  }
  const slide = document.querySelector<HTMLElement>(`.slide[data-slide-id="${CSS.escape(slideId)}"]`);
  if (slide === null) throw new Error(`slide '${slideId}' was not found`);
  const rect = (node: Element): BrowserBox => {
    const value = node.getBoundingClientRect();
    return { x: value.x / scale, y: value.y / scale, width: value.width / scale, height: value.height / scale };
  };
  const contains = (outer: DOMRect, inner: DOMRect): boolean =>
    inner.left >= outer.left - .25 && inner.top >= outer.top - .25
    && inner.right <= outer.right + .25 && inner.bottom <= outer.bottom + .25;
  const slideRect = slide.getBoundingClientRect();
  const elements = Array.from(slide.querySelectorAll<HTMLElement>("[data-element-id]")).map((element) => {
    const elementRect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const clippedByAncestors: string[] = [];
    for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
        && !contains(parent.getBoundingClientRect(), elementRect)) {
        clippedByAncestors.push(parent.dataset.elementId ?? parent.dataset.slideId ?? parent.className);
      }
    }
    const lines = Array.from(element.querySelectorAll<HTMLElement>(".text-line")).map((line) => {
      const lineRect = line.getBoundingClientRect();
      return { text: line.textContent ?? "", designBox: rect(line),
        containedInElement: contains(elementRect, lineRect), containedInSlide: contains(slideRect, lineRect) };
    });
    return {
      elementId: element.dataset.elementId ?? "", designBox: rect(element),
      fontSizeDesignPx: Number.parseFloat(computed.fontSize), fontFamily: computed.fontFamily,
      lines, containedInSlide: contains(slideRect, elementRect), clippedByAncestors,
      scrollOverflow: { x: Math.max(0, element.scrollWidth - element.clientWidth),
        y: Math.max(0, element.scrollHeight - element.clientHeight) },
    };
  });
  const assets = Array.from(slide.querySelectorAll<HTMLImageElement>("img[data-placement-id]")).map((asset) => ({
    placementId: asset.dataset.placementId ?? "", designBox: rect(asset),
    containedInSlide: contains(slideRect, asset.getBoundingClientRect()),
    loaded: asset.complete && asset.naturalWidth > 0, naturalWidth: asset.naturalWidth, naturalHeight: asset.naturalHeight,
  }));
  const textLines = elements.flatMap((element) => element.lines);
  const koreanLines = textLines.filter((line) => /[\uac00-\ud7a3]/.test(line.text));
  const englishParts = textLines.flatMap((line) => /[\uac00-\ud7a3]/.test(line.text)
    ? line.text.match(/[A-Za-z]+(?: +[A-Za-z]+)*/g) ?? [] : /[A-Za-z]/.test(line.text) ? [line.text] : []);
  return {
    viewportBox: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    designBox: rect(slide), rootOverflow: {
      x: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      y: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    }, elements, assets,
    textContainment: {
      korean: { text: koreanLines.map((line) => line.text).join(""), contained: koreanLines.every((line) => line.containedInElement && line.containedInSlide) },
      english: { text: englishParts.join(""), contained: textLines.filter((line) => /[A-Za-z]/.test(line.text)).every((line) => line.containedInElement && line.containedInSlide) },
    },
  } as BrowserInspection;
}

export function pngPixelBytes(png: Uint8Array): Uint8Array {
  if (png.byteLength < 33 || Buffer.from(png.subarray(1, 4)).toString() !== "PNG") throw new Error("screenshot is not a PNG");
  const view = Buffer.from(png); const width = view.readUInt32BE(16); const height = view.readUInt32BE(20);
  const depth = view[24]; const color = view[25]; const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (depth !== 8 || channels === 0 || view[28] !== 0) throw new Error(`unsupported screenshot PNG format (${depth}/${color})`);
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= view.length;) {
    const length = view.readUInt32BE(at); const type = view.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(view.subarray(at + 8, at + 8 + length));
    at += length + 12; if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * channels; const pixels = new Uint8Array(stride * height);
  const paeth = (a: number, b: number, c: number): number => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0, source = 0; y < height; y++) {
    const filter = raw[source++]!; const row = y * stride;
    for (let x = 0; x < stride; x++, source++) {
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const above = y > 0 ? pixels[row + x - stride]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[row + x - stride - channels]! : 0;
      const value = raw[source]!;
      pixels[row + x] = (value + (filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0)) & 255;
    }
  }
  return pixels;
}
