//! `tools.execute` under an access profile (ADR 0344): the pure narrowing
//! rules, then the RPC entry with a real session, workspace, and audit log.

use super::*;
use std::fs;

struct Fixture {
    _data_dir: tempfile::TempDir,
    project: PathBuf,
    outside: PathBuf,
    mode: String,
    state: Arc<Mutex<AppState>>,
    session_id: String,
}

/// A session in `mode` under `permission_mode`, with a note inside the
/// project and a secret next to the project, outside the workspace.
fn fixture(mode: &str, permission_mode: &str) -> Fixture {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    let outside = data_dir.path().join("outside");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        project.join("src").join("notes.txt"),
        "needle in the workspace\n",
    )
    .unwrap();
    fs::write(outside.join("secret.txt"), "needle outside the workspace\n").unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Read-only profile".into()),
        Some(mode.into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        mode,
        None,
        None,
        None,
        Some(permission_mode),
    )
    .unwrap();
    Fixture {
        _data_dir: data_dir,
        project,
        outside,
        mode: mode.to_string(),
        state: Arc::new(Mutex::new(app_state)),
        session_id: session.id,
    }
}

/// One profiled `tools.execute` request.
fn call(fx: &Fixture, tool_call_id: &str, tool_name: &str, args: Value) -> Value {
    json!({
        "sessionId": fx.session_id,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "args": args,
        "mode": fx.mode,
        "accessProfile": "read-only"
    })
}

/// Runs one request and returns its result with every notification it
/// emitted. A call that waits for a permission decision never returns, so
/// the timeout turns a stray prompt into a failure.
async fn execute(fx: &Fixture, request: Value) -> (Result<Value, JsonRpcError>, Vec<String>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        handle_request(fx.state.clone(), "tools.execute", request, tx),
    )
    .await
    .expect("a profiled call waited for a permission decision");
    let mut notifications = Vec::new();
    while let Ok(text) = rx.try_recv() {
        notifications.push(text);
    }
    (result, notifications)
}

fn error_code_of(error: &JsonRpcError) -> Value {
    error
        .data
        .as_ref()
        .map_or(Value::Null, |data| data["errorCode"].clone())
}

async fn audit_payloads(fx: &Fixture, kind: &str) -> Vec<Value> {
    let st = fx.state.lock().await;
    let mut statement = st
        .db
        .conn()
        .prepare("SELECT payload_json FROM audit_log WHERE kind = ?1 ORDER BY id")
        .unwrap();
    let mut payloads: Vec<Value> = Vec::new();
    for row in statement
        .query_map([kind], |row| row.get::<_, String>(0))
        .unwrap()
    {
        payloads.push(serde_json::from_str(&row.unwrap()).unwrap());
    }
    payloads
}

fn params(extra: Value) -> ToolsExecuteParams {
    let mut request = json!({
        "sessionId": "session-1",
        "toolCallId": "call-1",
        "toolName": "Read",
        "args": {},
        "mode": "agent"
    });
    if let (Some(request), Some(extra)) = (request.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            request.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(request).unwrap()
}

#[test]
fn absent_profile_leaves_the_call_unchanged() {
    assert_eq!(parse(&params(json!({}))).unwrap(), None);
}

#[test]
fn read_only_profile_parses_alone_and_rejects_conflicts() {
    assert_eq!(
        parse(&params(json!({ "accessProfile": "read-only" }))).unwrap(),
        Some(AccessProfile::ReadOnly)
    );
    for extra in [
        json!({ "accessProfile": "" }),
        json!({ "accessProfile": "READ-ONLY" }),
        json!({ "accessProfile": "read-only", "fileBatchTicket": "ticket-1" }),
        json!({ "accessProfile": "read-only", "delegationId": "delegate-1" }),
        json!({ "accessProfile": "read-only", "permissionScope": "inherit" }),
        json!({ "accessProfile": "read-only", "runInBackground": true }),
    ] {
        let error = parse(&params(extra.clone())).unwrap_err();
        assert_eq!(error_code_of(&error), "INVALID_PARAMS", "{extra}");
    }
}

#[test]
fn narrowing_denies_instead_of_prompting_and_never_grants() {
    use crate::permissions::PermissionDecision::{AllowOnce, AllowSession, Deny};
    let read_only = Some(AccessProfile::ReadOnly);
    // Without a profile every decision passes through, prompts included.
    for auto in [None, Some(AllowOnce), Some(AllowSession), Some(Deny)] {
        assert_eq!(narrow_auto_decision(None, "Bash", true, auto.clone()), auto);
    }
    let cases = [
        ("Read", false, Some(AllowOnce), Some(AllowOnce)),
        ("Grep", false, Some(AllowSession), Some(AllowOnce)),
        ("Glob", false, None, Some(Deny)),
        ("Read", false, Some(Deny), Some(Deny)),
        ("Read", true, Some(AllowOnce), Some(Deny)),
        ("Read", true, Some(AllowSession), Some(Deny)),
        ("Write", false, Some(AllowOnce), Some(Deny)),
    ];
    for (tool_name, external, auto, expected) in cases {
        assert_eq!(
            narrow_auto_decision(read_only, tool_name, external, auto.clone()),
            expected,
            "{tool_name} external={external} auto={auto:?}"
        );
    }
}

#[test]
fn denial_codes_name_the_reason() {
    let read_only = Some(AccessProfile::ReadOnly);
    assert_eq!(denial_code(None, "Write", true), None);
    assert_eq!(denial_code(read_only, "Read", false), None);
    assert_eq!(
        denial_code(read_only, "Bash", false),
        Some("TOOL_DISABLED_IN_READ_ONLY")
    );
    // An unlisted tool is reported as such even when its path is external.
    assert_eq!(
        denial_code(read_only, "Write", true),
        Some("TOOL_DISABLED_IN_READ_ONLY")
    );
    assert_eq!(
        denial_code(read_only, "Glob", true),
        Some("EXTERNAL_PATH_DISABLED_IN_READ_ONLY")
    );
}

#[test]
fn audit_rows_record_the_profile_only_when_present() {
    let mut payload = json!({ "toolName": "Read" });
    annotate_audit(&mut payload, None);
    assert!(payload.get("accessProfile").is_none());
    annotate_audit(&mut payload, Some(AccessProfile::ReadOnly));
    assert_eq!(payload["accessProfile"], "read-only");
}

#[tokio::test]
async fn read_only_profile_runs_read_glob_and_grep_inside_the_workspace_without_prompting() {
    // `ask` prompts for writes and external paths; profiled reads never ask.
    let fx = fixture("agent", "ask");
    let calls = [
        ("read-inside", "Read", json!({ "path": "src/notes.txt" })),
        ("glob-inside", "Glob", json!({ "pattern": "**/*.txt" })),
        ("grep-inside", "Grep", json!({ "pattern": "needle" })),
    ];
    for (tool_call_id, tool_name, args) in calls {
        let (result, notifications) = execute(&fx, call(&fx, tool_call_id, tool_name, args)).await;
        let result = result.unwrap();
        assert_eq!(result["ok"], true, "{tool_name} failed: {result}");
        assert!(notifications.is_empty(), "{tool_name}: {notifications:?}");
    }
    let executed = audit_payloads(&fx, "tool_execute").await;
    assert_eq!(executed.len(), 3);
    assert!(executed
        .iter()
        .all(|row| row["accessProfile"] == "read-only"));
}

#[tokio::test]
async fn read_only_profile_denies_every_other_tool_before_it_runs() {
    // `auto` would run every one of these; the profile cannot be widened.
    let fx = fixture("agent", "auto");
    let calls = [
        (
            "write",
            "Write",
            json!({ "path": "created.txt", "content": "no" }),
        ),
        (
            "edit",
            "Edit",
            json!({ "path": "src/notes.txt", "tag": "ABCD", "ops": "PUT 1.=1:\n+changed\n" }),
        ),
        (
            "bash",
            "Bash",
            json!({ "command": "echo changed > created.txt" }),
        ),
        ("image", "GenerateImages", json!({ "prompt": "a cat" })),
        ("plugin", "plugin_demo_run", json!({})),
        ("mcp", "mcp_demo_tool", json!({})),
        ("unknown", "UnknownTool", json!({})),
    ];
    let expected = calls.len();
    for (tool_call_id, tool_name, args) in calls {
        let (result, notifications) = execute(&fx, call(&fx, tool_call_id, tool_name, args)).await;
        let result = result.unwrap();
        assert_eq!(result["ok"], false, "{tool_name} ran: {result}");
        assert_eq!(result["denied"], true, "{tool_name}: {result}");
        assert_eq!(result["errorCode"], "TOOL_DISABLED_IN_READ_ONLY");
        assert_eq!(result["content"]["code"], "TOOL_DISABLED_IN_READ_ONLY");
        assert!(notifications.is_empty(), "{tool_name}: {notifications:?}");
    }
    assert!(!fx.project.join("created.txt").exists());
    assert_eq!(
        fs::read_to_string(fx.project.join("src").join("notes.txt")).unwrap(),
        "needle in the workspace\n"
    );
    let denied = audit_payloads(&fx, "tool_denied").await;
    assert_eq!(denied.len(), expected);
    assert!(denied
        .iter()
        .all(|row| row["accessProfile"] == "read-only" && row["mode"] == "agent"));
    assert!(audit_payloads(&fx, "tool_execute").await.is_empty());
}

#[tokio::test]
async fn read_only_profile_denies_external_paths_in_every_permission_mode() {
    for permission_mode in ["ask", "accept-edits", "auto"] {
        let fx = fixture("agent", permission_mode);
        let secret = fx.outside.join("secret.txt").to_string_lossy().into_owned();
        let outside = fx.outside.to_string_lossy().into_owned();
        let calls = [
            ("read-outside", "Read", json!({ "path": secret })),
            (
                "glob-outside",
                "Glob",
                json!({ "path": outside.clone(), "pattern": "**/*" }),
            ),
            (
                "grep-outside",
                "Grep",
                json!({ "path": outside, "pattern": "needle" }),
            ),
        ];
        for (tool_call_id, tool_name, args) in calls {
            let (result, notifications) =
                execute(&fx, call(&fx, tool_call_id, tool_name, args)).await;
            let result = result.unwrap();
            assert_eq!(
                result["ok"], false,
                "{tool_name} under {permission_mode}: {result}"
            );
            assert_eq!(result["errorCode"], "EXTERNAL_PATH_DISABLED_IN_READ_ONLY");
            assert!(
                notifications.is_empty(),
                "{tool_name} under {permission_mode}: {notifications:?}"
            );
        }
        let denied = audit_payloads(&fx, "tool_denied").await;
        assert_eq!(denied.len(), 3, "{permission_mode}");
        assert!(denied.iter().all(
            |row| row["accessProfile"] == "read-only" && row["externalPathPermission"] == true
        ));
    }
}

#[tokio::test]
async fn read_only_profile_ignores_session_grants_for_external_paths() {
    let fx = fixture("agent", "ask");
    fx.state
        .lock()
        .await
        .session_grants
        .insert(fx.session_id.clone(), vec!["Read".to_string()]);
    let secret = fx.outside.join("secret.txt").to_string_lossy().into_owned();

    // Control: without the profile the session grant admits the external read.
    let mut granted = call(
        &fx,
        "read-granted",
        "Read",
        json!({ "path": secret.clone() }),
    );
    if let Some(request) = granted.as_object_mut() {
        request.remove("accessProfile");
    }
    let (result, notifications) = execute(&fx, granted).await;
    let result = result.unwrap();
    assert_eq!(result["ok"], true, "the grant did not apply: {result}");
    assert!(notifications.is_empty(), "{notifications:?}");

    let profiled = call(&fx, "read-profiled", "Read", json!({ "path": secret }));
    let (result, notifications) = execute(&fx, profiled).await;
    let result = result.unwrap();
    assert_eq!(
        result["ok"], false,
        "the grant widened the profile: {result}"
    );
    assert_eq!(result["errorCode"], "EXTERNAL_PATH_DISABLED_IN_READ_ONLY");
    assert!(notifications.is_empty(), "{notifications:?}");
}

#[tokio::test]
async fn read_only_profile_reads_the_session_scratch_directory() {
    let fx = fixture("agent", "ask");
    let scratch_dir = {
        let st = fx.state.lock().await;
        scratch::session_dir(&st.data_dir, &fx.session_id).unwrap()
    };
    fs::create_dir_all(&scratch_dir).unwrap();
    let note = scratch_dir.join("note.txt");
    fs::write(&note, "scratch note\n").unwrap();
    let request = call(
        &fx,
        "read-scratch",
        "Read",
        json!({ "path": note.to_string_lossy() }),
    );
    let (result, notifications) = execute(&fx, request).await;
    let result = result.unwrap();
    assert_eq!(result["ok"], true, "scratch read failed: {result}");
    assert!(notifications.is_empty(), "{notifications:?}");
}

#[tokio::test]
async fn read_only_profile_rejects_unknown_values_and_conflicting_fields() {
    let fx = fixture("agent", "auto");
    let mut unknown = call(
        &fx,
        "unknown-profile",
        "Read",
        json!({ "path": "src/notes.txt" }),
    );
    unknown["accessProfile"] = json!("write");
    let mut requests = vec![unknown];
    for (field, value) in [
        ("fileBatchTicket", json!("ticket-1")),
        ("delegationId", json!("delegate-1")),
        ("permissionScope", json!("inherit")),
        ("runInBackground", json!(true)),
    ] {
        let mut request = call(&fx, field, "Read", json!({ "path": "src/notes.txt" }));
        request[field] = value;
        requests.push(request);
    }
    for request in requests {
        let (result, notifications) = execute(&fx, request.clone()).await;
        let Err(error) = result else {
            panic!("an invalid profiled call was accepted: {request}");
        };
        assert_eq!(error_code_of(&error), "INVALID_PARAMS", "{request}");
        assert!(error.message.contains("accessProfile"), "{}", error.message);
        assert!(notifications.is_empty(), "{notifications:?}");
    }
    assert!(audit_payloads(&fx, "tool_execute").await.is_empty());
    assert!(audit_payloads(&fx, "tool_denied").await.is_empty());
}

#[tokio::test]
async fn read_only_profile_narrows_contract_modes_without_widening_them() {
    // Plan admits Bash under `auto`; the profile does not.
    let fx = fixture("plan", "auto");
    let request = call(&fx, "plan-read", "Read", json!({ "path": "src/notes.txt" }));
    let (result, notifications) = execute(&fx, request).await;
    let result = result.unwrap();
    assert_eq!(result["ok"], true, "plan read failed: {result}");
    assert!(notifications.is_empty(), "{notifications:?}");
    for (tool_call_id, tool_name, args) in [
        (
            "plan-bash",
            "Bash",
            json!({ "command": "printf plan-bash" }),
        ),
        (
            "plan-write",
            "Write",
            json!({ "path": "created.txt", "content": "no" }),
        ),
    ] {
        let (result, notifications) = execute(&fx, call(&fx, tool_call_id, tool_name, args)).await;
        let result = result.unwrap();
        assert_eq!(
            result["errorCode"], "TOOL_DISABLED_IN_READ_ONLY",
            "{tool_name}: {result}"
        );
        assert!(notifications.is_empty(), "{notifications:?}");
    }
    assert!(!fx.project.join("created.txt").exists());
}
