//! `review.fileDiff` contract: the snapshot ids a workspace Write records in
//! its result are exactly what the diff request consumes.

use super::*;
use std::fs;

struct Fixture {
    _data: tempfile::TempDir,
    workspace: PathBuf,
    state: Arc<Mutex<AppState>>,
    session_id: String,
    // Kept alive so a notification the host sends during a call is buffered
    // instead of failing on a closed channel.
    tx: mpsc::UnboundedSender<String>,
    _rx: mpsc::UnboundedReceiver<String>,
}

async fn fixture() -> Fixture {
    let data = tempfile::tempdir().unwrap();
    // Canonical paths keep the symlink-aware resolver's comparisons simple on
    // macOS, where the temp dir lives behind /var -> /private/var.
    let data_dir = workspace::simple_canonicalize(data.path()).unwrap();
    let workspace = data_dir.join("project");
    fs::create_dir_all(&workspace).unwrap();
    let mut app = AppState::open(&data_dir).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, rx) = mpsc::unbounded_channel();
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({ "projectPath": workspace }),
        tx.clone(),
    )
    .await
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    handle_request(
        state.clone(),
        "session.configure",
        json!({ "id": session_id, "mode": "agent", "permissionMode": "auto" }),
        tx.clone(),
    )
    .await
    .unwrap();
    Fixture {
        _data: data,
        workspace,
        state,
        session_id,
        tx,
        _rx: rx,
    }
}

impl Fixture {
    /// Run a workspace Write through `tools.execute` and return the snapshot
    /// id its result recorded.
    async fn write(&self, call: &str, path: &str, content: &str) -> String {
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            handle_request(
                self.state.clone(),
                "tools.execute",
                json!({ "sessionId": self.session_id, "toolCallId": call, "toolName": "Write",
                    "args": { "path": path, "content": content }, "mode": "agent" }),
                self.tx.clone(),
            ),
        )
        .await
        .expect("an auto-mode workspace Write must not wait for approval")
        .unwrap();
        assert_eq!(result["ok"], true, "{result}");
        result["content"]["review"]["snapshotId"]
            .as_str()
            .unwrap_or_else(|| panic!("workspace Write recorded no review snapshot: {result}"))
            .to_string()
    }

    async fn file_diff(&self, params: Value) -> Result<Value, JsonRpcError> {
        handle_request(
            self.state.clone(),
            "review.fileDiff",
            params,
            self.tx.clone(),
        )
        .await
    }
}

#[tokio::test]
async fn file_diff_consumes_the_snapshot_ids_workspace_writes_record() {
    let f = fixture().await;
    let created = f.write("write-1", "notes.txt", "one\ntwo\n").await;
    let rewritten = f.write("write-2", "notes.txt", "one\nthree\n").await;
    let request = json!({ "sessionId": f.session_id, "snapshotIds": [created, rewritten] });

    let diff = f.file_diff(request.clone()).await.unwrap();
    // The file did not exist before the session, so the net change is the
    // whole current file, however many writes produced it.
    assert_eq!(diff["status"], "added", "{diff}");
    assert_eq!(diff["additions"], 2);
    assert_eq!(diff["deletions"], 0);
    assert_eq!(diff["binary"], false);
    assert_eq!(diff["truncated"], false);
    assert_eq!(diff["drifted"], false);
    assert!(!diff["hunks"].as_array().unwrap().is_empty());

    fs::write(f.workspace.join("notes.txt"), "edited by hand\n").unwrap();
    let drifted = f.file_diff(request).await.unwrap();
    assert_eq!(drifted["status"], "added", "{drifted}");
    assert_eq!(drifted["additions"], 1);
    assert_eq!(drifted["drifted"], true);
}

#[tokio::test]
async fn file_diff_rejects_malformed_requests_as_invalid_params() {
    let f = fixture().await;
    let id = f.session_id.clone();
    for params in [
        json!({ "sessionId": id }),
        json!({ "snapshotIds": ["a"] }),
        json!({ "sessionId": id, "snapshotIds": "a" }),
        json!({ "sessionId": id, "snapshotIds": [1] }),
        json!({ "sessionId": id, "snapshotIds": [] }),
        json!({ "sessionId": id, "snapshotIds": ["../escape"] }),
    ] {
        let error = f.file_diff(params.clone()).await.unwrap_err();
        assert_eq!(
            error.data.unwrap()["errorCode"],
            "INVALID_PARAMS",
            "{params}"
        );
    }
}
