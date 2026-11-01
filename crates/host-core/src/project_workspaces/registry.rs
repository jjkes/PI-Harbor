//! Rows of the `project_workspaces` table (schema v28).

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use crate::db::{ms_to_ts, now_ms, Database};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceStatus {
    Creating,
    Active,
    Missing,
}

impl WorkspaceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkspaceStatus::Creating => "creating",
            WorkspaceStatus::Active => "active",
            WorkspaceStatus::Missing => "missing",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "creating" => WorkspaceStatus::Creating,
            "active" => WorkspaceStatus::Active,
            "missing" => WorkspaceStatus::Missing,
            other => return Err(anyhow!("unknown project workspace status {other}")),
        })
    }
}

/// Mirrors `session_worktrees::registry::SetupStatus`; the two tables keep
/// their own column so neither feature constrains the other's states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupStatus {
    None,
    Running,
    Ok,
    Failed,
}

impl SetupStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SetupStatus::None => "none",
            SetupStatus::Running => "running",
            SetupStatus::Ok => "ok",
            SetupStatus::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "none" => SetupStatus::None,
            "running" => SetupStatus::Running,
            "ok" => SetupStatus::Ok,
            "failed" => SetupStatus::Failed,
            other => return Err(anyhow!("unknown project workspace setup status {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRow {
    pub id: String,
    pub project_id: i64,
    /// Canonical path of the owning project, from the join.
    pub project_path: String,
    pub name: String,
    /// Workspace root: the directory `git worktree add` created.
    pub path: String,
    pub common_dir: String,
    /// Project directory relative to the repository top level.
    pub prefix: String,
    pub branch: String,
    pub source_remote: String,
    pub source_branch: String,
    pub source_commit: String,
    pub created_branch: bool,
    pub status: WorkspaceStatus,
    pub setup_status: Option<SetupStatus>,
    /// Bounded tail of the setup command output.
    pub setup_log: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The sidebar node shape; the field names are the frozen wire contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub project_path: String,
    pub name: String,
    pub relative_path: String,
    pub branch: String,
    pub source_remote: String,
    pub source_branch: String,
    pub created_branch: bool,
    pub status: WorkspaceStatus,
    pub setup_status: Option<SetupStatus>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn summary_of(row: &WorkspaceRow) -> WorkspaceSummary {
    WorkspaceSummary {
        id: row.id.clone(),
        project_path: row.project_path.clone(),
        name: row.name.clone(),
        relative_path: super::relative_path(&row.name),
        branch: row.branch.clone(),
        source_remote: row.source_remote.clone(),
        source_branch: row.source_branch.clone(),
        created_branch: row.created_branch,
        status: row.status,
        setup_status: row.setup_status,
        created_at: ms_to_ts(row.created_at),
        updated_at: ms_to_ts(row.updated_at),
    }
}

pub struct NewWorkspace<'a> {
    pub project_id: i64,
    pub name: &'a str,
    pub path: &'a str,
    pub common_dir: &'a str,
    pub prefix: &'a str,
    pub branch: &'a str,
    pub source_remote: &'a str,
    pub source_branch: &'a str,
    pub source_commit: &'a str,
    pub created_branch: bool,
}

const COLUMNS: &str = "w.id, w.project_id, p.path, w.name, w.path, w.common_dir, w.prefix,
                       w.branch, w.source_remote, w.source_branch, w.source_commit,
                       w.created_branch, w.status, w.setup_status, w.setup_log,
                       w.created_at, w.updated_at";

const FROM: &str = "FROM project_workspaces w JOIN projects p ON p.id = w.project_id";

fn from_row(row: &Row<'_>) -> rusqlite::Result<(WorkspaceRow, String, Option<String>)> {
    Ok((
        WorkspaceRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            project_path: row.get(2)?,
            name: row.get(3)?,
            path: row.get(4)?,
            common_dir: row.get(5)?,
            prefix: row.get(6)?,
            branch: row.get(7)?,
            source_remote: row.get(8)?,
            source_branch: row.get(9)?,
            source_commit: row.get(10)?,
            created_branch: row.get::<_, i64>(11)? != 0,
            status: WorkspaceStatus::Creating,
            setup_status: None,
            setup_log: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        },
        row.get(12)?,
        row.get(13)?,
    ))
}

fn finish(raw: (WorkspaceRow, String, Option<String>)) -> Result<WorkspaceRow> {
    let (mut row, status, setup) = raw;
    row.status = WorkspaceStatus::parse(&status)?;
    row.setup_status = setup.as_deref().map(SetupStatus::parse).transpose()?;
    Ok(row)
}

fn query_many(db: &Database, sql: &str, args: impl rusqlite::Params) -> Result<Vec<WorkspaceRow>> {
    let mut statement = db.conn().prepare_cached(sql)?;
    let rows = statement
        .query_map(args, from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(finish).collect()
}

/// Insert a row in `creating` state. The unique index on `(project_id, name)`
/// and the unique `path` reject a second workspace of the same name or root.
pub fn insert(db: &Database, new: &NewWorkspace<'_>) -> Result<WorkspaceRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO project_workspaces (
             id, project_id, name, path, common_dir, prefix, branch, source_remote,
             source_branch, source_commit, created_branch, status, setup_status,
             created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'creating', NULL, ?12, ?12)",
        params![
            id,
            new.project_id,
            new.name,
            new.path,
            new.common_dir,
            new.prefix,
            new.branch,
            new.source_remote,
            new.source_branch,
            new.source_commit,
            i64::from(new.created_branch),
            now
        ],
    )?;
    get(db, &id)?.ok_or_else(|| anyhow!("inserted project workspace {id} not found"))
}

pub fn get(db: &Database, id: &str) -> Result<Option<WorkspaceRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!("SELECT {COLUMNS} {FROM} WHERE w.id = ?1"))?
        .query_row(params![id], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// The workspace of one project with this name, if any. The create path and
/// the re-import pass both need the row, not just its existence.
pub fn by_name(db: &Database, project_id: i64, name: &str) -> Result<Option<WorkspaceRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!(
            "SELECT {COLUMNS} {FROM} WHERE w.project_id = ?1 AND w.name = ?2"
        ))?
        .query_row(params![project_id, name], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// The workspace registered at this root, if any. `path` is UNIQUE, so the
/// re-import pass uses it to recognize a directory it already owns even when
/// the name on disk was changed by hand.
pub fn by_path(db: &Database, path: &str) -> Result<Option<WorkspaceRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!("SELECT {COLUMNS} {FROM} WHERE w.path = ?1"))?
        .query_row(params![path], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// Every workspace of one project, oldest first.
pub fn for_project(db: &Database, project_path: &str) -> Result<Vec<WorkspaceRow>> {
    let path =
        crate::db::canonical_project_path(project_path).unwrap_or_else(|| project_path.to_string());
    query_many(
        db,
        &format!("SELECT {COLUMNS} {FROM} WHERE p.path = ?1 ORDER BY w.created_at"),
        params![path],
    )
}

/// Every row, for startup reconciliation.
pub fn all(db: &Database) -> Result<Vec<WorkspaceRow>> {
    query_many(
        db,
        &format!("SELECT {COLUMNS} {FROM} ORDER BY w.created_at"),
        [],
    )
}

/// The workspace a session is bound to, or `None` for a project session.
pub fn for_session(db: &Database, session_id: &str) -> Result<Option<WorkspaceRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!(
            "SELECT {COLUMNS} {FROM}
             JOIN sessions s ON s.workspace_id = w.id
             WHERE s.id = ?1"
        ))?
        .query_row(params![session_id], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// Live session ids bound to a workspace, newest first.
pub fn session_ids(db: &Database, workspace_id: &str) -> Result<Vec<String>> {
    let mut statement = db.conn().prepare_cached(
        "SELECT id FROM sessions
         WHERE workspace_id = ?1 AND deleted_at IS NULL
         ORDER BY updated_at DESC",
    )?;
    let ids = statement
        .query_map(params![workspace_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// How many workspaces of this repository share `prefix`. The managed
/// `info/exclude` rule is pruned only when this reaches zero.
pub fn count_for_prefix(db: &Database, common_dir: &str, prefix: &str) -> Result<i64> {
    Ok(db.conn().query_row(
        "SELECT COUNT(*) FROM project_workspaces WHERE common_dir = ?1 AND prefix = ?2",
        params![common_dir, prefix],
        |row| row.get(0),
    )?)
}

pub fn set_status(db: &Database, id: &str, status: WorkspaceStatus) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE project_workspaces SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status.as_str(), now_ms()],
    )? > 0)
}

pub fn set_setup_status(
    db: &Database,
    id: &str,
    status: SetupStatus,
    log: Option<&str>,
) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE project_workspaces
         SET setup_status = ?2, setup_log = COALESCE(?3, setup_log), updated_at = ?4
         WHERE id = ?1",
        params![id, status.as_str(), log, now_ms()],
    )? > 0)
}

/// Record a recomputed location after the project moved or was renamed.
pub fn relocate(db: &Database, id: &str, path: &str, common_dir: &str) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE project_workspaces SET path = ?2, common_dir = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, path, common_dir, now_ms()],
    )? > 0)
}

pub fn remove(db: &Database, id: &str) -> Result<bool> {
    Ok(db
        .conn()
        .execute("DELETE FROM project_workspaces WHERE id = ?1", params![id])?
        > 0)
}
