//! Remote and source-branch data for the create dialog.
//!
//! Enumeration is offline by default: `for-each-ref refs/remotes/<remote>`
//! reads the cached remote-tracking refs, so the dialog still works without
//! a network. `refresh` runs `git fetch --prune` first and degrades to the
//! cached list with a warning when the fetch fails.

use std::path::Path;

use serde::Serialize;

use super::{WorkspaceError, WORKSPACE_FETCH_FAILED};
use crate::db::Database;
use crate::session_worktrees::git::GitRunner;

/// Default remote when the repository has one.
const PREFERRED_REMOTE: &str = "origin";

/// `kv` namespace holding the last source branch the user picked per project.
const LAST_SOURCE_NS: &str = "projectWorkspaceSource";
/// `kv` namespace holding the last successful fetch time per project.
const LAST_FETCH_NS: &str = "projectWorkspaceFetch";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchWarning {
    pub error_code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub remote: String,
    pub remotes: Vec<String>,
    /// Short branch names under `refs/remotes/<remote>`, `HEAD` removed.
    pub branches: Vec<String>,
    pub default_branch: Option<String>,
    /// Last branch the user created a workspace from, when still listed.
    pub last_used_branch: Option<String>,
    pub fetched: bool,
    pub last_fetched_at: Option<i64>,
    pub warning: Option<FetchWarning>,
}

/// Remote names, `origin` first when present.
pub async fn remotes(git: &GitRunner, project: &Path) -> Result<Vec<String>, WorkspaceError> {
    let listed = git.run(project, &["remote"]).await?;
    let mut remotes: Vec<String> = listed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    remotes.sort();
    remotes.dedup();
    if let Some(index) = remotes.iter().position(|name| name == PREFERRED_REMOTE) {
        remotes.swap(0, index);
    }
    Ok(remotes)
}

/// The preselected remote: `origin`, else the first one, else `None`.
pub fn default_remote(remotes: &[String]) -> Option<String> {
    remotes.first().cloned()
}

/// Resolve the remote to use for a request, defaulting to `origin`.
pub async fn resolve_remote(
    git: &GitRunner,
    project: &Path,
    requested: Option<&str>,
) -> Result<(String, Vec<String>), WorkspaceError> {
    let remotes = remotes(git, project).await?;
    if remotes.is_empty() {
        return Err(WorkspaceError::no_remote());
    }
    let remote = match requested.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => {
            if !remotes.iter().any(|existing| existing == name) {
                return Err(WorkspaceError::new(
                    super::WORKSPACE_NO_REMOTE,
                    format!("the repository has no remote named `{name}`"),
                ));
            }
            name.to_string()
        }
        None => default_remote(&remotes).ok_or_else(WorkspaceError::no_remote)?,
    };
    Ok((remote, remotes))
}

/// Short branch names cached under `refs/remotes/<remote>`.
///
/// `lstrip=3` drops `refs/remotes/<remote>/` and keeps the rest intact, so a
/// nested name such as `feature/a/b` survives. `origin/HEAD` is a symbolic
/// ref, not a branch, and is filtered out.
pub async fn cached_branches(
    git: &GitRunner,
    project: &Path,
    remote: &str,
) -> Result<Vec<String>, WorkspaceError> {
    let listed = git
        .run(
            project,
            &[
                "for-each-ref",
                "--format=%(refname:lstrip=3)",
                &format!("refs/remotes/{remote}"),
            ],
        )
        .await?;
    let mut branches: Vec<String> = listed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "HEAD")
        .map(str::to_string)
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

/// The remote's default branch, when `refs/remotes/<remote>/HEAD` is set.
pub async fn default_branch(git: &GitRunner, project: &Path, remote: &str) -> Option<String> {
    let output = git
        .output(
            project,
            &[
                "symbolic-ref",
                "--quiet",
                &format!("refs/remotes/{remote}/HEAD"),
            ],
        )
        .await
        .ok()?;
    if !output.success() {
        return None;
    }
    output
        .stdout
        .trim()
        .strip_prefix(&format!("refs/remotes/{remote}/"))
        .map(str::to_string)
}

/// Remember the source branch a workspace was created from.
pub fn remember_source_branch(db: &Database, project_path: &str, branch: &str) {
    if let Err(error) = db.kv_set(
        LAST_SOURCE_NS,
        &project_key(project_path),
        &serde_json::json!(branch),
    ) {
        tracing::warn!(%error, "could not record the last project workspace source branch");
    }
}

fn last_source_branch(db: &Database, project_path: &str) -> Option<String> {
    db.kv_get(LAST_SOURCE_NS, &project_key(project_path))
        .ok()
        .flatten()
        .and_then(|value| value.as_str().map(str::to_string))
}

fn last_fetched_at(db: &Database, project_path: &str) -> Option<i64> {
    db.kv_get(LAST_FETCH_NS, &project_key(project_path))
        .ok()
        .flatten()
        .and_then(|value| value.as_i64())
}

fn record_fetch(db: &Database, project_path: &str) -> Option<i64> {
    let now = crate::db::now_ms();
    if let Err(error) = db.kv_set(
        LAST_FETCH_NS,
        &project_key(project_path),
        &serde_json::json!(now),
    ) {
        tracing::warn!(%error, "could not record the project workspace fetch time");
        return None;
    }
    Some(now)
}

/// The canonical project path keys both namespaces, so a project that is
/// re-added at the same location keeps its last choice.
fn project_key(project_path: &str) -> String {
    crate::db::canonical_project_path(project_path).unwrap_or_else(|| project_path.to_string())
}

/// The source-branch picker's data. A failed `refresh` is reported as a
/// warning beside the cached list rather than as an error, so the dialog
/// still works offline.
pub async fn list(
    state: &super::create::SharedState,
    git: &GitRunner,
    project: &Path,
    project_path: &str,
    requested_remote: Option<&str>,
    refresh: bool,
) -> Result<BranchList, WorkspaceError> {
    let (remote, remotes) = resolve_remote(git, project, requested_remote).await?;
    let mut fetched = false;
    let mut warning = None;
    // Each remembered value is read under its own short lock. `git fetch`
    // below waits on the network, and holding the AppState lock across it
    // would stall every other request for the duration of the fetch.
    let mut last_fetched = last_fetched_at(&state.lock().await.db, project_path);
    if refresh {
        match git.output(project, &["fetch", "--prune", &remote]).await {
            Ok(output) if output.success() => {
                fetched = true;
                last_fetched = record_fetch(&state.lock().await.db, project_path).or(last_fetched);
            }
            Ok(output) => {
                warning = Some(FetchWarning {
                    error_code: WORKSPACE_FETCH_FAILED,
                    message: fetch_message(&output.stderr),
                });
            }
            Err(error) => {
                warning = Some(FetchWarning {
                    error_code: WORKSPACE_FETCH_FAILED,
                    message: error.to_string(),
                });
            }
        }
    }
    let branches = cached_branches(git, project, &remote).await?;
    let default = default_branch(git, project, &remote).await;
    let last_used = last_source_branch(&state.lock().await.db, project_path)
        .filter(|branch| branches.iter().any(|listed| listed == branch));
    Ok(BranchList {
        remote,
        remotes,
        branches,
        default_branch: default,
        last_used_branch: last_used,
        fetched,
        last_fetched_at: last_fetched,
        warning,
    })
}

/// Keep the fetch failure readable without leaking a multi-line transcript.
fn fetch_message(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("git fetch failed");
    format!("could not fetch from the remote: {detail}")
}
