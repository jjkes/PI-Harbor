//! Net per-file diff across a session's recorded Write/Edit snapshots.
//!
//! The renderer names the snapshots its transcript recorded for one workspace
//! file, oldest first; the host owns everything else. The baseline is the
//! first snapshot's pre-tool bytes, the comparison side is the file on disk,
//! and the path always comes from host-written snapshot metadata, so a caller
//! cannot point the diff at a file the session never recorded.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{
    before_path, hash_file, make_preview, metadata_path, read_meta, safe_component, snapshot_dir,
    ReviewChangeState, ReviewDiffHunk, SnapshotMeta,
};
use crate::workspace;

/// Snapshot ids accepted in one request. Each id costs one small metadata
/// read; the bound keeps a renderer bug from turning one diff into an
/// unbounded scan.
const MAX_FILE_DIFF_SNAPSHOTS: usize = 512;

/// A request refused before any snapshot is read.
#[derive(Debug)]
pub struct FileDiffRequestError(&'static str);

impl fmt::Display for FileDiffRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for FileDiffRequestError {}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileDiffStatus {
    Added,
    Modified,
    Deleted,
    /// The file is back to its pre-session bytes, or absent again.
    Unchanged,
    /// The snapshots or the file cannot be read for this session: a forked
    /// transcript names its parent's snapshots, and deleted sessions sweep
    /// theirs.
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileDiff {
    pub status: FileDiffStatus,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<ReviewDiffHunk>,
    pub binary: bool,
    pub truncated: bool,
    /// The file on disk matches no state the recorded changes left behind,
    /// so the diff also contains edits made outside them.
    pub drifted: bool,
}

/// What a recorded change found or left at the path.
#[derive(Debug)]
enum RecordedState {
    Absent,
    Present(String),
    /// A file existed, but its bytes could not be hashed.
    Unknown,
}

impl RecordedState {
    fn recorded(exists: bool, hash: Option<&str>) -> Self {
        match (exists, hash) {
            (false, _) => Self::Absent,
            (true, Some(hash)) => Self::Present(hash.to_string()),
            (true, None) => Self::Unknown,
        }
    }

    fn on_disk(target: &Path) -> Self {
        if !target.is_file() {
            return Self::Absent;
        }
        hash_file(target).map_or(Self::Unknown, Self::Present)
    }

    /// Whether two states can hold the same bytes. An unknown side never
    /// proves a difference, so it never raises a drift warning by itself.
    fn may_equal(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Absent, Self::Absent) => true,
            (Self::Absent, _) | (_, Self::Absent) => false,
            (Self::Present(left), Self::Present(right)) => left == right,
            _ => true,
        }
    }
}

fn net_status(baseline: &RecordedState, current: &RecordedState) -> FileDiffStatus {
    match (baseline, current) {
        (RecordedState::Absent, RecordedState::Absent) => FileDiffStatus::Unchanged,
        (RecordedState::Absent, _) => FileDiffStatus::Added,
        (_, RecordedState::Absent) => FileDiffStatus::Deleted,
        (RecordedState::Present(before), RecordedState::Present(after)) if before == after => {
            FileDiffStatus::Unchanged
        }
        _ => FileDiffStatus::Modified,
    }
}

/// Every state the recorded changes can have left at the path.
///
/// The newest change still in effect left its post-tool bytes, and a rollback
/// restores a change's pre-tool bytes. Rollback order is not recorded, so every
/// rolled-back change contributes its pre-tool state; whichever recorded event
/// ran last, the file it left is in this set.
fn expected_states(metas: &[SnapshotMeta]) -> Vec<RecordedState> {
    let mut states: Vec<RecordedState> = metas
        .iter()
        .filter(|meta| meta.state == ReviewChangeState::RolledBack)
        .map(|meta| RecordedState::recorded(meta.before_exists, meta.before_hash.as_deref()))
        .collect();
    if let Some(head) = metas
        .iter()
        .rev()
        .find(|meta| meta.state == ReviewChangeState::Active)
    {
        states.push(RecordedState::recorded(
            head.after_exists,
            head.after_hash.as_deref(),
        ));
    }
    states
}

/// Read one snapshot's metadata. A missing snapshot is expected, so only
/// metadata that exists but cannot be read is logged.
fn load_meta(data_dir: &Path, session_id: &str, snapshot_id: &str) -> Option<SnapshotMeta> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id).ok()?;
    if !metadata_path(&dir).is_file() {
        return None;
    }
    match read_meta(data_dir, session_id, snapshot_id) {
        Ok(meta) => Some(meta),
        Err(error) => {
            tracing::warn!(
                snapshot_id = %snapshot_id,
                error = %error,
                "review snapshot metadata is unreadable"
            );
            None
        }
    }
}

/// The base snapshot's pre-tool bytes, when the snapshot kept them. A file
/// above the snapshot size limit keeps only its hash, and the preview then
/// reports the diff as too large.
fn baseline_bytes(dir: &Path, base: &SnapshotMeta) -> Option<PathBuf> {
    let path = before_path(dir);
    (base.before_exists && base.reversible && path.is_file()).then_some(path)
}

fn without_lines(status: FileDiffStatus, drifted: bool) -> ReviewFileDiff {
    ReviewFileDiff {
        status,
        additions: 0,
        deletions: 0,
        hunks: Vec::new(),
        binary: false,
        truncated: false,
        drifted,
    }
}

/// Diff one workspace file from before the session's first recorded change to
/// its current bytes on disk.
///
/// `snapshot_ids` are the session's recorded changes to that one path, oldest
/// first. Snapshots this session cannot read, or a path that no longer
/// resolves inside the workspace, produce `Unavailable`; only a malformed
/// request is refused.
pub fn file_diff(
    data_dir: &Path,
    session_id: &str,
    snapshot_ids: &[String],
    workspace_root: Option<&Path>,
) -> Result<ReviewFileDiff, FileDiffRequestError> {
    if snapshot_ids.is_empty() {
        return Err(FileDiffRequestError(
            "snapshotIds must name at least one snapshot",
        ));
    }
    if snapshot_ids.len() > MAX_FILE_DIFF_SNAPSHOTS {
        return Err(FileDiffRequestError("snapshotIds names too many snapshots"));
    }
    if !snapshot_ids.iter().all(|id| safe_component(id.as_str())) {
        return Err(FileDiffRequestError(
            "snapshotIds contains an invalid snapshot id",
        ));
    }
    let unavailable = || without_lines(FileDiffStatus::Unavailable, false);
    let Some(metas) = snapshot_ids
        .iter()
        .map(|id| load_meta(data_dir, session_id, id))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(unavailable());
    };
    let base = &metas[0];
    if metas.iter().any(|meta| meta.path != base.path) {
        return Err(FileDiffRequestError(
            "snapshotIds must all record the same file",
        ));
    }
    let Some(root) = workspace_root else {
        return Ok(unavailable());
    };
    let Ok(target) = workspace::resolve_in_workspace(root, &base.path) else {
        return Ok(unavailable());
    };
    let Ok(base_dir) = snapshot_dir(data_dir, session_id, &snapshot_ids[0]) else {
        return Ok(unavailable());
    };

    let baseline = RecordedState::recorded(base.before_exists, base.before_hash.as_deref());
    let current = RecordedState::on_disk(&target);
    let drifted = !expected_states(&metas)
        .iter()
        .any(|state| state.may_equal(&current));
    let status = net_status(&baseline, &current);
    if status == FileDiffStatus::Unchanged {
        return Ok(without_lines(status, drifted));
    }
    let (binary, truncated, additions, deletions, hunks) = make_preview(
        baseline_bytes(&base_dir, base).as_deref(),
        base.before_exists,
        Some(target.as_path()),
        target.is_file(),
    );
    Ok(ReviewFileDiff {
        status,
        additions,
        deletions,
        hunks,
        binary,
        truncated,
        drifted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::{finalize_change, prepare_change, rollback_change};
    use crate::workspace::ContainedRoots;
    use serde_json::json;
    use std::fs;
    use tempfile::{tempdir, TempDir};

    struct Session {
        data: TempDir,
        workspace: TempDir,
    }

    impl Session {
        fn new() -> Self {
            Self {
                data: tempdir().unwrap(),
                workspace: tempdir().unwrap(),
            }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.workspace.path().join(name)
        }

        /// Snapshot, mutate, and finalize the way `tools.execute` does.
        fn record(&self, name: &str, mutate: impl FnOnce(&Path)) -> String {
            let pending = prepare_change(
                self.data.path(),
                "s1",
                "m1",
                Some(self.workspace.path()),
                &ContainedRoots::new(),
                "Edit",
                &json!({ "path": name }),
            )
            .unwrap()
            .unwrap();
            mutate(self.file(name).as_path());
            finalize_change(&pending).unwrap().snapshot_id
        }

        fn roll_back(&self, snapshot_id: &str) {
            let outcome = rollback_change(
                self.data.path(),
                "s1",
                snapshot_id,
                Some(self.workspace.path()),
            )
            .unwrap();
            assert_eq!(outcome.status, "rolledBack");
        }

        fn diff(&self, ids: &[String]) -> ReviewFileDiff {
            file_diff(self.data.path(), "s1", ids, Some(self.workspace.path())).unwrap()
        }
    }

    fn changed_lines(diff: &ReviewFileDiff) -> Vec<(&str, &str)> {
        diff.hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.line_type != "context")
            .map(|line| (line.line_type.as_str(), line.text.as_str()))
            .collect()
    }

    #[test]
    fn net_diff_spans_every_recorded_edit_of_the_file() {
        let s = Session::new();
        fs::write(s.file("src.txt"), "one\ntwo\nthree\n").unwrap();
        let first = s.record("src.txt", |path| {
            fs::write(path, "one\n2\nthree\n").unwrap()
        });
        let second = s.record("src.txt", |path| {
            fs::write(path, "one\n2\nthree\nfour\n").unwrap()
        });

        let diff = s.diff(&[first, second]);
        assert_eq!(diff.status, FileDiffStatus::Modified);
        assert_eq!((diff.additions, diff.deletions), (2, 1));
        assert_eq!(
            changed_lines(&diff),
            vec![("del", "two"), ("add", "2"), ("add", "four")]
        );
        assert!(!diff.drifted);
        assert!(!diff.binary && !diff.truncated);
    }

    #[test]
    fn created_and_deleted_files_report_their_net_status() {
        let s = Session::new();
        let created = s.record("new.txt", |path| fs::write(path, "hello\n").unwrap());
        let added = s.diff(&[created]);
        assert_eq!(added.status, FileDiffStatus::Added);
        assert_eq!((added.additions, added.deletions), (1, 0));
        assert!(!added.drifted);

        fs::write(s.file("old.txt"), "keep\nme\n").unwrap();
        let removed = s.record("old.txt", |path| fs::remove_file(path).unwrap());
        let deleted = s.diff(&[removed]);
        assert_eq!(deleted.status, FileDiffStatus::Deleted);
        assert_eq!((deleted.additions, deleted.deletions), (0, 2));
        assert!(!deleted.drifted);
    }

    #[test]
    fn a_file_created_then_removed_is_unchanged() {
        let s = Session::new();
        let created = s.record("tmp.txt", |path| fs::write(path, "scratch\n").unwrap());
        let removed = s.record("tmp.txt", |path| fs::remove_file(path).unwrap());

        let diff = s.diff(&[created, removed]);
        assert_eq!(diff.status, FileDiffStatus::Unchanged);
        assert!(diff.hunks.is_empty());
        assert!(!diff.drifted);
    }

    #[test]
    fn an_edit_after_the_last_recorded_change_is_flagged() {
        let s = Session::new();
        fs::write(s.file("src.txt"), "a\n").unwrap();
        let edit = s.record("src.txt", |path| fs::write(path, "b\n").unwrap());
        assert!(!s.diff(std::slice::from_ref(&edit)).drifted);

        fs::write(s.file("src.txt"), "c\n").unwrap();
        let diff = s.diff(&[edit]);
        assert_eq!(diff.status, FileDiffStatus::Modified);
        assert!(diff.drifted);
        assert_eq!(changed_lines(&diff), vec![("del", "a"), ("add", "c")]);
    }

    #[test]
    fn rolling_back_every_change_leaves_nothing_to_review() {
        let s = Session::new();
        fs::write(s.file("src.txt"), "a\n").unwrap();
        let edit = s.record("src.txt", |path| fs::write(path, "b\n").unwrap());
        s.roll_back(&edit);

        let diff = s.diff(&[edit]);
        assert_eq!(diff.status, FileDiffStatus::Unchanged);
        assert!(!diff.drifted);
    }

    #[test]
    fn rolling_back_the_newest_change_keeps_the_earlier_one() {
        let s = Session::new();
        fs::write(s.file("src.txt"), "a\n").unwrap();
        let first = s.record("src.txt", |path| fs::write(path, "b\n").unwrap());
        let second = s.record("src.txt", |path| fs::write(path, "c\n").unwrap());
        s.roll_back(&second);
        assert_eq!(fs::read_to_string(s.file("src.txt")).unwrap(), "b\n");

        let diff = s.diff(&[first, second]);
        assert_eq!(diff.status, FileDiffStatus::Modified);
        assert_eq!(changed_lines(&diff), vec![("del", "a"), ("add", "b")]);
        assert!(!diff.drifted);
    }

    #[test]
    fn snapshots_this_session_cannot_read_are_unavailable() {
        let s = Session::new();
        fs::write(s.file("src.txt"), "a\n").unwrap();
        let edit = s.record("src.txt", |path| fs::write(path, "b\n").unwrap());
        let ids = std::slice::from_ref(&edit);

        // A fork shows its parent's evidence; the snapshots stay with the parent.
        let forked = file_diff(s.data.path(), "s2", ids, Some(s.workspace.path())).unwrap();
        assert_eq!(forked.status, FileDiffStatus::Unavailable);
        let missing = s.diff(&["0000-missing".to_string()]);
        assert_eq!(missing.status, FileDiffStatus::Unavailable);
        let unbound = file_diff(s.data.path(), "s1", ids, None).unwrap();
        assert_eq!(unbound.status, FileDiffStatus::Unavailable);

        let dir = snapshot_dir(s.data.path(), "s1", &edit).unwrap();
        fs::write(metadata_path(&dir), "not json").unwrap();
        assert_eq!(s.diff(ids).status, FileDiffStatus::Unavailable);
    }

    #[test]
    fn malformed_requests_are_refused() {
        let s = Session::new();
        let one = s.record("one.txt", |path| fs::write(path, "1\n").unwrap());
        let two = s.record("two.txt", |path| fs::write(path, "2\n").unwrap());
        let refuse = |ids: &[String]| {
            file_diff(s.data.path(), "s1", ids, Some(s.workspace.path())).unwrap_err()
        };

        refuse(&[]);
        refuse(&["../escape".to_string()]);
        let too_many: Vec<String> = (0..=MAX_FILE_DIFF_SNAPSHOTS).map(|_| one.clone()).collect();
        refuse(&too_many);
        assert!(refuse(&[one, two]).to_string().contains("same file"));
    }

    #[test]
    fn statuses_serialize_in_renderer_spelling() {
        let names: Vec<serde_json::Value> = [
            FileDiffStatus::Added,
            FileDiffStatus::Modified,
            FileDiffStatus::Deleted,
            FileDiffStatus::Unchanged,
            FileDiffStatus::Unavailable,
        ]
        .iter()
        .map(|status| serde_json::to_value(status).unwrap())
        .collect();
        assert_eq!(
            names,
            ["added", "modified", "deleted", "unchanged", "unavailable"]
        );
    }
}
