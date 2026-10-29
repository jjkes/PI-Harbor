use super::{create_migration_backup, Connection, Context, Path, Result};

/// Schema v26 records the optional execution model chosen during Plan/Goal
/// approval (D674). Existing approvals keep NULL targets.
pub(crate) fn migrate_v25_to_v26(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 25)?;
    let tx = conn.unchecked_transaction()?;
    for column in [
        "target_provider_id",
        "target_model_id",
        "target_thinking_level",
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('plan_approvals') WHERE name = ?1)",
            [column],
            |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(&format!(
                "ALTER TABLE plan_approvals ADD COLUMN {column} TEXT;"
            ))?;
        }
    }
    tx.pragma_update(None, "user_version", 26i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v25 to v26 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
