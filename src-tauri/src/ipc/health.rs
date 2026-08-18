use serde::{Deserialize, Serialize};

use super::response::IpcResponse;

pub const IPC_PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckData {
    pub backend_status: String,
    pub app_version: String,
    pub protocol_version: u8,
}

#[tauri::command]
pub fn health_check() -> IpcResponse<HealthCheckData> {
    let response = IpcResponse::success(HealthCheckData {
        backend_status: "ok".to_owned(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_version: IPC_PROTOCOL_VERSION,
    });

    tracing::info!(
        event = "ipc_command_completed",
        command = "health_check",
        outcome = "success"
    );

    response
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::health_check;

    #[test]
    fn reports_backend_health_and_application_version() {
        assert_eq!(
            serde_json::to_value(health_check()).expect("health response should serialize"),
            json!({
                "status": "success",
                "data": {
                    "backendStatus": "ok",
                    "appVersion": "0.1.0",
                    "protocolVersion": 1
                }
            })
        );
    }
}
