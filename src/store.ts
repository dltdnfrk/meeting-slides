// ============================================================
// store.ts - 회의 영속 저장소 (bun:sqlite)
// ============================================================
// anarlog(fastrepl)의 핵심 아키텍처 차용: 전사·슬라이드를 메모리가 아니라
// 로컬 SQLite에 canonical 데이터로 저장해, 저장/보내기가 브라우저 상태와
// 무관하게 항상 동작하게 한다. DB 파일은 프로젝트 루트 meetings.db.

import { Database } from "bun:sqlite";

import { parseDeckOutline, parseSlideSpec, type DeckOutline } from "./slide-spec.js";

export interface StoredLine {
  seq: number;
  ts: number;
  speaker: number | null;
  text: string;
}

export interface StoredSlide {
  idx: number;
  title: string;
  bullets: string[];
  startedAt: number;
}

export interface StoredDeckOutline {
  outline: DeckOutline;
  plannerError: string | null;
  compiledAt: number;
  publishedAt: number | null;
}

export class MeetingStore {
  private db: Database;
  private meetingId: number | null = null;
  private lineSeq = 0;
  private addSlideTx!: (slide: { idx: number; title: string; bullets: string[]; startedAt: number }) => void;

  constructor(path = "meetings.db") {
    this.db = new Database(path);
    // WAL: 동시 읽기(export/lines) 중 쓰기(addLine)가 블로킹되지 않음. 동기화 비용 ↓.
    this.db.run("PRAGMA journal_mode = WAL");
    // 락 경합 시 즉시 실패 대신 최대 5초 대기 (WS 핸들러 + whisper 콜백 동시 쓰기).
    this.db.run("PRAGMA busy_timeout = 5000");
    // WAL 모드에서 NORMAL은 crash-safe하면서 FULL보다 fsync 횟수가 적어 빠름.
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        provider TEXT
      );
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        speaker INTEGER,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        title TEXT NOT NULL,
        bullets TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deck_outlines (
        meeting_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        style TEXT NOT NULL,
        source_json TEXT,
        planner_error TEXT,
        compiled_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deck_slide_specs (
        meeting_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        PRIMARY KEY (meeting_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_lines_meeting ON transcript_lines(meeting_id, seq);
      CREATE INDEX IF NOT EXISTS idx_slides_meeting ON slides(meeting_id, idx);
      CREATE INDEX IF NOT EXISTS idx_deck_specs_meeting ON deck_slide_specs(meeting_id, idx);
    `);
    const outlineColumns = this.db.query("PRAGMA table_info(deck_outlines)").all() as { name: string }[];
    if (!outlineColumns.some(({ name }) => name === "published_at")) {
      this.db.run("ALTER TABLE deck_outlines ADD COLUMN published_at INTEGER");
    }

    // (meeting_id, idx) 단위 upsert: 같은 토픽 슬라이드 갱신이 INSERT 중복으로 쌓이지 않게.
    // 기존 DB에 중복 행이 있어도 UPDATE는 전부 갱신하고, 없을 때만 INSERT.
    this.addSlideTx = this.db.transaction((slide: { idx: number; title: string; bullets: string[]; startedAt: number }): void => {
      if (this.meetingId === null) return;
      const bulletsJson = JSON.stringify(slide.bullets);
      const updated = this.db.run(
        "UPDATE slides SET title = ?, bullets = ?, started_at = ? WHERE meeting_id = ? AND idx = ?",
        [slide.title, bulletsJson, slide.startedAt, this.meetingId, slide.idx],
      );
      if (Number(updated.changes) > 0) return;
      this.db.run(
        "INSERT INTO slides (meeting_id, idx, title, bullets, started_at) VALUES (?, ?, ?, ?, ?)",
        [this.meetingId, slide.idx, slide.title, bulletsJson, slide.startedAt],
      );
    });
  }

  /** 캡처 시작 = 새 회의 */
  startMeeting(provider: string): number {
    const res = this.db.run("INSERT INTO meetings (started_at, provider) VALUES (?, ?)", [Date.now(), provider]);
    this.meetingId = Number(res.lastInsertRowid);
    this.lineSeq = 0;
    return this.meetingId;
  }

  endMeeting(): void {
    if (this.meetingId === null) return;
    this.db.run("UPDATE meetings SET ended_at = ? WHERE id = ?", [Date.now(), this.meetingId]);
  }

  /** 회의가 열려 있지 않으면 무시 (파일 모드/수동 라인 대비) */
  addLine(line: { ts: number; speaker?: number; text: string }): void {
    if (this.meetingId === null) return;
    this.lineSeq += 1;
    this.db.run("INSERT INTO transcript_lines (meeting_id, seq, ts, speaker, text) VALUES (?, ?, ?, ?, ?)", [
      this.meetingId,
      this.lineSeq,
      line.ts,
      line.speaker ?? null,
      line.text,
    ]);
  }

  /** 한 슬라이드를 원자적으로 upsert (meeting_id + idx 기준). 신규·같은 토픽 갱신 모두 이 경로. */
  addSlide(slide: { idx: number; title: string; bullets: string[]; startedAt: number }): void {
    this.addSlideTx(slide);
  }

  /** addSlide와 동일. 호출부 가독성용 별칭. */
  upsertSlide(slide: { idx: number; title: string; bullets: string[]; startedAt: number }): void {
    this.addSlideTx(slide);
  }

  lines(meetingId?: number): StoredLine[] {
    const id = meetingId ?? this.meetingId;
    if (id === null) return [];
    return this.db
      .query("SELECT seq, ts, speaker, text FROM transcript_lines WHERE meeting_id = ? ORDER BY seq")
      .all(id) as StoredLine[];
  }

  slides(meetingId?: number): StoredSlide[] {
    const id = meetingId ?? this.meetingId;
    if (id === null) return [];
    // 과거 INSERT-only 경로로 같은 idx가 여러 번 쌓였을 수 있어,
    // idx별 최신 row(id MAX)만 노출한다. upsert 이후에는 보통 1행.
    const rows = this.db
      .query(`
        SELECT s.idx, s.title, s.bullets, s.started_at as startedAt
        FROM slides s
        INNER JOIN (
          SELECT meeting_id, idx, MAX(id) AS max_id
          FROM slides
          WHERE meeting_id = ?
          GROUP BY meeting_id, idx
        ) latest ON s.id = latest.max_id
        ORDER BY s.idx
      `)
      .all(id) as { idx: number; title: string; bullets: string; startedAt: number }[];
    return rows.map((r) => ({ ...r, bullets: JSON.parse(r.bullets) as string[] }));
  }

  /** 검증된 outline 메타데이터와 canonical SlideSpec들을 한 트랜잭션으로 교체한다. */
  saveDeckOutline(outlineValue: unknown, plannerError: string | null = null): StoredDeckOutline {
    const outline = parseDeckOutline(outlineValue);
    const compiledAt = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO deck_outlines (meeting_id, title, style, source_json, planner_error, compiled_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           title = excluded.title,
           style = excluded.style,
           source_json = excluded.source_json,
           planner_error = excluded.planner_error,
           compiled_at = excluded.compiled_at,
           published_at = NULL`,
        [
          outline.meetingId,
          outline.title,
          outline.style,
          outline.source === undefined ? null : JSON.stringify(outline.source),
          plannerError,
          compiledAt,
        ],
      );
      this.db.run("DELETE FROM deck_slide_specs WHERE meeting_id = ?", [outline.meetingId]);
      for (const [idx, spec] of outline.slides.entries()) {
        this.db.run(
          "INSERT INTO deck_slide_specs (meeting_id, idx, spec_json) VALUES (?, ?, ?)",
          [outline.meetingId, idx, JSON.stringify(parseSlideSpec(spec))],
        );
      }
    })();
    return { outline, plannerError, compiledAt, publishedAt: null };
  }

  /** Filesystem publish가 끝난 outline만 export 우선 대상으로 표시한다. */
  markDeckPublished(meetingId: number, publishedAt = Date.now()): void {
    const result = this.db.run(
      "UPDATE deck_outlines SET published_at = ? WHERE meeting_id = ?",
      [publishedAt, meetingId],
    );
    if (Number(result.changes) !== 1) throw new Error(`No compiled outline for meeting ${meetingId}`);
  }

  /** HTML이 아닌 persisted SlideSpec들로 outline을 재구성하고 다시 검증한다. */
  deckOutline(meetingId?: number): StoredDeckOutline | null {
    const id = meetingId ?? this.meetingId;
    if (id === null) return null;
    const row = this.db.query(
      `SELECT title, style, source_json as sourceJson,
              planner_error as plannerError, compiled_at as compiledAt,
              published_at as publishedAt
       FROM deck_outlines WHERE meeting_id = ?`,
    ).get(id) as {
      title: string;
      style: string;
      sourceJson: string | null;
      plannerError: string | null;
      compiledAt: number;
      publishedAt: number | null;
    } | null;
    if (row === null) return null;
    const specs = this.db.query(
      "SELECT spec_json as specJson FROM deck_slide_specs WHERE meeting_id = ? ORDER BY idx",
    ).all(id) as { specJson: string }[];
    const outline = parseDeckOutline({
      meetingId: id,
      title: row.title,
      style: row.style,
      slides: specs.map(({ specJson }) => parseSlideSpec(specJson)),
      ...(row.sourceJson === null ? {} : { source: JSON.parse(row.sourceJson) as unknown }),
    });
    return {
      outline,
      plannerError: row.plannerError,
      compiledAt: row.compiledAt,
      publishedAt: row.publishedAt,
    };
  }

  /** anarlog식 Markdown export: 헤더 + 슬라이드 요약 + 전체 전사본 */
  exportMarkdown(meetingId?: number): string {
    const id = meetingId ?? this.meetingId ?? undefined;
    const lines = this.lines(id);
    const slides = this.slides(id);
    const meta = id === undefined
      ? null
      : (this.db.query("SELECT started_at, ended_at, provider FROM meetings WHERE id = ?").get(id) as
          { started_at: number; ended_at: number | null; provider: string | null } | null);

    const fmt = (ts: number) => new Date(ts).toLocaleString("ko-KR", { hour12: false });
    const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });

    const out = ["# Meeting Notes", ""];
    if (meta) {
      out.push(`- 시작: ${fmt(meta.started_at)}`);
      if (meta.ended_at) out.push(`- 종료: ${fmt(meta.ended_at)}`);
      if (meta.provider) out.push(`- LLM: ${meta.provider}`);
      out.push("");
    }
    if (slides.length > 0) {
      out.push("## 슬라이드 요약", "");
      for (const s of slides) {
        out.push(`### ${String(s.idx).padStart(2, "0")}. ${s.title}`, "");
        for (const b of s.bullets) out.push(`- ${b}`);
        out.push("");
      }
    }
    out.push("## 전사본", "");
    for (const l of lines) {
      const who = l.speaker ? `화자 ${l.speaker}` : "전사";
      out.push(`**[${fmtTime(l.ts)}] ${who}** — ${l.text}`);
    }
    out.push("");
    return out.join("\n");
  }

  meeting(meetingId: number): { id: number; started_at: number; ended_at: number | null; provider: string | null } | null {
    return (this.db
      .query("SELECT id, started_at, ended_at, provider FROM meetings WHERE id = ?")
      .get(meetingId) as { id: number; started_at: number; ended_at: number | null; provider: string | null } | null) ?? null;
  }

  /** 가장 최근 회의 (서버 재시작 후에도 이전 회의 export 가능 — anarlog 방식) */
  latestMeeting(): { id: number; started_at: number; ended_at: number | null; provider: string | null } | null {
    return (this.db
      .query("SELECT id, started_at, ended_at, provider FROM meetings ORDER BY id DESC LIMIT 1")
      .get() as { id: number; started_at: number; ended_at: number | null; provider: string | null } | null) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
