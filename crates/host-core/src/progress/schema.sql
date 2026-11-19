CREATE TABLE IF NOT EXISTS session_progress_reports (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  trigger           TEXT NOT NULL CHECK (trigger IN ('manual','auto','turnEnd')),
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ok','unparsed')),
  body_json         TEXT,
  raw_text          TEXT,
  fingerprint       TEXT NOT NULL,
  last_message_id   TEXT,
  message_count     INTEGER NOT NULL,
  included_messages INTEGER NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  duration_ms       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_progress_reports_session
  ON session_progress_reports(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_progress_settings (
  session_id           TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  model_json           TEXT NOT NULL,
  auto_enabled         INTEGER NOT NULL DEFAULT 0,
  interval_minutes     INTEGER NOT NULL DEFAULT 5,
  last_collected_at    INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);
