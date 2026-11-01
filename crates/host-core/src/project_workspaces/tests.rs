//! Project-workspace tests against real temporary git repositories.
//!
//! Every repository is created under a `tempfile::TempDir` with its identity
//! in the repository config, so no test depends on the developer's global git
//! configuration and nothing outside the temporary directory is touched.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use super::create::{create, CreateInput, SharedState};
use super::lifecycle::{self, DeleteOptions};
use super::registry::{self, WorkspaceStatus};
use super::{exclude, import, relative_path, repair, validate_name, workspace_path, WORKSPACE_DIR};
use crate::session_worktrees::delegate::create_delegate_worktree;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::lifecycle::worktrees_dir;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::sessions;
use crate::state::AppState;

// ---- name validation (pure) -------------------------------------------------

#[test]
fn name_is_kept_verbatim_in_nfc() {
    // Not slugified: what the user types is what appears on disk.
    assert_eq!(validate_name("My Feature 2").unwrap(), "My Feature 2");
    assert_eq!(validate_name("feature-1_b").unwrap(), "feature-1_b");
    assert_eq!(validate_name("重构").unwrap(), "重构");

    // Decomposed "é" (e + U+0301) normalizes to the composed form, so two
    // visually identical names cannot produce two directories.
    let decomposed = "cafe\u{0301}";
    let composed = "caf\u{e9}";
    assert_ne!(decomposed, composed);
    assert_eq!(validate_name(decomposed).unwrap(), composed);
    assert_eq!(validate_name(composed).unwrap(), composed);
}

#[test]
fn name_rejects_everything_that_is_not_one_safe_segment() {
    let cases = [
        "",
        "a/b",
        "a\\b",
        "..",
        "a..b",
        ".hidden",
        "trailing ",
        " leading",
        "trailing.",
        "a:b",
        "a*b",
        "a?b",
        "a\"b",
        "a<b",
        "a>b",
        "a|b",
        "CON",
        "con.txt",
        "NUL",
        "lpt1",
        "with\u{0}null",
        "with\nnewline",
    ];
    for case in cases {
        let error = validate_name(case).unwrap_err_or_else(|| panic!("`{case}` must be rejected"));
        assert_eq!(error.code, "WORKSPACE_NAME_INVALID", "for `{case}`");
    }
    // 64 characters is the limit; 65 is not.
    assert!(validate_name(&"a".repeat(64)).is_ok());
    assert_eq!(
        validate_name(&"a".repeat(65)).unwrap_err().code,
        "WORKSPACE_NAME_INVALID"
    );
}

/// `Result::unwrap_err` needs `T: Debug`; `WorkspaceSummary` has it, but this
/// keeps the failure message pointing at the offending input.
trait UnwrapErrOrElse<T, E> {
    fn unwrap_err_or_else(self, on_ok: impl FnOnce() -> E) -> E;
}

impl<T, E> UnwrapErrOrElse<T, E> for Result<T, E> {
    fn unwrap_err_or_else(self, on_ok: impl FnOnce() -> E) -> E {
        match self {
            Ok(_) => on_ok(),
            Err(error) => error,
        }
    }
}

#[test]
fn paths_are_rooted_at_the_project() {
    assert_eq!(relative_path("feat"), ".pi/worktree/feat");
    assert_eq!(WORKSPACE_DIR, ".pi/worktree");
    assert_eq!(
        workspace_path(Path::new("/p"), "feat"),
        PathBuf::from("/p/.pi/worktree/feat")
    );
}

// ---- managed info/exclude block --------------------------------------------

#[test]
fn exclude_rule_is_anchored_at_the_project_prefix() {
    // Top level: anchored at the repository root.
    assert_eq!(exclude::rule_for(""), "/.pi/worktree/");
    // A project that is a repository subdirectory: anchored at that prefix, so
    // a sibling directory's `.pi/worktree` is not hidden.
    assert_eq!(
        exclude::rule_for("apps/desktop/"),
        "/apps/desktop/.pi/worktree/"
    );
}

#[test]
fn exclude_block_is_idempotent_and_preserves_user_lines() {
    let dir = tempfile::tempdir().unwrap();
    let common = dir.path().join(".git");
    fs::create_dir_all(common.join("info")).unwrap();
    let path = exclude::exclude_path(&common);
    fs::write(&path, "# user rule\nmy-scratch/\n").unwrap();

    exclude::add_rule(&common, "").unwrap();
    exclude::add_rule(&common, "").unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(
        text.matches("/.pi/worktree/").count(),
        1,
        "a second add must not duplicate the rule: {text}"
    );
    assert!(text.contains("my-scratch/"), "user lines survive: {text}");
    assert_eq!(exclude::rules(&common), vec!["/.pi/worktree/".to_string()]);

    // A second project prefix in the same repository adds its own rule.
    exclude::add_rule(&common, "sub/").unwrap();
    assert_eq!(exclude::rules(&common).len(), 2);

    exclude::remove_rule(&common, "").unwrap();
    assert_eq!(
        exclude::rules(&common),
        vec!["/sub/.pi/worktree/".to_string()]
    );

    exclude::remove_rule(&common, "sub/").unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(exclude::rules(&common).is_empty());
    assert!(
        text.contains("my-scratch/"),
        "user lines survive removal: {text}"
    );
}

// ---- integration harness ----------------------------------------------------

struct Env {
    _dir: tempfile::TempDir,
    state: SharedState,
    git: GitRunner,
    project: PathBuf,
    origin: PathBuf,
}

/// A project cloned from a local bare "remote" with `main` and `feature/one`
/// published, so remote-tracking refs exist without any network.
async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin.git");
    let seed = init_repo(&dir.path().join("seed"));
    git_cmd(&seed, &["checkout", "-q", "-b", "feature/one"]);
    fs::write(seed.join("feature.txt"), "one\n").unwrap();
    git_cmd(&seed, &["add", "feature.txt"]);
    git_cmd(&seed, &["commit", "-q", "-m", "feature"]);
    git_cmd(&seed, &["checkout", "-q", "main"]);
    git_cmd(&seed, &["init", "-q", "--bare", &origin.to_string_lossy()]);
    git_cmd(
        &seed,
        &["remote", "add", "origin", &origin.to_string_lossy()],
    );
    git_cmd(&seed, &["push", "-q", "origin", "main", "feature/one"]);

    let project = dir.path().join("project");
    git_cmd(
        dir.path(),
        &[
            "clone",
            "-q",
            &origin.to_string_lossy(),
            &project.to_string_lossy(),
        ],
    );
    git_cmd(&project, &["config", "user.name", "PI Test"]);
    git_cmd(
        &project,
        &["config", "user.email", "pi-test@example.invalid"],
    );
    git_cmd(&project, &["config", "commit.gpgsign", "false"]);

    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let state = Arc::new(Mutex::new(AppState::open(&data).unwrap()));
    Env {
        _dir: dir,
        state,
        git: GitRunner::default(),
        project,
        origin,
    }
}

fn input(env: &Env, name: &str, source: &str) -> CreateInput {
    CreateInput {
        project_path: env.project.to_string_lossy().into_owned(),
        name: name.to_string(),
        remote: None,
        source_branch: source.to_string(),
        create_branch: false,
        new_branch: None,
    }
}

async fn session_in(env: &Env, workspace_id: Option<&str>) -> String {
    let st = env.state.lock().await;
    let session = sessions::create_session_with_options(
        &st.db,
        sessions::SessionCreateOptions {
            title: Some("Workspace session".into()),
            mode: None,
            provider_id: None,
            model_id: None,
            project_path: Some(env.project.to_string_lossy().into_owned()),
            thinking_level: None,
            permission_mode: None,
        },
    )
    .unwrap()
    .id;
    if let Some(id) = workspace_id {
        lifecycle::bind_session(&st.db, &session, id).unwrap();
    }
    session
}

fn status_is_clean(project: &Path) -> bool {
    git_cmd(project, &["status", "--porcelain"])
        .trim()
        .is_empty()
}

// ---- creation ---------------------------------------------------------------

#[tokio::test]
async fn creates_a_workspace_from_a_remote_branch_without_dirtying_the_project() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .expect("create succeeds");

    assert_eq!(created.workspace.name, "feat");
    assert_eq!(created.workspace.relative_path, ".pi/worktree/feat");
    assert_eq!(created.workspace.branch, "feature/one");
    assert_eq!(created.workspace.source_remote, "origin");
    assert_eq!(created.workspace.status, WorkspaceStatus::Active);
    assert!(!created.workspace.created_branch);

    // The checkout exists at the requested in-project location and carries the
    // source branch's file.
    let root = workspace_path(&env.project, "feat");
    assert!(root.join("feature.txt").is_file(), "source branch content");

    // The parent checkout stays clean: the managed `info/exclude` block hides
    // the nested checkout from `git status`.
    assert!(
        status_is_clean(&env.project),
        "parent status: {}",
        git_cmd(&env.project, &["status", "--porcelain"])
    );
    let common = env.project.join(".git");
    assert_eq!(exclude::rules(&common), vec!["/.pi/worktree/".to_string()]);

    // Locked, so `git worktree prune` cannot discard it.
    let list = git_cmd(&env.project, &["worktree", "list", "--porcelain"]);
    assert!(list.contains("locked"), "worktree must be locked: {list}");
}

#[tokio::test]
async fn new_branch_starts_without_an_upstream() {
    let env = env().await;
    let mut request = input(&env, "spike", "main");
    request.create_branch = true;
    request.new_branch = Some("feat/spike".into());
    let created = create(&env.state, &env.git, &request)
        .await
        .expect("create succeeds");
    assert_eq!(created.workspace.branch, "feat/spike");
    assert!(created.workspace.created_branch);

    // `--no-track`: with default tracking the upstream would be the *source*
    // remote branch and `git push` would fail with an upstream-name mismatch.
    let root = workspace_path(&env.project, "spike");
    let upstream = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--abbrev-ref", "feat/spike@{upstream}"])
        .output()
        .unwrap();
    assert!(
        !upstream.status.success(),
        "a new workspace branch must have no upstream, got {}",
        String::from_utf8_lossy(&upstream.stdout)
    );
}

#[tokio::test]
async fn rejects_a_duplicate_name_and_a_branch_already_checked_out() {
    let env = env().await;
    create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();

    // Source `main` on a fresh branch: the checkout itself is valid (`main` is
    // checked out by the project, but a new branch from it is not), so the
    // only refusal left is the name collision.
    let mut same_name = input(&env, "feat", "main");
    same_name.create_branch = true;
    same_name.new_branch = Some("feat-again".into());
    let duplicate = create(&env.state, &env.git, &same_name)
        .await
        .expect_err("the name is taken");
    assert_eq!(duplicate.code, "WORKSPACE_NAME_EXISTS");

    // `feature/one` is now checked out in the first workspace.
    let in_use = create(&env.state, &env.git, &input(&env, "other", "feature/one"))
        .await
        .expect_err("the branch is in use");
    assert_eq!(in_use.code, "WORKSPACE_BRANCH_IN_USE");

    // The project's own branch is checked out in the main worktree.
    let project_branch = create(&env.state, &env.git, &input(&env, "main-copy", "main"))
        .await
        .expect_err("main is checked out by the project");
    assert_eq!(project_branch.code, "WORKSPACE_BRANCH_IN_USE");

    // A new branch whose name already exists locally is a different refusal.
    let mut existing = input(&env, "dup-branch", "main");
    existing.create_branch = true;
    existing.new_branch = Some("feature/one".into());
    let error = create(&env.state, &env.git, &existing)
        .await
        .expect_err("the branch exists");
    assert_eq!(error.code, "WORKSPACE_BRANCH_EXISTS");
}

#[tokio::test]
async fn rejects_an_unknown_source_branch_and_an_invalid_name() {
    let env = env().await;
    let missing = create(&env.state, &env.git, &input(&env, "feat", "no/such/branch"))
        .await
        .expect_err("unknown source");
    assert_eq!(missing.code, "WORKSPACE_SOURCE_NOT_FOUND");

    let bad_name = create(&env.state, &env.git, &input(&env, "a/b", "main"))
        .await
        .expect_err("invalid name");
    assert_eq!(bad_name.code, "WORKSPACE_NAME_INVALID");
    assert!(
        !env.project.join(".pi").exists(),
        "a rejected request must not create any directory"
    );
}

// ---- session root resolution ------------------------------------------------

#[tokio::test]
async fn a_workspace_session_resolves_to_the_workspace_and_a_project_session_does_not() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();

    let bound = session_in(&env, Some(&created.workspace.id)).await;
    let unbound = session_in(&env, None).await;

    let st = env.state.lock().await;
    let root = lifecycle::tool_root(&st.db, &bound).unwrap().unwrap();
    assert_eq!(root, workspace_path(&env.project, "feat"));
    // A project session is not a workspace session: the caller falls through
    // to the project path.
    assert!(lifecycle::tool_root(&st.db, &unbound).unwrap().is_none());
}

#[tokio::test]
async fn a_vanished_workspace_fails_its_sessions_instead_of_using_the_project_root() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let session = session_in(&env, Some(&created.workspace.id)).await;

    // The user deleted the folder behind the app's back.
    fs::remove_dir_all(workspace_path(&env.project, "feat")).unwrap();

    let st = env.state.lock().await;
    let error = lifecycle::tool_root(&st.db, &session)
        .expect_err("a missing workspace must fail, not fall back");
    assert_eq!(error.code, "WORKSPACE_MISSING");
}

/// A workspace session is not an isolated session: it has no `worktrees` row
/// to branch a delegate from, so a subagent that asks for its own worktree is
/// refused. Nothing may appear next to the workspace inside the project's
/// `.pi/worktree/`, and nothing in the data directory's worktrees folder
/// either.
#[tokio::test]
async fn a_workspace_session_is_refused_a_delegate_worktree() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let session = session_in(&env, Some(&created.workspace.id)).await;

    let error = create_delegate_worktree(&env.state, &env.git, &session, "delegation-1")
        .await
        .expect_err("a workspace session has no isolated worktree to branch from");
    assert_eq!(error.code, "WORKTREE_NOT_ISOLATED");

    // The workspace directory still holds only the workspace itself.
    let workspace_dir = workspace_path(&env.project, "feat");
    let parent = workspace_dir.parent().expect("the workspace has a parent");
    let mut siblings: Vec<String> = fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    siblings.sort();
    assert_eq!(siblings, vec!["feat".to_string()]);

    // And the isolated-session area was never touched.
    let data_dir = env.state.lock().await.data_dir.clone();
    assert!(!worktrees_dir(&data_dir).exists());
    assert!(status_is_clean(&env.project));
}

// ---- deletion ---------------------------------------------------------------

#[tokio::test]
async fn delete_removes_the_checkout_and_keeps_the_branch_by_default() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let root = workspace_path(&env.project, "feat");

    let outcome = lifecycle::delete(
        &env.state,
        &env.git,
        &created.workspace.id,
        &DeleteOptions::default(),
    )
    .await
    .expect("delete succeeds");
    assert!(outcome.removed);
    assert!(!outcome.branch_deleted, "the branch is kept by default");
    assert!(!root.exists(), "the checkout is gone");

    let branches = git_cmd(&env.project, &["branch", "--list", "feature/one"]);
    assert!(
        branches.contains("feature/one"),
        "branch survives: {branches}"
    );

    let st = env.state.lock().await;
    assert!(registry::get(&st.db, &created.workspace.id)
        .unwrap()
        .is_none());
    // Last workspace of this prefix: the managed block is pruned again.
    assert!(exclude::rules(&env.project.join(".git")).is_empty());
}

#[tokio::test]
async fn delete_can_keep_the_folder_or_delete_the_branch() {
    let env = env().await;

    // keepFolder: the row goes, the directory stays, and git no longer tracks
    // it as a worktree of this repository.
    let keep = create(&env.state, &env.git, &input(&env, "keep", "feature/one"))
        .await
        .unwrap();
    let keep_root = workspace_path(&env.project, "keep");
    let outcome = lifecycle::delete(
        &env.state,
        &env.git,
        &keep.workspace.id,
        &DeleteOptions {
            keep_folder: true,
            ..DeleteOptions::default()
        },
    )
    .await
    .unwrap();
    assert!(outcome.folder_kept);
    assert!(keep_root.is_dir(), "the folder stays on disk");
    let list = git_cmd(&env.project, &["worktree", "list", "--porcelain"]);
    assert!(
        !list.contains("keep"),
        "the checkout is unregistered: {list}"
    );

    // deleteBranch on a workspace that created its own branch.
    let mut request = input(&env, "spike", "main");
    request.create_branch = true;
    request.new_branch = Some("feat/spike".into());
    let spike = create(&env.state, &env.git, &request).await.unwrap();
    let outcome = lifecycle::delete(
        &env.state,
        &env.git,
        &spike.workspace.id,
        &DeleteOptions {
            delete_branch: true,
            ..DeleteOptions::default()
        },
    )
    .await
    .unwrap();
    assert!(outcome.branch_deleted);
    let branches = git_cmd(&env.project, &["branch", "--list", "feat/spike"]);
    assert!(branches.trim().is_empty(), "branch deleted: {branches}");
}

#[tokio::test]
async fn delete_also_removes_the_workspace_sessions() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let session = session_in(&env, Some(&created.workspace.id)).await;

    let outcome = lifecycle::delete(
        &env.state,
        &env.git,
        &created.workspace.id,
        &DeleteOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.sessions_removed, 1);

    let st = env.state.lock().await;
    assert!(
        sessions::session_summary(&st.db, &session)
            .unwrap()
            .is_none(),
        "the workspace's sessions are deleted with it"
    );
}

// ---- re-import --------------------------------------------------------------

#[tokio::test]
async fn re_import_readopts_a_registered_checkout_with_no_row() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();

    // Simulate "delete project": the rows cascade away while the checkout and
    // git's registration stay on disk.
    {
        let st = env.state.lock().await;
        registry::remove(&st.db, &created.workspace.id).unwrap();
        assert!(
            registry::for_project(&st.db, &env.project.to_string_lossy())
                .unwrap()
                .is_empty()
        );
    }

    let adopted = import::import_project(&env.state, &env.git, &env.project.to_string_lossy())
        .await
        .expect("import succeeds");
    assert_eq!(adopted.len(), 1);
    assert_eq!(adopted[0].name, "feat");
    assert_eq!(adopted[0].branch, "feature/one");
    // Never delete a branch the app did not create.
    assert!(!adopted[0].created_branch);

    // A second pass is a no-op: the row now exists.
    let again = import::import_project(&env.state, &env.git, &env.project.to_string_lossy())
        .await
        .unwrap();
    assert!(again.is_empty(), "re-import is idempotent");
}

#[tokio::test]
async fn a_forked_workspace_session_stays_in_its_workspace() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let workspace_id = created.workspace.id.clone();
    let source = session_in(&env, Some(workspace_id.as_str())).await;

    let st = env.state.lock().await;
    let forked = sessions::fork_session_through(&st.db, &source, None, None).unwrap();
    assert!(
        matches!(forked, sessions::ForkSessionResult::Created(_)),
        "the fork is created"
    );

    // The fork keeps the binding: it runs in the same checkout and is listed
    // under the same workspace node instead of moving to the project root.
    let bound = registry::session_ids(&st.db, &workspace_id).unwrap();
    assert_eq!(bound.len(), 2, "source and fork are both in the workspace");
    let fork = bound.iter().find(|id| **id != source).unwrap();
    let root = lifecycle::tool_root(&st.db, &source).unwrap();
    assert!(root.is_some());
    assert_eq!(lifecycle::tool_root(&st.db, fork).unwrap(), root);
}

#[tokio::test]
async fn a_kept_folder_keeps_the_parent_exclude_rule() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "keep", "feature/one"))
        .await
        .unwrap();
    let keep = DeleteOptions {
        delete_branch: false,
        keep_folder: true,
    };
    lifecycle::delete(&env.state, &env.git, &created.workspace.id, &keep)
        .await
        .unwrap();

    // No workspace is listed any more, but the checkout's files are still under
    // `.pi/worktree`: the parent must keep ignoring them, or `git add -A` would
    // stage the folder as an embedded repository.
    assert!(workspace_path(&env.project, "keep").is_dir());
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");

    // Once the folder is gone, deleting the last workspace prunes the rule.
    fs::remove_dir_all(workspace_path(&env.project, "keep")).unwrap();
    let again = create(&env.state, &env.git, &input(&env, "again", "feature/one"))
        .await
        .unwrap();
    lifecycle::delete(
        &env.state,
        &env.git,
        &again.workspace.id,
        &DeleteOptions::default(),
    )
    .await
    .unwrap();
    assert!(exclude::rules(&env.project.join(".git")).is_empty());
}

#[tokio::test]
async fn re_import_ignores_a_directory_git_does_not_know() {
    let env = env().await;
    // A plain directory under `.pi/worktree/` is not a registered worktree of
    // this repository and must not become a workspace.
    let stray = workspace_path(&env.project, "stray");
    fs::create_dir_all(stray.join("src")).unwrap();
    fs::write(stray.join("src/main.rs"), "fn main() {}\n").unwrap();

    let adopted = import::import_project(&env.state, &env.git, &env.project.to_string_lossy())
        .await
        .unwrap();
    assert!(
        adopted.is_empty(),
        "an unregistered directory is not adopted"
    );
    assert!(stray.is_dir(), "and it is left alone");
    let _ = env.origin;
}

#[tokio::test]
async fn a_folder_deleted_while_running_is_listed_as_missing() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    fs::remove_dir_all(workspace_path(&env.project, "feat")).unwrap();

    let st = env.state.lock().await;
    let project = env.project.to_string_lossy();
    let mut rows = registry::for_project(&st.db, &project).unwrap();
    repair::mark_vanished(&st.db, &mut rows).unwrap();
    assert_eq!(rows[0].status, WorkspaceStatus::Missing);
    // The stored row agrees with what the sidebar is told.
    let stored = registry::get(&st.db, &created.workspace.id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, WorkspaceStatus::Missing);
}

#[tokio::test]
async fn repair_checks_a_vanished_folder_out_again_from_its_branch() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let root = workspace_path(&env.project, "feat");
    fs::remove_dir_all(&root).unwrap();

    let repaired = repair::repair(&env.state, &env.git, &created.workspace.id)
        .await
        .unwrap();
    assert_eq!(repaired.status, WorkspaceStatus::Active);
    assert!(root.join(".git").is_file(), "the checkout is back");
    assert_eq!(
        git_cmd(&root, &["symbolic-ref", "--short", "HEAD"]).trim(),
        "feature/one"
    );
    // Locked again, so `git worktree prune` cannot discard it, and still
    // ignored by the parent checkout.
    let listed = git_cmd(&env.project, &["worktree", "list", "--porcelain"]);
    assert!(listed.contains("locked"), "{listed}");
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
}

/// Repair restores the local files `.worktreeinclude` selects, so a re-created
/// checkout is as usable as a freshly created one.
#[tokio::test]
async fn repair_copies_the_included_files_into_the_recreated_checkout() {
    let env = env().await;
    // `.worktreeinclude` only copies files git already ignores, so `.env` is
    // ignored and stays untracked while the two rule files are committed.
    fs::write(env.project.join(".gitignore"), ".env\n").unwrap();
    fs::write(env.project.join(".worktreeinclude"), ".env\n").unwrap();
    git_cmd(&env.project, &["add", ".gitignore", ".worktreeinclude"]);
    git_cmd(&env.project, &["commit", "-q", "-m", "include rules"]);
    fs::write(env.project.join(".env"), "TOKEN=1\n").unwrap();

    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    assert_eq!(created.included.copied, vec![".env"], "copied on create");
    let root = workspace_path(&env.project, "feat");
    assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "TOKEN=1\n");

    fs::remove_dir_all(&root).unwrap();
    let repaired = repair::repair(&env.state, &env.git, &created.workspace.id)
        .await
        .unwrap();

    assert_eq!(repaired.status, WorkspaceStatus::Active);
    assert_eq!(
        fs::read_to_string(root.join(".env")).unwrap(),
        "TOKEN=1\n",
        "the included file is back with its content"
    );
    assert_eq!(git_cmd(&env.project, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn repair_refuses_to_recreate_a_checkout_whose_branch_is_gone() {
    let env = env().await;
    let mut spike = input(&env, "spike", "main");
    spike.create_branch = true;
    spike.new_branch = Some("feat/spike".into());
    let created = create(&env.state, &env.git, &spike).await.unwrap();
    let root = workspace_path(&env.project, "spike");
    fs::remove_dir_all(&root).unwrap();
    // `update-ref` deletes the branch even though the vanished checkout still
    // has it registered as checked out.
    git_cmd(&env.project, &["update-ref", "-d", "refs/heads/feat/spike"]);

    let error = repair::repair(&env.state, &env.git, &created.workspace.id)
        .await
        .expect_err("there is nothing to check out");
    assert_eq!(error.code, "WORKSPACE_REPAIR_FAILED");
    assert!(!root.exists(), "nothing is created");
}

#[tokio::test]
async fn create_remembers_the_source_branch_for_the_next_dialog() {
    let env = env().await;
    let project_path = env.project.to_string_lossy().into_owned();
    let before = super::branches::list(
        &env.state,
        &env.git,
        &env.project,
        &project_path,
        None,
        false,
    )
    .await
    .unwrap();
    let before = serde_json::to_value(&before).unwrap();
    assert!(before["lastUsedBranch"].is_null(), "{before}");

    create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();

    let after = super::branches::list(
        &env.state,
        &env.git,
        &env.project,
        &project_path,
        None,
        false,
    )
    .await
    .unwrap();
    let after = serde_json::to_value(&after).unwrap();
    // The create dialog pre-selects the branch this project's last workspace
    // was created from.
    assert_eq!(after["lastUsedBranch"], "feature/one");
}

// ---- running sessions, reconciliation, project moves ------------------------

/// §4.11: deletion is refused while any session of the workspace is running,
/// and the `pendingWork` summary the confirmation dialog shows reports what
/// the deletion would lose.
#[tokio::test]
async fn delete_is_refused_while_a_workspace_session_is_running() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let session = session_in(&env, Some(&created.workspace.id)).await;
    let root = workspace_path(&env.project, "feat");
    // Work the dialog has to warn about before the folder is removed.
    fs::write(root.join("scratch.txt"), "wip\n").unwrap();
    {
        let st = env.state.lock().await;
        sessions::begin_turn(&st.db, &session, None, None).unwrap();
    }

    let pending = lifecycle::pending_work(&env.state, &env.git, &created.workspace.id)
        .await
        .expect("pending work is readable");
    assert_eq!(pending.sessions, 1);
    assert_eq!(pending.running_sessions, 1);
    assert!(pending.git_readable, "{pending:?}");
    assert!(pending.uncommitted_changes, "{pending:?}");

    let error = lifecycle::delete(
        &env.state,
        &env.git,
        &created.workspace.id,
        &DeleteOptions::default(),
    )
    .await
    .expect_err("a running session blocks the delete");
    assert_eq!(error.code, "WORKSPACE_HAS_RUNNING_SESSIONS");

    // The refused request destroyed nothing: neither the checkout, nor the
    // row, nor the session it would have deleted.
    assert!(root.is_dir(), "the checkout survives");
    let st = env.state.lock().await;
    assert!(registry::get(&st.db, &created.workspace.id)
        .unwrap()
        .is_some());
    assert!(sessions::session_summary(&st.db, &session)
        .unwrap()
        .is_some());
}

/// §4.11 startup reconciliation: a row left in `creating` by a crash is rolled
/// back with its directory, and a row whose folder vanished becomes `missing`
/// instead of staying `active`.
#[tokio::test]
async fn startup_reconciliation_rolls_back_creating_rows_and_marks_a_vanished_root_missing() {
    let env = env().await;
    let crashed = create(&env.state, &env.git, &input(&env, "half", "feature/one"))
        .await
        .unwrap();
    let mut gone_input = input(&env, "gone", "main");
    gone_input.create_branch = true;
    gone_input.new_branch = Some("feat/gone".into());
    let gone = create(&env.state, &env.git, &gone_input).await.unwrap();

    // The crash shape: the row still says `creating` after the process died.
    {
        let st = env.state.lock().await;
        registry::set_status(&st.db, &crashed.workspace.id, WorkspaceStatus::Creating).unwrap();
    }
    // And this one's folder was deleted behind the app's back.
    fs::remove_dir_all(workspace_path(&env.project, "gone")).unwrap();

    repair::reconcile(env.state.clone(), env.git.clone()).await;

    let st = env.state.lock().await;
    assert!(
        registry::get(&st.db, &crashed.workspace.id)
            .unwrap()
            .is_none(),
        "a `creating` row is rolled back"
    );
    assert!(
        !workspace_path(&env.project, "half").exists(),
        "and its half-created checkout is discarded"
    );
    let vanished = registry::get(&st.db, &gone.workspace.id).unwrap().unwrap();
    assert_eq!(
        vanished.status,
        WorkspaceStatus::Missing,
        "a vanished root is reported as missing, not active"
    );
}

/// §4.11 project move: the stored path is recomputed from the project's new
/// location and `git worktree repair` is given explicit paths, so both
/// directions of the link work again and the bound session follows.
#[tokio::test]
async fn a_moved_project_recomputes_its_workspace_path_and_relinks_git() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    let session = session_in(&env, Some(&created.workspace.id)).await;
    let (project_id, before_path) = {
        let st = env.state.lock().await;
        let row = registry::get(&st.db, &created.workspace.id)
            .unwrap()
            .unwrap();
        (row.project_id, row.path)
    };

    // The user moved the project folder: the registered gitdir and the
    // checkout's `.git` file now point at a location that no longer exists.
    let moved = env.project.parent().unwrap().join("moved-project");
    fs::rename(&env.project, &moved).unwrap();
    {
        let st = env.state.lock().await;
        let moved_text = moved.to_string_lossy().into_owned();
        st.db
            .conn()
            .execute(
                "UPDATE projects SET path = ?1 WHERE id = ?2",
                rusqlite::params![moved_text, project_id],
            )
            .unwrap();
    }

    let repaired = repair::repair(&env.state, &env.git, &created.workspace.id)
        .await
        .expect("repair relinks the moved checkout");
    assert_eq!(repaired.status, WorkspaceStatus::Active);

    let expected = fs::canonicalize(workspace_path(&moved, "feat")).unwrap();
    let root = {
        let st = env.state.lock().await;
        let row = registry::get(&st.db, &created.workspace.id)
            .unwrap()
            .unwrap();
        assert_ne!(row.path, before_path, "the stored path was recomputed");
        assert_eq!(fs::canonicalize(&row.path).unwrap(), expected);
        assert_eq!(
            fs::canonicalize(&row.common_dir).unwrap(),
            fs::canonicalize(moved.join(".git")).unwrap()
        );
        // A session's root is derived, not stored, so it moves with the row.
        assert_eq!(
            fs::canonicalize(lifecycle::tool_root(&st.db, &session).unwrap().unwrap()).unwrap(),
            expected
        );
        PathBuf::from(row.path)
    };

    // The checkout resolves its repository again, and the repository lists the
    // checkout at its new path.
    assert_eq!(
        git_cmd(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "feature/one"
    );
    let listed = git_cmd(&moved, &["worktree", "list", "--porcelain"]);
    assert!(
        listed.contains(&root.to_string_lossy().to_string()),
        "the repository points at the moved checkout: {listed}"
    );
}

/// Repair re-checks the recorded branch out and re-copies the
/// `.worktreeinclude` paths like create, but it does not re-run the project's
/// setup command.
#[tokio::test]
async fn repair_does_not_rerun_the_setup_command() {
    let env = env().await;
    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .unwrap();
    assert_eq!(
        created.workspace.setup_status,
        Some(registry::SetupStatus::None),
        "this project has no setup command when the workspace is created"
    );

    // Configured only now, so a setup run during repair would be visible both
    // as a status change and as a file on disk.
    let project_path = env.project.to_string_lossy().into_owned();
    let marker = env.project.join("setup-ran.txt");
    {
        let st = env.state.lock().await;
        let stored = crate::session_worktrees::lifecycle::set_setup_command(
            &st.db,
            &project_path,
            Some(&format!("echo ran > {}", marker.to_string_lossy())),
        )
        .unwrap();
        assert!(
            stored,
            "the project is registered, so the command is stored"
        );
    }

    let root = workspace_path(&env.project, "feat");
    fs::remove_dir_all(&root).unwrap();
    let repaired = repair::repair(&env.state, &env.git, &created.workspace.id)
        .await
        .unwrap();

    assert_eq!(repaired.status, WorkspaceStatus::Active);
    assert!(root.join(".git").is_file(), "the checkout is back");
    assert_eq!(
        repaired.setup_status,
        Some(registry::SetupStatus::None),
        "repair must not put the workspace back into `running` setup"
    );
    assert!(!marker.exists(), "the setup command must not run again");
}

// ---- setup command ----------------------------------------------------------

/// Register the project and store its `worktree_setup_command`: `create` reads
/// that column through `session_worktrees::lifecycle::setup_command`, and the
/// update only lands once the project row exists.
async fn set_setup(env: &Env, command: &str) {
    let project_path = env.project.to_string_lossy().into_owned();
    let st = env.state.lock().await;
    st.db.ensure_project(&project_path, false).unwrap();
    assert!(
        crate::session_worktrees::lifecycle::set_setup_command(
            &st.db,
            &project_path,
            Some(command)
        )
        .unwrap(),
        "the project is registered, so the command is stored"
    );
}

/// Poll the row until the background setup task leaves `running`, like
/// `wait_for_setup` in the isolated-worktree tests.
async fn wait_for_setup(env: &Env, id: &str) -> registry::WorkspaceRow {
    for _ in 0..600 {
        let row = registry::get(&env.state.lock().await.db, id)
            .unwrap()
            .expect("the workspace row outlives its setup run");
        if row.setup_status != Some(registry::SetupStatus::Running) {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("setup did not finish");
}

/// The setup command runs in the default command shell, which is PowerShell on
/// Windows and bash elsewhere, so each command is written per dialect.
fn default_shell_is_powershell() -> bool {
    crate::tools::shell::dialect_for_id(crate::tools::shell::default_shell_id())
        == Some("powershell")
}

/// Creation returns while setup is still running; the background run then ends
/// in `ok` with the command's output in the bounded log tail.
#[tokio::test]
async fn the_setup_command_runs_after_the_workspace_is_created() {
    let env = env().await;
    // `echo` prints the same way in sh, cmd and PowerShell.
    set_setup(&env, "echo workspace-setup-ok").await;

    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .expect("create succeeds");
    assert_eq!(
        created.workspace.setup_status,
        Some(registry::SetupStatus::Running),
        "create must not wait for the setup command"
    );

    let row = wait_for_setup(&env, &created.workspace.id).await;
    assert_eq!(
        row.setup_status,
        Some(registry::SetupStatus::Ok),
        "{:?}",
        row.setup_log
    );
    assert!(
        row.setup_log
            .as_deref()
            .is_some_and(|log| log.contains("workspace-setup-ok")),
        "the command's output is kept: {:?}",
        row.setup_log
    );
}

/// A non-zero exit ends in `failed` with the output kept, and leaves the
/// workspace itself active.
#[tokio::test]
async fn a_failing_setup_command_is_recorded_without_failing_the_workspace() {
    let env = env().await;
    let failing = if default_shell_is_powershell() {
        "[Console]::Error.WriteLine('workspace-setup-broken'); exit 3"
    } else {
        "echo workspace-setup-broken >&2; exit 3"
    };
    set_setup(&env, failing).await;

    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .expect("create succeeds");
    let row = wait_for_setup(&env, &created.workspace.id).await;

    assert_eq!(
        row.setup_status,
        Some(registry::SetupStatus::Failed),
        "{:?}",
        row.setup_log
    );
    assert!(
        row.setup_log
            .as_deref()
            .is_some_and(|log| log.contains("workspace-setup-broken")),
        "the failure output is kept: {:?}",
        row.setup_log
    );
    assert_eq!(
        row.status,
        WorkspaceStatus::Active,
        "a setup failure must not take the workspace out of service"
    );
}

/// `PI_WORKSPACE_ROOT` names the workspace root, and the command runs there:
/// the relative redirect lands inside the new checkout.
#[cfg(unix)]
#[tokio::test]
async fn the_setup_command_sees_the_workspace_root() {
    let env = env().await;
    set_setup(&env, "printf %s \"$PI_WORKSPACE_ROOT\" > root.txt").await;

    let created = create(&env.state, &env.git, &input(&env, "feat", "feature/one"))
        .await
        .expect("create succeeds");
    let row = wait_for_setup(&env, &created.workspace.id).await;
    assert_eq!(
        row.setup_status,
        Some(registry::SetupStatus::Ok),
        "{:?}",
        row.setup_log
    );

    let root = workspace_path(&env.project, "feat");
    let exported = fs::read_to_string(root.join("root.txt")).expect("written in the workspace");
    assert_eq!(
        fs::canonicalize(&exported).unwrap(),
        fs::canonicalize(&root).unwrap(),
        "PI_WORKSPACE_ROOT was `{exported}`"
    );
}
