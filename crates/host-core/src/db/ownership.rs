//! Exclusion between host-core processes over one app data directory.
//!
//! Boot maintenance treats every `running` turn as belonging to a process that
//! is gone: it aborts the turn, interrupts its task runs, and interrupts the
//! Plan and collaboration work it owned. That reading is only true while one
//! host-core serves the directory.
//!
//! It is not guaranteed. The renderer's single-instance lock is skipped when
//! `PI_HARBOR_DATA_DIR` is set (`installation.ts`), which is how E2E harnesses
//! and side-by-side profiles run; a development host launched that way opens
//! the same database as a running installation. Its boot sweep then closes the
//! other host's live turn. Every tool that does not re-validate the turn keeps
//! working against the live runtime, but `TodoWrite` does re-validate
//! (`todos::replace_tx`), so the checklist fails with `TOOL_TURN_CANCELLED`
//! for the rest of that turn — the caller sees one red tool row per retry.
//!
//! The lock here is the honest answer to "is another host-core serving this
//! directory right now?". It is advisory, exclusive, and released by the
//! operating system when the holder exits, so a crashed holder never wedges the
//! next start and no process epoch has to be persisted. The boot recovery of
//! live work is the owner's job alone; everything else in boot maintenance is
//! idempotent maintenance that any process may run.

use std::fs::{File, OpenOptions};
use std::path::Path;

/// Held for as long as this process serves the data directory.
///
/// Dropping it — or exiting, however the process exits — releases the lock.
pub(crate) struct DataDirOwnership {
    _file: File,
}

impl DataDirOwnership {
    /// Take ownership of `data_dir`, or report that another live host-core
    /// already holds it.
    ///
    /// The lock file itself is left in place: an empty, unlocked
    /// `host-core.lock` carries no meaning, and removing it would race a
    /// concurrent acquirer.
    pub(crate) fn try_acquire(data_dir: &Path) -> std::io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(data_dir.join("host-core.lock"))?;
        if lock_exclusive(&file)? {
            Ok(Some(Self { _file: file }))
        } else {
            Ok(None)
        }
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> std::io::Result<bool> {
    use std::os::unix::io::AsRawFd;

    // SAFETY: the descriptor is owned by `file` and stays open for the call.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if locked == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(false);
    }
    Err(error)
}

#[cfg(windows)]
fn lock_exclusive(file: &File) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    // SAFETY: `OVERLAPPED` is a plain POD structure; zeroing it is the
    // documented initial state for a whole-file lock, and the handle stays
    // owned by `file` for the call.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let locked = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if locked != 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        return Ok(false);
    }
    Err(error)
}

/// Platforms without an advisory file lock this crate can take keep the
/// previous behavior: every host-core believes it owns the directory.
#[cfg(not(any(unix, windows)))]
fn lock_exclusive(_file: &File) -> std::io::Result<bool> {
    Ok(true)
}
