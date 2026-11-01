use super::{create_migration_backup, Connection, Context, Path, Result};

/// Add the project-workspace registry and the session binding column without
/// touching existing rows (schema v27 to v28).
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let tx = conn.unchecked_transaction()?;
    crate::project_workspaces::apply_schema(&tx)?;
    tx.pragma_update(None, "user_version", 28i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v27 to v28 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
