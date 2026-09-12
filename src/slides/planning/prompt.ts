import type {
  SlidePlannerAttempt,
  SlidePlannerValidationFailure,
  TranscriptSnapshot,
} from "./planner.ts";
import {
  MINIMUM_DISTINCT_LAYOUT_FAMILIES,
  PLANNED_SLIDE_COUNT,
} from "../layouts/selection.ts";

const CONTRACT = {
  narrative: {
    workflow: "coherent-title-only-story-first",
    titlesFormNarrative: true,
    instruction: "Read slide titles alone as one coherent argument; titles must state the story, not label sections.",
  },
  editorialSynthesis: {
    profile: "presentation-editor-v1",
    sourceTextRole: "evidence-not-display-copy",
    displayCopy: "distilled-headlines-and-scan-copy",
    copyingGate: { minimumCopiedFields: 3, maxCopiedShareExclusive: 0.5 },
    exactCopyBudgetExemption: ["fields bound only to quote claims"],
    exactAtomicValuesRequired: ["owner names", "dates", "metrics"],
    provenanceAtoms: {
      mustAppearInBoundClaims: ["numbers", "dates", "acronyms", "URLs", "emails"],
    },
    statusSemantics: {
      openItemsRemainExplicitlyOpen: true,
      resolvedLanguageRequiresOpenStatusMarker: true,
      closingSeparatesCompletedAndOpen: true,
    },
  },
  primaryLayouts: ["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"],
  layoutCoverage: {
    slideCount: PLANNED_SLIDE_COUNT,
    minimumDistinctFamilies: MINIMUM_DISTINCT_LAYOUT_FAMILIES,
    reuseAllowed: true,
    chooseByEvidence: true,
    unsupportedFamilyCanBeOmitted: true,
  },
  modelOutput: {
    format: "strict-json",
    htmlAllowed: false,
    omitAuthoritativeFields: ["planId", "snapshot", "createdAt", "updatedAt", "theme"],
    requiredFields: ["schemaVersion", "revision", "title", "claims", "assets", "slides"],
    fixedValues: { schemaVersion: 1, revision: 0 },
  },
  claims: {
    fields: ["id", "kind", "text", "sources", "method"],
    kinds: ["fact", "decision", "quote", "action"],
    methods: ["extractive", "verbatim", "reviewed"],
  },
  slideShape: {
    fields: ["id", "layout", "storyRole", "title", "payload", "bindings", "editorialPaths", "assetIds"],
    storyRoles: ["opening", "context", "argument", "decision", "commitment", "closing"],
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
  bindings: {
    keyFormat: "payload-relative paths without the payload. prefix, plus title",
    titleKey: "title",
    everyFactualPathMustBeBound: true,
    neverPrefixWithPayload: true,
    factualPaths: {
      hero: ["statement"],
      summary: ["items[i]"],
      decision: ["decision", "rationale[i]"],
      comparison: ["sides[i].items[j]"],
      timeline: ["events[i].text"],
      metrics: ["metrics[i].label", "metrics[i].value", "metrics[i].detail"],
      actions: ["items[i].task", "items[i].owner", "items[i].due"],
    },
    editorialPaths: {
      comparison: ["sides[i].label"],
      timeline: ["events[i].label"],
    },
    example: { title: ["claim-id"], statement: ["claim-id"] },
  },
  rendering: {
    canvas: { width: 1280, height: 720 },
    projectionSafe: true,
    density: { maxBodyItemsPerSlide: 6, minimumBodyFontSize: 22 },
  },
  designTokens: ["colors", "spacing", "typography", "stroke", "radius"],
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
      ownerDueSource: "confirmedReview",
      ownerField: "assigneeAttendeeId",
      dueFields: ["deadlineText", "deadline"],
      attendeeDisplayNameField: "displayName",
      summary: {
        optional: true,
        overviewFor: ["hero.statement", "summary"],
        sectionOrderFrom: "topics",
      },
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

First act as a presentation editor: turn the source into a visual thesis, a short opener-to-commitment content plan, and copy that scans in seconds. Claims and citations preserve evidence; visible titles and body copy must distill that evidence into concise headlines, takeaways, comparisons, milestones, metrics, and actions instead of repeating transcript or Review sentences. Exact quote fields may remain verbatim. Owner names, dates, metrics, numbers, acronyms, URLs, and emails must remain exact and must already appear in the claims bound to that field; never introduce a new atomic fact while paraphrasing. An open_item must remain visibly unresolved everywhere it is used: never describe it as confirmed, completed, closed, or finalized, and separate completed outcomes from open next steps in the closing slide.

Shape a concise story whose titles alone read as a coherent narrative. Emit up to seven slides, using at least four distinct primary layout families when the evidence supports them. Choose and reuse layouts according to the evidence instead of filling a layout quota: never use timeline for a single event, metrics without a real quantitative value, or another family that does not fit the content. If the transcript is thin, emit fewer slides rather than padding with weak claims. Do not use section-label titles. Give each slide one distinct job and one dominant message; materially differentiate overview, detail, decision, risk, action, and closing slides instead of repeating the same claim. Preserve a projection-safe 1280x720 canvas: at most six body items per slide and body text no smaller than 22px. Express visual choices only through the complete design-token groups. Do not invent evidence, citations, assets, paths, hashes, provenance, owners, dates, or metrics.

Every factual payload field needs claim bindings. Binding object keys are payload-relative paths without the payload. prefix, plus title: use statement not payload.statement, items[0] not payload.items[0]. Bind every factual path and title. List editorialPaths exactly (comparison sides[i].label, timeline events[i].label) and never bind those keys. Every claim needs a citation to the supplied transcriptVersionId and a contiguous startSeq/endSeq range. evidenceQuote must be an exact substring of those source line texts joined with a newline, preserving spelling, case, and punctuation. If confirmed Review evidence is supplied, emit exactly one method=reviewed claim for every listed item, preserving its item ID as claim ID, description as claim text, and source exactly; map decision to decision, action_item to action, and open_item to fact. Never emit a reviewed claim not listed there. Actions owner text may only be the attendees displayName for assigneeAttendeeId; actions due text may only be deadlineText, or deadline when deadlineText is absent. Do not invent or omit those confirmed values. If a confirmed Review summary is supplied, use its overview for the hero statement and summary overview slide, and order sections to follow its topics. Assets are manifest entries only: use managed local paths, include provenance, never hotlink, and bind informative assets to supporting claim IDs. Place assets only on (hero, image), (summary, icon), (summary, diagram), and (metrics, chart) when metrics mode is chart; omit assets on every other (layout, kind) pair.

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
  const summary = input.snapshot.confirmedReview?.summary;
  const reviewSummary = summary === undefined ? "" :
    `\n<review-summary>${JSON.stringify(summary)}</review-summary>`;
  return `${instruction}\n<transcript-snapshot>${JSON.stringify(source)}</transcript-snapshot>${confirmedReview}${reviewSummary}${
    repair === undefined ? "" : `\n<repair-context>${JSON.stringify(repair)}</repair-context>`
  }`;
}
