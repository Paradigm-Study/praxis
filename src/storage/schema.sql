-- Praxis local event database (SQLite).
-- Pragmas (WAL etc.) are applied in db.ts; this file is pure DDL so it can also
-- run against an in-memory database during tests.

-- Layer 1/2 — the raw event ledger. This is the source of truth.
CREATE TABLE IF NOT EXISTS raw_events (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  source       TEXT NOT NULL,
  app          TEXT NOT NULL,
  window       TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  blob_refs    TEXT NOT NULL DEFAULT '[]',
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_events_ts ON raw_events(ts);
CREATE INDEX IF NOT EXISTS idx_raw_events_source ON raw_events(source);
CREATE INDEX IF NOT EXISTS idx_raw_events_app ON raw_events(app);
CREATE INDEX IF NOT EXISTS idx_raw_events_hash ON raw_events(hash);

-- Content-addressed blob index (bytes live on disk under the blob dir).
CREATE TABLE IF NOT EXISTS blobs (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Layer 3 — reconstructed user actions (interpretations, with evidence).
CREATE TABLE IF NOT EXISTS action_events (
  id               TEXT PRIMARY KEY,
  start_ts         TEXT NOT NULL,
  end_ts           TEXT NOT NULL,
  action_type      TEXT NOT NULL,
  app              TEXT NOT NULL,
  window           TEXT,
  text             TEXT,
  confidence       REAL NOT NULL,
  evidence_ids     TEXT NOT NULL DEFAULT '[]',
  uncertainty      TEXT,
  payload_json     TEXT,
  reconstructed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_events_start ON action_events(start_ts);
CREATE INDEX IF NOT EXISTS idx_action_events_type ON action_events(action_type);

-- Layer 4 — fused context episodes.
CREATE TABLE IF NOT EXISTS episodes (
  id                  TEXT PRIMARY KEY,
  start_ts            TEXT NOT NULL,
  end_ts              TEXT NOT NULL,
  summary             TEXT NOT NULL,
  goal                TEXT,
  evidence_action_ids TEXT NOT NULL DEFAULT '[]',
  artifacts           TEXT NOT NULL DEFAULT '[]',
  decision_points     TEXT NOT NULL DEFAULT '[]',
  rejected_paths      TEXT NOT NULL DEFAULT '[]',
  uncertainty         TEXT NOT NULL DEFAULT '[]',
  boundary_reason     TEXT,
  payload_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_start ON episodes(start_ts);

-- Layer 6 — claims extracted from episodes (the textual backbone of the graph).
CREATE TABLE IF NOT EXISTS claims (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  text                 TEXT NOT NULL,
  confidence           REAL NOT NULL,
  evidence_episode_ids TEXT NOT NULL DEFAULT '[]',
  created_ts           TEXT NOT NULL,
  updated_ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_kind ON claims(kind);

-- Layer 6 — expert memory graph.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  confidence REAL NOT NULL,
  claim_id   TEXT,
  data_json  TEXT,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);

CREATE TABLE IF NOT EXISTS graph_edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  data_json  TEXT,
  created_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);

-- Layer 5 — observer interpretations (model output, always evidence-linked).
CREATE TABLE IF NOT EXISTS observations (
  id                  TEXT PRIMARY KEY,
  bundle_id           TEXT NOT NULL,
  episode_id          TEXT,
  intent              TEXT,
  task                TEXT,
  decision_point      TEXT,
  accepted_options    TEXT NOT NULL DEFAULT '[]',
  rejected_options    TEXT NOT NULL DEFAULT '[]',
  inferred_preference TEXT,
  uncertainty         TEXT NOT NULL DEFAULT '[]',
  suggested_question  TEXT,
  options             TEXT NOT NULL DEFAULT '[]',
  evidence            TEXT NOT NULL DEFAULT '[]',
  model               TEXT NOT NULL,
  created_ts          TEXT NOT NULL
);

-- Layer 7 — persisted agent-loop decisions (so Studio can surface them live).
CREATE TABLE IF NOT EXISTS decisions (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  question       TEXT,
  evidence       TEXT NOT NULL DEFAULT '[]',
  observation_id TEXT,
  claim_id       TEXT,
  created_ts     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_ts);

-- Human-in-the-loop corrections on any interpretation.
CREATE TABLE IF NOT EXISTS corrections (
  id             TEXT PRIMARY KEY,
  target_kind    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  corrected_text TEXT,
  note           TEXT,
  created_ts     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_id);
