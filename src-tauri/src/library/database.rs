use std::{
    path::Path,
    time::{Duration, Instant},
};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, from_str, to_string};

use super::model::{
    CollectionId, CollectionRecord, DocumentFormat, DocumentId, DocumentRecord, DocumentStatus,
    IndexRebuildSummary, LIBRARY_SCHEMA_VERSION, LibraryError, LibraryErrorCode, LibraryResult,
    ScanEvent, ScanEventKind, ScanJobId, ScanJobRecord, ScanJobState, SearchDocument, SearchQuery,
    SearchResults, SearchSnippet, SourceKind, SourceLocator, SourceRegistration, SourceRootId,
    SourceRootRecord, TagId, TagRecord, new_identifier, now_unix_ms,
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
        let mut version: i64 = self
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
            version = 1;
        }
        if version == 1 {
            self.connection
                .execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS collections (
                        id TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL UNIQUE,
                        created_at_ms INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS tags (
                        id TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL UNIQUE,
                        created_at_ms INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS document_collections (
                        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                        created_at_ms INTEGER NOT NULL,
                        PRIMARY KEY (document_id, collection_id)
                    );
                    CREATE INDEX IF NOT EXISTS document_collections_collection_idx
                        ON document_collections(collection_id, document_id);
                    CREATE TABLE IF NOT EXISTS document_tags (
                        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                        created_at_ms INTEGER NOT NULL,
                        PRIMARY KEY (document_id, tag_id)
                    );
                    CREATE INDEX IF NOT EXISTS document_tags_tag_idx
                        ON document_tags(tag_id, document_id);
                    CREATE TABLE IF NOT EXISTS document_usage (
                        document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                        is_favorite INTEGER NOT NULL DEFAULT 0,
                        last_used_at_ms INTEGER,
                        updated_at_ms INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS document_search_state (
                        document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                        state TEXT NOT NULL CHECK (state IN ('ready', 'error')),
                        error_code TEXT,
                        updated_at_ms INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS document_search_content (
                        document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                        body TEXT NOT NULL DEFAULT '',
                        ocr TEXT NOT NULL DEFAULT '',
                        updated_at_ms INTEGER NOT NULL
                    );
                    CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
                        document_id UNINDEXED,
                        title,
                        body,
                        path,
                        tags,
                        ocr,
                        tokenize = 'trigram'
                    );
                    INSERT INTO document_fts(document_id, title, body, path, tags, ocr)
                        SELECT d.id, d.display_name, '', d.canonical_path, '', ''
                        FROM documents d
                        WHERE NOT EXISTS (
                            SELECT 1 FROM document_fts f WHERE f.document_id = d.id
                        );
                    INSERT OR IGNORE INTO document_search_state(document_id, state, error_code, updated_at_ms)
                        SELECT id, 'ready', NULL, updated_at_ms FROM documents;
                    INSERT OR IGNORE INTO document_search_content(document_id, body, ocr, updated_at_ms)
                        SELECT id, '', '', updated_at_ms FROM documents;
                    PRAGMA user_version = 2;
                    "#,
                )
                .map_err(database_error)?;
        }
        Ok(())
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn collections(&self) -> LibraryResult<Vec<CollectionRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, name, created_at_ms FROM collections ORDER BY name COLLATE NOCASE")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(CollectionRecord {
                    id: CollectionId(row.get(0)?),
                    name: row.get(1)?,
                    created_at_ms: row.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn sources(&self) -> LibraryResult<Vec<SourceRootRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, kind, canonical_path, display_name, created_at_ms FROM source_roots WHERE active = 1 ORDER BY display_name COLLATE NOCASE")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], source_from_row)
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn tags(&self) -> LibraryResult<Vec<TagRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, name, created_at_ms FROM tags ORDER BY name COLLATE NOCASE")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(TagRecord {
                    id: TagId(row.get(0)?),
                    name: row.get(1)?,
                    created_at_ms: row.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn create_collection(&mut self, name: &str) -> LibraryResult<CollectionRecord> {
        let name = name.trim();
        if name.is_empty() {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "collection name cannot be empty",
            ));
        }
        if let Some(existing) = self
            .connection
            .query_row(
                "SELECT id, name, created_at_ms FROM collections WHERE name = ?1",
                params![name],
                |row| {
                    Ok(CollectionRecord {
                        id: CollectionId(row.get(0)?),
                        name: row.get(1)?,
                        created_at_ms: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)?
        {
            return Ok(existing);
        }
        let collection = CollectionRecord {
            id: CollectionId(new_identifier("col")),
            name: name.to_owned(),
            created_at_ms: now_unix_ms(),
        };
        self.connection
            .execute(
                "INSERT INTO collections (id, name, created_at_ms) VALUES (?1, ?2, ?3)",
                params![collection.id.0, collection.name, collection.created_at_ms],
            )
            .map_err(database_error)?;
        Ok(collection)
    }

    pub(crate) fn create_tag(&mut self, name: &str) -> LibraryResult<TagRecord> {
        let name = name.trim();
        if name.is_empty() {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "tag name cannot be empty",
            ));
        }
        if let Some(existing) = self
            .connection
            .query_row(
                "SELECT id, name, created_at_ms FROM tags WHERE name = ?1",
                params![name],
                |row| {
                    Ok(TagRecord {
                        id: TagId(row.get(0)?),
                        name: row.get(1)?,
                        created_at_ms: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)?
        {
            return Ok(existing);
        }
        let tag = TagRecord {
            id: TagId(new_identifier("tag")),
            name: name.to_owned(),
            created_at_ms: now_unix_ms(),
        };
        self.connection
            .execute(
                "INSERT INTO tags (id, name, created_at_ms) VALUES (?1, ?2, ?3)",
                params![tag.id.0, tag.name, tag.created_at_ms],
            )
            .map_err(database_error)?;
        Ok(tag)
    }

    pub(crate) fn set_collection_membership(
        &mut self,
        document_id: &DocumentId,
        collection_id: &CollectionId,
        included: bool,
    ) -> LibraryResult<()> {
        self.ensure_document(document_id)?;
        self.ensure_collection(collection_id)?;
        if included {
            self.connection
                .execute(
                    "INSERT OR IGNORE INTO document_collections (document_id, collection_id, created_at_ms) VALUES (?1, ?2, ?3)",
                    params![document_id.0, collection_id.0, now_unix_ms()],
                )
                .map_err(database_error)?;
        } else {
            self.connection
                .execute(
                    "DELETE FROM document_collections WHERE document_id = ?1 AND collection_id = ?2",
                    params![document_id.0, collection_id.0],
                )
                .map_err(database_error)?;
        }
        self.refresh_document_index(document_id)
    }

    pub(crate) fn set_tag_membership(
        &mut self,
        document_id: &DocumentId,
        tag_id: &TagId,
        included: bool,
    ) -> LibraryResult<()> {
        self.ensure_document(document_id)?;
        self.ensure_tag(tag_id)?;
        if included {
            self.connection
                .execute(
                    "INSERT OR IGNORE INTO document_tags (document_id, tag_id, created_at_ms) VALUES (?1, ?2, ?3)",
                    params![document_id.0, tag_id.0, now_unix_ms()],
                )
                .map_err(database_error)?;
        } else {
            self.connection
                .execute(
                    "DELETE FROM document_tags WHERE document_id = ?1 AND tag_id = ?2",
                    params![document_id.0, tag_id.0],
                )
                .map_err(database_error)?;
        }
        self.refresh_document_index(document_id)
    }

    pub(crate) fn set_favorite(
        &mut self,
        document_id: &DocumentId,
        favorite: bool,
    ) -> LibraryResult<()> {
        self.ensure_document(document_id)?;
        self.connection
            .execute(
                "INSERT INTO document_usage (document_id, is_favorite, updated_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(document_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at_ms = excluded.updated_at_ms",
                params![document_id.0, i64::from(favorite), now_unix_ms()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) fn record_recent_use(&mut self, document_id: &DocumentId) -> LibraryResult<()> {
        self.ensure_document(document_id)?;
        self.connection
            .execute(
                "INSERT INTO document_usage (document_id, is_favorite, last_used_at_ms, updated_at_ms) VALUES (?1, 0, ?2, ?2) ON CONFLICT(document_id) DO UPDATE SET last_used_at_ms = excluded.last_used_at_ms, updated_at_ms = excluded.updated_at_ms",
                params![document_id.0, now_unix_ms()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) fn set_document_search_fields(
        &mut self,
        document_id: &DocumentId,
        body: &str,
        ocr: &str,
    ) -> LibraryResult<()> {
        self.ensure_document(document_id)?;
        self.connection
            .execute(
                "INSERT INTO document_search_content (document_id, body, ocr, updated_at_ms) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(document_id) DO UPDATE SET body = excluded.body, ocr = excluded.ocr, updated_at_ms = excluded.updated_at_ms",
                params![document_id.0, body, ocr, now_unix_ms()],
            )
            .map_err(database_error)?;
        self.refresh_document_index(document_id)
    }

    pub(crate) fn rebuild_search_index(&mut self) -> LibraryResult<IndexRebuildSummary> {
        let started = Instant::now();
        let documents = self.all_documents()?;
        let mut indexed_count = 0;
        let mut failed_count = 0;
        for document in documents {
            self.refresh_document_index(&document.id)?;
            if self.index_state(&document.id)?.as_deref() == Some("ready") {
                indexed_count += 1;
            } else {
                failed_count += 1;
            }
        }
        Ok(IndexRebuildSummary {
            indexed_count,
            failed_count,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub(crate) fn search(&self, query: &SearchQuery) -> LibraryResult<SearchResults> {
        let started = Instant::now();
        let mut where_clauses = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        let text = query
            .text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let use_fts = text
            .map(|value| value.chars().count() >= 3)
            .unwrap_or(false);
        if let Some(text) = text {
            if use_fts {
                where_clauses.push("document_fts MATCH ?".to_owned());
                values.push(SqlValue::Text(fts_query(text)));
            } else {
                where_clauses.push("(d.display_name LIKE ? OR d.canonical_path LIKE ? OR EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id AND t.name LIKE ?))".to_owned());
                let needle = format!("%{text}%");
                values.extend(
                    [needle.clone(), needle.clone(), needle]
                        .into_iter()
                        .map(SqlValue::Text),
                );
            }
        }
        if !query.formats.is_empty() {
            where_clauses.push(format!(
                "d.format IN ({})",
                placeholders(query.formats.len())
            ));
            values.extend(
                query
                    .formats
                    .iter()
                    .map(|format| SqlValue::Text(format.as_str().to_owned())),
            );
        }
        if let Some(after) = query.modified_after_ms {
            where_clauses.push("d.modified_at_ms >= ?".to_owned());
            values.push(SqlValue::Integer(after));
        }
        if let Some(before) = query.modified_before_ms {
            where_clauses.push("d.modified_at_ms <= ?".to_owned());
            values.push(SqlValue::Integer(before));
        }
        if !query.source_root_ids.is_empty() {
            where_clauses.push(format!(
                "d.source_root_id IN ({})",
                placeholders(query.source_root_ids.len())
            ));
            values.extend(
                query
                    .source_root_ids
                    .iter()
                    .map(|id| SqlValue::Text(id.0.clone())),
            );
        }
        if let Some(collection_id) = &query.collection_id {
            where_clauses.push("EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = d.id AND dc.collection_id = ?)".to_owned());
            values.push(SqlValue::Text(collection_id.0.clone()));
        }
        for tag_id in &query.tag_ids {
            where_clauses.push("EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.tag_id = ?)".to_owned());
            values.push(SqlValue::Text(tag_id.0.clone()));
        }
        if !query.statuses.is_empty() {
            where_clauses.push(format!(
                "d.status IN ({})",
                placeholders(query.statuses.len())
            ));
            values.extend(
                query
                    .statuses
                    .iter()
                    .map(|status| SqlValue::Text(status.as_str().to_owned())),
            );
        }
        if query.favorite_only {
            where_clauses.push("COALESCE(u.is_favorite, 0) = 1".to_owned());
        }
        if query.recent_only {
            where_clauses.push("u.last_used_at_ms IS NOT NULL".to_owned());
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        let from_sql = if use_fts {
            "FROM document_fts JOIN documents d ON d.id = document_fts.document_id LEFT JOIN document_usage u ON u.document_id = d.id"
        } else {
            "FROM documents d LEFT JOIN document_fts ON document_fts.document_id = d.id LEFT JOIN document_usage u ON u.document_id = d.id"
        };
        let total: u64 = self
            .connection
            .query_row(
                &format!("SELECT COUNT(DISTINCT d.id) {from_sql} {where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get::<_, i64>(0),
            )
            .map_err(database_error)?
            .try_into()
            .unwrap_or(0);
        let limit = query.limit.clamp(1, 200);
        let offset = query.offset;
        let mut result_values = values.clone();
        result_values.push(SqlValue::Integer(i64::from(limit)));
        result_values.push(SqlValue::Integer(i64::from(offset)));
        let order = if use_fts {
            "ORDER BY bm25(document_fts, 12.0, 1.0, 4.0, 3.0, 1.0), d.modified_at_ms DESC"
        } else if query.recent_only {
            "ORDER BY u.last_used_at_ms DESC, d.display_name COLLATE NOCASE"
        } else {
            "ORDER BY d.modified_at_ms DESC, d.display_name COLLATE NOCASE"
        };
        let sql = format!(
            "SELECT d.id, d.source_root_id, d.canonical_path, d.display_name, d.format, d.size_bytes, d.modified_at_ms, d.file_identity, d.content_sha256, d.status, d.content_state, COALESCE(s.state, 'error'), COALESCE(u.is_favorite, 0), snippet(document_fts, 1, '<mark>', '</mark>', '...', 24), snippet(document_fts, 2, '<mark>', '</mark>', '...', 24), snippet(document_fts, 3, '<mark>', '</mark>', '...', 24), snippet(document_fts, 4, '<mark>', '</mark>', '...', 24), snippet(document_fts, 5, '<mark>', '</mark>', '...', 24) {from_sql} LEFT JOIN document_search_state s ON s.document_id = d.id {where_sql} {order} LIMIT ? OFFSET ?"
        );
        let mut statement = self.connection.prepare(&sql).map_err(database_error)?;
        let rows = statement
            .query_map(params_from_iter(result_values.iter()), |row| {
                let document = DocumentRecord {
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
                };
                Ok((
                    document,
                    row.get::<_, String>(11)?,
                    row.get::<_, i64>(12)? != 0,
                    (1..=5)
                        .map(|index| row.get::<_, String>(12 + index))
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                ))
            })
            .map_err(database_error)?;
        let mut items = Vec::new();
        for row in rows {
            let (document, index_state, is_favorite, snippets) = row.map_err(database_error)?;
            let fields = ["title", "body", "path", "tags", "ocr"];
            let snippets = snippets
                .into_iter()
                .enumerate()
                .filter(|(_, text)| !text.is_empty())
                .map(|(index, text)| SearchSnippet {
                    field: fields[index].to_owned(),
                    text,
                })
                .collect();
            items.push(SearchDocument {
                source_locator: source_locator(&document),
                tags: self.tags_for_document(&document.id)?,
                collections: self.collections_for_document(&document.id)?,
                document,
                snippets,
                is_favorite,
                index_state,
            });
        }
        Ok(SearchResults {
            items,
            total,
            query_time_ms: started.elapsed().as_millis() as u64,
        })
    }

    fn all_documents(&self) -> LibraryResult<Vec<DocumentRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents ORDER BY id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], document_from_row)
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub(crate) fn document_by_id(&self, id: &DocumentId) -> LibraryResult<Option<DocumentRecord>> {
        self.connection
            .query_row(
                "SELECT id, source_root_id, canonical_path, display_name, format, size_bytes, modified_at_ms, file_identity, content_sha256, status, content_state FROM documents WHERE id = ?1",
                params![id.0],
                document_from_row,
            )
            .optional()
            .map_err(database_error)
    }

    fn ensure_document(&self, id: &DocumentId) -> LibraryResult<()> {
        if self.document_by_id(id)?.is_some() {
            Ok(())
        } else {
            Err(LibraryError::new(
                LibraryErrorCode::SourceNotFound,
                "document was not found",
            ))
        }
    }

    fn ensure_collection(&self, id: &CollectionId) -> LibraryResult<()> {
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
                params![id.0],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        exists.then_some(()).ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "collection was not found",
            )
        })
    }

    fn ensure_tag(&self, id: &TagId) -> LibraryResult<()> {
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tags WHERE id = ?1)",
                params![id.0],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        exists.then_some(()).ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::InvalidArgument, "tag was not found")
        })
    }

    fn tags_for_document(&self, document_id: &DocumentId) -> LibraryResult<Vec<TagRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT t.id, t.name, t.created_at_ms FROM tags t JOIN document_tags dt ON dt.tag_id = t.id WHERE dt.document_id = ?1 ORDER BY t.name COLLATE NOCASE")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![document_id.0], |row| {
                Ok(TagRecord {
                    id: TagId(row.get(0)?),
                    name: row.get(1)?,
                    created_at_ms: row.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    fn collections_for_document(
        &self,
        document_id: &DocumentId,
    ) -> LibraryResult<Vec<CollectionRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT c.id, c.name, c.created_at_ms FROM collections c JOIN document_collections dc ON dc.collection_id = c.id WHERE dc.document_id = ?1 ORDER BY c.name COLLATE NOCASE")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![document_id.0], |row| {
                Ok(CollectionRecord {
                    id: CollectionId(row.get(0)?),
                    name: row.get(1)?,
                    created_at_ms: row.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    fn refresh_document_index(&mut self, document_id: &DocumentId) -> LibraryResult<()> {
        let Some(document) = self.document_by_id(document_id)? else {
            return Ok(());
        };
        let tags = self
            .tags_for_document(document_id)?
            .into_iter()
            .map(|tag| tag.name)
            .collect::<Vec<_>>()
            .join(" ");
        let (body, ocr): (String, String) = self
            .connection
            .query_row(
                "SELECT body, ocr FROM document_search_content WHERE document_id = ?1",
                params![document_id.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(database_error)?
            .unwrap_or_default();
        let result = (|| {
            self.connection
                .execute(
                    "DELETE FROM document_fts WHERE document_id = ?1",
                    params![document_id.0],
                )
                .map_err(database_error)?;
            self.connection
                .execute(
                    "INSERT INTO document_fts (document_id, title, body, path, tags, ocr) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![document.id.0, document.display_name, body, document.canonical_path, tags, ocr],
                )
                .map_err(database_error)?;
            Ok::<(), LibraryError>(())
        })();
        match result {
            Ok(()) => self.set_index_state(document_id, "ready", None),
            Err(error) => self.set_index_state(document_id, "error", Some(&error.code)),
        }
    }

    fn set_index_state(
        &mut self,
        document_id: &DocumentId,
        state: &str,
        error_code: Option<&str>,
    ) -> LibraryResult<()> {
        self.connection
            .execute(
                "INSERT INTO document_search_state (document_id, state, error_code, updated_at_ms) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(document_id) DO UPDATE SET state = excluded.state, error_code = excluded.error_code, updated_at_ms = excluded.updated_at_ms",
                params![document_id.0, state, error_code, now_unix_ms()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    fn index_state(&self, document_id: &DocumentId) -> LibraryResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT state FROM document_search_state WHERE document_id = ?1",
                params![document_id.0],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
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
        // Metadata is committed before the best-effort search refresh. An index failure
        // is recorded separately so a malformed field can never remove a Document.
        self.refresh_document_index(&document.id)?;
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

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn fts_query(text: &str) -> String {
    text.split_whitespace()
        .filter(|part| !part.is_empty())
        .map(|part| format!("\"{}\"", part.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn source_locator(document: &DocumentRecord) -> SourceLocator {
    let kind = match document.format {
        DocumentFormat::Pdf => "page",
        DocumentFormat::Pptx => "slide",
        DocumentFormat::Docx
        | DocumentFormat::Markdown
        | DocumentFormat::Text
        | DocumentFormat::Csv => "paragraph",
        _ => "document",
    };
    SourceLocator {
        kind: kind.to_owned(),
        page: None,
        slide: None,
        paragraph: None,
        available: false,
        reason: Some("正文提取与页码、幻灯片、段落定位尚未实现".to_owned()),
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
    use std::time::Instant;

    use rusqlite::params;

    use super::LibraryDatabase;
    use crate::library::model::{
        DocumentFormat, DocumentId, DocumentRecord, DocumentStatus, ScanJobId, SearchQuery,
        SourceKind,
    };

    fn insert_document(
        database: &mut LibraryDatabase,
        id: &str,
        title: &str,
        format: DocumentFormat,
    ) -> DocumentId {
        let source = database
            .register_source(SourceKind::Directory, "C:/authorized", "authorized")
            .expect("source should exist");
        let document_id = DocumentId(id.to_owned());
        database
            .upsert_document(
                &DocumentRecord {
                    id: document_id.clone(),
                    source_root_id: source.source.id,
                    canonical_path: format!("C:/authorized/{title}"),
                    display_name: title.to_owned(),
                    format,
                    size_bytes: 10,
                    modified_at_ms: 100,
                    file_identity: None,
                    content_sha256: format!("hash-{id}"),
                    status: DocumentStatus::Present,
                    content_state: "pending".to_owned(),
                },
                &ScanJobId("job-test".to_owned()),
            )
            .expect("document should be stored");
        document_id
    }

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
        assert_eq!(version, 2);
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

    #[test]
    fn supports_chinese_substring_weighted_search_and_combined_filters() {
        let mut database = LibraryDatabase::in_memory().expect("database should open");
        let design = insert_document(
            &mut database,
            "doc-design",
            "产品设计说明.md",
            DocumentFormat::Markdown,
        );
        let plan = insert_document(
            &mut database,
            "doc-plan",
            "项目计划.txt",
            DocumentFormat::Text,
        );
        database
            .set_document_search_fields(&design, "这是关于全文检索和标签组织的产品设计正文", "")
            .expect("content should index");
        database
            .set_document_search_fields(&plan, "全文检索的实施计划", "")
            .expect("content should index");
        let tag = database.create_tag("检索").expect("tag should create");
        let collection = database
            .create_collection("产品")
            .expect("collection should create");
        database
            .set_tag_membership(&design, &tag.id, true)
            .expect("tag relation");
        database
            .set_collection_membership(&design, &collection.id, true)
            .expect("collection relation");
        database
            .set_favorite(&design, true)
            .expect("favorite should save");

        let query = SearchQuery {
            text: Some("全文检索".to_owned()),
            formats: vec![DocumentFormat::Markdown],
            collection_id: Some(collection.id),
            tag_ids: vec![tag.id],
            favorite_only: true,
            limit: 20,
            ..SearchQuery::default()
        };
        let results = database.search(&query).expect("search should work");
        assert_eq!(results.total, 1);
        assert_eq!(results.items[0].document.id, design);
        assert!(
            results.items[0]
                .snippets
                .iter()
                .any(|snippet| snippet.field == "body")
        );
        assert!(!results.items[0].source_locator.available);
        assert_eq!(results.items[0].source_locator.kind, "paragraph");
    }

    #[test]
    fn keeps_many_to_many_relationships_and_rebuilds_index_without_metadata_loss() {
        let mut database = LibraryDatabase::in_memory().expect("database should open");
        let first = insert_document(
            &mut database,
            "doc-first",
            "会议纪要.txt",
            DocumentFormat::Text,
        );
        let second = insert_document(
            &mut database,
            "doc-second",
            "研究笔记.txt",
            DocumentFormat::Text,
        );
        let tag = database.create_tag("项目A").expect("tag should create");
        let collection = database
            .create_collection("进行中")
            .expect("collection should create");
        database
            .set_tag_membership(&first, &tag.id, true)
            .expect("relation should save");
        database
            .set_tag_membership(&second, &tag.id, true)
            .expect("relation should save");
        database
            .set_collection_membership(&first, &collection.id, true)
            .expect("relation should save");
        database
            .set_collection_membership(&second, &collection.id, true)
            .expect("relation should save");
        let rebuild = database
            .rebuild_search_index()
            .expect("rebuild should work");
        assert_eq!(rebuild.indexed_count, 2);
        assert!(database.document_by_id(&first).unwrap().is_some());
        assert_eq!(
            database
                .search(&SearchQuery {
                    text: Some("项目A".to_owned()),
                    limit: 20,
                    ..SearchQuery::default()
                })
                .unwrap()
                .total,
            2
        );
    }

    #[test]
    fn indexed_query_p95_is_below_three_hundred_ms_for_representative_dataset() {
        let mut database = LibraryDatabase::in_memory().expect("database should open");
        for index in 0..1_000 {
            let id = insert_document(
                &mut database,
                &format!("doc-{index}"),
                &format!("项目资料-{index}.txt"),
                DocumentFormat::Text,
            );
            database
                .set_document_search_fields(
                    &id,
                    "中文全文检索性能代表性资料集，包含项目计划和资料组织内容",
                    "",
                )
                .expect("content should index");
        }
        let mut durations = Vec::new();
        for _ in 0..30 {
            let started = Instant::now();
            let results = database
                .search(&SearchQuery {
                    text: Some("全文检索".to_owned()),
                    limit: 50,
                    ..SearchQuery::default()
                })
                .expect("search should work");
            assert_eq!(results.total, 1_000);
            durations.push(started.elapsed().as_millis() as u64);
        }
        durations.sort_unstable();
        let p95 = durations[((durations.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)];
        eprintln!("search_perf dataset=1000 queries=30 limit=50 p95_ms={p95}");
        assert!(p95 < 300, "p95 was {p95}ms");
    }
}
