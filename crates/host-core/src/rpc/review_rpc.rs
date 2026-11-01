//! `review.fileDiff`: the net diff of one workspace file across the session's
//! recorded Write/Edit snapshots (see `review::file_diff`).
//!
//! The state lock is held only to resolve the session's root; snapshot reads,
//! hashing, and the line diff run on a blocking thread so a large file does not
//! stall unrelated host requests.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use super::{remote_tools, resolve_tool_workspace, rpc_err, JsonRpcError};
use crate::review;
use crate::state::AppState;

pub(super) async fn file_diff(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?
        .to_string();
    let snapshot_ids = params
        .get("snapshotIds")
        .and_then(Value::as_array)
        .ok_or_else(|| rpc_err(1002, "snapshotIds required", "INVALID_PARAMS"))?
        .iter()
        .map(|id| id.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| rpc_err(1002, "snapshotIds must be strings", "INVALID_PARAMS"))?;
    let (data_dir, workspace_root) = {
        let st = state.lock().await;
        // A remote workspace keeps no local snapshots, exactly as for rollback.
        if remote_tools::session_remote_workspace(&st, &session_id)?.is_some() {
            return Err(rpc_err(
                1002,
                "remote workspace review is unavailable",
                "CAPABILITY_UNAVAILABLE",
            ));
        }
        (
            st.data_dir.clone(),
            resolve_tool_workspace(&st, &session_id)?,
        )
    };
    let diff = tokio::task::spawn_blocking(move || {
        review::file_diff(
            &data_dir,
            &session_id,
            &snapshot_ids,
            workspace_root.as_deref().map(std::path::Path::new),
        )
    })
    .await
    .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
    .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    serde_json::to_value(diff).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}
