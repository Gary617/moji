use std::{
    io::{BufRead, BufReader},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRequest {
    pub prompt: String,
    pub system_prompt: String,
    pub context: String,
    pub allowed_tools: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AiStreamEvent {
    TextDelta {
        text: String,
    },
    ToolRequest {
        call_id: String,
        name: String,
        arguments: Value,
    },
    Completed {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiFailure {
    NoApiKey,
    InvalidApiKey,
    Timeout,
    RateLimited,
    Network,
    Cancelled,
    ToolDenied,
    Provider,
}

impl AiFailure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NoApiKey => "AI_NO_API_KEY",
            Self::InvalidApiKey => "AI_INVALID_API_KEY",
            Self::Timeout => "AI_TIMEOUT",
            Self::RateLimited => "AI_RATE_LIMITED",
            Self::Network => "AI_NETWORK",
            Self::Cancelled => "AI_CANCELLED",
            Self::ToolDenied => "AI_TOOL_DENIED",
            Self::Provider => "AI_PROVIDER_ERROR",
        }
    }

    pub(crate) fn retryable(self) -> bool {
        matches!(
            self,
            Self::Timeout | Self::RateLimited | Self::Network | Self::Provider
        )
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AiError {
    pub(crate) failure: AiFailure,
}

impl AiError {
    pub(crate) fn new(failure: AiFailure) -> Self {
        Self { failure }
    }
}

#[derive(Clone, Default)]
pub(crate) struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub(crate) trait AiProvider: Send + Sync {
    fn stream(
        &self,
        request: &AiRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
    ) -> Result<(), AiError>;
}

pub(crate) trait CredentialStore: Send + Sync {
    fn read_api_key(&self) -> Result<Option<String>, AiError>;
}

#[derive(Default)]
pub(crate) struct MemoryCredentialStore {
    value: std::sync::Mutex<Option<String>>,
}

impl MemoryCredentialStore {
    #[cfg(test)]
    pub(crate) fn with_key(key: &str) -> Self {
        Self {
            value: std::sync::Mutex::new(Some(key.to_owned())),
        }
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn read_api_key(&self) -> Result<Option<String>, AiError> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|_| AiError::new(AiFailure::Provider))
    }
}

pub(crate) struct WindowsCredentialStore {
    target: String,
}

impl Default for WindowsCredentialStore {
    fn default() -> Self {
        Self {
            target: "moji/openai/api-key".to_owned(),
        }
    }
}

impl CredentialStore for WindowsCredentialStore {
    #[cfg(windows)]
    fn read_api_key(&self) -> Result<Option<String>, AiError> {
        use std::ptr;
        use windows_sys::Win32::Security::Credentials::{
            CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
        };

        let target: Vec<u16> = self
            .target
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut credential: *mut CREDENTIALW = ptr::null_mut();
        // The Windows API allocates the credential; it is freed before returning and never logged.
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if ok == 0 || credential.is_null() {
            return Ok(None);
        }
        let result = unsafe {
            let item = &*credential;
            if item.CredentialBlob.is_null() || item.CredentialBlobSize == 0 {
                None
            } else {
                let bytes = std::slice::from_raw_parts(
                    item.CredentialBlob,
                    item.CredentialBlobSize as usize,
                );
                String::from_utf8(bytes.to_vec()).ok()
            }
        };
        unsafe { CredFree(credential.cast()) };
        Ok(result)
    }

    #[cfg(not(windows))]
    fn read_api_key(&self) -> Result<Option<String>, AiError> {
        let _ = &self.target;
        Ok(None)
    }
}

pub(crate) struct OpenAiResponsesProvider<C: CredentialStore> {
    credentials: C,
    endpoint: String,
    model: String,
    timeout: Duration,
}

impl<C: CredentialStore> OpenAiResponsesProvider<C> {
    pub(crate) fn new(credentials: C) -> Self {
        Self {
            credentials,
            endpoint: "https://api.openai.com/v1/responses".to_owned(),
            model: "gpt-5".to_owned(),
            timeout: Duration::from_secs(30),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_endpoint(mut self, endpoint: &str) -> Self {
        self.endpoint = endpoint.to_owned();
        self
    }
}

impl<C: CredentialStore> AiProvider for OpenAiResponsesProvider<C> {
    fn stream(
        &self,
        request: &AiRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
    ) -> Result<(), AiError> {
        let key = self
            .credentials
            .read_api_key()?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| AiError::new(AiFailure::NoApiKey))?;
        if cancellation.is_cancelled() {
            return Err(AiError::new(AiFailure::Cancelled));
        }
        let body = json!({
            "model": self.model,
            "stream": true,
            "input": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": format!("{}\n\n<document_context untrusted=\"true\">{}\n</document_context>", request.prompt, request.context) }
            ],
            "tools": request.allowed_tools.iter().map(|name| json!({
                "type": "function", "name": name, "description": "受控文档工具", "parameters": {"type":"object"}
            })).collect::<Vec<_>>()
        });
        let client = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|_| AiError::new(AiFailure::Network))?;
        let response = client
            .post(&self.endpoint)
            .bearer_auth(key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    AiError::new(AiFailure::Timeout)
                } else {
                    AiError::new(AiFailure::Network)
                }
            })?;
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AiError::new(AiFailure::InvalidApiKey));
        }
        if status.as_u16() == 429 {
            return Err(AiError::new(AiFailure::RateLimited));
        }
        if !status.is_success() {
            return Err(AiError::new(AiFailure::Provider));
        }
        let mut reader = BufReader::new(response);
        let mut line = String::new();
        while reader
            .read_line(&mut line)
            .map_err(|_| AiError::new(AiFailure::Network))?
            > 0
        {
            if cancellation.is_cancelled() {
                return Err(AiError::new(AiFailure::Cancelled));
            }
            if let Some(data) = line.strip_prefix("data:").map(str::trim) {
                if data == "[DONE]" {
                    break;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    emit_sse_event(&value, sink)?;
                }
            }
            line.clear();
        }
        Ok(())
    }
}

fn emit_sse_event(
    value: &Value,
    sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
) -> Result<(), AiError> {
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" => {
            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                sink(AiStreamEvent::TextDelta {
                    text: text.to_owned(),
                })?;
            }
        }
        "response.function_call_arguments.done" => {
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| json!({}));
            sink(AiStreamEvent::ToolRequest {
                call_id: value
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                name: value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                arguments,
            })?;
        }
        "response.completed" => {
            let usage = value
                .get("response")
                .and_then(|response| response.get("usage"));
            sink(AiStreamEvent::Completed {
                input_tokens: usage
                    .and_then(|item| item.get("input_tokens"))
                    .and_then(Value::as_u64),
                output_tokens: usage
                    .and_then(|item| item.get("output_tokens"))
                    .and_then(Value::as_u64),
            })?;
        }
        _ => {}
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) enum MockScenario {
    Success(Vec<AiStreamEvent>),
    Failure(AiFailure),
}

pub(crate) struct MockProvider {
    scenario: MockScenario,
}

impl MockProvider {
    pub(crate) fn new(scenario: MockScenario) -> Self {
        Self { scenario }
    }
}

impl AiProvider for MockProvider {
    fn stream(
        &self,
        _request: &AiRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
    ) -> Result<(), AiError> {
        if cancellation.is_cancelled() {
            return Err(AiError::new(AiFailure::Cancelled));
        }
        match &self.scenario {
            MockScenario::Failure(failure) => Err(AiError::new(*failure)),
            MockScenario::Success(events) => {
                for event in events {
                    if cancellation.is_cancelled() {
                        return Err(AiError::new(AiFailure::Cancelled));
                    }
                    sink(event.clone())?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AiRequest {
        AiRequest {
            prompt: "总结".to_owned(),
            system_prompt: "固定系统提示".to_owned(),
            context: "不可信正文".to_owned(),
            allowed_tools: vec![],
        }
    }

    #[test]
    fn mock_streams_text_and_completion_without_exposing_context() {
        let provider = MockProvider::new(MockScenario::Success(vec![
            AiStreamEvent::TextDelta {
                text: "好".to_owned(),
            },
            AiStreamEvent::Completed {
                input_tokens: Some(2),
                output_tokens: Some(1),
            },
        ]));
        let mut events = Vec::new();
        provider
            .stream(&request(), &CancellationToken::default(), &mut |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(
            !serde_json::to_string(&events)
                .unwrap()
                .contains("不可信正文")
        );
    }

    #[test]
    fn mock_cancellation_and_failures_are_structured() {
        let token = CancellationToken::default();
        token.cancel();
        let provider = MockProvider::new(MockScenario::Success(vec![]));
        assert_eq!(
            provider
                .stream(&request(), &token, &mut |_| Ok(()))
                .unwrap_err()
                .failure,
            AiFailure::Cancelled
        );
        for failure in [
            AiFailure::NoApiKey,
            AiFailure::Timeout,
            AiFailure::RateLimited,
            AiFailure::Network,
        ] {
            let provider = MockProvider::new(MockScenario::Failure(failure));
            assert_eq!(
                provider
                    .stream(&request(), &CancellationToken::default(), &mut |_| Ok(()))
                    .unwrap_err()
                    .failure,
                failure
            );
        }
    }

    #[test]
    fn openai_provider_without_credential_fails_without_network_or_secret_output() {
        let provider = OpenAiResponsesProvider::new(MemoryCredentialStore::default());
        let error = provider
            .stream(&request(), &CancellationToken::default(), &mut |_| Ok(()))
            .unwrap_err();
        assert_eq!(error.failure, AiFailure::NoApiKey);
        assert!(!error.failure.code().contains("sk-"));
    }
}
