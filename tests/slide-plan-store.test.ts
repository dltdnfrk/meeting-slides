import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_SCHEMA } from "../src/minutes-store-schema-core.ts";
import { REVIEW_SCHEMA } from "../src/minutes-store-schema-review.ts";
import { SlidePlanStore } from "../src/slide-plan-store.ts";
import type { PlanSlide, SlidePlan, Theme } from "../src/slides/model/plan.ts";
import { stableSlidePlanJson } from "../src/slides/server-pipeline-publication.ts";
import type {
  PipelineIdentity,
  SlidePlanFinalityReceipt,
} from "../src/slides/server-pipeline-types.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const transcriptHash = sha256(`${JSON.stringify({ seq: 1, ts: 10, speaker_turn: 1, text: "Launch Friday" })}\n`);
const theme: Theme = {
  id: "store-theme",
  canvas: { width: 1280, height: 720 },
  font: { family: "Fixture", localPath: "fonts/fixture.woff2", sha256: "f".repeat(64) },
  colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
  spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
  typography: {
    display: { size: 64, lineHeight: 68, weight: 700 },
    heading: { size: 36, lineHeight: 42, weight: 700 },
    body: { size: 22, lineHeight: 30, weight: 400 },
    label: { size: 16, lineHeight: 20, weight: 600 },
  },
  stroke: { thin: 1, strong: 3 },
  radius: { small: 8, large: 24 },
};
const claim = {
  id: "decision-z",
  kind: "decision" as const,
  text: "Launch Friday.",
  sources: [{ transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Launch Friday" }],
  method: "reviewed" as const,
};

function slide(layout: PlanSlide["layout"], index: number): PlanSlide {
  const base = {
    id: `slide-${layout}`,
    layout,
    storyRole: index === 0 ? "opening" as const : "argument" as const,
    title: `Slide ${index}`,
    editorialPaths: [] as string[],
    assetIds: [] as string[],
  };
  const binding = [claim.id];
  switch (layout) {
    case "hero": return { ...base, layout, payload: { variant: "cover", statement: "Launch Friday" }, bindings: { title: binding, statement: binding } };
    case "summary": return { ...base, layout, payload: { mode: "overview", items: ["Launch Friday"] }, bindings: { title: binding, "items[0]": binding } };
    case "decision": return { ...base, layout, payload: { decision: "Launch Friday", rationale: ["Agreed"] }, bindings: { title: binding, decision: binding, "rationale[0]": binding } };
    case "comparison": return { ...base, layout, payload: { sides: [{ label: "Before", items: ["Open"] }, { label: "After", items: ["Agreed"] }] }, bindings: { title: binding, "sides[0].items[0]": binding, "sides[1].items[0]": binding }, editorialPaths: ["sides[0].label", "sides[1].label"] };
    case "timeline": return { ...base, layout, payload: { mode: "process", events: [{ label: "Friday", text: "Launch" }] }, bindings: { title: binding, "events[0].text": binding }, editorialPaths: ["events[0].label"] };
    case "metrics": return { ...base, layout, payload: { mode: "cards", metrics: [{ label: "Date", value: "Friday", detail: "Launch" }] }, bindings: { title: binding, "metrics[0].label": binding, "metrics[0].value": binding, "metrics[0].detail": binding } };
    case "actions": return { ...base, layout, payload: { items: [{ task: "Launch", owner: "Mina", due: "Friday" }] }, bindings: { title: binding, "items[0].task": binding, "items[0].owner": binding, "items[0].due": binding } };
  }
}

function plan(planId = "plan-store", meetingId = 1): SlidePlan {
  return {
    schemaVersion: 1,
    planId,
    revision: 0,
    snapshot: { meetingId, transcriptVersionId: "transcript-v1", contentSha256: transcriptHash, lineCount: 1 },
    title: "Launch",
    theme,
    claims: [claim],
    assets: [],
    slides: (["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"] as const).map(slide),
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
}

type Publication = ReturnType<typeof publication>;

function publication(value = plan(), status: "draft" | "final" = "final", reviewedItemIds = ["action-a", "decision-z"] as const) {
  const planJson = stableSlidePlanJson(value);
  const identity: PipelineIdentity = {
    planId: value.planId,
    deckId: `${value.planId}:deck`,
    snapshot: value.snapshot,
    slideIds: value.slides.map((entry) => entry.id),
    geometryIds: value.slides.map((entry) => `geometry-${entry.id}`),
    claimIds: value.claims.map((entry) => entry.id),
    ...(status === "final" ? { reviewId: "review-v1", reviewedItemIds: [...reviewedItemIds] } : {}),
  };
  const finalityReceipt: SlidePlanFinalityReceipt | undefined = status === "final" ? {
    reviewId: "review-v1",
    confirmedAt: 200,
    transcriptVersionId: "transcript-v1",
    contentSha256: transcriptHash,
    reviewedItemIds: [...reviewedItemIds],
  } : undefined;
  const manifestJson = `${JSON.stringify({
    schemaVersion: 2,
    publicationStatus: status,
    identity,
    ...(finalityReceipt === undefined ? {} : { finalityReceipt }),
    planSha256: sha256(planJson),
    assetManifestSha256: "b".repeat(64),
    artifacts: [],
  })}\n`;
  return {
    identity,
    planJson,
    planSha256: sha256(planJson),
    manifestJson,
    publicationSha256: sha256(manifestJson),
    directory: `/published/${value.planId}`,
  };
}

function createDomain(db: Database, options: {
  readonly meetingId?: number;
  readonly reviewMeetingId?: number;
  readonly reviewStatus?: "draft" | "confirmed";
  readonly canonicalVersion?: string;
  readonly canonicalHash?: string;
} = {}): void {
  const meetingId = options.meetingId ?? 1;
  const reviewMeetingId = options.reviewMeetingId ?? meetingId;
  const status = options.reviewStatus ?? "confirmed";
  db.run("CREATE TABLE meetings (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, provider TEXT)");
  db.run(CORE_SCHEMA);
  db.run(REVIEW_SCHEMA);
  db.run("INSERT INTO meetings (id, started_at) VALUES (?, 1)", [meetingId]);
  if (reviewMeetingId !== meetingId) db.run("INSERT INTO meetings (id, started_at) VALUES (?, 1)", [reviewMeetingId]);
  db.run(`INSERT INTO transcript_versions
    (transcript_version_id, meeting_id, version_no, source_kind, created_at, finalized_at, content_sha256)
    VALUES ('transcript-v1', ?, 1, 'import', 1, 100, ?)`, [reviewMeetingId, options.canonicalHash ?? transcriptHash]);
  db.run(`INSERT INTO transcript_version_lines
    (meeting_id, transcript_version_id, seq, captured_at_ms, speaker_turn, text)
    VALUES (?, 'transcript-v1', 1, 10, 1, 'Launch Friday')`, [reviewMeetingId]);
  db.run(`INSERT INTO meeting_transcript_state
    (meeting_id, canonical_transcript_version_id, canonical_selected_at)
    VALUES (?, ?, 100)`, [reviewMeetingId, options.canonicalVersion ?? "transcript-v1"]);
  db.run("INSERT INTO attendees (meeting_id, attendee_id, display_name, created_at) VALUES (?, 'attendee-1', 'Mina', 1)", [reviewMeetingId]);
  db.run(`INSERT INTO meeting_reviews
    (review_id, meeting_id, transcript_version_id, status, created_at, updated_at, confirmed_at)
    VALUES ('review-v1', ?, 'transcript-v1', ?, 1, 200, ?)`, [reviewMeetingId, status, status === "confirmed" ? 200 : null]);
  insertReviewedItem(db, "decisions", "decision_id", "decision-z", reviewMeetingId);
  insertReviewedItem(db, "action_items", "action_item_id", "action-a", reviewMeetingId);
}

function insertReviewedItem(db: Database, table: "decisions" | "action_items" | "open_items", idColumn: string, id: string, meetingId = 1): void {
  const commonColumns = `${idColumn}, meeting_id, review_id, description, evidence_quote,
    source_transcript_version_id, source_start_seq, source_end_seq`;
  if (table === "action_items") {
    db.run(`INSERT INTO action_items (${commonColumns}, assignee_attendee_id, attributed_attendee_id,
      deadline, origin, review_state, created_at, updated_at)
      VALUES (?, ?, 'review-v1', 'Launch', 'Launch Friday', 'transcript-v1', 1, 1,
      'attendee-1', 'attendee-1', '2026-09-01', 'manual', 'confirmed', 1, 1)`, [id, meetingId]);
    return;
  }
  db.run(`INSERT INTO ${table} (${commonColumns}, attributed_attendee_id, origin, review_state, created_at, updated_at)
    VALUES (?, ?, 'review-v1', 'Launch', 'Launch Friday', 'transcript-v1', 1, 1,
    'attendee-1', 'manual', 'confirmed', 1, 1)`, [id, meetingId]);
}

const historicalColumns = `
  plan_id TEXT PRIMARY KEY, meeting_id INTEGER NOT NULL, identity_json TEXT NOT NULL,
  plan_json TEXT NOT NULL, plan_sha256 TEXT NOT NULL, publication_sha256 TEXT NOT NULL,
  publication_path TEXT NOT NULL, review_id TEXT, reviewed_item_ids_json TEXT, published_at INTEGER NOT NULL`;

function insertHistorical(db: Database, value: Publication, table = "slide_plan_publications", revisionColumn = false, statusColumn = false): void {
  const planValue = JSON.parse(value.planJson) as { revision: number };
  const columns = [
    ...(revisionColumn ? ["publication_id"] : []), "plan_id", ...(revisionColumn ? ["revision"] : []),
    "meeting_id", "identity_json", "plan_json", "plan_sha256", "publication_sha256",
    ...(statusColumn ? ["publication_status"] : []), "publication_path", "review_id",
    "reviewed_item_ids_json", "published_at",
  ];
  const values = [
    ...(revisionColumn ? [sha256(`${value.identity.planId}\n${planValue.revision}\n${value.planSha256}\n`)] : []),
    value.identity.planId, ...(revisionColumn ? [planValue.revision] : []), value.identity.snapshot.meetingId,
    JSON.stringify(value.identity), value.planJson, value.planSha256, value.publicationSha256,
    ...(statusColumn ? [value.identity.reviewId === undefined ? "draft" : "final"] : []), value.directory,
    value.identity.reviewId ?? null,
    value.identity.reviewedItemIds === undefined ? null : JSON.stringify(value.identity.reviewedItemIds), 42,
  ];
  db.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
}

function createImmediateSchema(db: Database, table = "slide_plan_publications", withStatus = false): void {
  db.run(`CREATE TABLE ${table} (
    publication_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
    meeting_id INTEGER NOT NULL, identity_json TEXT NOT NULL, plan_json TEXT NOT NULL,
    plan_sha256 TEXT NOT NULL, publication_sha256 TEXT NOT NULL,
    ${withStatus ? "publication_status TEXT NOT NULL," : ""}
    publication_path TEXT NOT NULL, review_id TEXT, reviewed_item_ids_json TEXT,
    published_at INTEGER NOT NULL, UNIQUE(plan_id, revision))`);
}

function cloneTargetSchema(db: Database, target: string): void {
  const sourceSql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'slide_plan_publications'").get() as { sql: string }).sql;
  db.run(sourceSql.replace("CREATE TABLE slide_plan_publications", `CREATE TABLE ${target}`));
}

function targetStaging(db: Database, planIds: readonly string[]): void {
  const store = new SlidePlanStore(db);
  for (const [index, planId] of planIds.entries()) {
    store.save(publication(plan(planId), "draft"), index + 1);
  }
  db.run("ALTER TABLE slide_plan_publications RENAME TO slide_plan_publications_staging");
}

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
}

function migrationMarker(db: Database, table: string): void {
  const schema = (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql;
  const columns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
  const rowids = db.query(`SELECT rowid AS source_rowid FROM ${table} ORDER BY rowid`).all() as Array<{ source_rowid: number }>;
  const rowDigests = rowids.map(({ source_rowid }) => sha256(JSON.stringify(columns.map((name) => db.query(
    `SELECT typeof("${name}") AS type, hex(CAST("${name}" AS BLOB)) AS bytes FROM ${table} WHERE rowid = ?`,
  ).get(source_rowid)))));
  db.run(`CREATE TABLE slide_plan_publications_migration (
    source_schema_sha256 TEXT, source_row_count INTEGER, source_row_digest TEXT, phase TEXT)`);
  db.run("INSERT INTO slide_plan_publications_migration VALUES (?, ?, ?, 'copied')", [
    sha256(schema), rowids.length, sha256(JSON.stringify(rowDigests)),
  ]);
}

function typedCells(db: Database, table: string, rowid: number): Array<{
  readonly ordinal: number;
  readonly name: string;
  readonly sqliteType: string;
  readonly valueHex: string;
}> {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ cid: number; name: string }>;
  return columns.map(({ cid, name }) => {
    const cell = db.query(`SELECT typeof("${name}") AS sqliteType,
      coalesce(hex(CAST("${name}" AS BLOB)), '') AS valueHex FROM ${table} WHERE rowid = ?`).get(rowid) as {
        sqliteType: string;
        valueHex: string;
      };
    return { ordinal: cid, name, ...cell };
  });
}

function unknownStagingSnapshot(db: Database): Record<string, unknown> {
  return {
    schemas: db.query(`SELECT name, sql FROM sqlite_master
      WHERE name IN ('slide_plan_publications_staging', 'slide_plan_publications_migration') ORDER BY name`).all(),
    count: db.query("SELECT count(*) AS count FROM slide_plan_publications_staging").get(),
    cells: typedCells(db, "slide_plan_publications_staging", 1),
    marker: tableNames(db).includes("slide_plan_publications_migration")
      ? db.query("SELECT * FROM slide_plan_publications_migration").all()
      : [],
  };
}

function publicationRows(db: Database): Array<Record<string, unknown>> {
  return db.query(`SELECT publication_seq, publication_status, plan_id, revision, review_id,
    finality_receipt_json, finality_receipt_sha256, published_at
    FROM slide_plan_publications ORDER BY publication_seq`).all() as Array<Record<string, unknown>>;
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("SlidePlanStore same-DB finality", () => {
  test("rejects a forged reviewId in an empty database", () => {
    const db = new Database(":memory:");
    const store = new SlidePlanStore(db);
    expect(() => store.save(publication(), 1)).toThrow(/review|finality|same database/i);
    expect(store.list()).toEqual([]);
    db.close();
  });

  test("persists a final only for the matching confirmed Review, canonical transcript, and exact sorted confirmed item set", () => {
    const db = new Database(":memory:");
    createDomain(db);
    const store = new SlidePlanStore(db);
    const saved = store.save(publication(), 1000);
    expect(saved).toMatchObject({ publicationStatus: "final", reviewId: "review-v1", reviewedItemIds: ["action-a", "decision-z"], publicationSeq: 1 });
    expect(saved.finalityReceipt).toEqual({ reviewId: "review-v1", confirmedAt: 200, transcriptVersionId: "transcript-v1", contentSha256: transcriptHash, reviewedItemIds: ["action-a", "decision-z"] });
    expect(publicationRows(db)[0]?.finality_receipt_sha256).toBe(sha256(`${JSON.stringify(saved.finalityReceipt)}\n`));
    db.close();
  });

  test("rejects orphan, cross-meeting, and draft Reviews", () => {
    for (const setup of [
      (db: Database): void => { db.run("CREATE TABLE meetings (id INTEGER PRIMARY KEY)"); db.run("INSERT INTO meetings VALUES (1)"); },
      (db: Database): void => createDomain(db, { reviewMeetingId: 2 }),
      (db: Database): void => createDomain(db, { reviewStatus: "draft" }),
    ]) {
      const db = new Database(":memory:");
      setup(db);
      const store = new SlidePlanStore(db);
      expect(() => store.save(publication(), 1)).toThrow(/review|meeting|confirmed/i);
      expect(store.list()).toEqual([]);
      db.close();
    }
  });

  test("rejects canonical transcript version and content hash drift", () => {
    const db = new Database(":memory:");
    createDomain(db);
    const store = new SlidePlanStore(db);
    db.run("UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = 'transcript-v1'", ["c".repeat(64)]);
    expect(() => store.save(publication(), 1)).toThrow(/canonical|transcript|hash/i);
    db.run("UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = 'transcript-v1'", [transcriptHash]);
    db.run("UPDATE meeting_transcript_state SET canonical_transcript_version_id = 'transcript-other'");
    expect(() => store.save(publication(), 1)).toThrow(/canonical|transcript|version/i);
    db.close();
  });

  test("rejects reviewed item addition, removal, and rejection", () => {
    const variants = [
      (db: Database): void => insertReviewedItem(db, "open_items", "open_item_id", "open-extra"),
      (db: Database): void => { db.run("DELETE FROM action_items WHERE action_item_id = 'action-a'"); },
      (db: Database): void => { db.run("UPDATE action_items SET review_state = 'rejected' WHERE action_item_id = 'action-a'"); },
    ];
    for (const mutate of variants) {
      const db = new Database(":memory:");
      createDomain(db);
      mutate(db);
      const store = new SlidePlanStore(db);
      expect(() => store.save(publication(), 1)).toThrow(/reviewed item|receipt|finality/i);
      expect(store.list()).toEqual([]);
      db.close();
    }
  });

  test("rejects tampered receipt, status, and identity and revalidates them on hydrate", () => {
    const db = new Database(":memory:");
    createDomain(db);
    const store = new SlidePlanStore(db);
    const value = publication();
    const manifest = JSON.parse(value.manifestJson) as Record<string, unknown>;
    const receipt = manifest.finalityReceipt as Record<string, unknown>;
    const tamperedReceiptJson = `${JSON.stringify({ ...manifest, finalityReceipt: { ...receipt, confirmedAt: 201 } })}\n`;
    expect(() => store.save({ ...value, manifestJson: tamperedReceiptJson, publicationSha256: sha256(tamperedReceiptJson) }, 1)).toThrow(/receipt|confirmed/i);
    const draftStatusJson = `${JSON.stringify({ ...manifest, publicationStatus: "draft" })}\n`;
    expect(() => store.save({ ...value, manifestJson: draftStatusJson, publicationSha256: sha256(draftStatusJson) }, 1)).toThrow(/status|manifest/i);
    const missingReceipt = { ...manifest };
    delete missingReceipt.finalityReceipt;
    const missingReceiptJson = `${JSON.stringify(missingReceipt)}\n`;
    expect(() => store.save({ ...value, manifestJson: missingReceiptJson, publicationSha256: sha256(missingReceiptJson) }, 1)).toThrow(/receipt/i);
    const tamperedIdentityJson = `${JSON.stringify({ ...manifest, identity: { ...value.identity, deckId: "forged-deck" } })}\n`;
    expect(() => store.save({ ...value, manifestJson: tamperedIdentityJson, publicationSha256: sha256(tamperedIdentityJson) }, 1)).toThrow(/identity/i);
    const saved = store.save(value, 1);
    db.run("UPDATE slide_plan_publications SET finality_receipt_json = ? WHERE publication_id = ?", [JSON.stringify({ ...saved.finalityReceipt, confirmedAt: 999 }), saved.publicationId]);
    expect(() => store.one(saved.plan.planId)).toThrow(/receipt|hash|finality/i);
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run("UPDATE slide_plan_publications SET finality_receipt_json = NULL, finality_receipt_sha256 = NULL WHERE publication_id = ?", [saved.publicationId]);
    expect(() => store.one(saved.plan.planId)).toThrow(/receipt|finality/i);
    db.close();
  });

  test("hydrate rejects a raw finality receipt byte change with the persisted SHA unchanged", () => {
    const db = new Database(":memory:");
    createDomain(db);
    const store = new SlidePlanStore(db);
    const saved = store.save(publication(), 1);
    const persisted = db.query(`SELECT finality_receipt_json AS receipt, finality_receipt_sha256 AS receiptSha
      FROM slide_plan_publications WHERE publication_id = ?`).get(saved.publicationId) as {
        receipt: string;
        receiptSha: string;
      };
    expect(persisted.receipt.endsWith("\n")).toBe(true);
    expect(sha256(persisted.receipt)).toBe(persisted.receiptSha);

    db.run("UPDATE slide_plan_publications SET finality_receipt_json = ? WHERE publication_id = ?", [
      persisted.receipt.slice(0, -1), saved.publicationId,
    ]);

    expect(() => store.one(saved.plan.planId)).toThrow(/receipt.*(byte|hash|canonical)/i);
    db.close();
  });

  test("drafts carry no Review receipt", () => {
    const db = new Database(":memory:");
    const store = new SlidePlanStore(db);
    const saved = store.save(publication(plan("draft-plan"), "draft"), 1);
    expect(saved).toMatchObject({ publicationStatus: "draft", publicationSeq: 1 });
    expect(saved).not.toHaveProperty("reviewId");
    expect(saved).not.toHaveProperty("finalityReceipt");
    expect(publicationRows(db)[0]).toMatchObject({ review_id: null, finality_receipt_json: null, finality_receipt_sha256: null });
    db.close();
  });
});

describe("SlidePlanStore atomic historical migration", () => {
  test("migrates the original plan_id primary-key schema", () => {
    const db = new Database(":memory:");
    createDomain(db);
    db.run(`CREATE TABLE slide_plan_publications (${historicalColumns})`);
    insertHistorical(db, publication());
    const store = new SlidePlanStore(db);
    expect(store.one("plan-store")).toMatchObject({ publicationStatus: "final", publicationSeq: 1, publishedAt: 42 });
    expect(publicationRows(db)[0]?.finality_receipt_json).not.toBeNull();
    db.close();
  });

  test("migrates the immediate publication_id and revision schema without status", () => {
    const db = new Database(":memory:");
    createImmediateSchema(db);
    insertHistorical(db, publication(plan("prior-plan"), "draft"), "slide_plan_publications", true);
    const store = new SlidePlanStore(db);
    expect(store.one("prior-plan")).toMatchObject({ publicationStatus: "draft", publicationSeq: 1 });
    db.close();
  });

  test("migrates the current status schema without sequence or receipt", () => {
    const db = new Database(":memory:");
    createDomain(db);
    createImmediateSchema(db, "slide_plan_publications", true);
    insertHistorical(db, publication(), "slide_plan_publications", true, true);
    const store = new SlidePlanStore(db);
    expect(store.latest()).toMatchObject({ publicationStatus: "final", publicationSeq: 1 });
    expect(publicationRows(db)[0]?.finality_receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });

  test("migrates the ALTER-appended trailing publication_status schema", () => {
    const db = new Database(":memory:");
    createDomain(db);
    createImmediateSchema(db);
    db.run(`ALTER TABLE slide_plan_publications ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft', 'final'))`);
    insertHistorical(db, publication(), "slide_plan_publications", true);
    db.run("UPDATE slide_plan_publications SET publication_status = 'final'");
    const store = new SlidePlanStore(db);
    expect(store.latest()).toMatchObject({ publicationStatus: "final", publicationSeq: 1 });
    expect(publicationRows(db)[0]?.finality_receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });

  test("recovers leftover staging deterministically and leaves no staging residue", () => {
    const db = new Database(":memory:");
    createImmediateSchema(db);
    insertHistorical(db, publication(plan("canonical-draft"), "draft"), "slide_plan_publications", true);
    createImmediateSchema(db, "slide_plan_publications_staging");
    insertHistorical(db, publication(plan("staging-only"), "draft"), "slide_plan_publications_staging", true);
    const store = new SlidePlanStore(db);
    expect(store.list().map(({ plan }) => plan.planId)).toEqual(["canonical-draft"]);
    expect(tableNames(db).filter((name) => name.includes("staging"))).toEqual([]);
    const reasons = db.query("SELECT reason FROM slide_plan_publication_quarantine ORDER BY quarantine_id").all();
    expect(reasons).toEqual([{ reason: "staging-only-row" }]);
    db.close();
  });

  test("handles recognized staging recovery and leaves unknown staging unchanged with or without a marker", () => {
    const bound = new Database(":memory:");
    createImmediateSchema(bound, "slide_plan_publications_staging");
    insertHistorical(bound, publication(plan("bound-staging"), "draft"), "slide_plan_publications_staging", true);
    migrationMarker(bound, "slide_plan_publications_staging");
    const resumed = new SlidePlanStore(bound);
    expect(resumed.list().map(({ plan }) => plan.planId)).toEqual(["bound-staging"]);
    expect(tableNames(bound).filter((name) => name.includes("staging") || name.includes("migration"))).toEqual([]);
    bound.close();

    const unbound = new Database(":memory:");
    createImmediateSchema(unbound, "slide_plan_publications_staging");
    insertHistorical(unbound, publication(plan("unbound-staging"), "draft"), "slide_plan_publications_staging", true);
    const recovered = new SlidePlanStore(unbound);
    expect(recovered.list()).toEqual([]);
    expect(unbound.query("SELECT reason FROM slide_plan_publication_quarantine").all()).toEqual([{ reason: "unbound-staging-row" }]);
    expect(tableNames(unbound).filter((name) => name.includes("staging") || name.includes("migration"))).toEqual([]);
    unbound.close();

    for (const withMarker of [false, true]) {
      const unknown = new Database(":memory:");
      unknown.run("CREATE TABLE slide_plan_publications_staging (mystery TEXT, payload BLOB)");
      unknown.run("INSERT INTO slide_plan_publications_staging VALUES ('keep', x'00ff')");
      if (withMarker) migrationMarker(unknown, "slide_plan_publications_staging");
      const before = unknownStagingSnapshot(unknown);

      expect(() => new SlidePlanStore(unknown)).toThrow(/unknown.*staging.*schema/i);
      expect(unknownStagingSnapshot(unknown)).toEqual(before);
      expect(tableNames(unknown)).not.toContain("slide_plan_publications");
      expect(tableNames(unknown)).not.toContain("slide_plan_publication_quarantine");
      unknown.close();
    }
  });

  test("recovers target-shaped staging with canonical-first authority and explicit rowid aliases", () => {
    const bound = new Database(":memory:");
    targetStaging(bound, ["target-bound-a", "target-bound-b"]);
    const unaliasedRowid = bound.query("SELECT rowid FROM slide_plan_publications_staging ORDER BY rowid LIMIT 1").get();
    const aliasedRowid = bound.query("SELECT rowid AS source_rowid FROM slide_plan_publications_staging ORDER BY rowid LIMIT 1").get();
    expect(unaliasedRowid).toEqual({ publication_seq: 1 });
    expect(aliasedRowid).toEqual({ source_rowid: 1 });
    migrationMarker(bound, "slide_plan_publications_staging");

    const resumed = new SlidePlanStore(bound);
    const resumedPlanIds = resumed.list().map(({ plan }) => plan.planId);
    const boundResidue = tableNames(bound).filter((name) => name.includes("staging") || name.includes("migration"));

    expect(resumedPlanIds).toEqual(["target-bound-b", "target-bound-a"]);
    expect(boundResidue).toEqual([]);
    bound.close();

    const unbound = new Database(":memory:");
    targetStaging(unbound, ["target-unbound-a", "target-unbound-b"]);

    const recovered = new SlidePlanStore(unbound);

    const unboundReasons = unbound.query("SELECT reason, count(*) AS count FROM slide_plan_publication_quarantine GROUP BY reason").all();
    const unboundValueCount = unbound.query("SELECT count(*) AS count FROM slide_plan_publication_quarantine_values").get();
    const unboundResidue = tableNames(unbound).filter((name) => name.includes("staging") || name.includes("migration"));
    expect(recovered.list()).toEqual([]);
    expect(unboundReasons).toEqual([{ reason: "unbound-staging-row", count: 2 }]);
    expect(unboundValueCount).toEqual({ count: 34 });
    expect(unboundResidue).toEqual([]);
    unbound.close();

    const divergent = new Database(":memory:");
    const canonical = new SlidePlanStore(divergent);
    canonical.save(publication(plan("target-canonical"), "draft"), 1);
    cloneTargetSchema(divergent, "slide_plan_publications_staging");
    divergent.run("INSERT INTO slide_plan_publications_staging SELECT * FROM slide_plan_publications");
    divergent.run("UPDATE slide_plan_publications_staging SET publication_path = '/divergent-staging-path'");

    const authoritative = new SlidePlanStore(divergent);

    const authoritativePlanIds = authoritative.list().map(({ plan }) => plan.planId);
    const divergentReasons = divergent.query("SELECT reason FROM slide_plan_publication_quarantine").all();
    const divergentPath = divergent.query(`SELECT hex(value_bytes) AS valueHex FROM slide_plan_publication_quarantine_values
      WHERE name = 'publication_path'`).get();
    expect(authoritativePlanIds).toEqual(["target-canonical"]);
    expect(divergentReasons).toEqual([{ reason: "staging-only-row" }]);
    expect(divergentPath).toEqual({ valueHex: Buffer.from("/divergent-staging-path").toString("hex").toUpperCase() });
    expect(tableNames(divergent)).not.toContain("slide_plan_publications_staging");
    divergent.close();

    const staleMarker = new Database(":memory:");
    const staleCanonical = new SlidePlanStore(staleMarker);
    staleCanonical.save(publication(plan("target-stale-marker"), "draft"), 1);
    cloneTargetSchema(staleMarker, "slide_plan_publications_staging");
    staleMarker.run("INSERT INTO slide_plan_publications_staging SELECT * FROM slide_plan_publications");
    migrationMarker(staleMarker, "slide_plan_publications_staging");
    staleMarker.run("UPDATE slide_plan_publications_migration SET source_row_digest = 'stale'");

    const canonicalWins = new SlidePlanStore(staleMarker);

    const staleMarkerPlanIds = canonicalWins.list().map(({ plan }) => plan.planId);
    const staleMarkerResidue = tableNames(staleMarker).filter((name) => name.includes("staging") || name.includes("migration"));
    const staleMarkerQuarantine = staleMarker.query("SELECT count(*) AS count FROM slide_plan_publication_quarantine").get();
    expect(staleMarkerPlanIds).toEqual(["target-stale-marker"]);
    expect(staleMarkerResidue).toEqual([]);
    expect(staleMarkerQuarantine).toEqual({ count: 0 });
    const evidenceDirectory = process.env.EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      writeFileSync(join(evidenceDirectory, "remediation-2-proof.json"), `${JSON.stringify({
        bunRowidAlias: { unaliased: unaliasedRowid, aliased: aliasedRowid },
        markerBoundTarget: { planIds: resumedPlanIds, residue: boundResidue },
        unboundTarget: { publications: 0, reasons: unboundReasons, valueCount: unboundValueCount, residue: unboundResidue },
        divergentTarget: { canonicalPlanIds: authoritativePlanIds, reasons: divergentReasons, publicationPath: divergentPath },
        staleMarkerCanonicalAuthority: { planIds: staleMarkerPlanIds, residue: staleMarkerResidue, quarantine: staleMarkerQuarantine },
      }, null, 2)}\n`);
    }
    staleMarker.close();
  });

  test("preserves every valid historical typed cell and reconciles invalid cells to quarantine before swap", () => {
    const db = new Database(":memory:");
    createDomain(db);
    createImmediateSchema(db);
    insertHistorical(db, publication(), "slide_plan_publications", true);
    const nonCanonicalItems = `[ "action-a", "decision-z" ]`;
    db.run("UPDATE slide_plan_publications SET reviewed_item_ids_json = ? WHERE rowid = 1", [nonCanonicalItems]);
    db.run(`INSERT INTO slide_plan_publications
      (publication_id, plan_id, revision, meeting_id, identity_json, plan_json, plan_sha256,
       publication_sha256, publication_path, review_id, reviewed_item_ids_json, published_at)
      VALUES ('bad', 17, 0, 1, '{}', x'00ff', 'bad-hash', 'bad-publication', '/bad', NULL, NULL, 9)`);
    const validSource = typedCells(db, "slide_plan_publications", 1);
    const invalidSource = typedCells(db, "slide_plan_publications", 2);

    const store = new SlidePlanStore(db);

    expect(store.one("plan-store")?.reviewedItemIds).toEqual(["action-a", "decision-z"]);
    const targetByName = new Map(typedCells(db, "slide_plan_publications", 1).map((cell) => [cell.name, cell]));
    for (const sourceCell of validSource) {
      expect(targetByName.get(sourceCell.name)).toMatchObject({
        name: sourceCell.name,
        sqliteType: sourceCell.sqliteType,
        valueHex: sourceCell.valueHex,
      });
    }
    expect((targetByName.get("reviewed_item_ids_json")?.valueHex)).toBe(Buffer.from(nonCanonicalItems).toString("hex").toUpperCase());
    const quarantine = db.query(`SELECT v.ordinal, v.name, v.sqlite_type AS sqliteType,
      coalesce(hex(v.value_bytes), '') AS valueHex
      FROM slide_plan_publication_quarantine q
      JOIN slide_plan_publication_quarantine_values v USING(quarantine_id)
      WHERE q.source_rowid = 2 ORDER BY v.ordinal`).all();
    expect(quarantine).toEqual(invalidSource);
    db.close();
  });

  test("quarantines malformed dynamically typed rows as typed per-column BLOB values", () => {
    const db = new Database(":memory:");
    createImmediateSchema(db);
    insertHistorical(db, publication(plan("valid-draft"), "draft"), "slide_plan_publications", true);
    db.run(`INSERT INTO slide_plan_publications
      (publication_id, plan_id, revision, meeting_id, identity_json, plan_json, plan_sha256,
       publication_sha256, publication_path, review_id, reviewed_item_ids_json, published_at)
      VALUES ('bad', 17, 0, 1, '{}', x'00ff', 'bad-hash', 'bad-publication', '/bad', NULL, NULL, 9)`);
    const store = new SlidePlanStore(db);
    expect(store.list().map(({ plan }) => plan.planId)).toEqual(["valid-draft"]);
    const quarantine = db.query(`SELECT q.reason, v.ordinal, v.name, v.sqlite_type, hex(v.value_bytes) AS bytes
      FROM slide_plan_publication_quarantine q
      JOIN slide_plan_publication_quarantine_values v USING(quarantine_id)
      WHERE v.name IN ('plan_id', 'plan_json') ORDER BY v.ordinal`).all();
    expect(quarantine).toEqual([
      { reason: "invalid-publication-row", ordinal: 1, name: "plan_id", sqlite_type: "text", bytes: "3137" },
      { reason: "invalid-publication-row", ordinal: 5, name: "plan_json", sqlite_type: "blob", bytes: "00FF" },
    ]);
    db.close();
  });

  test("orders latest, list, and one by monotonic sequence when publishedAt moves backward", () => {
    const db = new Database(":memory:");
    const store = new SlidePlanStore(db);
    const draft = store.save(publication(plan("draft-plan"), "draft"), 200);
    const finalPlan = plan("final-plan");
    createDomain(db);
    const final = store.save(publication(finalPlan), 100);
    expect(final.publicationSeq).toBeGreaterThan(draft.publicationSeq);
    expect(store.latest(1)).toEqual(final);
    expect(store.list(1)).toEqual([final, draft]);
    expect(store.one("final-plan")).toEqual(final);
    db.close();
  });

  test("rollback preserves source schema, count, and bytes after an injected migration failure", () => {
    const db = new Database(":memory:");
    createImmediateSchema(db);
    const value = publication(plan("rollback-draft"), "draft");
    insertHistorical(db, value, "slide_plan_publications", true);
    const beforeSchema = (db.query("SELECT sql FROM sqlite_master WHERE name='slide_plan_publications'").get() as { sql: string }).sql;
    const before = db.query("SELECT quote(plan_json) AS plan, count(*) AS count FROM slide_plan_publications").get();
    expect(() => new SlidePlanStore(db, { injectMigrationFailure: "after-copy" })).toThrow(/injected migration failure/i);
    expect((db.query("SELECT sql FROM sqlite_master WHERE name='slide_plan_publications'").get() as { sql: string }).sql).toBe(beforeSchema);
    expect(db.query("SELECT quote(plan_json) AS plan, count(*) AS count FROM slide_plan_publications").get()).toEqual(before);
    expect(tableNames(db).filter((name) => name.includes("staging") || name.includes("migration"))).toEqual([]);
    db.close();
  });

  test("reopen and rerun are idempotent with no staging residue", () => {
    const root = mkdtempSync(join(tmpdir(), "slide-plan-store-rerun-"));
    roots.push(root);
    const path = join(root, "fixture.db");
    const db = new Database(path);
    createImmediateSchema(db);
    insertHistorical(db, publication(plan("rerun-draft"), "draft"), "slide_plan_publications", true);
    const firstStore = new SlidePlanStore(db);
    const first = { rows: publicationRows(db), quarantine: db.query("SELECT * FROM slide_plan_publication_quarantine ORDER BY quarantine_id").all() };
    expect(firstStore.list()).toHaveLength(1);
    db.close();
    const reopened = new Database(path);
    const secondStore = new SlidePlanStore(reopened);
    expect({ rows: publicationRows(reopened), quarantine: reopened.query("SELECT * FROM slide_plan_publication_quarantine ORDER BY quarantine_id").all() }).toEqual(first);
    expect(secondStore.list()).toHaveLength(1);
    expect(tableNames(reopened).filter((name) => name.includes("staging"))).toEqual([]);
    reopened.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("leaves unknown publication schemas unchanged and fails closed", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE slide_plan_publications (mystery TEXT, payload BLOB)");
    db.run("INSERT INTO slide_plan_publications VALUES ('keep', x'00ff')");
    const before = db.query("SELECT sql FROM sqlite_master WHERE name='slide_plan_publications'").get();
    expect(() => new SlidePlanStore(db)).toThrow(/unknown.*schema/i);
    expect(db.query("SELECT sql FROM sqlite_master WHERE name='slide_plan_publications'").get()).toEqual(before);
    expect(db.query("SELECT mystery, hex(payload) AS payload FROM slide_plan_publications").all()).toEqual([{ mystery: "keep", payload: "00FF" }]);
    db.close();
  });
});

test("emits remediation proof for receipt bytes, historical cells, reconciliation, and unknown staging", () => {
  const receiptDb = new Database(":memory:");
  createDomain(receiptDb);
  const receiptStore = new SlidePlanStore(receiptDb);
  const saved = receiptStore.save(publication(), 1);
  const receiptRow = receiptDb.query(`SELECT finality_receipt_json AS receipt, finality_receipt_sha256 AS receiptSha
    FROM slide_plan_publications WHERE publication_id = ?`).get(saved.publicationId) as {
      receipt: string;
      receiptSha: string;
    };
  receiptDb.run("UPDATE slide_plan_publications SET finality_receipt_json = ? WHERE publication_id = ?", [
    receiptRow.receipt.slice(0, -1), saved.publicationId,
  ]);
  let receiptError = "";
  try {
    receiptStore.one(saved.plan.planId);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    receiptError = error.message;
  }
  expect(receiptError).toMatch(/receipt.*(byte|hash|canonical)/i);
  receiptDb.close();

  const migrationDb = new Database(":memory:");
  createDomain(migrationDb);
  createImmediateSchema(migrationDb);
  insertHistorical(migrationDb, publication(), "slide_plan_publications", true);
  const historicalJson = `[ "action-a", "decision-z" ]`;
  migrationDb.run("UPDATE slide_plan_publications SET reviewed_item_ids_json = ? WHERE rowid = 1", [historicalJson]);
  migrationDb.run(`INSERT INTO slide_plan_publications
    (publication_id, plan_id, revision, meeting_id, identity_json, plan_json, plan_sha256,
     publication_sha256, publication_path, review_id, reviewed_item_ids_json, published_at)
    VALUES ('bad', 17, 0, 1, '{}', x'00ff', 'bad-hash', 'bad-publication', '/bad', NULL, NULL, 9)`);
  const validSource = typedCells(migrationDb, "slide_plan_publications", 1);
  const invalidSource = typedCells(migrationDb, "slide_plan_publications", 2);
  new SlidePlanStore(migrationDb);
  const targetByName = new Map(typedCells(migrationDb, "slide_plan_publications", 1).map((cell) => [cell.name, cell]));
  const validCellsPreserved = validSource.every((source) => {
    const target = targetByName.get(source.name);
    return target?.sqliteType === source.sqliteType && target.valueHex === source.valueHex;
  });
  const quarantineCells = migrationDb.query(`SELECT v.ordinal, v.name, v.sqlite_type AS sqliteType,
    coalesce(hex(v.value_bytes), '') AS valueHex
    FROM slide_plan_publication_quarantine q
    JOIN slide_plan_publication_quarantine_values v USING(quarantine_id)
    WHERE q.source_rowid = 2 ORDER BY v.ordinal`).all();
  const quarantineCellsReconciled = JSON.stringify(quarantineCells) === JSON.stringify(invalidSource);
  expect(validCellsPreserved).toBe(true);
  expect(quarantineCellsReconciled).toBe(true);
  migrationDb.close();

  const unknownResults: Array<{
    readonly withMarker: boolean;
    readonly error: string;
    readonly unchanged: boolean;
  }> = [];
  for (const withMarker of [false, true]) {
    const unknown = new Database(":memory:");
    unknown.run("CREATE TABLE slide_plan_publications_staging (mystery TEXT, payload BLOB)");
    unknown.run("INSERT INTO slide_plan_publications_staging VALUES ('keep', x'00ff')");
    if (withMarker) migrationMarker(unknown, "slide_plan_publications_staging");
    const before = unknownStagingSnapshot(unknown);
    let error = "";
    try {
      new SlidePlanStore(unknown);
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      error = caught.message;
    }
    const after = unknownStagingSnapshot(unknown);
    unknownResults.push({ withMarker, error, unchanged: JSON.stringify(after) === JSON.stringify(before) });
    unknown.close();
  }
  expect(unknownResults).toEqual([
    { withMarker: false, error: "unknown publication staging schema; database left unchanged", unchanged: true },
    { withMarker: true, error: "unknown publication staging schema; database left unchanged", unchanged: true },
  ]);

  const evidenceDirectory = process.env.EVIDENCE_DIR;
  if (evidenceDirectory !== undefined) {
    writeFileSync(join(evidenceDirectory, "remediation-proof.json"), `${JSON.stringify({
      rawReceiptTamper: {
        canonicalEndsWithNewline: receiptRow.receipt.endsWith("\n"),
        actualCanonicalSha256: sha256(receiptRow.receipt),
        persistedSha256: receiptRow.receiptSha,
        tamperedActualSha256: sha256(receiptRow.receipt.slice(0, -1)),
        rejected: receiptError !== "",
        error: receiptError,
      },
      historicalBytes: {
        reviewedItemIdsSourceHex: Buffer.from(historicalJson).toString("hex").toUpperCase(),
        reviewedItemIdsTargetHex: targetByName.get("reviewed_item_ids_json")?.valueHex,
        everyValidSourceCellPreserved: validCellsPreserved,
      },
      reconciliation: {
        validSourceCellCount: validSource.length,
        quarantinedSourceCellCount: invalidSource.length,
        everyQuarantinedSourceCellReconciled: quarantineCellsReconciled,
      },
      unknownStaging: unknownResults,
    }, null, 2)}\n`);
  }
});

test("emits migration evidence with retained draft and final, typed quarantine, backward clock, and rerun receipts", () => {
  const evidenceDirectory = process.env.EVIDENCE_DIR;
  const evidenceDatabase = process.env.EVIDENCE_DB;
  if (evidenceDirectory === undefined || evidenceDatabase === undefined) return;
  rmSync(evidenceDatabase, { force: true });
  rmSync(`${evidenceDatabase}-wal`, { force: true });
  rmSync(`${evidenceDatabase}-shm`, { force: true });
  const db = new Database(evidenceDatabase);
  createDomain(db);
  createImmediateSchema(db);
  insertHistorical(db, publication(plan("retained-draft"), "draft"), "slide_plan_publications", true);
  db.run("UPDATE slide_plan_publications SET published_at = 200 WHERE plan_id = 'retained-draft'");
  db.run(`INSERT INTO slide_plan_publications
    (publication_id, plan_id, revision, meeting_id, identity_json, plan_json, plan_sha256,
     publication_sha256, publication_path, review_id, reviewed_item_ids_json, published_at)
    VALUES ('bad', 17, 0, 1, '{}', x'00ff', 'bad-hash', 'bad-publication', '/bad', NULL, NULL, 9)`);
  const store = new SlidePlanStore(db);
  const final = store.save(publication(plan("retained-final")), 100);
  const firstRows = publicationRows(db);
  const firstQuarantine = db.query("SELECT * FROM slide_plan_publication_quarantine ORDER BY quarantine_id").all();
  expect(store.latest(1)).toEqual(final);
  db.close();

  const reopened = new Database(evidenceDatabase);
  const rerun = new SlidePlanStore(reopened);
  const secondRows = publicationRows(reopened);
  const secondQuarantine = reopened.query("SELECT * FROM slide_plan_publication_quarantine ORDER BY quarantine_id").all();
  expect(secondRows).toEqual(firstRows);
  expect(secondQuarantine).toEqual(firstQuarantine);
  expect(rerun.list(1).map(({ plan }) => plan.planId)).toEqual(["retained-final", "retained-draft"]);
  const schema = (reopened.query("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'slide_plan_%' ORDER BY type,name").all() as Array<{ sql: string | null }>).map(({ sql }) => sql).filter((sql) => sql !== null).join(";\n\n");
  writeFileSync(join(evidenceDirectory, "schema.sql"), `${schema};\n`);
  writeFileSync(join(evidenceDirectory, "rows.json"), `${JSON.stringify({ publications: secondRows, quarantine: secondQuarantine, latestPlanId: rerun.latest(1)?.plan.planId, stagingTables: tableNames(reopened).filter((name) => name.includes("staging")) }, null, 2)}\n`);
  reopened.run("PRAGMA wal_checkpoint(TRUNCATE)");
  reopened.close();
});
