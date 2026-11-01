//! `session.create` tests for the workspace binding of schema v28.
//!
//! The binding is checked before the session row is inserted, so a refused
//! request must leave no session behind: a session whose bind failed would run
//! its tools in the project root while the caller believed it was in the
//! workspace. These go through `handle_request` so the RPC contract itself is
//! covered, not only the `project_workspaces` functions beneath it.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::handle_request;
use crate::project_workspaces::create::{create, CreateInput};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::sessions;
use crate::state::AppState;

struct Env {
    _dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
    project: String,
}

/// A git project cloned from a local bare "remote" with `main` published, plus
/// a handshook host state, so `session.create` runs its own parameter handling
/// instead of a stubbed one. Workspace creation resolves a remote, so a plain
/// `git init` project would be refused before the binding is ever reached.
async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin.git");
    let seed = init_repo(&dir.path().join("seed"));
    git_cmd(&seed, &["init", "-q", "--bare", &origin.to_string_lossy()]);
    git_cmd(
        &seed,
        &["remote", "add", "origin", &origin.to_string_lossy()],
    );
    git_cmd(&seed, &["push", "-q", "origin", "main"]);

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
    std::fs::create_dir_all(&data).unwrap();
    let mut app_state = AppState::open(&data).unwrap();
    app_state.handshook = true;
    Env {
        _dir: dir,
        state: Arc::new(Mutex::new(app_state)),
        tx: mpsc::unbounded_channel().0,
        project: project.to_string_lossy().into_owned(),
    }
}

impl Env {
    /// A workspace on a new branch off `main`; `main` itself stays checked out
    /// by the project.
    async fn workspace(&self, name: &str, branch: &str) -> String {
        create(
            &self.state,
            &GitRunner::default(),
            &CreateInput {
                project_path: self.project.clone(),
                name: name.to_string(),
                remote: None,
                source_branch: "main".to_string(),
                create_branch: true,
                new_branch: Some(branch.to_string()),
            },
        )
        .await
        .expect("the workspace is created")
        .workspace
        .id
    }

    async fn create_session(&self, params: Value) -> Result<Value, super::JsonRpcError> {
        handle_request(
            Arc::clone(&self.state),
            "session.create",
            params,
            self.tx.clone(),
        )
        .await
    }

    async fn session_count(&self) -> usize {
        sessions::list_sessions(&self.state.lock().await.db)
            .unwrap()
            .len()
    }
}

fn error_code(error: &super::JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn refuses_a_workspace_session_that_also_asks_to_be_isolated() {
    let env = env().await;
    let workspace = env.workspace("feat", "feat-branch").await;

    let error = env
        .create_session(json!({
            "title": "Both",
            "projectPath": env.project,
            "workspaceId": workspace,
            "isolated": true,
        }))
        .await
        .expect_err("the two forms of isolation are mutually exclusive");
    assert_eq!(error_code(&error), "WORKSPACE_ISOLATED_CONFLICT");

    // Refused before the row was inserted, so no half-bound session is left.
    assert_eq!(env.session_count().await, 0);
}

#[tokio::test]
async fn refuses_an_unknown_workspace_id_without_creating_a_session() {
    let env = env().await;

    let error = env
        .create_session(json!({
            "title": "Unknown",
            "projectPath": env.project,
            "workspaceId": "no-such-workspace",
        }))
        .await
        .expect_err("an unknown workspace id cannot be bound");
    assert_eq!(error_code(&error), "WORKSPACE_NOT_FOUND");

    // The alternative would be a session silently running in the project root.
    assert_eq!(env.session_count().await, 0);
}

#[tokio::test]
async fn creates_a_session_bound_to_its_workspace() {
    let env = env().await;
    let workspace = env.workspace("feat", "feat-branch").await;

    let result = env
        .create_session(json!({
            "title": "Bound",
            "projectPath": env.project,
            "workspaceId": workspace,
        }))
        .await
        .expect("a valid workspace id binds");

    // The reply carries the binding: the renderer groups the new session under
    // its workspace node from this field alone.
    let session = &result["session"];
    assert_eq!(session["workspaceId"].as_str(), Some(workspace.as_str()));
    let session_id = session["id"]
        .as_str()
        .expect("the session has an id")
        .to_string();

    // And the binding is persisted, not only reported.
    let st = env.state.lock().await;
    let bound = crate::project_workspaces::registry::session_ids(&st.db, &workspace).unwrap();
    assert_eq!(bound, vec![session_id]);
}
