use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::now_ms;

pub(super) struct StoredTeam {
    pub enabled: bool,
    pub roster_json: String,
    pub revision: i64,
}

pub(super) fn session_exists(conn: &Connection, session_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        params![session_id],
        |row| row.get(0),
    )?)
}

pub(super) fn get(conn: &Connection, session_id: &str) -> Result<Option<StoredTeam>> {
    conn.query_row(
        "SELECT enabled,roster_json,revision FROM session_team WHERE session_id=?1",
        params![session_id],
        |row| {
            Ok(StoredTeam {
                enabled: row.get(0)?,
                roster_json: row.get(1)?,
                revision: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Insert the first revision or compare-and-swap an existing row. A zero row
/// count means another writer advanced the revision after it was read.
pub(super) fn upsert(
    conn: &Connection,
    session_id: &str,
    enabled: bool,
    roster_json: &str,
    expected_revision: i64,
) -> Result<bool> {
    let changed = conn.execute(
        "INSERT INTO session_team(session_id,enabled,roster_json,revision,updated_at)
         VALUES(?1,?2,?3,1,?4)
         ON CONFLICT(session_id) DO UPDATE SET
           enabled=excluded.enabled,
           roster_json=excluded.roster_json,
           revision=session_team.revision+1,
           updated_at=excluded.updated_at
         WHERE session_team.revision=?5",
        params![
            session_id,
            enabled,
            roster_json,
            now_ms(),
            expected_revision
        ],
    )?;
    Ok(changed == 1)
}
