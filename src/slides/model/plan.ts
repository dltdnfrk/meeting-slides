export type ClaimKind = "fact" | "decision" | "quote" | "action";
export type ClaimMethod = "extractive" | "verbatim" | "reviewed";

export interface SourceRange {
  transcriptVersionId: string;
  startSeq: number;
  endSeq: number;
  evidenceQuote: string;
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
  sources: SourceRange[];
  method: ClaimMethod;
}

export interface SnapshotIdentity {
  meetingId: number;
  transcriptVersionId: string;
  contentSha256: string;
  lineCount: number;
}

export interface Theme {
  id: string;
  canvas: { width: number; height: number };
  font: { family: string; localPath: string; sha256: string };
  colors: {
    paper: string; raised: string; ink: string; muted: string;
    rule: string; coral: string; blue: string; focus: string;
  };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  typography: {
    display: TextStyle; heading: TextStyle; body: TextStyle; label: TextStyle;
  };
  stroke: { thin: number; strong: number };
  radius: { small: number; large: number };
}

export interface TextStyle {
  size: number;
  lineHeight: number;
  weight: number;
}

export type AssetSource =
  | { kind: "local"; originalPath: string }
  | { kind: "generated"; generator: string }
  | { kind: "retrieved"; url: string; retrievedAt: string };

export interface PlanAsset {
  id: string;
  purpose: "informative" | "decorative";
  kind: "image" | "diagram" | "chart" | "icon";
  localPath: string;
  mediaType: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  altDescription: string;
  source: AssetSource;
  claimIds: string[];
}

interface SlideBase<L extends string, P> {
  id: string;
  layout: L;
  storyRole: "opening" | "context" | "argument" | "decision" | "commitment" | "closing";
  title: string;
  payload: P;
  bindings: Record<string, string[]>;
  editorialPaths: string[];
  assetIds: string[];
  notes?: string;
}

export type HeroSlide = SlideBase<"hero", {
  variant: "cover" | "statement";
  statement: string;
}>;

export type SummarySlide = SlideBase<"summary", {
  mode: "overview" | "takeaways";
  items: string[];
}>;

export type DecisionSlide = SlideBase<"decision", {
  decision: string;
  rationale: string[];
}>;

export type ComparisonSlide = SlideBase<"comparison", {
  sides: Array<{ label: string; items: string[] }>;
}>;

export type TimelineSlide = SlideBase<"timeline", {
  mode: "process" | "chronology";
  events: Array<{ label: string; text: string }>;
}>;

export type MetricsSlide = SlideBase<"metrics", {
  mode: "chart" | "cards";
  metrics: Array<{ label: string; value: string; detail: string }>;
}>;

export type ActionsSlide = SlideBase<"actions", {
  items: Array<{ task: string; owner: string; due: string }>;
}>;

export type PlanSlide = HeroSlide | SummarySlide | DecisionSlide |
  ComparisonSlide | TimelineSlide | MetricsSlide | ActionsSlide;

export interface SlidePlan {
  schemaVersion: 1;
  planId: string;
  revision: number;
  snapshot: SnapshotIdentity;
  title: string;
  theme: Theme;
  claims: Claim[];
  assets: PlanAsset[];
  slides: PlanSlide[];
  createdAt: string;
  updatedAt: string;
}
