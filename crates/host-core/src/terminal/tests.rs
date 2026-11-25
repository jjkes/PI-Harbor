use base64::engine::general_purpose::STANDARD as B64;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::*;
use crate::db::Database;

struct FakePtyHandle {
    output: Arc<Mutex<VecDeque<u8>>>,
    written: Arc<Mutex<Vec<u8>>>,
    resized: Arc<Mutex<Vec<(u16, u16)>>>,
    interrupted: Arc<Mutex<bool>>,
    closed: Arc<Mutex<bool>>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl PtyHandle for FakePtyHandle {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.written.lock().unwrap().extend_from_slice(data);
        // Echo the input back as output, plus a prompt marker for tests.
        self.output.lock().unwrap().extend(data.iter().copied());
        self.output.lock().unwrap().push_back(b'>');
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.resized.lock().unwrap().push((cols, rows));
        Ok(())
    }

    fn interrupt(&mut self) -> Result<()> {
        *self.interrupted.lock().unwrap() = true;
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        *self.closed.lock().unwrap() = true;
        Ok(())
    }

    fn try_wait(&mut self) -> Result<Option<i32>> {
        Ok(*self.exit_code.lock().unwrap())
    }

    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| std::io::Error::other("output lock poisoned"))?;
        if output.is_empty() {
            // Block briefly to simulate a live pty; tests drive output through write().
            std::thread::sleep(std::time::Duration::from_millis(10));
            return Ok(0);
        }
        let mut n = 0;
        while n < buf.len() && !output.is_empty() {
            buf[n] = output.pop_front().unwrap();
            n += 1;
        }
        Ok(n)
    }
}

type FakePtyParts = (
    Box<dyn PtyHandle + Send>,
    Arc<Mutex<Vec<u8>>>,
    Arc<Mutex<Vec<(u16, u16)>>>,
    Arc<Mutex<bool>>,
    Arc<Mutex<bool>>,
    Arc<Mutex<Option<i32>>>,
);

fn make_fake_pty() -> FakePtyParts {
    let output = Arc::new(Mutex::new(VecDeque::new()));
    let written = Arc::new(Mutex::new(Vec::new()));
    let resized = Arc::new(Mutex::new(Vec::new()));
    let interrupted = Arc::new(Mutex::new(false));
    let closed = Arc::new(Mutex::new(false));
    let exit_code = Arc::new(Mutex::new(None));
    let handle = FakePtyHandle {
        output,
        written: written.clone(),
        resized: resized.clone(),
        interrupted: interrupted.clone(),
        closed: closed.clone(),
        exit_code: exit_code.clone(),
    };
    (
        Box::new(handle),
        written,
        resized,
        interrupted,
        closed,
        exit_code,
    )
}

async fn setup() -> (crate::state::AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::open(dir.path()).unwrap();
    let (tx, _rx) = mpsc::unbounded_channel();
    state.terminal.set_notification_tx(tx).await;
    (state, dir)
}

fn create_session(db: &Database, project_path: &str) -> String {
    crate::sessions::create_session(
        db,
        Some("test session".into()),
        Some("agent".into()),
        None,
        None,
        Some(project_path.into()),
    )
    .unwrap()
    .id
}

async fn inject_terminal(
    manager: &TerminalManager,
    terminal_id: &str,
    session_id: &str,
    pty: Box<dyn PtyHandle + Send>,
) {
    let notification_tx = {
        let inner = manager.inner.lock().await;
        inner.notification_tx.as_ref().unwrap().clone()
    };
    inject_terminal_with_tx(manager, terminal_id, session_id, pty, notification_tx).await;
}

async fn inject_terminal_with_tx(
    manager: &TerminalManager,
    terminal_id: &str,
    session_id: &str,
    pty: Box<dyn PtyHandle + Send>,
    notification_tx: mpsc::UnboundedSender<String>,
) {
    let mut inner = manager.inner.lock().await;
    let max_live_queue = inner.max_live_queue;
    let replay_ring_bytes = inner.replay_ring_bytes;
    inner.terminals.insert(
        terminal_id.to_string(),
        Terminal {
            id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            cols: 80,
            rows: 24,
            ring: Vec::new(),
            ring_bytes: 0,
            live_queue: Vec::new(),
            max_live_queue,
            pty: Arc::new(std::sync::Mutex::new(pty)),
            state: TerminalState::Open,
            exit_code: None,
            sink_failures: 0,
            dropped_count: 0,
            dropped_bytes: 0,
            notification_tx,
            replay_ring_bytes,
        },
    );
}

#[tokio::test]
async fn open_requires_user_confirmation() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);
    let result = state
        .terminal
        .open(&state.db, &session_id, 80, 24, false)
        .await;
    assert!(result.is_err());
    let msg = result.unwrap_err().to_string();
    assert!(msg.contains("explicit user confirmation"), "{msg}");
}

#[tokio::test]
async fn open_rejects_missing_session() {
    let (state, _dir) = setup().await;
    let result = state
        .terminal
        .open(&state.db, "no-such-session", 80, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("session not found"));
}

#[tokio::test]
async fn open_rejects_session_without_project_path() {
    let (state, _dir) = setup().await;
    let session_id = crate::sessions::create_session(
        &state.db,
        Some("test session".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap()
    .id;
    let result = state
        .terminal
        .open(&state.db, &session_id, 80, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("session has no project path"));
}

#[tokio::test]
async fn open_canonicalizes_and_rejects_non_directory_project_path() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("not-a-dir");
    std::fs::write(&file_path, b"x").unwrap();
    let session_id = create_session(&state.db, file_path.to_str().unwrap());
    let result = state
        .terminal
        .open(&state.db, &session_id, 80, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("project path is not a directory"));
}

#[tokio::test]
async fn open_rejects_out_of_bounds_dimensions() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let result = state
        .terminal
        .open(&state.db, &session_id, 0, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("cols"));

    let result = state
        .terminal
        .open(&state.db, &session_id, 80, 1001, true)
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("rows"));
}

#[tokio::test]
async fn cross_session_input_is_rejected() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_a = create_session(&state.db, path);
    let session_b = create_session(&state.db, path);

    let (pty, _written, _resized, _interrupted, _closed, _exit_code) = make_fake_pty();
    let terminal_id = "term-test-a".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_a, pty).await;

    let result = state
        .terminal
        .input(&terminal_id, &session_b, B64.encode("x").as_str())
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("does not belong to this session"));
}

#[tokio::test]
async fn io_resize_interrupt_close_lifecycle() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, written, resized, interrupted, closed, _exit_code) = make_fake_pty();
    let terminal_id = "term-test-io".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    // Input
    state
        .terminal
        .input(&terminal_id, &session_id, &B64.encode("hello"))
        .await
        .unwrap();
    assert_eq!(&*written.lock().unwrap(), b"hello");

    // Resize
    state
        .terminal
        .resize(&terminal_id, &session_id, 100, 30)
        .await
        .unwrap();
    assert_eq!(&*resized.lock().unwrap(), &[(100, 30)]);

    // Interrupt
    state
        .terminal
        .interrupt(&terminal_id, &session_id)
        .await
        .unwrap();
    assert!(*interrupted.lock().unwrap());

    // Close
    state
        .terminal
        .close(&terminal_id, &session_id)
        .await
        .unwrap();
    assert!(*closed.lock().unwrap());

    // Operations after close fail because the terminal was removed.
    assert!(state
        .terminal
        .input(&terminal_id, &session_id, &B64.encode("x"))
        .await
        .is_err());
}

#[tokio::test]
async fn replay_ring_is_bounded() {
    let manager = TerminalManager::with_config(10, 2, 16);
    let (tx, _rx) = mpsc::unbounded_channel();
    manager.set_notification_tx(tx).await;

    let (pty, _written, _resized, _interrupted, _closed, _exit_code) = make_fake_pty();
    let terminal_id = "term-test-ring".to_string();
    inject_terminal(&manager, &terminal_id, "session-ring", pty).await;

    // Push chunks directly to the ring.
    {
        let mut inner = manager.inner.lock().await;
        let terminal = inner.terminals.get_mut(&terminal_id).unwrap();
        terminal.push_output(vec![b'a'; 8]);
        terminal.push_output(vec![b'b'; 8]);
        terminal.push_output(vec![b'c'; 8]);
    }

    let snapshot = {
        let inner = manager.inner.lock().await;
        inner.terminals[&terminal_id].snapshot()
    };
    // The ring keeps the tail within the byte budget.
    assert!(
        snapshot.replay.len() <= 10,
        "replay exceeded budget: {}",
        snapshot.replay.len()
    );
    assert!(snapshot.replay.iter().all(|&b| b == b'b' || b == b'c'));
}

#[tokio::test]
async fn close_all_for_session_cleans_up_open_terminals() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let mut ids = Vec::new();
    for i in 0..2 {
        let (pty, _written, _resized, _interrupted, _closed, _exit_code) = make_fake_pty();
        let terminal_id = format!("term-cleanup-{i}");
        inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;
        ids.push(terminal_id);
    }

    let closed = state
        .terminal
        .close_all_for_session(&session_id)
        .await
        .unwrap();
    assert_eq!(closed.len(), 2);

    let inner = state.terminal.inner.lock().await;
    for id in ids {
        assert!(
            !inner.terminals.contains_key(&id),
            "terminal {id} was not removed"
        );
    }
}

#[tokio::test]
async fn close_all_for_session_rejects_remote_and_native_pi_sessions() {
    let manager = TerminalManager::new();
    let result = manager.close_all_for_session("remote:host:sess").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("remote or native-pi sessions cannot use local terminals"));

    let result = manager.close_all_for_session("native-pi:some-id").await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("remote or native-pi sessions cannot use local terminals"));
}

#[tokio::test]
async fn max_per_session_is_enforced() {
    let manager = TerminalManager::with_config(1024, 1, 16);
    let (tx, _rx) = mpsc::unbounded_channel();
    manager.set_notification_tx(tx).await;

    let dir = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::open(dir.path()).unwrap();
    state
        .terminal
        .set_notification_tx(mpsc::unbounded_channel().0)
        .await;

    let project_dir = tempfile::tempdir().unwrap();
    let path = project_dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    // Use the manager directly with fake terminals to bypass PTY spawn.
    let first_id = {
        let (pty, _, _, _, _, _) = make_fake_pty();
        let id = "term-limit-1".to_string();
        inject_terminal(&manager, &id, &session_id, pty).await;
        id
    };

    let result = manager.open(&state.db, &session_id, 80, 24, true).await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("terminal limit reached"));

    // Closing the first terminal frees the slot.
    {
        let mut inner = manager.inner.lock().await;
        if let Some(t) = inner.terminals.get_mut(&first_id) {
            t.state = TerminalState::Closed;
        }
    }

    let result = manager.open(&state.db, &session_id, 80, 24, true).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn close_rejects_cross_session_ownership() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_a = create_session(&state.db, path);
    let session_b = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-close-x".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_a, pty).await;

    let result = state.terminal.close(&terminal_id, &session_b).await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("does not belong to this session"));

    // Owner can still close it.
    state
        .terminal
        .close(&terminal_id, &session_a)
        .await
        .unwrap();
}

#[tokio::test]
async fn close_is_idempotent_and_removes_terminal_from_map() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-close-idempotent".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    state
        .terminal
        .close(&terminal_id, &session_id)
        .await
        .unwrap();
    {
        let inner = state.terminal.inner.lock().await;
        assert!(
            !inner.terminals.contains_key(&terminal_id),
            "terminal was not removed on first close"
        );
    }

    // Second close on the same id is idempotent.
    let result = state.terminal.close(&terminal_id, &session_id).await;
    assert!(result.is_ok());

    // Close on an unknown id is also idempotent.
    let result = state
        .terminal
        .close("term-does-not-exist", &session_id)
        .await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn resize_updates_stored_dimensions() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-resize-dims".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    state
        .terminal
        .resize(&terminal_id, &session_id, 132, 43)
        .await
        .unwrap();

    let inner = state.terminal.inner.lock().await;
    let terminal = &inner.terminals[&terminal_id];
    assert_eq!(terminal.cols, 132);
    assert_eq!(terminal.rows, 43);
}

#[tokio::test]
async fn resize_rejects_out_of_bounds_dimensions() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-resize-bounds".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    let result = state
        .terminal
        .resize(&terminal_id, &session_id, 0, 24)
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("cols"));

    let result = state
        .terminal
        .resize(&terminal_id, &session_id, 80, 1001)
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("rows"));
}

#[tokio::test]
async fn live_queue_drops_when_sink_is_disconnected() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-sink-drop".to_string();
    // A closed channel fails sends immediately.
    let (tx, _rx) = mpsc::unbounded_channel::<String>();
    drop(_rx);
    inject_terminal_with_tx(&state.terminal, &terminal_id, &session_id, pty, tx).await;

    {
        let mut inner = state.terminal.inner.lock().await;
        let terminal = inner.terminals.get_mut(&terminal_id).unwrap();
        for i in 0..3 {
            terminal.push_output(vec![b'x'; 16]);
            assert_eq!(terminal.sink_failures, i + 1);
        }
        // After the threshold the live queue is abandoned so it stops growing.
        assert!(terminal.live_queue.is_empty());
        assert!(terminal.dropped_count > 0);
        assert!(terminal.dropped_bytes > 0);
    }
}

#[tokio::test]
async fn close_all_teardown_closes_every_open_terminal() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_a = create_session(&state.db, path);
    let session_b = create_session(&state.db, path);

    let mut ids = Vec::new();
    for (i, session_id) in [&session_a, &session_b].iter().enumerate() {
        let (pty, _, _, _, _, _) = make_fake_pty();
        let terminal_id = format!("term-teardown-{i}");
        inject_terminal(&state.terminal, &terminal_id, session_id, pty).await;
        ids.push(terminal_id);
    }

    let closed = state.terminal.close_all().await;
    assert_eq!(closed.len(), 2);

    let inner = state.terminal.inner.lock().await;
    for id in ids {
        assert!(
            !inner.terminals.contains_key(&id),
            "terminal {id} was not removed"
        );
    }
}

#[tokio::test]
async fn input_rejects_invalid_base64() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-b64".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    let result = state
        .terminal
        .input(&terminal_id, &session_id, "not-base64!!!")
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("input data is not valid base64"));
}

#[tokio::test]
async fn input_rejects_oversized_payload() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    let terminal_id = "term-input-size".to_string();
    inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;

    let oversized = vec![b'x'; MAX_INPUT_BYTES + 1];
    let encoded = B64.encode(&oversized);
    let result = state
        .terminal
        .input(&terminal_id, &session_id, &encoded)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("exceeds 65536 byte limit"));
}

#[tokio::test]
async fn open_rejects_remote_session() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    // A real local session exists, but the id used for open is remote-prefixed.
    create_session(&state.db, path);
    let result = state
        .terminal
        .open(&state.db, "remote:host:sess", 80, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("remote or native-pi sessions cannot open local terminals"));
}

#[tokio::test]
async fn open_rejects_native_pi_session() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    create_session(&state.db, path);
    let result = state
        .terminal
        .open(&state.db, "native-pi:some-id", 80, 24, true)
        .await;
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("remote or native-pi sessions cannot open local terminals"));
}

#[tokio::test]
async fn environment_whitelist_strips_secret_variables() {
    std::env::set_var("SECRET_ENV", "top-secret");
    std::env::set_var("PI_ALLOWED", "visible");
    let env = build_terminal_env();
    assert!(
        !env.contains_key("SECRET_ENV"),
        "SECRET_ENV must be stripped from terminal environment"
    );
    assert_eq!(env.get("PI_ALLOWED").map(String::as_str), Some("visible"));
}

#[tokio::test]
#[cfg(unix)]
async fn interrupt_fallback_when_pgid_is_unsafe() {
    let current_pgrp = unsafe { libc::getpgrp() };
    // Targeting the current process group is unsafe and must fall back.
    assert!(
        !send_interrupt_to_process_group(current_pgrp).unwrap(),
        "interrupt must not target current process group"
    );
    // Non-positive pgids are unsafe and must fall back.
    assert!(!send_interrupt_to_process_group(0).unwrap());
    assert!(!send_interrupt_to_process_group(-1).unwrap());
}

#[tokio::test]
async fn session_delete_triggers_terminal_cleanup() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    for i in 0..2 {
        let (pty, _, _, _, _, _) = make_fake_pty();
        let terminal_id = format!("term-delete-cleanup-{i}");
        inject_terminal(&state.terminal, &terminal_id, &session_id, pty).await;
    }

    state
        .terminal
        .close_all_for_session(&session_id)
        .await
        .unwrap();
    crate::rpc::drop_session_side_data(&state, &session_id);

    let inner = state.terminal.inner.lock().await;
    assert_eq!(
        inner
            .terminals
            .values()
            .filter(|t| t.session_id == session_id)
            .count(),
        0,
        "session.delete must close all session terminals"
    );
}

#[tokio::test]
async fn close_all_includes_exited_terminals() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_a = create_session(&state.db, path);
    let session_b = create_session(&state.db, path);

    let mut ids = Vec::new();
    for (i, session_id) in [&session_a, &session_b].iter().enumerate() {
        let (pty, _, _, _, _, exit_code) = make_fake_pty();
        let terminal_id = format!("term-exited-{i}");
        inject_terminal(&state.terminal, &terminal_id, session_id, pty).await;
        if i == 0 {
            *exit_code.lock().unwrap() = Some(0);
            // Give watch_exit a moment to observe the exit.
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }
        ids.push(terminal_id);
    }

    let closed = state.terminal.close_all().await;
    assert_eq!(
        closed.len(),
        2,
        "close_all must clean up open and exited terminals"
    );

    let inner = state.terminal.inner.lock().await;
    for id in ids {
        assert!(
            !inner.terminals.contains_key(&id),
            "terminal {id} was not removed"
        );
    }
}

#[tokio::test]
async fn close_all_for_session_includes_exited_terminals() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);
    let other_session = create_session(&state.db, path);

    let open_id = {
        let (pty, _, _, _, _, _) = make_fake_pty();
        let id = "term-session-open".to_string();
        inject_terminal(&state.terminal, &id, &session_id, pty).await;
        id
    };
    let exited_id = {
        let (pty, _, _, _, _, exit_code) = make_fake_pty();
        let id = "term-session-exited".to_string();
        inject_terminal(&state.terminal, &id, &session_id, pty).await;
        *exit_code.lock().unwrap() = Some(1);
        id
    };
    let other_id = {
        let (pty, _, _, _, _, _) = make_fake_pty();
        let id = "term-other-session".to_string();
        inject_terminal(&state.terminal, &id, &other_session, pty).await;
        id
    };

    tokio::time::sleep(std::time::Duration::from_millis(60)).await;

    let closed = state
        .terminal
        .close_all_for_session(&session_id)
        .await
        .unwrap();
    assert_eq!(closed.len(), 2);
    assert!(closed.contains(&open_id));
    assert!(closed.contains(&exited_id));

    let inner = state.terminal.inner.lock().await;
    assert!(!inner.terminals.contains_key(&open_id));
    assert!(!inner.terminals.contains_key(&exited_id));
    assert!(inner.terminals.contains_key(&other_id));
}

#[tokio::test]
async fn close_all_is_idempotent() {
    let (state, _dir) = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    let session_id = create_session(&state.db, path);

    let (pty, _, _, _, _, _) = make_fake_pty();
    inject_terminal(&state.terminal, "term-idem", &session_id, pty).await;

    assert_eq!(state.terminal.close_all().await.len(), 1);
    assert!(state.terminal.close_all().await.is_empty());
}
