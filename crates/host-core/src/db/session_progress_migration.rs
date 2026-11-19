use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// v31 adds read-only session progress reports and their per-session
/// auto-collection settings (ADR 0350). Both tables are additive, so existing
/// sessions keep working and simply have no reports yet.
fn migrate_v30_to_v31_tx(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(crate::progress::SCHEMA)?;
    tx.pragma_update(None, "user_version", 31i64)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 30)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v30_to_v31_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v30 to v31 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
