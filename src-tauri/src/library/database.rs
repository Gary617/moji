use std::{path::Path, time::Duration};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, from_str, to_string};

use super::model::{
    DocumentFormat, DocumentId, DocumentRecord, DocumentStatus, LIBRARY_SCHEMA_VERSION,
    LibraryError, LibraryErrorCode, LibraryResult, ScanEvent, ScanEventKind, ScanJobId,
    ScanJobRecord, ScanJobState, SourceKind, SourceRegistration, SourceRootId, SourceRootRecord,
    new_identifier, now_unix_ms,
};

pub(crate) struct LibraryDatabase {
    connection: Connection,
}

impl LibraryDatabase {
    pub(crate) fn open(path: impl AsRef<Path>) -> LibraryResult<Self> {
        let connection = Connection::open(path).map_err(database_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(database_error)?;
        let mut database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    pub(crate) fn in_memory() -> LibraryResult<Self> {
        let connection = Connection::open_in_memory().map_err(database_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(database_error)?;
        let mut database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    pub(crate) fn migrate(&mut self) -> LibraryResult<()> {
        self.connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(database_error)?;
        let version: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if version > LIBRARY_SCHEMA_VERSION {
            return Err(LibraryError::new(
                LibraryErrorCode::MigrationFailed,
                "library database version is newer than this application",
            )
            .with_details(serde_json::json!({
                "databaseVersion": version,
                "supportedVersion": LIBRARY_SCHEMA_VERSION,
            })));
        }
        if version == 0 {
            self.connection
                .execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS source_roots (
                        id TEXT PRIMARY KEY NOT NULL,
                        kind TEXT NOT NULL CHECK (kind IN ('directory', 'single_file')),
                        canonical_path TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        created_at_ms INTEGER NOT NULL,
                        active INTEGER NOT NULL DEFAULT 1
                    );
                    CREATE TABLE IF NOT EXISTS documents (
                        id TEXT PRIMARY KEY NOT NULL,
                        source_root_id TEXT NOT NULL REFERENCES source_roots(id) ON DELETE CASCADE,
                        canonical_path TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        format TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        modified_at_ms INTEGER NOT NULL,
                        file_identity TEXT,
                        content_sha256 TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (status IN ('present', 'missing', 'error')),
                        content_state TEXT NOT NULL DEFAULT 'pending',
                        last_seen_scan_id TEXT,
                        created_at_ms INTEGER NOT NULL,
                        updated_at_ms INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS documents_source_root_idx
                        ON documents(source_root_id, status);
                    CREATE INDEX IF NOT EXISTS documents_file_identity_idx
                        ON documents(source_root_id, file_identity);
                    CREATE INDEX IF NOT EXISTS documents_hash_idx
                        ON documents(source_root_id, content_sha256);
                    CREATE TABLE IF NOT EXISTS scan_jobs (
                        id TEXT PRIMARY KEY NOT NULL,
                        source_root_id TEXT NOT NULL REFERENCES source_roots(id) ON DELETE CASCADE,
                        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'cancelled', 'failed', 'completed')),
                        scanned_count INTEGER NOT NULL DEFAULT 0,
                        changed_count INTEGER NOT NULL DEFAULT 0,
                        failed_count INTEGER NOT NULL DEFAULT 0,
                        retry_count INTEGER NOT NULL DEFAULT 0,
                        error_code TEXT,
                        created_at_ms INTEGER NOT NULL,
                        updated_at_ms INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS scan_jobs_source_idx
                        ON scan_jobs(source_root_id, updated_at_ms);
                    CREATE TABLE IF NOT EXISTS scan_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
                        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
                        kind TEXT NOT NULL CHECK (kind IN ('discovered', 'updated', 'renamed', 'missing', 'skipped', 'error')),
                        occurred_at_ms INTEGER NOT NULL,
                        details_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS scan_events_job_idx
                        ON scan_events(scan_job_id, id);
                    PRAGMA user_version = 1;
                    "#,
                )
                .map_err(database_error)?;
        }
        Ok(())
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn register_source(
        &mut self,
        kind: SourceKind,
        canonical_path: &str,
        display_name: &str,
    ) -> LibraryResult<SourceRegistration> {
        if let Some(source) = self.source_by_path(canonical_path)? {
            return Ok(SourceRegistration {
                source,
                created: false,
            });
        }
        let source = SourceRootRecord {
            id: SourceRootId(new_identifier("src")),
            kind,
            canonical_path: canonical_path.to_owned(),
            display_name: display_name.to_owned(),
            created_at_ms: now_unix_ms(),
        };
        self.connection
            .execute(
                "INSERT INTO source_roots (id, kind, canonical_path, display_name, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![source.id.0, source.kind.as_str(), source.canonical_path, source.display_name, source.created_at_ms],
            )
            .map_err(database_error)?;
        Ok(SourceRegistration {
            source,
            created: true,
        })
    }

    pub(crate) fn source_by_id(
        &self,
        id: &SourceRootId,
    ) -> LibraryResult<Option<SourceRootRecord>> {
        self.connection
            .query_row(
                "SELECT id, kind, canonical_path, display_name, created_at_ms FROM source_roots WHERE id = ?1 AND active = 1",
                params![id.0],
                source_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub(crate) fn source_by_path(&self, path: &str) -> LibraryResult<Option<SourceRootRecord>> {
        self.connection
            .query_row(
                "SELECT id, kind, canonical_path, display_name, created_at_ms FROM source_roots WHERE canonical_path = ?1 AND active = 1",
                params![path],
                source_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub(crate) fn create_scan_job(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<ScanJobRecord> {
        let source = self.source_by_id(source_root_id)?;
        if source.is_none() {
            return Err(LibraryError::new(
                LibraryErrorCode::SourceNotFound,
                "source root was not found",
            ));
        }
        let now = now_unix_ms();
        let job = ScanJobRecord {
            id: ScanJobId(new_identifier("job")),
            source_root_id: source_root_id.clone(),
            state: ScanJobState::Queued,
            scanned_count: 0,
            changed_count: 0,
            failed_count: 0,
            retry_count: 0,
            error_code: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.connection
            .execute(
                "INSERT INTO scan_jobs (id, source_root_id, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![job.id.0, job.source_root_id.0, job.state.as_str(), job.created_at_ms, job.updated_at_ms],
            )
            .map_err(database_error)?;
        Ok(job)
    }

    pub(crate) fn job(&self, id: &ScanJobId) -> LibraryResult<Option<ScanJobRecord>> {
        self.connection
            .query_row(
                "SELECT id, source_root_id, state, scanned_count, changed_count, failed_count, retry_count, error_code, created_at_ms, updated_at_ms FROM scan_jobs WHERE id = ?1",
                params![id.0],
                job_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub(crate) fn recover_running_jobs(&mut self) -> LibraryResult<u64> {
        let changed = self
            .connection
            .execute(
                "UPDATE scan_jobs SET state = 'paused', updated_at_ms = ?1 WHERE state = 'running'",
                params![now_unix_ms()],
            )
            .map_err(database_error)?;
        Ok(changed as u64)
    }

    pub(crate) fn update_job(
        &mut self,
        id: &ScanJobId,
        state: ScanJobState,
        scanned_count: u64,
        changed_count: u64,
        failed_count: u64,
        retry_count: u32,
        error_code: Option<&str>,
    ) -> LibraryResult<ScanJobRecord> {
        self.connection
            .execute(
                "UPDATE scan_jobs SET state = ?2, scanned_count = ?3, changed_count = ?4, failed_count = ?5, retry_count = ?6, error_code = ?7, updated_at_ms = ?8 WHERE id = ?1",
                params![id.0, state.as_str(), sqlite_int(scanned_count), sqlite_int(changed_count), sqlite_int(failed_count), i64::from(retry_count), error_code, now_unix_ms()],
            )
            .map_err(database_error)?;
        self.job(id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::ScanJobNotFound, "scan job was not found")
        })
    }

    pub(crate) fn update_running_progress(
        &mut self,
        id: &ScanJobId,
        scanned_count: u64,
        changed_count: u64,
        failed_count: u64,
        retry_count: u32,
    ) -> LibraryResult<Option<ScanJobRecord>> {
        let changed = self
            .connection
            .execute(
                "UPDATE scan_jobs SET scanned_count = ?2, changed_count = ?3, failed_count = ?4, retry_count = ?5, updated_at_ms = ?6 WHERE id = ?1 AND state = 'running'",
                params![id.0, sqlite_int(scanned_count), sqlite_int(changed_count), sqlite_int(failed_count), i64::from(retry_count), now_unix_ms()],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Ok(None);
        }
        self.job(id)
    }

    pub(crate) fn documents_for_source(
        &self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<Vec<DocumentRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents WHERE source_root_id = ?1")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![source_root_id.0], document_from_row)
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn document_by_path(&self, path: &str) -> LibraryResult<Option<DocumentRecord>> {
        self.connection
            .query_row(
                "SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents WHERE canonical_path = ?1",
                params![path],
                document_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub(crate) fn document_by_identity(
        &self,
        source_root_id: &SourceRootId,
        identity: &str,
    ) -> LibraryResult<Option<DocumentRecord>> {
        self.connection
            .query_row(
                "SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents WHERE source_root_id = ?1 AND file_identity = ?2 ORDER BY status = 'missing' DESC LIMIT 1",
                params![source_root_id.0, identity],
                document_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    pub(crate) fn documents_by_hash(
        &self,
        source_root_id: &SourceRootId,
        hash: &str,
    ) -> LibraryResult<Vec<DocumentRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents WHERE source_root_id = ?1 AND content_sha256 = ?2")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![source_root_id.0, hash], document_from_row)
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn upsert_document(
        &mut self,
        document: &DocumentRecord,
        scan_job_id: &ScanJobId,
    ) -> LibraryResult<()> {
        self.connection
            .execute(
                r#"INSERT INTO documents
                    (id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state, last_seen_scan_id, created_at_ms, updated_at_ms)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
                    ON CONFLICT(id) DO UPDATE SET
                        source_root_id = excluded.source_root_id,
                        canonical_path = excluded.canonical_path,
                        display_name = excluded.display_name,
                        format = excluded.format,
                        size_bytes = excluded.size_bytes,
                        modified_at_ms = excluded.modified_at_ms,
                        file_identity = excluded.file_identity,
                        content_sha256 = excluded.content_sha256,
                        status = excluded.status,
                        content_state = excluded.content_state,
                        last_seen_scan_id = excluded.last_seen_scan_id,
                        updated_at_ms = excluded.updated_at_ms"#,
                params![
                    document.id.0,
                    document.source_root_id.0,
                    document.canonical_path,
                    document.display_name,
                    document.format.as_str(),
                    sqlite_int(document.size_bytes),
                    document.modified_at_ms,
                    document.file_identity,
                    document.content_sha256,
                    document.status.as_str(),
                    document.content_state,
                    scan_job_id.0,
                    now_unix_ms(),
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) fn mark_missing(
        &mut self,
        document_id: &DocumentId,
        scan_job_id: &ScanJobId,
    ) -> LibraryResult<()> {
        self.connection
            .execute(
                "UPDATE documents SET status = 'missing', last_seen_scan_id = ?2, updated_at_ms = ?3 WHERE id = ?1",
                params![document_id.0, scan_job_id.0, now_unix_ms()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) fn add_event(
        &mut self,
        scan_job_id: &ScanJobId,
        document_id: Option<&DocumentId>,
        kind: ScanEventKind,
        details: &Value,
    ) -> LibraryResult<ScanEvent> {
        let occurred_at_ms = now_unix_ms();
        self.connection
            .execute(
                "INSERT INTO scan_events (scan_job_id, document_id, kind, occurred_at_ms, details_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![scan_job_id.0, document_id.map(|id| id.0.as_str()), kind.as_str(), occurred_at_ms, to_string(details).map_err(|_| database_error(rusqlite::Error::InvalidQuery))?],
            )
            .map_err(database_error)?;
        let id = self.connection.last_insert_rowid();
        Ok(ScanEvent {
            id,
            scan_job_id: scan_job_id.clone(),
            document_id: document_id.cloned(),
            kind,
            occurred_at_ms,
            details: details.clone(),
        })
    }

    pub(crate) fn events_for_job(&self, scan_job_id: &ScanJobId) -> LibraryResult<Vec<ScanEvent>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, scan_job_id, document_id, kind, occurred_at_ms, details_json FROM scan_events WHERE scan_job_id = ?1 ORDER BY id")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![scan_job_id.0], |row| {
                let details_json: String = row.get(5)?;
                Ok(ScanEvent {
                    id: row.get(0)?,
                    scan_job_id: ScanJobId(row.get(1)?),
                    document_id: row.get::<_, Option<String>>(2)?.map(DocumentId),
                    kind: ScanEventKind::parse(&row.get::<_, String>(3)?)
                        .ok_or(rusqlite::Error::InvalidQuery)?,
                    occurred_at_ms: row.get(4)?,
                    details: from_str(&details_json).map_err(|_| rusqlite::Error::InvalidQuery)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRootRecord> {
    Ok(SourceRootRecord {
        id: SourceRootId(row.get(0)?),
        kind: SourceKind::parse(&row.get::<_, String>(1)?).ok_or(rusqlite::Error::InvalidQuery)?,
        canonical_path: row.get(2)?,
        display_name: row.get(3)?,
        created_at_ms: row.get(4)?,
    })
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRecord> {
    Ok(DocumentRecord {
        id: DocumentId(row.get(0)?),
        source_root_id: SourceRootId(row.get(1)?),
        canonical_path: row.get(2)?,
        display_name: row.get(3)?,
        format: DocumentFormat::parse(&row.get::<_, String>(4)?)
            .ok_or(rusqlite::Error::InvalidQuery)?,
        size_bytes: row
            .get::<_, i64>(5)?
            .try_into()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        modified_at_ms: row.get(6)?,
        file_identity: row.get(7)?,
        content_sha256: row.get(8)?,
        status: DocumentStatus::parse(&row.get::<_, String>(9)?)
            .ok_or(rusqlite::Error::InvalidQuery)?,
        content_state: row.get(10)?,
    })
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScanJobRecord> {
    Ok(ScanJobRecord {
        id: ScanJobId(row.get(0)?),
        source_root_id: SourceRootId(row.get(1)?),
        state: ScanJobState::parse(&row.get::<_, String>(2)?)
            .ok_or(rusqlite::Error::InvalidQuery)?,
        scanned_count: row
            .get::<_, i64>(3)?
            .try_into()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        changed_count: row
            .get::<_, i64>(4)?
            .try_into()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        failed_count: row
            .get::<_, i64>(5)?
            .try_into()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        retry_count: row
            .get::<_, i64>(6)?
            .try_into()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        error_code: row.get(7)?,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
    })
}

fn database_error(error: rusqlite::Error) -> LibraryError {
    LibraryError::new(
        LibraryErrorCode::DatabaseFailed,
        "local library database operation failed",
    )
    .retryable()
    .with_details(serde_json::json!({ "source": error.to_string() }))
}

fn sqlite_int(value: u64) -> i64 {
    value.try_into().unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::LibraryDatabase;
    use crate::library::model::SourceKind;

    #[test]
    fn migration_creates_the_library_tables_and_is_idempotent() {
        let mut database = LibraryDatabase::in_memory().expect("database should open");
        database
            .register_source(SourceKind::Directory, "C:/authorized", "authorized")
            .expect("source should be stored");
        database.migrate().expect("second migration should succeed");
        let version: i64 = database
            .connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version should be readable");
        assert_eq!(version, 1);
        let table_count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_roots', 'documents', 'scan_jobs', 'scan_events')",
                [],
                |row| row.get(0),
            )
            .expect("tables should be queryable");
        assert_eq!(table_count, 4);
        let count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM source_roots WHERE id = ?1",
                params!["src-does-not-exist"],
                |row| row.get(0),
            )
            .expect("source table should survive migration");
        assert_eq!(count, 0);
        let source = database
            .source_by_path("C:/authorized")
            .expect("source lookup should work");
        assert!(source.is_some());
        assert!(source.expect("source").id.0.starts_with("src-"));
    }
}
