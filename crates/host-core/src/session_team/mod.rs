//! Per-session Team mode configuration. Definition lookup and launch-time
//! filtering remain outside host-core; this module only persists the roster.
use std::collections::HashSet;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Database;
use crate::sessions::is_valid_thinking_level;
use crate::user_subagents::ASSIGNABLE_TOOLS;

mod repository;

pub const SCHEMA: &str = include_str!("schema.sql");

/// Version 2 adds per-member `enabled`, `tools` and `thinkingLevel` session
/// settings. Version 1 rows read as enabled members without session settings.
const ROSTER_VERSION: u64 = 2;
const LEGACY_ROSTER_VERSION: u64 = 1;
const MAX_TEAM_MEMBERS: usize = 16;
const MAX_SESSION_ID_LENGTH: usize = 256;
const MAX_AGENT_NAME_LENGTH: usize = 40;
const MAX_PROVIDER_ID_LENGTH: usize = 128;
const MAX_MODEL_ID_LENGTH: usize = 256;
/// Every assignable tool plus `inherit`.
const MAX_TEAM_MEMBER_TOOLS: usize = ASSIGNABLE_TOOLS.len() + 1;
const INHERIT_TOOL_GRANT: &str = "inherit";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTeamModelPin {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTeamMember {
    pub agent: String,
    /// Omitted means enabled, which is how every v1 member reads; `true` is
    /// stored as an omitted flag. A disabled member keeps its session settings.
    #[serde(default = "enabled_by_default", skip_serializing_if = "is_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<SessionTeamModelPin>,
    /// Session-only tool grant; the role definition is never rewritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Session-only reasoning level for this member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

fn is_enabled(enabled: &bool) -> bool {
    *enabled
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTeamConfig {
    pub session_id: String,
    pub enabled: bool,
    pub members: Vec<SessionTeamMember>,
    pub revision: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Roster {
    version: u64,
    members: Vec<SessionTeamMember>,
}

fn empty_config(session_id: &str) -> SessionTeamConfig {
    SessionTeamConfig {
        session_id: session_id.into(),
        enabled: false,
        members: Vec::new(),
        revision: 0,
    }
}

fn degraded_config(session_id: &str, revision: i64) -> SessionTeamConfig {
    SessionTeamConfig {
        revision,
        ..empty_config(session_id)
    }
}

fn decode_stored(session_id: &str, stored: repository::StoredTeam) -> SessionTeamConfig {
    let raw: Value = match serde_json::from_str(&stored.roster_json) {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!(
                session_id,
                revision = stored.revision,
                %error,
                "session team roster is unreadable; Team mode disabled"
            );
            return degraded_config(session_id, stored.revision);
        }
    };
    let version = raw.get("version").and_then(Value::as_u64);
    if !matches!(version, Some(LEGACY_ROSTER_VERSION | ROSTER_VERSION)) {
        tracing::warn!(
            session_id,
            revision = stored.revision,
            version = ?raw.get("version"),
            "unsupported session team roster version; Team mode disabled"
        );
        return degraded_config(session_id, stored.revision);
    }
    let roster: Roster = match serde_json::from_value(raw) {
        Ok(roster) => roster,
        Err(error) => {
            tracing::warn!(
                session_id,
                revision = stored.revision,
                %error,
                "session team roster is invalid; Team mode disabled"
            );
            return degraded_config(session_id, stored.revision);
        }
    };
    match normalize_members(roster.members) {
        Ok(members) => SessionTeamConfig {
            session_id: session_id.into(),
            enabled: stored.enabled,
            members,
            revision: stored.revision,
        },
        Err(error) => {
            tracing::warn!(
                session_id,
                revision = stored.revision,
                %error,
                "session team roster failed validation; Team mode disabled"
            );
            degraded_config(session_id, stored.revision)
        }
    }
}

fn ensure_session(db: &Database, session_id: &str) -> Result<()> {
    if repository::session_exists(db.conn(), session_id)? {
        Ok(())
    } else {
        Err(anyhow!("NOT_FOUND: session {session_id}"))
    }
}

pub fn get(db: &Database, session_id: &str) -> Result<SessionTeamConfig> {
    ensure_session(db, session_id)?;
    Ok(match repository::get(db.conn(), session_id)? {
        Some(stored) => decode_stored(session_id, stored),
        None => empty_config(session_id),
    })
}

fn session_id(input: &Value) -> Result<&str> {
    let value = input
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: sessionId required"))?;
    if value.chars().count() > MAX_SESSION_ID_LENGTH {
        return Err(anyhow!("INVALID_ARGUMENT: sessionId too long"));
    }
    Ok(value)
}

fn expected_revision(input: &Value) -> Result<i64> {
    input
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: expectedRevision must be a non-negative integer"))
}

fn is_js_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Mirrors `normalizeSubagentName`: basename extraction, optional Markdown
/// suffix removal, Unicode lowercasing, then whitespace/underscore folding.
fn normalize_agent_name(value: &str) -> String {
    let path = value.replace('\\', "/");
    let path = path.trim_end_matches('/');
    let basename = path.rsplit('/').next().unwrap_or_default();
    let basename = if basename.to_ascii_lowercase().ends_with(".md") {
        &basename[..basename.len() - 3]
    } else {
        basename
    };
    let lowered = basename.trim_matches(is_js_whitespace).to_lowercase();
    let mut normalized = String::with_capacity(lowered.len());
    let mut in_separator = false;
    for character in lowered.chars() {
        if character == '_' || is_js_whitespace(character) {
            if !in_separator {
                normalized.push('-');
                in_separator = true;
            }
        } else {
            normalized.push(character);
            in_separator = false;
        }
    }
    normalized
}

fn bounded_id(value: &str, field: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() {
        return Err(anyhow!("TEAM_ROSTER_INVALID: {field} must not be empty"));
    }
    if value.chars().count() > limit {
        return Err(anyhow!(
            "TEAM_ROSTER_INVALID: {field} exceeds {limit} characters"
        ));
    }
    Ok(())
}

fn normalize_members(members: Vec<SessionTeamMember>) -> Result<Vec<SessionTeamMember>> {
    if members.len() > MAX_TEAM_MEMBERS {
        return Err(anyhow!(
            "TEAM_ROSTER_INVALID: roster exceeds {MAX_TEAM_MEMBERS} members"
        ));
    }
    let mut names = HashSet::with_capacity(members.len());
    let mut normalized = Vec::with_capacity(members.len());
    for member in members {
        if member.agent.chars().count() > MAX_AGENT_NAME_LENGTH {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: agent exceeds {MAX_AGENT_NAME_LENGTH} characters"
            ));
        }
        let agent = normalize_agent_name(&member.agent);
        if agent.is_empty() {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: agent must contain a definition name"
            ));
        }
        if !names.insert(agent.clone()) {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: duplicate normalized agent {agent}"
            ));
        }
        if let Some(model) = &member.model {
            bounded_id(&model.provider_id, "providerId", MAX_PROVIDER_ID_LENGTH)?;
            bounded_id(&model.model_id, "modelId", MAX_MODEL_ID_LENGTH)?;
        }
        let tools = member.tools.as_deref().map(normalize_tools).transpose()?;
        if member
            .thinking_level
            .as_deref()
            .is_some_and(|level| !is_valid_thinking_level(level))
        {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: thinkingLevel is not a supported level"
            ));
        }
        normalized.push(SessionTeamMember {
            agent,
            enabled: member.enabled,
            model: member.model,
            tools,
            thinking_level: member.thinking_level,
        });
    }
    Ok(normalized)
}

/// Validate a session-only tool grant and store it in canonical order:
/// `inherit` first, then the assignable tools in catalog order.
fn normalize_tools(tools: &[String]) -> Result<Vec<String>> {
    if tools.is_empty() || tools.len() > MAX_TEAM_MEMBER_TOOLS {
        return Err(anyhow!(
            "TEAM_ROSTER_INVALID: tools must list 1 to {MAX_TEAM_MEMBER_TOOLS} entries"
        ));
    }
    let mut seen = HashSet::with_capacity(tools.len());
    for tool in tools.iter().map(String::as_str) {
        if tool != INHERIT_TOOL_GRANT && !ASSIGNABLE_TOOLS.contains(&tool) {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: tools contains an unsupported entry"
            ));
        }
        if !seen.insert(tool) {
            return Err(anyhow!(
                "TEAM_ROSTER_INVALID: tools contains a duplicate entry"
            ));
        }
    }
    Ok(std::iter::once(INHERIT_TOOL_GRANT)
        .chain(ASSIGNABLE_TOOLS)
        .filter(|tool| seen.contains(tool))
        .map(str::to_string)
        .collect())
}

fn requested_members(input: &Value) -> Result<Option<Vec<SessionTeamMember>>> {
    let Some(value) = input.get("members") else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| anyhow!("TEAM_ROSTER_INVALID: members must be an array"))?;
    if values.len() > MAX_TEAM_MEMBERS {
        return Err(anyhow!(
            "TEAM_ROSTER_INVALID: roster exceeds {MAX_TEAM_MEMBERS} members"
        ));
    }
    let mut members = Vec::with_capacity(values.len());
    for value in values {
        members.push(
            serde_json::from_value(value.clone())
                .map_err(|_| anyhow!("TEAM_ROSTER_INVALID: malformed roster member"))?,
        );
    }
    normalize_members(members).map(Some)
}

fn requested_enabled(input: &Value) -> Result<Option<bool>> {
    match input.get("enabled") {
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| anyhow!("INVALID_ARGUMENT: enabled must be a boolean")),
        None => Ok(None),
    }
}

pub fn set(db: &Database, input: &Value) -> Result<SessionTeamConfig> {
    let session_id = session_id(input)?;
    let expected_revision = expected_revision(input)?;
    let enabled = requested_enabled(input)?;
    let members = requested_members(input)?;
    ensure_session(db, session_id)?;

    let stored = repository::get(db.conn(), session_id)?;
    let current_revision = stored.as_ref().map_or(0, |stored| stored.revision);
    if current_revision != expected_revision {
        return Err(anyhow!(
            "TEAM_REVISION_STALE: expected revision {expected_revision}, current revision {current_revision}"
        ));
    }
    if current_revision == i64::MAX {
        return Err(anyhow!("TEAM_REVISION_STALE: revision cannot be advanced"));
    }
    let current = match stored {
        Some(stored) => decode_stored(session_id, stored),
        None => empty_config(session_id),
    };
    let roster = Roster {
        version: ROSTER_VERSION,
        members: members.unwrap_or(current.members),
    };
    let roster_json = serde_json::to_string(&roster)?;
    let enabled = enabled.unwrap_or(current.enabled);
    if !repository::upsert(
        db.conn(),
        session_id,
        enabled,
        &roster_json,
        expected_revision,
    )? {
        return Err(anyhow!(
            "TEAM_REVISION_STALE: expected revision {expected_revision} no longer matches"
        ));
    }
    get(db, session_id)
}

pub fn handle(db: &Database, method: &str, input: &Value) -> Result<Value> {
    match method {
        "session.team.get" => Ok(serde_json::to_value(get(db, session_id(input)?)?)?),
        "session.team.set" => Ok(serde_json::to_value(set(db, input)?)?),
        _ => Err(anyhow!("NOT_FOUND: unknown session team operation")),
    }
}

#[cfg(test)]
mod tests;
