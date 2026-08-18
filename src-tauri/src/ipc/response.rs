use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IpcResponse<T> {
    Success { data: T },
    Error { error: IpcError },
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl<T> IpcResponse<T> {
    pub fn success(data: T) -> Self {
        Self::Success { data }
    }

    #[allow(dead_code)]
    pub fn error(error: IpcError) -> Self {
        Self::Error { error }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{IpcError, IpcResponse};

    #[test]
    fn serializes_success_with_explicit_status() {
        let response = IpcResponse::success(json!({ "value": 42 }));

        assert_eq!(
            serde_json::to_value(response).expect("response should serialize"),
            json!({ "status": "success", "data": { "value": 42 } })
        );
    }

    #[test]
    fn serializes_error_with_stable_shape() {
        let response: IpcResponse<Value> = IpcResponse::error(IpcError {
            code: "BACKEND_UNAVAILABLE".to_owned(),
            message: "backend is unavailable".to_owned(),
            retryable: true,
            details: None,
        });

        assert_eq!(
            serde_json::to_value(response).expect("response should serialize"),
            json!({
                "status": "error",
                "error": {
                    "code": "BACKEND_UNAVAILABLE",
                    "message": "backend is unavailable",
                    "retryable": true,
                    "details": null
                }
            })
        );
    }
}
