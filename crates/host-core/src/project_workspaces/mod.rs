//! Project workspaces: named linked git worktrees that live inside the
//! project at `.pi/worktree/<name>` and own their own sessions.
//!
//! Distinct from two neighbours that already use the word "workspace":
//! `workspace.*` is the active project of the window, and `worktree.*` is the
//! per-session isolated worktree of ADR 0329, which is machine named and
//! stored outside the project. "workspace" alone never means this feature in
//! shared code; the identifiers are always `project_workspace` /
//! `projectWorkspace`.
//!
//! host-core owns every path and every git command. Callers name a project or
//! a workspace id; no method accepts a workspace path.

pub mod branches;
pub mod create;
pub mod exclude;
pub mod import;
pub mod lifecycle;
pub mod registry;
pub mod repair;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use unicode_normalization::{is_nfc, UnicodeNormalization};

use crate::session_worktrees::git::{GitError, GitRunner};
use crate::session_worktrees::probe::ProbeError;

pub const SCHEMA: &str = include_str!("schema.sql");

/// The session binding column of schema v28. A session bound to a workspace
/// derives its tool root from this id, never from a client-sent path. NULL for
/// every project-level session, so existing rows and existing `session.create`
/// callers are unaffected. SQLite requires an added column's default to be
/// NULL when it carries a REFERENCES clause, which is exactly the wanted
/// default.
///
/// Not in `schema.sql`: `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS`,
/// so [`apply_schema`] adds it only when it is absent.
const SESSION_BINDING_DDL: &str = "ALTER TABLE sessions ADD COLUMN workspace_id TEXT \
     REFERENCES project_workspaces(id) ON DELETE CASCADE;";

const SESSION_BINDING_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_sessions_workspace \
     ON sessions(workspace_id) WHERE workspace_id IS NOT NULL;";

/// Apply every schema-v28 object: the registry table and the session binding.
/// The fresh schema and the v27 to v28 migration both call this, so the two
/// cannot drift, and it is idempotent, so a database downgraded in place (a
/// test fixture) migrates again cleanly.
pub fn apply_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    let bound: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'workspace_id')",
        [],
        |row| row.get(0),
    )?;
    if !bound {
        conn.execute_batch(SESSION_BINDING_DDL)?;
    }
    conn.execute_batch(SESSION_BINDING_INDEX)
}

/// Directory under the project that holds every workspace of that project.
pub const WORKSPACE_DIR: &str = ".pi/worktree";

/// Upper bound on the user-typed name, in characters.
const MAX_NAME_CHARS: usize = 64;

/// Windows device names. `CON.txt` is reserved too, so the stem before the
/// first `.` is what gets compared.
const WINDOWS_RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Machine-readable error codes of `projectWorkspace.*`. These strings are a
/// frozen contract shared with the renderer (`ProjectWorkspaceErrorCodes` in
/// `packages/shared/src/types/project-workspace.ts`); do not rename them.
pub const WORKSPACE_NAME_INVALID: &str = "WORKSPACE_NAME_INVALID";
pub const WORKSPACE_NAME_EXISTS: &str = "WORKSPACE_NAME_EXISTS";
pub const WORKSPACE_PATH_EXISTS: &str = "WORKSPACE_PATH_EXISTS";
pub const WORKSPACE_BRANCH_INVALID: &str = "WORKSPACE_BRANCH_INVALID";
pub const WORKSPACE_BRANCH_IN_USE: &str = "WORKSPACE_BRANCH_IN_USE";
pub const WORKSPACE_BRANCH_EXISTS: &str = "WORKSPACE_BRANCH_EXISTS";
pub const WORKSPACE_SOURCE_NOT_FOUND: &str = "WORKSPACE_SOURCE_NOT_FOUND";
pub const WORKSPACE_NO_REMOTE: &str = "WORKSPACE_NO_REMOTE";
pub const WORKSPACE_FETCH_FAILED: &str = "WORKSPACE_FETCH_FAILED";
pub const WORKSPACE_NOT_FOUND: &str = "WORKSPACE_NOT_FOUND";
pub const WORKSPACE_NOT_READY: &str = "WORKSPACE_NOT_READY";
pub const WORKSPACE_MISSING: &str = "WORKSPACE_MISSING";
pub const WORKSPACE_HAS_RUNNING_SESSIONS: &str = "WORKSPACE_HAS_RUNNING_SESSIONS";
pub const WORKSPACE_ISOLATED_CONFLICT: &str = "WORKSPACE_ISOLATED_CONFLICT";
pub const WORKSPACE_REMOTE_UNSUPPORTED: &str = "WORKSPACE_REMOTE_UNSUPPORTED";
pub const WORKSPACE_REPAIR_FAILED: &str = "WORKSPACE_REPAIR_FAILED";

/// A failure that reaches the RPC surface with a stable error code. The
/// `WORKSPACE_*` codes are this feature's own; the `WORKTREE_*` codes come
/// from the shared git probe and runner and are passed through unchanged,
/// because the git requirements are the same ones ADR 0329 already probes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceError {
    pub code: &'static str,
    pub message: String,
}

impl WorkspaceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn name_invalid(reason: impl Into<String>) -> Self {
        Self::new(WORKSPACE_NAME_INVALID, reason)
    }

    pub fn no_remote() -> Self {
        Self::new(
            "WORKSPACE_NO_REMOTE",
            "this repository has no remote to create a workspace from",
        )
    }

    /// An internal invariant failed. Callers map this to the generic RPC
    /// error; it is never a condition the user can act on.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("WORKTREE_INTERNAL", message)
    }
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<GitError> for WorkspaceError {
    fn from(error: GitError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

impl From<ProbeError> for WorkspaceError {
    fn from(error: ProbeError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

impl From<anyhow::Error> for WorkspaceError {
    fn from(error: anyhow::Error) -> Self {
        Self::new("WORKTREE_INTERNAL", error.to_string())
    }
}

impl From<std::io::Error> for WorkspaceError {
    fn from(error: std::io::Error) -> Self {
        Self::new("WORKTREE_IO", error.to_string())
    }
}

impl From<rusqlite::Error> for WorkspaceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("WORKTREE_INTERNAL", error.to_string())
    }
}

type Result<T> = std::result::Result<T, WorkspaceError>;

/// Validate the user-typed name as one safe path segment and return it in NFC.
///
/// The name is not slugified: what the user types is what appears on disk.
/// NFC is the normalization, not a rewrite of the user's intent — macOS stores
/// what it is given while Linux compares bytes, so two visually identical
/// names must not be able to produce two directories.
///
/// Whitespace is rejected rather than trimmed: a trimmed name would no longer
/// be the name the create dialog previewed as `.pi/worktree/<name>`.
pub fn validate_name(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err(WorkspaceError::name_invalid("the name is required"));
    }
    let name: String = if is_nfc(raw) {
        raw.to_string()
    } else {
        raw.nfc().collect()
    };
    let count = name.chars().count();
    if count > MAX_NAME_CHARS {
        return Err(WorkspaceError::name_invalid(format!(
            "the name must be at most {MAX_NAME_CHARS} characters"
        )));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(WorkspaceError::name_invalid(
            "the name must be one path segment, without `/` or `\\`",
        ));
    }
    if name.contains("..") {
        return Err(WorkspaceError::name_invalid(
            "the name must not contain `..`",
        ));
    }
    if let Some(bad) = name.chars().find(|c| c.is_control()) {
        return Err(WorkspaceError::name_invalid(format!(
            "the name must not contain the control character U+{:04X}",
            bad as u32
        )));
    }
    if name.starts_with('.') {
        return Err(WorkspaceError::name_invalid(
            "the name must not start with `.`",
        ));
    }
    // A trailing space or dot is dropped by the Windows filesystem, which
    // would make the directory name differ from the stored name.
    if name.ends_with(' ') || name.ends_with('.') || name.starts_with(' ') {
        return Err(WorkspaceError::name_invalid(
            "the name must not start or end with a space, or end with `.`",
        ));
    }
    // Reserved on Windows whichever extension follows, and `:` is the stream
    // separator there.
    if name.contains(':')
        || name.contains('*')
        || name.contains('?')
        || name.contains('"')
        || name.contains('<')
        || name.contains('>')
        || name.contains('|')
    {
        return Err(WorkspaceError::name_invalid(
            "the name must not contain `: * ? \" < > |`",
        ));
    }
    let stem = name.split('.').next().unwrap_or(&name);
    if WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(WorkspaceError::name_invalid(format!(
            "`{stem}` is a reserved device name"
        )));
    }
    Ok(name)
}

/// The workspace root of a validated name under a project.
pub fn workspace_path(project: &Path, name: &str) -> PathBuf {
    project.join(".pi").join("worktree").join(name)
}

/// Project-relative display path of a workspace, for the sidebar.
pub fn relative_path(name: &str) -> String {
    format!("{WORKSPACE_DIR}/{name}")
}

/// Validate a branch name with git itself. No such validation exists
/// elsewhere in host-core, and reimplementing `check-ref-format` by hand
/// would drift from the git version actually installed.
pub async fn validate_branch_name(git: &GitRunner, dir: &Path, branch: &str) -> Result<()> {
    let invalid = |reason: &str| {
        Err(WorkspaceError::new(
            "WORKSPACE_BRANCH_INVALID",
            format!("`{branch}` is not a valid branch name: {reason}"),
        ))
    };
    if branch.is_empty() {
        return invalid("it is empty");
    }
    // Checked here because git would read it as an option, not as a ref.
    if branch.starts_with('-') {
        return invalid("it must not start with `-`");
    }
    // `@{-1}` and friends resolve to a previously checked-out branch rather
    // than naming one, and `check-ref-format` accepts the spelling.
    if branch.contains("@{") {
        return invalid("it must not contain `@{`");
    }
    let output = git
        .output(dir, &["check-ref-format", "--branch", branch])
        .await?;
    if output.success() {
        Ok(())
    } else {
        invalid("git rejected it")
    }
}
