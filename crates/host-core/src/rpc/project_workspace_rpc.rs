//! `projectWorkspace.*` methods. Callers name a project or a workspace id; no
//! method accepts a workspace path, and every path in a result is produced by
//! host-core.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::project_workspaces::create::CreateInput;
use crate::project_workspaces::lifecycle::DeleteOptions;
use crate::project_workspaces::{
    branches, create, import, lifecycle, registry, repair, WorkspaceError,
};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::probe;
use crate::state::AppState;

/// Numeric JSON-RPC code shared by every `WORKSPACE_*` error; `data.errorCode`
/// carries the specific reason, as `worktree_rpc::to_rpc` does for `WORKTREE_*`.
const PROJECT_WORKSPACE_RPC_CODE: i64 = 1026;

pub(super) fn to_rpc(error: WorkspaceError) -> JsonRpcError {
    JsonRpcError {
        code: PROJECT_WORKSPACE_RPC_CODE,
        message: error.message,
        data: Some(json!({ "errorCode": error.code })),
    }
}

/// The shell environment of one tool call: the isolated-worktree variables of
/// an isolated session or its delegate (ADR 0329), else the project-workspace
/// variables of a workspace session, else nothing. At most one applies,
/// because `session.create` refuses a session that asks for both.
pub(super) fn session_tool_env(
    db: &crate::db::Database,
    session_id: &str,
    delegation_id: Option<&str>,
) -> Vec<(String, String)> {
    let isolated = crate::session_worktrees::delegate::tool_env(db, session_id, delegation_id);
    if isolated.is_empty() {
        lifecycle::tool_env(db, session_id)
    } else {
        isolated
    }
}

/// Code of a refusal to create a workspace in a remote-host project: its path
/// names a workspace on another machine, not a local git checkout.
pub(super) const REMOTE_UNSUPPORTED: &str = crate::project_workspaces::WORKSPACE_REMOTE_UNSUPPORTED;

/// Workspaces need a local checkout; remote-host projects run their tools on
/// the remote machine and are refused before anything is created.
fn ensure_local_project(db: &crate::db::Database, project_path: &str) -> Result<(), JsonRpcError> {
    let remote = db
        .remote_workspace_for_path(project_path)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if remote.is_some() {
        return Err(JsonRpcError {
            code: PROJECT_WORKSPACE_RPC_CODE,
            message: "this project runs on a remote host and has no local checkout".into(),
            data: Some(json!({ "errorCode": REMOTE_UNSUPPORTED })),
        });
    }
    Ok(())
}

fn str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{name} required"), "INVALID_PARAMS"))
}

fn bool_param(params: &Value, name: &str) -> bool {
    params
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or_default()
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let git = GitRunner::default();
    match method {
        // Every workspace of a project, for the sidebar tree.
        "projectWorkspace.list" => {
            let project = str_param(&params, "projectPath")?;
            let (rows, local) = {
                let st = state.lock().await;
                let rows = registry::for_project(&st.db, project)
                    .map_err(|error| to_rpc(WorkspaceError::from(error)))?;
                (rows, ensure_local_project(&st.db, project).is_ok())
            };
            // A project that was deleted and added again still has its
            // checkouts on disk; adopt them so its workspaces come back.
            let mut rows = if local && import::has_adoptable_dirs(project, &rows) {
                if let Err(error) = import::import_project(state, &git, project).await {
                    tracing::debug!(%error, "project workspace re-import skipped");
                }
                registry::for_project(&state.lock().await.db, project)
                    .map_err(|error| to_rpc(WorkspaceError::from(error)))?
            } else {
                rows
            };
            // A folder deleted while the app runs shows as missing now, not
            // only after the next start.
            if local {
                repair::mark_vanished(&state.lock().await.db, &mut rows).map_err(to_rpc)?;
            }
            let workspaces = rows.iter().map(registry::summary_of).collect::<Vec<_>>();
            Ok(json!({ "workspaces": workspaces }))
        }
        // Whether the project can host workspaces, plus its remotes. The
        // unavailable arm reuses the ADR 0329 `WORKTREE_*` probe codes: the git
        // requirements are the same ones that feature already probes for.
        "projectWorkspace.probe" => {
            let project = str_param(&params, "projectPath")?;
            if let Err(error) = ensure_local_project(&state.lock().await.db, project) {
                let data = error.data.unwrap_or_default();
                return Ok(json!({
                    "available": false,
                    "errorCode": data["errorCode"],
                    "message": error.message,
                }));
            }
            match probe::probe(&git, Path::new(project)).await {
                Ok(_) => {
                    let remotes = branches::remotes(&git, Path::new(project))
                        .await
                        .map_err(to_rpc)?;
                    let default = branches::default_remote(&remotes);
                    Ok(json!({
                        "available": true,
                        "remotes": remotes,
                        "defaultRemote": default,
                    }))
                }
                Err(error) => Ok(json!({
                    "available": false,
                    "errorCode": error.code(),
                    "message": error.to_string(),
                })),
            }
        }
        // The source-branch picker's data. Offline by default; `refresh` runs
        // `git fetch --prune` and degrades to the cached list with a warning.
        "projectWorkspace.branches" => {
            let project = str_param(&params, "projectPath")?;
            ensure_local_project(&state.lock().await.db, project)?;
            let remote = params
                .get("remote")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let refresh = bool_param(&params, "refresh");
            let list = branches::list(
                state,
                &git,
                Path::new(project),
                project,
                remote.as_deref(),
                refresh,
            )
            .await
            .map_err(to_rpc)?;
            serde_json::to_value(list).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "projectWorkspace.create" => {
            let project = str_param(&params, "projectPath")?.to_string();
            let name = params
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let source_branch = str_param(&params, "sourceBranch")?.to_string();
            let remote = params
                .get("remote")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let create_branch = bool_param(&params, "createBranch");
            let new_branch = params
                .get("newBranch")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            ensure_local_project(&state.lock().await.db, &project)?;
            let created = create::create(
                state,
                &git,
                &CreateInput {
                    project_path: project,
                    name,
                    remote,
                    source_branch,
                    create_branch,
                    new_branch,
                },
            )
            .await
            .map_err(to_rpc)?;
            serde_json::to_value(created).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        // What deleting the workspace would lose, for the confirmation dialog.
        "projectWorkspace.pendingWork" => {
            let workspace_id = str_param(&params, "workspaceId")?;
            let pending = lifecycle::pending_work(state, &git, workspace_id)
                .await
                .map_err(to_rpc)?;
            serde_json::to_value(pending).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "projectWorkspace.delete" => {
            let workspace_id = str_param(&params, "workspaceId")?.to_string();
            let outcome = lifecycle::delete(
                state,
                &git,
                &workspace_id,
                &DeleteOptions {
                    delete_branch: bool_param(&params, "deleteBranch"),
                    keep_folder: bool_param(&params, "keepFolder"),
                },
            )
            .await
            .map_err(to_rpc)?;
            serde_json::to_value(outcome).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        // Re-link a workspace after a project move, or re-create a checkout
        // whose folder vanished while its branch still exists.
        "projectWorkspace.repair" => {
            let workspace_id = str_param(&params, "workspaceId")?;
            let workspace = repair::repair(state, &git, workspace_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "workspace": workspace }))
        }
        "projectWorkspace.setupLog" => {
            let workspace_id = str_param(&params, "workspaceId")?;
            let st = state.lock().await;
            let row = registry::get(&st.db, workspace_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "setupStatus": row.as_ref().and_then(|row| row.setup_status),
                "log": row.and_then(|row| row.setup_log),
            }))
        }
        // The absolute path, for Electron main's shell reveal. host-core owns
        // the path; the caller never supplies one.
        "projectWorkspace.reveal" => {
            let workspace_id = str_param(&params, "workspaceId")?;
            let st = state.lock().await;
            let row = lifecycle::require_row(&st.db, workspace_id).map_err(to_rpc)?;
            Ok(json!({ "path": row.path }))
        }
        // The tool root of a workspace-bound session, for Electron main's
        // session launch and file tools. A session with no binding, or whose
        // checkout is gone, fails rather than falling back to the project.
        "projectWorkspace.location" => {
            let session_id = str_param(&params, "sessionId")?;
            let st = state.lock().await;
            match lifecycle::tool_root(&st.db, session_id).map_err(to_rpc)? {
                Some(root) => Ok(json!({ "path": root.to_string_lossy() })),
                None => Err(to_rpc(WorkspaceError::new(
                    crate::project_workspaces::WORKSPACE_NOT_FOUND,
                    "the session is not bound to a project workspace",
                ))),
            }
        }
        // Re-adopt `.pi/worktree/*` directories that are registered worktrees
        // of this repository but have no row, so a workspace survives
        // "delete project" followed by re-adding the project.
        "projectWorkspace.import" => {
            let project = str_param(&params, "projectPath")?;
            ensure_local_project(&state.lock().await.db, project)?;
            let imported = import::import_project(state, &git, project)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "workspaces": imported }))
        }
        other => Err(rpc_err(
            1001,
            format!("unknown method: {other}"),
            "METHOD_NOT_FOUND",
        )),
    }
}
