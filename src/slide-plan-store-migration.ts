// allow: SIZE_OK — atomic SQLite migration/recovery is one indivisible transaction state machine.
import type { Database } from "bun:sqlite";

import {
  assertHash,
  assertIdentity,
  decodeIdentity,
  decodeStringArray,
  deriveFinalityReceipt,
  equal,
  stableFinalityReceiptJson,
} from "./slide-plan-finality.ts";
import { parseSlidePlan } from "./slides/model/plan-parser.ts";
import { pipelineHash, stableSlidePlanJson } from "./slides/server-pipeline-publication.ts";
import type { SlidePlanPublicationStatus } from "./slides/server-pipeline-types.ts";

const PUBLICATION_TABLE = "slide_plan_publications";
const STAGING_TABLE = "slide_plan_publications_staging";
const MARKER_TABLE = "slide_plan_publications_migration";
const MIGRATION_TARGET = "slide_plan_publications_migration_new";

const ORIGINAL_COLUMNS = [
  "plan_id", "meeting_id", "identity_json", "plan_json", "plan_sha256",
  "publication_sha256", "publication_path", "review_id", "reviewed_item_ids_json", "published_at",
] as const;
const PREVIOUS_COLUMNS = [
  "publication_id", "plan_id", "revision", "meeting_id", "identity_json", "plan_json",
  "plan_sha256", "publication_sha256", "publication_path", "review_id",
  "reviewed_item_ids_json", "published_at",
] as const;
const STATUS_COLUMNS = [
  "publication_id", "plan_id", "revision", "meeting_id", "identity_json", "plan_json",
  "plan_sha256", "publication_sha256", "publication_status", "publication_path", "review_id",
  "reviewed_item_ids_json", "published_at",
] as const;
const TRAILING_STATUS_COLUMNS = [
  "publication_id", "plan_id", "revision", "meeting_id", "identity_json", "plan_json",
  "plan_sha256", "publication_sha256", "publication_path", "review_id",
  "reviewed_item_ids_json", "published_at", "publication_status",
] as const;
const TARGET_COLUMNS = [
  "publication_seq", "publication_id", "plan_id", "revision", "meeting_id", "identity_json",
  "plan_json", "plan_sha256", "manifest_json", "publication_sha256", "publication_status",
  "publication_path", "review_id", "reviewed_item_ids_json", "finality_receipt_json",
  "finality_receipt_sha256", "published_at",
] as const;
const MARKER_COLUMNS = ["source_schema_sha256", "source_row_count", "source_row_digest", "phase"] as const;

export type HistoricalPublicationShape = "original" | "previous" | "status" | "trailing-status" | "target";

export type PublicationRow = {
  readonly publication_seq: number;
  readonly publication_id: string;
  readonly plan_id: string;
  readonly revision: number;
  readonly meeting_id: number;
  readonly identity_json: string;
  readonly plan_json: string;
  readonly plan_sha256: string;
  readonly manifest_json: string | null;
  readonly publication_sha256: string;
  readonly publication_status: SlidePlanPublicationStatus;
  readonly publication_path: string;
  readonly review_id: string | null;
  readonly reviewed_item_ids_json: string | null;
  readonly finality_receipt_json: string | null;
  readonly finality_receipt_sha256: string | null;
  readonly published_at: number;
};

export type MigrationCandidate = Omit<PublicationRow, "publication_seq">;

export type StoreMigrationOptions = {
  readonly injectMigrationFailure?: "after-copy";
};

type TypedCell = {
  readonly ordinal: number;
  readonly name: string;
  readonly sqliteType: string;
  readonly valueHex: string;
};

type MigrationOutcome =
  | { readonly kind: "target"; readonly sourceRowid: number; readonly sequence: number }
  | { readonly kind: "quarantine"; readonly sourceRowid: number; readonly quarantineId: number };

type MarkerRow = {
  readonly source_schema_sha256: string;
  readonly source_row_count: number;
  readonly source_row_digest: string;
  readonly phase: string;
};

export class SlidePlanMigrationError extends Error {
  readonly name = "SlidePlanMigrationError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

function tableExists(database: Database, name: string): boolean {
  return database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function schemaSql(database: Database, table: string): string {
  const row = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { readonly sql: string } | null;
  return row?.sql ?? "";
}

function columnNames(database: Database, table: string): readonly string[] {
  return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>).map(({ name }) => name);
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function publicationShape(database: Database, table: string): HistoricalPublicationShape | null {
  const columns = columnNames(database, table);
  if (sameColumns(columns, ORIGINAL_COLUMNS)) return "original";
  if (sameColumns(columns, PREVIOUS_COLUMNS)) return "previous";
  if (sameColumns(columns, STATUS_COLUMNS)) return "status";
  if (sameColumns(columns, TRAILING_STATUS_COLUMNS)) return "trailing-status";
  if (sameColumns(columns, TARGET_COLUMNS)) return "target";
  return null;
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function typedCells(database: Database, table: string, rowid: number): readonly TypedCell[] {
  return columnNames(database, table).map((name, ordinal) => {
    const cell = database.query(`SELECT typeof(${quotedIdentifier(name)}) AS sqliteType,
      coalesce(hex(CAST(${quotedIdentifier(name)} AS BLOB)), '') AS valueHex
      FROM ${quotedIdentifier(table)} WHERE rowid = ?`).get(rowid) as {
        readonly sqliteType: string;
        readonly valueHex: string;
      };
    return { ordinal, name, ...cell };
  });
}

function typedRowDigest(database: Database, table: string, rowid: number): string {
  return pipelineHash(JSON.stringify(typedCells(database, table, rowid)));
}

function markerTableDigest(database: Database, table: string): string {
  const columns = columnNames(database, table);
  const rows = database.query(`SELECT rowid AS source_rowid FROM ${quotedIdentifier(table)} ORDER BY rowid`).all() as Array<{ readonly source_rowid: number }>;
  const rowDigests = rows.map(({ source_rowid }) => pipelineHash(JSON.stringify(columns.map((name) => database.query(
    `SELECT typeof(${quotedIdentifier(name)}) AS type, hex(CAST(${quotedIdentifier(name)} AS BLOB)) AS bytes
     FROM ${quotedIdentifier(table)} WHERE rowid = ?`,
  ).get(source_rowid)))));
  return pipelineHash(JSON.stringify(rowDigests));
}

function createTargetSchema(database: Database, table = PUBLICATION_TABLE): void {
  database.run(`CREATE TABLE ${table} (
    publication_seq INTEGER PRIMARY KEY CHECK (publication_seq > 0),
    publication_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    meeting_id INTEGER NOT NULL,
    identity_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    plan_sha256 TEXT NOT NULL,
    manifest_json TEXT,
    publication_sha256 TEXT NOT NULL,
    publication_status TEXT NOT NULL CHECK (publication_status IN ('draft', 'final')),
    publication_path TEXT NOT NULL,
    review_id TEXT,
    reviewed_item_ids_json TEXT,
    finality_receipt_json TEXT,
    finality_receipt_sha256 TEXT,
    published_at INTEGER NOT NULL,
    UNIQUE(plan_id, revision),
    CHECK ((publication_status = 'draft' AND review_id IS NULL AND reviewed_item_ids_json IS NULL
      AND finality_receipt_json IS NULL AND finality_receipt_sha256 IS NULL)
      OR (publication_status = 'final' AND review_id IS NOT NULL AND reviewed_item_ids_json IS NOT NULL
      AND finality_receipt_json IS NOT NULL AND finality_receipt_sha256 IS NOT NULL))
  )`);
}

function createIndexes(database: Database): void {
  database.run(`CREATE INDEX IF NOT EXISTS idx_slide_plan_publications_meeting_sequence
    ON slide_plan_publications(meeting_id, publication_seq DESC)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_slide_plan_publications_plan_sequence
    ON slide_plan_publications(plan_id, publication_seq DESC)`);
}

function createQuarantineSchema(database: Database): void {
  database.run(`CREATE TABLE IF NOT EXISTS slide_plan_publication_quarantine (
    quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    source_rowid INTEGER NOT NULL,
    reason TEXT NOT NULL,
    source_schema_sha256 TEXT NOT NULL
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS slide_plan_publication_quarantine_values (
    quarantine_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    sqlite_type TEXT NOT NULL,
    value_bytes BLOB,
    PRIMARY KEY (quarantine_id, ordinal),
    FOREIGN KEY (quarantine_id) REFERENCES slide_plan_publication_quarantine(quarantine_id) ON DELETE CASCADE
  )`);
}

function quarantineRow(
  database: Database,
  request: { readonly table: string; readonly rowid: number; readonly reason: string },
): number {
  const { table, rowid, reason } = request;
  const inserted = database.run(`INSERT INTO slide_plan_publication_quarantine
    (source_table, source_rowid, reason, source_schema_sha256) VALUES (?, ?, ?, ?)`,
  [table, rowid, reason, pipelineHash(schemaSql(database, table))]);
  const quarantineId = Number(inserted.lastInsertRowid);
  for (const cell of typedCells(database, table, rowid)) {
    database.run(`INSERT INTO slide_plan_publication_quarantine_values
      (quarantine_id, ordinal, name, sqlite_type, value_bytes)
      SELECT ?, ?, ?, ?, CAST(${quotedIdentifier(cell.name)} AS BLOB)
      FROM ${quotedIdentifier(table)} WHERE rowid = ?`,
    [quarantineId, cell.ordinal, cell.name, cell.sqliteType, rowid]);
  }
  return quarantineId;
}

export function insertPublicationCandidate(
  database: Database,
  request: { readonly table: string; readonly sequence: number; readonly candidate: MigrationCandidate },
): void {
  const { table, sequence, candidate } = request;
  database.run(`INSERT INTO ${table} (${TARGET_COLUMNS.join(",")})
    VALUES (${TARGET_COLUMNS.map(() => "?").join(",")})`, [
    sequence, candidate.publication_id, candidate.plan_id, candidate.revision, candidate.meeting_id,
    candidate.identity_json, candidate.plan_json, candidate.plan_sha256, candidate.manifest_json,
    candidate.publication_sha256, candidate.publication_status, candidate.publication_path,
    candidate.review_id, candidate.reviewed_item_ids_json, candidate.finality_receipt_json,
    candidate.finality_receipt_sha256, candidate.published_at,
  ]);
}

function quarantineCells(database: Database, quarantineId: number): readonly TypedCell[] {
  return database.query(`SELECT ordinal, name, sqlite_type AS sqliteType,
    coalesce(hex(value_bytes), '') AS valueHex
    FROM slide_plan_publication_quarantine_values WHERE quarantine_id = ? ORDER BY ordinal`).all(quarantineId) as TypedCell[];
}

function reconcileSourceOutcomes(
  database: Database,
  request: {
    readonly sourceTable: string;
    readonly targetTable: string;
    readonly outcomes: readonly MigrationOutcome[];
  },
): void {
  const { sourceTable, targetTable, outcomes } = request;
  const sourceRows = database.query(`SELECT rowid AS source_rowid FROM ${quotedIdentifier(sourceTable)} ORDER BY rowid`).all() as Array<{ readonly source_rowid: number }>;
  if (sourceRows.length !== outcomes.length ||
      sourceRows.some(({ source_rowid }) => !outcomes.some((outcome) => outcome.sourceRowid === source_rowid))) {
    throw new SlidePlanMigrationError("migration source/outcome count reconciliation failed");
  }
  for (const outcome of outcomes) {
    const sourceCells = typedCells(database, sourceTable, outcome.sourceRowid);
    if (outcome.kind === "quarantine") {
      if (JSON.stringify(quarantineCells(database, outcome.quarantineId)) !== JSON.stringify(sourceCells)) {
        throw new SlidePlanMigrationError("migration source/quarantine typed-cell reconciliation failed");
      }
      continue;
    }
    const targetCells = typedCells(database, targetTable, outcome.sequence);
    const targetByName = new Map(targetCells.map((cell) => [cell.name, cell]));
    for (const sourceCell of sourceCells) {
      const targetCell = targetByName.get(sourceCell.name);
      if (targetCell === undefined || targetCell.sqliteType !== sourceCell.sqliteType || targetCell.valueHex !== sourceCell.valueHex) {
        throw new SlidePlanMigrationError(`migration source/target typed-cell reconciliation failed at ${sourceCell.name}`);
      }
    }
  }
}

function validatedMarker(database: Database): MarkerRow | null {
  if (!tableExists(database, MARKER_TABLE)) return null;
  if (!sameColumns(columnNames(database, MARKER_TABLE), MARKER_COLUMNS)) {
    throw new SlidePlanMigrationError("unknown publication migration marker schema; database left unchanged");
  }
  const rows = database.query(`SELECT * FROM ${MARKER_TABLE}`).all() as MarkerRow[];
  if (rows.length !== 1) throw new SlidePlanMigrationError("unrecognized publication migration marker binding; database left unchanged");
  return rows[0] ?? null;
}

function preflightRecovery(database: Database): void {
  if (tableExists(database, PUBLICATION_TABLE) && publicationShape(database, PUBLICATION_TABLE) === null) {
    throw new SlidePlanMigrationError("unknown slide_plan_publications schema; database left unchanged");
  }
  if (tableExists(database, STAGING_TABLE) && publicationShape(database, STAGING_TABLE) === null) {
    throw new SlidePlanMigrationError("unknown publication staging schema; database left unchanged");
  }
  const marker = validatedMarker(database);
  if (marker === null || tableExists(database, PUBLICATION_TABLE)) return;
  if (!tableExists(database, STAGING_TABLE)) {
    throw new SlidePlanMigrationError("unrecognized publication migration marker binding; database left unchanged");
  }
  const bound = marker.source_schema_sha256 === pipelineHash(schemaSql(database, STAGING_TABLE)) &&
    marker.source_row_count === (database.query(`SELECT count(*) AS count FROM ${STAGING_TABLE}`).get() as { readonly count: number }).count &&
    marker.source_row_digest === markerTableDigest(database, STAGING_TABLE) && marker.phase === "copied";
  if (!bound) throw new SlidePlanMigrationError("unrecognized publication migration marker binding; database left unchanged");
}

function recoverWithoutCanonical(database: Database): void {
  if (tableExists(database, PUBLICATION_TABLE) || !tableExists(database, STAGING_TABLE)) return;
  const marker = validatedMarker(database);
  if (marker !== null) {
    database.run(`ALTER TABLE ${STAGING_TABLE} RENAME TO ${PUBLICATION_TABLE}`);
  } else {
    const rows = database.query(`SELECT rowid AS source_rowid FROM ${STAGING_TABLE} ORDER BY rowid`).all() as Array<{ readonly source_rowid: number }>;
    const outcomes = rows.map(({ source_rowid }) => ({
      kind: "quarantine" as const,
      sourceRowid: source_rowid,
      quarantineId: quarantineRow(database, { table: STAGING_TABLE, rowid: source_rowid, reason: "unbound-staging-row" }),
    }));
    reconcileSourceOutcomes(database, { sourceTable: STAGING_TABLE, targetTable: STAGING_TABLE, outcomes });
    database.run(`DROP TABLE ${STAGING_TABLE}`);
  }
  if (tableExists(database, MARKER_TABLE)) database.run(`DROP TABLE ${MARKER_TABLE}`);
}

function reconcileCanonicalStaging(database: Database): void {
  if (!tableExists(database, STAGING_TABLE)) {
    if (tableExists(database, MARKER_TABLE)) database.run(`DROP TABLE ${MARKER_TABLE}`);
    return;
  }
  const canonicalDigests = new Set<string>();
  const canonicalRows = database.query(`SELECT rowid AS source_rowid FROM ${PUBLICATION_TABLE} ORDER BY rowid`).all() as Array<{ readonly source_rowid: number }>;
  for (const { source_rowid } of canonicalRows) canonicalDigests.add(typedRowDigest(database, PUBLICATION_TABLE, source_rowid));
  const stagingRows = database.query(`SELECT rowid AS source_rowid FROM ${STAGING_TABLE} ORDER BY rowid`).all() as Array<{ readonly source_rowid: number }>;
  const quarantined = stagingRows.flatMap(({ source_rowid }) => canonicalDigests.has(typedRowDigest(database, STAGING_TABLE, source_rowid)) ? [] : [{
    kind: "quarantine" as const,
    sourceRowid: source_rowid,
    quarantineId: quarantineRow(database, { table: STAGING_TABLE, rowid: source_rowid, reason: "staging-only-row" }),
  }]);
  for (const outcome of quarantined) {
    if (JSON.stringify(typedCells(database, STAGING_TABLE, outcome.sourceRowid)) !==
        JSON.stringify(quarantineCells(database, outcome.quarantineId))) {
      throw new SlidePlanMigrationError("staging/quarantine typed-cell reconciliation failed");
    }
  }
  database.run(`DROP TABLE ${STAGING_TABLE}`);
  if (tableExists(database, MARKER_TABLE)) database.run(`DROP TABLE ${MARKER_TABLE}`);
}

function publicationIdFor(plan: { readonly planId: string; readonly revision: number }, planSha256: string): string {
  return pipelineHash(`${plan.planId}\n${plan.revision}\n${planSha256}\n`);
}

function historicalCandidate(
  database: Database,
  row: Record<string, unknown>,
  shape: HistoricalPublicationShape,
): MigrationCandidate {
  const planJson = row.plan_json;
  const identityJson = row.identity_json;
  const planSha256 = row.plan_sha256;
  const publicationSha256 = row.publication_sha256;
  const path = row.publication_path;
  const meetingId = row.meeting_id;
  const publishedAt = row.published_at;
  if (typeof planJson !== "string" || typeof identityJson !== "string" || typeof planSha256 !== "string" ||
      typeof publicationSha256 !== "string" || typeof path !== "string" || path.length === 0 ||
      !Number.isSafeInteger(meetingId) || !Number.isSafeInteger(publishedAt) || (publishedAt as number) < 0) {
    throw new TypeError("historical publication columns have invalid SQLite types");
  }
  const plan = parseSlidePlan(planJson);
  const identity = decodeIdentity(identityJson);
  assertHash(planSha256, "historical planSha256");
  assertHash(publicationSha256, "historical publicationSha256");
  if (stableSlidePlanJson(plan) !== planJson || pipelineHash(planJson) !== planSha256) {
    throw new TypeError("historical SlidePlan hash mismatch");
  }
  assertIdentity(plan, identity);
  if (plan.snapshot.meetingId !== meetingId || plan.planId !== row.plan_id) {
    throw new TypeError("historical publication identity mismatch");
  }
  const revision = shape === "original" ? plan.revision : row.revision;
  if (!Number.isSafeInteger(revision) || revision !== plan.revision) throw new TypeError("historical revision mismatch");
  const status = identity.reviewId === undefined ? "draft" : "final";
  if ((shape === "status" || shape === "trailing-status") && row.publication_status !== status) {
    throw new TypeError("historical publication status mismatch");
  }
  const rawReviewId = row.review_id;
  const rawReviewedItemIds = row.reviewed_item_ids_json;
  if ((rawReviewId !== null && typeof rawReviewId !== "string") ||
      (rawReviewedItemIds !== null && typeof rawReviewedItemIds !== "string")) {
    throw new TypeError("historical Review columns have invalid SQLite types");
  }
  const reviewedItemIds = decodeStringArray(rawReviewedItemIds);
  if (rawReviewId !== (identity.reviewId ?? null) || !equal(reviewedItemIds, identity.reviewedItemIds)) {
    throw new TypeError("historical Review identity mismatch");
  }
  const receipt = status === "final" ? deriveFinalityReceipt(database, identity) : undefined;
  const receiptJson = receipt === undefined ? null : stableFinalityReceiptJson(receipt);
  const expectedPublicationId = publicationIdFor(plan, planSha256);
  if (shape !== "original" && row.publication_id !== expectedPublicationId) {
    throw new TypeError("historical publication ID mismatch");
  }
  return {
    publication_id: expectedPublicationId,
    plan_id: plan.planId,
    revision: plan.revision,
    meeting_id: plan.snapshot.meetingId,
    identity_json: identityJson,
    plan_json: planJson,
    plan_sha256: planSha256,
    manifest_json: null,
    publication_sha256: publicationSha256,
    publication_status: status,
    publication_path: path,
    review_id: rawReviewId,
    reviewed_item_ids_json: rawReviewedItemIds,
    finality_receipt_json: receiptJson,
    finality_receipt_sha256: receiptJson === null ? null : pipelineHash(receiptJson),
    published_at: publishedAt as number,
  };
}

export function migrateSlidePlanStore(database: Database, options: StoreMigrationOptions): void {
  preflightRecovery(database);
  database.transaction(() => {
    createQuarantineSchema(database);
    recoverWithoutCanonical(database);
    reconcileCanonicalStaging(database);
    if (!tableExists(database, PUBLICATION_TABLE)) {
      createTargetSchema(database);
      createIndexes(database);
      return;
    }
    const shape = publicationShape(database, PUBLICATION_TABLE);
    if (shape === null) throw new SlidePlanMigrationError("unknown publication schema after recovery");
    if (shape === "target") {
      createIndexes(database);
      return;
    }
    const rows = database.query(`SELECT rowid AS source_rowid, * FROM ${PUBLICATION_TABLE} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    createTargetSchema(database, MIGRATION_TARGET);
    const outcomes: MigrationOutcome[] = [];
    let sequence = 0;
    for (const row of rows) {
      const rowid = row.source_rowid;
      if (!Number.isSafeInteger(rowid)) throw new SlidePlanMigrationError("source rowid is invalid");
      try {
        sequence += 1;
        insertPublicationCandidate(database, {
          table: MIGRATION_TARGET,
          sequence,
          candidate: historicalCandidate(database, row, shape),
        });
        outcomes.push({ kind: "target", sourceRowid: rowid as number, sequence });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        sequence -= 1;
        outcomes.push({
          kind: "quarantine",
          sourceRowid: rowid as number,
          quarantineId: quarantineRow(database, {
            table: PUBLICATION_TABLE,
            rowid: rowid as number,
            reason: "invalid-publication-row",
          }),
        });
      }
    }
    reconcileSourceOutcomes(database, {
      sourceTable: PUBLICATION_TABLE,
      targetTable: MIGRATION_TARGET,
      outcomes,
    });
    if (options.injectMigrationFailure === "after-copy") throw new SlidePlanMigrationError("injected migration failure after-copy");
    database.run(`DROP TABLE ${PUBLICATION_TABLE}`);
    database.run(`ALTER TABLE ${MIGRATION_TARGET} RENAME TO ${PUBLICATION_TABLE}`);
    createIndexes(database);
  })();
}
