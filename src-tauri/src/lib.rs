mod ipc;
mod logging;

pub fn run() {
    logging::init();
    tracing::info!(
        event = "application_started",
        application = "moji-desktop",
        version = env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ipc::health::health_check])
        .run(tauri::generate_context!())
        .expect("failed to run the Tauri application");
}
