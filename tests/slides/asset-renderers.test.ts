import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { renderChart } from "../../src/slides/assets/charts.ts";
import { ICON_NAMES, renderIcon } from "../../src/slides/assets/icons.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import { createDeckTheme } from "../../src/slides/theme/theme.ts";

const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

describe("deterministic local icon rendering", () => {
  test("exposes a small named meeting-deck set and renders registry-ready decorative SVG", () => {
    expect(ICON_NAMES).toEqual(["action", "calendar", "check", "decision", "people", "trend"]);

    const first = renderIcon({ name: "decision", size: 48, color: "colors.blue", purpose: "decorative" }, theme);
    const second = renderIcon({ name: "decision", size: 48, color: "colors.blue", purpose: "decorative" }, theme);

    expect(first.svg).toBe(second.svg);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.svg).toBe(text(first.bytes));
    expect(first.sha256).toBe(digest(first.bytes));
    expect(first).toMatchObject({
      width: 48,
      height: 48,
      mediaType: "image/svg+xml",
      altDescription: "",
      registration: {
        purpose: "decorative",
        kind: "icon",
        mediaType: "image/svg+xml",
        width: 48,
        height: 48,
        altDescription: "",
        source: { kind: "generated", generator: "meeting-icon-svg-v1" },
        claimIds: [],
      },
    });
    expect(first.svg).toContain('aria-hidden="true"');
    expect(first.svg).toContain(`#${theme.colors.blue}`);
    expect(first.svg).not.toContain("<title");
    expect(first.svg).not.toContain("<desc");
  });

  test("adds escaped accessible semantics only for informative icons", () => {
    const rendered = renderIcon({
      name: "action",
      size: 32,
      color: "colors.coral",
      purpose: "informative",
      title: "Next & now",
      description: 'Action <owner> says "go".',
      altDescription: "Action assigned to the owner.",
      claimIds: ["claim-action"],
    }, theme);

    expect(rendered.svg).toContain('<title id="title">Next &amp; now</title>');
    expect(rendered.svg).toContain('<desc id="description">Action &lt;owner&gt; says &quot;go&quot;.</desc>');
    expect(rendered.svg).toContain('role="img" aria-labelledby="title description"');
    expect(rendered.registration.claimIds).toEqual(["claim-action"]);
  });

  test("rejects unknown names, raw colors, and invalid dimensions", () => {
    expect(() => renderIcon({ name: "rocket", purpose: "decorative" }, theme)).toThrow(/unknown icon.*rocket/i);
    expect(() => renderIcon({ name: "check", color: "#ff0000", purpose: "decorative" }, theme)).toThrow(/semantic.*color token/i);
    expect(() => renderIcon({ name: "check", size: 0, purpose: "decorative" }, theme)).toThrow(/size.*positive integer/i);
  });
});

describe("deterministic local chart rendering", () => {
  const chart = {
    type: "bar",
    width: 640,
    height: 360,
    title: "Quarterly <delivery>",
    description: "Completed work by quarter & team.",
    altDescription: "Bar chart of completed work by quarter.",
    claimIds: ["claim-delivery"],
    categories: ["Q1 & setup", "Q2 <launch>", "Q3"],
    series: [
      { id: "planned", label: "Plan & target", color: "colors.blue", values: [12, 18, 21] },
      { id: "done", label: 'Done "actual"', color: "colors.coral", values: [10, 20, 24] },
    ],
  } as const;

  test("renders ordered, escaped, accessible bar SVG and complete registry metadata", () => {
    const first = renderChart(chart, theme);
    const second = renderChart(structuredClone(chart), theme);

    expect(first.svg).toBe(second.svg);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.svg).toBe(text(first.bytes));
    expect(first.sha256).toBe(digest(first.bytes));
    expect(first.width).toBe(640);
    expect(first.height).toBe(360);
    expect(first.mediaType).toBe("image/svg+xml");
    expect(first.registration).toEqual({
      purpose: "informative",
      kind: "chart",
      mediaType: "image/svg+xml",
      width: 640,
      height: 360,
      altDescription: chart.altDescription,
      source: { kind: "generated", generator: "meeting-chart-svg-v1" },
      claimIds: ["claim-delivery"],
    });
    expect(first.svg).toContain('<title id="title">Quarterly &lt;delivery&gt;</title>');
    expect(first.svg).toContain('<desc id="description">Completed work by quarter &amp; team.</desc>');
    expect(first.svg).toContain('role="img" aria-labelledby="title description"');
    expect(first.svg).toContain("Q1 &amp; setup");
    expect(first.svg).toContain("Q2 &lt;launch&gt;");
    expect(first.svg).toContain("Plan &amp; target");
    expect(first.svg).toContain("Done &quot;actual&quot;");
    expect(first.svg.indexOf("Q1 &amp; setup")).toBeLessThan(first.svg.indexOf("Q2 &lt;launch&gt;"));
    expect(first.svg.indexOf("Plan &amp; target")).toBeLessThan(first.svg.indexOf("Done &quot;actual&quot;"));
    expect(first.svg).toContain(`#${theme.colors.blue}`);
    expect(first.svg).toContain(`#${theme.colors.coral}`);
  });

  test("renders deterministic line charts from finite numeric data", () => {
    const input = { ...chart, type: "line" as const };
    const rendered = renderChart(input, theme);

    expect(rendered.svg).toContain("<polyline");
    expect(rendered.svg).not.toContain("<rect class=\"bar\"");
    expect(rendered.sha256).toBe(digest(rendered.bytes));
  });

  test("rejects empty data, non-finite values, duplicate series, shape mismatch, and raw colors", () => {
    expect(() => renderChart({ ...chart, categories: [], series: [] }, theme)).toThrow(/dataset.*empty/i);
    expect(() => renderChart({ ...chart, series: [{ ...chart.series[0], values: [1, Number.NaN, 3] }] }, theme)).toThrow(/finite/i);
    expect(() => renderChart({ ...chart, series: [chart.series[0], { ...chart.series[0] }] }, theme)).toThrow(/duplicate series.*planned/i);
    expect(() => renderChart({ ...chart, series: [{ ...chart.series[0], values: [1] }] }, theme)).toThrow(/value.*categories/i);
    expect(() => renderChart({ ...chart, series: [{ ...chart.series[0], color: "335C81" }] }, theme)).toThrow(/semantic.*color token/i);
  });
});
