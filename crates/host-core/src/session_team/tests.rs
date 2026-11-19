use rusqlite::params;
use serde_json::json;

use super::*;
use crate::{db::now_ms, sessions};

fn session(db: &Database, title: &str) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

#[test]
fn v26_migration_preserves_sessions_and_adds_team_storage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let session_id;
    {
        let db = Database::open(&path).unwrap();
        session_id = session(&db, "Existing session");
        db.conn()
            .execute_batch("DROP TABLE session_team; PRAGMA user_version=26;")
            .unwrap();
    }

    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    // A v26 file walks every later step in the same launch.
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    assert_eq!(crate::db::SCHEMA_VERSION, 31);
    assert!(crate::db::migration_backup_path(&path, 26).exists());
    assert!(repository::session_exists(db.conn(), &session_id).unwrap());
    assert_eq!(get(&db, &session_id).unwrap(), empty_config(&session_id));
}

#[test]
fn missing_row_defaults_to_disabled_empty_revision_zero() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Defaults");

    let value = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(
        value,
        json!({
            "sessionId": session_id,
            "enabled": false,
            "members": [],
            "revision": 0
        })
    );
    assert!(get(&db, "missing")
        .unwrap_err()
        .to_string()
        .starts_with("NOT_FOUND"));
}

#[test]
fn agent_normalization_matches_shared_separator_semantics() {
    assert_eq!(normalize_agent_name("_Agent Name__.MD"), "-agent-name-");
    assert_eq!(normalize_agent_name("a\u{2003}b"), "a-b");
    assert_eq!(normalize_agent_name("a\u{0085}b"), "a\u{0085}b");
    assert_eq!(normalize_agent_name("folder\\agent.md/"), "agent");
}

#[test]
fn set_normalizes_roundtrips_and_supports_partial_updates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session_id = session(&db, "Roundtrip");
    let created = handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "members": [
                {"agent": "agents\\Fixer.MD"},
                {
                    "agent": " Explorer  One ",
                    "model": {"providerId": "anthropic", "modelId": "claude-sonnet-4-5"}
                }
            ]
        }),
    )
    .unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(created["enabled"], true);
    assert_eq!(created["members"][0]["agent"], "fixer");
    assert_eq!(created["members"][1]["agent"], "explorer-one");
    assert_eq!(
        created["members"][1]["model"],
        json!({"providerId": "anthropic", "modelId": "claude-sonnet-4-5"})
    );

    let updated = handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 1,
            "enabled": false
        }),
    )
    .unwrap();
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["enabled"], false);
    assert_eq!(updated["members"], created["members"]);
    let roster: String = db
        .conn()
        .query_row(
            "SELECT roster_json FROM session_team WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    let roster: Value = serde_json::from_str(&roster).unwrap();
    assert_eq!(roster["version"], 3);
    assert_eq!(roster["members"], updated["members"]);

    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap(),
        updated
    );
}

#[test]
fn stale_revision_is_rejected_without_changing_the_roster() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Concurrency");
    let original = set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "reviewGate": true,
            "qaGate": true,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();
    let stored_sql = "SELECT roster_json,revision FROM session_team WHERE session_id=?1";
    let before: (String, i64) = db
        .conn()
        .query_row(stored_sql, params![session_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();

    let error = set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": false,
            "reviewGate": false,
            "qaGate": false,
            "members": [{"agent": "replacement"}]
        }),
    )
    .unwrap_err();
    assert!(error.to_string().starts_with("TEAM_REVISION_STALE"));
    assert!(!repository::upsert(
        db.conn(),
        &session_id,
        false,
        "{\"version\":1,\"members\":[]}",
        0,
    )
    .unwrap());
    let after: (String, i64) = db
        .conn()
        .query_row(stored_sql, params![session_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(after, before);
    let reread = get(&db, &session_id).unwrap();
    assert_eq!(reread, original);
    assert!(
        reread.review_gate,
        "stale write must not clear the review gate"
    );
    assert!(reread.qa_gate, "stale write must not clear the qa gate");
}

#[test]
fn roster_validation_enforces_bounds_and_normalized_uniqueness() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Validation");
    // One past the ceiling is rejected; exactly the ceiling is stored, so the
    // bound is the host's constant rather than a number this test repeats.
    let too_many: Vec<Value> = (0..=MAX_TEAM_MEMBERS)
        .map(|index| json!({"agent": format!("agent-{index}")}))
        .collect();
    let invalid = vec![
        too_many,
        vec![
            json!({"agent": "agents/Explorer.MD"}),
            json!({"agent": "explorer"}),
        ],
        vec![json!({"agent": ".md"})],
        vec![json!({"agent": "a".repeat(41)})],
        vec![json!({"agent": "explorer", "model": {"providerId": " ", "modelId": "model"}})],
        vec![json!({"agent": "explorer", "model": {"providerId": "provider", "modelId": "\t"}})],
        vec![
            json!({"agent": "explorer", "model": {"providerId": "p".repeat(129), "modelId": "model"}}),
        ],
        vec![
            json!({"agent": "explorer", "model": {"providerId": "provider", "modelId": "m".repeat(257)}}),
        ],
    ];
    for members in invalid {
        let error = set(
            &db,
            &json!({
                "sessionId": session_id,
                "expectedRevision": 0,
                "members": members
            }),
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("TEAM_ROSTER_INVALID"));
        assert_eq!(get(&db, &session_id).unwrap().revision, 0);
    }
    assert!(set(&db, &json!({"sessionId": session_id, "members": []}))
        .unwrap_err()
        .to_string()
        .starts_with("INVALID_ARGUMENT: expectedRevision"));

    let full: Vec<Value> = (0..MAX_TEAM_MEMBERS)
        .map(|index| json!({"agent": format!("agent-{index}")}))
        .collect();
    let accepted = set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "members": full
        }),
    )
    .unwrap();
    assert_eq!(accepted.members.len(), MAX_TEAM_MEMBERS);
    assert_eq!(accepted.revision, 1);
}

#[test]
fn unknown_roster_version_degrades_without_rewriting_storage() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Future roster");
    let raw = json!({"version": 99, "members": [{"agent": "future-agent"}]}).to_string();
    db.conn()
        .execute(
            "INSERT INTO session_team(session_id,enabled,roster_json,revision,updated_at)
             VALUES(?1,1,?2,7,?3)",
            params![session_id, raw, now_ms()],
        )
        .unwrap();

    assert_eq!(
        get(&db, &session_id).unwrap(),
        SessionTeamConfig {
            session_id: session_id.clone(),
            enabled: false,
            members: Vec::new(),
            review_gate: false,
            qa_gate: false,
            revision: 7,
        }
    );
    let persisted: String = db
        .conn()
        .query_row(
            "SELECT roster_json FROM session_team WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted, raw);
}

#[test]
fn deleting_a_session_cascades_to_its_team_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Cascade");
    set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id=?1", params![session_id])
        .unwrap();
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_team WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

fn stored_roster_json(db: &Database, session_id: &str) -> Value {
    let roster: String = db
        .conn()
        .query_row(
            "SELECT roster_json FROM session_team WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&roster).unwrap()
}

#[test]
fn version_one_rosters_read_as_enabled_members_and_upgrade_on_write() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Legacy roster");
    let members = json!([
        {"agent": "explorer"},
        {
            "agent": "fixer",
            "model": {"providerId": "anthropic", "modelId": "claude-sonnet-4-5"}
        }
    ]);
    let raw = json!({"version": 1, "members": members}).to_string();
    db.conn()
        .execute(
            "INSERT INTO session_team(session_id,enabled,roster_json,revision,updated_at)
             VALUES(?1,1,?2,3,?3)",
            params![session_id, raw, now_ms()],
        )
        .unwrap();

    let legacy = get(&db, &session_id).unwrap();
    assert!(legacy.enabled);
    assert_eq!(legacy.revision, 3);
    assert!(!legacy.review_gate);
    assert!(!legacy.qa_gate);
    assert_eq!(legacy.members.len(), 2);
    for member in &legacy.members {
        assert!(member.enabled, "{member:?}");
        assert_eq!(member.tools, None);
        assert_eq!(member.thinking_level, None);
    }
    let read = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(read["members"], members);

    let upgraded = set(
        &db,
        &json!({"sessionId": session_id, "expectedRevision": 3, "enabled": false}),
    )
    .unwrap();
    assert_eq!(upgraded.members, legacy.members);
    let roster = stored_roster_json(&db, &session_id);
    assert_eq!(roster["version"], 3);
    assert_eq!(roster["members"], members);
    assert_eq!(roster.get("review_gate"), None);
    assert_eq!(roster.get("qa_gate"), None);
}

#[test]
fn member_session_settings_roundtrip_in_canonical_form() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session_id = session(&db, "Session settings");
    let saved = handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "members": [
                {"agent": "explorer", "enabled": true},
                {
                    "agent": "code-reviewer",
                    "enabled": false,
                    "tools": ["Edit", "Read", "inherit"],
                    "thinkingLevel": "high"
                },
                {"agent": "fixer", "tools": ["inherit"], "thinkingLevel": "omit"}
            ]
        }),
    )
    .unwrap();
    let canonical = json!([
        {"agent": "explorer"},
        {
            "agent": "code-reviewer",
            "enabled": false,
            "tools": ["inherit", "Read", "Edit"],
            "thinkingLevel": "high"
        },
        {"agent": "fixer", "tools": ["inherit"], "thinkingLevel": "omit"}
    ]);
    assert_eq!(saved["members"], canonical);
    let roster = stored_roster_json(&db, &session_id);
    assert_eq!(roster["version"], 3);
    assert_eq!(roster["members"], canonical);

    drop(db);
    let db = Database::open(&path).unwrap();
    let restored = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(restored["members"], canonical);
    assert_eq!(restored["revision"], 1);
}

#[test]
fn invalid_member_session_settings_are_rejected_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Invalid settings");
    for member in [
        json!({"agent": "fixer", "tools": []}),
        json!({"agent": "fixer", "tools": ["Read", "Read"]}),
        json!({"agent": "fixer", "tools": ["read"]}),
        json!({"agent": "fixer", "tools": ["Task"]}),
        json!({"agent": "fixer", "tools": ["SessionTask"]}),
        json!({"agent": "fixer", "tools": "Read"}),
        json!({"agent": "fixer", "thinkingLevel": "extreme"}),
        json!({"agent": "fixer", "enabled": "yes"}),
        json!({"agent": "fixer", "enabled": null}),
        json!({"agent": "fixer", "prompt": "override the role"}),
    ] {
        let error = set(
            &db,
            &json!({
                "sessionId": session_id,
                "expectedRevision": 0,
                "enabled": true,
                "members": [{"agent": "explorer"}, member]
            }),
        )
        .unwrap_err()
        .to_string();
        assert!(error.starts_with("TEAM_ROSTER_INVALID"), "{error}");
    }
    assert_eq!(get(&db, &session_id).unwrap(), empty_config(&session_id));
    let rows: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_team WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
}

fn insert_roster(db: &Database, session_id: &str, roster: &Value, revision: i64) {
    db.conn()
        .execute(
            "INSERT INTO session_team(session_id,enabled,roster_json,revision,updated_at)
             VALUES(?1,1,?2,?3,?4)",
            params![session_id, roster.to_string(), revision, now_ms()],
        )
        .unwrap();
}

#[test]
fn quality_gate_flags_roundtrip_through_set_and_get() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session_id = session(&db, "Gates on");
    let saved = handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "reviewGate": true,
            "qaGate": true,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();
    assert_eq!(saved["reviewGate"], true);
    assert_eq!(saved["qaGate"], true);
    assert_eq!(saved["revision"], 1);

    let read = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(read["reviewGate"], true);
    assert_eq!(read["qaGate"], true);
    let roster = stored_roster_json(&db, &session_id);
    assert_eq!(roster["version"], 3);
    assert_eq!(roster["review_gate"], true);
    assert_eq!(roster["qa_gate"], true);

    drop(db);
    let db = Database::open(&path).unwrap();
    let restored = get(&db, &session_id).unwrap();
    assert!(restored.review_gate);
    assert!(restored.qa_gate);
}

#[test]
fn absent_quality_gate_flags_stay_absent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Gates absent");
    handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "reviewGate": false,
            "qaGate": false,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();

    let config = get(&db, &session_id).unwrap();
    assert!(!config.review_gate);
    assert!(!config.qa_gate);
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(value.get("reviewGate"), None, "{value}");
    assert_eq!(value.get("qaGate"), None, "{value}");
    let read = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(read.get("reviewGate"), None, "{read}");
    assert_eq!(read.get("qaGate"), None, "{read}");
    // An off gate is omitted from storage too, not persisted as `false`.
    let roster = stored_roster_json(&db, &session_id);
    assert_eq!(roster.get("review_gate"), None, "{roster}");
    assert_eq!(roster.get("qa_gate"), None, "{roster}");
}

#[test]
fn omitting_a_gate_on_update_preserves_the_stored_gate() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Gate partial");
    handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "qaGate": true,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();

    let updated = handle(
        &db,
        "session.team.set",
        &json!({
            "sessionId": session_id,
            "expectedRevision": 1,
            "reviewGate": true
        }),
    )
    .unwrap();
    assert_eq!(updated["reviewGate"], true);
    assert_eq!(updated["qaGate"], true);
    assert_eq!(updated["revision"], 2);
    let roster = stored_roster_json(&db, &session_id);
    assert_eq!(roster["review_gate"], true);
    assert_eq!(roster["qa_gate"], true);

    // The same omission rule applies when clearing one gate explicitly.
    let cleared = set(
        &db,
        &json!({"sessionId": session_id, "expectedRevision": 2, "qaGate": false}),
    )
    .unwrap();
    assert!(cleared.review_gate);
    assert!(!cleared.qa_gate);
}

#[test]
fn non_boolean_quality_gate_is_rejected_without_advancing_revision() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Gate invalid");
    let accepted = set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "members": [{"agent": "explorer"}]
        }),
    )
    .unwrap();
    assert_eq!(accepted.revision, 1);

    for input in [
        json!({"sessionId": session_id, "expectedRevision": 1, "reviewGate": "yes"}),
        json!({"sessionId": session_id, "expectedRevision": 1, "qaGate": "yes"}),
        json!({"sessionId": session_id, "expectedRevision": 1, "reviewGate": null}),
        json!({"sessionId": session_id, "expectedRevision": 1, "qaGate": 1}),
    ] {
        let error = set(&db, &input).unwrap_err().to_string();
        assert!(error.starts_with("INVALID_ARGUMENT"), "{error}");
        assert!(error.contains("must be a boolean"), "{error}");
    }
    let after = get(&db, &session_id).unwrap();
    assert_eq!(after, accepted);
    assert_eq!(after.revision, 1);
    assert!(!after.review_gate);
    assert!(!after.qa_gate);
}

#[test]
fn version_two_rosters_read_with_both_gates_off() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Roster v2");
    let members = json!([
        {"agent": "explorer"},
        {
            "agent": "fixer",
            "tools": ["inherit", "Read"],
            "thinkingLevel": "high"
        }
    ]);
    insert_roster(
        &db,
        &session_id,
        &json!({"version": 2, "members": members}),
        4,
    );

    let legacy = get(&db, &session_id).unwrap();
    assert_eq!(legacy.revision, 4);
    assert!(!legacy.review_gate);
    assert!(!legacy.qa_gate);
    assert_eq!(legacy.members.len(), 2);
    assert_eq!(
        legacy.members[1].tools.as_deref(),
        Some(&["inherit".to_string(), "Read".to_string()][..])
    );
    let read = handle(&db, "session.team.get", &json!({"sessionId": session_id})).unwrap();
    assert_eq!(read["members"], members);
    assert_eq!(read.get("reviewGate"), None, "{read}");
    assert_eq!(read.get("qaGate"), None, "{read}");
}
