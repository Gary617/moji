use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

use file_id::get_file_id;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    database::LibraryDatabase,
    model::{
        DocumentId, DocumentRecord, DocumentStatus, LibraryError, LibraryErrorCode, LibraryResult,
        ScanEvent, ScanEventKind, ScanJobId, ScanJobState, ScanSummary, SourceKind,
        SourceRegistration, SourceRootId, WatchPollResult, WatchStatus, new_identifier,
        now_unix_ms,
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
}

impl LibraryService {
    pub(crate) fn open(path: impl AsRef<Path>) -> LibraryResult<Self> {
        let mut database = LibraryDatabase::open(path)?;
        database.recover_running_jobs()?;
        Ok(Self {
            database,
            watchers: HashMap::new(),
        })
    }

    pub(crate) fn in_memory() -> LibraryResult<Self> {
        Ok(Self {
            database: LibraryDatabase::in_memory()?,
            watchers: HashMap::new(),
        })
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

    pub(crate) fn scan_source(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<ScanSummary> {
        let source_record = self.database.source_by_id(source_root_id)?.ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::SourceNotFound,
                "source root was not found",
            )
        })?;
        let mut job = self.database.create_scan_job(source_root_id)?;
        job = self
            .database
            .update_job(&job.id, ScanJobState::Running, 0, 0, 0, 0, None)?;
        let source = match authorize_source(&source_record.canonical_path) {
            Ok(source) => source,
            Err(error) => {
                let _ = self.database.update_job(
                    &job.id,
                    ScanJobState::Failed,
                    0,
                    0,
                    1,
                    0,
                    Some(&error.code),
                );
                return Err(error);
            }
        };
        let known_documents = self.database.documents_for_source(source_root_id)?;
        let known_by_path = known_documents
            .iter()
            .map(|document| (document.canonical_path.clone(), document.clone()))
            .collect::<HashMap<_, _>>();
        let mut seen_paths = HashSet::new();
        let mut pre_events = Vec::new();
        let mut scanned_count = 0u64;
        let mut changed_count = 0u64;
        let mut failed_count = 0u64;

        let files = match collect_files(&source, &mut pre_events, &job.id) {
            Ok(files) => files,
            Err(error) => {
                let _ = self.database.update_job(
                    &job.id,
                    ScanJobState::Failed,
                    0,
                    0,
                    1,
                    0,
                    Some(&error.code),
                );
                return Err(error);
            }
        };
        let mut events = Vec::new();
        for event in pre_events {
            if event.id < 0 {
                events.push(self.database.add_event(
                    &job.id,
                    event.document_id.as_ref(),
                    event.kind,
                    &event.details,
                )?);
            } else {
                events.push(event);
            }
        }
        for path in files {
            let canonical = canonical_path_string(&path);
            seen_paths.insert(canonical.clone());
            scanned_count += 1;
            match self.reconcile_file(&source, source_root_id, &job.id, &path) {
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
                        let event = self.database.add_event(
                            &job.id,
                            Some(&existing.id),
                            ScanEventKind::Error,
                            &json!({ "displayName": existing.display_name, "code": error.code, "message": error.message }),
                        )?;
                        events.push(event);
                    } else {
                        let event = self.database.add_event(
                            &job.id,
                            None,
                            ScanEventKind::Error,
                            &json!({ "displayName": path.file_name().and_then(|name| name.to_str()).unwrap_or("file"), "code": error.code, "message": error.message }),
                        )?;
                        events.push(event);
                    }
                }
            }
        }

        for document in known_documents {
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
            }
        }

        let final_state = if failed_count > 0 {
            ScanJobState::Failed
        } else {
            ScanJobState::Completed
        };
        job = self.database.update_job(
            &job.id,
            final_state,
            scanned_count,
            changed_count,
            failed_count,
            0,
            (failed_count > 0).then_some("SCAN_FILE_FAILED"),
        )?;
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

    pub(crate) fn poll_watch(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<WatchPollResult> {
        let changed = {
            let watcher = self.watchers.get(source_root_id).ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::WatcherUnavailable,
                    "source watcher is not running",
                )
                .retryable()
            })?;
            !watcher.drain().is_empty()
        };
        let scan = if changed {
            Some(self.scan_source(source_root_id)?)
        } else {
            None
        };
        Ok(WatchPollResult {
            source_root_id: source_root_id.clone(),
            changed,
            scan,
        })
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
            .with_details(json!({ "source": error.to_string() }))
        })?;
        let hash = hash_file(&path)?;
        let identity = get_file_id(&path).ok().map(|value| format!("{value:?}"));
        let canonical = canonical_path_string(&path);
        let existing_path = self.database.document_by_path(&canonical)?;
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
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
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
            Some(_) => return Ok(None),
        };
        self.database.upsert_document(&document, scan_job_id)?;
        let event = self.database.add_event(
            scan_job_id,
            Some(&document.id),
            kind,
            &json!({ "displayName": document.display_name, "format": document.format.as_str() }),
        )?;
        Ok(Some((event, changed)))
    }
}

fn collect_files(
    source: &AuthorizedSource,
    events: &mut Vec<ScanEvent>,
    scan_job_id: &ScanJobId,
) -> LibraryResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    if source.kind == SourceKind::SingleFile {
        if format_from_path(&source.canonical_path).is_some() {
            files.push(source.canonical_path.clone());
        }
        return Ok(files);
    }
    walk_directory(&source.canonical_path, &mut files, events, scan_job_id)?;
    Ok(files)
}

fn walk_directory(
    path: &Path,
    files: &mut Vec<PathBuf>,
    events: &mut Vec<ScanEvent>,
    scan_job_id: &ScanJobId,
) -> LibraryResult<()> {
    let entries = fs::read_dir(path).map_err(|error| {
        LibraryError::new(
            LibraryErrorCode::PermissionDenied,
            "directory could not be read",
        )
        .retryable()
        .with_details(json!({ "source": error.to_string() }))
    })?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Error,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({ "code": "DIRECTORY_ENTRY_FAILED", "message": error.to_string() }),
                });
                continue;
            }
        };
        let child = entry.path();
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(error) => {
                events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Error,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("entry"), "code": "METADATA_READ_FAILED", "message": error.to_string() }),
                });
                continue;
            }
        };
        if let Some(reason) = exclusion_reason(&child, &metadata) {
            events.push(ScanEvent {
                id: -1,
                scan_job_id: scan_job_id.clone(),
                document_id: None,
                kind: ScanEventKind::Skipped,
                occurred_at_ms: now_unix_ms(),
                details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("entry"), "reason": reason }),
            });
            continue;
        }
        if metadata.is_dir() {
            walk_directory(&child, files, events, scan_job_id)?;
        } else if metadata.is_file() {
            if format_from_path(&child).is_some() {
                files.push(child);
            } else {
                events.push(ScanEvent {
                    id: -1,
                    scan_job_id: scan_job_id.clone(),
                    document_id: None,
                    kind: ScanEventKind::Skipped,
                    occurred_at_ms: now_unix_ms(),
                    details: json!({ "displayName": child.file_name().and_then(|name| name.to_str()).unwrap_or("file"), "reason": "unsupported_format" }),
                });
            }
        }
    }
    Ok(())
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
        .with_details(json!({ "source": error.to_string() }))
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
