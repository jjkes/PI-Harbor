use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::json;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

const DEFAULT_REPLAY_RING_BYTES: usize = 128 * 1024;
const DEFAULT_MAX_LIVE_QUEUE: usize = 256;
const DEFAULT_MAX_PER_SESSION: usize = 2;
const SINK_FAILURE_DETACH_THRESHOLD: usize = 3;
const OUTPUT_NOTIFICATION_MAX_BYTES: usize = 32 * 1024;
const EXIT_POLL_MS: u64 = 250;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MIN_COLS_ROWS: u16 = 1;
const MAX_COLS_ROWS: u16 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalState {
    Open,
    Exited,
    Closed,
}

impl TerminalState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TerminalState::Open => "open",
            TerminalState::Exited => "exited",
            TerminalState::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalOpenResult {
    pub terminal_id: String,
    pub replay: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
}

/// Platform-independent handle to one PTY-backed child process.
trait PtyHandle: Send {
    fn write(&mut self, data: &[u8]) -> Result<()>;
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;
    fn interrupt(&mut self) -> Result<()>;
    fn close(&mut self) -> Result<()>;
    fn try_wait(&mut self) -> Result<Option<i32>>;
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize>;
}

struct PortablePtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    writer: Option<Box<dyn Write + Send>>,
    reader: Option<Box<dyn Read + Send>>,
}

impl PtyHandle for PortablePtyHandle {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| anyhow!("pty writer already taken"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    #[cfg(unix)]
    fn interrupt(&mut self) -> Result<()> {
        if let Some(pgid) = self.master.process_group_leader() {
            if send_interrupt_to_process_group(pgid).unwrap_or(false) {
                return Ok(());
            }
        }
        self.write(b"\x03")
    }

    #[cfg(not(unix))]
    fn interrupt(&mut self) -> Result<()> {
        self.write(b"\x03")
    }

    fn close(&mut self) -> Result<()> {
        self.writer.take();
        self.reader.take();
        let _ = self.child.kill();
        Ok(())
    }

    fn try_wait(&mut self) -> Result<Option<i32>> {
        match self.child.try_wait()? {
            Some(status) => Ok(Some(status.exit_code() as i32)),
            None => Ok(None),
        }
    }

    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.reader.as_mut() {
            Some(reader) => reader.read(buf),
            None => Ok(0),
        }
    }
}

#[cfg(unix)]
fn send_interrupt_to_process_group(pgid: libc::pid_t) -> Result<bool> {
    let current_pgrp = unsafe { libc::getpgrp() };
    if pgid <= 0 || pgid == current_pgrp {
        return Ok(false);
    }
    let rc = unsafe { libc::kill(-pgid, libc::SIGINT) };
    if rc != 0 {
        return Ok(false);
    }
    Ok(true)
}

struct Terminal {
    id: String,
    session_id: String,
    cols: u16,
    rows: u16,
    ring: Vec<Vec<u8>>,
    ring_bytes: usize,
    live_queue: Vec<Vec<u8>>,
    max_live_queue: usize,
    pty: Arc<std::sync::Mutex<Box<dyn PtyHandle + Send>>>,
    state: TerminalState,
    exit_code: Option<i32>,
    sink_failures: usize,
    dropped_count: usize,
    dropped_bytes: usize,
    notification_tx: mpsc::UnboundedSender<String>,
    replay_ring_bytes: usize,
}

impl Terminal {
    fn push_output(&mut self, chunk: Vec<u8>) {
        if chunk.is_empty() {
            return;
        }
        self.ring.push(chunk.clone());
        self.ring_bytes += chunk.len();
        while self.ring_bytes > self.replay_ring_bytes && self.ring.len() > 1 {
            let dropped = self.ring.remove(0);
            self.ring_bytes -= dropped.len();
        }
        if self.live_queue.len() >= self.max_live_queue {
            let dropped = self.live_queue.remove(0);
            self.dropped_count += 1;
            self.dropped_bytes += dropped.len();
            tracing::warn!(
                terminal_id = %self.id,
                session_id = %self.session_id,
                dropped_count = self.dropped_count,
                dropped_bytes = self.dropped_bytes,
                "terminal live queue overflow: dropped chunk"
            );
        }
        self.live_queue.push(chunk);
        self.drain_live_queue();
    }

    fn drain_live_queue(&mut self) {
        while !self.live_queue.is_empty() {
            let next = self.live_queue.first().unwrap().clone();
            let encoded = B64.encode(&next);
            let params = json!({
                "terminalId": self.id,
                "sessionId": self.session_id,
                "output": encoded,
            });
            let note = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "terminal.output",
                "params": params,
            });
            if let Ok(raw) = serde_json::to_string(&note) {
                if self.notification_tx.send(format!("{raw}\n")).is_ok() {
                    self.live_queue.remove(0);
                    self.sink_failures = 0;
                } else {
                    self.sink_failures += 1;
                    if self.sink_failures >= SINK_FAILURE_DETACH_THRESHOLD {
                        for chunk in &self.live_queue {
                            self.dropped_count += 1;
                            self.dropped_bytes += chunk.len();
                        }
                        tracing::warn!(
                            terminal_id = %self.id,
                            session_id = %self.session_id,
                            dropped_count = self.dropped_count,
                            dropped_bytes = self.dropped_bytes,
                            "terminal live queue dropped: sink detached"
                        );
                        self.live_queue.clear();
                    }
                    break;
                }
            }
        }
    }

    fn emit_changed(&self, state: TerminalState, exit_code: Option<i32>) {
        let params = json!({
            "terminalId": self.id,
            "sessionId": self.session_id,
            "state": state.as_str(),
            "exitCode": exit_code,
        });
        let note = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "terminal.changed",
            "params": params,
        });
        if let Ok(raw) = serde_json::to_string(&note) {
            let _ = self.notification_tx.send(format!("{raw}\n"));
        }
    }

    fn snapshot(&self) -> TerminalOpenResult {
        TerminalOpenResult {
            terminal_id: self.id.clone(),
            replay: self.ring.iter().flat_map(|c| c.clone()).collect(),
            cols: self.cols,
            rows: self.rows,
            pid: None,
        }
    }
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Mutex<TerminalManagerInner>>,
}

struct TerminalManagerInner {
    terminals: HashMap<String, Terminal>,
    notification_tx: Option<mpsc::UnboundedSender<String>>,
    replay_ring_bytes: usize,
    max_per_session: usize,
    max_live_queue: usize,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalManagerInner {
                terminals: HashMap::new(),
                notification_tx: None,
                replay_ring_bytes: DEFAULT_REPLAY_RING_BYTES,
                max_per_session: DEFAULT_MAX_PER_SESSION,
                max_live_queue: DEFAULT_MAX_LIVE_QUEUE,
            })),
        }
    }

    pub async fn set_notification_tx(&self, tx: mpsc::UnboundedSender<String>) {
        let mut inner = self.inner.lock().await;
        inner.notification_tx = Some(tx);
    }

    #[cfg(test)]
    pub fn with_config(
        replay_ring_bytes: usize,
        max_per_session: usize,
        max_live_queue: usize,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalManagerInner {
                terminals: HashMap::new(),
                notification_tx: None,
                replay_ring_bytes,
                max_per_session,
                max_live_queue,
            })),
        }
    }

    pub fn open(
        &self,
        db: &crate::db::Database,
        session_id: &str,
        cols: u16,
        rows: u16,
        user_confirmed: bool,
    ) -> impl std::future::Future<Output = Result<TerminalOpenResult>> + Send + '_ {
        let session_id = session_id.to_string();
        let cwd = (|| -> Result<String> {
            validate_terminal_dimensions(cols, rows)?;
            if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
                return Err(anyhow!(
                    "remote or native-pi sessions cannot open local terminals"
                ));
            }
            if !user_confirmed {
                return Err(anyhow!("terminal open requires explicit user confirmation"));
            }
            let summary = crate::sessions::session_summary(db, &session_id)?
                .ok_or_else(|| anyhow!("session not found"))?;
            let cwd = summary
                .project_path
                .as_deref()
                .ok_or_else(|| anyhow!("session has no project path"))?;
            if cwd.starts_with("remote-project:") {
                return Err(anyhow!(
                    "remote project sessions cannot open local terminals"
                ));
            }
            let cwd = std::fs::canonicalize(cwd)
                .map_err(|e| anyhow!("failed to canonicalize project path: {e}"))?;
            if !cwd.is_dir() {
                return Err(anyhow!("project path is not a directory"));
            }
            cwd.into_os_string()
                .into_string()
                .map_err(|_| anyhow!("project path is not valid utf-8"))
        })();

        async move {
            let cwd = cwd?;
            let mut inner = self.inner.lock().await;
            let open_count = inner
                .terminals
                .values()
                .filter(|t| t.session_id == session_id && t.state == TerminalState::Open)
                .count();
            if open_count >= inner.max_per_session {
                return Err(anyhow!("terminal limit reached for this session"));
            }

            let tx = inner
                .notification_tx
                .as_ref()
                .ok_or_else(|| anyhow!("terminal notification channel is not ready"))?
                .clone();

            let (pty, pid) = spawn_pty(&cwd, cols, rows)?;
            let terminal_id = format!("term_{}", Uuid::new_v4());
            let terminal = Terminal {
                id: terminal_id.clone(),
                session_id: session_id.clone(),
                cols,
                rows,
                ring: Vec::new(),
                ring_bytes: 0,
                live_queue: Vec::new(),
                max_live_queue: inner.max_live_queue,
                pty: Arc::new(std::sync::Mutex::new(pty)),
                state: TerminalState::Open,
                exit_code: None,
                sink_failures: 0,
                dropped_count: 0,
                dropped_bytes: 0,
                notification_tx: tx.clone(),
                replay_ring_bytes: inner.replay_ring_bytes,
            };

            inner.terminals.insert(terminal_id.clone(), terminal);
            let snapshot = inner.terminals[&terminal_id].snapshot();
            inner.terminals[&terminal_id].emit_changed(TerminalState::Open, None);
            drop(inner);

            let manager = self.clone();
            let tid = terminal_id.clone();
            tokio::spawn(async move {
                manager.run_reader(tid).await;
            });

            let manager = self.clone();
            let tid = terminal_id.clone();
            tokio::spawn(async move {
                manager.watch_exit(tid).await;
            });

            let mut snapshot = snapshot;
            snapshot.pid = pid;
            Ok(snapshot)
        }
    }

    pub async fn input(&self, terminal_id: &str, session_id: &str, data: &str) -> Result<()> {
        if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
            return Err(anyhow!(
                "remote or native-pi sessions cannot use local terminals"
            ));
        }
        let bytes = B64
            .decode(data)
            .map_err(|_| anyhow!("input data is not valid base64"))?;
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(anyhow!("input data exceeds {MAX_INPUT_BYTES} byte limit"));
        }
        let pty = {
            let inner = self.inner.lock().await;
            let terminal = inner
                .terminals
                .get(terminal_id)
                .ok_or_else(|| anyhow!("terminal not found"))?;
            if terminal.session_id != session_id {
                return Err(anyhow!("terminal does not belong to this session"));
            }
            if terminal.state != TerminalState::Open {
                return Err(anyhow!("terminal is not open"));
            }
            terminal.pty.clone()
        };
        pty.lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?
            .write(&bytes)?;
        Ok(())
    }

    pub async fn resize(
        &self,
        terminal_id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        validate_terminal_dimensions(cols, rows)?;
        if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
            return Err(anyhow!(
                "remote or native-pi sessions cannot use local terminals"
            ));
        }
        let pty = {
            let inner = self.inner.lock().await;
            let terminal = inner
                .terminals
                .get(terminal_id)
                .ok_or_else(|| anyhow!("terminal not found"))?;
            if terminal.session_id != session_id {
                return Err(anyhow!("terminal does not belong to this session"));
            }
            if terminal.state != TerminalState::Open {
                return Err(anyhow!("terminal is not open"));
            }
            terminal.pty.clone()
        };
        pty.lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?
            .resize(cols, rows)?;
        {
            let mut inner = self.inner.lock().await;
            if let Some(terminal) = inner.terminals.get_mut(terminal_id) {
                terminal.cols = cols;
                terminal.rows = rows;
            }
        }
        Ok(())
    }

    pub async fn interrupt(&self, terminal_id: &str, session_id: &str) -> Result<()> {
        if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
            return Err(anyhow!(
                "remote or native-pi sessions cannot use local terminals"
            ));
        }
        let pty = {
            let inner = self.inner.lock().await;
            let terminal = inner
                .terminals
                .get(terminal_id)
                .ok_or_else(|| anyhow!("terminal not found"))?;
            if terminal.session_id != session_id {
                return Err(anyhow!("terminal does not belong to this session"));
            }
            if terminal.state != TerminalState::Open {
                return Err(anyhow!("terminal is not open"));
            }
            terminal.pty.clone()
        };
        pty.lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?
            .interrupt()?;
        Ok(())
    }

    pub async fn close(&self, terminal_id: &str, session_id: &str) -> Result<String> {
        if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
            return Err(anyhow!(
                "remote or native-pi sessions cannot use local terminals"
            ));
        }
        let pty = {
            let mut inner = self.inner.lock().await;
            let Some(terminal) = inner.terminals.get_mut(terminal_id) else {
                return Ok(terminal_id.to_string());
            };
            if terminal.session_id != session_id {
                return Err(anyhow!("terminal does not belong to this session"));
            }
            terminal.state = TerminalState::Closed;
            terminal.emit_changed(TerminalState::Closed, None);
            terminal.pty.clone()
        };
        let close_result = pty
            .lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?
            .close();
        {
            let mut inner = self.inner.lock().await;
            inner.terminals.remove(terminal_id);
        }
        if let Err(e) = close_result {
            tracing::warn!(
                terminal_id = %terminal_id,
                error = %e,
                "terminal pty close failed"
            );
        }
        Ok(terminal_id.to_string())
    }

    pub async fn close_all_for_session(&self, session_id: &str) -> Result<Vec<String>> {
        if session_id.starts_with("remote:") || session_id.starts_with("native-pi:") {
            return Err(anyhow!(
                "remote or native-pi sessions cannot use local terminals"
            ));
        }
        let ids: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .terminals
                .values()
                .filter(|t| t.session_id == session_id && t.state != TerminalState::Closed)
                .map(|t| t.id.clone())
                .collect()
        };
        let mut closed = Vec::new();
        for id in ids {
            if let Ok(tid) = self.close(&id, session_id).await {
                closed.push(tid);
            }
        }
        Ok(closed)
    }

    pub async fn close_all(&self) -> Vec<(String, String)> {
        let ids: Vec<(String, String)> = {
            let inner = self.inner.lock().await;
            inner
                .terminals
                .values()
                .filter(|t| t.state != TerminalState::Closed)
                .map(|t| (t.id.clone(), t.session_id.clone()))
                .collect()
        };
        let mut closed = Vec::new();
        for (id, session_id) in ids {
            if let Ok(tid) = self.close(&id, &session_id).await {
                closed.push((tid, session_id));
            }
        }
        closed
    }

    async fn run_reader(&self, terminal_id: String) {
        let mut buf = vec![0u8; OUTPUT_NOTIFICATION_MAX_BYTES];
        loop {
            let pty = {
                let inner = self.inner.lock().await;
                let Some(terminal) = inner.terminals.get(&terminal_id) else {
                    return;
                };
                if terminal.state != TerminalState::Open {
                    return;
                }
                terminal.pty.clone()
            };

            let read_result = tokio::task::spawn_blocking({
                let mut buf = std::mem::take(&mut buf);
                move || {
                    let mut pty = pty.lock().map_err(|_| anyhow!("pty lock poisoned"))?;
                    let n = pty.read(&mut buf)?;
                    Ok::<(Vec<u8>, usize), anyhow::Error>((buf, n))
                }
            })
            .await;

            match read_result {
                Ok(Ok((returned_buf, n))) => {
                    buf = returned_buf;
                    if n == 0 {
                        return;
                    }
                    let chunk = buf[..n].to_vec();
                    let mut inner = self.inner.lock().await;
                    if let Some(terminal) = inner.terminals.get_mut(&terminal_id) {
                        if terminal.state == TerminalState::Open {
                            terminal.push_output(chunk);
                        } else {
                            return;
                        }
                    } else {
                        return;
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    return;
                }
            }
        }
    }

    async fn watch_exit(&self, terminal_id: String) {
        loop {
            let pty = {
                let inner = self.inner.lock().await;
                let Some(terminal) = inner.terminals.get(&terminal_id) else {
                    return;
                };
                if terminal.state != TerminalState::Open {
                    return;
                }
                terminal.pty.clone()
            };

            let exited = tokio::task::spawn_blocking(move || {
                let mut pty = pty.lock().map_err(|_| anyhow!("pty lock poisoned"))?;
                pty.try_wait()
            })
            .await;

            match exited {
                Ok(Ok(Some(code))) => {
                    let mut inner = self.inner.lock().await;
                    if let Some(terminal) = inner.terminals.get_mut(&terminal_id) {
                        if terminal.state == TerminalState::Open {
                            terminal.state = TerminalState::Exited;
                            terminal.exit_code = Some(code);
                            terminal.emit_changed(TerminalState::Exited, Some(code));
                        }
                    }
                    return;
                }
                Ok(Ok(None)) => {
                    tokio::time::sleep(std::time::Duration::from_millis(EXIT_POLL_MS)).await;
                }
                Ok(Err(_)) | Err(_) => {
                    return;
                }
            }
        }
    }
}

fn validate_terminal_dimensions(cols: u16, rows: u16) -> Result<()> {
    if !(MIN_COLS_ROWS..=MAX_COLS_ROWS).contains(&cols) {
        return Err(anyhow!(
            "cols must be between {MIN_COLS_ROWS} and {MAX_COLS_ROWS}"
        ));
    }
    if !(MIN_COLS_ROWS..=MAX_COLS_ROWS).contains(&rows) {
        return Err(anyhow!(
            "rows must be between {MIN_COLS_ROWS} and {MAX_COLS_ROWS}"
        ));
    }
    Ok(())
}

fn spawn_pty(cwd: &str, cols: u16, rows: u16) -> Result<(Box<dyn PtyHandle + Send>, Option<u32>)> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system.openpty(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let shell = std::env::var("SHELL")
        .unwrap_or_else(|_| if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.to_string());
    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    cmd.cwd(std::path::PathBuf::from(cwd));
    cmd.env_clear();
    for (key, value) in build_terminal_env() {
        cmd.env(key, value);
    }
    let child = pair.slave.spawn_command(cmd)?;
    let pid = child.process_id();

    let writer = pair.master.take_writer()?;
    let reader = pair.master.try_clone_reader()?;

    let handle = PortablePtyHandle {
        master: pair.master,
        child,
        writer: Some(writer),
        reader: Some(reader),
    };

    Ok((Box::new(handle), pid))
}

fn build_terminal_env() -> HashMap<String, String> {
    let mut whitelist: Vec<&str> = vec![
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TERM",
        "LANG",
        "TZ",
        "TMPDIR",
        "XPC_FLAGS",
        "__CF_USER_TEXT_ENCODING",
    ];
    if cfg!(windows) {
        whitelist.extend_from_slice(&[
            "PATHEXT",
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "HOMEDRIVE",
            "HOMEPATH",
            "USERNAME",
            "USERPROFILE",
            "COMPUTERNAME",
            "WINDIR",
            "PI_*",
        ]);
    } else {
        whitelist.push("PI_*");
    }

    let mut env = HashMap::new();
    for (key, value) in std::env::vars() {
        if whitelist.iter().any(|prefix| {
            if *prefix == "PI_*" {
                key.starts_with("PI_")
            } else if let Some(stripped) = prefix.strip_suffix('*') {
                key.starts_with(stripped)
            } else {
                key == *prefix
            }
        }) {
            env.insert(key, value);
        }
    }
    env
}

#[cfg(test)]
mod tests;
