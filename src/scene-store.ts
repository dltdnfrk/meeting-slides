import type { Database } from "bun:sqlite";

import { parseNarrativeDeck, type NarrativeDeck, type SceneDeck } from "./scene-graph.js";

export interface ScenePublication {
  readonly meetingId: number;
  readonly narrative: NarrativeDeck;
  readonly scene: SceneDeck;
  readonly directory: string;
  readonly pptxPath: string;
  readonly publishedAt: number;
}

interface PublicationRow {
  meeting_id: number;
  narrative_json: string;
  scene_json: string;
  directory: string;
  pptx_path: string;
  published_at: number;
}

function ensureTable(database: Database): void {
  database.run(`CREATE TABLE IF NOT EXISTS scene_publications (
    meeting_id INTEGER PRIMARY KEY,
    narrative_json TEXT NOT NULL,
    scene_json TEXT NOT NULL,
    directory TEXT NOT NULL,
    pptx_path TEXT NOT NULL,
    published_at INTEGER NOT NULL
  )`);
}

export function saveScenePublication(database: Database, publication: ScenePublication): void {
  ensureTable(database);
  database.run(
    `INSERT INTO scene_publications
      (meeting_id, narrative_json, scene_json, directory, pptx_path, published_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET
      narrative_json=excluded.narrative_json,
      scene_json=excluded.scene_json,
      directory=excluded.directory,
      pptx_path=excluded.pptx_path,
      published_at=excluded.published_at`,
    [
      publication.meetingId,
      JSON.stringify(publication.narrative),
      JSON.stringify(publication.scene),
      publication.directory,
      publication.pptxPath,
      publication.publishedAt,
    ],
  );
}

export function scenePublication(database: Database, meetingId: number): ScenePublication | null {
  ensureTable(database);
  const row = database.query<PublicationRow, [number]>(
    `SELECT meeting_id, narrative_json, scene_json, directory, pptx_path, published_at
     FROM scene_publications WHERE meeting_id = ?`,
  ).get(meetingId);
  if (!row) return null;
  return {
    meetingId: row.meeting_id,
    narrative: parseNarrativeDeck(JSON.parse(row.narrative_json)),
    scene: JSON.parse(row.scene_json) as SceneDeck,
    directory: row.directory,
    pptxPath: row.pptx_path,
    publishedAt: row.published_at,
  };
}
