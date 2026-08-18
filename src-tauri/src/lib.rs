mod ipc;
mod library;
mod logging;

use tauri::Manager;

pub fn run() {
    logging::init();
    tracing::info!(
        event = "application_started",
        application = "moji-desktop",
        version = env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .manage(ipc::library::LibraryState::empty())
        .setup(|app| {
            let state = app.state::<ipc::library::LibraryState>();
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("app data directory is unavailable: {error}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|error| format!("app data directory could not be created: {error}"))?;
            state.initialize(app_data_dir.join("library.sqlite3"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::health::health_check,
            ipc::library::library_register_source,
            ipc::library::library_start_scan,
            ipc::library::library_scan_status,
            ipc::library::library_pause_scan,
            ipc::library::library_resume_scan,
            ipc::library::library_cancel_scan,
            ipc::library::library_retry_scan,
            ipc::library::library_start_watch,
            ipc::library::library_poll_watch
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Tauri application");
}
