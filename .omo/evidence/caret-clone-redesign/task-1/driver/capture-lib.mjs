// Shared deterministic capture helpers for caret-clone-redesign task-1.
// No sleeps, no polling delays: every wait subscribes to a real event/state.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TASK_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Deterministic browser environment shared by every capture in this packet. */
export const DETERMINISTIC = Object.freeze({
  locale: "ko-KR",
  timezone: "Asia/Seoul",
  deviceScaleFactor: 1,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

export const BASELINE_VIEWPORTS = Object.freeze([
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1244x836", width: 1244, height: 836 },
  { name: "960x760", width: 960, height: 760 },
  { name: "820x900", width: 820, height: 900 },
  { name: "375x812", width: 375, height: 812 },
  { name: "320x667", width: 320, height: 667 },
]);

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256String(text) {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return { path, sha256: sha256String(text), bytes: Buffer.byteLength(text) };
}

/** PNG dimensions straight from the IHDR chunk - no image library, no guessing. */
export function pngDimensions(path) {
  const buffer = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`not a PNG: ${path}`);
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`missing IHDR: ${path}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/** Applies the deterministic session contract to a fresh page. */
export async function prepareDeterministicPage(page, viewport) {
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: DETERMINISTIC.deviceScaleFactor,
  });
  await page.emulateTimezone(DETERMINISTIC.timezone);
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: DETERMINISTIC.colorScheme },
    { name: "prefers-reduced-motion", value: DETERMINISTIC.reducedMotion },
  ]);
  return page;
}

/**
 * Records the runtime truth of a node: getComputedStyle only, never source CSS.
 * Returns null when the selector is absent so the validator can name a missing state.
 */
export const COMPUTED_PROBE = function computedProbe(selectors) {
  const read = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      typography: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
      },
      color: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        opacity: style.opacity,
      },
      radius: {
        borderTopLeftRadius: style.borderTopLeftRadius,
        borderTopRightRadius: style.borderTopRightRadius,
        borderBottomLeftRadius: style.borderBottomLeftRadius,
        borderBottomRightRadius: style.borderBottomRightRadius,
      },
      material: {
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || "none",
        boxShadow: style.boxShadow,
        backgroundImage: style.backgroundImage,
        mixBlendMode: style.mixBlendMode,
      },
      motion: {
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
      },
      geometry: {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      },
    };
  };

  const record = {};
  const missing = [];
  for (const [key, selector] of Object.entries(selectors)) {
    const element = document.querySelector(selector);
    if (!element) {
      record[key] = null;
      missing.push({ key, selector });
      continue;
    }
    record[key] = { selector, ...read(element) };
  }
  return {
    record,
    missing,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  };
};

/** Waits for a named state via MutationObserver; rejects with the missing state name. */
export const WAIT_FOR_STATE = function waitForState(selector, stateName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const settled = () => document.querySelector(selector);
    const immediate = settled();
    if (immediate) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`missing state: ${stateName} (${selector})`));
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      if (!settled()) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
};

export function isoNow() {
  return new Date().toISOString();
}
