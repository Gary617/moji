use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, ipc::Channel};

use crate::ai::{
    context::{ContextPreview, ContextRequest},
    orchestrator::{
        AiActionsRequest, AiChangeRequest, AiChangeResult, AiChatRequest, AiChatResult,
    },
    provider::{
        AiFailure, AiStreamEvent, CancellationToken, OpenAiResponsesProvider,
        WindowsCredentialStore,
    },
};
use crate::library::{
    document::DocumentSaveInput,
    model::{
        AnnotationAnchor, AnnotationRecord, CollectionId, CollectionRecord, DocumentFragment,
        DocumentId, DocumentMode, DocumentOpenResult, DocumentSaveResult, IndexRebuildSummary,
        LibraryError, LibraryErrorCode, LibraryResult, OcrJobId, OcrJobRecord, OcrModelStatus,
        ScanEvent, ScanJobId, ScanJobRecord, ScanSummary, SearchQuery, SearchResults,
        SnapshotRecord, SourceRegistration, SourceRootId, SourceRootRecord, TagId, TagRecord,
        WatchPollResult, WatchStatus,
    },
    queue::ScanQueue,
    scanner::LibraryService,
};

use super::response::{IpcError, IpcResponse};

pub(crate) struct LibraryState {
    service: Mutex<Option<LibraryService>>,
    initialization_error: Mutex<Option<LibraryError>>,
    database_path: Mutex<Option<PathBuf>>,
}

impl LibraryState {
    pub(crate) fn empty() -> Self {
        Self {
            service: Mutex::new(None),
            initialization_error: Mutex::new(None),
            database_path: Mutex::new(None),
        }
    }

    pub(crate) fn initialize(&self, database_path: PathBuf) {
        if let Ok(mut slot) = self.database_path.lock() {
            *slot = Some(database_path.clone());
        }
        match LibraryService::open(database_path) {
            Ok(service) => {
                if let Ok(mut slot) = self.service.lock() {
                    *slot = Some(service);
                }
            }
            Err(error) => {
                if let Ok(mut slot) = self.initialization_error.lock() {
                    *slot = Some(error);
                }
            }
        }
    }

    fn database_path(&self) -> LibraryResult<PathBuf> {
        self.database_path
            .lock()
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::LibraryUnavailable,
                    "library state is unavailable",
                )
                .retryable()
            })?
            .clone()
            .ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::LibraryUnavailable,
                    "library database is not ready",
                )
                .retryable()
            })
    }
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceRegistrationData {
    pub source: SourceRegistration,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanRequest {
    pub source_root_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanJobRequest {
    pub scan_job_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameRequest {
    pub name: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentRelationRequest {
    pub document_id: String,
    pub relation_id: String,
    pub included: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteRequest {
    pub document_id: String,
    pub favorite: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentRequest {
    pub document_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OcrJobRequest {
    pub ocr_job_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentFragmentRequest {
    pub document_id: String,
    pub page: Option<u32>,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentOpenRequest {
    pub document_id: String,
    pub mode: DocumentMode,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentSaveRequest {
    pub document_id: String,
    pub expected_sha256: String,
    pub content: String,
    pub mode: DocumentMode,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotRestoreRequest {
    pub document_id: String,
    pub snapshot_id: String,
    pub expected_sha256: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationCreateRequest {
    pub document_id: String,
    pub author: String,
    pub body: String,
    pub anchor: AnnotationAnchor,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationDeleteRequest {
    pub annotation_id: String,
}

#[tauri::command]
pub(crate) fn ai_context_preview(
    request: ContextRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ContextPreview> {
    with_service(&state, |service| {
        crate::ai::orchestrator::context_preview(service, &request, request.permission)
            .map(|prepared| prepared.preview)
    })
}

#[tauri::command]
pub(crate) fn ai_chat(
    request: AiChatRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiChatResult> {
    let provider = OpenAiResponsesProvider::new(WindowsCredentialStore::default());
    let cancellation = CancellationToken::default();
    match with_service(&state, |service| {
        crate::ai::orchestrator::chat(service, service, &provider, &request, &cancellation)
            .map_err(ai_ipc_error)
    }) {
        IpcResponse::Success { data } => IpcResponse::success(data),
        IpcResponse::Error { error } => IpcResponse::Error { error },
    }
}

#[tauri::command]
pub(crate) fn ai_chat_stream(
    request: AiChatRequest,
    on_event: Channel<AiStreamEvent>,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiChatResult> {
    let provider = OpenAiResponsesProvider::new(WindowsCredentialStore::default());
    let cancellation = CancellationToken::default();
    with_service(&state, |service| {
        crate::ai::orchestrator::chat_with_sink(
            service,
            service,
            &provider,
            &request,
            &cancellation,
            &mut |event| {
                on_event
                    .send(event.clone())
                    .map_err(|_| crate::ai::provider::AiError::new(AiFailure::Provider))
            },
        )
        .map_err(ai_ipc_error)
    })
}

#[tauri::command]
pub(crate) fn ai_apply_change(
    request: AiChangeRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiChangeResult> {
    with_service(&state, |service| {
        crate::ai::orchestrator::apply_change(service, &request)
    })
}

#[tauri::command]
pub(crate) fn ai_list_actions(
    request: AiActionsRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<crate::library::model::AiActionRecord>> {
    with_service(&state, |service| {
        service.database.ai_actions(request.session_id.as_deref())
    })
}

#[tauri::command]
pub(crate) fn library_register_source(
    path: String,
    state: State<'_, LibraryState>,
) -> IpcResponse<SourceRegistrationData> {
    with_service(&state, |service| {
        service
            .register_source(path)
            .map(|source| SourceRegistrationData { source })
    })
}

#[tauri::command]
pub(crate) fn library_start_scan(
    request: ScanRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanSummary> {
    let source_id = SourceRootId(request.source_root_id);
    let response = with_service(&state, |service| service.enqueue_scan(&source_id));
    schedule_response(&state, response, |job| ScanSummary {
        job,
        events: Vec::new(),
    })
}

#[tauri::command]
pub(crate) fn library_scan_status(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanJobRecord> {
    let job_id = ScanJobId(request.scan_job_id);
    with_service(&state, |service| {
        service.database.job(&job_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::ScanJobNotFound, "scan job was not found")
        })
    })
}

#[tauri::command]
pub(crate) fn library_scan_events(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<ScanEvent>> {
    let job_id = ScanJobId(request.scan_job_id);
    with_service(&state, |service| {
        service.database.job(&job_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::ScanJobNotFound, "scan job was not found")
        })?;
        service.database.events_for_job(&job_id)
    })
}

#[tauri::command]
pub(crate) fn library_pause_scan(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanJobRecord> {
    transition_job(&state, request, |queue, id| queue.pause(id))
}

#[tauri::command]
pub(crate) fn library_resume_scan(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanJobRecord> {
    let job_id = ScanJobId(request.scan_job_id);
    let response = with_service(&state, |service| service.resume_scan(&job_id));
    schedule_response(&state, response, |job| job)
}

#[tauri::command]
pub(crate) fn library_cancel_scan(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanJobRecord> {
    transition_job(&state, request, |queue, id| queue.cancel(id))
}

#[tauri::command]
pub(crate) fn library_retry_scan(
    request: ScanJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<ScanJobRecord> {
    let job_id = ScanJobId(request.scan_job_id);
    let response = with_service(&state, |service| service.retry_scan(&job_id));
    schedule_response(&state, response, |job| job)
}

#[tauri::command]
pub(crate) fn library_start_watch(
    request: ScanRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<WatchStatus> {
    let source_id = SourceRootId(request.source_root_id);
    with_service(&state, |service| service.watch_source(&source_id))
}

#[tauri::command]
pub(crate) fn library_poll_watch(
    request: ScanRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<WatchPollResult> {
    let source_id = SourceRootId(request.source_root_id);
    let response = with_service(&state, |service| service.poll_watch_changes(&source_id));
    match response {
        IpcResponse::Success { data: changed } => {
            if !changed {
                return IpcResponse::success(WatchPollResult {
                    source_root_id: source_id,
                    changed: false,
                    scan: None,
                });
            }
            let queued = with_service(&state, |service| service.enqueue_scan(&source_id));
            match schedule_response(&state, queued, |job| ScanSummary {
                job,
                events: Vec::new(),
            }) {
                IpcResponse::Success { data: scan } => IpcResponse::success(WatchPollResult {
                    source_root_id: source_id,
                    changed: true,
                    scan: Some(scan),
                }),
                IpcResponse::Error { error } => IpcResponse::error(error),
            }
        }
        IpcResponse::Error { error } => IpcResponse::error(error),
    }
}

#[tauri::command]
pub(crate) fn library_search(
    request: SearchQuery,
    state: State<'_, LibraryState>,
) -> IpcResponse<SearchResults> {
    with_service(&state, |service| service.database.search(&request))
}

#[tauri::command]
pub(crate) fn library_list_collections(
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<CollectionRecord>> {
    with_service(&state, |service| service.database.collections())
}

#[tauri::command]
pub(crate) fn library_list_sources(
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<SourceRootRecord>> {
    with_service(&state, |service| service.database.sources())
}

#[tauri::command]
pub(crate) fn library_list_tags(state: State<'_, LibraryState>) -> IpcResponse<Vec<TagRecord>> {
    with_service(&state, |service| service.database.tags())
}

#[tauri::command]
pub(crate) fn library_create_collection(
    request: NameRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<CollectionRecord> {
    with_service(&state, |service| {
        service.database.create_collection(&request.name)
    })
}

#[tauri::command]
pub(crate) fn library_create_tag(
    request: NameRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<TagRecord> {
    with_service(&state, |service| service.database.create_tag(&request.name))
}

#[tauri::command]
pub(crate) fn library_set_collection_membership(
    request: DocumentRelationRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    let collection_id = CollectionId(request.relation_id);
    with_service(&state, |service| {
        service
            .database
            .set_collection_membership(&document_id, &collection_id, request.included)
    })
}

#[tauri::command]
pub(crate) fn library_set_tag_membership(
    request: DocumentRelationRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    let tag_id = TagId(request.relation_id);
    with_service(&state, |service| {
        service
            .database
            .set_tag_membership(&document_id, &tag_id, request.included)
    })
}

#[tauri::command]
pub(crate) fn library_set_favorite(
    request: FavoriteRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service
            .database
            .set_favorite(&document_id, request.favorite)
    })
}

#[tauri::command]
pub(crate) fn library_record_recent_use(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.database.record_recent_use(&document_id)
    })
}

#[tauri::command]
pub(crate) fn library_rebuild_search_index(
    state: State<'_, LibraryState>,
) -> IpcResponse<IndexRebuildSummary> {
    with_service(&state, |service| service.database.rebuild_search_index())
}

#[tauri::command]
pub(crate) fn library_ocr_model_status(
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrModelStatus> {
    with_service(&state, |service| Ok(service.ocr_model_status()))
}

#[tauri::command]
pub(crate) fn library_start_ocr(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let document_id = DocumentId(request.document_id);
    let response = with_service(&state, |service| service.enqueue_ocr(&document_id));
    schedule_ocr_response(&state, response)
}

#[tauri::command]
pub(crate) fn library_ocr_status(
    request: OcrJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let job_id = OcrJobId(request.ocr_job_id);
    with_service(&state, |service| service.ocr_job(&job_id))
}

#[tauri::command]
pub(crate) fn library_pause_ocr(
    request: OcrJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let job_id = OcrJobId(request.ocr_job_id);
    with_service(&state, |service| service.pause_ocr(&job_id))
}

#[tauri::command]
pub(crate) fn library_resume_ocr(
    request: OcrJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let job_id = OcrJobId(request.ocr_job_id);
    let response = with_service(&state, |service| service.resume_ocr(&job_id));
    schedule_ocr_response(&state, response)
}

#[tauri::command]
pub(crate) fn library_cancel_ocr(
    request: OcrJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let job_id = OcrJobId(request.ocr_job_id);
    with_service(&state, |service| service.cancel_ocr(&job_id))
}

#[tauri::command]
pub(crate) fn library_retry_ocr(
    request: OcrJobRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<OcrJobRecord> {
    let job_id = OcrJobId(request.ocr_job_id);
    let response = with_service(&state, |service| service.retry_ocr(&job_id));
    schedule_ocr_response(&state, response)
}

#[tauri::command]
pub(crate) fn library_document_fragments(
    request: DocumentFragmentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<DocumentFragment>> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.ocr_fragments(&document_id, request.page)
    })
}

#[tauri::command]
pub(crate) fn document_open(
    request: DocumentOpenRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<DocumentOpenResult> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.open_document(&document_id, request.mode)
    })
}

#[tauri::command]
pub(crate) fn document_save(
    request: DocumentSaveRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<DocumentSaveResult> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.save_document(DocumentSaveInput {
            document_id: &document_id,
            expected_sha256: &request.expected_sha256,
            content: &request.content,
            mode: request.mode,
        })
    })
}

#[tauri::command]
pub(crate) fn document_close(
    _request: DocumentRequest,
    _state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    IpcResponse::success(())
}

#[tauri::command]
pub(crate) fn document_list_snapshots(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<SnapshotRecord>> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| service.snapshots(&document_id))
}

#[tauri::command]
pub(crate) fn document_restore_snapshot(
    request: SnapshotRestoreRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<DocumentSaveResult> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.restore_snapshot(&document_id, &request.snapshot_id, &request.expected_sha256)
    })
}

#[tauri::command]
pub(crate) fn document_list_annotations(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<Vec<AnnotationRecord>> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| service.annotations(&document_id))
}

#[tauri::command]
pub(crate) fn document_add_annotation(
    request: AnnotationCreateRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AnnotationRecord> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.add_annotation(&document_id, request.author, request.body, request.anchor)
    })
}

#[tauri::command]
pub(crate) fn document_delete_annotation(
    request: AnnotationDeleteRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    with_service(&state, |service| {
        service.delete_annotation(&request.annotation_id)
    })
}

fn schedule_response<T, F>(
    state: &State<'_, LibraryState>,
    response: IpcResponse<ScanJobRecord>,
    map: F,
) -> IpcResponse<T>
where
    F: FnOnce(ScanJobRecord) -> T,
{
    match response {
        IpcResponse::Success { data: job } => match state.database_path() {
            Ok(path) => {
                spawn_scan_worker(path, job.id.clone());
                IpcResponse::success(map(job))
            }
            Err(error) => IpcResponse::error(library_ipc_error(error)),
        },
        IpcResponse::Error { error } => IpcResponse::Error { error },
    }
}

fn spawn_scan_worker(database_path: PathBuf, scan_job_id: ScanJobId) {
    let _ = std::thread::Builder::new()
        .name("moji-library-scan".to_owned())
        .spawn(move || {
            let result = LibraryService::open_worker(database_path)
                .and_then(|mut service| service.run_scan_job(&scan_job_id));
            if let Err(error) = result {
                tracing::warn!(
                    event = "library_scan_worker_failed",
                    scan_job_id = %scan_job_id.0,
                    code = %error.code,
                );
            }
        });
}

fn schedule_ocr_response(
    state: &State<'_, LibraryState>,
    response: IpcResponse<OcrJobRecord>,
) -> IpcResponse<OcrJobRecord> {
    match response {
        IpcResponse::Success { data: job } => match state.database_path() {
            Ok(path) => {
                spawn_ocr_worker(path, job.id.clone());
                IpcResponse::success(job)
            }
            Err(error) => IpcResponse::error(library_ipc_error(error)),
        },
        IpcResponse::Error { error } => IpcResponse::Error { error },
    }
}

fn spawn_ocr_worker(database_path: PathBuf, ocr_job_id: OcrJobId) {
    let _ = std::thread::Builder::new()
        .name("moji-library-ocr".to_owned())
        .spawn(move || {
            let result = LibraryService::open_worker(database_path)
                .and_then(|mut service| service.run_ocr_job(&ocr_job_id));
            if let Err(error) = result {
                tracing::warn!(
                    event = "library_ocr_worker_failed",
                    ocr_job_id = %ocr_job_id.0,
                    code = %error.code,
                );
            }
        });
}

fn transition_job<F>(
    state: &State<'_, LibraryState>,
    request: ScanJobRequest,
    operation: F,
) -> IpcResponse<ScanJobRecord>
where
    F: FnOnce(&mut ScanQueue<'_>, &ScanJobId) -> LibraryResult<ScanJobRecord>,
{
    let job_id = ScanJobId(request.scan_job_id);
    with_service(state, |service| {
        let mut queue = ScanQueue::new(&mut service.database);
        operation(&mut queue, &job_id)
    })
}

fn with_service<T, F>(state: &State<'_, LibraryState>, operation: F) -> IpcResponse<T>
where
    F: FnOnce(&mut LibraryService) -> LibraryResult<T>,
{
    let mut guard = match state.service.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return IpcResponse::error(library_ipc_error(
                LibraryError::new(
                    LibraryErrorCode::LibraryUnavailable,
                    "library state is unavailable",
                )
                .retryable(),
            ));
        }
    };
    let service = match guard.as_mut() {
        Some(service) => service,
        None => {
            let error = state
                .initialization_error
                .lock()
                .ok()
                .and_then(|error| error.clone())
                .unwrap_or_else(|| {
                    LibraryError::new(
                        LibraryErrorCode::LibraryUnavailable,
                        "library database is not ready",
                    )
                    .retryable()
                });
            return IpcResponse::error(library_ipc_error(error));
        }
    };
    match operation(service) {
        Ok(data) => IpcResponse::success(data),
        Err(error) => IpcResponse::error(library_ipc_error(error)),
    }
}

fn library_ipc_error(error: LibraryError) -> IpcError {
    IpcError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error
            .details
            .or(Some(Value::Null))
            .filter(|value| !value.is_null()),
    }
}

fn ai_ipc_error(error: crate::ai::provider::AiError) -> LibraryError {
    let failure = error.failure;
    LibraryError {
        code: failure.code().to_owned(),
        message: match failure {
            AiFailure::NoApiKey => "未配置 AI 服务凭据".to_owned(),
            AiFailure::InvalidApiKey => "AI 服务凭据无效".to_owned(),
            AiFailure::Timeout => "AI 服务响应超时".to_owned(),
            AiFailure::RateLimited => "AI 服务请求过于频繁".to_owned(),
            AiFailure::Network => "无法连接 AI 服务".to_owned(),
            AiFailure::Cancelled => "AI 请求已取消".to_owned(),
            AiFailure::ToolDenied => "AI 请求的工具不在当前权限范围内".to_owned(),
            AiFailure::Provider => "AI 服务返回了不可用响应".to_owned(),
        },
        retryable: failure.retryable(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ScanJobRequest, ScanRequest, SourceRegistrationData};
    use crate::ipc::response::IpcResponse;
    use crate::library::model::{SourceKind, SourceRegistration, SourceRootId, SourceRootRecord};

    #[test]
    fn serializes_library_requests_with_stable_ids() {
        let request = ScanRequest {
            source_root_id: "src-123".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({ "sourceRootId": "src-123" })
        );
        let job = ScanJobRequest {
            scan_job_id: "job-123".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(job).unwrap(),
            json!({ "scanJobId": "job-123" })
        );
    }

    #[test]
    fn serializes_source_registration_inside_existing_ipc_envelope() {
        let data = SourceRegistrationData {
            source: SourceRegistration {
                source: SourceRootRecord {
                    id: SourceRootId("src-123".to_owned()),
                    kind: SourceKind::Directory,
                    canonical_path: "C:\\\\docs".to_owned(),
                    display_name: "docs".to_owned(),
                    created_at_ms: 1,
                },
                created: true,
            },
        };
        let response = IpcResponse::success(data);
        assert_eq!(serde_json::to_value(response).unwrap()["status"], "success");
    }
}
