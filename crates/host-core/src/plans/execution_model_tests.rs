use super::*;

const ENABLED_PROVIDER: &str = "plugin:fixture:execution";
const DISABLED_PROVIDER: &str = "disabled-provider";

fn insert_provider(db: &Database, id: &str, enabled: bool) {
    db.conn()
        .execute(
            "INSERT INTO providers (
                 id, name, enabled, owner_plugin_id, created_at, updated_at
             ) VALUES (?1, ?1, ?2, 'fixture.plugin', 1, 1)",
            params![id, if enabled { 1 } else { 0 }],
        )
        .unwrap();
}

fn resolve_params<'a>(
    root: &'a Path,
    proposal: &'a PlanProposal,
    action: &'a str,
    provider_id: Option<&'a str>,
    model_id: Option<&'a str>,
    thinking_level: Option<&'a str>,
) -> PlanResolveParams<'a> {
    PlanResolveParams {
        workspace_root: Some(root),
        proposal_id: &proposal.id,
        session_id: &proposal.session_id,
        turn_id: &proposal.turn_id,
        tool_call_id: &proposal.tool_call_id,
        version: Some(proposal.version),
        action,
        target_permission_mode: (action == "approve").then_some("accept-edits"),
        target_provider_id: provider_id,
        target_model_id: model_id,
        target_thinking_level: thinking_level,
    }
}

fn approve<'a>(
    root: &'a Path,
    proposal: &'a PlanProposal,
    provider_id: Option<&'a str>,
    model_id: Option<&'a str>,
    thinking_level: Option<&'a str>,
) -> PlanResolveParams<'a> {
    resolve_params(
        root,
        proposal,
        "approve",
        provider_id,
        model_id,
        thinking_level,
    )
}

fn set_session_model(db: &Database, proposal: &PlanProposal, thinking_level: &str) {
    db.conn()
        .execute(
            "UPDATE sessions
             SET provider_id = 'planning-provider', model_id = 'planning-model',
                 thinking_level = ?2
             WHERE id = ?1",
            params![proposal.session_id, thinking_level],
        )
        .unwrap();
}

fn stored_target_columns(
    db: &Database,
    proposal_id: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    db.conn()
        .query_row(
            "SELECT target_provider_id, target_model_id, target_thinking_level
             FROM plan_approvals WHERE request_id = ?1",
            params![proposal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn approval_audit(db: &Database, proposal_id: &str) -> serde_json::Value {
    let raw: String = db
        .conn()
        .query_row(
            "SELECT payload_json FROM audit_log
             WHERE kind = 'plan_approval_resolved' AND json_extract(payload_json, '$.proposalId') = ?1
             ORDER BY id DESC LIMIT 1",
            params![proposal_id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn targeted_approval_commits_and_projects_the_execution_model() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    insert_provider(&db, ENABLED_PROVIDER, true);
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "targeted-approval");
    set_session_model(&db, &proposal, "medium");

    let resolution = manager
        .resolve(
            &db,
            approve(
                &root,
                &proposal,
                Some(ENABLED_PROVIDER),
                Some("execution-model"),
                Some("low"),
            ),
        )
        .unwrap();
    let expected = PlanExecutionModel {
        provider_id: ENABLED_PROVIDER.into(),
        model_id: "execution-model".into(),
        thinking_level: Some("low".into()),
    };
    assert_eq!(resolution.target_model.as_ref(), Some(&expected));
    assert_eq!(resolution.proposal.target_model.as_ref(), Some(&expected));
    assert_eq!(
        resolution.execution.as_ref().unwrap().target_model.as_ref(),
        Some(&expected)
    );
    assert_eq!(
        manager.queued_executions(&db, None).unwrap()[0]
            .target_model
            .as_ref(),
        Some(&expected)
    );
    let history =
        history_for_tool_calls(&db, &proposal.session_id, &[&proposal.tool_call_id]).unwrap();
    assert_eq!(history[0].proposal.target_model.as_ref(), Some(&expected));

    let session = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(session.mode, "agent");
    assert_eq!(session.permission_mode, "accept-edits");
    assert_eq!(session.provider_id.as_deref(), Some(ENABLED_PROVIDER));
    assert_eq!(session.model_id.as_deref(), Some("execution-model"));
    assert_eq!(session.thinking_level, "low");
    assert_eq!(
        stored_target_columns(&db, &proposal.id),
        (
            Some(ENABLED_PROVIDER.into()),
            Some("execution-model".into()),
            Some("low".into())
        )
    );
    assert_eq!(
        approval_audit(&db, &proposal.id)["targetModel"],
        serde_json::to_value(&expected).unwrap()
    );

    let wire = serde_json::to_value(&resolution).unwrap();
    assert_eq!(
        wire["targetModel"],
        serde_json::to_value(&expected).unwrap()
    );
    assert_eq!(
        wire["proposal"]["targetModel"],
        serde_json::to_value(&expected).unwrap()
    );
    assert_eq!(
        wire["execution"]["targetModel"],
        serde_json::to_value(&expected).unwrap()
    );
}

#[test]
fn untargeted_approval_preserves_the_session_model_and_has_no_stored_target() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "untargeted-approval");
    set_session_model(&db, &proposal, "high");

    let resolution = manager
        .resolve(&db, approve(&root, &proposal, None, None, None))
        .unwrap();
    assert!(resolution.target_model.is_none());
    assert!(resolution.proposal.target_model.is_none());
    assert!(resolution
        .execution
        .as_ref()
        .unwrap()
        .target_model
        .is_none());
    let session = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(session.mode, "agent");
    assert_eq!(session.permission_mode, "accept-edits");
    assert_eq!(session.provider_id.as_deref(), Some("planning-provider"));
    assert_eq!(session.model_id.as_deref(), Some("planning-model"));
    assert_eq!(session.thinking_level, "high");
    assert_eq!(stored_target_columns(&db, &proposal.id), (None, None, None));
    assert!(approval_audit(&db, &proposal.id)["targetModel"].is_null());

    let wire = serde_json::to_value(&resolution).unwrap();
    assert!(wire["targetModel"].is_null());
    assert!(wire["proposal"].get("targetModel").is_none());
    assert!(wire["execution"].get("targetModel").is_none());
}

#[test]
fn invalid_targets_leave_the_approval_pending_and_the_session_unchanged() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    insert_provider(&db, ENABLED_PROVIDER, true);
    insert_provider(&db, DISABLED_PROVIDER, false);
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "invalid-targets");
    set_session_model(&db, &proposal, "high");
    let before = (sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary,);

    let cases = [
        approve(
            &root,
            &proposal,
            Some("unknown-provider"),
            Some("model"),
            None,
        ),
        approve(
            &root,
            &proposal,
            Some(DISABLED_PROVIDER),
            Some("model"),
            None,
        ),
        approve(&root, &proposal, Some("  "), Some("model"), None),
        approve(&root, &proposal, Some(ENABLED_PROVIDER), Some("\t"), None),
        approve(
            &root,
            &proposal,
            Some(ENABLED_PROVIDER),
            Some("model"),
            Some("ultra"),
        ),
        approve(&root, &proposal, Some(ENABLED_PROVIDER), None, None),
        approve(&root, &proposal, None, Some("model"), None),
        approve(
            &root,
            &proposal,
            Some("extension-agent:fixture"),
            Some("model"),
            None,
        ),
        resolve_params(
            &root,
            &proposal,
            "reject",
            Some(ENABLED_PROVIDER),
            Some("model"),
            Some("low"),
        ),
    ];

    for params in cases {
        assert_eq!(
            manager.resolve(&db, params).unwrap_err().to_string(),
            "PLAN_TARGET_MODEL_INVALID"
        );
        let current = get_proposal(&db, &proposal.id).unwrap().unwrap();
        assert_eq!(current.status, STATUS_PENDING);
        assert_eq!(current.version, proposal.version);
        assert!(current.action.is_none());
        assert!(current.target_model.is_none());
        assert_eq!(stored_target_columns(&db, &proposal.id), (None, None, None));
        let after = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap()
            .summary;
        assert_eq!(after.mode, before.0.mode);
        assert_eq!(after.permission_mode, before.0.permission_mode);
        assert_eq!(after.provider_id, before.0.provider_id);
        assert_eq!(after.model_id, before.0.model_id);
        assert_eq!(after.thinking_level, before.0.thinking_level);
    }
}

#[test]
fn targeted_replays_require_an_exact_target_but_allow_an_omitted_target() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    insert_provider(&db, ENABLED_PROVIDER, true);
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "targeted-replay");
    let first = manager
        .resolve(
            &db,
            approve(
                &root,
                &proposal,
                Some(ENABLED_PROVIDER),
                Some("model-one"),
                Some("low"),
            ),
        )
        .unwrap();
    let first_execution_id = first.execution.unwrap().id;

    // Provider validation is deliberately skipped for an idempotent replay.
    db.conn()
        .execute(
            "UPDATE providers SET enabled = 0 WHERE id = ?1",
            params![ENABLED_PROVIDER],
        )
        .unwrap();
    let same = manager
        .resolve(
            &db,
            approve(
                &root,
                &proposal,
                Some(ENABLED_PROVIDER),
                Some("model-one"),
                Some("low"),
            ),
        )
        .unwrap();
    assert_eq!(same.execution.unwrap().id, first_execution_id);
    let omitted = manager
        .resolve(&db, approve(&root, &proposal, None, None, None))
        .unwrap();
    assert_eq!(omitted.execution.unwrap().id, first_execution_id);

    for params in [
        approve(
            &root,
            &proposal,
            Some(ENABLED_PROVIDER),
            Some("model-one"),
            None,
        ),
        approve(
            &root,
            &proposal,
            Some(ENABLED_PROVIDER),
            Some("model-two"),
            Some("low"),
        ),
    ] {
        assert_eq!(
            manager.resolve(&db, params).unwrap_err().to_string(),
            "PLAN_APPROVAL_CONFLICT"
        );
    }

    insert_provider(&db, "null-thinking-provider", true);
    let null_thinking = submit(&manager, &db, &root, "null-thinking-replay");
    manager
        .resolve(
            &db,
            approve(
                &root,
                &null_thinking,
                Some("null-thinking-provider"),
                Some("model"),
                None,
            ),
        )
        .unwrap();
    manager
        .resolve(
            &db,
            approve(
                &root,
                &null_thinking,
                Some("null-thinking-provider"),
                Some("model"),
                None,
            ),
        )
        .unwrap();
    assert_eq!(
        manager
            .resolve(
                &db,
                approve(
                    &root,
                    &null_thinking,
                    Some("null-thinking-provider"),
                    Some("model"),
                    Some("low"),
                ),
            )
            .unwrap_err()
            .to_string(),
        "PLAN_APPROVAL_CONFLICT"
    );
}
