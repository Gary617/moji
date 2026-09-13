use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

use file_id::get_file_id;
use quick_xml::{Reader, events::Event};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    database::LibraryDatabase,
    model::{
        AiActionInput, AiActionRecord, DocumentFormat, DocumentId, DocumentRecord, DocumentStatus,
        LibraryError, LibraryErrorCode, LibraryResult, ScanEvent, ScanEventKind, ScanJobId,
        ScanJobRecord, ScanJobState, ScanJobUpdate, ScanSummary, SourceKind, SourceRegistration,
        SourceRootId, WatchStatus, new_identifier, now_unix_ms,
    },
    policy::{
        AuthorizedSource, authorize_candidate, authorize_source, canonical_path_string,
        exclusion_reason, format_from_path,
    },
    watcher::LibraryWatcher,
};

pub(crate) struct LibraryService {
    pub(crate) database: LibraryDatabase,
    watchers: HashMap<SourceRootId, LibraryWatcher>,
    pub(crate) ocr_model_dir: PathBuf,
}

// Persisting one event for every unsupported entry can grow the database by
// hundreds of thousands of rows during a broad scan. Keep representative
// details while the counters on the scan job carry the complete progress.
const MAX_SCAN_EVENT_DETAILS: usize = 256;

impl LibraryService {
    pub(crate) fn open(path: impl AsRef<Path>) -> LibraryResult<Self> {
        Self::open_with_recovery(path, true)
    }

    pub(crate) fn open_worker(path: impl AsRef<Path>) -> LibraryResult<Self> {
        Self::open_with_recovery(path, false)
    }

    fn open_with_recovery(path: impl AsRef<Path>, recover_jobs: bool) -> LibraryResult<Self> {
        let database_path = path.as_ref().to_path_buf();
        let mut database = LibraryDatabase::open(&database_path)?;
        if recover_jobs {
            database.recover_running_jobs()?;
            database.recover_running_ocr_jobs()?;
        }
        Ok(Self {
            database,
            watchers: HashMap::new(),
            ocr_model_dir: database_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("ocr-models"),
        })
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> LibraryResult<Self> {
        Ok(Self {
            database: LibraryDatabase::in_memory()?,
            watchers: HashMap::new(),
            ocr_model_dir: std::env::temp_dir().join("moji-ocr-models"),
        })
    }

    pub(crate) fn record_ai_action(
        &self,
        input: AiActionInput<'_>,
    ) -> LibraryResult<AiActionRecord> {
        self.database.record_ai_action(input)
    }

    pub(crate) fn register_source(
        &mut self,
        input: impl AsRef<Path>,
    ) -> LibraryResult<SourceRegistration> {
        let source = authorize_source(input)?;
        if source.kind == SourceKind::SingleFile
            && format_from_path(&source.canonical_path).is_none()
        {
            return Err(LibraryError::new(
                LibraryErrorCode::UnsupportedFile,
                "file format is not supported",
            ));
        }
        self.database.register_source(
            source.kind,
            &canonical_path_string(&source.canonical_path),
            &source.display_name,
        )
    }

    pub(crate) fn enqueue_scan(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<ScanJobRecord> {
        let mut queue = super::queue::ScanQueue::new(&mut self.database);
        queue.enqueue(source_root_id)
    }

    pub(crate) fn resume_scan(&mut self, scan_job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        let mut queue = super::queue::ScanQueue::new(&mut self.database);
        queue.resume(scan_job_id)
    }

    pub(crate) fn retry_scan(&mut self, scan_job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        let mut queue = super::queue::ScanQueue::new(&mut self.database);
        queue.retry(scan_job_id)
    }

    #[cfg(test)]
    pub(crate) fn scan_source(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<ScanSummary> {
        let job = self.enqueue_scan(source_root_id)?;
        self.run_scan_job(&job.id)
    }

    pub(crate) fn run_scan_job(&mut self, scan_job_id: &ScanJobId) -> LibraryResult<ScanSummary> {
        let mut job = {
            let mut queue = super::queue::ScanQueue::new(&mut self.database);
            queue.start(scan_job_id)?
        };
        let source_record = self
            .database
            .source_by_id(&job.source_root_id)?
            .ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::SourceNotFound,
                    "source root was not found",
                )
            })?;
        let known_documents = self.database.documents_for_source(&job.source_root_id)?;
        let source = match authorize_source(&source_record.canonical_path) {
            Ok(source) => source,
            Err(error)
                if error.code_is(LibraryErrorCode::SourceNotFound)
                    && source_is_gone(&source_record.canonical_path) =>
            {
                return self.complete_missing_source(job, known_documents);
            }
            Err(error) => {
                let _ = self.database.update_job(ScanJobUpdate {
                    id: &job.id,
                    state: ScanJobState::Failed,
                    scanned_count: 0,
                    total_count: job.total_count,
                    current_file_name: None,
                    changed_count: 0,
                    failed_count: 1,
                    retry_count: job.retry_count,
                    error_code: Some(&error.code),
                    started_at_ms: job.started_at_ms,
                    completed_at_ms: Some(now_unix_ms()),
                });
                return Err(error);
            }
        };
        let known_by_path = known_documents
            .iter()
            .map(|document| (document.canonical_path.clone(), document.clone()))
            .collect::<HashMap<_, _>>();
        let mut seen_paths = HashSet::new();
        let mut pre_events = Vec::new();
        let mut scanned_count = 0u64;
        let mut changed_count = 0u64;

        // Publish a running state before walking the directory. Large trees can take
        // minutes to enumerate, and the UI must be able to show activity and cancel it.
        job = self.database.update_job(ScanJobUpdate {
            id: &job.id,
            state: ScanJobState::Running,
            scanned_count,
            total_count: 0,
            current_file_name: Some("正在枚举目录"),
            changed_count,
            failed_count: 0,
            retry_count: job.retry_count,
            error_code: None,
            started_at_ms: Some(job.started_at_ms.unwrap_or_else(now_unix_ms)),
            completed_at_ms: None,
        })?;

        let job_id = job.id.clone();
        let retry_count = job.retry_count;
        let mut discovered_count = 0u64;
        let mut files = match collect_files(&source, &mut pre_events, &job_id, &mut |path| {
            discovered_count += 1;
            if discovered_count % 128 != 0 {
                return Ok(false);
            }
            let current_file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("文件");
            Ok(self
                .database
                .update_running_progress(
                    &job_id,
                    discovered_count,
                    0,
                    Some(current_file_name),
                    changed_count,
                    0,
                    retry_count,
                )?
                .is_none())
        }) {
            Ok(files) => files,
            Err(error) => {
                let _ = self.database.update_job(ScanJobUpdate {
                    id: &job.id,
                    state: ScanJobState::Failed,
                    scanned_count: 0,
                    total_count: job.total_count,
                    current_file_name: None,
                    changed_count: 0,
                    failed_count: 1,
                    retry_count: job.retry_count,
                    error_code: Some(&error.code),
                    started_at_ms: job.started_at_ms,
                    completed_at_ms: Some(now_unix_ms()),
                });
                return Err(error);
            }
        };
        if files.interrupted {
            for event in pre_events {
                let _ = self.database.add_event(
                    &job_id,
                    event.document_id.as_ref(),
                    event.kind,
                    &event.details,
                );
            }
            return Ok(ScanSummary {
                job: self.current_job(&job_id)?,
                events: Vec::new(),
            });
        }
        let files = std::mem::take(&mut files.paths);
        let mut events = Vec::new();
        for event in pre_events {
            events.push(self.database.add_event(
                &job.id,
                event.document_id.as_ref(),
                event.kind,
                &event.details,
            )?);
        }
        let mut failed_count = events
            .iter()
            .filter(|event| event.kind == ScanEventKind::Error)
            .count() as u64;
        let total_count = files.len() as u64;
        job = self.database.update_job(ScanJobUpdate {
            id: &job.id,
            state: ScanJobState::Running,
            scanned_count,
            total_count,
            current_file_name: None,
            changed_count,
            failed_count,
            retry_count: job.retry_count,
            error_code: None,
            started_at_ms: Some(job.started_at_ms.unwrap_or_else(now_unix_ms)),
            completed_at_ms: None,
        })?;
        for path in files {
            if let Some(current) = self.interrupted_job(&job.id)? {
                return Ok(ScanSummary {
                    job: current,
                    events,
                });
            }
            let canonical = canonical_path_string(&path);
            let current_file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("文件");
            seen_paths.insert(canonical.clone());
            scanned_count += 1;
            match self.reconcile_file(&source, &job.source_root_id, &job.id, &path) {
                Ok(Some((event, changed))) => {
                    if changed {
                        changed_count += 1;
                    }
                    events.push(event);
                }
                Ok(None) => {}
                Err(error) => {
                    failed_count += 1;
                    if let Some(existing) = known_by_path.get(&canonical) {
                        events.push(self.database.add_event(
                            &job.id,
                            Some(&existing.id),
                            ScanEventKind::Error,
                            &json!({ "displayName": existing.display_name, "code": error.code, "message": error.message }),
                        )?);
                    } else {
                        events.push(self.database.add_event(
                            &job.id,
                            None,
                            ScanEventKind::Error,
                            &json!({ "displayName": path.file_name().and_then(|name| name.to_str()).unwrap_or("file"), "code": error.code, "message": error.message }),
                        )?);
                    }
                }
            }
            let Some(updated) = self.database.update_running_progress(
                &job.id,
                scanned_count,
                total_count,
                Some(current_file_name),
                changed_count,
                failed_count,
                job.retry_count,
            )?
            else {
                return Ok(ScanSummary {
                    job: self.current_job(&job.id)?,
                    events,
                });
            };
            job = updated;
        }

        for document in known_documents {
            if let Some(current) = self.interrupted_job(&job.id)? {
                return Ok(ScanSummary {
                    job: current,
                    events,
                });
            }
            // Images are intentionally outside the new scan scope. Keep existing
            // image records untouched instead of marking them missing when a
            // document source is rescanned.
            if matches!(
                document.format,
                DocumentFormat::Png
                    | DocumentFormat::Jpg
                    | DocumentFormat::Tiff
                    | DocumentFormat::Bmp
            ) {
                continue;
            }
            if document.status != DocumentStatus::Missing
                && !seen_paths.contains(&document.canonical_path)
            {
                self.database.mark_missing(&document.id, &job.id)?;
                events.push(self.database.add_event(
                    &job.id,
                    Some(&document.id),
                    ScanEventKind::Missing,
                    &json!({ "displayName": document.display_name }),
                )?);
                changed_count += 1;
                let Some(updated) = self.database.update_running_progress(
                    &job.id,
                    scanned_count,
                    total_count,
                    None,
                    changed_count,
                    failed_count,
                    job.retry_count,
                )?
                else {
                    return Ok(ScanSummary {
                        job: self.current_job(&job.id)?,
                        events,
                    });
                };
                job = updated;
            }
        }

        if let Some(current) = self.interrupted_job(&job.id)? {
            return Ok(ScanSummary {
                job: current,
                events,
            });
        }
        let final_state = if failed_count > 0 {
            ScanJobState::Failed
        } else {
            ScanJobState::Completed
        };
        job = self.database.update_job(ScanJobUpdate {
            id: &job.id,
            state: final_state,
            scanned_count,
            total_count,
            current_file_name: None,
            changed_count,
            failed_count,
            retry_count: job.retry_count,
            error_code: (failed_count > 0).then_some("SCAN_FILE_FAILED"),
            started_at_ms: job.started_at_ms,
            completed_at_ms: Some(now_unix_ms()),
        })?;
        Ok(ScanSummary { job, events })
    }

    fn current_job(&self, scan_job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.database.job(scan_job_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::ScanJobNotFound, "scan job was not found")
        })
    }

    fn interrupted_job(&self, scan_job_id: &ScanJobId) -> LibraryResult<Option<ScanJobRecord>> {
        let job = self.current_job(scan_job_id)?;
        Ok((job.state != ScanJobState::Running).then_some(job))
    }

    fn complete_missing_source(
        &mut self,
        mut job: ScanJobRecord,
        known_documents: Vec<DocumentRecord>,
    ) -> LibraryResult<ScanSummary> {
        let mut events = Vec::new();
        let mut changed_count = 0;
        for document in known_documents {
            if document.status == DocumentStatus::Missing {
                continue;
            }
            self.database.mark_missing(&document.id, &job.id)?;
            events.push(self.database.add_event(
                &job.id,
                Some(&document.id),
                ScanEventKind::Missing,
                &json!({ "displayName": document.display_name }),
            )?);
            changed_count += 1;
        }
        job = self.database.update_job(ScanJobUpdate {
            id: &job.id,
            state: ScanJobState::Completed,
            scanned_count: 0,
            total_count: 0,
            current_file_name: None,
            changed_count,
            failed_count: 0,
            retry_count: job.retry_count,
            error_code: None,
            started_at_ms: job.started_at_ms,
            completed_at_ms: Some(now_unix_ms()),
        })?;
        Ok(ScanSummary { job, events })
    }

    pub(crate) fn watch_source(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<WatchStatus> {
        let source_record = self.database.source_by_id(source_root_id)?.ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::SourceNotFound,
                "source root was not found",
            )
        })?;
        let source = authorize_source(&source_record.canonical_path)?;
        self.watchers
            .insert(source_root_id.clone(), LibraryWatcher::start(source)?);
        Ok(WatchStatus {
            source_root_id: source_root_id.clone(),
            running: true,
        })
    }

    pub(crate) fn poll_watch_changes(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<bool> {
        {
            let watcher = self.watchers.get(source_root_id).ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::WatcherUnavailable,
                    "source watcher is not running",
                )
                .retryable()
            })?;
            Ok(!watcher.drain().is_empty())
        }
    }

    fn reconcile_file(
        &mut self,
        source: &AuthorizedSource,
        source_root_id: &SourceRootId,
        scan_job_id: &ScanJobId,
        path: &Path,
    ) -> LibraryResult<Option<(ScanEvent, bool)>> {
        let path = authorize_candidate(source, path)?;
        let format = format_from_path(&path).ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::UnsupportedFile,
                "file format is not supported",
            )
        })?;
        let metadata = fs::metadata(&path).map_err(|error| {
            LibraryError::new(
                LibraryErrorCode::MetadataReadFailed,
                "file metadata could not be read",
            )
            .retryable()
            .with_details(json!({ "kind": format!("{:?}", error.kind()) }))
        })?;
        let canonical = canonical_path_string(&path);
        let existing_path = self.database.document_by_path(&canonical)?;
        if let Some(existing) = existing_path.as_ref() {
            // A later scan is the explicit way to bring a softly removed file
            // back into the library; the source file itself was never deleted.
            self.database.restore_from_library_scan(&existing.id)?;
        }
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if let Some(existing) = existing_path.as_ref() {
            if existing.status == DocumentStatus::Present
                && existing.format == format
                && existing.size_bytes == metadata.len()
                && existing.modified_at_ms == modified_at_ms
            {
                return Ok(None);
            }
        }
        let hash = hash_file(&path)?;
        let identity = get_file_id(&path).ok().map(|value| format!("{value:?}"));
        let existing = if existing_path.is_some() {
            existing_path
        } else if let Some(identity) = identity.as_deref() {
            self.database
                .document_by_identity(source_root_id, identity)?
        } else {
            let candidates = self.database.documents_by_hash(source_root_id, &hash)?;
            let missing = candidates
                .into_iter()
                .filter(|document| {
                    document.canonical_path != canonical
                        && !Path::new(&document.canonical_path).exists()
                })
                .collect::<Vec<_>>();
            (missing.len() == 1).then(|| missing.into_iter().next().expect("one candidate"))
        };
        let document = DocumentRecord {
            id: existing
                .as_ref()
                .map(|document| document.id.clone())
                .unwrap_or_else(|| DocumentId(new_identifier("doc"))),
            source_root_id: source_root_id.clone(),
            canonical_path: canonical,
            display_name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("document")
                .to_owned(),
            format,
            size_bytes: metadata.len(),
            modified_at_ms,
            file_identity: identity,
            content_sha256: hash,
            status: DocumentStatus::Present,
            content_state: "pending".to_owned(),
        };
        let changed = existing
            .as_ref()
            .map(|previous| {
                previous.canonical_path != document.canonical_path
                    || previous.size_bytes != document.size_bytes
                    || previous.modified_at_ms != document.modified_at_ms
                    || previous.content_sha256 != document.content_sha256
                    || previous.status != DocumentStatus::Present
            })
            .unwrap_or(true);
        let kind = match existing {
            None => ScanEventKind::Discovered,
            Some(previous) if previous.canonical_path != document.canonical_path => {
                ScanEventKind::Renamed
            }
            Some(_) if changed => ScanEventKind::Updated,
            Some(_) => {
                if matches!(
                    document.format,
                    super::model::DocumentFormat::Doc
                        | super::model::DocumentFormat::Docx
                        | super::model::DocumentFormat::Markdown
                        | super::model::DocumentFormat::Text
                        | super::model::DocumentFormat::Csv
                ) {
                    let body = extract_indexable_text(&path, document.format).unwrap_or_default();
                    self.database
                        .set_document_search_fields(&document.id, &body, "")?;
                }
                return Ok(None);
            }
        };
        self.database.upsert_document(&document, scan_job_id)?;
        let body = extract_indexable_text(&path, document.format).unwrap_or_default();
        self.database
            .set_document_search_fields(&document.id, &body, "")?;
        let event = self.database.add_event(
            scan_job_id,
            Some(&document.id),
            kind,
            &json!({ "displayName": document.display_name, "format": document.format.as_str() }),
        )?;
        Ok(Some((event, changed)))
    }
}

fn extract_indexable_text(
    path: &Path,
    format: super::model::DocumentFormat,
) -> LibraryResult<String> {
    match format {
        super::model::DocumentFormat::Markdown
        | super::model::DocumentFormat::Text
        | super::model::DocumentFormat::Csv => fs::read_to_string(path).map_err(|error| {
            LibraryError::new(LibraryErrorCode::DocumentReadFailed, "正文内容无法读取")
                .retryable()
                .with_details(json!({ "kind": format!("{:?}", error.kind()) }))
        }),
        super::model::DocumentFormat::Docx => {
            let file = File::open(path).map_err(|error| {
                LibraryError::new(LibraryErrorCode::DocumentReadFailed, "DOCX 文件无法读取")
                    .retryable()
                    .with_details(json!({ "kind": format!("{:?}", error.kind()) }))
            })?;
            let mut archive = zip::ZipArchive::new(file).map_err(|_| {
                LibraryError::new(LibraryErrorCode::DocumentReadFailed, "DOCX 压缩包无法读取")
            })?;
            let mut xml = String::new();
            archive
                .by_name("word/document.xml")
                .map_err(|_| {
                    LibraryError::new(LibraryErrorCode::DocumentReadFailed, "DOCX 正文部件不存在")
                })?
                .read_to_string(&mut xml)
                .map_err(|_| {
                    LibraryError::new(
                        LibraryErrorCode::DocumentReadFailed,
                        "DOCX 正文编码无法读取",
                    )
                })?;
            let mut reader = Reader::from_str(&xml);
            reader.config_mut().trim_text(true);
            let mut text = String::new();
            loop {
                match reader.read_event() {
                    Ok(Event::Text(value)) => {
                        let value = value.decode().map_err(|_| {
                            LibraryError::new(
                                LibraryErrorCode::DocumentReadFailed,
                                "DOCX 文本无法解码",
                            )
                        })?;
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(&value);
                    }
                    Ok(Event::Eof) => break,
                    Ok(_) => {}
                    Err(_) => {
                        return Err(LibraryError::new(
                            LibraryErrorCode::DocumentReadFailed,
                            "DOCX XML 无法解析",
                        ));
                    }
                }
            }
            Ok(text)
        }
        // Legacy binary DOC has no bundled parser in the desktop runtime yet.
        super::model::DocumentFormat::Doc => Ok(String::new()),
        _ => Ok(String::new()),
    }
}

struct FileCollection {
    paths: Vec<PathBuf>,
    interrupted: bool,
}

fn collect_files<F>(
    source: &AuthorizedSource,
    events: &mut Vec<ScanEvent>,
    scan_job_id: &ScanJobId,
    should_stop: &mut F,
) -> LibraryResult<FileCollection>
where
    F: FnMut(&Path) -> LibraryResult<bool>,
{
    let mut files = Vec::new();
    if source.kind == SourceKind::SingleFile {
        if format_from_path(&source.canonical_path).is_some() {
            let interrupted = should_stop(&source.canonical_path)?;
            files.push(source.canonical_path.clone());
            return Ok(FileCollection {
                paths: files,
                interrupted,
            });
        }
        return Ok(FileCollection {
            paths: files,
            interrupted: false,
        });
    }
    let interrupted = walk_directory(
        &source.canonical_path,
        &mut files,
        events,
        scan_job_id,
        should_stop,
    )?;
    Ok(FileCollection {
        paths: files,
        interrupted,
    })
}

fn source_is_gone(path: &str) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

fn walk_directory<F>(
    path: &Path,
    files: &mut Vec<PathBuf>,
    events: &mut Vec<ScanEvent>,
    scan_job_id: &ScanJobId,
    should_stop: &mut F,
) -> LibraryResult<bool>
where
    F: FnMut(&Path) -> LibraryResult<bool>,
{
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            // A broad scan should keep walking when one protected directory is
            // unreadable. The event is retained for the task summary while the
            // rest of the source continues in the background.
            if events.len() < MAX_SCAN_EVENT_DETAILS {
                events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Skipped,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({
                        "displayName": path.file_name().and_then(|name| name.to_str()).unwrap_or("directory"),
                        "code": "DIRECTORY_READ_SKIPPED",
                        "kind": format!("{:?}", error.kind()),
                    }),
                });
            }
            return Ok(false);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_error) => {
                if events.len() < MAX_SCAN_EVENT_DETAILS {
                    events.push(ScanEvent {
                        id: -1,
                        scan_job_id: scan_job_id.clone(),
                        document_id: None,
                        kind: ScanEventKind::Error,
                        occurred_at_ms: now_unix_ms(),
                        details: json!({ "code": "DIRECTORY_ENTRY_FAILED" }),
                    });
                }
                continue;
            }
        };
        let child = entry.path();
        if should_stop(&child)? {
            return Ok(true);
        }
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(_error) => {
                if events.len() < MAX_SCAN_EVENT_DETAILS {
                    events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Error,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("entry"), "code": "METADATA_READ_FAILED" }),
                    });
                }
                continue;
            }
        };
        if let Some(reason) = exclusion_reason(&child, &metadata) {
            if events.len() < MAX_SCAN_EVENT_DETAILS {
                events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Skipped,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("entry"), "reason": reason }),
                });
            }
            continue;
        }
        if metadata.is_dir() {
            if walk_directory(&child, files, events, scan_job_id, should_stop)? {
                return Ok(true);
            }
        } else if metadata.is_file() {
            if format_from_path(&child).is_some() {
                files.push(child);
            } else {
                if events.len() < MAX_SCAN_EVENT_DETAILS {
                    events.push(ScanEvent {
                        id: -1,
                        scan_job_id: scan_job_id.clone(),
                        document_id: None,
                        kind: ScanEventKind::Skipped,
                        occurred_at_ms: now_unix_ms(),
                        details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("file"), "reason": "unsupported_format" }),
                    });
                }
                continue;
            }
        }
    }
    Ok(false)
}

fn hash_file(path: &Path) -> LibraryResult<String> {
    let file = File::open(path).map_err(hash_read_error)?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(hash_read_error)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize()[..]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn hash_read_error(error: std::io::Error) -> LibraryError {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        LibraryErrorCode::PermissionDenied
    } else {
        LibraryErrorCode::HashReadFailed
    };
    LibraryError::new(code, "file content could not be read for hashing")
        .retryable()
        .with_details(json!({ "kind": format!("{:?}", error.kind()) }))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::LibraryService;
    use crate::library::model::{DocumentStatus, ScanEventKind};

    struct TempTree(PathBuf);
    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "moji-scan-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scans_register_metadata_and_reconciles_modify_delete_and_rename() {
        let tree = TempTree::new();
        fs::write(tree.0.join("report.docx"), "version one").unwrap();
        fs::write(tree.0.join("notes.txt"), "notes").unwrap();
        fs::write(tree.0.join("ignored.bin"), "ignored").unwrap();
        fs::create_dir(tree.0.join("node_modules")).unwrap();
        fs::write(tree.0.join("node_modules").join("nested.docx"), "ignored").unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let registration = service.register_source(&tree.0).unwrap();
        let first = service.scan_source(&registration.source.id).unwrap();
        assert_eq!(first.job.state.as_str(), "completed");
        assert_eq!(first.job.failed_count, 0);
        assert!(
            first
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Discovered)
        );
        assert!(
            first
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Skipped)
        );
        let docs = service
            .database
            .documents_for_source(&registration.source.id)
            .unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(
            service
                .database
                .events_for_job(&first.job.id)
                .unwrap()
                .len(),
            first.events.len()
        );
        let original_id = docs
            .iter()
            .find(|document| document.display_name == "report.docx")
            .unwrap()
            .id
            .clone();

        let second = service.scan_source(&registration.source.id).unwrap();
        assert!(
            second
                .events
                .iter()
                .all(|event| event.kind == ScanEventKind::Skipped)
        );

        fs::write(tree.0.join("report.docx"), "version two").unwrap();
        let third = service.scan_source(&registration.source.id).unwrap();
        assert!(
            third
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Updated)
        );

        fs::rename(tree.0.join("report.docx"), tree.0.join("renamed.docx")).unwrap();
        let fourth = service.scan_source(&registration.source.id).unwrap();
        assert!(
            fourth
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Renamed)
        );
        let renamed = service
            .database
            .documents_for_source(&registration.source.id)
            .unwrap()
            .into_iter()
            .find(|document| document.display_name == "renamed.docx")
            .unwrap();
        assert_eq!(renamed.id, original_id);

        fs::remove_file(tree.0.join("notes.txt")).unwrap();
        let fifth = service.scan_source(&registration.source.id).unwrap();
        assert!(
            fifth
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Missing)
        );
        let notes = service
            .database
            .documents_for_source(&registration.source.id)
            .unwrap()
            .into_iter()
            .find(|document| document.display_name == "notes.txt")
            .unwrap();
        assert_eq!(notes.status, DocumentStatus::Missing);
    }

    #[test]
    fn duplicate_source_registration_is_idempotent() {
        let tree = TempTree::new();
        let mut service = LibraryService::in_memory().unwrap();
        let first = service.register_source(&tree.0).unwrap();
        let second = service.register_source(&tree.0).unwrap();
        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.source.id, second.source.id);
    }

    #[test]
    fn scans_single_file_and_marks_external_deletion_missing() {
        let tree = TempTree::new();
        let file = tree.0.join("single.txt");
        fs::write(&file, "single file").unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let source = service.register_source(&file).unwrap();
        let first = service.scan_source(&source.source.id).unwrap();
        assert_eq!(
            first.job.state,
            crate::library::model::ScanJobState::Completed
        );
        assert_eq!(
            service
                .database
                .documents_for_source(&source.source.id)
                .unwrap()
                .len(),
            1
        );
        fs::remove_file(&file).unwrap();
        let second = service.scan_source(&source.source.id).unwrap();
        assert_eq!(
            second.job.state,
            crate::library::model::ScanJobState::Completed
        );
        assert!(
            second
                .events
                .iter()
                .any(|event| event.kind == ScanEventKind::Missing)
        );
        assert_eq!(
            service
                .database
                .documents_for_source(&source.source.id)
                .unwrap()[0]
                .status,
            DocumentStatus::Missing
        );
    }

    #[test]
    fn worker_open_does_not_pause_jobs_owned_by_the_current_process() {
        let tree = TempTree::new();
        let database_path = tree.0.join("library.sqlite3");
        let job_id = {
            let mut service = LibraryService::open(&database_path).unwrap();
            let source = service.register_source(&tree.0).unwrap();
            let mut queue = crate::library::queue::ScanQueue::new(&mut service.database);
            let job = queue.enqueue(&source.source.id).unwrap();
            queue.start(&job.id).unwrap();
            job.id
        };
        let worker = LibraryService::open_worker(&database_path).unwrap();
        assert_eq!(
            worker.database.job(&job_id).unwrap().unwrap().state,
            crate::library::model::ScanJobState::Running
        );
    }

    #[test]
    fn reopens_database_and_recovers_running_job_as_paused() {
        let tree = TempTree::new();
        let database_path = tree.0.join("library.sqlite3");
        let job_id = {
            let mut service = LibraryService::open(&database_path).unwrap();
            let source = service.register_source(&tree.0).unwrap();
            let mut queue = crate::library::queue::ScanQueue::new(&mut service.database);
            let job = queue.enqueue(&source.source.id).unwrap();
            queue.start(&job.id).unwrap();
            job.id
        };
        let reopened = LibraryService::open(&database_path).unwrap();
        let job = reopened.database.job(&job_id).unwrap().unwrap();
        assert_eq!(job.state, crate::library::model::ScanJobState::Paused);
    }

    #[test]
    fn classifies_permission_denied_as_a_retryable_structured_failure() {
        let error = super::hash_read_error(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "access denied",
        ));
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert!(error.retryable);
    }

    #[cfg(windows)]
    #[test]
    fn locked_file_is_reported_without_changing_the_source() {
        use std::os::windows::fs::OpenOptionsExt;

        let tree = TempTree::new();
        let locked_path = tree.0.join("locked.docx");
        fs::write(&locked_path, "locked source content").unwrap();
        let original = fs::read_to_string(&locked_path).unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let source = service.register_source(&tree.0).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&locked_path)
            .unwrap();
        let scan = service.scan_source(&source.source.id).unwrap();
        assert_eq!(scan.job.state.as_str(), "failed");
        assert!(
            scan.events
                .iter()
                .any(|event| event.kind == ScanEventKind::Error)
        );
        drop(lock);
        assert_eq!(fs::read_to_string(&locked_path).unwrap(), original);
        assert_eq!(
            service
                .scan_source(&source.source.id)
                .unwrap()
                .job
                .state
                .as_str(),
            "completed"
        );
    }
}
