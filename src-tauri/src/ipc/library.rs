use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::library::{
    model::{
        LibraryError, LibraryErrorCode, LibraryResult, ScanJobId, ScanJobRecord, ScanSummary,
        SourceRegistration, SourceRootId,
    },
    queue::ScanQueue,
    scanner::LibraryService,
};

use super::response::{IpcError, IpcResponse};

pub(crate) struct LibraryState {
    service: Mutex<Option<LibraryService>>,
    initialization_error: Mutex<Option<LibraryError>>,
}

impl LibraryState {
    pub(crate) fn empty() -> Self {
        Self {
            service: Mutex::new(None),
            initialization_error: Mutex::new(None),
        }
    }

    pub(crate) fn initialize(&self, database_path: PathBuf) {
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
    with_service(&state, |service| service.scan_source(&source_id))
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
    transition_job(&state, request, |queue, id| queue.start(id))
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
    transition_job(&state, request, |queue, id| queue.retry(id))
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
