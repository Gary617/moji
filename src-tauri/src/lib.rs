mod ai;
mod crypto;
mod ipc;
mod library;
mod logging;

use tauri::Manager;

#[cfg(windows)]
fn acquire_single_instance() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Local\\MojiDesktop.SingleInstance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        None
    } else {
        Some(handle)
    }
}

pub fn run() {
    // reqwest is intentionally built without an implicit TLS provider so the
    // desktop binary does not depend on aws-lc/NASM. Register ring once before
    // any blocking HTTPS client is constructed; otherwise rustls panics at
    // runtime with a missing process-level CryptoProvider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(windows)]
    let _single_instance = match acquire_single_instance() {
        Some(handle) => handle,
        None => {
            eprintln!("墨集已经在运行，跳过重复启动");
            return;
        }
    };
    logging::init();
    tracing::info!(
        event = "application_started",
        application = "moji-desktop",
        version = env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ipc::library::LibraryState::empty())
        .setup(|app| {
            // Always open the desktop workspace at a usable desktop size. A
            // previous narrow window state must not force the responsive
            // mobile layout on the desktop application.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("app data directory is unavailable: {error}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|error| format!("app data directory could not be created: {error}"))?;
            let database_path = app_data_dir.join("library.sqlite3");
            app.manage(ipc::workbench::WorkbenchStorageState::new(
                app_data_dir.join("workbench.json"),
            ));
            let app_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("moji-library-init".to_owned())
                .spawn(move || {
                    app_handle
                        .state::<ipc::library::LibraryState>()
                        .initialize(database_path);
                })
                .map_err(|error| {
                    format!("library initialization thread could not start: {error}")
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::music::music_status,
            ipc::music::music_control,
            ipc::music::music_open,
            ipc::health::health_check,
            ipc::library::library_pick_source_folder,
            ipc::library::library_pick_source_file,
            ipc::library::library_scan_common_locations,
            ipc::library::library_preview_common_locations,
            ipc::library::library_preview_full_disk,
            ipc::library::library_start_selected_scan,
            ipc::library::library_start_scan,
            ipc::library::library_scan_status,
            ipc::library::library_scan_events,
            ipc::library::library_pause_scan,
            ipc::library::library_resume_scan,
            ipc::library::library_cancel_scan,
            ipc::library::library_retry_scan,
            ipc::library::library_start_watch,
            ipc::library::library_poll_watch,
            ipc::library::library_search,
            ipc::library::library_list_sources,
            ipc::library::library_list_collections,
            ipc::library::library_list_tags,
            ipc::library::library_create_collection,
            ipc::library::library_create_tag,
            ipc::library::library_set_collection_membership,
            ipc::library::library_set_tag_membership,
            ipc::library::library_set_favorite,
            ipc::library::library_remove_document,
            ipc::library::library_record_recent_use,
            ipc::library::library_ocr_model_status,
            ipc::library::library_start_ocr,
            ipc::library::library_ocr_status,
            ipc::library::library_pause_ocr,
            ipc::library::library_resume_ocr,
            ipc::library::library_cancel_ocr,
            ipc::library::library_retry_ocr,
            ipc::library::library_document_fragments,
            ipc::library::document_open,
            ipc::library::document_open_external,
            ipc::library::document_save,
            ipc::library::document_save_binary,
            ipc::library::document_save_as,
            ipc::library::document_close,
            ipc::library::document_list_snapshots,
            ipc::library::document_restore_snapshot,
            ipc::library::document_list_annotations,
            ipc::library::document_add_annotation,
            ipc::library::document_delete_annotation,
            ipc::library::ai_context_preview,
            ipc::library::ai_chat,
            ipc::library::ai_chat_stream,
            ipc::library::ai_cancel,
            ipc::library::ai_apply_change,
            ipc::library::ai_reject_change,
            ipc::library::ai_list_actions,
            ipc::workbench::workbench_load_state,
            ipc::workbench::workbench_list_backups,
            ipc::workbench::workbench_restore_backup,
            ipc::workbench::workbench_save_state,
            ipc::workbench::workbench_agent_commit_state,
            ipc::workbench::workbench_ai_assist,
            ipc::workbench::workbench_ai_cancel,
            ipc::workbench::workbench_ai_research,
            ipc::workbench::workbench_ai_validate_goal_answer,
            ipc::workbench::workbench_ai_credentials_status,
            ipc::workbench::workbench_ai_save_credentials,
            ipc::workbench::workbench_ai_clear_credentials,
            ipc::workbench::workbench_ai_test_connection,
            ipc::workbench::workbench_ai_balance,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Tauri application");
}
