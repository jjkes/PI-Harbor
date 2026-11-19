use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::now_ms;

/// Rows kept per session. Auto collection at the 5 min default covers roughly
/// eight hours of one session before the oldest reports are pruned.
pub(super) const REPORTS_KEEP: i64 = 100;

pub(super) struct StoredReport {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub created_at: i64,
    pub trigger: String,
    pub provider_id: String,
    pub model_id: String,
    pub status: String,
    pub body_json: Option<String>,
    pub raw_text: Option<String>,
    pub fingerprint: String,
    pub last_message_id: Option<String>,
    pub message_count: i64,
    pub included_messages: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub duration_ms: i64,
}

pub(super) struct StoredSettings {
    pub model_json: String,
    pub auto_enabled: bool,
    pub interval_minutes: i64,
    pub last_collected_at: Option<i64>,
    pub consecutive_failures: i64,
    pub updated_at: i64,
}

const REPORT_COLUMNS: &str = "id,session_id,run_id,created_at,trigger,provider_id,model_id,status,\
     body_json,raw_text,fingerprint,last_message_id,message_count,included_messages,\
     input_tokens,output_tokens,duration_ms";

fn report_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredReport> {
    Ok(StoredReport {
        id: row.get(0)?,
        session_id: row.get(1)?,
        run_id: row.get(2)?,
        created_at: row.get(3)?,
        trigger: row.get(4)?,
        provider_id: row.get(5)?,
        model_id: row.get(6)?,
        status: row.get(7)?,
        body_json: row.get(8)?,
        raw_text: row.get(9)?,
        fingerprint: row.get(10)?,
        last_message_id: row.get(11)?,
        message_count: row.get(12)?,
        included_messages: row.get(13)?,
        input_tokens: row.get(14)?,
        output_tokens: row.get(15)?,
        duration_ms: row.get(16)?,
    })
}

pub(super) fn session_exists(conn: &Connection, session_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        params![session_id],
        |row| row.get(0),
    )?)
}

/// Insert one report and prune the session to its newest `REPORTS_KEEP` rows in
/// the same transaction, so a report that cost tokens is never left unpruned.
/// `run_id` is the idempotency key: a retried append inserts nothing.
pub(super) fn insert_report(conn: &Connection, report: &StoredReport) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO session_progress_reports(id,session_id,run_id,created_at,trigger,\
         provider_id,model_id,status,body_json,raw_text,fingerprint,last_message_id,\
         message_count,included_messages,input_tokens,output_tokens,duration_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
         ON CONFLICT(run_id) DO NOTHING",
        params![
            report.id,
            report.session_id,
            report.run_id,
            report.created_at,
            report.trigger,
            report.provider_id,
            report.model_id,
            report.status,
            report.body_json,
            report.raw_text,
            report.fingerprint,
            report.last_message_id,
            report.message_count,
            report.included_messages,
            report.input_tokens,
            report.output_tokens,
            report.duration_ms,
        ],
    )?;
    tx.execute(
        "DELETE FROM session_progress_reports
         WHERE session_id=?1 AND id NOT IN (
           SELECT id FROM session_progress_reports
           WHERE session_id=?1
           ORDER BY created_at DESC, id DESC
           LIMIT ?2
         )",
        params![report.session_id, REPORTS_KEEP],
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn get_by_run_id(conn: &Connection, run_id: &str) -> Result<Option<StoredReport>> {
    let sql = format!("SELECT {REPORT_COLUMNS} FROM session_progress_reports WHERE run_id=?1");
    conn.query_row(&sql, params![run_id], report_row)
        .optional()
        .map_err(Into::into)
}

/// Newest first, cursor-paged. `before` is the `(created_at, id)` of the last
/// row the caller already has, which keeps paging stable when two reports share
/// a timestamp.
pub(super) fn list_reports(
    conn: &Connection,
    session_id: &str,
    limit: i64,
    before: Option<(i64, String)>,
) -> Result<Vec<StoredReport>> {
    let (sql, rows) = match before {
        Some((created_at, id)) => (
            format!(
                "SELECT {REPORT_COLUMNS} FROM session_progress_reports
                 WHERE session_id=?1 AND (created_at<?2 OR (created_at=?2 AND id<?3))
                 ORDER BY created_at DESC, id DESC LIMIT ?4"
            ),
            vec![
                rusqlite::types::Value::Text(session_id.to_string()),
                rusqlite::types::Value::Integer(created_at),
                rusqlite::types::Value::Text(id),
                rusqlite::types::Value::Integer(limit),
            ],
        ),
        None => (
            format!(
                "SELECT {REPORT_COLUMNS} FROM session_progress_reports
                 WHERE session_id=?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2"
            ),
            vec![
                rusqlite::types::Value::Text(session_id.to_string()),
                rusqlite::types::Value::Integer(limit),
            ],
        ),
    };
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(rows), report_row)?;
    let mut reports = Vec::new();
    for row in rows {
        reports.push(row?);
    }
    Ok(reports)
}

pub(super) fn get_report(
    conn: &Connection,
    session_id: &str,
    id: &str,
) -> Result<Option<StoredReport>> {
    let sql = format!(
        "SELECT {REPORT_COLUMNS} FROM session_progress_reports WHERE session_id=?1 AND id=?2"
    );
    conn.query_row(&sql, params![session_id, id], report_row)
        .optional()
        .map_err(Into::into)
}

pub(super) fn latest_report(conn: &Connection, session_id: &str) -> Result<Option<StoredReport>> {
    let sql = format!(
        "SELECT {REPORT_COLUMNS} FROM session_progress_reports
         WHERE session_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    conn.query_row(&sql, params![session_id], report_row)
        .optional()
        .map_err(Into::into)
}

pub(super) fn get_settings(conn: &Connection, session_id: &str) -> Result<Option<StoredSettings>> {
    conn.query_row(
        "SELECT model_json,auto_enabled,interval_minutes,last_collected_at,\
         consecutive_failures,updated_at
         FROM session_progress_settings WHERE session_id=?1",
        params![session_id],
        |row| {
            Ok(StoredSettings {
                model_json: row.get(0)?,
                auto_enabled: row.get(1)?,
                interval_minutes: row.get(2)?,
                last_collected_at: row.get(3)?,
                consecutive_failures: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Upsert the whole settings row. A read never writes, so this is the only
/// writer of `session_progress_settings`.
pub(super) fn upsert_settings(
    conn: &Connection,
    session_id: &str,
    model_json: &str,
    auto_enabled: bool,
    interval_minutes: i64,
    last_collected_at: Option<i64>,
    consecutive_failures: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO session_progress_settings(session_id,model_json,auto_enabled,\
         interval_minutes,last_collected_at,consecutive_failures,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(session_id) DO UPDATE SET
           model_json=excluded.model_json,
           auto_enabled=excluded.auto_enabled,
           interval_minutes=excluded.interval_minutes,
           last_collected_at=excluded.last_collected_at,
           consecutive_failures=excluded.consecutive_failures,
           updated_at=excluded.updated_at",
        params![
            session_id,
            model_json,
            auto_enabled,
            interval_minutes,
            last_collected_at,
            consecutive_failures,
            now_ms(),
        ],
    )?;
    Ok(())
}
