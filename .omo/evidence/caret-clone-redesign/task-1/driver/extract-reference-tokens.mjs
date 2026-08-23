// Measured Caret token extraction: emerald identity, mono telemetry, rules, radii, motion.
// Runtime truth only (getComputedStyle); the official page is inert reference data.
import { join } from "node:path";
import puppeteer from "puppeteer";

import {
  DETERMINISTIC,
  TASK_ROOT,
  isoNow,
  prepareDeterministicPage,
  writeJson,
} from "./capture-lib.mjs";

const URL = "https://caret.so/en";
const VIEWPORT = { name: "1440x900", width: 1440, height: 900 };

const EXTRACT = function extract() {
  // Chromium keeps modern lab()/oklab() notations verbatim through getComputedStyle and
  // canvas fillStyle, so the only faithful sRGB resolution is painting one pixel and
  // reading it back. That is the color the user actually sees.
  const probeCanvas = document.createElement("canvas");
  probeCanvas.width = 1;
  probeCanvas.height = 1;
  const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
  const srgbCache = new Map();
  const parseRgb = (value) => {
    if (!value || value === "none") return null;
    if (srgbCache.has(value)) return srgbCache.get(value);
    let resolved = null;
    try {
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = "#000000";
      probeCtx.fillStyle = value;
      probeCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = probeCtx.getImageData(0, 0, 1, 1).data;
      const a = Number((alpha / 255).toFixed(3));
      // Alpha is premultiplied against the transparent canvas; undo it for the pure color.
      const unmul = (channel) => (a > 0 ? Math.min(255, Math.round(channel / a)) : channel);
      resolved = {
        r: unmul(r),
        g: unmul(g),
        b: unmul(b),
        a,
        srgb: a === 1
          ? `rgb(${unmul(r)}, ${unmul(g)}, ${unmul(b)})`
          : `rgba(${unmul(r)}, ${unmul(g)}, ${unmul(b)}, ${a})`,
      };
    } catch {
      resolved = null;
    }
    srgbCache.set(value, resolved);
    return resolved;
  };
  const toHex = (value) => {
    const rgb = parseRgb(value);
    if (!rgb) return null;
    const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
    return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
  };
  const srgbOf = (value) => parseRgb(value)?.srgb ?? null;
  const relLum = (rgb) => {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  };

  const all = [...document.querySelectorAll("body *")];

  // Emerald identity: saturated green fills used as accent surfaces.
  const emerald = new Map();
  const mono = new Map();
  const radii = new Map();
  const rules = new Map();
  const durations = new Map();
  const easings = new Map();
  const fontStacks = new Map();
  const fontSizes = new Map();

  const bump = (map, key, sample) => {
    const entry = map.get(key) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3 && sample) entry.samples.push(sample);
    map.set(key, entry);
  };

  for (const node of all) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const label = (node.textContent ?? "").trim().slice(0, 40) || node.tagName.toLowerCase();

    for (const property of ["backgroundColor", "color", "borderTopColor"]) {
      const raw = style[property];
      const rgb = parseRgb(raw);
      if (!rgb || rgb.a < 0.5) continue;
      const max = Math.max(rgb.r, rgb.g, rgb.b);
      const min = Math.min(rgb.r, rgb.g, rgb.b);
      const isGreenDominant = rgb.g === max && rgb.g - Math.max(rgb.r, rgb.b) > 25;
      if (isGreenDominant && max - min > 40) {
        bump(emerald, `${toHex(raw)}|${property}`, {
          label,
          raw,
          srgb: srgbOf(raw),
          hex: toHex(raw),
          property,
        });
      }
    }

    const family = style.fontFamily;
    bump(fontStacks, family, { label });
    bump(fontSizes, `${style.fontSize}/${style.fontWeight}/${style.lineHeight}`, { label, family });
    if (/mono/i.test(family)) bump(mono, family, { label, fontSize: style.fontSize, letterSpacing: style.letterSpacing });

    const radius = style.borderTopLeftRadius;
    if (radius !== "0px") bump(radii, radius, { label });

    const borderWidth = style.borderTopWidth;
    if (borderWidth !== "0px" && style.borderTopStyle !== "none") {
      const rgb = parseRgb(style.borderTopColor);
      bump(rules, `${borderWidth}|${srgbOf(style.borderTopColor) ?? style.borderTopColor}`, {
        label,
        alpha: rgb?.a ?? null,
        raw: style.borderTopColor,
      });
    }

    if (style.transitionDuration !== "0s") bump(durations, style.transitionDuration, { label });
    if (style.transitionDuration !== "0s") bump(easings, style.transitionTimingFunction, { label });
  }

  const rank = (map, limit) =>
    [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([key, value]) => ({ value: key, count: value.count, samples: value.samples }));

  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  const bodyBg = parseRgb(bodyStyle.backgroundColor);
  const bodyFg = parseRgb(bodyStyle.color);
  const contrast =
    bodyBg && bodyFg
      ? Number(
          (
            (Math.max(relLum(bodyBg), relLum(bodyFg)) + 0.05) /
            (Math.min(relLum(bodyBg), relLum(bodyFg)) + 0.05)
          ).toFixed(2),
        )
      : null;

  const result = {
    surface: {
      bodyBackground: bodyStyle.backgroundColor,
      bodyBackgroundSrgb: srgbOf(bodyStyle.backgroundColor),
      bodyBackgroundHex: toHex(bodyStyle.backgroundColor),
      bodyColor: bodyStyle.color,
      bodyColorSrgb: srgbOf(bodyStyle.color),
      bodyColorHex: toHex(bodyStyle.color),
      bodyContrastRatio: contrast,
      colorScheme: rootStyle.colorScheme,
    },
    typography: {
      bodyStack: bodyStyle.fontFamily,
      topFontStacks: rank(fontStacks, 5),
      monoStacks: rank(mono, 3),
      topSizeSteps: rank(fontSizes, 12),
    },
    emeraldCandidates: rank(emerald, 8),
    radiusSteps: rank(radii, 8),
    ruleSteps: rank(rules, 8),
    motion: {
      durations: rank(durations, 8),
      easings: rank(easings, 5),
    },
  };
  return result;
};

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars", "--lang=en-US"],
});
try {
  const page = await browser.newPage();
  await prepareDeterministicPage(page, VIEWPORT);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  const response = await page.goto(URL, { waitUntil: "networkidle2", timeout: 45_000 });
  if (!response?.ok()) throw new Error(`navigation failed: ${response?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  const tokens = await page.evaluate(EXTRACT);
  const receipt = writeJson(join(TASK_ROOT, "reference", "tokens.json"), {
    sourceUrl: URL,
    finalUrl: page.url(),
    viewport: VIEWPORT,
    capturedAt: isoNow(),
    deterministic: DETERMINISTIC,
    note: "Measured runtime values from the official public site. Reference measurement only; no asset reuse.",
    tokens,
  });
  console.log(`tokens written sha256=${receipt.sha256}`);
} finally {
  await browser.close();
}
