//! Repair and startup reconciliation.
//!
//! Repair is the per-workspace pass the user triggers: it re-links a checkout
//! after the project (or the repository) moved, and checks a vanished one out
//! again from its recorded branch. Reconciliation applies the same rules to
//! every registered row at startup, then hands over to re-import.

use std::path::{Path, PathBuf};

use super::create::{root_is_real, SharedState};
use super::import::import_all;
use super::lifecycle::{remove_checkout, require_row};
use super::registry::{self, WorkspaceRow, WorkspaceStatus};
use super::{exclude, WorkspaceError, WORKSPACE_REPAIR_FAILED};
use crate::db::Database;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::include::copy_included;
use crate::session_worktrees::remove::is_real_dir;
use crate::session_worktrees::repo_lock;

/// Re-link one workspace after the project (or the repository) moved, or check
/// it out again when its folder is gone.
///
/// The path is recomputed from the project's current location plus the stored
/// prefix and name, and `git worktree repair` is given explicit paths: a bare
/// `git worktree repair` from the moved parent exits 0 and repairs nothing,
/// because the registered gitdir still points at the old location. A vanished
/// folder is re-created from the recorded branch (`recreate_checkout`).
pub async fn repair(
    state: &SharedState,
    git: &GitRunner,
    workspace_id: &str,
) -> Result<registry::WorkspaceSummary, WorkspaceError> {
    let (row, project_path) = {
        let st = state.lock().await;
        let row = require_row(&st.db, workspace_id)?;
        let project = st.db.project_path(row.project_id)?;
        (row, project)
    };
    let Some(project_path) = project_path else {
        return Err(WorkspaceError::new(
            WORKSPACE_REPAIR_FAILED,
            "the owning project is no longer registered",
        ));
    };
    let recorded_path = row.path.clone();
    let row = relocate_row(state, git, &row, &project_path).await?;
    if !root_is_real(&row) {
        {
            let st = state.lock().await;
            registry::set_status(&st.db, &row.id, WorkspaceStatus::Missing)?;
        }
        return recreate_checkout(state, git, &row, &recorded_path, &project_path).await;
    }
    let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
    git.run_git_dir(
        Path::new(&row.common_dir),
        &["worktree", "repair", &row.path],
    )
    .await
    .map_err(|error| {
        WorkspaceError::new(
            WORKSPACE_REPAIR_FAILED,
            format!("git worktree repair failed: {error}"),
        )
    })?;
    let st = state.lock().await;
    registry::set_status(&st.db, &row.id, WorkspaceStatus::Active)?;
    let row = registry::get(&st.db, &row.id)?.unwrap_or(row);
    Ok(registry::summary_of(&row))
}

/// Check a vanished workspace out again at its path from its recorded branch.
///
/// Refused when anything occupies the path, so a link or a file put there is
/// never replaced, and when the branch no longer exists. git refuses to add a
/// worktree at a path it still has registered, so the stale registration is
/// dropped first, and only for a path where nothing exists on disk. The files
/// `.worktreeinclude` selects are copied again, exactly as creation copies
/// them; the setup command's output is not restored.
async fn recreate_checkout(
    state: &SharedState,
    git: &GitRunner,
    row: &WorkspaceRow,
    recorded_path: &str,
    project_path: &str,
) -> Result<registry::WorkspaceSummary, WorkspaceError> {
    let refuse = |message: String| WorkspaceError::new(WORKSPACE_REPAIR_FAILED, message);
    let root = Path::new(&row.path);
    if std::fs::symlink_metadata(root).is_ok() {
        return Err(refuse(format!(
            "{} exists but is not a usable checkout; move it away and repair again",
            super::relative_path(&row.name)
        )));
    }
    let project = Path::new(project_path);
    let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
    let branch_ref = format!("refs/heads/{}", row.branch);
    let branch = git
        .output(project, &["show-ref", "--verify", "--quiet", &branch_ref])
        .await?;
    if !branch.success() {
        return Err(refuse(format!(
            "branch `{}` no longer exists; remove this workspace from the list",
            row.branch
        )));
    }
    // The repository top level, for the `.worktreeinclude` copy below. Resolved
    // before anything is re-added, so a failure refuses the repair instead of
    // leaving a checkout behind. `probe` is deliberately not used: it refuses a
    // detached HEAD in the main checkout and an existing `pi-harbor` branch
    // namespace, neither of which blocks a repair. Canonicalized as `probe`
    // canonicalizes it, so the copy reads the same source root creation reads.
    let toplevel = git
        .run(project, &["rev-parse", "--show-toplevel"])
        .await
        .map(|output| {
            let path = PathBuf::from(output.trim());
            crate::workspace::simple_canonicalize(&path).unwrap_or(path)
        })
        .map_err(|error| refuse(format!("could not locate the repository: {error}")))?;
    let mut stale = vec![row.path.as_str()];
    if recorded_path != row.path {
        stale.push(recorded_path);
    }
    for path in stale {
        if std::fs::symlink_metadata(path).is_err() {
            // Nothing is on disk there, so this only drops git's registration.
            git.output(project, &["worktree", "remove", "--force", "--force", path])
                .await?;
        }
    }
    exclude::add_rule(Path::new(&row.common_dir), &row.prefix)?;
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `--force`: the branch may be checked out in another worktree too (the
    // project itself, or another workspace), and git refuses that by default.
    git.run(
        project,
        &["worktree", "add", "-q", "--force", &row.path, &row.branch],
    )
    .await
    .map_err(|error| {
        refuse(format!(
            "could not check `{}` out again: {error}",
            row.branch
        ))
    })?;
    let reason = format!("PI-Desktop workspace {}", row.name);
    let materialized: Result<(), WorkspaceError> = async {
        git.run(
            project,
            &["worktree", "lock", "--reason", &reason, &row.path],
        )
        .await?;
        // Same helper, source root, and destination as creation, so a repaired
        // checkout holds the included files a freshly created one holds.
        copy_included(git, &toplevel, root)
            .await
            .map_err(|error| WorkspaceError::new(error.code, error.message))?;
        Ok(())
    }
    .await;
    if let Err(error) = materialized {
        // All-or-nothing, as creation is: drop the fresh checkout link-safely
        // rather than leave a half-populated one behind. A cleanup failure is
        // logged, never returned, so the caller always sees the original cause.
        // The row stays `missing` (set by `repair` before this call), so the
        // workspace keeps offering Repair instead of looking usable.
        if let Err(cleanup) = remove_checkout(git, row, false).await {
            tracing::warn!(%cleanup, path = %row.path, "could not discard a failed workspace repair");
        }
        return Err(error);
    }
    let st = state.lock().await;
    registry::set_status(&st.db, &row.id, WorkspaceStatus::Active)?;
    let row = registry::get(&st.db, &row.id)?.unwrap_or_else(|| row.clone());
    Ok(registry::summary_of(&row))
}

/// Mark `active` rows whose checkout folder is gone as `missing`, so a folder
/// deleted while the app runs shows "Folder missing" as soon as the list is
/// read, and the row agrees with what `tool_root` reports. A checkout that
/// only moved with its project is left alone: startup reconciliation and
/// Repair re-link it.
pub fn mark_vanished(db: &Database, rows: &mut [WorkspaceRow]) -> Result<(), WorkspaceError> {
    for row in rows.iter_mut() {
        if row.status != WorkspaceStatus::Active || root_is_real(row) {
            continue;
        }
        let moved = super::workspace_path(Path::new(&row.project_path), &row.name);
        if moved.as_path() != Path::new(&row.path) && is_real_dir(&moved) {
            continue;
        }
        registry::set_status(db, &row.id, WorkspaceStatus::Missing)?;
        row.status = WorkspaceStatus::Missing;
    }
    Ok(())
}

/// Recompute `path` and `common_dir` from the project's current location.
/// A project move changes both, so the stored values are only a starting
/// point for finding the workspace again.
async fn relocate_row(
    state: &SharedState,
    git: &GitRunner,
    row: &WorkspaceRow,
    project_path: &str,
) -> Result<WorkspaceRow, WorkspaceError> {
    let expected = super::workspace_path(Path::new(project_path), &row.name);
    let expected_text = expected.to_string_lossy().into_owned();
    let common_dir =
        match crate::session_worktrees::probe::probe(git, Path::new(project_path)).await {
            Ok(repo) => repo.common_dir.to_string_lossy().into_owned(),
            // The project itself is unreadable; keep the recorded repository.
            Err(_) => row.common_dir.clone(),
        };
    if expected_text == row.path && common_dir == row.common_dir {
        return Ok(row.clone());
    }
    let st = state.lock().await;
    registry::relocate(&st.db, &row.id, &expected_text, &common_dir)?;
    Ok(registry::get(&st.db, &row.id)?.unwrap_or_else(|| {
        let mut moved = row.clone();
        moved.path = expected_text;
        moved.common_dir = common_dir;
        moved
    }))
}

/// Startup pass: roll back `creating` rows, mark non-directory or
/// link-replaced roots `missing`, repair the rest under the repo lock, and
/// re-adopt orphaned directories of every registered project.
pub async fn reconcile(state: SharedState, git: GitRunner) {
    let rows = match registry::all(&state.lock().await.db) {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "could not read the project workspace registry");
            return;
        }
    };
    for row in rows {
        if row.status == WorkspaceStatus::Creating {
            super::create::discard_failed_creation(&state, &git, &row).await;
            continue;
        }
        let project_path = {
            let st = state.lock().await;
            st.db.project_path(row.project_id).ok().flatten()
        };
        let row = match project_path.as_deref() {
            Some(project) => match relocate_row(&state, &git, &row, project).await {
                Ok(row) => row,
                Err(error) => {
                    tracing::warn!(%error, path = %row.path, "could not relocate a workspace");
                    row
                }
            },
            None => row,
        };
        if !root_is_real(&row) {
            let st = state.lock().await;
            let _ = registry::set_status(&st.db, &row.id, WorkspaceStatus::Missing);
            continue;
        }
        let common_dir = PathBuf::from(&row.common_dir);
        if common_dir.is_dir() {
            let _guard = repo_lock::lock(&common_dir).await;
            if let Err(error) = git
                .run_git_dir(&common_dir, &["worktree", "repair", &row.path])
                .await
            {
                tracing::warn!(%error, path = %row.path, "git worktree repair failed");
            }
        }
        if row.status == WorkspaceStatus::Missing {
            let st = state.lock().await;
            let _ = registry::set_status(&st.db, &row.id, WorkspaceStatus::Active);
        }
    }
    import_all(&state, &git).await;
}
