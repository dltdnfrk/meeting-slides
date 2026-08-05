export type ConversationVisualVariant = "cover" | "topic";

export interface ConversationVisualInput {
  readonly title: string;
  readonly points: readonly string[];
  readonly variant: ConversationVisualVariant;
}

interface VisualPoint {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number, index: number): number {
  let value = (seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0xffffffff;
}

function round(value: number): string {
  return value.toFixed(1);
}

function buildPoints(seed: number, count: number, width: number, height: number): VisualPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    x: width * (0.08 + seededUnit(seed, index * 4) * 0.58),
    y: height * (0.10 + seededUnit(seed, index * 4 + 1) * 0.80),
    radius: 7 + seededUnit(seed, index * 4 + 2) * 17,
  }));
}

export function renderConversationVisual(input: ConversationVisualInput): string {
  const source = [input.title, ...input.points].join("\u241f");
  const seed = hashText(source);
  const isCover = input.variant === "cover";
  const width = isCover ? 640 : 520;
  const height = isCover ? 720 : 520;
  const count = Math.max(4, Math.min(9, input.points.length + (isCover ? 4 : 3)));
  const points = buildPoints(seed, count, width, height);
  const hubX = width * (0.72 + seededUnit(seed, 90) * 0.14);
  const hubY = height * (0.38 + seededUnit(seed, 91) * 0.24);
  const visualClass = isCover ? "cover-visual" : "topic-map";

  const connections = points.map((point, index) => {
    const controlX = width * (0.48 + seededUnit(seed, 100 + index) * 0.16);
    const controlY = point.y + (hubY - point.y) * (0.25 + seededUnit(seed, 120 + index) * 0.50);
    return `<path class="visual-connection" d="M ${round(point.x)} ${round(point.y)} C ${round(controlX)} ${round(point.y)}, ${round(controlX)} ${round(controlY)}, ${round(hubX)} ${round(hubY)}" />`;
  }).join("\n    ");

  const nodes = points.map((point, index) => {
    const nodeClass = index % 3 === 0 ? "visual-node is-accent" : "visual-node";
    return `<circle class="${nodeClass}" cx="${round(point.x)}" cy="${round(point.y)}" r="${round(point.radius)}" />`;
  }).join("\n    ");

  const orbitRadius = 54 + seededUnit(seed, 150) * 34;
  const registrationX = width * (0.12 + seededUnit(seed, 151) * 0.18);
  const registrationY = height * (0.16 + seededUnit(seed, 152) * 0.66);

  return `<svg class="${visualClass}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
    <g class="visual-grid">
      <path d="M ${round(registrationX - 34)} ${round(registrationY)} H ${round(registrationX + 34)}" />
      <path d="M ${round(registrationX)} ${round(registrationY - 34)} V ${round(registrationY + 34)}" />
      <circle cx="${round(registrationX)}" cy="${round(registrationY)}" r="18" />
    </g>
    <g class="visual-connections">
      ${connections}
    </g>
    <g class="visual-nodes">
      ${nodes}
    </g>
    <g class="visual-hub">
      <circle class="visual-orbit" cx="${round(hubX)}" cy="${round(hubY)}" r="${round(orbitRadius)}" />
      <circle class="visual-orbit is-inner" cx="${round(hubX)}" cy="${round(hubY)}" r="${round(orbitRadius * 0.62)}" />
      <circle class="visual-core" cx="${round(hubX)}" cy="${round(hubY)}" r="${round(18 + seededUnit(seed, 153) * 14)}" />
    </g>
  </svg>`;
}
