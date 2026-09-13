use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

static IDENTIFIER_COUNTER: AtomicU64 = AtomicU64::new(1);

pub const LIBRARY_SCHEMA_VERSION: i64 = 8;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DocumentId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SourceRootId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ScanJobId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct OcrJobId(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Directory,
    SingleFile,
}

impl SourceKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::SingleFile => "single_file",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "directory" => Some(Self::Directory),
            "single_file" => Some(Self::SingleFile),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentFormat {
    Doc,
    Docx,
    Pptx,
    Xlsx,
    Pdf,
    Markdown,
    Text,
    Csv,
    Png,
    Jpg,
    Tiff,
    Bmp,
}

impl DocumentFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Xlsx => "xlsx",
            Self::Pdf => "pdf",
            Self::Markdown => "markdown",
            Self::Text => "text",
            Self::Csv => "csv",
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Tiff => "tiff",
            Self::Bmp => "bmp",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "doc" => Some(Self::Doc),
            "docx" => Some(Self::Docx),
            "pptx" => Some(Self::Pptx),
            "xlsx" => Some(Self::Xlsx),
            "pdf" => Some(Self::Pdf),
            "markdown" => Some(Self::Markdown),
            "text" => Some(Self::Text),
            "csv" => Some(Self::Csv),
            "png" => Some(Self::Png),
            "jpg" => Some(Self::Jpg),
            "tiff" => Some(Self::Tiff),
            "bmp" => Some(Self::Bmp),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentStatus {
    Present,
    Missing,
    Error,
}

impl DocumentStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Error => "error",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "present" => Some(Self::Present),
            "missing" => Some(Self::Missing),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanJobState {
    Queued,
    Running,
    Paused,
    Cancelled,
    Failed,
    Completed,
}

impl ScanJobState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Completed => "completed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "cancelled" => Some(Self::Cancelled),
            "failed" => Some(Self::Failed),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanEventKind {
    Discovered,
    Updated,
    Renamed,
    Missing,
    Skipped,
    Error,
}

impl ScanEventKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Discovered => "discovered",
            Self::Updated => "updated",
            Self::Renamed => "renamed",
            Self::Missing => "missing",
            Self::Skipped => "skipped",
            Self::Error => "error",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "discovered" => Some(Self::Discovered),
            "updated" => Some(Self::Updated),
            "renamed" => Some(Self::Renamed),
            "missing" => Some(Self::Missing),
            "skipped" => Some(Self::Skipped),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRootRecord {
    pub id: SourceRootId,
    pub kind: SourceKind,
    #[serde(skip_serializing)]
    pub canonical_path: String,
    pub display_name: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRegistration {
    pub source: SourceRootRecord,
    pub created: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: DocumentId,
    pub source_root_id: SourceRootId,
    /// The normalized local path is intentionally exposed only for the document
    /// tooltip. Source roots remain opaque to the renderer.
    #[serde(rename = "path")]
    pub canonical_path: String,
    pub display_name: String,
    pub format: DocumentFormat,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
    pub file_identity: Option<String>,
    pub content_sha256: String,
    pub status: DocumentStatus,
    pub content_state: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CollectionId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TagId(pub String);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecord {
    pub id: CollectionId,
    pub name: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: TagId,
    pub name: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocator {
    pub kind: String,
    pub page: Option<u32>,
    pub slide: Option<u32>,
    pub paragraph: Option<u32>,
    pub bounding_box: Option<OcrBoundingBox>,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPoint {
    pub x: u32,
    pub y: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBoundingBox {
    pub points: Vec<OcrPoint>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextBox {
    pub text: String,
    pub confidence: f32,
    pub bounding_box: OcrBoundingBox,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFragment {
    pub document_id: DocumentId,
    pub page: u32,
    pub source: String,
    pub text: String,
    pub confidence: Option<f32>,
    pub width: u32,
    pub height: u32,
    pub rotation_degrees: u32,
    pub boxes: Vec<OcrTextBox>,
    pub source_locator: SourceLocator,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSnippet {
    pub field: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocument {
    pub document: DocumentRecord,
    pub snippets: Vec<SearchSnippet>,
    pub source_locator: SourceLocator,
    pub tags: Vec<TagRecord>,
    pub collections: Vec<CollectionRecord>,
    pub is_favorite: bool,
    pub index_state: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    pub text: Option<String>,
    pub formats: Vec<DocumentFormat>,
    pub modified_after_ms: Option<i64>,
    pub modified_before_ms: Option<i64>,
    pub source_root_ids: Vec<SourceRootId>,
    pub collection_id: Option<CollectionId>,
    pub tag_ids: Vec<TagId>,
    pub statuses: Vec<DocumentStatus>,
    pub favorite_only: bool,
    pub recent_only: bool,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub items: Vec<SearchDocument>,
    pub total: u64,
    pub query_time_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentMode {
    ReadOnly,
    Edit,
    Assist,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCapabilities {
    pub can_edit: bool,
    pub can_save: bool,
    pub can_save_as: bool,
    pub can_annotate: bool,
    pub supports_page_anchor: bool,
    pub supports_paragraph_anchor: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOpenResult {
    pub session_id: String,
    pub document: DocumentRecord,
    pub mode: DocumentMode,
    pub read_only: bool,
    pub expected_sha256: String,
    pub content: Option<String>,
    pub binary_content: Option<String>,
    pub binary_media_type: Option<String>,
    pub capabilities: DocumentCapabilities,
    pub source_locator: SourceLocator,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSaveResult {
    pub document_id: DocumentId,
    pub snapshot_id: String,
    pub new_sha256: String,
    pub target_path: Option<String>,
    pub source_preserved: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSaveAsResult {
    pub document_id: DocumentId,
    pub cancelled: bool,
    pub target_name: Option<String>,
    pub new_sha256: Option<String>,
    pub source_preserved: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub id: String,
    pub document_id: DocumentId,
    pub original_sha256: String,
    pub created_at_ms: i64,
    pub byte_len: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationAnchor {
    pub kind: String,
    pub page: Option<u32>,
    pub slide: Option<u32>,
    pub paragraph: Option<u32>,
    pub char_start: Option<u32>,
    pub char_end: Option<u32>,
    pub quote: Option<String>,
    pub stable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRecord {
    pub id: String,
    pub document_id: DocumentId,
    pub author: String,
    pub body: String,
    pub anchor: AnnotationAnchor,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionRecord {
    pub id: String,
    pub session_id: String,
    pub document_id: Option<DocumentId>,
    pub permission: String,
    pub tool: String,
    pub outcome: String,
    pub details: Value,
    pub created_at_ms: i64,
}

pub(crate) struct AiActionInput<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub document_id: Option<&'a DocumentId>,
    pub permission: &'a str,
    pub tool: &'a str,
    pub outcome: &'a str,
    pub details: &'a Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanJobRecord {
    pub id: ScanJobId,
    pub source_root_id: SourceRootId,
    pub state: ScanJobState,
    pub scanned_count: u64,
    pub total_count: u64,
    pub current_file_name: Option<String>,
    pub changed_count: u64,
    pub failed_count: u64,
    pub retry_count: u32,
    pub error_code: Option<String>,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

pub(crate) struct ScanJobUpdate<'a> {
    pub id: &'a ScanJobId,
    pub state: ScanJobState,
    pub scanned_count: u64,
    pub total_count: u64,
    pub current_file_name: Option<&'a str>,
    pub changed_count: u64,
    pub failed_count: u64,
    pub retry_count: u32,
    pub error_code: Option<&'a str>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrJobRecord {
    pub id: OcrJobId,
    pub document_id: DocumentId,
    pub source_root_id: SourceRootId,
    pub state: ScanJobState,
    pub page_count: u32,
    pub processed_count: u32,
    pub failed_count: u32,
    pub retry_count: u32,
    pub error_code: Option<String>,
    pub model_version: String,
    pub runtime_version: String,
    pub input_sha256: String,
    pub duration_ms: Option<u64>,
    pub model_bytes: u64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub(crate) struct OcrJobUpdate<'a> {
    pub id: &'a OcrJobId,
    pub state: ScanJobState,
    pub page_count: u32,
    pub processed_count: u32,
    pub failed_count: u32,
    pub retry_count: u32,
    pub error_code: Option<&'a str>,
    pub duration_ms: Option<u64>,
}

pub(crate) struct OcrPageUpdate<'a> {
    pub document_id: &'a DocumentId,
    pub page: u32,
    pub source: &'a str,
    pub text: &'a str,
    pub confidence: Option<f32>,
    pub width: u32,
    pub height: u32,
    pub rotation_degrees: u32,
    pub boxes: &'a [OcrTextBox],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelStatus {
    pub model_version: String,
    pub runtime_version: String,
    pub available: bool,
    pub model_bytes: u64,
    pub missing_assets: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEvent {
    pub id: i64,
    pub scan_job_id: ScanJobId,
    pub document_id: Option<DocumentId>,
    pub kind: ScanEventKind,
    pub occurred_at_ms: i64,
    pub details: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub job: ScanJobRecord,
    pub events: Vec<ScanEvent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub source_root_id: SourceRootId,
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPollResult {
    pub source_root_id: SourceRootId,
    pub changed: bool,
    pub scan: Option<ScanSummary>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LibraryErrorCode {
    InvalidArgument,
    SourceNotFound,
    UnauthorizedPath,
    ExcludedPath,
    UnsupportedFile,
    PermissionDenied,
    MetadataReadFailed,
    HashReadFailed,
    DatabaseFailed,
    MigrationFailed,
    AuditIntegrityFailed,
    ScanJobNotFound,
    InvalidJobState,
    WatcherUnavailable,
    LibraryUnavailable,
    DocumentNotFound,
    DocumentReadFailed,
    DocumentCorrupt,
    DocumentWriteFailed,
    DocumentConflict,
    DocumentReadOnly,
    DocumentLocked,
    SaveAsTargetExists,
    SnapshotFailed,
    SnapshotNotFound,
    AnnotationNotFound,
    OcrJobNotFound,
    OcrUnsupportedFormat,
    OcrModelMissing,
    OcrModelInvalid,
    OcrRuntimeUnavailable,
    OcrCorruptDocument,
    OcrPdfRendererUnavailable,
    OcrInputChanged,
    OcrPageFailed,
}

impl LibraryErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "INVALID_ARGUMENT",
            Self::SourceNotFound => "SOURCE_NOT_FOUND",
            Self::UnauthorizedPath => "UNAUTHORIZED_PATH",
            Self::ExcludedPath => "EXCLUDED_PATH",
            Self::UnsupportedFile => "UNSUPPORTED_FILE",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::MetadataReadFailed => "METADATA_READ_FAILED",
            Self::HashReadFailed => "HASH_READ_FAILED",
            Self::DatabaseFailed => "DATABASE_FAILED",
            Self::MigrationFailed => "MIGRATION_FAILED",
            Self::AuditIntegrityFailed => "AUDIT_INTEGRITY_FAILED",
            Self::ScanJobNotFound => "SCAN_JOB_NOT_FOUND",
            Self::InvalidJobState => "INVALID_JOB_STATE",
            Self::WatcherUnavailable => "WATCHER_UNAVAILABLE",
            Self::LibraryUnavailable => "LIBRARY_UNAVAILABLE",
            Self::DocumentNotFound => "DOCUMENT_NOT_FOUND",
            Self::DocumentReadFailed => "DOCUMENT_READ_FAILED",
            Self::DocumentCorrupt => "DOCUMENT_CORRUPT",
            Self::DocumentWriteFailed => "DOCUMENT_WRITE_FAILED",
            Self::DocumentConflict => "DOCUMENT_CONFLICT",
            Self::DocumentReadOnly => "DOCUMENT_READ_ONLY",
            Self::DocumentLocked => "DOCUMENT_LOCKED",
            Self::SaveAsTargetExists => "SAVE_AS_TARGET_EXISTS",
            Self::SnapshotFailed => "SNAPSHOT_FAILED",
            Self::SnapshotNotFound => "SNAPSHOT_NOT_FOUND",
            Self::AnnotationNotFound => "ANNOTATION_NOT_FOUND",
            Self::OcrJobNotFound => "OCR_JOB_NOT_FOUND",
            Self::OcrUnsupportedFormat => "OCR_UNSUPPORTED_FORMAT",
            Self::OcrModelMissing => "OCR_MODEL_MISSING",
            Self::OcrModelInvalid => "OCR_MODEL_INVALID",
            Self::OcrRuntimeUnavailable => "OCR_RUNTIME_UNAVAILABLE",
            Self::OcrCorruptDocument => "OCR_CORRUPT_DOCUMENT",
            Self::OcrPdfRendererUnavailable => "OCR_PDF_RENDERER_UNAVAILABLE",
            Self::OcrInputChanged => "OCR_INPUT_CHANGED",
            Self::OcrPageFailed => "OCR_PAGE_FAILED",
        }
    }
}

impl fmt::Display for LibraryErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl LibraryError {
    pub fn new(code: LibraryErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.as_str().to_owned(),
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn code_is(&self, code: LibraryErrorCode) -> bool {
        self.code == code.as_str()
    }
}

pub type LibraryResult<T> = Result<T, LibraryError>;

pub(crate) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub(crate) fn new_identifier(prefix: &str) -> String {
    let counter = IDENTIFIER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let material = format!(
        "{prefix}:{}:{}:{counter}",
        now_unix_ms(),
        std::process::id()
    );
    let digest = Sha256::digest(material.as_bytes());
    let encoded = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{encoded}")
}

pub(crate) fn invalid_state_error(expected: &[ScanJobState], actual: ScanJobState) -> LibraryError {
    let expected = expected
        .iter()
        .map(|state| state.as_str())
        .collect::<Vec<_>>();
    LibraryError::new(
        LibraryErrorCode::InvalidJobState,
        "scan job cannot transition from its current state",
    )
    .with_details(json!({ "expected": expected, "actual": actual.as_str() }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        DocumentFormat, DocumentId, DocumentRecord, DocumentStatus, SearchQuery, SourceKind,
        SourceRootId, SourceRootRecord,
    };

    #[test]
    fn renderer_dtos_expose_document_path_but_keep_source_roots_opaque() {
        let source = SourceRootRecord {
            id: SourceRootId("src-private".to_owned()),
            kind: SourceKind::Directory,
            canonical_path: r"C:\Users\Private\Documents".to_owned(),
            display_name: "Documents".to_owned(),
            created_at_ms: 1,
        };
        let document = DocumentRecord {
            id: DocumentId("doc-private".to_owned()),
            source_root_id: source.id.clone(),
            canonical_path: r"C:\Users\Private\Documents\notes.md".to_owned(),
            display_name: "notes.md".to_owned(),
            format: DocumentFormat::Markdown,
            size_bytes: 12,
            modified_at_ms: 2,
            file_identity: None,
            content_sha256: "hash".to_owned(),
            status: DocumentStatus::Present,
            content_state: "ready".to_owned(),
        };

        let source_json = serde_json::to_value(source).unwrap();
        let document_json = serde_json::to_value(document).unwrap();

        assert_eq!(
            source_json,
            json!({
                "id": "src-private",
                "kind": "directory",
                "displayName": "Documents",
                "createdAtMs": 1,
            })
        );
        assert_eq!(
            document_json.get("path"),
            Some(&json!(r"C:\Users\Private\Documents\notes.md"))
        );
        assert!(document_json.get("canonicalPath").is_none());
    }

    #[test]
    fn search_query_defaults_omitted_optional_filters() {
        let query: SearchQuery = serde_json::from_value(json!({
            "limit": 100,
        }))
        .expect("search requests may omit unselected filters");

        assert_eq!(
            query,
            SearchQuery {
                limit: 100,
                ..SearchQuery::default()
            }
        );
    }
}
