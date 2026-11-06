//! Access profiles narrow one `tools.execute` call (ADR 0344).
//!
//! A caller may run a call under a profile that is narrower than the
//! session's permission mode. A profile only removes capability: it never
//! admits a tool, a path, or a grant that the session's contract mode,
//! permission mode, or grants would refuse, and it never opens a permission
//! request. Without a profile a call is unchanged.
//!
//! `read-only` admits `Read`, `Glob`, and `Grep` on paths that need no
//! external-path permission: the session workspace and its contained roots,
//! such as scratch. Every other tool and every external path is denied before
//! it runs, in every permission mode and despite session grants.

use super::*;

/// The narrowing requested for one `tools.execute` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AccessProfile {
    /// Inspect the workspace without writing, running commands, or leaving
    /// the session's contained roots.
    ReadOnly,
}

impl AccessProfile {
    /// The wire value, also recorded in audit payloads.
    fn label(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
        }
    }

    fn admits_tool(self, tool_name: &str) -> bool {
        match self {
            Self::ReadOnly => matches!(tool_name, "Read" | "Glob" | "Grep"),
        }
    }

    fn tool_denied_code(self) -> &'static str {
        match self {
            Self::ReadOnly => "TOOL_DISABLED_IN_READ_ONLY",
        }
    }

    fn external_path_denied_code(self) -> &'static str {
        match self {
            Self::ReadOnly => "EXTERNAL_PATH_DISABLED_IN_READ_ONLY",
        }
    }
}

/// Reads `accessProfile` from a call. An unknown value is `INVALID_PARAMS`,
/// and so is a profile combined with a field that carries its own authority:
/// a file-batch ticket, a delegation worktree, a permission scope, or a
/// detached background run.
pub(super) fn parse(p: &ToolsExecuteParams) -> Result<Option<AccessProfile>, JsonRpcError> {
    let Some(raw) = p.access_profile.as_deref() else {
        return Ok(None);
    };
    let profile = match raw {
        "read-only" => AccessProfile::ReadOnly,
        _ => return Err(rpc_err(1002, "unsupported accessProfile", "INVALID_PARAMS")),
    };
    let conflict = if p.file_batch_ticket.is_some() {
        Some("fileBatchTicket")
    } else if p.delegation_id.is_some() {
        Some("delegationId")
    } else if p.permission_scope.is_some() {
        Some("permissionScope")
    } else if p.run_in_background {
        Some("runInBackground")
    } else {
        None
    };
    match conflict {
        Some(field) => Err(rpc_err(
            1002,
            format!("accessProfile cannot be combined with {field}"),
            "INVALID_PARAMS",
        )),
        None => Ok(Some(profile)),
    }
}

/// The denial a profile imposes on a call. `None` means the profile admits
/// the call and the normal permission evaluation decides.
pub(super) fn denial_code(
    profile: Option<AccessProfile>,
    tool_name: &str,
    external_path_permission: bool,
) -> Option<&'static str> {
    let profile = profile?;
    if !profile.admits_tool(tool_name) {
        Some(profile.tool_denied_code())
    } else if external_path_permission {
        Some(profile.external_path_denied_code())
    } else {
        None
    }
}

/// Narrows the auto decision of a profiled call: a denied call stays denied,
/// an undecided call is denied instead of prompting, and an allowed call runs
/// once without recording a session grant. Without a profile the decision is
/// returned unchanged.
pub(super) fn narrow_auto_decision(
    profile: Option<AccessProfile>,
    tool_name: &str,
    external_path_permission: bool,
    auto: Option<PermissionDecision>,
) -> Option<PermissionDecision> {
    if profile.is_none() {
        return auto;
    }
    if denial_code(profile, tool_name, external_path_permission).is_some() {
        return Some(PermissionDecision::Deny);
    }
    match auto {
        Some(PermissionDecision::AllowOnce | PermissionDecision::AllowSession) => {
            Some(PermissionDecision::AllowOnce)
        }
        Some(PermissionDecision::Deny) | None => Some(PermissionDecision::Deny),
    }
}

/// Records the profile of a narrowed call in its audit payload.
pub(super) fn annotate_audit(payload: &mut Value, profile: Option<AccessProfile>) {
    if let Some(profile) = profile {
        payload["accessProfile"] = json!(profile.label());
    }
}

/// Denies a profiled call to a tool the profile does not admit before any
/// tool-specific setup runs, so every such call gets the same result and
/// audit row. Bash, for example, would otherwise fail its shell checks first.
/// Returns `None` when the call continues on the normal path.
pub(super) async fn deny_unlisted_tool(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
    profile: Option<AccessProfile>,
    started: Instant,
) -> Result<Option<Value>, JsonRpcError> {
    let Some(profile) = profile else {
        return Ok(None);
    };
    if profile.admits_tool(&p.tool_name) {
        return Ok(None);
    }
    let st = state.lock().await;
    let durable_mode = sessions::session_mode(&st.db, &p.session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
    let mut payload = json!({
        "toolName": p.tool_name,
        "toolCallId": p.tool_call_id,
        "mode": durable_mode,
        "prompted": false,
        "totalMs": started.elapsed().as_millis() as u64
    });
    annotate_audit(&mut payload, Some(profile));
    if let Err(error) = audit::append(&st.db, "tool_denied", Some(&p.session_id), payload) {
        tracing::warn!(%error, tool = %p.tool_name, "failed to audit an access-profile denial");
    }
    Ok(Some(denied_tool_result(
        p,
        profile.tool_denied_code(),
        false,
        None,
    )))
}

#[cfg(test)]
#[path = "tool_access_profile_tests.rs"]
mod tests;
