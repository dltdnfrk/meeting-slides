import type {
  SlidePlannerAttempt,
  SlidePlannerValidationFailure,
  TranscriptSnapshot,
} from "./planner.ts";

const CONTRACT = {
  narrative: {
    workflow: "coherent-title-only-story-first",
    titlesFormNarrative: true,
    instruction: "Read slide titles alone as one coherent argument; titles must state the story, not label sections.",
  },
  primaryLayouts: ["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"],
  modelOutput: {
    format: "strict-json",
    htmlAllowed: false,
    omitAuthoritativeFields: ["planId", "snapshot", "createdAt", "updatedAt"],
    requiredFields: ["schemaVersion", "revision", "title", "theme", "claims", "assets", "slides"],
    fixedValues: { schemaVersion: 1, revision: 0 },
  },
  claims: {
    fields: ["id", "kind", "text", "sources", "method"],
    kinds: ["fact", "decision", "quote", "action"],
    methods: ["extractive", "verbatim", "reviewed"],
  },
  slideShape: {
    fields: ["id", "layout", "storyRole", "title", "payload", "bindings", "editorialPaths", "assetIds"],
    payloads: {
      hero: { variant: "cover|statement", statement: "string" },
      summary: { mode: "overview|takeaways", items: "string[]" },
      decision: { decision: "string", rationale: "string[]" },
      comparison: { sides: "{label:string,items:string[]}[]" },
      timeline: { mode: "process|chronology", events: "{label:string,text:string}[]" },
      metrics: { mode: "chart|cards", metrics: "{label:string,value:string,detail:string}[]" },
      actions: { items: "{task:string,owner:string,due:string}[]" },
    },
  },
  rendering: {
    canvas: { width: 1280, height: 720 },
    projectionSafe: true,
    density: { maxBodyItemsPerSlide: 6, minimumBodyFontSize: 22 },
  },
  designTokens: ["colors", "spacing", "typography", "stroke", "radius"],
  themeShape: {
    fields: ["id", "canvas", "font", "colors", "spacing", "typography", "stroke", "radius"],
    font: ["family", "localPath", "sha256"],
    colors: ["paper", "raised", "ink", "muted", "rule", "coral", "blue", "focus"],
    spacing: ["xs", "sm", "md", "lg", "xl"],
    typography: ["display", "heading", "body", "label"],
    textStyle: ["size", "lineHeight", "weight"],
  },
  evidence: {
    citationsRequired: true,
    sourceRangesRequired: true,
    quotesMustMatchTranscript: true,
    confirmedReview: {
      preserveEveryItem: true,
      claimIdMustEqualItemId: true,
      claimTextMustEqualDescription: true,
      claimSourceMustEqualItemSource: true,
      claimMethod: "reviewed",
      kindMapping: { decision: "decision", action_item: "action", open_item: "fact" },
      unlistedReviewedClaimsAllowed: false,
    },
  },
  assets: {
    manifestOnly: true,
    provenanceRequired: true,
    informativeAssetsRequireClaimIds: true,
    remoteHotlinksAllowed: false,
    fields: ["id", "purpose", "kind", "localPath", "mediaType", "width", "height", "byteLength", "sha256", "altDescription", "source", "claimIds"],
    sourceVariants: ["local:{originalPath}", "generated:{generator}", "retrieved:{url,retrievedAt}"],
  },
} as const;

export const SLIDE_PLANNER_SYSTEM_PROMPT = `You are Claude acting as a source-bound presentation planner.
Return exactly one JSON object accepted by the SlidePlan schema. Return no Markdown fences, commentary, HTML, CSS, SVG, or layout coordinates. The application, not you, supplies planId, snapshot, createdAt, and updatedAt.

First shape a concise story whose titles alone read as a coherent narrative. Then choose only the seven primary layout families in the contract. Do not use section-label titles. Preserve a projection-safe 1280x720 canvas: at most six body items per slide and body text no smaller than 22px. Express visual choices only through the complete design-token groups. Do not invent evidence, citations, assets, paths, hashes, provenance, owners, dates, or metrics.

Every factual payload field needs claim bindings. Every claim needs a citation to the supplied transcriptVersionId and a contiguous startSeq/endSeq range. evidenceQuote must be an exact substring of those source line texts joined with a newline, preserving spelling, case, and punctuation. If confirmed Review evidence is supplied, emit exactly one method=reviewed claim for every listed item, preserving its item ID as claim ID, description as claim text, and source exactly; map decision to decision, action_item to action, and open_item to fact. Never emit a reviewed claim not listed there. Assets are manifest entries only: use managed local paths, include provenance, never hotlink, and bind informative assets to supporting claim IDs.

<slide-plan-contract>${JSON.stringify(CONTRACT)}</slide-plan-contract>`;

interface UserPromptInput {
  snapshot: TranscriptSnapshot;
  attempt: SlidePlannerAttempt;
  validationFailure?: SlidePlannerValidationFailure;
  previousOutput?: string;
}

export function buildSlidePlannerUserPrompt(input: UserPromptInput): string {
  const source = {
    state: input.snapshot.state,
    meetingId: input.snapshot.meetingId,
    transcriptVersionId: input.snapshot.transcriptVersionId,
    contentSha256: input.snapshot.contentSha256,
    lines: input.snapshot.lines,
  };
  const instruction = input.attempt === "initial"
    ? "Create the complete source-bound SlidePlan content object. Omit application-owned metadata."
    : "Correct the previous output and return one complete replacement object. Omit application-owned metadata.";
  const repair = input.validationFailure === undefined ? undefined : {
    validationFailure: input.validationFailure,
    previousOutput: input.previousOutput,
  };
  const confirmedReview = input.snapshot.confirmedReview === undefined ? "" :
    `\n<confirmed-review>${JSON.stringify(input.snapshot.confirmedReview)}</confirmed-review>`;
  return `${instruction}\n<transcript-snapshot>${JSON.stringify(source)}</transcript-snapshot>${confirmedReview}${
    repair === undefined ? "" : `\n<repair-context>${JSON.stringify(repair)}</repair-context>`
  }`;
}
