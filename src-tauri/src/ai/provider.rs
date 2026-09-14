use std::{
    io::{BufRead, BufReader},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::tools::tool_schema;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRequest {
    pub prompt: String,
    pub system_prompt: String,
    pub context: String,
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub tool_results: Vec<AiToolResult>,
    #[serde(default)]
    pub previous_response_id: Option<String>,
    #[serde(default)]
    pub conversation: Vec<super::orchestrator::AiConversationMessage>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiToolResult {
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
    pub result: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum AiStreamEvent {
    TextDelta {
        text: String,
    },
    ToolRequest {
        call_id: String,
        name: String,
        arguments: Value,
    },
    ProposedChange {
        proposal_id: String,
        document_id: String,
        permission: String,
        expected_sha256: String,
        old_content: String,
        new_content: String,
    },
    WritebackStatus {
        proposal_id: String,
        document_id: String,
        status: String,
        message: String,
        code: Option<String>,
    },
    Completed {
        response_id: Option<String>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
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
    pub(crate) detail: Option<String>,
}

impl AiError {
    pub(crate) fn new(failure: AiFailure) -> Self {
        Self { failure, detail: None }
    }

    pub(crate) fn with_detail(failure: AiFailure, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            failure,
            detail: (!detail.trim().is_empty()).then_some(detail),
        }
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

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryCredentialStore {
    value: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
#[cfg(test)]
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

impl WindowsCredentialStore {
    pub(crate) fn has_api_key(&self) -> Result<bool, AiError> {
        Ok(self
            .read_api_key()?
            .is_some_and(|key| !key.trim().is_empty()))
    }

    pub(crate) fn save_api_key(&self, value: &str) -> Result<(), AiError> {
        #[cfg(windows)]
        {
            use std::mem::zeroed;
            use windows_sys::Win32::Security::Credentials::{
                CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredWriteW,
            };
            if value.trim().is_empty() {
                return Err(AiError::new(AiFailure::NoApiKey));
            }
            let target: Vec<u16> = self
                .target
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut blob = value.as_bytes().to_vec();
            let mut credential: CREDENTIALW = unsafe { zeroed() };
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = target.as_ptr() as *mut u16;
            credential.CredentialBlobSize = blob.len() as u32;
            credential.CredentialBlob = blob.as_mut_ptr();
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            let ok = unsafe { CredWriteW(&credential, 0) };
            if ok == 0 {
                return Err(AiError::new(AiFailure::Provider));
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = value;
            Err(AiError::new(AiFailure::Provider))
        }
    }

    pub(crate) fn delete_api_key(&self) -> Result<(), AiError> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Security::Credentials::{CRED_TYPE_GENERIC, CredDeleteW};
            let target: Vec<u16> = self
                .target
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
            if ok == 0 {
                // Deleting an already absent credential is an idempotent success.
                return Ok(());
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            Err(AiError::new(AiFailure::Provider))
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
    prefer_chat_completions: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AiBalanceSnapshot {
    pub(crate) balance: f64,
    pub(crate) currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AiModelProbe {
    pub(crate) supported: bool,
    pub(crate) model_found: Option<bool>,
    pub(crate) model_count: Option<usize>,
    pub(crate) latency_ms: u128,
}

impl<C: CredentialStore> OpenAiResponsesProvider<C> {
    pub(crate) fn new(credentials: C) -> Self {
        Self::new_with_config(credentials, "https://api.openai.com/v1", "gpt-5")
            .expect("default AI provider configuration must be valid")
    }

    pub(crate) fn new_with_config(
        credentials: C,
        base_url: &str,
        model: &str,
    ) -> Result<Self, AiError> {
        // reqwest uses rustls-no-provider to keep the desktop bundle small.
        // Register the bundled ring implementation before any Client is built;
        // otherwise reqwest's blocking runtime panics instead of returning an
        // ordinary connection error.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let endpoint = normalize_responses_endpoint(base_url)?;
        let normalized_base = base_url.trim().trim_end_matches('/').to_ascii_lowercase();
        let prefer_chat_completions = normalized_base.ends_with("/chat/completions");
        let model = model.trim();
        if model.is_empty() || model.len() > 120 {
            return Err(AiError::new(AiFailure::Provider));
        }
        Ok(Self {
            credentials,
            endpoint,
            model: model.to_owned(),
            // Reasoning models and relay providers may need several minutes for a
            // long document edit. Keep this above the renderer's client timeout.
            timeout: Duration::from_secs(180),
            prefer_chat_completions,
        })
    }

    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub(crate) fn probe_models(&self) -> Result<AiModelProbe, AiError> {
        let key = self
            .credentials
            .read_api_key()?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| AiError::new(AiFailure::NoApiKey))?;
        let endpoint = self.endpoint.trim_end_matches("/responses").to_owned() + "/models";
        let started_at = std::time::Instant::now();
        let response = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|_| AiError::new(AiFailure::Network))?
            .get(endpoint)
            .bearer_auth(&key)
            .header("accept", "application/json")
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
            return Err(AiError::with_detail(
                AiFailure::InvalidApiKey,
                response_detail(response),
            ));
        }
        if status.as_u16() == 429 {
            return Err(AiError::with_detail(
                AiFailure::RateLimited,
                response_detail(response),
            ));
        }
        if matches!(status.as_u16(), 404 | 405) {
            return Ok(AiModelProbe {
                supported: false,
                model_found: None,
                model_count: None,
                latency_ms: started_at.elapsed().as_millis(),
            });
        }
        if !status.is_success() {
            return Err(AiError::with_detail(
                AiFailure::Provider,
                response_detail(response),
            ));
        }
        let payload = response.json::<Value>().map_err(|_| {
            AiError::with_detail(AiFailure::Provider, "模型目录返回的不是有效 JSON")
        })?;
        let ids = payload
            .get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });
        let model_found = ids.as_ref().map(|items| items.iter().any(|id| id == &self.model));
        Ok(AiModelProbe {
            supported: true,
            model_found,
            model_count: ids.as_ref().map(Vec::len),
            latency_ms: started_at.elapsed().as_millis(),
        })
    }

    pub(crate) fn query_balance(
        &self,
        balance_url: &str,
    ) -> Result<Option<AiBalanceSnapshot>, AiError> {
        let value = balance_url.trim();
        let parsed = reqwest::Url::parse(value).map_err(|_| AiError::new(AiFailure::Provider))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(AiError::new(AiFailure::Provider));
        }
        let key = self
            .credentials
            .read_api_key()?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| AiError::new(AiFailure::NoApiKey))?;
        let response = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|_| AiError::new(AiFailure::Network))?
            .get(value)
            .bearer_auth(&key)
            .header("accept", "application/json")
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
            return Err(AiError::with_detail(
                AiFailure::Provider,
                response_detail(response),
            ));
        }
        let payload = response
            .json::<Value>()
            .map_err(|_| AiError::new(AiFailure::Provider))?;
        Ok(find_balance_snapshot(&payload))
    }

    fn chat_completions_endpoint(&self) -> String {
        self.endpoint.trim_end_matches("/responses").to_owned() + "/chat/completions"
    }

    fn stream_chat_completions(
        &self,
        key: &str,
        request: &AiRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
    ) -> Result<(), AiError> {
        let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
        messages.extend(request.conversation.iter().map(|message| {
            json!({ "role": message.role, "content": message.content })
        }));
        let user_content = format!("{}\n\n<context>{}</context>", request.prompt, request.context);
        messages.push(json!({ "role": "user", "content": user_content }));
        if !request.tool_results.is_empty() {
            messages.push(json!({
                "role": "assistant",
                "tool_calls": request.tool_results.iter().map(|tool| json!({
                    "id": tool.call_id,
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "arguments": tool.arguments.to_string()
                    }
                })).collect::<Vec<_>>()
            }));
            messages.extend(request.tool_results.iter().map(|tool| json!({
                "role": "tool",
                "tool_call_id": tool.call_id,
                "content": tool.result.to_string()
            })));
        }
        // Relay providers are far more consistent with non-streaming chat completions.
        // The desktop IPC returns a complete answer anyway, so an SSE connection adds no UX value here.
        let tools = request
            .allowed_tools
            .iter()
            .filter_map(|name| tool_schema(name).map(|parameters| json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": "受控文档工具。仅在用户明确要求时调用。",
                    "parameters": parameters
                }
            })))
            .collect::<Vec<_>>();
        let mut body = json!({ "model": self.model, "stream": false, "messages": messages });
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }
        let response = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|_| AiError::new(AiFailure::Network))?
            .post(self.chat_completions_endpoint())
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
            return Err(AiError::with_detail(
                AiFailure::Provider,
                response_detail(response),
            ));
        }
        let value = response.json::<Value>().map_err(|_| AiError::new(AiFailure::Provider))?;
        if cancellation.is_cancelled() {
            return Err(AiError::new(AiFailure::Cancelled));
        }
        let message = value
            .get("choices")
            .and_then(|items| items.get(0))
            .and_then(|item| item.get("message"));
        if let Some(tool_calls) = message
            .and_then(|item| item.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for tool_call in tool_calls {
                let function = tool_call.get("function");
                let arguments = function
                    .and_then(|item| item.get("arguments"))
                    .and_then(parse_tool_arguments)
                    .unwrap_or_else(|| json!({}));
                let name = function
                    .and_then(|item| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let call_id = tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("chat-call")
                    .to_owned();
                if !name.is_empty() {
                    sink(AiStreamEvent::ToolRequest {
                        call_id,
                        name: name.to_owned(),
                        arguments,
                    })?;
                }
            }
        }
        let text = extract_chat_text(&value);
        if text.trim().is_empty()
            && !message
                .and_then(|item| item.get("tool_calls"))
                .is_some_and(|calls| calls.as_array().is_some_and(|items| !items.is_empty()))
        {
            return Err(AiError::with_detail(
                AiFailure::Provider,
                response_shape_detail(&value, "Chat Completions"),
            ));
        }
        let usage = value.get("usage");
        if !text.trim().is_empty() {
            sink(AiStreamEvent::TextDelta { text: text.to_owned() })?;
        }
        sink(AiStreamEvent::Completed {
            response_id: value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some("chat-completion".to_owned())),
            input_tokens: usage.and_then(|item| item.get("prompt_tokens")).and_then(Value::as_u64),
            output_tokens: usage.and_then(|item| item.get("completion_tokens")).and_then(Value::as_u64),
        })?;
        Ok(())
    }
}

fn parse_tool_arguments(value: &Value) -> Option<Value> {
    match value {
        Value::Object(_) | Value::Array(_) => Some(value.clone()),
        Value::String(raw) => serde_json::from_str(raw).ok(),
        _ => None,
    }
}

fn response_detail(response: Response) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let excerpt = compact.chars().take(300).collect::<String>();
    if excerpt.is_empty() {
        format!("HTTP {}，服务商没有返回错误详情", status.as_u16())
    } else {
        format!("HTTP {}：{}", status.as_u16(), excerpt)
    }
}

fn extract_chat_text(value: &Value) -> String {
    let choice = value.get("choices").and_then(|items| items.get(0));
    let message = choice.and_then(|item| item.get("message"));
    let candidates = [
        message.and_then(|item| item.get("content")),
        message.and_then(|item| item.get("text")),
        choice.and_then(|item| item.get("text")),
        message.and_then(|item| item.get("reasoning_content")),
        message.and_then(|item| item.get("reasoning")),
        value.get("output_text"),
        value.get("response").and_then(|item| item.get("output_text")),
        value.get("output"),
        value.get("response").and_then(|item| item.get("output")),
    ];
    candidates
        .into_iter()
        .filter_map(|candidate| candidate.map(extract_text_value))
        .find(|text| !text.trim().is_empty())
        .unwrap_or_default()
}

fn extract_text_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_owned(),
        Value::Array(items) => items.iter().map(extract_text_value).collect(),
        Value::Object(object) => ["text", "value", "content", "output_text", "delta"]
            .iter()
            .find_map(|key| object.get(*key).map(extract_text_value))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn response_shape_detail(value: &Value, protocol: &str) -> String {
    let fields = value
        .as_object()
        .map(|object| {
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            keys.into_iter().take(12).collect::<Vec<_>>().join(", ")
        })
        .unwrap_or_else(|| "非对象 JSON".to_owned());
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .map(|items| items.len().to_string())
        .unwrap_or_else(|| "不存在".to_owned());
    format!("{protocol} 返回成功，但没有可显示的文本内容（顶层字段：{fields}；choices 数量：{choices}）")
}

fn emit_response_json_tool_calls(
    value: &Value,
    sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
) -> Result<bool, AiError> {
    let mut found = false;
    let output = value
        .get("output")
        .or_else(|| value.get("response").and_then(|item| item.get("output")));
    if let Some(items) = output.and_then(Value::as_array) {
        for item in items {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if !matches!(item_type, "function_call" | "tool_call") {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            found = true;
            let arguments = item
                .get("arguments")
                .and_then(parse_tool_arguments)
                .unwrap_or_else(|| json!({}));
            sink(AiStreamEvent::ToolRequest {
                call_id: item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("responses-call")
                    .to_owned(),
                name: name.to_owned(),
                arguments,
            })?;
        }
    }
    Ok(found)
}

fn find_balance_snapshot(value: &Value) -> Option<AiBalanceSnapshot> {
    if let Some(object) = value.as_object() {
        let amount = [
            "balance",
            "available_balance",
            "total_available",
            "remaining",
            "credit",
        ]
        .iter()
        .find_map(|key| object.get(*key).and_then(value_as_f64));
        if let Some(balance) = amount {
            let currency = ["currency", "currency_code", "unit"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str).map(str::to_owned));
            return Some(AiBalanceSnapshot { balance, currency });
        }
        for key in ["data", "result", "account", "usage"] {
            if let Some(snapshot) = object.get(key).and_then(find_balance_snapshot) {
                return Some(snapshot);
            }
        }
    }
    None
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
    })
}

fn normalize_responses_endpoint(base_url: &str) -> Result<String, AiError> {
    let value = base_url.trim().trim_end_matches('/');
    let base = value
        .strip_suffix("/responses")
        .or_else(|| value.strip_suffix("/chat/completions"))
        .or_else(|| value.strip_suffix("/models"))
        .unwrap_or(value);
    let parsed = reqwest::Url::parse(base).map_err(|_| AiError::new(AiFailure::Provider))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AiError::new(AiFailure::Provider));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AiError::with_detail(AiFailure::Provider, "Base URL 请只填写接口地址，不要附带 Key、查询参数或片段"));
    }
    let base = if parsed.path().trim_matches('/').is_empty() { format!("{base}/v1") } else { base.to_owned() };
    Ok(format!("{base}/responses"))
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
        if self.prefer_chat_completions {
            match self.stream_chat_completions(&key, request, cancellation, sink) {
                Err(error) if error.failure == AiFailure::Provider && error.detail.as_deref().is_some_and(|d| ["HTTP 404", "HTTP 405", "HTTP 415", "HTTP 501"].iter().any(|prefix| d.starts_with(prefix))) => {},
                result => return result,
            }
        }
        if cancellation.is_cancelled() { return Err(AiError::new(AiFailure::Cancelled)); }
        let mut input = if request.previous_response_id.is_some() {
            Vec::new()
        } else {
            let mut initial = vec![json!({ "role": "system", "content": request.system_prompt })];
            initial.extend(request.conversation.iter().map(|message| {
                json!({ "role": message.role, "content": message.content })
            }));
            initial.push(json!({ "role": "user", "content": format!("{}\n\n<document_context untrusted=\"true\">{}\n</document_context>", request.prompt, request.context) }));
            initial
        };
        input.extend(request.tool_results.iter().map(|tool| {
            json!({
                "type": "function_call_output",
                "call_id": tool.call_id,
                "output": tool.result.to_string(),
            })
        }));
        let mut body = json!({
            "model": self.model,
            "stream": true,
            "input": input,
            "tools": request.allowed_tools.iter().filter_map(|name| tool_schema(name).map(|parameters| json!({
                "type": "function", "name": name, "description": "受控文档工具", "strict": true, "parameters": parameters
            }))).collect::<Vec<_>>()
        });
        if let Some(previous_response_id) = &request.previous_response_id {
            body["previous_response_id"] = json!(previous_response_id);
        }
        let client = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|_| AiError::new(AiFailure::Network))?;
        let response = client
            .post(&self.endpoint)
            .bearer_auth(&key)
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
            if !self.prefer_chat_completions && matches!(status.as_u16(), 400 | 404 | 405 | 415 | 501) {
                return self.stream_chat_completions(&key, request, cancellation, sink);
            }
            return Err(AiError::with_detail(
                AiFailure::Provider,
                response_detail(response),
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.contains("text/event-stream") {
            let value = response
                .json::<Value>()
                .map_err(|_| AiError::with_detail(AiFailure::Provider, "Responses 返回成功，但响应不是有效 JSON"))?;
            if cancellation.is_cancelled() {
                return Err(AiError::new(AiFailure::Cancelled));
            }
            let has_tool_calls = emit_response_json_tool_calls(&value, sink)?;
            let text = extract_chat_text(&value);
            if text.trim().is_empty() && !has_tool_calls {
                return Err(AiError::with_detail(
                    AiFailure::Provider,
                    response_shape_detail(&value, "Responses"),
                ));
            }
            if !text.trim().is_empty() {
                sink(AiStreamEvent::TextDelta { text })?;
            }
            let usage = value
                .get("usage")
                .or_else(|| value.get("response").and_then(|item| item.get("usage")));
            sink(AiStreamEvent::Completed {
                response_id: value
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("response").and_then(|item| item.get("id")).and_then(Value::as_str))
                    .map(str::to_owned)
                    .or_else(|| Some("responses-completion".to_owned())),
                input_tokens: usage
                    .and_then(|item| item.get("input_tokens").or_else(|| item.get("prompt_tokens")))
                    .and_then(Value::as_u64),
                output_tokens: usage
                    .and_then(|item| item.get("output_tokens").or_else(|| item.get("completion_tokens")))
                    .and_then(Value::as_u64),
            })?;
            return Ok(());
        }
        let mut reader = BufReader::new(response);
        let mut line = String::new();
        let mut saw_event = false;
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
                    saw_event = true;
                    emit_sse_event(&value, sink)?;
                }
            }
            line.clear();
        }
        if !saw_event {
            return Err(AiError::with_detail(
                AiFailure::Provider,
                "Responses 返回成功，但没有收到可识别的 SSE 事件",
            ));
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
                response_id: value
                    .get("response")
                    .and_then(|response| response.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
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

#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) enum MockScenario {
    Success(Vec<AiStreamEvent>),
    Failure(AiFailure),
}

#[cfg(test)]
pub(crate) struct MockProvider {
    scenario: MockScenario,
}

#[cfg(test)]
impl MockProvider {
    pub(crate) fn new(scenario: MockScenario) -> Self {
        Self { scenario }
    }
}

#[cfg(test)]
impl AiProvider for MockProvider {
    fn stream(
        &self,
        request: &AiRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn FnMut(AiStreamEvent) -> Result<(), AiError>,
    ) -> Result<(), AiError> {
        if cancellation.is_cancelled() {
            return Err(AiError::new(AiFailure::Cancelled));
        }
        match &self.scenario {
            MockScenario::Failure(failure) => Err(AiError::new(*failure)),
            MockScenario::Success(events) => {
                if !request.tool_results.is_empty() {
                    sink(AiStreamEvent::Completed {
                        response_id: Some("mock-continuation".to_owned()),
                        input_tokens: None,
                        output_tokens: None,
                    })?;
                    return Ok(());
                }
                let mut completed = false;
                for event in events {
                    if cancellation.is_cancelled() {
                        return Err(AiError::new(AiFailure::Cancelled));
                    }
                    completed |= matches!(event, AiStreamEvent::Completed { .. });
                    sink(event.clone())?;
                }
                if !completed {
                    sink(AiStreamEvent::Completed {
                        response_id: Some("mock-initial".to_owned()),
                        input_tokens: None,
                        output_tokens: None,
                    })?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_events_match_frontend_wire_contract() {
        let events = vec![
            AiStreamEvent::TextDelta { text: "Ready".into() },
            AiStreamEvent::ToolRequest {
                call_id: "call-1".into(), name: "propose_edit".into(), arguments: json!({}),
            },
            AiStreamEvent::ProposedChange {
                proposal_id: "proposal-1".into(), document_id: "doc-ai".into(),
                permission: "autonomous".into(), expected_sha256: "hash-before".into(),
                old_content: "before".into(), new_content: "after".into(),
            },
            AiStreamEvent::WritebackStatus {
                proposal_id: "proposal-1".into(), document_id: "doc-ai".into(),
                status: "applied".into(), message: "Saved".into(), code: None,
            },
            AiStreamEvent::Completed {
                response_id: Some("response-1".into()), input_tokens: Some(12), output_tokens: Some(8),
            },
        ];
        let expected = json!([
            {"kind":"textDelta","text":"Ready"},
            {"kind":"toolRequest","callId":"call-1","name":"propose_edit","arguments":{}},
            {"kind":"proposedChange","proposalId":"proposal-1","documentId":"doc-ai","permission":"autonomous","expectedSha256":"hash-before","oldContent":"before","newContent":"after"},
            {"kind":"writebackStatus","proposalId":"proposal-1","documentId":"doc-ai","status":"applied","message":"Saved","code":null},
            {"kind":"completed","responseId":"response-1","inputTokens":12,"outputTokens":8}
        ]);
        assert_eq!(serde_json::to_value(events).unwrap(), expected);
    }

    fn request() -> AiRequest {
        AiRequest {
            prompt: "总结".to_owned(),
            system_prompt: "固定系统提示".to_owned(),
            context: "不可信正文".to_owned(),
            allowed_tools: vec![],
            tool_results: vec![],
            previous_response_id: None,
            conversation: vec![],
        }
    }

    #[test]
    fn balance_parser_accepts_common_relay_shapes_without_guessing_unknown_values() {
        assert_eq!(
            find_balance_snapshot(&json!({"data": {"balance": "12.50", "currency": "USD"}})),
            Some(AiBalanceSnapshot {
                balance: 12.5,
                currency: Some("USD".to_owned())
            })
        );
        assert_eq!(
            find_balance_snapshot(&json!({"usage": {"total": 12}})),
            None
        );
    }

    #[test]
    fn mock_streams_text_and_completion_without_exposing_context() {
        let provider = MockProvider::new(MockScenario::Success(vec![
            AiStreamEvent::TextDelta {
                text: "好".to_owned(),
            },
            AiStreamEvent::Completed {
                response_id: Some("mock-initial".to_owned()),
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

    fn relay_roundtrip(base_suffix: &str, replies: Vec<(&'static str, u16, &'static str)>) -> Result<(), AiError> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for (path, status, payload) in replies {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    if let Ok((stream, _)) = listener.accept() { break stream; }
                    assert!(start.elapsed() < Duration::from_secs(5), "expected relay request");
                    std::thread::sleep(Duration::from_millis(10));
                };
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new(); reader.read_line(&mut first).unwrap();
                assert!(first.starts_with(&format!("POST {path} ")), "unexpected endpoint");
                let mut length = 0;
                loop {
                    let mut line = String::new(); reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().unwrap(); }
                }
                let mut bytes = vec![0; length]; reader.read_exact(&mut bytes).unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["model"], "relay-model");
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
            }
        });
        let credentials = MemoryCredentialStore { value: std::sync::Mutex::new(Some("local-test-key".into())) };
        let provider = OpenAiResponsesProvider::new_with_config(credentials, &format!("http://{address}{base_suffix}"), "relay-model").unwrap().with_timeout(Duration::from_secs(3));
        let mut output = String::new();
        let result = provider.stream(&request(), &CancellationToken::default(), &mut |event| { if let AiStreamEvent::TextDelta { text } = event { output.push_str(&text); } Ok(()) });
        server.join().unwrap();
        if result.is_ok() { assert_eq!(output, "ok"); }
        result
    }

    #[test]
    fn relay_supports_responses_only_and_chat_only() {
        relay_roundtrip("/v1", vec![("/v1/responses", 200, r#"{"output_text":"ok"}"#)]).unwrap();
        relay_roundtrip("/v1", vec![("/v1/responses", 404, "{}"), ("/v1/chat/completions", 200, r#"{"choices":[{"message":{"content":"ok"}}]}"#)]).unwrap();
        relay_roundtrip("/v1/chat/completions", vec![("/v1/chat/completions", 405, "{}"), ("/v1/responses", 200, r#"{"output_text":"ok"}"#)]).unwrap();
    }

    #[test]
    fn relay_does_not_retry_invalid_key_or_rate_limit() {
        assert_eq!(relay_roundtrip("/v1", vec![("/v1/responses",401,"{}")]).unwrap_err().failure, AiFailure::InvalidApiKey);
        assert_eq!(relay_roundtrip("/v1", vec![("/v1/responses",429,"{}")]).unwrap_err().failure, AiFailure::RateLimited);
    }

    #[test]
    fn normalizes_common_full_endpoint_inputs_without_duplicate_paths() {
        assert_eq!(normalize_responses_endpoint("https://relay.example/").unwrap(), "https://relay.example/v1/responses");
        assert_eq!(normalize_responses_endpoint("https://relay.example/api/v2").unwrap(), "https://relay.example/api/v2/responses");
        assert!(normalize_responses_endpoint("https://relay.example/v1?key=secret").is_err());
        assert_eq!(
            normalize_responses_endpoint("https://relay.example/v1/chat/completions").unwrap(),
            "https://relay.example/v1/responses"
        );
        assert_eq!(
            normalize_responses_endpoint("https://relay.example/v1/models").unwrap(),
            "https://relay.example/v1/responses"
        );
    }

    #[test]
    fn accepts_string_array_and_reasoning_chat_content() {
        assert_eq!(
            extract_chat_text(&json!({"choices":[{"message":{"content":"你好"}}]})),
            "你好"
        );
        assert_eq!(
            extract_chat_text(&json!({"choices":[{"message":{"content":[{"type":"text","text":"好"},{"text":"的"}]}}]})),
            "好的"
        );
        assert_eq!(
            extract_chat_text(&json!({"choices":[{"message":{"reasoning_content":"连接成功"}}]})),
            "连接成功"
        );
        assert_eq!(
            extract_chat_text(&json!({"choices":[{"text":"兼容旧版文本字段"}]})),
            "兼容旧版文本字段"
        );
        assert_eq!(
            extract_chat_text(&json!({"choices":[{"message":{"content":{"text":"对象文本"}}}]})),
            "对象文本"
        );
        assert_eq!(
            extract_chat_text(&json!({"output_text":"顶层文本"})),
            "顶层文本"
        );
        assert_eq!(
            extract_chat_text(&json!({"output":[{"type":"message","content":[{"type":"output_text","text":"Responses 文本"}]}]})),
            "Responses 文本"
        );
    }

    #[test]
    fn response_shape_diagnostic_contains_only_safe_structure_metadata() {
        let detail = response_shape_detail(
            &json!({"id":"resp-secret-like", "choices":[{"message":{"role":"assistant"}}], "api_key":"must-not-leak"}),
            "Chat Completions",
        );
        assert!(detail.contains("顶层字段"));
        assert!(detail.contains("choices 数量：1"));
        assert!(!detail.contains("resp-secret-like"));
        assert!(!detail.contains("must-not-leak"));
    }

    #[test]
    fn parses_tool_arguments_from_string_or_native_json() {
        assert_eq!(
            parse_tool_arguments(&json!(r#"{"documentId":"doc-1"}"#)),
            Some(json!({"documentId": "doc-1"}))
        );
        assert_eq!(
            parse_tool_arguments(&json!({"documentId": "doc-1"})),
            Some(json!({"documentId": "doc-1"}))
        );
        assert_eq!(parse_tool_arguments(&Value::Null), None);
    }
}
