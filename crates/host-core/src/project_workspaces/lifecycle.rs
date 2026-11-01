//! Resolution, setup, and deletion of a workspace.
//!
//! Repair and startup reconciliation live in [`super::repair`], re-adoption of
//! on-disk checkouts in [`super::import`].
//!
//! A workspace session's root is always derived from its binding (workspace
//! path plus repository prefix), never from a client-sent path, and it never
//! falls back to the project root: a half-created or vanished workspace fails
//! the session instead.

use std::path::{Path, PathBuf};

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use serde_json::json;

use super::create::{path_exists, root_is_real, root_of, SharedState};
use super::registry::{self, SetupStatus, WorkspaceRow, WorkspaceStatus};
use super::{
    exclude, WorkspaceError, WORKSPACE_HAS_RUNNING_SESSIONS, WORKSPACE_MISSING,
    WORKSPACE_NOT_FOUND, WORKSPACE_NOT_READY,
};
use crate::db::Database;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::SETUP_TIMEOUT_MS;
use crate::session_worktrees::remove::{
    clear_contents, drop_admin_entry, is_real_dir, remove_entry,
};
use crate::session_worktrees::repo_lock;
use crate::sessions;

const SETUP_LOG_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWork {
    pub sessions: i64,
    pub running_sessions: i64,
    pub uncommitted_changes: bool,
    pub unpushed_commits: i64,
    /// False when the folder is missing, so git could not be consulted.
    pub git_readable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub removed: bool,
    pub sessions_removed: i64,
    /// True when the folder was left on disk (`keepFolder`, or already gone).
    pub folder_kept: bool,
    pub branch_deleted: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DeleteOptions {
    /// Delete the local branch as well. Off by default.
    pub delete_branch: bool,
    /// Keep the checkout on disk and only drop it from the list.
    pub keep_folder: bool,
}

// ---- resolution (sync, called under the AppState lock) ----------------------

/// The tool root of a workspace-bound session, or `None` for every other
/// session. A workspace session never falls back to the project root.
pub fn tool_root(db: &Database, session_id: &str) -> Result<Option<PathBuf>, WorkspaceError> {
    let Some(row) = registry::for_session(db, session_id)? else {
        return Ok(None);
    };
    match row.status {
        WorkspaceStatus::Creating => Err(WorkspaceError::new(
            WORKSPACE_NOT_READY,
            "the workspace is still being created",
        )),
        WorkspaceStatus::Missing => Err(missing_error()),
        WorkspaceStatus::Active => {
            if root_is_real(&row) {
                Ok(Some(root_of(&row)))
            } else {
                Err(missing_error())
            }
        }
    }
}

pub(super) fn missing_error() -> WorkspaceError {
    WorkspaceError::new(
        WORKSPACE_MISSING,
        "the workspace folder no longer exists; repair the workspace or remove it",
    )
}

/// `PI_PROJECT_ROOT` and `PI_WORKSPACE_ROOT` for a workspace session's shell
/// commands; empty for every other session.
pub fn tool_env(db: &Database, session_id: &str) -> Vec<(String, String)> {
    let Ok(Some(row)) = registry::for_session(db, session_id) else {
        return Vec::new();
    };
    let project = sessions::session_summary(db, session_id)
        .ok()
        .flatten()
        .and_then(|summary| summary.project_path);
    env_for(&row, project.as_deref())
}

pub(super) fn env_for(row: &WorkspaceRow, project: Option<&str>) -> Vec<(String, String)> {
    let root = root_of(row).to_string_lossy().into_owned();
    let mut env = vec![
        ("PI_WORKSPACE_ROOT".to_string(), root.clone()),
        // The project's `worktree_setup_command` was written for isolated
        // worktrees, which export this name; a workspace keeps it working.
        ("PI_WORKTREE_ROOT".to_string(), root),
    ];
    if let Some(project) = project {
        env.push(("PI_PROJECT_ROOT".to_string(), project.to_string()));
    }
    env
}

// ---- setup -----------------------------------------------------------------

/// Run the project's `worktree_setup_command` in the new workspace. Same
/// timeout and log cap as the isolated-worktree setup.
pub(super) async fn run_setup(
    state: SharedState,
    row: WorkspaceRow,
    project_path: String,
    command: String,
) {
    let shell_id = {
        let st = state.lock().await;
        let configured = st
            .db
            .get_setting("app")
            .ok()
            .flatten()
            .and_then(|settings| {
                settings
                    .get("defaultCommandShell")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            });
        crate::tools::shell::catalog(configured.as_deref())
            .effective
            .map(|option| option.id)
            .unwrap_or_else(|| crate::tools::shell::default_shell_id().to_string())
    };
    let root = root_of(&row);
    let result = crate::tools::execute_tool_with_path_access(
        Some(&root),
        None,
        "Bash",
        &json!({ "command": command }),
        crate::tools::ToolExecutionOptions {
            timeout_ms: Some(SETUP_TIMEOUT_MS),
            bash_options: Some(crate::tools::BashExecutionOptions {
                session_id: String::new(),
                tool_call_id: format!("project-workspace-setup-{}", row.id),
                command_shell_id: shell_id,
                timeout_ms: Some(SETUP_TIMEOUT_MS),
                cancellation: None,
                output_tx: None,
                extra_env: env_for(&row, Some(&project_path)),
                run_in_background: false,
                app_state: None,
            }),
            allow_external_paths: false,
            hashline: None,
            visualization_root: None,
        },
    )
    .await;
    let log = setup_log(&result.content);
    let status = if result.ok {
        SetupStatus::Ok
    } else {
        SetupStatus::Failed
    };
    let st = state.lock().await;
    if let Err(error) = registry::set_setup_status(&st.db, &row.id, status, Some(&log)) {
        tracing::warn!(%error, "could not record the workspace setup result");
    }
}

fn setup_log(content: &serde_json::Value) -> String {
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        value => {
            let stdout = value.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
            let stderr = value.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
            format!("{stdout}{stderr}")
        }
    };
    if text.len() <= SETUP_LOG_LIMIT {
        return text;
    }
    let tail = text
        .char_indices()
        .rev()
        .map(|(index, _)| index)
        .find(|index| text.len() - index <= SETUP_LOG_LIMIT)
        .unwrap_or(0);
    format!("…{}", &text[tail..])
}

// ---- removal ---------------------------------------------------------------

/// Remove the checkout link-safely and drop git's registration for it.
///
/// `delete_branch` also deletes the local branch through the common git dir.
/// A locked worktree needs `git worktree remove --force --force`: the first
/// `--force` overrides a dirty tree, the second a lock.
pub(super) async fn remove_checkout(
    git: &GitRunner,
    row: &WorkspaceRow,
    delete_branch: bool,
) -> Result<(), WorkspaceError> {
    let root = Path::new(&row.path);
    let common_dir = Path::new(&row.common_dir);
    let repository_exists = common_dir.is_dir();
    match std::fs::symlink_metadata(root) {
        // The registered folder was replaced by a link (or a file): remove
        // that entry alone; its target is never read or emptied.
        Ok(metadata) if !metadata.is_dir() => remove_entry(root)?,
        Ok(_) => {
            // Empty it first: Git for Windows follows a junction inside the
            // worktree during `git worktree remove --force` and deletes the
            // target's files (see `session_worktrees::remove`).
            clear_contents(root)?;
            if repository_exists {
                git.run_git_dir(
                    common_dir,
                    &["worktree", "remove", "--force", "--force", &row.path],
                )
                .await?;
            }
            if is_real_dir(root) {
                std::fs::remove_dir_all(root)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if repository_exists {
        drop_admin_entry(common_dir, root)?;
        if delete_branch {
            delete_local_branch(git, common_dir, &row.branch).await?;
        }
    }
    Ok(())
}

/// Drop git's registration but keep the directory on disk ("remove from
/// list"). The checkout stops being a working linked worktree, which is what
/// keeps the re-import pass from adopting it again.
async fn unregister_checkout(git: &GitRunner, row: &WorkspaceRow) -> Result<(), WorkspaceError> {
    let common_dir = Path::new(&row.common_dir);
    if !common_dir.is_dir() {
        return Ok(());
    }
    // Unlock first: `git worktree prune` refuses a locked entry, and the
    // admin directory is dropped directly below.
    let _ = git
        .run_git_dir(common_dir, &["worktree", "unlock", &row.path])
        .await;
    drop_admin_entry(common_dir, Path::new(&row.path))?;
    Ok(())
}

async fn delete_local_branch(
    git: &GitRunner,
    common_dir: &Path,
    branch: &str,
) -> Result<bool, WorkspaceError> {
    let exists = git
        .run_git_dir(
            common_dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await
        .is_ok();
    if !exists {
        return Ok(false);
    }
    git.run_git_dir(common_dir, &["branch", "-D", branch])
        .await?;
    Ok(true)
}

/// Remove the managed `info/exclude` rule once no workspace of that prefix is
/// left in the same repository and nothing is left under the project's
/// `.pi/worktree` either. A folder kept by "remove from list" still holds a
/// checkout; without the rule, `git add -A` in the parent would stage it as an
/// embedded repository.
pub(super) fn prune_exclude_if_last(db: &Database, row: &WorkspaceRow) -> Result<()> {
    if registry::count_for_prefix(db, &row.common_dir, &row.prefix)? > 0 {
        return Ok(());
    }
    // Workspace names never start with `.`, so `.DS_Store` and friends are not
    // checkouts and do not keep the rule alive.
    let holds_checkouts = Path::new(&row.path)
        .parent()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .is_some_and(|mut entries| {
            entries.any(|entry| {
                entry.is_ok_and(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            })
        });
    if !holds_checkouts {
        exclude::remove_rule(Path::new(&row.common_dir), &row.prefix)?;
    }
    Ok(())
}

// ---- pending work and deletion ---------------------------------------------

/// What deleting the workspace would lose, for the confirmation dialog.
pub async fn pending_work(
    state: &SharedState,
    git: &GitRunner,
    workspace_id: &str,
) -> Result<PendingWork, WorkspaceError> {
    let (row, session_ids) = {
        let st = state.lock().await;
        let row = require_row(&st.db, workspace_id)?;
        let ids = registry::session_ids(&st.db, workspace_id)?;
        (row, ids)
    };
    let running = {
        let st = state.lock().await;
        session_ids
            .iter()
            .filter(|id| sessions::session_has_running_turn(&st.db, id).unwrap_or(false))
            .count() as i64
    };
    let mut pending = PendingWork {
        sessions: session_ids.len() as i64,
        running_sessions: running,
        ..PendingWork::default()
    };
    let root = Path::new(&row.path);
    if root_is_real(&row) {
        pending.git_readable = true;
        pending.uncommitted_changes = !git
            .run(root, &["status", "--porcelain"])
            .await?
            .trim()
            .is_empty();
        pending.unpushed_commits = unpushed_commits(git, &row).await?;
    }
    Ok(pending)
}

/// Commits on the workspace branch that its upstream does not have. Without
/// an upstream, the source commit the workspace started from is the baseline.
async fn unpushed_commits(git: &GitRunner, row: &WorkspaceRow) -> Result<i64, WorkspaceError> {
    let root = Path::new(&row.path);
    let upstream = git
        .output(
            root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{}@{{upstream}}", row.branch),
            ],
        )
        .await?;
    let base = if upstream.success() && !upstream.stdout.trim().is_empty() {
        upstream.stdout.trim().to_string()
    } else {
        row.source_commit.clone()
    };
    let counted = git
        .output(
            root,
            &[
                "rev-list",
                "--count",
                &format!("{base}..refs/heads/{}", row.branch),
            ],
        )
        .await?;
    if !counted.success() {
        return Ok(0);
    }
    Ok(counted.stdout.trim().parse().unwrap_or(0))
}

/// Delete a workspace: its sessions and their side data, then the checkout,
/// then the row, then the managed exclude rule when it was the last one.
pub async fn delete(
    state: &SharedState,
    git: &GitRunner,
    workspace_id: &str,
    options: &DeleteOptions,
) -> Result<DeleteOutcome, WorkspaceError> {
    let (row, session_ids) = {
        let st = state.lock().await;
        let row = require_row(&st.db, workspace_id)?;
        let ids = registry::session_ids(&st.db, workspace_id)?;
        // Refused while any session of the workspace is running, the same
        // idle rule the isolated-worktree removal applies.
        for id in &ids {
            if sessions::session_has_running_turn(&st.db, id)? {
                return Err(WorkspaceError::new(
                    WORKSPACE_HAS_RUNNING_SESSIONS,
                    "a session of this workspace is running; wait for it to finish",
                ));
            }
        }
        (row, ids)
    };

    let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;

    let mut sessions_removed = 0;
    for id in &session_ids {
        let removed = {
            let st = state.lock().await;
            sessions::delete_session(&st.db, id)?
        };
        if removed {
            let st = state.lock().await;
            crate::rpc::drop_session_side_data(&st, id);
            sessions_removed += 1;
        }
    }

    let existed = path_exists(&row) || std::fs::symlink_metadata(&row.path).is_ok();
    let mut branch_deleted = false;
    if options.keep_folder {
        unregister_checkout(git, &row).await?;
        if options.delete_branch {
            branch_deleted =
                delete_local_branch(git, Path::new(&row.common_dir), &row.branch).await?;
        }
    } else {
        remove_checkout(git, &row, options.delete_branch).await?;
        branch_deleted = options.delete_branch;
    }

    {
        let st = state.lock().await;
        registry::remove(&st.db, &row.id)?;
        prune_exclude_if_last(&st.db, &row)?;
    }
    Ok(DeleteOutcome {
        removed: true,
        sessions_removed,
        folder_kept: options.keep_folder || !existed,
        branch_deleted,
    })
}

pub fn require_row(db: &Database, workspace_id: &str) -> Result<WorkspaceRow, WorkspaceError> {
    registry::get(db, workspace_id)?
        .ok_or_else(|| WorkspaceError::new(WORKSPACE_NOT_FOUND, "no workspace with that id"))
}

// ---- session binding --------------------------------------------------------

/// Bind a session to a workspace. Rejects an unknown id so a session is never
/// silently downgraded to the project root.
pub fn bind_session(
    db: &Database,
    session_id: &str,
    workspace_id: &str,
) -> Result<(), WorkspaceError> {
    let row = require_row(db, workspace_id)?;
    db.conn().execute(
        "UPDATE sessions SET workspace_id = ?2 WHERE id = ?1",
        params![session_id, row.id],
    )?;
    Ok(())
}
