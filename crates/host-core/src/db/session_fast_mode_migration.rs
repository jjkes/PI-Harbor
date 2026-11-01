use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// v30 stores the per-session `/fast` switch (ADR 0334). Every existing
/// session keeps the default service tier.
///
/// Upstream places this step at v26 -> v27; this distribution spent 26, 27 and
/// 28 on the plan execution model, Team rosters and project workspaces before
/// the step arrived, so it runs last and stamps its own version.
fn migrate_v29_to_v30_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_fast_mode: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'fast_mode')",
        [],
        |row| row.get(0),
    )?;
    if !has_fast_mode {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0
             CHECK (fast_mode IN (0, 1));",
        )?;
    }
    tx.pragma_update(None, "user_version", 30i64)?;
    Ok(())
}

pub(crate) fn migrate_v29_to_v30(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 29)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v29_to_v30_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v29 to v30 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
