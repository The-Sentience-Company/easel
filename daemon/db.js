// SQLite layer: surfaces, rounds, feedback (incl. drafts), cursors, chat.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const DATA_DIR = process.env.EASEL_DATA_DIR || join(homedir(), '.easel')
export const DB_PATH = join(DATA_DIR, 'easel.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS surfaces (
  key         TEXT PRIMARY KEY,
  title       TEXT,
  file        TEXT,
  template    TEXT,
  data_file   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | ended | archived
  wip_html    TEXT,
  wip_updated_at TEXT,
  wip_diagrams_json TEXT,
  audit_json  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  surface_key  TEXT NOT NULL REFERENCES surfaces(key),
  seq          INTEGER NOT NULL,
  html         TEXT NOT NULL,        -- data-sid annotated body html
  note         TEXT,
  diff_json    TEXT,                 -- {added,removed,modified,moved} vs seq-1; null for seq 1
  audit_json   TEXT,
  diagrams_json TEXT,                -- [{index,source,hash}] seeding the whiteboard
  published_at TEXT NOT NULL,
  PRIMARY KEY (surface_key, seq)
);

-- Scene outlives the round it was drawn against: source_hash records which
-- diagram version that was, so a later publish marks it stale, never deletes it.
CREATE TABLE IF NOT EXISTS whiteboards (
  surface_key   TEXT NOT NULL REFERENCES surfaces(key),
  diagram_index INTEGER NOT NULL,
  source_hash   TEXT,
  scene_json    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,   -- a write names the version it edited
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (surface_key, diagram_index)
);

CREATE TABLE IF NOT EXISTS feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,   -- cursor/since compare on this
  surface_key  TEXT NOT NULL REFERENCES surfaces(key),
  round_seq    INTEGER,
  kind         TEXT NOT NULL,        -- annotation | widget | chat
  state        TEXT NOT NULL,        -- draft | submitted
  client_id    TEXT,                 -- scopes drafts to a browser client
  sid          TEXT,
  quote        TEXT,
  prefix       TEXT,
  suffix       TEXT,
  excerpt      TEXT,
  comment      TEXT,
  widget_id    TEXT,
  widget_value TEXT,
  text         TEXT,                 -- chat-kind payload
  payload_json TEXT,                 -- whiteboard-kind: {diagramIndex,scenePath,svgPath,...}
  context_json TEXT,                 -- anchor section context: {heading,card,nth,of}
  created_at   TEXT NOT NULL,
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS feedback_surface ON feedback(surface_key, state, id);

CREATE TABLE IF NOT EXISTS cursors (
  surface_key TEXT NOT NULL REFERENCES surfaces(key),
  agent_id    TEXT NOT NULL,
  acked_upto  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (surface_key, agent_id)
);

CREATE TABLE IF NOT EXISTS chat (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  surface_key TEXT NOT NULL REFERENCES surfaces(key),
  role        TEXT NOT NULL,         -- user | agent
  agent_id    TEXT,                  -- callsign on agent messages; null for user
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_surface ON chat(surface_key, id);
`

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

// CREATE TABLE IF NOT EXISTS is a no-op on a database that already has the
// table, so additive columns need an explicit backfill for resident installs.
function migrate(db) {
  const has = (table, column) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  if (!has('chat', 'agent_id')) db.exec(`ALTER TABLE chat ADD COLUMN agent_id TEXT`)
  // Rounds published before this column existed carry no sources; the whiteboard
  // opens blank with a reason rather than seeding from a since-changed file.
  if (!has('rounds', 'diagrams_json')) db.exec(`ALTER TABLE rounds ADD COLUMN diagrams_json TEXT`)
  // WIP shows unpublished diagrams; without its own sources the whiteboard would
  // seed them from the last round, which is the wrong diagram.
  if (!has('surfaces', 'wip_diagrams_json')) db.exec(`ALTER TABLE surfaces ADD COLUMN wip_diagrams_json TEXT`)
  if (!has('feedback', 'payload_json')) db.exec(`ALTER TABLE feedback ADD COLUMN payload_json TEXT`)
  // Items stored before anchor context existed simply carry none.
  if (!has('feedback', 'context_json')) db.exec(`ALTER TABLE feedback ADD COLUMN context_json TEXT`)
  // Scenes stored before versioning start at 0, which is what a first-open reads.
  if (!has('whiteboards', 'version')) {
    db.exec(`ALTER TABLE whiteboards ADD COLUMN version INTEGER NOT NULL DEFAULT 0`)
  }
  // Freeform sections rendered in a sandboxed frame; verbatim html per round.
  if (!has('rounds', 'islands_json')) db.exec(`ALTER TABLE rounds ADD COLUMN islands_json TEXT`)
  if (!has('surfaces', 'wip_islands_json')) db.exec(`ALTER TABLE surfaces ADD COLUMN wip_islands_json TEXT`)
  // The last round a reader had on screen; auto-open opens what has not been seen.
  if (!has('surfaces', 'viewed_round')) db.exec(`ALTER TABLE surfaces ADD COLUMN viewed_round INTEGER`)
}

export const now = () => new Date().toISOString()
