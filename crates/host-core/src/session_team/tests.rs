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
    assert_eq!(version, 27);
    assert_eq!(crate::db::SCHEMA_VERSION, 27);
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
    assert_eq!(roster["version"], 2);
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
    assert_eq!(get(&db, &session_id).unwrap(), original);
}

#[test]
fn roster_validation_enforces_bounds_and_normalized_uniqueness() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session_id = session(&db, "Validation");
    let too_many: Vec<Value> = (0..17)
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

    let sixteen: Vec<Value> = (0..16)
        .map(|index| json!({"agent": format!("agent-{index}")}))
        .collect();
    let accepted = set(
        &db,
        &json!({
            "sessionId": session_id,
            "expectedRevision": 0,
            "enabled": true,
            "members": sixteen
        }),
    )
    .unwrap();
    assert_eq!(accepted.members.len(), 16);
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
    assert_eq!(roster["version"], 2);
    assert_eq!(roster["members"], members);
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
    assert_eq!(roster["version"], 2);
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
