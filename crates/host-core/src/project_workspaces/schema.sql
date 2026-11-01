-- Project workspaces: named linked git worktrees that live inside the project
-- at `.pi/worktree/<name>` and own their own sessions (schema v28).
--
-- Distinct from `worktrees` (ADR 0329), whose rows are per-session, machine
-- named, and stored under the data directory. A project workspace is never an
-- orphan of that table's cleanup pass.
CREATE TABLE IF NOT EXISTS project_workspaces (
  id             TEXT PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- User-typed name; also the directory name under `.pi/worktree/`.
  name           TEXT NOT NULL,
  -- Absolute workspace root (`<project>/.pi/worktree/<name>`). Lives inside
  -- the project, so a data-directory relocation never rewrites it.
  path           TEXT NOT NULL UNIQUE,
  common_dir     TEXT NOT NULL,
  -- Project directory relative to the repository top level, '' at top level.
  prefix         TEXT NOT NULL DEFAULT '',
  branch         TEXT NOT NULL,
  source_remote  TEXT NOT NULL,
  source_branch  TEXT NOT NULL,
  source_commit  TEXT NOT NULL,
  -- Delete the branch on removal only when this workspace created it.
  created_branch INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('creating','active','missing')),
  setup_status   TEXT CHECK (setup_status IS NULL
                        OR setup_status IN ('none','running','ok','failed')),
  setup_log      TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_workspaces_name
  ON project_workspaces(project_id, name);
