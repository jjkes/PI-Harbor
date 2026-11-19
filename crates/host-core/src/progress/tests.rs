use serde_json::json;

use super::*;
use crate::sessions;

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

fn report(session_id: &str, run_id: &str, created_at: i64) -> Value {
    json!({
        "sessionId": session_id,
        "runId": run_id,
        "createdAt": created_at,
        "trigger": "manual",
        "providerId": "openai",
        "modelId": "gpt-4.1-mini",
        "status": "ok",
        "body": {
            "completed": ["read the design"],
            "inProgress": ["writing the host module"],
            "next": ["wire Electron main"],
            "remainingSteps": 4,
            "remainingMinutes": 18,
            "confidence": "medium"
        },
        "fingerprint": "abcd1234",
        "lastMessageId": "m-42",
        "messageCount": 86,
        "includedMessages": 40,
        "inputTokens": 900,
        "outputTokens": 120,
        "durationMs": 2_400
    })
}

fn temp_db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

#[test]
fn v30_migration_preserves_sessions_and_adds_progress_storage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let session_id;
    {
        let db = Database::open(&path).unwrap();
        session_id = session(&db, "Existing session");
        db.conn()
            .execute_batch(
                "DROP TABLE session_progress_reports;
                 DROP TABLE session_progress_settings;
                 PRAGMA user_version=30;",
            )
            .unwrap();
    }

    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    assert_eq!(crate::db::SCHEMA_VERSION, 31);
    assert!(crate::db::migration_backup_path(&path, 30).exists());
    assert!(repository::session_exists(db.conn(), &session_id).unwrap());
    // A session that predates the tables reads the documented defaults.
    let settings = settings_get(&db, &json!({"sessionId": session_id})).unwrap();
    assert!(!settings.auto_enabled);
    assert_eq!(settings.interval_minutes, 5);
}

#[test]
fn append_round_trips_a_report() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Report");
    let stored = append(&db, &report(&session_id, "run_1", 1_000)).unwrap();
    assert_eq!(stored.id, "run_1");
    assert_eq!(stored.trigger, "manual");
    assert_eq!(stored.status, "ok");
    assert_eq!(stored.message_count, 86);
    assert_eq!(stored.included_messages, 40);
    assert_eq!(stored.last_message_id.as_deref(), Some("m-42"));
    assert_eq!(
        stored.usage.as_ref().map(|usage| usage.output_tokens),
        Some(120)
    );
    let body = stored.body.expect("body");
    assert_eq!(body["inProgress"][0], "writing the host module");
}

#[test]
fn append_is_idempotent_per_run_id() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Idempotent");
    let first = append(&db, &report(&session_id, "run_1", 1_000)).unwrap();
    let second = append(&db, &report(&session_id, "run_1", 2_000)).unwrap();
    assert_eq!(first.id, second.id);
    // The stored row is the first one; the retry did not write a second row.
    assert_eq!(second.created_at, 1_000);
    let page = list(&db, &json!({"sessionId": session_id})).unwrap();
    assert_eq!(page.reports.len(), 1);
}

#[test]
fn unparsed_reports_keep_the_raw_text() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Unparsed");
    let stored = append(
        &db,
        &json!({
            "sessionId": session_id,
            "runId": "run_u",
            "trigger": "auto",
            "providerId": "openai",
            "modelId": "gpt-4.1-mini",
            "status": "unparsed",
            "raw": "I cannot see the transcript",
            "fingerprint": "ff00",
            "messageCount": 3,
            "includedMessages": 3,
            "durationMs": 10
        }),
    )
    .unwrap();
    assert_eq!(stored.status, "unparsed");
    assert_eq!(stored.raw.as_deref(), Some("I cannot see the transcript"));
    assert!(stored.body.is_none());
    assert!(stored.usage.is_none());
}

#[test]
fn append_rejects_a_malformed_row() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Validation");
    let invalid_trigger = json!({
        "sessionId": session_id, "runId": "run_x", "trigger": "scheduled",
        "providerId": "openai", "modelId": "m", "status": "ok",
        "body": {"completed": []}, "fingerprint": "f",
        "messageCount": 0, "includedMessages": 0, "durationMs": 0
    });
    assert!(append(&db, &invalid_trigger)
        .unwrap_err()
        .to_string()
        .contains("trigger"));

    let missing_body = json!({
        "sessionId": session_id, "runId": "run_y", "trigger": "manual",
        "providerId": "openai", "modelId": "m", "status": "ok",
        "fingerprint": "f", "messageCount": 0, "includedMessages": 0, "durationMs": 0
    });
    assert!(append(&db, &missing_body)
        .unwrap_err()
        .to_string()
        .contains("body"));
}

#[test]
fn append_refuses_an_unknown_session() {
    let (_dir, db) = temp_db();
    let error = append(&db, &report("missing", "run_1", 1)).unwrap_err();
    assert!(error.to_string().contains("NOT_FOUND"));
}

#[test]
fn listing_is_newest_first_and_pages_by_cursor() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Paging");
    for index in 0..5 {
        append(
            &db,
            &report(&session_id, &format!("run_{index}"), 1_000 + index),
        )
        .unwrap();
    }
    let first = list(&db, &json!({"sessionId": session_id, "limit": 2})).unwrap();
    assert_eq!(
        first
            .reports
            .iter()
            .map(|report| report.run_id.as_str())
            .collect::<Vec<_>>(),
        vec!["run_4", "run_3"]
    );
    let cursor = first.next_cursor.clone().expect("cursor");
    let second = list(
        &db,
        &json!({"sessionId": session_id, "limit": 2, "before": cursor}),
    )
    .unwrap();
    assert_eq!(
        second
            .reports
            .iter()
            .map(|report| report.run_id.as_str())
            .collect::<Vec<_>>(),
        vec!["run_2", "run_1"]
    );
    let cursor = second.next_cursor.clone().expect("cursor");
    let third = list(
        &db,
        &json!({"sessionId": session_id, "limit": 2, "before": cursor}),
    )
    .unwrap();
    assert_eq!(third.reports.len(), 1);
    assert!(third.next_cursor.is_none());
}

#[test]
fn latest_returns_the_newest_report_or_none() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Latest");
    assert!(latest(&db, &json!({"sessionId": session_id}))
        .unwrap()
        .is_none());
    append(&db, &report(&session_id, "run_1", 1_000)).unwrap();
    append(&db, &report(&session_id, "run_2", 2_000)).unwrap();
    let newest = latest(&db, &json!({"sessionId": session_id}))
        .unwrap()
        .unwrap();
    assert_eq!(newest.run_id, "run_2");
}

#[test]
fn appending_prunes_to_the_newest_hundred() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Prune");
    for index in 0..105 {
        append(
            &db,
            &report(&session_id, &format!("run_{index}"), 1_000 + index),
        )
        .unwrap();
    }
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_progress_reports WHERE session_id=?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, repository::REPORTS_KEEP);
    let page = list(&db, &json!({"sessionId": session_id, "limit": 100})).unwrap();
    assert_eq!(
        page.reports.first().map(|report| report.run_id.as_str()),
        Some("run_104")
    );
    assert_eq!(
        page.reports.last().map(|report| report.run_id.as_str()),
        Some("run_5")
    );
}

#[test]
fn deleting_a_session_cascades_its_reports_and_settings() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Cascade");
    append(&db, &report(&session_id, "run_1", 1_000)).unwrap();
    settings_set(&db, &json!({"sessionId": session_id, "autoEnabled": true})).unwrap();
    sessions::delete_session(&db, &session_id).unwrap();
    let reports: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_progress_reports WHERE session_id=?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap();
    let settings: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_progress_settings WHERE session_id=?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reports, 0);
    assert_eq!(settings, 0);
}

#[test]
fn settings_defaults_do_not_write_a_row() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Defaults");
    let settings = settings_get(&db, &json!({"sessionId": session_id})).unwrap();
    assert_eq!(settings.model, json!({"followSession": true}));
    assert!(!settings.auto_enabled);
    assert_eq!(settings.interval_minutes, 5);
    assert_eq!(settings.consecutive_failures, 0);
    let rows: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM session_progress_settings WHERE session_id=?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn settings_set_patches_and_persists() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Patch");
    let updated = settings_set(
        &db,
        &json!({
            "sessionId": session_id,
            "model": {"providerId": "openai", "modelId": "gpt-4.1-mini"},
            "autoEnabled": true,
            "intervalMinutes": 15,
            "lastCollectedAt": 1_700_000_000_000_i64
        }),
    )
    .unwrap();
    assert_eq!(
        updated.model,
        json!({"providerId": "openai", "modelId": "gpt-4.1-mini"})
    );
    assert!(updated.auto_enabled);
    assert_eq!(updated.interval_minutes, 15);
    assert_eq!(updated.last_collected_at, Some(1_700_000_000_000));

    // A patch that omits a field keeps it.
    let patched =
        settings_set(&db, &json!({"sessionId": session_id, "autoEnabled": false})).unwrap();
    assert!(!patched.auto_enabled);
    assert_eq!(patched.interval_minutes, 15);
    assert_eq!(
        patched.model,
        json!({"providerId": "openai", "modelId": "gpt-4.1-mini"})
    );
}

#[test]
fn settings_set_refuses_an_unsupported_interval_or_model() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Reject");
    for interval in [0, 2, 7, 60] {
        let error = settings_set(
            &db,
            &json!({"sessionId": session_id, "intervalMinutes": interval}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("intervalMinutes"));
    }
    let error = settings_set(
        &db,
        &json!({"sessionId": session_id, "model": {"followSession": false}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("followSession"));
    let error = settings_set(
        &db,
        &json!({"sessionId": session_id, "model": {"providerId": "openai", "modelId": "m", "x": 1}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("model"));
}

#[test]
fn handle_rejects_an_unknown_operation() {
    let (_dir, db) = temp_db();
    let error = handle(&db, "progress.nope", &json!({})).unwrap_err();
    assert!(error.to_string().contains("NOT_FOUND"));
}

#[test]
fn handle_serves_every_documented_method() {
    let (_dir, db) = temp_db();
    let session_id = session(&db, "Methods");
    let appended = handle(
        &db,
        "progress.reports.append",
        &report(&session_id, "run_1", 1),
    )
    .unwrap();
    assert_eq!(appended["runId"], "run_1");
    let listed = handle(
        &db,
        "progress.reports.list",
        &json!({"sessionId": session_id}),
    )
    .unwrap();
    assert_eq!(listed["reports"].as_array().map(Vec::len), Some(1));
    let newest = handle(
        &db,
        "progress.reports.latest",
        &json!({"sessionId": session_id}),
    )
    .unwrap();
    assert_eq!(newest["runId"], "run_1");
    let settings = handle(
        &db,
        "progress.settings.get",
        &json!({"sessionId": session_id}),
    )
    .unwrap();
    assert_eq!(settings["autoEnabled"], false);
    let patched = handle(
        &db,
        "progress.settings.set",
        &json!({"sessionId": session_id, "autoEnabled": true}),
    )
    .unwrap();
    assert_eq!(patched["autoEnabled"], true);
}
