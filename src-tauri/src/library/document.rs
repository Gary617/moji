use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use super::policy::{
    authorize_candidate, authorize_source, canonical_path_string, exclusion_reason,
};
use super::{
    model::{
        AnnotationAnchor, AnnotationRecord, DocumentCapabilities, DocumentId, DocumentMode,
        DocumentOpenResult, DocumentRecord, DocumentSaveResult, DocumentStatus, LibraryError,
        LibraryErrorCode, LibraryResult, SnapshotRecord, SourceLocator, new_identifier,
        now_unix_ms,
    },
    scanner::LibraryService,
};

pub(crate) struct DocumentSaveInput<'a> {
    pub document_id: &'a DocumentId,
    pub expected_sha256: &'a str,
    pub content: &'a str,
    pub mode: DocumentMode,
}

impl LibraryService {
    pub(crate) fn open_document(
        &mut self,
        document_id: &DocumentId,
        mode: DocumentMode,
    ) -> LibraryResult<DocumentOpenResult> {
        let document = self.document(document_id)?;
        if document.status != DocumentStatus::Present {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentNotFound,
                "document is not currently available",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let bytes = fs::read(&path).map_err(|error| {
            LibraryError::new(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
            )
            .retryable()
            .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
        })?;
        let current_hash = sha256(&bytes);
        let is_text = matches!(document.format.as_str(), "markdown" | "text" | "csv");
        let content = if is_text {
            Some(String::from_utf8(bytes.clone()).map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::DocumentReadFailed,
                    "text document encoding is not valid UTF-8",
                )
            })?)
        } else {
            None
        };
        let binary_content = if document.format.as_str() == "pdf" {
            Some(STANDARD.encode(&bytes))
        } else {
            None
        };
        let capabilities = capabilities_for(document.format.as_str(), mode);
        let source_locator = locator_for(&document);
        let mut warnings = Vec::new();
        if content.is_none() {
            warnings.push("该格式当前提供受控只读预览，编辑由对应适配器负责".to_owned());
        }
        if mode == DocumentMode::Assist {
            warnings.push("协助修改模式仅记录用户修改，暂不接入 AI".to_owned());
        }
        Ok(DocumentOpenResult {
            session_id: new_identifier("session"),
            document,
            mode,
            read_only: mode == DocumentMode::ReadOnly || !capabilities.can_edit,
            expected_sha256: current_hash,
            content,
            binary_content,
            capabilities,
            source_locator,
            warnings,
        })
    }

    pub(crate) fn save_document(
        &mut self,
        input: DocumentSaveInput<'_>,
    ) -> LibraryResult<DocumentSaveResult> {
        if input.mode == DocumentMode::ReadOnly {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentReadOnly,
                "document is open in read-only mode",
            ));
        }
        let document = self.document(input.document_id)?;
        if !matches!(document.format.as_str(), "markdown" | "text" | "csv") {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "this format cannot be written by the text adapter",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let original = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
                error,
            )
        })?;
        let current_hash = sha256(&original);
        if current_hash != input.expected_sha256 {
            return Err(conflict_error(
                &document,
                input.expected_sha256,
                &current_hash,
            ));
        }
        let snapshot = self
            .database
            .create_snapshot(input.document_id, &current_hash, &original)
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::SnapshotFailed,
                    "snapshot could not be created",
                )
                .retryable()
            })?;
        let temp_path = path.with_extension(format!(
            "{}{}.moji-tmp",
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!("{e}."))
                .unwrap_or_default(),
            snapshot.id
        ));
        let backup_path = path.with_extension(format!(
            "{}{}.moji-backup",
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!("{e}."))
                .unwrap_or_default(),
            snapshot.id
        ));
        let result = write_with_recovery(&path, &temp_path, &backup_path, input.content.as_bytes());
        if let Err(error) = result {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(&backup_path);
            return Err(error);
        }
        let new_bytes = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "saved document could not be verified",
                error,
            )
        })?;
        let new_hash = sha256(&new_bytes);
        let modified_at_ms = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_else(now_unix_ms);
        self.database.update_document_file_state(
            input.document_id,
            &new_hash,
            new_bytes.len() as u64,
            modified_at_ms,
        )?;
        Ok(DocumentSaveResult {
            document_id: input.document_id.clone(),
            snapshot_id: snapshot.id,
            new_sha256: new_hash,
            target_path: None,
            source_preserved: false,
        })
    }

    pub(crate) fn restore_snapshot(
        &mut self,
        document_id: &DocumentId,
        snapshot_id: &str,
        expected_sha256: &str,
    ) -> LibraryResult<DocumentSaveResult> {
        let document = self.document(document_id)?;
        let path = self.authorized_document_path(&document)?;
        let current = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
                error,
            )
        })?;
        let current_hash = sha256(&current);
        if current_hash != expected_sha256 {
            return Err(conflict_error(&document, expected_sha256, &current_hash));
        }
        let (snapshot, content) =
            self.database
                .snapshot_content(snapshot_id)?
                .ok_or_else(|| {
                    LibraryError::new(LibraryErrorCode::SnapshotNotFound, "snapshot was not found")
                })?;
        if snapshot.document_id != *document_id {
            return Err(LibraryError::new(
                LibraryErrorCode::SnapshotNotFound,
                "snapshot does not belong to this document",
            ));
        }
        let before = self
            .database
            .create_snapshot(document_id, &current_hash, &current)
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::SnapshotFailed,
                    "snapshot could not be created",
                )
                .retryable()
            })?;
        let temp_path = path.with_extension(format!("restore-{}.moji-tmp", before.id));
        let backup_path = path.with_extension(format!("restore-{}.moji-backup", before.id));
        write_with_recovery(&path, &temp_path, &backup_path, &content)?;
        let modified_at_ms = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_else(now_unix_ms);
        self.database.update_document_file_state(
            document_id,
            &sha256(&content),
            content.len() as u64,
            modified_at_ms,
        )?;
        Ok(DocumentSaveResult {
            document_id: document_id.clone(),
            snapshot_id: snapshot.id,
            new_sha256: sha256(&content),
            target_path: None,
            source_preserved: false,
        })
    }

    pub(crate) fn document(&self, document_id: &DocumentId) -> LibraryResult<DocumentRecord> {
        self.database.document_by_id(document_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::DocumentNotFound, "document was not found")
        })
    }

    fn authorized_document_path(&self, document: &DocumentRecord) -> LibraryResult<PathBuf> {
        let source = self
            .database
            .source_by_id(&document.source_root_id)?
            .ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::UnauthorizedPath,
                    "document source is no longer authorized",
                )
            })?;
        let authorized_source = authorize_source(&source.canonical_path)?;
        let path = authorize_candidate(&authorized_source, &document.canonical_path)?;
        let recorded_path = fs::canonicalize(&document.canonical_path)
            .unwrap_or_else(|_| PathBuf::from(&document.canonical_path));
        if canonical_path_string(&path) != canonical_path_string(&recorded_path) {
            return Err(LibraryError::new(
                LibraryErrorCode::UnauthorizedPath,
                "document path no longer matches the authorized record",
            ));
        }
        let metadata = fs::metadata(&path).map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::DocumentNotFound,
                "document is not currently available",
            )
        })?;
        if !metadata.is_file() {
            return Err(LibraryError::new(
                LibraryErrorCode::UnauthorizedPath,
                "document target is not a regular file",
            ));
        }
        Ok(path)
    }

    pub(crate) fn snapshots(&self, document_id: &DocumentId) -> LibraryResult<Vec<SnapshotRecord>> {
        self.document(document_id)?;
        self.database.snapshots_for_document(document_id)
    }

    pub(crate) fn annotations(
        &self,
        document_id: &DocumentId,
    ) -> LibraryResult<Vec<AnnotationRecord>> {
        self.document(document_id)?;
        self.database.annotations_for_document(document_id)
    }

    pub(crate) fn add_annotation(
        &mut self,
        document_id: &DocumentId,
        author: String,
        body: String,
        anchor: AnnotationAnchor,
    ) -> LibraryResult<AnnotationRecord> {
        if body.trim().is_empty() {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "annotation body cannot be empty",
            ));
        }
        self.document(document_id)?;
        let now = now_unix_ms();
        let annotation = AnnotationRecord {
            id: new_identifier("anno"),
            document_id: document_id.clone(),
            author: author.trim().to_owned(),
            body,
            anchor,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.database.add_annotation(&annotation)?;
        Ok(annotation)
    }

    pub(crate) fn delete_annotation(&mut self, annotation_id: &str) -> LibraryResult<()> {
        self.database.delete_annotation(annotation_id)
    }
}

fn capabilities_for(format: &str, mode: DocumentMode) -> DocumentCapabilities {
    let text = matches!(format, "markdown" | "text" | "csv");
    DocumentCapabilities {
        can_edit: text && mode != DocumentMode::ReadOnly,
        can_save: text && mode != DocumentMode::ReadOnly,
        can_save_as: text,
        can_annotate: true,
        supports_page_anchor: format == "pdf",
        supports_paragraph_anchor: text || format == "docx",
    }
}

fn locator_for(document: &DocumentRecord) -> SourceLocator {
    let kind = match document.format.as_str() {
        "pdf" => "page",
        "pptx" => "slide",
        "markdown" | "text" | "csv" | "docx" => "paragraph",
        _ => "document",
    };
    SourceLocator {
        kind: kind.to_owned(),
        page: None,
        slide: None,
        paragraph: None,
        bounding_box: None,
        available: false,
        reason: Some("稳定正文定位尚未可用，批注将保留引用文本并明确降级".to_owned()),
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn conflict_error(
    document: &DocumentRecord,
    expected_hash: &str,
    current_hash: &str,
) -> LibraryError {
    LibraryError::new(LibraryErrorCode::DocumentConflict, "文件在编辑期间已被外部修改").with_details(serde_json::json!({ "documentId": document.id, "expectedSha256": expected_hash, "currentSha256": current_hash, "actions": ["abandon", "save_as", "compare", "restore"] }))
}

fn io_error(code: LibraryErrorCode, message: &str, error: std::io::Error) -> LibraryError {
    let locked = matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
    );
    LibraryError::new(
        if locked {
            LibraryErrorCode::DocumentLocked
        } else {
            code
        },
        message,
    )
    .retryable()
    .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
}

fn write_with_recovery(
    path: &std::path::Path,
    temp: &std::path::Path,
    backup: &std::path::Path,
    bytes: &[u8],
) -> LibraryResult<()> {
    let result = (|| {
        assert_regular_target(path)?;
        let original = fs::read(path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be read",
                error,
            )
        })?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(|error| {
                io_error(
                    LibraryErrorCode::DocumentWriteFailed,
                    "temporary document could not be created",
                    error,
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be written",
                error,
            )
        })?;
        file.sync_all().map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be flushed",
                error,
            )
        })?;
        let mut backup_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(backup)
            .map_err(|error| {
                io_error(
                    LibraryErrorCode::DocumentWriteFailed,
                    "document backup could not be created",
                    error,
                )
            })?;
        backup_file.write_all(&original).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be written",
                error,
            )
        })?;
        backup_file.sync_all().map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be flushed",
                error,
            )
        })?;
        assert_regular_target(path)?;
        atomic_replace(path, temp).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be replaced",
                error,
            )
        })?;
        assert_regular_target(path)?;
        fs::remove_file(backup).ok();
        Ok(())
    })();
    if result.is_err() {
        if backup.exists() {
            let _ = atomic_replace(path, backup);
        }
    }
    result
}

fn assert_regular_target(path: &Path) -> LibraryResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        LibraryError::new(
            LibraryErrorCode::UnauthorizedPath,
            "document target is unavailable",
        )
    })?;
    if exclusion_reason(path, &metadata).is_some() || !metadata.is_file() {
        return Err(LibraryError::new(
            LibraryErrorCode::UnauthorizedPath,
            "document target is not a regular authorized file",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(path: &Path, temp: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(path: &Path, temp: &Path) -> std::io::Result<()> {
    fs::rename(temp, path)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::library::{
        model::{DocumentFormat, DocumentRecord, SourceKind},
        scanner::LibraryService,
    };

    struct TempTree(PathBuf);
    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "moji-document-test-{}",
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

    fn scanned_text_service() -> (TempTree, LibraryService, DocumentId) {
        let tree = TempTree::new();
        let path = tree.0.join("notes.md");
        fs::write(&path, "before").unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let source = service
            .database
            .register_source(
                SourceKind::Directory,
                tree.0.to_string_lossy().as_ref(),
                "temp",
            )
            .unwrap();
        let document_id = DocumentId("doc-notes".to_owned());
        service
            .database
            .upsert_document(
                &DocumentRecord {
                    id: document_id.clone(),
                    source_root_id: source.source.id,
                    canonical_path: path.to_string_lossy().to_string(),
                    display_name: "notes.md".to_owned(),
                    format: DocumentFormat::Markdown,
                    size_bytes: 6,
                    modified_at_ms: 1,
                    file_identity: None,
                    content_sha256: sha256(b"before"),
                    status: DocumentStatus::Present,
                    content_state: "pending".to_owned(),
                },
                &super::super::model::ScanJobId("job-test".to_owned()),
            )
            .unwrap();
        (tree, service, document_id)
    }

    #[test]
    fn saves_text_only_after_snapshot_and_restores_original_bytes() {
        let (tree, mut service, document_id) = scanned_text_service();
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        let saved = service
            .save_document(DocumentSaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: "after",
                mode: DocumentMode::Edit,
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "after"
        );
        assert_eq!(service.snapshots(&document_id).unwrap().len(), 1);
        let restored = service
            .restore_snapshot(&document_id, &saved.snapshot_id, &saved.new_sha256)
            .unwrap();
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "before"
        );
        assert_eq!(restored.new_sha256, sha256(b"before"));
    }

    #[test]
    fn detects_external_modification_without_overwriting_file() {
        let (tree, mut service, document_id) = scanned_text_service();
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        fs::write(tree.0.join("notes.md"), "external").unwrap();
        let error = service
            .save_document(DocumentSaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: "local",
                mode: DocumentMode::Edit,
            })
            .unwrap_err();
        assert_eq!(error.code, "DOCUMENT_CONFLICT");
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "external"
        );
        assert!(service.snapshots(&document_id).unwrap().is_empty());
    }

    #[test]
    fn persists_annotations_with_explicit_unstable_anchor_fallback() {
        let (_tree, mut service, document_id) = scanned_text_service();
        let annotation = service
            .add_annotation(
                &document_id,
                "Gary".to_owned(),
                "check this".to_owned(),
                AnnotationAnchor {
                    kind: "character-range".to_owned(),
                    page: None,
                    slide: None,
                    paragraph: Some(1),
                    char_start: Some(0),
                    char_end: Some(5),
                    quote: Some("before".to_owned()),
                    stable: false,
                },
            )
            .unwrap();
        let annotations = service.annotations(&document_id).unwrap();
        assert_eq!(annotations, vec![annotation]);
    }
}
