//! Read-only session progress reports (ADR 0350).
//!
//! A report is a model-written snapshot of what a session has done, is doing,
//! and has left. This module only stores reports and the per-session
//! auto-collection settings; it never touches a transcript, a turn, or a
//! session configuration. The collection itself runs in Electron Main.
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{now_ms, Database};

mod repository;

pub const SCHEMA: &str = include_str!("schema.sql");

/// Newest reports a `progress.reports.list` page returns.
const DEFAULT_PAGE: i64 = 20;
const MAX_PAGE: i64 = 100;
/// Intervals the popover can render (packages/shared `PROGRESS_INTERVALS`).
const INTERVALS: [i64; 6] = [1, 3, 5, 10, 15, 30];
const DEFAULT_INTERVAL: i64 = 5;
const MAX_SESSION_ID_LENGTH: usize = 256;
const MAX_ID_LENGTH: usize = 128;
const MAX_PROVIDER_ID_LENGTH: usize = 128;
const MAX_MODEL_ID_LENGTH: usize = 256;
const MAX_FINGERPRINT_LENGTH: usize = 128;
/// Raw model text kept for an unparsed answer; Main caps it at 4,000.
const MAX_RAW_CHARS: usize = 8_000;
/// Serialized report body ceiling, so one row cannot grow without bound.
const MAX_BODY_BYTES: usize = 16 * 1024;

const TRIGGERS: [&str; 3] = ["manual", "auto", "turnEnd"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressReport {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub created_at: i64,
    pub trigger: String,
    pub provider_id: String,
    pub model_id: String,
    pub status: String,
    pub body: Option<Value>,
    pub raw: Option<String>,
    pub fingerprint: String,
    pub last_message_id: Option<String>,
    pub message_count: i64,
    pub included_messages: i64,
    pub usage: Option<ProgressUsage>,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSettings {
    pub session_id: String,
    pub model: Value,
    pub auto_enabled: bool,
    pub interval_minutes: i64,
    pub last_collected_at: Option<i64>,
    pub consecutive_failures: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressReportPage {
    pub reports: Vec<ProgressReport>,
    pub next_cursor: Option<String>,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("INVALID_ARGUMENT: {}", message.into())
}

fn session_id(input: &Value) -> Result<&str> {
    let value = input
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("sessionId required"))?;
    if value.chars().count() > MAX_SESSION_ID_LENGTH {
        return Err(invalid("sessionId too long"));
    }
    Ok(value)
}

fn required_text(input: &Value, field: &str, limit: usize) -> Result<String> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field} required")))?;
    if value.chars().count() > limit {
        return Err(invalid(format!("{field} too long")));
    }
    Ok(value.to_string())
}

fn optional_text(input: &Value, field: &str, limit: usize) -> Result<Option<String>> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > limit {
                return Err(invalid(format!("{field} too long")));
            }
            Ok(Some(trimmed.to_string()))
        }
        Some(_) => Err(invalid(format!("{field} must be a string"))),
    }
}

fn required_count(input: &Value, field: &str) -> Result<i64> {
    input
        .get(field)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or_else(|| invalid(format!("{field} must be a non-negative integer")))
}

fn optional_count(input: &Value, field: &str) -> Result<Option<i64>> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .filter(|value| *value >= 0)
            .map(Some)
            .ok_or_else(|| invalid(format!("{field} must be a non-negative integer"))),
    }
}

fn ensure_session(db: &Database, session_id: &str) -> Result<()> {
    if repository::session_exists(db.conn(), session_id)? {
        Ok(())
    } else {
        Err(anyhow!("NOT_FOUND: session {session_id}"))
    }
}

/// The stored, canonical form of an untrusted model reference. Only the two
/// documented shapes survive, so a hostile payload cannot add keys.
fn parse_model_ref(value: &Value) -> Result<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("model must be an object"))?;
    if let Some(follow) = object.get("followSession") {
        if follow.as_bool() != Some(true) || object.len() != 1 {
            return Err(invalid("model.followSession must be true and stand alone"));
        }
        return Ok(json!({ "followSession": true }));
    }
    let provider_id = object
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("model.providerId required"))?;
    let model_id = object
        .get("modelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("model.modelId required"))?;
    if object.len() != 2 {
        return Err(invalid(
            "model must be { followSession } or { providerId, modelId }",
        ));
    }
    if provider_id.chars().count() > MAX_PROVIDER_ID_LENGTH {
        return Err(invalid("model.providerId too long"));
    }
    if model_id.chars().count() > MAX_MODEL_ID_LENGTH {
        return Err(invalid("model.modelId too long"));
    }
    Ok(json!({ "providerId": provider_id, "modelId": model_id }))
}

fn parse_body(input: &Value) -> Result<Option<String>> {
    let Some(value) = input.get("body") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if !value.is_object() {
        return Err(invalid("body must be an object or null"));
    }
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > MAX_BODY_BYTES {
        return Err(invalid("body too large"));
    }
    Ok(Some(encoded))
}

fn to_report(stored: repository::StoredReport) -> ProgressReport {
    let body = stored
        .body_json
        .as_deref()
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok());
    let usage = match (stored.input_tokens, stored.output_tokens) {
        (Some(input_tokens), Some(output_tokens)) => Some(ProgressUsage {
            input_tokens,
            output_tokens,
        }),
        _ => None,
    };
    ProgressReport {
        id: stored.id,
        session_id: stored.session_id,
        run_id: stored.run_id,
        created_at: stored.created_at,
        trigger: stored.trigger,
        provider_id: stored.provider_id,
        model_id: stored.model_id,
        status: stored.status,
        body,
        raw: stored.raw_text,
        fingerprint: stored.fingerprint,
        last_message_id: stored.last_message_id,
        message_count: stored.message_count,
        included_messages: stored.included_messages,
        usage,
        duration_ms: stored.duration_ms,
    }
}

fn default_settings(session_id: &str) -> ProgressSettings {
    ProgressSettings {
        session_id: session_id.to_string(),
        model: json!({ "followSession": true }),
        auto_enabled: false,
        interval_minutes: DEFAULT_INTERVAL,
        last_collected_at: None,
        consecutive_failures: 0,
        updated_at: 0,
    }
}

fn to_settings(session_id: &str, stored: repository::StoredSettings) -> ProgressSettings {
    let model = serde_json::from_str::<Value>(&stored.model_json)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "followSession": true }));
    ProgressSettings {
        session_id: session_id.to_string(),
        model,
        auto_enabled: stored.auto_enabled,
        interval_minutes: stored.interval_minutes,
        last_collected_at: stored.last_collected_at,
        consecutive_failures: stored.consecutive_failures,
        updated_at: stored.updated_at,
    }
}

/// Insert one report. A retried append (same `run_id`) returns the row that
/// already exists instead of writing a second one.
pub fn append(db: &Database, input: &Value) -> Result<ProgressReport> {
    let session_id = session_id(input)?;
    let run_id = required_text(input, "runId", MAX_ID_LENGTH)?;
    let session_short = session_id.to_string();
    ensure_session(db, &session_short)?;

    if let Some(existing) = repository::get_by_run_id(db.conn(), &run_id)? {
        return Ok(to_report(existing));
    }

    let id = match optional_text(input, "id", MAX_ID_LENGTH)? {
        Some(id) => id,
        None => run_id.clone(),
    };
    let trigger = required_text(input, "trigger", 16)?;
    if !TRIGGERS.contains(&trigger.as_str()) {
        return Err(invalid("trigger must be manual, auto, or turnEnd"));
    }
    let status = required_text(input, "status", 16)?;
    if status != "ok" && status != "unparsed" {
        return Err(invalid("status must be ok or unparsed"));
    }
    let body_json = parse_body(input)?;
    if status == "ok" && body_json.is_none() {
        return Err(invalid("status ok needs a body"));
    }
    let raw = optional_text(input, "raw", MAX_RAW_CHARS)?;
    if status == "unparsed" && raw.is_none() {
        return Err(invalid("status unparsed needs raw text"));
    }

    let report = repository::StoredReport {
        id,
        session_id: session_short,
        run_id,
        created_at: optional_count(input, "createdAt")?.unwrap_or_else(now_ms),
        trigger,
        provider_id: required_text(input, "providerId", MAX_PROVIDER_ID_LENGTH)?,
        model_id: required_text(input, "modelId", MAX_MODEL_ID_LENGTH)?,
        status,
        body_json,
        raw_text: raw,
        fingerprint: required_text(input, "fingerprint", MAX_FINGERPRINT_LENGTH)?,
        last_message_id: optional_text(input, "lastMessageId", MAX_ID_LENGTH)?,
        message_count: required_count(input, "messageCount")?,
        included_messages: required_count(input, "includedMessages")?,
        input_tokens: optional_count(input, "inputTokens")?,
        output_tokens: optional_count(input, "outputTokens")?,
        duration_ms: required_count(input, "durationMs")?,
    };
    repository::insert_report(db.conn(), &report)?;
    // A concurrent append with the same run id may have won the insert; read
    // back the row that is actually stored so both callers agree.
    let stored = repository::get_by_run_id(db.conn(), &report.run_id)?
        .ok_or_else(|| anyhow!("INTERNAL: progress report disappeared after insert"))?;
    Ok(to_report(stored))
}

/// One page of history, newest first. `before` names the last row the caller
/// already has.
pub fn list(db: &Database, input: &Value) -> Result<ProgressReportPage> {
    let session_id = session_id(input)?.to_string();
    ensure_session(db, &session_id)?;
    let limit = match input.get("limit") {
        None | Some(Value::Null) => DEFAULT_PAGE,
        Some(value) => value
            .as_i64()
            .filter(|value| *value > 0)
            .map(|value| value.min(MAX_PAGE))
            .ok_or_else(|| invalid("limit must be a positive integer"))?,
    };
    let before = match optional_text(input, "before", MAX_ID_LENGTH)? {
        Some(cursor) => {
            let anchor = repository::get_report(db.conn(), &session_id, &cursor)?
                .ok_or_else(|| invalid("before is not a report of this session"))?;
            Some((anchor.created_at, anchor.id))
        }
        None => None,
    };
    let reports = repository::list_reports(db.conn(), &session_id, limit, before)?
        .into_iter()
        .map(to_report)
        .collect::<Vec<_>>();
    // A full page may have more behind it; a short page is the end. The cursor
    // is the last row of this page, and it stays in the page.
    let next_cursor = if reports.len() as i64 == limit {
        reports.last().map(|report| report.id.clone())
    } else {
        None
    };
    Ok(ProgressReportPage {
        reports,
        next_cursor,
    })
}

pub fn latest(db: &Database, input: &Value) -> Result<Option<ProgressReport>> {
    let session_id = session_id(input)?.to_string();
    ensure_session(db, &session_id)?;
    Ok(repository::latest_report(db.conn(), &session_id)?.map(to_report))
}

/// Settings for a session. A session with no row reads the documented defaults
/// and a read never writes.
pub fn settings_get(db: &Database, input: &Value) -> Result<ProgressSettings> {
    let session_id = session_id(input)?.to_string();
    ensure_session(db, &session_id)?;
    Ok(match repository::get_settings(db.conn(), &session_id)? {
        Some(stored) => to_settings(&session_id, stored),
        None => default_settings(&session_id),
    })
}

/// Patch the settings. Every field is optional; an out-of-range interval is
/// refused so a stored interval is always one the popover can render.
pub fn settings_set(db: &Database, input: &Value) -> Result<ProgressSettings> {
    let session_id = session_id(input)?.to_string();
    ensure_session(db, &session_id)?;
    let current = match repository::get_settings(db.conn(), &session_id)? {
        Some(stored) => to_settings(&session_id, stored),
        None => default_settings(&session_id),
    };

    let model = match input.get("model") {
        None => current.model.clone(),
        Some(value) => parse_model_ref(value)?,
    };
    let auto_enabled = match input.get("autoEnabled") {
        None => current.auto_enabled,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| invalid("autoEnabled must be a boolean"))?,
    };
    let interval_minutes = match input.get("intervalMinutes") {
        None => current.interval_minutes,
        Some(value) => {
            let minutes = value
                .as_i64()
                .ok_or_else(|| invalid("intervalMinutes must be an integer"))?;
            if !INTERVALS.contains(&minutes) {
                return Err(invalid("intervalMinutes is not a supported interval"));
            }
            minutes
        }
    };
    let last_collected_at = if input.get("lastCollectedAt").is_some() {
        optional_count(input, "lastCollectedAt")?
    } else {
        current.last_collected_at
    };
    let consecutive_failures = match input.get("consecutiveFailures") {
        None => current.consecutive_failures,
        Some(_) => required_count(input, "consecutiveFailures")?,
    };

    let model_json = serde_json::to_string(&model)?;
    repository::upsert_settings(
        db.conn(),
        &session_id,
        &model_json,
        auto_enabled,
        interval_minutes,
        last_collected_at,
        consecutive_failures,
    )?;
    settings_get(db, &json!({ "sessionId": session_id }))
}

pub fn handle(db: &Database, method: &str, input: &Value) -> Result<Value> {
    match method {
        "progress.reports.append" => Ok(serde_json::to_value(append(db, input)?)?),
        "progress.reports.list" => Ok(serde_json::to_value(list(db, input)?)?),
        "progress.reports.latest" => Ok(serde_json::to_value(latest(db, input)?)?),
        "progress.settings.get" => Ok(serde_json::to_value(settings_get(db, input)?)?),
        "progress.settings.set" => Ok(serde_json::to_value(settings_set(db, input)?)?),
        _ => Err(anyhow!("NOT_FOUND: unknown progress operation")),
    }
}

#[cfg(test)]
mod tests;
