//! The transcript the session context viewer replays (`session.contextTranscript`).
//!
//! The agent runtime decides which rows become model context
//! (`packages/agent-runtime/src/history-projection.ts`). The viewer runs the
//! same projection over what this module returns, so a row keeps exactly the
//! fields that projection reads and nothing else: the result is the same as
//! replaying the full `session.get` read, without tool payloads, usage, the
//! checkpoint chain, or summaries. `context_transcript.contract.json` pins
//! that equivalence on both sides.

use anyhow::Result;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::Path;

use super::{dedupe_records, record_to_ui, UiMessage};
use crate::transcripts::{self, CompactionRecord};

/// One transcript row, reduced to what the context projection reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextRow {
    id: String,
    role: String,
    /// User and assistant text; empty for every other row.
    content: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_system: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_replay: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hosted_search: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

/// Which rows the projection keeps depends on these fields alone. A subagent
/// row is never context, but its id and system state still order and
/// deduplicate the parent's system rows, so only those survive. Every
/// `UiMessage` field is named here: a new one fails to compile until it is
/// classified.
pub(crate) fn context_row(message: UiMessage) -> ContextRow {
    let UiMessage {
        id,
        role,
        content,
        command: _,
        skill_mentions: _,
        session_message: _,
        voice_origin: _,
        attachments: _,
        steering: _,
        created_at,
        thinking,
        status,
        model_id: _,
        provider_id: _,
        usage: _,
        response_duration_ms: _,
        response_output_tokens: _,
        error,
        revision_root_id: _,
        revision_count: _,
        active_revision: _,
        tool_name,
        tool_call_id,
        tool_status: _,
        tool_args: _,
        tool_result: _,
        tool_completed_at: _,
        tool_duration_ms: _,
        is_error,
        parent_tool_call_id,
        nested_parent_tool_call_id: _,
        agent_name: _,
        hosted_search,
        model_system,
        provider_replay,
    } = message;
    let own = parent_tool_call_id.is_none();
    let assistant = own && role == "assistant";
    let tool = own && role == "tool";
    ContextRow {
        content: if own && (role == "user" || assistant) {
            content
        } else {
            String::new()
        },
        thinking: thinking.filter(|_| assistant),
        status: status.filter(|_| assistant),
        is_error: is_error.filter(|_| assistant),
        error: error.filter(|_| assistant),
        provider_replay: provider_replay.filter(|_| assistant),
        hosted_search: hosted_search.filter(|_| assistant),
        tool_name: tool_name.filter(|_| tool),
        tool_call_id: tool_call_id.filter(|_| tool),
        id,
        role,
        created_at,
        parent_tool_call_id,
        model_system,
    }
}

/// The anchor and folded system state of the checkpoint that governs the next
/// request. `details` keeps `systemMessageJson` exactly when the record has it,
/// including `null`, because the replay tells "absent" from "present".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextCheckpoint {
    through_message_id: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

pub(crate) fn context_checkpoint(record: &CompactionRecord) -> ContextCheckpoint {
    let details = record
        .details
        .as_ref()
        .and_then(|details| details.as_object()?.get("systemMessageJson"))
        .map(|json| {
            Value::Object(Map::from_iter([(
                "systemMessageJson".to_owned(),
                json.clone(),
            )]))
        });
    ContextCheckpoint {
        through_message_id: record.through_message_id.clone(),
        created_at: record.created_at.clone(),
        details,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextTranscript {
    messages: Vec<ContextRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compaction: Option<ContextCheckpoint>,
}

/// Parse transcript bytes read by `transcripts::read_transcript_bytes`, with
/// the same merge as `session.get`: retried lines keep the first position and
/// the last content, and the latest checkpoint governs.
pub(crate) fn context_transcript_from_bytes(
    bytes: &[u8],
    data_dir: &Path,
    session_id: &str,
) -> Result<ContextTranscript> {
    let read = transcripts::parse_transcript_bytes(bytes, data_dir, session_id)?;
    let messages = dedupe_records(read.messages)
        .into_iter()
        .map(|mut record| {
            // Tool payloads can be megabytes, and the projection never reads
            // them; drop them before `record_to_ui` clones the block.
            if let Some(blocks) = record.blocks.as_array_mut() {
                for block in blocks.iter_mut().filter_map(Value::as_object_mut) {
                    if block.get("type").and_then(Value::as_str) == Some("tool_call") {
                        block.remove("args");
                        block.remove("result");
                    }
                }
            }
            context_row(record_to_ui(record))
        })
        .collect();
    Ok(ContextTranscript {
        messages,
        compaction: read.compactions.last().map(context_checkpoint),
    })
}

#[cfg(test)]
#[path = "context_transcript_tests.rs"]
mod tests;
