use super::{create_migration_backup, Connection, Context, Path, Result};

/// Add per-session Team mode storage without backfilling existing sessions.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 26)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(crate::session_team::SCHEMA)?;
    tx.pragma_update(None, "user_version", 27i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v26 to v27 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
