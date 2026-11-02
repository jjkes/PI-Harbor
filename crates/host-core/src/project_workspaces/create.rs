//! Creating a workspace at `<project>/.pi/worktree/<name>`.
//!
//! The order is deliberate: everything that can be rejected is rejected
//! before any directory exists, the managed `info/exclude` block is written
//! before `git worktree add` so no intermediate state is visible to
//! `git status`, and the registry row exists before the checkout so a crash
//! leaves a `creating` row for startup reconciliation instead of an
//! unrecorded directory.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::registry::{self, NewWorkspace, SetupStatus, WorkspaceRow, WorkspaceStatus};
use super::{
    exclude, lifecycle, validate_branch_name, validate_name, workspace_path, WorkspaceError,
    WORKSPACE_BRANCH_EXISTS, WORKSPACE_NAME_EXISTS, WORKSPACE_PATH_EXISTS,
    WORKSPACE_SOURCE_NOT_FOUND,
};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::include::{copy_included, IncludeReport};
use crate::session_worktrees::probe::probe;
use crate::session_worktrees::remove::is_real_dir;
use crate::session_worktrees::repo_lock;

/// Shared `Arc<Mutex<AppState>>`, as in `session_worktrees::lifecycle`.
pub type SharedState = crate::session_worktrees::lifecycle::SharedState;

#[derive(Debug, Clone)]
pub struct CreateInput {
    pub project_path: String,
    pub name: String,
    pub remote: Option<String>,
    pub source_branch: String,
    pub create_branch: bool,
    pub new_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkspace {
    pub workspace: registry::WorkspaceSummary,
    pub included: IncludeReport,
}

/// Which `git worktree add` variant the request resolves to (design §4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Checkout {
    /// `createBranch`: a new branch from the source, with no upstream.
    NewBranch { branch: String },
    /// The source branch has no local branch yet; create it tracking.
    TrackSource { branch: String },
    /// A local branch of the source name exists and is not checked out.
    ReuseLocal { branch: String },
}

impl Checkout {
    fn branch(&self) -> &str {
        match self {
            Checkout::NewBranch { branch }
            | Checkout::TrackSource { branch }
            | Checkout::ReuseLocal { branch } => branch,
        }
    }

    fn created_branch(&self) -> bool {
        matches!(self, Checkout::NewBranch { .. })
    }
}

/// Whether a local branch of that name exists.
pub(super) async fn local_branch_exists(
    git: &GitRunner,
    dir: &Path,
    branch: &str,
) -> Result<bool, WorkspaceError> {
    let output = git
        .output(
            dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await?;
    Ok(output.success())
}

/// Resolve the commit behind `refs/remotes/<remote>/<branch>`.
async fn resolve_source_commit(
    git: &GitRunner,
    dir: &Path,
    remote: &str,
    branch: &str,
) -> Result<String, WorkspaceError> {
    let reference = format!("refs/remotes/{remote}/{branch}");
    let output = git
        .output(
            dir,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{reference}^{{commit}}"),
            ],
        )
        .await?;
    if !output.success() || output.stdout.trim().is_empty() {
        return Err(WorkspaceError::new(
            WORKSPACE_SOURCE_NOT_FOUND,
            format!(
                "`{remote}/{branch}` is not a known remote-tracking branch; refresh the branch list"
            ),
        ));
    }
    Ok(output.stdout.trim().to_string())
}

/// Decide the checkout variant and reject the cases that cannot succeed.
async fn resolve_checkout(
    git: &GitRunner,
    project: &Path,
    input: &CreateInput,
) -> Result<Checkout, WorkspaceError> {
    if input.create_branch {
        let branch = input
            .new_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .ok_or_else(|| {
                WorkspaceError::new(
                    super::WORKSPACE_BRANCH_INVALID,
                    "a new branch needs a branch name",
                )
            })?
            .to_string();
        validate_branch_name(git, project, &branch).await?;
        // Checked before any directory exists. The branch is new, so it is
        // checked out nowhere else.
        if local_branch_exists(git, project, &branch).await? {
            return Err(WorkspaceError::new(
                WORKSPACE_BRANCH_EXISTS,
                format!("a local branch named `{branch}` already exists"),
            ));
        }
        return Ok(Checkout::NewBranch { branch });
    }

    // A branch may be checked out in several worktrees at once, so a branch
    // that the project or another workspace already has is reused as-is.
    let branch = input.source_branch.clone();
    if local_branch_exists(git, project, &branch).await? {
        Ok(Checkout::ReuseLocal { branch })
    } else {
        Ok(Checkout::TrackSource { branch })
    }
}

/// Create a workspace and start its setup command in the background.
/// On any failure after the row exists, the directory is removed link-safely
/// and the row is dropped.
pub async fn create(
    state: &SharedState,
    git: &GitRunner,
    input: &CreateInput,
) -> Result<CreatedWorkspace, WorkspaceError> {
    let project = Path::new(&input.project_path);
    let repo = probe(git, project).await?;
    let name = validate_name(&input.name)?;
    let (remote, _remotes) =
        super::branches::resolve_remote(git, project, input.remote.as_deref()).await?;
    let source_branch = input.source_branch.trim().to_string();
    validate_branch_name(git, project, &source_branch).await?;
    let source_commit = resolve_source_commit(git, project, &remote, &source_branch).await?;
    let checkout = resolve_checkout(git, project, input).await?;

    // Everything below runs with the repository serialized, and every
    // availability check is repeated inside the lock.
    let _guard = repo_lock::lock(&repo.common_dir).await;

    let project_id = {
        let st = state.lock().await;
        st.db.ensure_project(&input.project_path, false)?
    };
    let root = workspace_path(project, &name);
    {
        let st = state.lock().await;
        if registry::by_name(&st.db, project_id, &name)?.is_some() {
            return Err(WorkspaceError::new(
                WORKSPACE_NAME_EXISTS,
                format!("this project already has a workspace named `{name}`"),
            ));
        }
    }
    if std::fs::symlink_metadata(&root).is_ok() {
        return Err(WorkspaceError::new(
            WORKSPACE_PATH_EXISTS,
            format!("{} already exists", root.display()),
        ));
    }
    let branch = checkout.branch().to_string();
    if checkout.created_branch() && local_branch_exists(git, project, &branch).await? {
        return Err(WorkspaceError::new(
            WORKSPACE_BRANCH_EXISTS,
            format!("a local branch named `{branch}` already exists"),
        ));
    }

    // Before `git worktree add`, so the parent checkout never sees the new
    // directory as untracked.
    exclude::add_rule(&repo.common_dir, &repo.prefix)?;

    let parent = root
        .parent()
        .ok_or_else(|| WorkspaceError::internal("the workspace path has no parent"))?
        .to_path_buf();
    std::fs::create_dir_all(&parent)?;
    let root_text = root.to_string_lossy().into_owned();

    let row = {
        let st = state.lock().await;
        registry::insert(
            &st.db,
            &NewWorkspace {
                project_id,
                name: &name,
                path: &root_text,
                common_dir: &repo.common_dir.to_string_lossy(),
                prefix: &repo.prefix,
                branch: &branch,
                source_remote: &remote,
                source_branch: &source_branch,
                source_commit: &source_commit,
                created_branch: checkout.created_branch(),
            },
        )?
    };

    let materialized: Result<IncludeReport, WorkspaceError> = async {
        add_worktree(git, project, &checkout, &remote, &source_branch, &root_text).await?;
        // Locked immediately, so `git worktree prune` cannot discard it.
        git.run(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                &format!("PI-Desktop workspace {name}"),
                &root_text,
            ],
        )
        .await?;
        copy_included(git, &repo.toplevel, &root)
            .await
            .map_err(|error| WorkspaceError::new(error.code, error.message))
    }
    .await;

    let included = match materialized {
        Ok(included) => included,
        Err(error) => {
            discard_failed_creation(state, git, &row).await;
            return Err(error);
        }
    };

    let (row, command) = {
        let st = state.lock().await;
        registry::set_status(&st.db, &row.id, WorkspaceStatus::Active)?;
        super::branches::remember_source_branch(&st.db, &input.project_path, &source_branch);
        let command =
            crate::session_worktrees::lifecycle::setup_command(&st.db, &input.project_path)?;
        let status = if command.is_some() {
            SetupStatus::Running
        } else {
            SetupStatus::None
        };
        registry::set_setup_status(&st.db, &row.id, status, None)?;
        let row = registry::get(&st.db, &row.id)?.unwrap_or(row);
        (row, command)
    };
    if let Some(command) = command {
        tokio::spawn(lifecycle::run_setup(
            state.clone(),
            row.clone(),
            input.project_path.clone(),
            command,
        ));
    }
    let workspace = registry::summary_of(&row);
    Ok(CreatedWorkspace {
        workspace,
        included,
    })
}

/// The `git worktree add` variant of design §4.2.
async fn add_worktree(
    git: &GitRunner,
    project: &Path,
    checkout: &Checkout,
    remote: &str,
    source_branch: &str,
    root_text: &str,
) -> Result<(), WorkspaceError> {
    let source = format!("{remote}/{source_branch}");
    match checkout {
        // `--no-track` is deliberate: with default tracking the new branch's
        // upstream becomes the *source* remote branch, and `git push` then
        // fails with "upstream branch ... does not match the name of your
        // current branch". A new workspace branch starts with no upstream and
        // the user publishes it with `git push -u`.
        Checkout::NewBranch { branch } => {
            git.run(
                project,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "--no-track",
                    "-b",
                    branch,
                    root_text,
                    &source,
                ],
            )
            .await?;
        }
        Checkout::TrackSource { branch } => {
            git.run(
                project,
                &[
                    "worktree", "add", "-q", "--track", "-b", branch, root_text, &source,
                ],
            )
            .await?;
        }
        Checkout::ReuseLocal { branch } => {
            // `--force` is what lets the same branch be checked out in more
            // than one worktree: git refuses it by default ("already used by
            // worktree at ..."), and the branch then points at one commit for
            // every checkout, which is what "checked out twice" means.
            git.run(
                project,
                &["worktree", "add", "-q", "--force", root_text, branch],
            )
            .await?;
        }
    }
    Ok(())
}

/// Undo a failed creation. The `creating` row stays when cleanup itself
/// fails, so startup reconciliation retries it instead of leaving an
/// unrecorded directory and branch behind.
pub(super) async fn discard_failed_creation(
    state: &SharedState,
    git: &GitRunner,
    row: &WorkspaceRow,
) {
    match lifecycle::remove_checkout(git, row, false).await {
        Ok(_) => {
            let st = state.lock().await;
            if let Err(error) = registry::remove(&st.db, &row.id) {
                tracing::warn!(%error, "could not unregister a failed workspace creation");
            }
            if let Err(error) = lifecycle::prune_exclude_if_last(&st.db, row) {
                tracing::warn!(%error, "could not prune the workspace exclude block");
            }
        }
        Err(error) => {
            tracing::warn!(%error, path = %row.path, "could not clean up a failed workspace creation");
        }
    }
}

/// The workspace root of a path and prefix pair, for callers that only hold
/// the row. Kept here so the layout rule lives next to the creation flow.
pub fn root_of(row: &WorkspaceRow) -> PathBuf {
    let root = PathBuf::from(&row.path);
    if row.prefix.is_empty() {
        root
    } else {
        // `prefix` carries a trailing `/` (`git rev-parse --show-prefix`); a tool
        // root must not, or string comparisons against it drift from the
        // isolated-session roots of ADR 0329.
        root.join(row.prefix.trim_end_matches('/'))
    }
}

/// Whether the checkout (and the project directory inside it) is a real
/// directory chain, never a link.
pub fn root_is_real(row: &WorkspaceRow) -> bool {
    crate::session_worktrees::remove::is_real_dir_chain(Path::new(&row.path), &row.prefix)
}

/// Whether anything at all exists at the registered path.
pub fn path_exists(row: &WorkspaceRow) -> bool {
    is_real_dir(Path::new(&row.path))
}
