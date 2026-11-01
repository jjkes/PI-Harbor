//! Re-adopting on-disk checkouts that have no registry row.
//!
//! A workspace folder outlives its row when the project is deleted from the
//! sidebar and added again, so `.pi/worktree` is read again on demand (the
//! list method) and at startup: every directory that git still has registered
//! as a linked worktree of the project's repository gets its row back.

use std::path::{Path, PathBuf};

use super::create::SharedState;
use super::registry::{self, NewWorkspace, WorkspaceRow, WorkspaceStatus};
use super::{exclude, validate_name, WorkspaceError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::remove::is_real_dir;

/// Re-adopt directories under `<project>/.pi/worktree/` that are registered
/// linked worktrees of this repository but have no row. This is how a
/// workspace survives "delete project" followed by re-adding the project.
pub async fn import_project(
    state: &SharedState,
    git: &GitRunner,
    project_path: &str,
) -> Result<Vec<registry::WorkspaceSummary>, WorkspaceError> {
    let project = Path::new(project_path);
    let parent = project.join(super::WORKSPACE_DIR);
    if !is_real_dir(&parent) {
        return Ok(Vec::new());
    }
    let repo = match crate::session_worktrees::probe::probe(git, project).await {
        Ok(repo) => repo,
        // Not a usable git project: nothing to adopt.
        Err(_) => return Ok(Vec::new()),
    };
    let registered = registered_worktrees(git, project).await?;
    let project_id = {
        let st = state.lock().await;
        st.db.ensure_project(project_path, false)?
    };

    let mut adopted = Vec::new();
    let entries = match std::fs::read_dir(&parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if !is_real_dir(&entry.path()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(name) = validate_name(&name) else {
            continue;
        };
        let path = super::workspace_path(project, &name);
        let path_text = path.to_string_lossy().into_owned();
        let Some(branch) = matching_registration(&registered, &path) else {
            continue;
        };
        {
            let st = state.lock().await;
            if registry::by_path(&st.db, &path_text)?.is_some()
                || registry::by_name(&st.db, project_id, &name)?.is_some()
            {
                continue;
            }
        }
        // The repository must exclude it again: a re-added project has a
        // fresh `info/exclude` only if the user never removed it.
        exclude::add_rule(&repo.common_dir, &repo.prefix)?;
        let (source_remote, source_branch) = upstream_of(git, &path, &branch).await;
        let source_commit = git
            .output(
                &path,
                &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            )
            .await
            .map(|output| output.stdout.trim().to_string())
            .unwrap_or_default();
        let row = {
            let st = state.lock().await;
            let row = registry::insert(
                &st.db,
                &NewWorkspace {
                    project_id,
                    name: &name,
                    path: &path_text,
                    common_dir: &repo.common_dir.to_string_lossy(),
                    prefix: &repo.prefix,
                    branch: &branch,
                    source_remote: &source_remote,
                    source_branch: &source_branch,
                    source_commit: &source_commit,
                    // Never delete a branch this process did not create.
                    created_branch: false,
                },
            )?;
            registry::set_status(&st.db, &row.id, WorkspaceStatus::Active)?;
            registry::get(&st.db, &row.id)?.unwrap_or(row)
        };
        adopted.push(registry::summary_of(&row));
    }
    Ok(adopted)
}

/// Re-import for every registered project, as part of startup.
pub(super) async fn import_all(state: &SharedState, git: &GitRunner) {
    let projects = {
        let st = state.lock().await;
        let listed = st
            .db
            .conn()
            .prepare("SELECT path FROM projects")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            });
        listed.unwrap_or_default()
    };
    for project in projects {
        if let Err(error) = import_project(state, git, &project).await {
            tracing::warn!(%error, project = %project, "could not re-import project workspaces");
        }
    }
}

/// `(path, branch)` of every linked worktree git has registered.
async fn registered_worktrees(
    git: &GitRunner,
    project: &Path,
) -> Result<Vec<(PathBuf, String)>, WorkspaceError> {
    let listed = git
        .run(project, &["worktree", "list", "--porcelain"])
        .await?;
    let mut out = Vec::new();
    let mut path: Option<PathBuf> = None;
    for line in listed.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(value.trim()));
        } else if let Some(value) = line.strip_prefix("branch ") {
            if let (Some(current), Some(branch)) =
                (path.clone(), value.trim().strip_prefix("refs/heads/"))
            {
                out.push((current, branch.to_string()));
            }
        }
    }
    Ok(out)
}

/// Whether `.pi/worktree` holds a checkout that git still has registered but
/// the registry does not list: the state a project is in after "delete
/// project" followed by adding the same folder again.
///
/// Filesystem reads only, because `projectWorkspace.list` asks on every
/// sidebar refresh. A folder kept by "remove from list" does not count: its
/// admin entry was dropped, so the gitdir its `.git` file names is gone and a
/// re-import would not adopt it anyway.
pub fn has_adoptable_dirs(project_path: &str, rows: &[WorkspaceRow]) -> bool {
    let dir = Path::new(project_path).join(".pi").join("worktree");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        let Ok(name) = validate_name(&entry.file_name().to_string_lossy()) else {
            return false;
        };
        is_real_dir(&path)
            && !rows.iter().any(|row| row.name == name)
            && linked_gitdir(&path).is_some_and(|gitdir| gitdir.is_dir())
    })
}

/// The administrative directory a linked worktree's `.git` file points at.
fn linked_gitdir(checkout: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(checkout.join(".git")).ok()?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
    let target = Path::new(target.trim());
    Some(if target.is_absolute() {
        target.to_path_buf()
    } else {
        checkout.join(target)
    })
}

/// The branch of the registration whose path is `candidate`, comparing
/// resolved paths because git records the canonical form.
fn matching_registration(registered: &[(PathBuf, String)], candidate: &Path) -> Option<String> {
    let resolved = crate::workspace::simple_canonicalize(candidate).ok();
    registered.iter().find_map(|(path, branch)| {
        let same = path == candidate
            || resolved.as_deref().is_some_and(|resolved| path == resolved)
            || crate::workspace::simple_canonicalize(path)
                .ok()
                .as_deref()
                .is_some_and(|canonical| Some(canonical) == resolved.as_deref());
        same.then(|| branch.clone())
    })
}

/// `(remote, branch)` of the branch's upstream, or empty strings.
async fn upstream_of(git: &GitRunner, root: &Path, branch: &str) -> (String, String) {
    let Ok(output) = git
        .output(
            root,
            &[
                "for-each-ref",
                "--format=%(upstream:remotename)%09%(upstream:lstrip=3)",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await
    else {
        return (String::new(), String::new());
    };
    let line = output.stdout.trim();
    match line.split_once('\t') {
        Some((remote, upstream)) => (remote.to_string(), upstream.to_string()),
        None => (String::new(), String::new()),
    }
}
