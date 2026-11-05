//! `session.contextTranscript`: the lean transcript the session context viewer
//! replays (`sessions::context_transcript`). Main-private; the sidecar and
//! plugins have no route to it.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::sessions::{self, context_transcript};
use crate::state::AppState;
use crate::transcripts;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextTranscriptParams {
    id: String,
}

/// The state lock covers only the visibility check and the file read, under
/// the same lock every transcript writer holds, so the bytes are the snapshot
/// `session.get` would read. Parsing and projection happen after it is
/// released: a long session no longer stalls every other request.
pub(super) async fn context_transcript(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let ContextTranscriptParams { id } = serde_json::from_value(params)
        .map_err(|_| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let internal = |error: anyhow::Error| rpc_err(1000, error.to_string(), "INTERNAL");
    let (data_dir, bytes) = {
        let st = state.lock().await;
        if sessions::session_summary(&st.db, &id)
            .map_err(internal)?
            .is_none()
        {
            return Ok(json!({ "transcript": null }));
        }
        let data_dir = st.db.data_dir().to_path_buf();
        let bytes = transcripts::read_transcript_bytes(&data_dir, &id).map_err(internal)?;
        (data_dir, bytes)
    };
    let transcript = tokio::task::spawn_blocking(move || {
        context_transcript::context_transcript_from_bytes(&bytes, &data_dir, &id)
    })
    .await
    .map_err(|_| rpc_err(1000, "context transcript worker failed", "INTERNAL"))?
    .map_err(internal)?;
    Ok(json!({ "transcript": transcript }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::handle_request;
    use crate::sessions::UiMessage;
    use tokio::sync::mpsc;

    fn fixture() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
        let directory = tempfile::tempdir().unwrap();
        let mut state = AppState::open(directory.path()).unwrap();
        state.handshook = true;
        (directory, Arc::new(Mutex::new(state)))
    }

    async fn call(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
        handle_request(
            state,
            "session.contextTranscript",
            params,
            mpsc::unbounded_channel().0,
        )
        .await
    }

    fn row(value: Value) -> UiMessage {
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn returns_the_lean_rows_of_a_visible_session() {
        let (_directory, state) = fixture();
        let id = {
            let st = state.lock().await;
            let session = sessions::create_session(&st.db, None, None, None, None, None).unwrap();
            for message in [
                json!({ "id": "u1", "role": "user", "content": "Read it", "createdAt": "2026-11-05T00:00:01.000Z" }),
                json!({ "id": "t1", "role": "tool", "content": "", "createdAt": "2026-11-05T00:00:02.000Z",
                    "toolName": "Read", "toolCallId": "t1", "toolStatus": "success",
                    "toolResult": { "content": [{ "type": "text", "text": "TOOL-PAYLOAD" }] } }),
            ] {
                sessions::append_message(&st.db, &session.id, &row(message), None).unwrap();
            }
            session.id
        };
        let result = call(state, json!({ "id": id })).await.unwrap();
        let messages = &result["transcript"]["messages"];
        assert_eq!(messages[0]["content"], "Read it");
        assert_eq!(messages[1]["toolCallId"], "t1");
        assert!(!result.to_string().contains("TOOL-PAYLOAD"));
    }

    #[tokio::test]
    async fn answers_null_for_a_missing_or_deleted_session() {
        let (_directory, state) = fixture();
        let id = {
            let st = state.lock().await;
            let session = sessions::create_session(&st.db, None, None, None, None, None).unwrap();
            st.db
                .conn()
                .execute(
                    "UPDATE sessions SET deleted_at = 1 WHERE id = ?1",
                    [&session.id],
                )
                .unwrap();
            session.id
        };
        for id in [id.as_str(), "missing"] {
            let result = call(state.clone(), json!({ "id": id })).await.unwrap();
            assert_eq!(result, json!({ "transcript": null }), "{id}");
        }
    }

    #[tokio::test]
    async fn rejects_malformed_params() {
        let (_directory, state) = fixture();
        for params in [
            json!({}),
            json!({ "id": 1 }),
            json!({ "id": "a", "messageLimit": 5 }),
        ] {
            let error = call(state.clone(), params).await.unwrap_err();
            assert_eq!(error.code, 1002);
        }
    }
}
