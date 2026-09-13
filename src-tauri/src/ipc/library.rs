use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

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
    document::{DocumentBinarySaveInput, DocumentSaveInput},
    model::{
        AnnotationAnchor, AnnotationRecord, CollectionId, CollectionRecord, DocumentFragment,
        DocumentId, DocumentMode, DocumentOpenResult, DocumentSaveAsResult, DocumentSaveResult,
        LibraryError, LibraryErrorCode, LibraryResult, OcrJobId, OcrJobRecord, OcrModelStatus,
        ScanEvent, ScanJobId, ScanJobRecord, ScanJobState, ScanSummary, SearchQuery, SearchResults,
        SnapshotRecord, SourceRegistration, SourceRootId, SourceRootRecord, TagId, TagRecord,
        WatchPollResult, WatchStatus,
    },
    queue::ScanQueue,
    scanner::LibraryService,
};

use super::response::{IpcError, IpcResponse};
use super::workbench::WorkbenchStorageState;

// All background jobs share one SQLite file. Serializing worker lifetimes keeps
// startup migrations and write-heavy scan/OCR jobs from contending on the DB.
static WORKER_DATABASE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn configured_ai_provider(
    workbench: &WorkbenchStorageState,
) -> OpenAiResponsesProvider<WindowsCredentialStore> {
    let credentials = WindowsCredentialStore::default();
    match workbench.ai_config() {
        Some(config) => OpenAiResponsesProvider::new_with_config(credentials, &config.base_url, &config.model)
            .unwrap_or_else(|_| OpenAiResponsesProvider::new(WindowsCredentialStore::default())),
        None => OpenAiResponsesProvider::new(credentials),
    }
}

pub(crate) struct LibraryState {
    service: Arc<Mutex<Option<LibraryService>>>,
    initialization_error: Mutex<Option<LibraryError>>,
    database_path: Mutex<Option<PathBuf>>,
    active_ai_sessions: Mutex<HashMap<String, CancellationToken>>,
    pending_ai_changes: Mutex<HashMap<String, PendingAiChange>>,
}

#[derive(Clone)]
struct PendingAiChange {
    session_id: String,
    permission: crate::ai::tools::AiPermission,
    document_id: String,
    expected_sha256: String,
    old_content: String,
    content: String,
    authorized_document_ids: Vec<String>,
}

impl LibraryState {
    pub(crate) fn empty() -> Self {
        Self {
            service: Arc::new(Mutex::new(None)),
            initialization_error: Mutex::new(None),
            database_path: Mutex::new(None),
            active_ai_sessions: Mutex::new(HashMap::new()),
            pending_ai_changes: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn initialize(&self, database_path: PathBuf) {
        if let Ok(mut slot) = self.database_path.lock() {
            *slot = Some(database_path.clone());
        }
        let initialization = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            LibraryService::open(database_path)
        }));
        match initialization {
            Err(_) => {
                tracing::error!(
                    event = "library_initialization_panicked",
                    "library initialization was interrupted safely"
                );
                if let Ok(mut slot) = self.initialization_error.lock() {
                    *slot = Some(
                        LibraryError::new(
                            LibraryErrorCode::LibraryUnavailable,
                            "资料库初始化异常，应用仍可继续使用；请稍后重试",
                        )
                        .retryable(),
                    );
                }
            }
            Ok(result) => match result {
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
            },
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

    fn start_ai_session(&self, session_id: &str) -> LibraryResult<CancellationToken> {
        if session_id.trim().is_empty() || session_id.len() > 128 {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "AI session identifier is invalid",
            ));
        }
        let token = CancellationToken::default();
        let mut sessions = self.active_ai_sessions.lock().map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::LibraryUnavailable,
                "AI session state is unavailable",
            )
        })?;
        if sessions.contains_key(session_id) {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "AI session is already active",
            ));
        }
        sessions.insert(session_id.to_owned(), token.clone());
        Ok(token)
    }

    fn finish_ai_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.active_ai_sessions.lock() {
            sessions.remove(session_id);
        }
    }

    fn cancel_ai_session(&self, session_id: &str) -> bool {
        let token = self
            .active_ai_sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned())
            .filter(|token| !token.is_cancelled());
        let Some(token) = token else {
            return false;
        };
        token.cancel();
        if let Ok(mut changes) = self.pending_ai_changes.lock() {
            changes.retain(|_, change| change.session_id != session_id);
        }
        true
    }

    fn remember_changes(
        &self,
        request: &AiChatRequest,
        result: &AiChatResult,
        cancellation: &CancellationToken,
    ) {
        // Holding the active-session lock prevents cancellation from racing a successful
        // provider response into the review queue.
        let Ok(sessions) = self.active_ai_sessions.lock() else {
            return;
        };
        if cancellation.is_cancelled() || !sessions.contains_key(&request.session_id) {
            return;
        }
        let Ok(mut changes) = self.pending_ai_changes.lock() else {
            return;
        };
        for event in &result.events {
            if let AiStreamEvent::ProposedChange {
                proposal_id,
                document_id,
                permission,
                expected_sha256,
                old_content,
                new_content,
                ..
            } = event
                && permission == crate::ai::tools::AiPermission::Assist.as_str()
                && request.permission == crate::ai::tools::AiPermission::Assist
            {
                changes.insert(
                    proposal_id.clone(),
                    PendingAiChange {
                        session_id: request.session_id.clone(),
                        permission: request.permission,
                        document_id: document_id.clone(),
                        expected_sha256: expected_sha256.clone(),
                        old_content: old_content.clone(),
                        content: new_content.clone(),
                        authorized_document_ids: request.authorized_document_ids.clone(),
                    },
                );
            }
        }
    }

    fn take_approved_change(&self, request: &AiChangeRequest) -> LibraryResult<AiChangeRequest> {
        let change_id = request.change_id.as_deref().ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "AI change approval is required",
            )
        })?;
        let mut changes = self.pending_ai_changes.lock().map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::LibraryUnavailable,
                "AI review state is unavailable",
            )
        })?;
        let pending = changes.get(change_id).cloned().ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "AI change is unavailable",
            )
        })?;
        if request.session_id != pending.session_id
            || request.permission != pending.permission
            || request.document_id != pending.document_id
            || (pending.permission == crate::ai::tools::AiPermission::Assist && !request.approved)
            || pending.permission == crate::ai::tools::AiPermission::Suggest
        {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "AI change approval does not match the proposal",
            ));
        }
        changes.remove(change_id);
        Ok(AiChangeRequest {
            session_id: pending.session_id,
            permission: pending.permission,
            document_id: pending.document_id,
            expected_sha256: pending.expected_sha256,
            old_content: pending.old_content,
            content: pending.content,
            approved: request.approved,
            change_id: Some(change_id.to_owned()),
            authorized_document_ids: pending.authorized_document_ids,
        })
    }

    fn reject_change(&self, session_id: &str, change_id: &str) -> LibraryResult<bool> {
        let mut changes = self.pending_ai_changes.lock().map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::LibraryUnavailable,
                "AI review state is unavailable",
            )
        })?;
        let matches_session = changes
            .get(change_id)
            .is_some_and(|change| change.session_id == session_id);
        if matches_session {
            changes.remove(change_id);
        }
        Ok(matches_session)
    }
}

fn apply_autonomous_changes(
    service: &mut LibraryService,
    request: &AiChatRequest,
    result: &AiChatResult,
    status_sink: &mut dyn FnMut(AiStreamEvent),
) -> LibraryResult<()> {
    if request.permission != crate::ai::tools::AiPermission::Autonomous {
        return Ok(());
    }
    for event in &result.events {
        let AiStreamEvent::ProposedChange {
            proposal_id,
            document_id,
            permission,
            expected_sha256,
            old_content,
            new_content,
        } = event else {
            continue;
        };
        if permission != crate::ai::tools::AiPermission::Autonomous.as_str() {
            continue;
        }
        tracing::debug!(
            event = "ai_autonomous_writeback_start",
            session_id = %request.session_id,
            document_id = %document_id,
            proposal_id = %proposal_id,
            "starting autonomous document writeback"
        );
        status_sink(AiStreamEvent::WritebackStatus {
            proposal_id: proposal_id.clone(),
            document_id: document_id.clone(),
            status: "started".to_owned(),
            message: "正在安全写回当前文档".to_owned(),
            code: None,
        });
        let applied = crate::ai::orchestrator::apply_change(
            service,
            &AiChangeRequest {
                session_id: request.session_id.clone(),
                permission: request.permission,
                document_id: document_id.clone(),
                expected_sha256: expected_sha256.clone(),
                old_content: old_content.clone(),
                content: new_content.clone(),
                // Autonomous permission is the user's approval for the selected document.
                approved: false,
                change_id: Some(proposal_id.clone()),
                authorized_document_ids: request.authorized_document_ids.clone(),
            },
        );
        match applied {
            Ok(result) if result
                .save
                .as_ref()
                .is_some_and(|save| save.new_sha256 != *expected_sha256) => {}
            Ok(_) => {
                let error = LibraryError::new(
                    LibraryErrorCode::DocumentWriteFailed,
                    "AI 修改没有产生文件写回结果",
                )
                .retryable();
                status_sink(AiStreamEvent::WritebackStatus {
                    proposal_id: proposal_id.clone(),
                    document_id: document_id.clone(),
                    status: "failed".to_owned(),
                    message: "AI 修改没有写入文件，请重试".to_owned(),
                    code: Some(error.code.clone()),
                });
                return Err(error);
            }
            Err(error) => {
                status_sink(AiStreamEvent::WritebackStatus {
                    proposal_id: proposal_id.clone(),
                    document_id: document_id.clone(),
                    status: "failed".to_owned(),
                    message: "文档写回失败，请重试".to_owned(),
                    code: Some(error.code.clone()),
                });
                tracing::warn!(
                    event = "ai_autonomous_writeback_failed",
                    session_id = %request.session_id,
                    document_id = %document_id,
                    proposal_id = %proposal_id,
                    code = %error.code,
                    "autonomous document writeback failed"
                );
                return Err(error);
            }
        }
        status_sink(AiStreamEvent::WritebackStatus {
            proposal_id: proposal_id.clone(),
            document_id: document_id.clone(),
            status: "applied".to_owned(),
            message: "文档已安全写回".to_owned(),
            code: None,
        });
        tracing::debug!(
            event = "ai_autonomous_writeback_completed",
            session_id = %request.session_id,
            document_id = %document_id,
            proposal_id = %proposal_id,
            "autonomous document writeback completed"
        );
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePickerResult {
    pub cancelled: bool,
    pub source: Option<SourceRegistration>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommonLocationScanResult {
    pub sources: Vec<SourceRootRecord>,
    pub jobs: Vec<ScanJobRecord>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanFolderNode {
    pub relative_path: String,
    pub display_name: String,
    pub depth: u8,
    pub file_count: u64,
    pub children: Vec<ScanFolderNode>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanRootPreview {
    pub source_id: String,
    pub label: String,
    pub root: ScanFolderNode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanPreviewResult {
    pub roots: Vec<ScanRootPreview>,
    pub skipped: Vec<String>,
    pub max_depth: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ScanPreviewEvent {
    Started {
        root_count: u32,
    },
    RootStarted {
        label: String,
        root_index: u32,
        root_count: u32,
    },
    Folder {
        label: String,
        relative_path: String,
        folders_scanned: u64,
        files_found: u64,
    },
    Completed {
        folders_scanned: u64,
        files_found: u64,
    },
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanSelection {
    pub source_id: String,
    pub relative_paths: Vec<String>,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanSelectionRequest {
    pub selections: Vec<ScanSelection>,
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
pub(crate) struct AiCancelRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiCancelResult {
    pub session_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRejectChangeRequest {
    pub session_id: String,
    pub change_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRejectChangeResult {
    pub change_id: String,
    pub rejected: bool,
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
pub(crate) struct DocumentBinarySaveRequest {
    pub document_id: String,
    pub expected_sha256: String,
    pub binary_content: String,
    pub mode: DocumentMode,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentSaveAsRequest {
    pub document_id: String,
    pub content: Option<String>,
    pub binary_content: Option<String>,
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
    workbench: State<'_, WorkbenchStorageState>,
) -> IpcResponse<AiChatResult> {
    let provider = configured_ai_provider(&workbench);
    let cancellation = match state.start_ai_session(&request.session_id) {
        Ok(token) => token,
        Err(error) => return IpcResponse::error(library_ipc_error(error)),
    };
    let response = with_service(&state, |service| {
        let result = crate::ai::orchestrator::chat(service, service, &provider, &request, &cancellation)
            .map_err(ai_ipc_error)?;
        apply_autonomous_changes(service, &request, &result, &mut |_| {})?;
        Ok(result)
    });
    if let IpcResponse::Success { data } = &response {
        state.remember_changes(&request, data, &cancellation);
    }
    state.finish_ai_session(&request.session_id);
    response
}

#[tauri::command]
pub(crate) async fn ai_chat_stream(
    request: AiChatRequest,
    on_event: Channel<AiStreamEvent>,
    state: State<'_, LibraryState>,
    workbench: State<'_, WorkbenchStorageState>,
) -> Result<IpcResponse<AiChatResult>, String> {
    let provider = configured_ai_provider(&workbench);
    let cancellation = match state.start_ai_session(&request.session_id) {
        Ok(token) => token,
        Err(error) => return Ok(IpcResponse::error(library_ipc_error(error))),
    };
    let service = Arc::clone(&state.service);
    let request_for_task = request.clone();
    let cancellation_for_task = cancellation.clone();
    let task_result = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = service.lock().map_err(|_| crate::library::model::LibraryError::new(LibraryErrorCode::LibraryUnavailable, "资料库状态不可用").retryable())?;
        let service = guard.as_mut().ok_or_else(|| crate::library::model::LibraryError::new(LibraryErrorCode::LibraryUnavailable, "资料库尚未准备完成").retryable())?;
        let result = crate::ai::orchestrator::chat_with_sink(
            service,
            service,
            &provider,
            &request_for_task,
            &cancellation_for_task,
            &mut |event| {
                on_event
                    .send(event.clone())
                    .map_err(|_| crate::ai::provider::AiError::new(AiFailure::Provider))
            },
        )
        .map_err(ai_ipc_error)?;
        apply_autonomous_changes(service, &request_for_task, &result, &mut |event| {
            let _ = on_event.send(event);
        })?;
        Ok(result)
    }).await;
    // Keep the command contract stable even when the blocking worker cannot
    // be joined (for example, a panic in a provider adapter). Returning a raw
    // `Err(String)` here makes the renderer treat the call as a transport
    // failure and can leave the AI composer stuck in its busy state. Convert
    // every worker outcome to the normal structured IPC response instead.
    let response = match task_result {
        Ok(Ok(data)) => IpcResponse::success(data),
        Ok(Err(error)) => IpcResponse::error(library_ipc_error(error)),
        Err(error) => {
            tracing::error!(
                event = "ai_background_task_failed",
                session_id = %request.session_id,
                "AI background task could not be joined: {error}"
            );
            IpcResponse::error(library_ipc_error(
                LibraryError::new(
                    LibraryErrorCode::LibraryUnavailable,
                    "AI 后台任务异常，请重试",
                )
                .retryable(),
            ))
        }
    };
    if let IpcResponse::Success { data } = &response {
        state.remember_changes(&request, data, &cancellation);
    }
    state.finish_ai_session(&request.session_id);
    Ok(response)
}

#[tauri::command]
pub(crate) fn ai_cancel(
    request: AiCancelRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiCancelResult> {
    IpcResponse::success(AiCancelResult {
        session_id: request.session_id.clone(),
        cancelled: state.cancel_ai_session(&request.session_id),
    })
}

#[tauri::command]
pub(crate) fn ai_apply_change(
    request: AiChangeRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiChangeResult> {
    let verified = match state.take_approved_change(&request) {
        Ok(change) => change,
        Err(error) => return IpcResponse::error(library_ipc_error(error)),
    };
    with_service(&state, |service| {
        crate::ai::orchestrator::apply_change(service, &verified)
    })
}

#[tauri::command]
pub(crate) fn ai_reject_change(
    request: AiRejectChangeRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<AiRejectChangeResult> {
    match state.reject_change(&request.session_id, &request.change_id) {
        Ok(rejected) => IpcResponse::success(AiRejectChangeResult {
            change_id: request.change_id,
            rejected,
        }),
        Err(error) => IpcResponse::error(library_ipc_error(error)),
    }
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
pub(crate) fn library_pick_source_folder(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> IpcResponse<SourcePickerResult> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择要授权的资料文件夹")
        .blocking_pick_folder();
    register_selected_source(&state, selected)
}

#[tauri::command]
pub(crate) fn library_pick_source_file(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> IpcResponse<SourcePickerResult> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择要授权的资料文件")
        .add_filter(
            "支持的资料",
            &[
                "doc", "docx", "pptx", "xlsx", "pdf", "md", "markdown", "txt", "csv",
            ],
        )
        .blocking_pick_file();
    register_selected_source(&state, selected)
}

#[tauri::command]
pub(crate) fn library_scan_common_locations(
    state: State<'_, LibraryState>,
) -> IpcResponse<CommonLocationScanResult> {
    let mut sources = Vec::new();
    let mut jobs = Vec::new();
    let mut skipped = Vec::new();

    for candidate in common_location_candidates() {
        let label = candidate.label.as_str();
        let path = candidate.path;
        if !path.is_dir() {
            skipped.push(label.to_owned());
            continue;
        }
        let registration = match with_service(&state, |service| service.register_source(&path)) {
            IpcResponse::Success { data } => data,
            IpcResponse::Error { error } => {
                skipped.push(label.to_owned());
                tracing::debug!(
                    event = "common_location_skipped",
                    location = label,
                    code = %error.code,
                );
                continue;
            }
        };
        let mut source = registration.source;
        // Common locations use stable, user-facing labels even when a previous
        // registration stored a generic drive-root name such as "source".
        source.display_name = label.to_owned();
        let source_id = source.id.clone();
        let response = with_service(&state, |service| service.enqueue_scan(&source_id));
        match schedule_response(&state, response, |job| job) {
            IpcResponse::Success { data: job } => {
                sources.push(source);
                jobs.push(job);
            }
            IpcResponse::Error { error } => {
                skipped.push(label.to_owned());
                tracing::debug!(
                    event = "common_location_scan_queue_failed",
                    location = label,
                    code = %error.code,
                );
            }
        }
    }

    IpcResponse::success(CommonLocationScanResult {
        sources,
        jobs,
        skipped,
    })
}

#[tauri::command]
pub(crate) async fn library_preview_common_locations(
    on_event: Channel<ScanPreviewEvent>,
) -> IpcResponse<ScanPreviewResult> {
    let candidates = common_location_candidates();
    tauri::async_runtime::spawn_blocking(move || {
        preview_scan_locations_with_events(candidates, on_event)
    })
    .await
    .unwrap_or_else(|_| {
        IpcResponse::error(IpcError {
            code: "SCAN_PREVIEW_FAILED".to_owned(),
            message: "扫描目录枚举任务无法启动".to_owned(),
            retryable: true,
            details: None,
        })
    })
}

#[tauri::command]
pub(crate) async fn library_preview_full_disk(
    on_event: Channel<ScanPreviewEvent>,
) -> IpcResponse<ScanPreviewResult> {
    let candidates = full_disk_candidates();
    tauri::async_runtime::spawn_blocking(move || {
        preview_scan_locations_with_events(candidates, on_event)
    })
    .await
    .unwrap_or_else(|_| {
        IpcResponse::error(IpcError {
            code: "SCAN_PREVIEW_FAILED".to_owned(),
            message: "全盘目录枚举任务无法启动".to_owned(),
            retryable: true,
            details: None,
        })
    })
}

#[tauri::command]
pub(crate) fn library_start_selected_scan(
    request: ScanSelectionRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<CommonLocationScanResult> {
    let candidates = common_location_candidates()
        .into_iter()
        .chain(full_disk_candidates())
        .collect::<Vec<_>>();
    let mut sources = Vec::new();
    let mut jobs = Vec::new();
    let mut skipped = Vec::new();

    for selection in request.selections {
        let Some(candidate) = candidates
            .iter()
            .find(|item| item.id == selection.source_id)
        else {
            skipped.push(selection.source_id);
            continue;
        };
        let authorized = match crate::library::policy::authorize_source(&candidate.path) {
            Ok(source) => source,
            Err(_) => {
                skipped.push(candidate.label.clone());
                continue;
            }
        };
        let mut relative_paths = selection.relative_paths;
        if relative_paths.is_empty() {
            relative_paths.push(String::new());
        }
        relative_paths.sort_by_key(|path| path.len());
        let mut accepted = Vec::<PathBuf>::new();
        for relative in relative_paths {
            let relative = relative.trim().replace('/', "\\");
            if relative
                .split('\\')
                .any(|part| part == ".." || part.is_empty() && relative != "")
            {
                continue;
            }
            let path = if relative.is_empty() {
                authorized.canonical_path.clone()
            } else {
                authorized.canonical_path.join(&relative)
            };
            let Ok(path) = crate::library::policy::authorize_candidate(&authorized, &path) else {
                continue;
            };
            if accepted.iter().any(|parent| path.starts_with(parent)) {
                continue;
            }
            accepted.retain(|existing| !existing.starts_with(&path));
            accepted.push(path);
        }
        for path in accepted {
            let registration = match with_service(&state, |service| service.register_source(&path))
            {
                IpcResponse::Success { data } => data,
                IpcResponse::Error { error } => {
                    skipped.push(format!("{}: {}", candidate.label, error.message));
                    continue;
                }
            };
            let mut source = registration.source;
            source.display_name = if path == authorized.canonical_path {
                candidate.label.clone()
            } else {
                format!(
                    "{} / {}",
                    candidate.label,
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("文件夹")
                )
            };
            let source_id = source.id.clone();
            match schedule_response(
                &state,
                with_service(&state, |service| service.enqueue_scan(&source_id)),
                |job| job,
            ) {
                IpcResponse::Success { data: job } => {
                    sources.push(source);
                    jobs.push(job);
                }
                IpcResponse::Error { error } => {
                    skipped.push(format!("{}: {}", candidate.label, error.message))
                }
            }
        }
    }

    IpcResponse::success(CommonLocationScanResult {
        sources,
        jobs,
        skipped,
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
pub(crate) fn library_remove_document(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.database.remove_from_library(&document_id)
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
pub(crate) fn document_open_external(
    request: DocumentRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<()> {
    let document_id = DocumentId(request.document_id);
    with_service(&state, |service| {
        service.open_document_external(&document_id)
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
pub(crate) fn document_save_binary(
    request: DocumentBinarySaveRequest,
    state: State<'_, LibraryState>,
) -> IpcResponse<DocumentSaveResult> {
    let document_id = DocumentId(request.document_id);
    let bytes = match STANDARD.decode(request.binary_content.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return IpcResponse::error(IpcError {
                code: "INVALID_ARGUMENT".to_owned(),
                message: "Office 输出不是有效的 Base64 数据".to_owned(),
                retryable: false,
                details: None,
            });
        }
    };
    with_service(&state, |service| {
        service.save_binary_document(DocumentBinarySaveInput {
            document_id: &document_id,
            expected_sha256: &request.expected_sha256,
            content: &bytes,
            mode: request.mode,
        })
    })
}

#[tauri::command]
pub(crate) fn document_save_as(
    request: DocumentSaveAsRequest,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> IpcResponse<DocumentSaveAsResult> {
    let document_id = DocumentId(request.document_id);
    let document = match with_service(&state, |service| service.document(&document_id)) {
        IpcResponse::Success { data } => data,
        IpcResponse::Error { error } => return IpcResponse::Error { error },
    };
    let bytes = match (request.content, request.binary_content) {
        (Some(content), None) => content.into_bytes(),
        (None, Some(content)) => match STANDARD.decode(content.as_bytes()) {
            Ok(bytes) => bytes,
            Err(_) => {
                return IpcResponse::error(IpcError {
                    code: "INVALID_ARGUMENT".to_owned(),
                    message: "另存内容不是有效的 Base64 数据".to_owned(),
                    retryable: false,
                    details: None,
                });
            }
        },
        _ => {
            return IpcResponse::error(IpcError {
                code: "INVALID_ARGUMENT".to_owned(),
                message: "另存请求必须提供一种文档内容".to_owned(),
                retryable: false,
                details: None,
            });
        }
    };
    let extension = document.format.as_str();
    let selected = app
        .dialog()
        .file()
        .set_title("另存文档副本")
        .set_file_name(&document.display_name)
        .add_filter(extension.to_ascii_uppercase(), &[extension])
        .blocking_save_file();
    let Some(selected) = selected else {
        return IpcResponse::success(DocumentSaveAsResult {
            document_id,
            cancelled: true,
            target_name: None,
            new_sha256: None,
            source_preserved: true,
        });
    };
    let target = match selected.into_path() {
        Ok(path) => path,
        Err(_) => {
            return IpcResponse::error(IpcError {
                code: "INVALID_ARGUMENT".to_owned(),
                message: "另存位置不是本地文件路径".to_owned(),
                retryable: false,
                details: None,
            });
        }
    };
    with_service(&state, |service| {
        service.save_document_copy(&document_id, &bytes, &target)
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
                if job.state == ScanJobState::Queued {
                    spawn_scan_worker(path, job.id.clone());
                }
                IpcResponse::success(map(job))
            }
            Err(error) => IpcResponse::error(library_ipc_error(error)),
        },
        IpcResponse::Error { error } => IpcResponse::Error { error },
    }
}

fn register_selected_source(
    state: &State<'_, LibraryState>,
    selected: Option<tauri_plugin_dialog::FilePath>,
) -> IpcResponse<SourcePickerResult> {
    let Some(selected) = selected else {
        return IpcResponse::success(SourcePickerResult {
            cancelled: true,
            source: None,
        });
    };
    let path = match selected.into_path() {
        Ok(path) => path,
        Err(_) => {
            return IpcResponse::error(IpcError {
                code: "INVALID_ARGUMENT".to_owned(),
                message: "选择的资料不是本地文件或文件夹".to_owned(),
                retryable: false,
                details: None,
            });
        }
    };
    with_service(state, |service| {
        service
            .register_source(path)
            .map(|source| SourcePickerResult {
                cancelled: false,
                source: Some(source),
            })
    })
}

#[derive(Debug, Clone)]
struct ScanLocationCandidate {
    id: String,
    label: String,
    path: PathBuf,
}

fn common_location_candidates() -> Vec<ScanLocationCandidate> {
    let profile = std::env::var_os("USERPROFILE").or_else(|| {
        let drive = std::env::var_os("HOMEDRIVE")?;
        let home = std::env::var_os("HOMEPATH")?;
        let mut path = PathBuf::from(drive);
        path.push(home);
        Some(path.into_os_string())
    });
    let Some(profile) = profile else {
        return Vec::new();
    };
    let profile = PathBuf::from(profile);
    let mut candidates = Vec::new();
    let mut add = |id: &str, label: &str, path: PathBuf| {
        if candidates
            .iter()
            .all(|item: &ScanLocationCandidate| item.path != path)
        {
            candidates.push(ScanLocationCandidate {
                id: id.to_owned(),
                label: label.to_owned(),
                path,
            });
        }
    };
    add("desktop", "桌面", profile.join("Desktop"));
    add("documents", "文档", profile.join("Documents"));
    add("downloads", "下载", profile.join("Downloads"));
    add("onedrive", "OneDrive", profile.join("OneDrive"));
    add(
        "wechat-documents",
        "微信资料",
        profile.join(r"Documents\WeChat Files"),
    );
    add(
        "wechat-roaming",
        "微信资料（应用目录）",
        profile.join(r"AppData\Roaming\Tencent\WeChat"),
    );
    // Data volumes are discovered at runtime instead of assuming that every
    // machine has a D: drive. The profile's volume is already represented by
    // Desktop/Documents/Downloads above; other local volumes are offered as
    // whole roots so files stored directly under D:\, E:\, etc. are included.
    #[cfg(windows)]
    {
        let system_drive = profile
            .to_string_lossy()
            .chars()
            .next()
            .map(|letter| letter.to_ascii_uppercase());
        for letter in b'A'..=b'Z' {
            let letter = letter as char;
            if Some(letter) == system_drive {
                continue;
            }
            let path = PathBuf::from(format!("{}:/", letter));
            if path.is_dir() {
                add(
                    &format!("common-drive-{}", letter),
                    &format!("{}盘", letter),
                    path,
                );
            }
        }
    }
    candidates
}

fn full_disk_candidates() -> Vec<ScanLocationCandidate> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let path = PathBuf::from(format!("{}:\\", letter as char));
                path.is_dir().then(|| ScanLocationCandidate {
                    id: format!("drive-{}", letter as char),
                    label: format!("{}盘（排除系统文件）", letter as char),
                    path,
                })
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn preview_scan_locations_with_events(
    candidates: Vec<ScanLocationCandidate>,
    on_event: Channel<ScanPreviewEvent>,
) -> IpcResponse<ScanPreviewResult> {
    const MAX_DEPTH: u8 = 3;
    let mut roots = Vec::new();
    let mut skipped = Vec::new();
    let root_count = candidates.len() as u32;
    let _ = on_event.send(ScanPreviewEvent::Started { root_count });
    let mut folders_scanned = 0u64;
    let mut files_found = 0u64;
    for (index, candidate) in candidates.into_iter().enumerate() {
        if !candidate.path.is_dir() {
            skipped.push(candidate.label);
            continue;
        }
        let _ = on_event.send(ScanPreviewEvent::RootStarted {
            label: candidate.label.clone(),
            root_index: index as u32 + 1,
            root_count,
        });
        match build_folder_node_with_progress(
            &candidate.path,
            "",
            0,
            MAX_DEPTH,
            &candidate.label,
            &on_event,
            &mut folders_scanned,
            &mut files_found,
        ) {
            Ok(root) => roots.push(ScanRootPreview {
                source_id: candidate.id,
                label: candidate.label,
                root,
            }),
            Err(_) => skipped.push(candidate.label),
        }
    }
    let _ = on_event.send(ScanPreviewEvent::Completed {
        folders_scanned,
        files_found,
    });
    IpcResponse::success(ScanPreviewResult {
        roots,
        skipped,
        max_depth: MAX_DEPTH,
    })
}

fn build_folder_node_with_progress(
    path: &Path,
    relative_path: &str,
    depth: u8,
    max_depth: u8,
    label: &str,
    on_event: &Channel<ScanPreviewEvent>,
    folders_scanned: &mut u64,
    files_found: &mut u64,
) -> std::io::Result<ScanFolderNode> {
    let display_name = if relative_path.is_empty() {
        path.file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("根目录")
            .to_owned()
    } else {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("文件夹")
            .to_owned()
    };
    *folders_scanned += 1;
    if *folders_scanned == 1 || *folders_scanned % 16 == 0 {
        let _ = on_event.send(ScanPreviewEvent::Folder {
            label: label.to_owned(),
            relative_path: relative_path.to_owned(),
            folders_scanned: *folders_scanned,
            files_found: *files_found,
        });
    }
    let mut file_count = 0u64;
    let mut child_paths = Vec::new();
    for entry in fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        let child = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&child) else {
            continue;
        };
        if crate::library::policy::exclusion_reason(&child, &metadata).is_some() {
            continue;
        }
        if metadata.is_file() {
            if crate::library::policy::format_from_path(&child).is_some() {
                file_count += 1;
                *files_found += 1;
            }
        } else if metadata.is_dir() {
            child_paths.push(child);
        }
    }
    child_paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    let mut children = Vec::new();
    let mut has_more = false;
    for child in child_paths {
        let child_relative = if relative_path.is_empty() {
            child
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_owned()
        } else {
            format!(
                "{}\\{}",
                relative_path,
                child
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
            )
        };
        if depth < max_depth {
            if let Ok(node) = build_folder_node_with_progress(
                &child,
                &child_relative,
                depth + 1,
                max_depth,
                label,
                on_event,
                folders_scanned,
                files_found,
            ) {
                children.push(node);
            }
        } else {
            has_more = true;
        }
    }
    Ok(ScanFolderNode {
        relative_path: relative_path.to_owned(),
        display_name,
        depth,
        file_count,
        children,
        has_more,
    })
}

fn spawn_scan_worker(database_path: PathBuf, scan_job_id: ScanJobId) {
    let _ = std::thread::Builder::new()
        .name("moji-library-scan".to_owned())
        .spawn(move || {
            let lock = WORKER_DATABASE_LOCK.get_or_init(|| Mutex::new(()));
            let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
            let lock = WORKER_DATABASE_LOCK.get_or_init(|| Mutex::new(()));
            let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let detail = error.detail;
    let base_message = match failure {
        AiFailure::NoApiKey => "未配置 AI 服务凭据",
        AiFailure::InvalidApiKey => "AI 服务凭据无效",
        AiFailure::Timeout => "AI 服务响应超时",
        AiFailure::RateLimited => "AI 服务请求过于频繁",
        AiFailure::Network => "无法连接 AI 服务",
        AiFailure::Cancelled => "AI 请求已取消",
        AiFailure::ToolDenied => "AI 请求的工具不在当前权限范围内",
        AiFailure::Provider => "AI 服务返回了不可用响应",
    };
    LibraryError {
        code: failure.code().to_owned(),
        message: detail
            .as_deref()
            .map(|detail| format!("{base_message}（{detail}）"))
            .unwrap_or_else(|| base_message.to_owned()),
        retryable: failure.retryable(),
        details: detail.map(|detail| json!({ "diagnostic": detail })),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        AiCancelRequest, LibraryState, PendingAiChange, ScanJobRequest, ScanRequest,
        SourcePickerResult, ai_ipc_error,
    };
    use crate::ai::provider::{AiError, AiFailure, AiStreamEvent};
    use crate::ai::{orchestrator::AiChangeRequest, tools::AiPermission};
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
    fn ai_ipc_error_preserves_safe_provider_diagnostic() {
        let error = ai_ipc_error(AiError::with_detail(
            AiFailure::Provider,
            "Chat Completions 返回成功，但没有可显示的文本内容（顶层字段：choices）",
        ));
        assert!(error.message.contains("顶层字段：choices"));
        assert_eq!(
            error.details,
            Some(json!({
                "diagnostic": "Chat Completions 返回成功，但没有可显示的文本内容（顶层字段：choices）"
            }))
        );
    }

    #[test]
    fn picker_response_does_not_serialize_the_authorized_path() {
        let data = SourcePickerResult {
            cancelled: false,
            source: Some(SourceRegistration {
                source: SourceRootRecord {
                    id: SourceRootId("src-123".to_owned()),
                    kind: SourceKind::Directory,
                    canonical_path: r"C:\\private\\documents".to_owned(),
                    display_name: "docs".to_owned(),
                    created_at_ms: 1,
                },
                created: true,
            }),
        };
        let response = IpcResponse::success(data);
        let serialized = serde_json::to_value(response).unwrap();
        assert_eq!(serialized["status"], "success");
        assert!(serialized.to_string().contains("docs"));
        assert!(!serialized.to_string().contains("private"));
    }

    #[test]
    fn ai_session_cancel_marks_the_registered_token_without_accessing_library_data() {
        let state = LibraryState::empty();
        let token = state.start_ai_session("session-cancel").unwrap();
        assert!(!token.is_cancelled());
        assert!(state.cancel_ai_session("session-cancel"));
        assert!(token.is_cancelled());
        assert!(!state.cancel_ai_session("missing"));
        state.finish_ai_session("session-cancel");
        assert!(!state.cancel_ai_session("session-cancel"));

        let request = AiCancelRequest {
            session_id: "session-cancel".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({ "sessionId": "session-cancel" })
        );
    }

    #[test]
    fn accepted_change_uses_the_server_proposal_not_client_content_and_rejection_revokes_it() {
        let state = LibraryState::empty();
        state.pending_ai_changes.lock().unwrap().insert(
            "proposal-1".to_owned(),
            PendingAiChange {
                session_id: "session-1".to_owned(),
                permission: AiPermission::Assist,
                document_id: "doc-1".to_owned(),
                expected_sha256: "server-hash".to_owned(),
                old_content: "server-old".to_owned(),
                content: "server-content".to_owned(),
                authorized_document_ids: vec![],
            },
        );
        let accepted = state
            .take_approved_change(&AiChangeRequest {
                session_id: "session-1".to_owned(),
                permission: AiPermission::Assist,
                document_id: "doc-1".to_owned(),
                expected_sha256: "client-hash".to_owned(),
                old_content: "client-old".to_owned(),
                content: "client-content".to_owned(),
                approved: true,
                change_id: Some("proposal-1".to_owned()),
                authorized_document_ids: vec!["client-doc".to_owned()],
            })
            .unwrap();
        assert_eq!(accepted.expected_sha256, "server-hash");
        assert_eq!(accepted.content, "server-content");
        assert!(!state.reject_change("session-1", "proposal-1").unwrap());

        state.pending_ai_changes.lock().unwrap().insert(
            "proposal-2".to_owned(),
            PendingAiChange {
                session_id: "session-1".to_owned(),
                permission: AiPermission::Assist,
                document_id: "doc-1".to_owned(),
                expected_sha256: "hash".to_owned(),
                old_content: "old".to_owned(),
                content: "content".to_owned(),
                authorized_document_ids: vec![],
            },
        );
        assert!(state.reject_change("session-1", "proposal-2").unwrap());
        assert!(
            state
                .pending_ai_changes
                .lock()
                .unwrap()
                .get("proposal-2")
                .is_none()
        );
    }

    #[test]
    fn cancelled_ai_session_cannot_register_or_apply_stale_proposals() {
        let state = LibraryState::empty();
        let token = state.start_ai_session("session-cancelled").unwrap();
        let request = crate::ai::orchestrator::AiChatRequest {
            session_id: "session-cancelled".to_owned(),
            prompt: "update the note".to_owned(),
            document_ids: vec!["doc-1".to_owned()],
            selections: vec![],
            max_chars: None,
            permission: AiPermission::Autonomous,
                confirmed: true,
                authorized_document_ids: vec!["doc-1".to_owned()],
                conversation: vec![],
        };
        let result = crate::ai::orchestrator::AiChatResult {
            session_id: request.session_id.clone(),
            permission: AiPermission::Autonomous,
            context: crate::ai::context::ContextPreview {
                sources: vec![],
                segment_count: 0,
                character_count: 0,
                estimated_tokens: 0,
                truncated: false,
                permission: AiPermission::Autonomous.as_str().to_owned(),
                untrusted: true,
            },
            events: vec![AiStreamEvent::ProposedChange {
                proposal_id: "proposal-cancelled".to_owned(),
                document_id: "doc-1".to_owned(),
                permission: AiPermission::Autonomous.as_str().to_owned(),
                expected_sha256: "hash".to_owned(),
                old_content: "before".to_owned(),
                new_content: "after".to_owned(),
            }],
        };

        assert!(state.cancel_ai_session(&request.session_id));
        assert!(token.is_cancelled());
        state.remember_changes(&request, &result, &token);
        let error = state
            .take_approved_change(&AiChangeRequest {
                session_id: request.session_id,
                permission: AiPermission::Autonomous,
                document_id: "doc-1".to_owned(),
                expected_sha256: "hash".to_owned(),
                old_content: "before".to_owned(),
                content: "after".to_owned(),
                approved: true,
                change_id: Some("proposal-cancelled".to_owned()),
                authorized_document_ids: vec!["doc-1".to_owned()],
            })
            .expect_err("cancelled sessions must not retain proposals");
        assert_eq!(error.code, "INVALID_ARGUMENT");
    }
}
