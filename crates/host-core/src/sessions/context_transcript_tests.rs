use super::*;
use crate::db::Database;
use crate::sessions::{create_session, get_session_with_options, ui_to_record, SessionReadOptions};
use serde_json::json;

/// Shared with `packages/agent-runtime/src/session-system-context.test.ts`,
/// which replays both sides and expects the same result.
const CONTRACT: &str = include_str!("context_transcript.contract.json");

fn contract() -> Value {
    serde_json::from_str(CONTRACT).unwrap()
}

fn as_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn context_rows_keep_exactly_the_fields_the_projection_reads() {
    let contract = contract();
    let full: Vec<UiMessage> = serde_json::from_value(contract["full"].clone()).unwrap();
    let lean: Vec<Value> = full
        .into_iter()
        .map(|row| as_value(&context_row(row)))
        .collect();
    assert_eq!(Value::Array(lean), contract["lean"]);
}

#[test]
fn context_checkpoint_keeps_the_anchor_and_folded_system_state_only() {
    for case in contract()["checkpoints"].as_array().unwrap() {
        let record: CompactionRecord = serde_json::from_value(case["full"].clone()).unwrap();
        assert_eq!(
            as_value(&context_checkpoint(&record)),
            case["lean"],
            "{}",
            case["name"]
        );
    }
}

fn row(value: Value) -> UiMessage {
    serde_json::from_value(value).unwrap()
}

fn checkpoint(id: &str, through: &str) -> CompactionRecord {
    serde_json::from_value(json!({
        "id": id, "summary": format!("summary {id}"), "throughMessageId": through,
        "tokensBefore": 10, "retainedTail": [{ "role": "user", "content": "RETAINED-TAIL", "timestamp": 1 }],
        "details": { "systemMessageJson": format!("{{\"checkpoint\":\"{id}\"}}") },
        "createdAt": "2026-11-05T00:00:09.000Z",
    }))
    .unwrap()
}

/// The same file read through `session.get` and through this module.
#[test]
fn context_transcript_merges_like_session_get_without_its_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let rows = [
        row(
            json!({ "id": "u1", "role": "user", "content": "first", "createdAt": "2026-11-05T00:00:01.000Z" }),
        ),
        row(
            json!({ "id": "a1", "role": "assistant", "content": "Reading.", "createdAt": "2026-11-05T00:00:02.000Z",
            "usage": { "inputTokens": 5, "outputTokens": 2, "totalTokens": 7 } }),
        ),
        row(
            json!({ "id": "t1", "role": "tool", "content": "", "createdAt": "2026-11-05T00:00:03.000Z",
            "toolName": "Read", "toolCallId": "t1", "toolStatus": "success",
            "toolArgs": { "path": "big.txt" }, "toolResult": { "content": [{ "type": "text", "text": "TOOL-PAYLOAD" }] } }),
        ),
        // A retried append: the same id again, newest content last.
        row(
            json!({ "id": "u1", "role": "user", "content": "retried", "createdAt": "2026-11-05T00:00:01.000Z" }),
        ),
        row(
            json!({ "id": "u2", "role": "user", "content": "second", "createdAt": "2026-11-05T00:00:04.000Z" }),
        ),
    ];
    let records: Vec<_> = rows.iter().map(|row| ui_to_record(row).0).collect();
    let chain = [checkpoint("older", "a1"), checkpoint("latest", "t1")];
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &session.id,
        "2026-11-05T00:00:00.000Z",
        &records,
        &chain,
    )
    .unwrap();

    let bytes = transcripts::read_transcript_bytes(db.data_dir(), &session.id).unwrap();
    let lean = context_transcript_from_bytes(&bytes, db.data_dir(), &session.id).unwrap();
    let full = get_session_with_options(&db, &session.id, SessionReadOptions::default())
        .unwrap()
        .unwrap();

    let expected: Vec<ContextRow> = full.messages.into_iter().map(context_row).collect();
    assert_eq!(lean.messages, expected);
    assert_eq!(
        lean.compaction,
        full.compaction.as_ref().map(context_checkpoint)
    );
    let encoded = as_value(&lean);
    assert_eq!(encoded["messages"].as_array().unwrap().len(), 4);
    assert_eq!(encoded["messages"][0]["content"], "retried");
    assert_eq!(encoded["compaction"]["throughMessageId"], "t1");
    let text = encoded.to_string();
    for absent in [
        "TOOL-PAYLOAD",
        "big.txt",
        "inputTokens",
        "summary latest",
        "RETAINED-TAIL",
    ] {
        assert!(!text.contains(absent), "{absent} leaked into {text}");
    }
}

#[test]
fn a_missing_transcript_reads_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = transcripts::read_transcript_bytes(dir.path(), "never-written").unwrap();
    let lean = context_transcript_from_bytes(&bytes, dir.path(), "never-written").unwrap();
    assert_eq!(as_value(&lean), json!({ "messages": [] }));
}
