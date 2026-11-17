use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::db::Database;
use crate::mcp_servers::McpServerRegistry;
use crate::permissions::PermissionManager;
use crate::plans::PlanManager;
use crate::plugins::PluginManager;
use crate::secrets::SecretStore;
use crate::tool_budget::ToolBudget;
use crate::user_skills::UserSkillRegistry;
use crate::user_subagents::UserSubagentRegistry;
use crate::workspace::WorkspaceState;

pub const PROTOCOL_VERSION: u32 = 11;
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
const BASH_ABORT_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_BASH_ABORT_TOMBSTONES: usize = 1024;
const TOOL_ABORT_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_TOOL_ABORT_TOMBSTONES: usize = 1024;
const PLUGIN_IMPORT_RATE_WINDOW: Duration = Duration::from_secs(60);
const PLUGIN_IMPORT_RATE_LIMIT: usize = 10;
const PLUGIN_BATCH_IMPORT_RATE_LIMIT: usize = 5;
const PLUGIN_DELETE_RATE_LIMIT: usize = 20;

/// One tool call this host asked the desktop runner to execute.
///
/// The runner owns the plugin JS and the MCP client, so it is the only side
/// that can report the call's progress (D682). Host-core keeps the entry while
/// the call is outstanding, which is what makes a report attributable: a
/// finished call, or a call this host never dispatched, has no entry and so
/// its reports are refused.
pub struct DesktopToolExecution {
    pub responder: tokio::sync::oneshot::Sender<serde_json::Value>,
    session_id: String,
    tool_call_id: String,
}

impl DesktopToolExecution {
    pub fn new(
        responder: tokio::sync::oneshot::Sender<serde_json::Value>,
        session_id: String,
        tool_call_id: String,
    ) -> Self {
        Self {
            responder,
            session_id,
            tool_call_id,
        }
    }

    /// The progress key this call registered, for closing it on resolve.
    pub fn progress_key(&self) -> (String, String) {
        (self.session_id.clone(), self.tool_call_id.clone())
    }
}

pub struct AppState {
    pub data_dir: std::path::PathBuf,
    pub db: Database,
    pub secrets: SecretStore,
    pub workspace: WorkspaceState,
    pub permissions: PermissionManager,
    pub plans: PlanManager,
    pub plugins: PluginManager,
    /// MCP servers the user configured directly, without a plugin around them.
    pub mcp_servers: McpServerRegistry,
    /// Skill documents the user wrote or imported directly.
    pub user_skills: UserSkillRegistry,
    /// Subagent definitions the user owns, alongside the builtin and per-project
    /// ones the runtime discovers itself (D202).
    pub user_subagents: UserSubagentRegistry,
    /// One reconciliation worker per local vault. The lock is separate from
    /// the AppState mutex so WebDAV I/O never monopolizes the host state lock.
    pub config_sync_lock: Arc<tokio::sync::Mutex<()>>,
    /// Process-local status for the single active sync worker. It is never
    /// persisted and only drives the renderer's transient "syncing" state.
    pub config_sync_in_progress: Arc<AtomicBool>,
    pub started_at: Instant,
    pub handshook: bool,
    pub shutting_down: bool,
    /// session_id -> toolName grants
    pub session_grants: HashMap<String, Vec<String>>,
    /// executionId -> responder for plugin tool dispatches awaiting the
    /// desktop runner (Electron main executes the plugin JS and resolves).
    pub remote_execs: HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>,
    pub plugin_execs: HashMap<String, DesktopToolExecution>,
    /// (session_id, tool_call_id) -> progress reports accepted for a
    /// desktop-dispatched call. Opened with the dispatch and closed when the
    /// execution resolves, so a late or unrelated report cannot reach a
    /// finished call or a call this host never dispatched.
    pub(crate) desktop_progress: HashMap<(String, String), usize>,
    /// Rolling plugin session API brakes. These are intentionally process-local;
    /// a restart is already a natural rate-window boundary.
    pub plugin_import_rates: HashMap<String, Vec<Instant>>,
    pub plugin_batch_import_rates: HashMap<String, Vec<Instant>>,
    pub plugin_delete_rates: HashMap<String, Vec<Instant>>,
    /// Chat-started processes detached from their turn (dev servers, etc.).
    /// Lives with the host process; `shutdown` stops every running task.
    pub background_tasks: crate::background_tasks::BackgroundTaskRegistry,
    pub tool_budget: ToolBudget,
    /// (session_id, tool_call_id) -> cancellation signal for an active Bash
    /// process. The signal is removed by the execution owner in all outcomes.
    pub active_bash_cancellations: HashMap<(String, String), tokio::sync::watch::Sender<bool>>,
    /// (session_id, tool_call_id, tool_name) -> cancellation signal for
    /// in-flight non-process tools, including permission waits and remote
    /// workspace calls.
    pub(crate) active_tool_cancellations:
        HashMap<(String, String, String), tokio::sync::watch::Sender<bool>>,
    /// request_id -> (session_id, tool_call_id) for permission requests that
    /// are currently awaited by an RPC task. PermissionManager intentionally
    /// keeps its pending map private, so AppState tracks the ownership needed
    /// for shutdown cancellation.
    pending_permissions: HashMap<String, (String, String)>,
    /// Abort can race ahead of tools.execute because host RPC requests run in
    /// separate tasks. A short-lived tombstone makes the later request start
    /// already cancelled instead of executing after Stop was acknowledged.
    pending_bash_aborts: HashMap<(String, String), Instant>,
    /// Typed aborts that race ahead of a non-process tools.execute request.
    /// Including the tool name prevents an old abort from cancelling a later
    /// tool call that happens to reuse the same id for another tool.
    pub(crate) pending_tool_aborts: HashMap<(String, String, String), Instant>,
    /// Session-scoped Read/Edit snapshot store (ADR 0087). Interior mutex so
    /// tool execution does not hold the AppState lock.
    pub hashline: crate::tools::HashlineStore,
}

impl AppState {
    pub fn open(data_dir: &std::path::Path) -> Result<Self> {
        let db = Database::open_in_dir(data_dir)?;
        crate::scheduled::automation::recover(&db)?;
        // Replies that were still streaming when the previous process ended
        // are promoted into their transcripts before any client can read them
        // (D299). The turn sweep inside `open` has already marked those turns
        // aborted, so the promoted rows land under an aborted turn.
        match crate::sessions::recover_orphaned_sessions(&db) {
            Ok(restored) if restored > 0 => {
                tracing::info!(
                    count = restored,
                    "restored orphaned session rows from transcripts"
                );
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "orphaned session sweep failed"),
        }
        match crate::sessions::recover_inflight_messages(&db, false) {
            Ok(recovered) if !recovered.is_empty() => {
                tracing::info!(count = recovered.len(), "recovered in-flight replies");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "in-flight reply sweep failed"),
        }
        let secrets = SecretStore::open(data_dir)?;
        // The marketplace channel is read before the manager builds its first
        // catalog, so a source configured for networks without GitHub access
        // applies on launch instead of only after a manual refresh.
        let app_settings = db.get_setting("app").unwrap_or_default();
        crate::network_proxy::apply_from_settings(app_settings.as_ref());
        // The WebDAV transport reads this before it allows a plaintext hop, so
        // it has to be in place on launch and not only after a settings write.
        crate::network_policy::apply_from_settings(app_settings.as_ref());
        let (channel, custom_url) =
            crate::plugins::market_channel_from_settings(app_settings.as_ref());
        let plugins = PluginManager::new(data_dir, channel, custom_url);
        // Provider rows a plugin declared are rebuilt from the registry on
        // launch, so the table matches the enabled plugins whatever path
        // (install, enable, an upgraded manifest) last changed them.
        match crate::plugins::reconcile_all(&db, &secrets, &plugins) {
            Ok(0) => {}
            Ok(count) => tracing::info!(count, "reconciled plugin provider rows"),
            Err(error) => tracing::warn!(%error, "plugin provider reconciliation failed"),
        }
        let mcp_servers = McpServerRegistry::new(data_dir);
        let user_skills = UserSkillRegistry::new(data_dir);
        let user_subagents = UserSubagentRegistry::new(data_dir);
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            db,
            secrets,
            workspace: WorkspaceState::default(),
            permissions: PermissionManager::default(),
            plans: PlanManager,
            plugins,
            mcp_servers,
            user_skills,
            user_subagents,
            config_sync_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_sync_in_progress: Arc::new(AtomicBool::new(false)),
            background_tasks: crate::background_tasks::BackgroundTaskRegistry::default(),
            started_at: Instant::now(),
            handshook: false,
            shutting_down: false,
            session_grants: HashMap::new(),
            plugin_execs: HashMap::new(),
            desktop_progress: HashMap::new(),
            remote_execs: HashMap::new(),
            plugin_import_rates: HashMap::new(),
            plugin_batch_import_rates: HashMap::new(),
            plugin_delete_rates: HashMap::new(),
            tool_budget: ToolBudget::new(),
            active_bash_cancellations: HashMap::new(),
            active_tool_cancellations: HashMap::new(),
            pending_permissions: HashMap::new(),
            pending_bash_aborts: HashMap::new(),
            pending_tool_aborts: HashMap::new(),
            hashline: crate::tools::HashlineStore::new(),
        })
    }

    fn rate_allowed(
        rates: &mut HashMap<String, Vec<Instant>>,
        plugin_id: &str,
        limit: usize,
    ) -> bool {
        let now = Instant::now();
        let entries = rates.entry(plugin_id.to_string()).or_default();
        entries.retain(|at| now.duration_since(*at) < PLUGIN_IMPORT_RATE_WINDOW);
        if entries.len() >= limit {
            return false;
        }
        entries.push(now);
        true
    }

    pub fn allow_plugin_import(&mut self, plugin_id: &str, batch: bool) -> bool {
        if batch {
            Self::rate_allowed(
                &mut self.plugin_batch_import_rates,
                plugin_id,
                PLUGIN_BATCH_IMPORT_RATE_LIMIT,
            )
        } else {
            Self::rate_allowed(
                &mut self.plugin_import_rates,
                plugin_id,
                PLUGIN_IMPORT_RATE_LIMIT,
            )
        }
    }

    pub fn allow_plugin_delete(&mut self, plugin_id: &str) -> bool {
        Self::rate_allowed(
            &mut self.plugin_delete_rates,
            plugin_id,
            PLUGIN_DELETE_RATE_LIMIT,
        )
    }

    pub fn register_pending_permission(
        &mut self,
        request_id: &str,
        session_id: &str,
        tool_call_id: &str,
    ) {
        self.pending_permissions.insert(
            request_id.to_string(),
            (session_id.to_string(), tool_call_id.to_string()),
        );
    }

    pub fn clear_pending_permission(&mut self, request_id: &str) {
        self.pending_permissions.remove(request_id);
    }

    pub fn cancel_pending_permission(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        let request_id = self
            .pending_permissions
            .iter()
            .find(|(_, (pending_session_id, pending_tool_call_id))| {
                pending_session_id == session_id && pending_tool_call_id == tool_call_id
            })
            .map(|(request_id, _)| request_id.clone());
        let Some(request_id) = request_id else {
            return false;
        };
        self.pending_permissions.remove(&request_id);
        self.permissions.cancel_for_tool(session_id, tool_call_id)
    }

    pub fn resolve_permission(
        &mut self,
        request_id: &str,
        decision: crate::permissions::PermissionDecision,
    ) -> Result<(), String> {
        let result = self.permissions.resolve(request_id, decision);
        self.clear_pending_permission(request_id);
        result
    }

    fn prune_bash_abort_tombstones(&mut self) {
        self.pending_bash_aborts
            .retain(|_, requested_at| requested_at.elapsed() < BASH_ABORT_TOMBSTONE_TTL);
        while self.pending_bash_aborts.len() > MAX_BASH_ABORT_TOMBSTONES {
            let Some(oldest) = self
                .pending_bash_aborts
                .iter()
                .min_by_key(|(_, requested_at)| **requested_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.pending_bash_aborts.remove(&oldest);
        }
    }

    pub fn register_bash_cancellation(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
    ) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        if self.shutting_down {
            return Err("HOST_SHUTTING_DOWN".into());
        }
        self.prune_bash_abort_tombstones();
        let key = (session_id.to_string(), tool_call_id.to_string());
        if self.active_bash_cancellations.contains_key(&key) {
            return Err("TOOL_BUSY".into());
        }
        let initially_aborted = self.pending_bash_aborts.remove(&key).is_some();
        let (sender, receiver) = tokio::sync::watch::channel(initially_aborted);
        self.active_bash_cancellations.insert(key, sender);
        Ok(receiver)
    }

    pub fn abort_or_queue_bash(&mut self, session_id: &str, tool_call_id: &str) -> (bool, bool) {
        self.prune_bash_abort_tombstones();
        let key = (session_id.to_string(), tool_call_id.to_string());
        let active = self
            .active_bash_cancellations
            .get(&key)
            .is_some_and(|sender| sender.send(true).is_ok());
        if active {
            (true, false)
        } else {
            self.pending_bash_aborts.insert(key, Instant::now());
            (false, true)
        }
    }

    pub fn clear_bash_cancellation(&mut self, session_id: &str, tool_call_id: &str) {
        let key = (session_id.to_string(), tool_call_id.to_string());
        self.active_bash_cancellations.remove(&key);
        self.pending_bash_aborts.remove(&key);
    }

    /// Remember a desktop-dispatched call so the desktop runner can report its
    /// progress while it executes. The key is what the runtime matches a
    /// `tool_update` against, so it is the call's own identity.
    pub fn begin_desktop_progress(&mut self, session_id: &str, tool_call_id: &str) {
        self.desktop_progress
            .insert((session_id.to_string(), tool_call_id.to_string()), 0);
    }

    /// Close the progress channel of one resolved call. A call that never
    /// reported simply has nothing to remove.
    pub fn end_desktop_progress(&mut self, session_id: &str, tool_call_id: &str) {
        self.desktop_progress
            .remove(&(session_id.to_string(), tool_call_id.to_string()));
    }

    /// Count one accepted progress report, or `None` when this host is not
    /// running that call. Callers apply the per-call budget so a chatty server
    /// cannot turn one call into unbounded traffic.
    pub fn record_desktop_progress(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
    ) -> Option<usize> {
        let reports = self
            .desktop_progress
            .get_mut(&(session_id.to_string(), tool_call_id.to_string()))?;
        *reports += 1;
        Some(*reports)
    }

    fn prune_tool_abort_tombstones(&mut self) {
        self.pending_tool_aborts
            .retain(|_, requested_at| requested_at.elapsed() < TOOL_ABORT_TOMBSTONE_TTL);
        while self.pending_tool_aborts.len() > MAX_TOOL_ABORT_TOMBSTONES {
            let Some(oldest) = self
                .pending_tool_aborts
                .iter()
                .min_by_key(|(_, requested_at)| **requested_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.pending_tool_aborts.remove(&oldest);
        }
    }

    pub fn register_tool_cancellation(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        if self.shutting_down {
            return Err("HOST_SHUTTING_DOWN".into());
        }
        self.prune_tool_abort_tombstones();
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        if self.active_tool_cancellations.contains_key(&key) {
            return Err("TOOL_BUSY".into());
        }
        let initially_aborted = self.pending_tool_aborts.remove(&key).is_some();
        let (sender, receiver) = tokio::sync::watch::channel(initially_aborted);
        self.active_tool_cancellations.insert(key, sender);
        Ok(receiver)
    }

    pub fn abort_or_queue_tool(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) -> (bool, bool) {
        self.prune_tool_abort_tombstones();
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        let active = self
            .active_tool_cancellations
            .get(&key)
            .is_some_and(|sender| sender.send(true).is_ok());
        if active {
            (true, false)
        } else {
            self.pending_tool_aborts.insert(key, Instant::now());
            (false, true)
        }
    }

    pub fn abort_active_tool(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        self.active_tool_cancellations
            .iter()
            .find(|((active_session, active_call, _), _)| {
                active_session == session_id && active_call == tool_call_id
            })
            .is_some_and(|(_, sender)| sender.send(true).is_ok())
    }

    pub fn clear_tool_cancellation(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
    ) {
        let key = (
            session_id.to_string(),
            tool_call_id.to_string(),
            tool_name.to_string(),
        );
        self.active_tool_cancellations.remove(&key);
        self.pending_tool_aborts.remove(&key);
    }

    pub fn shutdown(&mut self) {
        self.shutting_down = true;
        for sender in self.active_bash_cancellations.values() {
            let _ = sender.send(true);
        }
        self.active_bash_cancellations.clear();
        for sender in self.active_tool_cancellations.values() {
            let _ = sender.send(true);
        }
        self.active_tool_cancellations.clear();
        self.pending_tool_aborts.clear();
        // Chat-started background tasks follow the application: signal every
        // running supervisor so its process tree is terminated and reaped.
        crate::background_tasks::stop_all_running_sync(&self.background_tasks);

        let pending_request_ids: Vec<String> = self.pending_permissions.keys().cloned().collect();
        for request_id in pending_request_ids {
            let _ = self.permissions.cancel(&request_id);
        }
        self.pending_permissions.clear();

        self.pending_bash_aborts.clear();
        self.plugin_execs.clear();
        self.desktop_progress.clear();
        self.remote_execs.clear();
    }

    pub fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_cancels_pending_permissions_and_active_bash() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        let (request, _receiver) = state.permissions.create_request(
            "session-1",
            "tool-call-1",
            "Bash",
            serde_json::json!({ "command": "sleep 30" }),
            "test",
        );
        state.register_pending_permission(
            &request.request_id,
            &request.session_id,
            &request.tool_call_id,
        );
        let mut cancellation = state
            .register_bash_cancellation("session-1", "tool-call-2")
            .unwrap();
        let mut tool_cancellation = state
            .register_tool_cancellation("session-1", "tool-call-4", "Write")
            .unwrap();

        state.shutdown();

        assert!(state.pending_permissions.is_empty());
        assert!(state.active_bash_cancellations.is_empty());
        assert!(state.pending_bash_aborts.is_empty());
        assert!(state.active_tool_cancellations.is_empty());
        assert!(state.pending_tool_aborts.is_empty());
        assert!(state.shutting_down);
        assert!(matches!(
            state.register_bash_cancellation("session-1", "tool-call-3"),
            Err(error) if error == "HOST_SHUTTING_DOWN"
        ));
        assert!(*cancellation.borrow_and_update());
        assert!(*tool_cancellation.borrow_and_update());
        assert_eq!(
            state.permissions.resolve(
                &request.request_id,
                crate::permissions::PermissionDecision::Deny,
            ),
            Err("NOT_FOUND".into())
        );
    }

    #[test]
    fn tool_abort_tombstones_are_scoped_to_the_tool_name() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        let mut write = state
            .register_tool_cancellation("session-1", "same-id", "Write")
            .unwrap();

        assert_eq!(
            state.abort_or_queue_tool("session-1", "same-id", "Edit"),
            (false, true)
        );
        assert!(!*write.borrow_and_update());
        state.clear_tool_cancellation("session-1", "same-id", "Write");

        let edit = state
            .register_tool_cancellation("session-1", "same-id", "Edit")
            .unwrap();
        assert!(*edit.borrow());
        assert!(state.pending_tool_aborts.is_empty());
    }

    #[test]
    fn plugin_session_rate_limits_are_per_plugin_and_per_operation() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();

        assert!((0..10).all(|_| state.allow_plugin_import("plugin.one", false)));
        assert!(!state.allow_plugin_import("plugin.one", false));
        assert!(state.allow_plugin_import("plugin.two", false));

        assert!((0..5).all(|_| state.allow_plugin_import("plugin.one", true)));
        assert!(!state.allow_plugin_import("plugin.one", true));
        assert!((0..20).all(|_| state.allow_plugin_delete("plugin.one")));
        assert!(!state.allow_plugin_delete("plugin.one"));
    }

    #[test]
    fn desktop_progress_is_attributable_and_closes_with_the_call() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();

        // A call this host is not running has nothing to attribute a report to.
        assert!(state
            .record_desktop_progress("session-1", "call-1")
            .is_none());

        state.begin_desktop_progress("session-1", "call-1");
        assert_eq!(
            state.record_desktop_progress("session-1", "call-1"),
            Some(1)
        );
        assert_eq!(
            state.record_desktop_progress("session-1", "call-1"),
            Some(2)
        );
        // Neither another call's id nor another session's reaches this channel.
        assert!(state
            .record_desktop_progress("session-1", "call-2")
            .is_none());
        assert!(state
            .record_desktop_progress("session-2", "call-1")
            .is_none());

        // Resolving the call closes it: a late report cannot revive the row.
        state.end_desktop_progress("session-1", "call-1");
        assert!(state
            .record_desktop_progress("session-1", "call-1")
            .is_none());
    }
}
