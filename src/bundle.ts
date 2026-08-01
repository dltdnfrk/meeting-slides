import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { buildDeckHtml, buildSlideFiles, type DeckInput } from "./deck.ts";
import { buildMinutesHtml, type MinutesInput, type MinutesSourceSegment } from "./minutes.ts";
import type { MinutesStore } from "./minutes-store.ts";
import { renderMinutesPdf } from "./pdf.ts";

interface ManifestEntry { path: string; sha256: string; byte_size: number; byte_length: number; content_type: string; version: { transcript_version_id: string; version_no: number } }
export interface BundleManifest { schema_version: 1; bundle_id: string; meeting_id: number; review_id: string; target_commit: string; created_at: string; entries: ManifestEntry[]; artifacts: ManifestEntry[] }
export interface ExportBundleOptions { store: MinutesStore; outputRoot?: string; projectRoot?: string; renderPdf?: typeof renderMinutesPdf; targetCommit: string }
export interface ExportBundleResult { bundleId: string; bundlePath: string; manifest: BundleManifest; deduplicated: boolean }

type Row = Record<string, unknown>;
const enc = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const source = (row: Row): MinutesSourceSegment => ({ transcript_version_id: row.source_transcript_version_id as string, start_seq: row.source_start_seq as number, end_seq: row.source_end_seq as number });

function safeRelative(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`[UNSAFE_BUNDLE_PATH] ${path}`);
}
function contentType(path: string): string {
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".jsonl")) return "application/x-ndjson";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function validateBundle(path: string, bundleId: string, targetCommit: string): Promise<BundleManifest> {
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as BundleManifest;
  if (manifest.bundle_id !== bundleId || manifest.target_commit !== targetCommit || !Array.isArray(manifest.entries) || !Array.isArray(manifest.artifacts)) throw new Error("[BUNDLE_IDENTITY_MISMATCH] bundle identity or manifest shape differs");
  const required = ["minutes.pdf", "minutes.json", "audio.ref.json", "deck/index.html"];
  const transcript = manifest.entries.filter((entry) => /^transcript\.v\d+\.jsonl$/.test(entry.path));
  if (transcript.length !== 1) throw new Error("[BUNDLE_INCOMPLETE] canonical transcript is missing or ambiguous");
  for (const requiredPath of required) if (!manifest.entries.some((entry) => entry.path === requiredPath)) throw new Error(`[BUNDLE_INCOMPLETE] missing ${requiredPath}`);
  if (JSON.stringify(manifest.entries) !== JSON.stringify(manifest.artifacts)) throw new Error("[BUNDLE_MANIFEST_MISMATCH] artifact indexes differ");
  for (const entry of manifest.entries) {
    safeRelative(entry.path);
    const bytes = await readFile(join(path, entry.path));
    if (bytes.byteLength !== entry.byte_size || entry.byte_length !== entry.byte_size || hash(bytes) !== entry.sha256) throw new Error(`[BUNDLE_HASH_MISMATCH] ${entry.path}`);
  }
  if (!(await readFile(join(path, "minutes.pdf"))).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("[INVALID_MINUTES_PDF] PDF signature missing");
  return manifest;
}

function loadSnapshot(store: MinutesStore, meetingId: number, reviewId: string) {
  const db = store.databaseHandle();
  const review = db.query("SELECT * FROM meeting_reviews WHERE review_id = ?").get(reviewId) as Row | null;
  if (!review || review.meeting_id !== meetingId) throw new Error("[REVIEW_MEETING_MISMATCH] review does not belong to meeting");
  if (review.status !== "confirmed") throw new Error("[REVIEW_NOT_CONFIRMED] bundle export requires a confirmed review");
  const version = store.canonicalVersion(meetingId);
  if (!version || version.transcriptVersionId !== review.transcript_version_id) throw new Error("[STALE_TRANSCRIPT_VERSION] confirmed review is not for the canonical transcript");
  if (!version.finalizedAt || !version.contentSha256) throw new Error("[TRANSCRIPT_INTEGRITY_FAILED] canonical transcript is not finalized");
  const meeting = db.query("SELECT id, started_at, ended_at, provider FROM meetings WHERE id = ?").get(meetingId) as Row | null;
  const meta = store.meetingMeta(meetingId);
  if (!meeting || !meta) throw new Error("[MEETING_NOT_FOUND] meeting metadata is missing");
  const attendees = store.attendeesFor(meetingId), lines = store.transcriptVersionLines(version.transcriptVersionId);
  const storedBytes = enc.encode(lines.map((line) => JSON.stringify({ seq: line.seq, captured_at_ms: line.capturedAtMs, audio_start_ms: line.audioStartMs, audio_end_ms: line.audioEndMs, speaker_turn: line.speakerTurn, text: line.text })).join("\n") + (lines.length ? "\n" : ""));
  if (hash(storedBytes) !== version.contentSha256) throw new Error("[TRANSCRIPT_INTEGRITY_FAILED] canonical transcript rows do not match their finalized hash");
  const transcriptBytes = enc.encode(lines.map((line) => JSON.stringify({ seq: line.seq, ts: line.capturedAtMs, speaker_turn: line.speakerTurn, text: line.text })).join("\n") + (lines.length ? "\n" : ""));
  const select = (table: string, id: string) => db.query(`SELECT *, ${id} AS item_id FROM ${table} WHERE review_id = ? AND review_state = 'confirmed' ORDER BY created_at, ${id}`).all(reviewId) as Row[];
  const decisions = select("decisions", "decision_id"), actions = select("action_items", "action_item_id"), open = select("open_items", "open_item_id"), materials = select("referenced_materials", "material_id");
  const seqs = new Set(lines.map((line) => line.seq));
  for (const row of [...decisions, ...actions, ...open, ...materials.filter((item) => item.source_transcript_version_id)]) {
    if (row.source_transcript_version_id !== version.transcriptVersionId) throw new Error("[STALE_ITEM_PROVENANCE] item source version differs from bundle version");
    for (let seq = row.source_start_seq as number; seq <= (row.source_end_seq as number); seq++) if (!seqs.has(seq)) throw new Error("[INVALID_ITEM_PROVENANCE] source segment is absent from canonical transcript");
  }
  return { db, review, version, meeting, meta, attendees, lines, transcriptBytes, decisions, actions, open, materials };
}

function minutesInput(s: ReturnType<typeof loadSnapshot>): MinutesInput {
  const attendee = (id: unknown) => id as string | null;
  return { meta: { title: "Meeting Notes", meetingDate: new Date(s.meeting.started_at as number).toISOString(), timeZone: "UTC", purpose: s.meta.purpose, provider: s.meeting.provider as string | null }, attendees: s.attendees.map((a) => ({ attendeeId: a.attendeeId, displayName: a.displayName })), decisions: s.decisions.map((r) => ({ description: r.description as string, attributedAttendeeId: attendee(r.attributed_attendee_id), sourceSegment: source(r) })), actions: s.actions.map((r) => ({ description: r.description as string, assigneeAttendeeId: attendee(r.assignee_attendee_id), attributedAttendeeId: attendee(r.attributed_attendee_id), deadline: r.deadline as string | null, deadlineText: r.deadline_text as string | null, sourceSegment: source(r) })), open: s.open.map((r) => ({ description: r.description as string, attributedAttendeeId: attendee(r.attributed_attendee_id), sourceSegment: source(r) })), referencedMaterials: s.materials.map((r) => ({ materialType: r.material_type as "document" | "figure" | "link" | "data" | "other", title: r.title as string | null, uri: r.uri as string | null, notes: r.notes as string | null, sourceSegment: r.source_transcript_version_id ? source(r) : null })), transcript: s.lines.map((line) => ({ seq: line.seq, capturedAtMs: line.capturedAtMs, speakerTurn: line.speakerTurn, text: line.text })), transcriptVersionId: s.version.transcriptVersionId };
}

function minutesJson(s: ReturnType<typeof loadSnapshot>, transcriptPath: string) {
  const mapItem = (row: Row, id: string) => ({ [id]: row.item_id, description: row.description, attributed_attendee_id: row.attributed_attendee_id, origin: row.origin, source: source(row), source_segment: source(row) });
  return { schema_version: 1, meeting: { meeting_id: s.meeting.id, started_at: s.meeting.started_at, ended_at: s.meeting.ended_at, provider: s.meeting.provider, purpose: s.meta.purpose }, review: { review_id: s.review.review_id, confirmed_at: s.review.confirmed_at, confirmed_by: s.review.confirmed_by }, transcript: { version_id: s.version.transcriptVersionId, version_no: s.version.versionNo, source_kind: s.version.sourceKind, engine: s.version.engine, engine_model: s.version.engineModel, finalized_at: s.version.finalizedAt, content_sha256: hash(s.transcriptBytes), relative_path: transcriptPath }, attendees: s.attendees.map((a) => ({ attendee_id: a.attendeeId, display_name: a.displayName, crm_person_entity_id: a.crmPersonEntityId })), decisions: s.decisions.map((r) => mapItem(r, "decision_id")), action_items: s.actions.map((r) => ({ ...mapItem(r, "action_item_id"), assignee_attendee_id: r.assignee_attendee_id, deadline: r.deadline, deadline_text: r.deadline_text })), open_items: s.open.map((r) => mapItem(r, "open_item_id")), referenced_materials: s.materials.map((r) => ({ material_id: r.item_id, material_type: r.material_type, title: r.title, uri: r.uri, notes: r.notes, source: r.source_transcript_version_id ? source(r) : null, source_segment: r.source_transcript_version_id ? source(r) : null })) };
}

function recordComplete(s: ReturnType<typeof loadSnapshot>, bundleId: string, bundlePath: string, entries: ManifestEntry[]) {
  const now = s.review.confirmed_at as number;
  s.db.transaction(() => {
    s.db.run("INSERT OR IGNORE INTO artifact_bundles VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)", [bundleId, s.meeting.id as number, s.review.review_id as string, s.version.transcriptVersionId, bundlePath, now, now]);
    const specs: Array<[string, string]> = [["minutes_pdf", "minutes.pdf"], ["minutes_json", "minutes.json"], ["canonical_transcript", `transcript.v${s.version.versionNo}.jsonl`], ["slide_deck", "deck/index.html"]];
    for (const [type, path] of specs) { const entry = entries.find((candidate) => candidate.path === path); if (!entry) throw new Error(`[BUNDLE_INCOMPLETE] missing database artifact ${path}`); s.db.run("INSERT OR IGNORE INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [`${bundleId}:${type}`, bundleId, type, path, entry.content_type, entry.sha256, entry.byte_size, now]); }
  })();
}

export async function exportBundle(meetingId: number, reviewId: string, options: ExportBundleOptions): Promise<ExportBundleResult> {
  if (!Number.isSafeInteger(meetingId) || meetingId < 1) throw new TypeError("meetingId must be a positive integer");
  if (!reviewId.trim()) throw new TypeError("reviewId must not be blank");
  const targetCommit = options.targetCommit.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(targetCommit)) throw new Error("targetCommit must be a 40-character git commit");
  const s = loadSnapshot(options.store, meetingId, reviewId), identity = hash(enc.encode(`${meetingId}\0${reviewId}\0${s.version.transcriptVersionId}`)), bundleId = `bundle-${identity}`;
  const outputRoot = options.outputRoot ?? join(process.cwd(), "exports"), stamp = new Date(s.review.confirmed_at as number).toISOString().replace(/[:.]/g, "-"), target = join(outputRoot, `bundle-${meetingId}-${stamp}`);
  try { const manifest = await validateBundle(target, bundleId, targetCommit); recordComplete(s, bundleId, target, manifest.entries); return { bundleId, bundlePath: target, manifest, deduplicated: true }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(outputRoot, `.bundle-${meetingId}-${stamp}-${randomUUID()}.tmp`); let published = false;
  await mkdir(temporary, { recursive: true });
  try {
    const entries: ManifestEntry[] = [], version = { transcript_version_id: s.version.transcriptVersionId, version_no: s.version.versionNo };
    const put = async (path: string, data: string | Uint8Array) => { safeRelative(path); const bytes = typeof data === "string" ? enc.encode(data) : data; await mkdir(join(temporary, ...path.split("/").slice(0, -1)), { recursive: true }); await writeFile(join(temporary, path), bytes); entries.push({ path, sha256: hash(bytes), byte_size: bytes.byteLength, byte_length: bytes.byteLength, content_type: contentType(path), version }); };
    const transcriptPath = `transcript.v${s.version.versionNo}.jsonl`, html = buildMinutesHtml(minutesInput(s));
    await put("minutes.pdf", await (options.renderPdf ?? renderMinutesPdf)(html)); await put("minutes.json", json(minutesJson(s, transcriptPath))); await put(transcriptPath, s.transcriptBytes);
    const audio = s.db.query("SELECT * FROM meeting_audio_sources WHERE meeting_id = ?").get(meetingId) as Row | null;
    if (audio?.original_audio_path) { const path = audio.original_audio_path as string; let bytes: Buffer; try { if (!(await stat(path)).isFile()) throw new Error(); bytes = await readFile(path); } catch { throw new Error("[ORIGINAL_AUDIO_MISSING] recorded source is unavailable"); } if (hash(bytes) !== audio.original_audio_sha256 || bytes.byteLength !== audio.byte_length) throw new Error("[ORIGINAL_AUDIO_INTEGRITY_FAILED] recorded source bytes changed"); }
    await put("audio.ref.json", json({ path: audio?.original_audio_path ?? null, original_audio_sha256: audio?.original_audio_sha256 ?? null }));
    const slides = s.db.query("SELECT x.idx, x.title, x.bullets, x.started_at FROM slides x JOIN (SELECT idx, MAX(id) id FROM slides WHERE meeting_id = ? GROUP BY idx) y ON x.id=y.id ORDER BY x.idx").all(meetingId) as Array<{ idx: number; title: string; bullets: string; started_at: number }>;
    const deck: DeckInput = { title: "Meeting Notes", startedAt: s.meeting.started_at as number, provider: s.meeting.provider as string | null, slides: slides.map((slide) => ({ idx: slide.idx, title: slide.title, bullets: JSON.parse(slide.bullets), startedAt: slide.started_at })), lines: s.lines.map((line) => ({ seq: line.seq, ts: line.capturedAtMs ?? 0, speaker: line.speakerTurn, text: line.text })) };
    const root = options.projectRoot ?? process.cwd(); await put("deck/index.html", buildDeckHtml(deck)); await put("deck/theme.css", await readFile(join(root, "deck", "theme.css"))); for (const file of buildSlideFiles(deck)) await put(`deck/slides/${file.filename}`, file.html); await put("deck/slides/theme.css", await readFile(join(root, "deck", "theme.css"))); for (const name of ["meeting-cover.png", "meeting-topic-map.png"]) { const bytes = await readFile(join(root, "deck", "assets", name)); await put(`deck/assets/${name}`, bytes); await put(`deck/slides/assets/${name}`, bytes); }
    entries.sort((a, b) => a.path.localeCompare(b.path)); const manifest: BundleManifest = { schema_version: 1, bundle_id: bundleId, meeting_id: meetingId, review_id: reviewId, target_commit: targetCommit, created_at: new Date(s.review.confirmed_at as number).toISOString(), entries, artifacts: entries }; await writeFile(join(temporary, "manifest.json"), json(manifest)); await validateBundle(temporary, bundleId, targetCommit);
    await rename(temporary, target); published = true; recordComplete(s, bundleId, target, entries); return { bundleId, bundlePath: target, manifest, deduplicated: false };
  } catch (error) { if (published) await rm(target, { recursive: true, force: true }); throw error; } finally { await rm(temporary, { recursive: true, force: true }); }
}
