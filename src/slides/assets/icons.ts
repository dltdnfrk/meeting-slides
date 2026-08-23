import type { Theme } from "../model/plan.ts";
import {
  claimIds,
  colorValue,
  escapeXml,
  finishSvg,
  positiveInteger,
  requiredText,
  type RenderedSvgAsset,
  type SemanticColorToken,
} from "./svg-renderer.ts";

export const ICON_NAMES = Object.freeze([
  "action",
  "calendar",
  "check",
  "decision",
  "people",
  "trend",
] as const);

export type IconName = (typeof ICON_NAMES)[number];

export interface IconRenderInput {
  readonly name: string;
  readonly size?: number;
  readonly color?: SemanticColorToken | string;
  readonly purpose: "informative" | "decorative";
  readonly title?: string;
  readonly description?: string;
  readonly altDescription?: string;
  readonly claimIds?: readonly string[];
}

const PATHS: Readonly<Record<IconName, string>> = Object.freeze({
  action: '<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8 14h2M14 14h2M8 18h2"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  decision: '<path d="M12 3l9 9-9 9-9-9z"/><path d="M8 12h8"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6M15 15c3.5 0 6 1.5 6 5"/>',
  trend: '<path d="M4 18l5-5 4 3 7-9"/><path d="M15 7h5v5"/>',
});

function iconName(value: string): IconName {
  if (!ICON_NAMES.some((name) => name === value)) throw new TypeError(`unknown icon '${value}'`);
  return value as IconName;
}

export function renderIcon(input: IconRenderInput, theme: Theme): RenderedSvgAsset {
  const name = iconName(input.name);
  const size = positiveInteger(input.size ?? 24, "size");
  const stroke = colorValue(theme, input.color ?? "colors.ink");
  let accessibility: string;
  let semanticContent: string;
  let altDescription: string;
  let claims: readonly string[];

  if (input.purpose === "decorative") {
    if (input.title !== undefined || input.description !== undefined || input.altDescription !== undefined ||
        (input.claimIds !== undefined && input.claimIds.length > 0)) {
      throw new TypeError("decorative icons must omit semantic content");
    }
    accessibility = 'aria-hidden="true" focusable="false"';
    semanticContent = "";
    altDescription = "";
    claims = Object.freeze([]);
  } else if (input.purpose === "informative") {
    const title = requiredText(input.title, "title");
    const description = requiredText(input.description, "description");
    altDescription = requiredText(input.altDescription, "altDescription");
    claims = claimIds(input.claimIds);
    accessibility = 'role="img" aria-labelledby="title description"';
    semanticContent = `<title id="title">${escapeXml(title)}</title><desc id="description">${escapeXml(description)}</desc>`;
  } else {
    throw new TypeError("purpose must be informative or decorative");
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${accessibility}>${semanticContent}<g fill="none" stroke="${stroke}" stroke-width="${theme.stroke.strong}" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</g></svg>`;

  return finishSvg(svg, {
    purpose: input.purpose,
    kind: "icon",
    width: size,
    height: size,
    altDescription,
    source: { kind: "generated", generator: "meeting-icon-svg-v1" },
    claimIds: claims,
  });
}
