use std::{collections::HashMap, fs, path::PathBuf, sync::{Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};

use reqwest::{Url, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{ipc::Channel, State};

use crate::ai::provider::{
    AiProvider, AiRequest, AiStreamEvent, CancellationToken, OpenAiResponsesProvider,
    WindowsCredentialStore,
};
use crate::ai::workbench_skills::{ids as skill_ids, route as route_skills, system_instructions};
use crate::ai::workbench_tools;
use crate::ai::provider::AiToolResult;
use crate::ai::tools::{allowed_tools, AiPermission};

use super::response::{IpcError, IpcResponse};

const MAX_STATE_BYTES: usize = 5 * 1024 * 1024;

pub(crate) struct WorkbenchStorageState {
    path: PathBuf,
    active_ai_sessions: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl WorkbenchStorageState {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path, active_ai_sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    fn start_ai_session(&self, session_id: &str) -> Result<CancellationToken, IpcError> {
        if session_id.trim().is_empty() || session_id.len() > 128 {
            return Err(storage_error("WORKBENCH_AI_SESSION_INVALID", "AI 会话标识无效", false));
        }
        let token = CancellationToken::default();
        let mut sessions = self.active_ai_sessions.lock().map_err(|_| storage_error("WORKBENCH_AI_SESSION_STATE", "AI 会话状态不可用", true))?;
        if sessions.contains_key(session_id) {
            return Err(storage_error("WORKBENCH_AI_SESSION_ACTIVE", "该 AI 会话仍在运行", false));
        }
        sessions.insert(session_id.to_owned(), token.clone());
        Ok(token)
    }

    fn finish_ai_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.active_ai_sessions.lock() { sessions.remove(session_id); }
    }

    fn cancel_ai_session(&self, session_id: &str) -> bool {
        let token = self.active_ai_sessions.lock().ok().and_then(|sessions| sessions.get(session_id).cloned()).filter(|token| !token.is_cancelled());
        let Some(token) = token else { return false; };
        token.cancel();
        true
    }

    /// Resolve the provider configuration shared by the workbench and the
    /// document assistant. Missing or legacy state deliberately falls back to
    /// the provider defaults at the call site.
    pub(crate) fn ai_config(&self) -> Option<WorkbenchAiConfigRequest> {
        read_state(&self.path)
            .ok()
            .flatten()
            .and_then(|state| serde_json::from_value(state.get("preferences")?.get("aiConfig")?.clone()).ok())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchSaveRequest {
    state: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAgentCommitRequest {
    expected_state: Value,
    next_state: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchSaveResult {
    saved: bool,
    byte_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiRequest {
    prompt: String,
    context: Value,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    agent_run_id: Option<String>,
    #[serde(default)]
    snapshot_version: Option<String>,
    #[serde(default)]
    config: Option<WorkbenchAiConfigRequest>,
    #[serde(default)]
    permission: Option<AiPermission>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiConfigRequest {
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default)]
    balance_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiCredentialStatus {
    configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiCredentialRequest {
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiConnectionResult {
    model: String,
    protocol: String,
    latency_ms: u128,
    reply: String,
    model_directory_supported: bool,
    model_found: Option<bool>,
    model_count: Option<usize>,
    model_probe_latency_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiResult {
    text: String,
    model: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    skills: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiResearchRequest {
    query: String,
    details: Option<WorkbenchAiResearchDetails>,
    config: WorkbenchAiConfigRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiResearchDetails {
    kind: String,
    target_date: String,
    days_remaining: i64,
    progress: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiGoalAnswerValidationRequest {
    goal_title: String,
    question_key: String,
    question: String,
    answer: String,
    config: WorkbenchAiConfigRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiGoalAnswerValidationResult {
    accepted: bool,
    normalized: String,
    reason: String,
    confidence: u8,
    model: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    skills: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiResearchSource {
    title: String,
    url: String,
    snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiResearchResult {
    interpretation: String,
    summary: String,
    question: Option<String>,
    needs_confirmation: bool,
    suggested_outcome: Option<String>,
    suggested_dimensions: Vec<String>,
    sources: Vec<WorkbenchAiResearchSource>,
    model: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    skills: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiBalanceResult {
    supported: bool,
    balance: Option<f64>,
    currency: Option<String>,
    message: String,
}

fn storage_error(code: &str, message: impl Into<String>, retryable: bool) -> IpcError {
    IpcError {
        code: code.to_owned(),
        message: message.into(),
        retryable,
        details: None,
    }
}

fn ai_error(error: crate::ai::provider::AiError, action: &str) -> IpcError {
    let message = match error.failure {
        crate::ai::provider::AiFailure::NoApiKey => {
            "尚未配置 API Key，请在右上角 AI 配置中填写并保存"
        }
        crate::ai::provider::AiFailure::InvalidApiKey => "API Key 无效，或无权访问当前模型",
        crate::ai::provider::AiFailure::Timeout => "中转站响应超时，请稍后重试",
        crate::ai::provider::AiFailure::RateLimited => "请求过于频繁或额度不足，请检查中转站账户",
        crate::ai::provider::AiFailure::Network => "无法连接中转站，请检查地址和网络",
        crate::ai::provider::AiFailure::Cancelled => "AI 请求已取消",
        crate::ai::provider::AiFailure::ToolDenied => "AI 请求了未授权的操作",
        crate::ai::provider::AiFailure::Provider => {
            "中转站返回了不兼容的响应，请确认模型及 Responses API 地址"
        }
    };
    let detail = error.detail.clone();
    IpcError {
        code: error.failure.code().to_owned(),
        message: match detail.as_deref() {
            Some(detail) => format!("{action}：{message}（{detail}）"),
            None => format!("{action}：{message}"),
        },
        retryable: error.failure.retryable(),
        details: detail.map(|detail| json!({ "diagnostic": detail })),
    }
}

fn research_error(code: &str, message: &str, retryable: bool) -> IpcError {
    storage_error(code, message, retryable)
}

fn decode_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn strip_html(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    decode_html(output.trim()).trim().to_owned()
}

fn extract_attribute(tag: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')? + start;
    Some(decode_html(&tag[start..end]))
}

fn search_web_duckduckgo(query: &str) -> Result<Vec<WorkbenchAiResearchSource>, IpcError> {
    let url = Url::parse_with_params("https://html.duckduckgo.com/html/", [("q", query)])
        .map_err(|_| research_error("AI_RESEARCH_INVALID_QUERY", "在线研究查询无效", false))?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Moji Desktop online research")
        .build()
        .map_err(|_| research_error("AI_RESEARCH_NETWORK", "无法建立在线搜索连接", true))?
        .get(url)
        .send()
        .map_err(|_| {
            research_error(
                "AI_RESEARCH_NETWORK",
                "无法连接在线搜索服务，请检查网络",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(research_error(
            "AI_RESEARCH_NETWORK",
            "在线搜索服务暂时不可用",
            true,
        ));
    }
    let html = response
        .text()
        .map_err(|_| research_error("AI_RESEARCH_NETWORK", "无法读取在线搜索结果", true))?;
    let mut sources = Vec::new();
    let mut cursor = 0;
    while sources.len() < 6 {
        let Some(relative) = html[cursor..].find("class=\"result__a\"") else {
            break;
        };
        let class_start = cursor + relative;
        let anchor_start = html[..class_start].rfind("<a ").unwrap_or(class_start);
        let Some(tag_end_relative) = html[class_start..].find('>') else {
            break;
        };
        let tag_end = class_start + tag_end_relative;
        let Some(close_relative) = html[tag_end..].find("</a>") else {
            break;
        };
        let close = tag_end + close_relative;
        let title = strip_html(&html[tag_end + 1..close]);
        let href = extract_attribute(&html[anchor_start..tag_end], "href").unwrap_or_default();
        let url = if let Ok(parsed) = Url::parse(&href) {
            parsed
                .query_pairs()
                .find_map(|(key, value)| (key == "uddg").then(|| value.into_owned()))
                .unwrap_or(href)
        } else {
            href
        };
        let valid_url = Url::parse(&url)
            .ok()
            .is_some_and(|item| matches!(item.scheme(), "http" | "https"));
        if title.is_empty() || url.is_empty() || !valid_url {
            cursor = close + 4;
            continue;
        }
        let snippet_start = html[close + 4..]
            .find("class=\"result__snippet\"")
            .map(|offset| close + 4 + offset);
        let snippet = snippet_start
            .and_then(|start| {
                let tag_end = start + html[start..].find('>')?;
                let close = tag_end
                    + html[tag_end..]
                        .find("</a>")
                        .or_else(|| html[tag_end..].find("</div>"))?;
                Some(
                    strip_html(&html[tag_end + 1..close])
                        .chars()
                        .take(600)
                        .collect(),
                )
            })
            .unwrap_or_default();
        sources.push(WorkbenchAiResearchSource {
            title,
            url,
            snippet,
        });
        cursor = close + 4;
    }
    if sources.is_empty() {
        return Err(research_error(
            "AI_RESEARCH_NO_RESULTS",
            "在线搜索没有返回可用资料",
            true,
        ));
    }
    Ok(sources)
}

fn rss_field(item: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let start = item.find(&start_tag)? + start_tag.len();
    let end = item[start..].find(&end_tag)? + start;
    Some(decode_html(&item[start..end]).trim().to_owned())
}

fn search_web_bing_rss(query: &str) -> Result<Vec<WorkbenchAiResearchSource>, IpcError> {
    let url = Url::parse_with_params(
        "https://www.bing.com/search",
        [("format", "rss"), ("q", query)],
    )
    .map_err(|_| research_error("AI_RESEARCH_INVALID_QUERY", "在线研究查询无效", false))?;
    let response = Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Moji Desktop online research")
        .build()
        .map_err(|_| research_error("AI_RESEARCH_NETWORK", "无法建立备用搜索连接", true))?
        .get(url)
        .send()
        .map_err(|_| {
            research_error(
                "AI_RESEARCH_NETWORK",
                "无法连接备用搜索服务，请检查网络",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(research_error(
            "AI_RESEARCH_NETWORK",
            "备用搜索服务暂时不可用",
            true,
        ));
    }
    let xml = response
        .text()
        .map_err(|_| research_error("AI_RESEARCH_NETWORK", "无法读取备用搜索结果", true))?;
    let mut sources = Vec::new();
    for item in xml.split("<item>").skip(1).take(6) {
        let title = rss_field(item, "title").unwrap_or_default();
        let url = rss_field(item, "link").unwrap_or_default();
        let snippet = rss_field(item, "description").unwrap_or_default();
        let valid_url = Url::parse(&url)
            .ok()
            .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"));
        if !title.is_empty() && valid_url {
            sources.push(WorkbenchAiResearchSource {
                title,
                url,
                snippet: snippet.chars().take(600).collect(),
            });
        }
    }
    if sources.is_empty() {
        return Err(research_error(
            "AI_RESEARCH_NO_RESULTS",
            "备用搜索没有返回可用资料",
            true,
        ));
    }
    Ok(sources)
}

fn search_web(query: &str) -> Result<Vec<WorkbenchAiResearchSource>, IpcError> {
    match search_web_duckduckgo(query) {
        Ok(sources) => Ok(sources),
        Err(primary_error) => search_web_bing_rss(query).map_err(|_| primary_error),
    }
}

fn parse_research_json(text: &str) -> Option<Value> {
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).ok().or_else(|| {
        let start = cleaned.find('{')?;
        let end = cleaned.rfind('}')?;
        serde_json::from_str(&cleaned[start..=end]).ok()
    })
}

/// Public goal facts belong to online research, not to the user's progressive
/// profile interview. Models occasionally ignore that distinction and ask for
/// the outcome or subject list anyway; suppress only those generic questions,
/// while preserving real disambiguation questions such as "是哪一种考试".
fn is_redundant_public_goal_question(question: &str) -> bool {
    let question = question.trim();
    if question.is_empty() {
        return false;
    }
    // A confirmation-shaped sentence is not enough to interrupt the user. The
    // dialog is reserved for explicit alternatives or an unresolved choice.
    let genuine_disambiguation = [
        "还是", "或者", "二选一", "多个合理解释", "存在歧义", "无法确定", "不确定是", "不确定指",
    ]
    .iter()
    .any(|marker| question.contains(marker))
        || ["哪个", "哪种", "哪一", "哪项", "哪门", "哪类", "哪件", "哪方面"]
            .iter()
            .any(|marker| question.contains(marker));
    if !genuine_disambiguation {
        let generic_confirmation = [
            "这样理解对吗", "这样理解正确吗", "我理解得对吗", "对吗", "是吗", "是不是",
            "是否就是", "确认一下", "这是你要", "你要准备", "可以吗",
        ]
        .iter()
        .any(|marker| question.contains(marker));
        if generic_confirmation {
            return true;
        }
        return [
            "达到什么结果",
            "目标结果",
            "完成标准",
            "目标领域",
            "哪些学科",
            "哪些模块",
            "包含哪些",
            "涉及哪些",
            "考哪些科目",
            "准备哪些内容",
            "具体包含什么",
        ]
        .iter()
        .any(|marker| question.contains(marker));
    }
    // “哪一个” and “还是” carry the ambiguity themselves. Generic “对吗/是
    // 吗” wording without alternatives is intentionally handled above.
    false
}

fn backup_path(path: &std::path::Path) -> PathBuf {
    path.with_extension("json.backup")
}

fn temp_path(path: &std::path::Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn read_state(path: &std::path::Path) -> Result<Option<Value>, IpcError> {
    let source = if path.exists() {
        path.to_path_buf()
    } else {
        let backup = backup_path(path);
        if !backup.exists() {
            return Ok(None);
        }
        backup
    };
    let bytes = fs::read(&source).map_err(|error| {
        storage_error(
            "WORKBENCH_READ_FAILED",
            format!("工作台数据读取失败：{error}"),
            true,
        )
    })?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(storage_error(
            "WORKBENCH_STATE_TOO_LARGE",
            "工作台数据超过 5 MB 限制",
            false,
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        storage_error(
            "WORKBENCH_STATE_INVALID",
            format!("工作台数据格式无效：{error}"),
            false,
        )
    })?;
    if !value.is_object() {
        return Err(storage_error(
            "WORKBENCH_STATE_INVALID",
            "工作台数据必须是 JSON 对象",
            false,
        ));
    }
    Ok(Some(value))
}

fn replace_state(path: &std::path::Path, bytes: &[u8]) -> Result<(), IpcError> {
    let temporary = temp_path(path);
    let backup = backup_path(path);
    fs::write(&temporary, bytes).map_err(|error| {
        storage_error(
            "WORKBENCH_WRITE_FAILED",
            format!("临时数据写入失败：{error}"),
            true,
        )
    })?;

    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                storage_error(
                    "WORKBENCH_WRITE_FAILED",
                    format!("旧备份清理失败：{error}"),
                    true,
                )
            })?;
        }
        fs::rename(path, &backup).map_err(|error| {
            storage_error(
                "WORKBENCH_WRITE_FAILED",
                format!("现有数据备份失败：{error}"),
                true,
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(storage_error(
            "WORKBENCH_WRITE_FAILED",
            format!("工作台数据替换失败：{error}"),
            true,
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchBackupInfo { pub name: String, pub byte_count: usize, pub created_at: u64 }

fn backup_dir(path: &std::path::Path) -> Option<PathBuf> { path.parent().map(|parent| parent.join("workbench-backups")) }
fn backup_current(path: &std::path::Path) -> Result<(), IpcError> {
    let bytes = match fs::read(path) { Ok(bytes) => bytes, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(error) => return Err(storage_error("WORKBENCH_READ_FAILED", format!("当前数据备份失败：{error}"), true)) };
    if bytes.len() > MAX_STATE_BYTES { return Err(storage_error("WORKBENCH_STATE_TOO_LARGE", "当前数据超过 5 MB 限制", false)); }
    let Some(dir) = backup_dir(path) else { return Ok(()); }; fs::create_dir_all(&dir).map_err(|error| storage_error("WORKBENCH_WRITE_FAILED", format!("备份目录创建失败：{error}"), true))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    fs::write(dir.join(format!("workbench.backup-{stamp}.json")), bytes).map_err(|error| storage_error("WORKBENCH_WRITE_FAILED", format!("历史备份写入失败：{error}"), true))?;
    let mut entries: Vec<_> = fs::read_dir(&dir).map_err(|error| storage_error("WORKBENCH_WRITE_FAILED", format!("历史备份读取失败：{error}"), true))?.flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with("workbench.backup-")).collect();
    entries.sort_by_key(|entry| entry.metadata().ok().and_then(|meta| meta.modified().ok()));
    while entries.len() > 14 { if let Some(entry) = entries.first() { let _ = fs::remove_file(entry.path()); } entries.remove(0); }
    Ok(())
}

#[tauri::command]
pub(crate) fn workbench_list_backups(state: State<'_, WorkbenchStorageState>) -> IpcResponse<Vec<WorkbenchBackupInfo>> {
    let Some(parent) = backup_dir(&state.path) else { return IpcResponse::success(Vec::new()); };
    let prefix = "workbench.backup-";
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) { for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string(); if !name.starts_with(&prefix) { continue; }
        if let Ok(meta) = entry.metadata() { items.push(WorkbenchBackupInfo { name, byte_count: meta.len() as usize, created_at: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0) }); }
    }}
    items.sort_by(|a,b| b.created_at.cmp(&a.created_at)); IpcResponse::success(items)
}

#[tauri::command]
pub(crate) fn workbench_restore_backup(name: String, state: State<'_, WorkbenchStorageState>) -> IpcResponse<WorkbenchSaveResult> {
    let Some(parent) = backup_dir(&state.path) else { return IpcResponse::error(storage_error("WORKBENCH_BACKUP_INVALID", "备份位置无效", false)); };
    let safe = PathBuf::from(&name); if safe.file_name().and_then(|v| v.to_str()) != Some(name.as_str()) || !name.starts_with("workbench.backup-") { return IpcResponse::error(storage_error("WORKBENCH_BACKUP_INVALID", "备份名称无效", false)); }
    let source = parent.join(safe); let bytes = match fs::read(&source) { Ok(v) if v.len() <= MAX_STATE_BYTES => v, Ok(_) => return IpcResponse::error(storage_error("WORKBENCH_STATE_TOO_LARGE", "备份超过 5 MB 限制", false)), Err(_) => return IpcResponse::error(storage_error("WORKBENCH_BACKUP_NOT_FOUND", "备份不存在", false)) };
    if serde_json::from_slice::<Value>(&bytes).map(|v| v.is_object()).unwrap_or(false) == false { return IpcResponse::error(storage_error("WORKBENCH_STATE_INVALID", "备份格式无效", false)); }
    if let Err(error) = backup_current(&state.path) { return IpcResponse::error(error); }
    match replace_state(&state.path, &bytes) { Ok(()) => IpcResponse::success(WorkbenchSaveResult { saved: true, byte_count: bytes.len() }), Err(e) => IpcResponse::error(e) }
}

#[tauri::command]
pub(crate) fn workbench_load_state(
    state: State<'_, WorkbenchStorageState>,
) -> IpcResponse<Option<Value>> {
    match read_state(&state.path) {
        Ok(value) => IpcResponse::success(value),
        Err(error) => IpcResponse::error(error),
    }
}

#[tauri::command]
pub(crate) fn workbench_save_state(
    request: WorkbenchSaveRequest,
    state: State<'_, WorkbenchStorageState>,
) -> IpcResponse<WorkbenchSaveResult> {
    if !request.state.is_object() {
        return IpcResponse::error(storage_error(
            "WORKBENCH_STATE_INVALID",
            "工作台数据必须是 JSON 对象",
            false,
        ));
    }
    let bytes = match serde_json::to_vec(&request.state) {
        Ok(bytes) if bytes.len() <= MAX_STATE_BYTES => bytes,
        Ok(_) => {
            return IpcResponse::error(storage_error(
                "WORKBENCH_STATE_TOO_LARGE",
                "工作台数据超过 5 MB 限制",
                false,
            ));
        }
        Err(error) => {
            return IpcResponse::error(storage_error(
                "WORKBENCH_STATE_INVALID",
                format!("工作台数据无法序列化：{error}"),
                false,
            ));
        }
    };
    if let Err(error) = backup_current(&state.path) { return IpcResponse::error(error); }
    match replace_state(&state.path, &bytes) {
        Ok(()) => IpcResponse::success(WorkbenchSaveResult {
            saved: true,
            byte_count: bytes.len(),
        }),
        Err(error) => IpcResponse::error(error),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_assist(
    request: WorkbenchAiRequest,
    on_event: Channel<WorkbenchAgentEvent>,
    state: State<'_, WorkbenchStorageState>,
) -> Result<IpcResponse<WorkbenchAiResult>, String> {
    if request.prompt.trim().is_empty() {
        return Ok(IpcResponse::error(storage_error(
            "WORKBENCH_AI_PROMPT_EMPTY",
            "请输入需要分析的问题",
            false,
        )));
    }
    let context = request.context.to_string();
    let session_id = request.session_id.clone().unwrap_or_else(|| format!("workbench-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0)));
    let cancellation = match state.start_ai_session(&session_id) {
        Ok(token) => token,
        Err(error) => return Ok(IpcResponse::error(error)),
    };
    let _agent_metadata = (
        request.session_id.as_deref().unwrap_or("legacy"),
        request.agent_run_id.as_deref().unwrap_or("legacy"),
        request.snapshot_version.as_deref().unwrap_or("unknown"),
    );
    if context.len() > 100_000 {
        state.finish_ai_session(&session_id);
        return Ok(IpcResponse::error(storage_error(
            "WORKBENCH_AI_CONTEXT_TOO_LARGE",
            "AI 上下文超过限制",
            false,
        )));
    }
    let prompt = request.prompt;
    let permission = request.permission.unwrap_or(AiPermission::Suggest);
    let routed_skills = route_skills(&prompt, &context);
    let skills = skill_ids(&routed_skills);
    let skill_system_prompt = format!(
        "{}\n你不是一次性问答接口，而是有状态的工作台 Agent。先读取并综合 context 中的 currentDate、activeGoal、activeGoalRule、goals、projects、tasks、countdowns、recentHistory、memories、pendingPlanProposals 和 recentChat，再回答当前请求。\nAgent 决策规则：1. activeGoalRule 是当前页面和对话的最高优先级，除非用户明确切换目标，不得把其他目标列为待选择项；2. 已在 context 中明确给出的事实不得再次追问；3. recentChat 中已经回答过的问题不得原样重复提问；4. 先判断用户是在查询、补充资料、调整计划还是请求执行；5. 只有缺少会改变结论的关键信息时才提出一个最小澄清问题；6. 不能把模型猜测写成用户事实，不能声称已经执行未执行的操作；7. 涉及任务、计划或记忆变化时，先给出依据、影响和待确认动作。普通聊天中的记忆处理：用户明确陈述稳定的个人背景、身份、专业、学校或长期规划偏好时，可以直接记录为本地记忆，不要询问‘是否确认保存这条记忆’。只有含义不清、互相冲突、明显临时或带猜测的内容才不记录；普通回答中说明已自动记录即可。用户可以随时删除或停用。",
        system_instructions(&routed_skills)
    );
    let config = request
        .config
        .or_else(|| {
            request
                .context
                .get("preferences")
                .and_then(|preferences| preferences.get("aiConfig"))
                .and_then(|config| serde_json::from_value(config.clone()).ok())
        })
        .unwrap_or(WorkbenchAiConfigRequest {
            base_url: "https://api.openai.com/v1".to_owned(),
            model: "gpt-5".to_owned(),
            balance_url: String::new(),
        });
    let provider = match OpenAiResponsesProvider::new_with_config(
        WindowsCredentialStore::default(),
        &config.base_url,
        &config.model,
    ) {
        Ok(provider) => provider,
        Err(error) => {
            state.finish_ai_session(&session_id);
            return Ok(IpcResponse::error(storage_error(error.failure.code(), "AI 配置无效", false)));
        }
    };
    // 计划生成包含多份文档，允许中转站较长的推理时间；前端对应等待 240 秒。
    let provider = provider.with_timeout(std::time::Duration::from_secs(240));
    let model = config.model.clone();
    let response = match tauri::async_runtime::spawn_blocking(move || {
        let allowed_tools = allowed_tools(permission).into_iter().map(str::to_owned).collect::<Vec<_>>();
        let conversation = request.context.get("recentChat").and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| Some(crate::ai::orchestrator::AiConversationMessage {
                role: item.get("role")?.as_str()?.to_owned(),
                content: item.get("text")?.as_str()?.to_owned(),
            })).take(24).collect::<Vec<_>>()).unwrap_or_default();
        let snapshot: Value = serde_json::from_str(&context).unwrap_or_else(|_| json!({}));
        let mut tool_results: Vec<AiToolResult> = Vec::new();
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;
        for round in 0..6 {
            if cancellation.is_cancelled() { return Err(crate::ai::provider::AiError::new(crate::ai::provider::AiFailure::Cancelled)); }
            let _ = on_event.send(WorkbenchAgentEvent::Stage { label: format!("开始第 {} 轮分析", round + 1), detail: None });
            text.clear();
            let mut tool_requests = Vec::new();
            let ai_request = AiRequest {
                prompt: if round == 0 { prompt.clone() } else { "根据工具结果继续完成当前用户请求。不要重复已经完成的检索。".to_owned() },
                system_prompt: skill_system_prompt.clone(),
                context: context.clone(),
                allowed_tools: allowed_tools.clone(),
                tool_results: tool_results.clone(),
                previous_response_id: None,
                conversation: conversation.clone(),
            };
            provider.stream(&ai_request, &cancellation, &mut |event| {
                match event {
                    AiStreamEvent::TextDelta { text: delta } => text.push_str(&delta),
                    AiStreamEvent::ToolRequest { call_id, name, arguments } => {
                        let _ = on_event.send(WorkbenchAgentEvent::Tool { name: name.clone(), status: "requested".to_owned(), detail: None });
                        tool_requests.push((call_id, name, arguments));
                    },
                    AiStreamEvent::Completed { input_tokens: input, output_tokens: output, .. } => { input_tokens = input; output_tokens = output; }
                    _ => {}
                }
                Ok(())
            })?;
            if tool_requests.is_empty() { break; }
            for (call_id, name, arguments) in tool_requests {
                if cancellation.is_cancelled() { return Err(crate::ai::provider::AiError::new(crate::ai::provider::AiFailure::Cancelled)); }
                let result = workbench_tools::run(&name, &arguments, &snapshot)
                    .map(|value| json!({"ok": true, "data": value }))
                    .unwrap_or_else(|error| json!({"ok": false, "error": error }));
                let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
                let _ = on_event.send(WorkbenchAgentEvent::Tool { name: name.clone(), status: if ok { "completed" } else { "failed" }.to_owned(), detail: Some(result.to_string()) });
                tool_results.push(AiToolResult { call_id, name, arguments, result });
            }
        }
        if text.trim().is_empty() { return Err(crate::ai::provider::AiError::new(crate::ai::provider::AiFailure::Provider)); }
        let _ = on_event.send(WorkbenchAgentEvent::Completed);
        Ok((text, input_tokens, output_tokens))
    }).await {
        Ok(Ok((text, input_tokens, output_tokens))) => IpcResponse::success(WorkbenchAiResult {
            text,
            model,
            input_tokens,
            output_tokens,
            skills,
        }),
        Ok(Err(error)) => IpcResponse::error(ai_error(error, "AI 对话失败")),
        Err(error) => IpcResponse::error(storage_error(
            "WORKBENCH_AI_FAILED",
            format!("AI 分析任务失败：{error}"),
            true,
        )),
    };
    state.finish_ai_session(&session_id);
    Ok(response)
}

#[tauri::command]
pub(crate) fn workbench_agent_commit_state(
    request: WorkbenchAgentCommitRequest,
    state: State<'_, WorkbenchStorageState>,
) -> IpcResponse<WorkbenchSaveResult> {
    if !request.expected_state.is_object() || !request.next_state.is_object() {
        return IpcResponse::error(storage_error("WORKBENCH_STATE_INVALID", "Agent 提交的数据必须是 JSON 对象", false));
    }
    commit_agent_state(&state.path, request.expected_state, request.next_state)
}

fn commit_agent_state(path: &std::path::Path, expected_state: Value, next_state: Value) -> IpcResponse<WorkbenchSaveResult> {
    let current = match read_state(path) {
        Ok(Some(value)) => value,
        Ok(None) => json!({}),
        Err(error) => return IpcResponse::error(error),
    };
    if current != expected_state {
        return IpcResponse::error(storage_error("WORKBENCH_VERSION_CONFLICT", "工作台数据已在其他位置发生变化，未覆盖最新内容", false));
    }
    let bytes = match serde_json::to_vec(&next_state) {
        Ok(bytes) if bytes.len() <= MAX_STATE_BYTES => bytes,
        Ok(_) => return IpcResponse::error(storage_error("WORKBENCH_STATE_TOO_LARGE", "Agent 提交的数据超过 5 MB 限制", false)),
        Err(error) => return IpcResponse::error(storage_error("WORKBENCH_STATE_INVALID", format!("Agent 提交的数据无法序列化：{error}"), false)),
    };
    if let Err(error) = backup_current(path) { return IpcResponse::error(error); }
    match replace_state(path, &bytes) {
        Ok(()) => IpcResponse::success(WorkbenchSaveResult { saved: true, byte_count: bytes.len() }),
        Err(error) => IpcResponse::error(error),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum WorkbenchAgentEvent {
    Stage { label: String, detail: Option<String> },
    Tool { name: String, status: String, detail: Option<String> },
    Completed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiCancelRequest { session_id: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchAiCancelResult { session_id: String, cancelled: bool }

#[tauri::command]
pub(crate) fn workbench_ai_cancel(
    request: WorkbenchAiCancelRequest,
    state: State<'_, WorkbenchStorageState>,
) -> IpcResponse<WorkbenchAiCancelResult> {
    IpcResponse::success(WorkbenchAiCancelResult { session_id: request.session_id.clone(), cancelled: state.cancel_ai_session(&request.session_id) })
}

#[tauri::command]
pub(crate) async fn workbench_ai_research(
    request: WorkbenchAiResearchRequest,
) -> IpcResponse<WorkbenchAiResearchResult> {
    let query = request.query.trim().to_owned();
    if query.is_empty() || query.chars().count() > 200 {
        return IpcResponse::error(research_error(
            "AI_RESEARCH_INVALID_QUERY",
            "请输入有效的目标名称",
            false,
        ));
    }
    let config = request.config;
    let details = request.details;
    let routed_skills = route_skills(&query, "目标研究与在线资料");
    let routed_skill_ids = skill_ids(&routed_skills);
    let routed_system_prompt = system_instructions(&routed_skills);
    match tauri::async_runtime::spawn_blocking(move || {
        let credentials = WindowsCredentialStore::default();
        if !credentials.has_api_key().map_err(|error| ai_error(error, "在线研究失败"))? {
            return Err(research_error("AI_NO_API_KEY", "尚未配置 API Key，在线目标研究需要联网 AI", false));
        }
        // Search is supporting evidence, not a prerequisite for understanding the
        // user's goal. If both public search providers are unavailable, continue
        // with an explicit empty source list so the model must disclose the gap.
        let sources = search_web(&query).unwrap_or_default();
        let context = serde_json::to_string(&json!({
            "query": query,
            "countdown": details,
            "sources": sources.clone(),
            "searchAvailable": !sources.is_empty(),
        })).map_err(|_| research_error("AI_RESEARCH_FAILED", "在线研究资料整理失败", true))?;
        let provider = OpenAiResponsesProvider::new_with_config(credentials, &config.base_url, &config.model)
            .map_err(|error| ai_error(error, "在线研究配置无效"))?;
        let request = AiRequest {
            prompt: "请先理解用户输入的倒数日目标，再综合在线资料给出结构化判断。上下文中的 countdown 字段（类型、目标日期、剩余天数、当前进度）已经由用户确认，必须直接使用，禁止再次询问这些字段。只返回 JSON，不要 Markdown 代码块。字段必须是 interpretation（最可能的目标含义）、summary（与目标相关的关键要求）、suggestedOutcome（仅根据公开资料整理的可验证完成标准；无法确认时为 null）、suggestedDimensions（仅根据公开资料整理的学科、模块或工作方向数组；无法确认时为空数组）、question（只有目标含义确实存在多个合理解释且无法根据查询和搜索结果判断时才提问，否则为 null）、needsConfirmation（是否必须先确认）、sources（只能原样保留输入资料来源，不要新增来源）。目标结果和目标领域如果能从公开资料确定，必须填入 suggestedOutcome 和 suggestedDimensions，不要再向用户询问。不要询问达到什么结果、目标领域、学科、模块、目标日期、剩余天数或进度，这些属于公开研究或已提供上下文。用户当前基础、个人分数、每周可用时间等个人信息不能从网上推断，留给后续逐步询问。若存在主导的常见含义且与倒数日类型一致（例如考试类型为 exam 的“四级”通常指大学英语四级），直接采用该含义，不要仅因为简称而提问。当 searchAvailable 为 false 时，必须在 summary 中明确说明暂时没有取得可验证的在线资料，不得编造具体考试规则或日期。".to_owned(),
            system_prompt: format!("{}\n你是在线目标研究助手。必须使用给定搜索结果，不得编造来源或事实。只输出简洁中文 JSON。", routed_system_prompt),
            context,
            allowed_tools: Vec::new(),
            tool_results: Vec::new(),
            previous_response_id: None,
            conversation: Vec::new(),
        };
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;
        provider.stream(&request, &CancellationToken::default(), &mut |event| {
            match event {
                AiStreamEvent::TextDelta { text: delta } => text.push_str(&delta),
                AiStreamEvent::Completed { input_tokens: input, output_tokens: output, .. } => {
                    input_tokens = input;
                    output_tokens = output;
                }
                _ => {}
            }
            Ok(())
        }).map_err(|error| ai_error(error, "在线研究失败"))?;
        let parsed = parse_research_json(&text).ok_or_else(|| research_error("AI_RESEARCH_INVALID_RESPONSE", "在线 AI 返回格式无法识别", true))?;
        let interpretation = parsed.get("interpretation").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        let summary = parsed.get("summary").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        if interpretation.is_empty() || summary.is_empty() {
            return Err(research_error("AI_RESEARCH_INVALID_RESPONSE", "在线 AI 没有返回完整研究结论", true));
        }
        let suggested_outcome = parsed.get("suggestedOutcome").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
        let suggested_dimensions = parsed.get("suggestedDimensions").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned).take(12).collect()).unwrap_or_default();
        let raw_question = parsed.get("question").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
        let question = raw_question.filter(|value| !is_redundant_public_goal_question(value));
        let needs_confirmation = if question.is_some() {
            parsed.get("needsConfirmation").and_then(Value::as_bool).unwrap_or(true)
        } else {
            false
        };
        let sources = serde_json::from_value::<Vec<WorkbenchAiResearchSource>>(parsed.get("sources").cloned().unwrap_or_else(|| json!([])))
            .unwrap_or_default();
        Ok::<_, IpcError>(WorkbenchAiResearchResult { interpretation, summary, question, needs_confirmation, suggested_outcome, suggested_dimensions, sources, model: config.model, input_tokens, output_tokens, skills: routed_skill_ids })
    }).await {
        Ok(Ok(result)) => IpcResponse::success(result),
        Ok(Err(error)) => IpcResponse::error(error),
        Err(error) => IpcResponse::error(storage_error("WORKBENCH_AI_FAILED", format!("在线研究任务失败：{error}"), true)),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_validate_goal_answer(
    request: WorkbenchAiGoalAnswerValidationRequest,
) -> IpcResponse<WorkbenchAiGoalAnswerValidationResult> {
    let answer = request.answer.trim().to_owned();
    if answer.is_empty() || answer.chars().count() > 1000 {
        return IpcResponse::error(storage_error(
            "AI_GOAL_ANSWER_INVALID",
            "目标资料回答为空或过长",
            false,
        ));
    }
    let config = request.config;
    let routed_skills = route_skills(&request.question, "目标资料审核与记忆筛选");
    let routed_skill_ids = skill_ids(&routed_skills);
    let routed_system_prompt = system_instructions(&routed_skills);
    match tauri::async_runtime::spawn_blocking(move || {
        let provider = OpenAiResponsesProvider::new_with_config(WindowsCredentialStore::default(), &config.base_url, &config.model)
            .map_err(|error| ai_error(error, "目标资料审核失败"))?;
        let context = serde_json::to_string(&json!({
            "goalTitle": request.goal_title,
            "questionKey": request.question_key,
            "question": request.question,
            "answer": answer,
        })).map_err(|_| research_error("AI_GOAL_ANSWER_FAILED", "目标资料审核上下文整理失败", true))?;
        let ai_request = AiRequest {
            prompt: "审核这条目标资料回答。只返回 JSON：accepted（是否是对当前问题有意义、基本可信的回答）、normalized（通过时整理后的短文本，拒绝时为空字符串）、reason（给用户的简短说明）、confidence（0 到 100）。乱答、辱骂、无意义字符、明显答非所问或无法用于规划的内容必须 accepted=false。不要编造用户未说的信息。".to_owned(),
            system_prompt: format!("{}\n你是在线目标资料审核器。只筛选用户输入，不替用户补答案；严格拒绝乱答和答非所问。只输出简洁 JSON。", routed_system_prompt),
            context,
            allowed_tools: Vec::new(),
            tool_results: Vec::new(),
            previous_response_id: None,
            conversation: Vec::new(),
        };
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;
        provider.stream(&ai_request, &CancellationToken::default(), &mut |event| {
            match event {
                AiStreamEvent::TextDelta { text: delta } => text.push_str(&delta),
                AiStreamEvent::Completed { input_tokens: input, output_tokens: output, .. } => { input_tokens = input; output_tokens = output; }
                _ => {}
            }
            Ok(())
        }).map_err(|error| ai_error(error, "目标资料审核失败"))?;
        let parsed = parse_research_json(&text).ok_or_else(|| research_error("AI_GOAL_ANSWER_INVALID_RESPONSE", "在线 AI 审核返回格式无法识别", true))?;
        let accepted = parsed.get("accepted").and_then(Value::as_bool).unwrap_or(false);
        let normalized = parsed.get("normalized").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        let reason = parsed.get("reason").and_then(Value::as_str).unwrap_or(if accepted { "回答已通过审核" } else { "这条回答暂时不能作为目标资料" }).trim().to_owned();
        let confidence = parsed.get("confidence").and_then(Value::as_u64).unwrap_or(0).min(100) as u8;
        if accepted && normalized.is_empty() { return Err(research_error("AI_GOAL_ANSWER_INVALID_RESPONSE", "在线 AI 没有返回有效的整理结果", true)); }
        Ok::<_, IpcError>(WorkbenchAiGoalAnswerValidationResult { accepted, normalized, reason, confidence, model: config.model, input_tokens, output_tokens, skills: routed_skill_ids })
    }).await {
        Ok(Ok(result)) => IpcResponse::success(result),
        Ok(Err(error)) => IpcResponse::error(error),
        Err(error) => IpcResponse::error(storage_error("WORKBENCH_AI_FAILED", format!("目标资料审核任务失败：{error}"), true)),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_credentials_status() -> IpcResponse<WorkbenchAiCredentialStatus> {
    match WindowsCredentialStore::default().has_api_key() {
        Ok(configured) => IpcResponse::success(WorkbenchAiCredentialStatus { configured }),
        Err(error) => IpcResponse::error(storage_error(
            error.failure.code(),
            "无法读取 AI 凭据状态",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_save_credentials(
    request: WorkbenchAiCredentialRequest,
) -> IpcResponse<WorkbenchAiCredentialStatus> {
    let key = request.api_key.trim();
    if key.is_empty() || key.len() > 4096 {
        return IpcResponse::error(storage_error(
            "AI_NO_API_KEY",
            "请输入有效的 API Key",
            false,
        ));
    }
    match WindowsCredentialStore::default().save_api_key(key) {
        Ok(()) => IpcResponse::success(WorkbenchAiCredentialStatus { configured: true }),
        Err(error) => IpcResponse::error(storage_error(
            error.failure.code(),
            "AI 凭据保存失败",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_clear_credentials() -> IpcResponse<WorkbenchAiCredentialStatus> {
    match WindowsCredentialStore::default().delete_api_key() {
        Ok(()) => IpcResponse::success(WorkbenchAiCredentialStatus { configured: false }),
        Err(error) => IpcResponse::error(storage_error(
            error.failure.code(),
            "AI 凭据清除失败",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_test_connection(
    config: WorkbenchAiConfigRequest,
) -> IpcResponse<WorkbenchAiConnectionResult> {
    let model = config.model.clone();
    let base_url = config.base_url.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let started_at = std::time::Instant::now();
        let provider = OpenAiResponsesProvider::new_with_config(
            WindowsCredentialStore::default(),
            &config.base_url,
            &config.model,
        )
        .map_err(|error| ai_error(error, "配置检查失败"))?
        .with_timeout(std::time::Duration::from_secs(60));
        let request = AiRequest {
            prompt: "只回复：连接成功".to_owned(),
            system_prompt: "你是连接测试助手。不要推理或解释，只回复四个字：连接成功。".to_owned(),
            context: "".to_owned(),
            allowed_tools: Vec::new(),
            tool_results: Vec::new(),
            previous_response_id: None,
            conversation: Vec::new(),
        };
        let mut text = String::new();
        provider
            .stream(&request, &CancellationToken::default(), &mut |event| {
                if let AiStreamEvent::TextDelta { text: delta } = event {
                    text.push_str(&delta);
                }
                Ok(())
            })
            .map_err(|error| ai_error(error, "推理请求检查失败"))?;
        if text.trim().is_empty() {
            return Err(storage_error(
                "AI_PROVIDER_ERROR",
                "AI 未返回测试内容",
                true,
            ));
        }
        // A relay can serve inference while denying or omitting /models.
        let model_probe = OpenAiResponsesProvider::new_with_config(WindowsCredentialStore::default(), &base_url, &config.model).map_err(|error| ai_error(error, "配置检查失败"))?
            .with_timeout(std::time::Duration::from_secs(5)).probe_models()
            .unwrap_or(super::super::ai::provider::AiModelProbe { supported:false, model_found:None, model_count:None, latency_ms:0 });
        let protocol = "OpenAI 兼容（Responses / Chat Completions 自动适配）";
        Ok::<_, crate::ipc::response::IpcError>((
            protocol.to_owned(),
            started_at.elapsed().as_millis(),
            text.trim().chars().take(80).collect::<String>(),
            model_probe,
        ))
    })
    .await
    {
        Ok(Ok((protocol, latency_ms, reply, model_probe))) => IpcResponse::success(WorkbenchAiConnectionResult {
            model,
            protocol,
            latency_ms,
            reply,
            model_directory_supported: model_probe.supported,
            model_found: model_probe.model_found,
            model_count: model_probe.model_count,
            model_probe_latency_ms: model_probe.latency_ms,
        }),
        Ok(Err(error)) => IpcResponse::error(error),
        Err(error) => IpcResponse::error(storage_error(
            "WORKBENCH_AI_FAILED",
            format!("AI 连接测试失败：{error}"),
            true,
        )),
    }
}

#[tauri::command]
pub(crate) async fn workbench_ai_balance(
    config: WorkbenchAiConfigRequest,
) -> IpcResponse<WorkbenchAiBalanceResult> {
    if config.balance_url.trim().is_empty() {
        return IpcResponse::success(WorkbenchAiBalanceResult {
            supported: false,
            balance: None,
            currency: None,
            message: "当前中转站未配置余额查询地址；可以继续统计 token 用量。".to_owned(),
        });
    }
    let balance_url = config.balance_url.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let provider = OpenAiResponsesProvider::new_with_config(
            WindowsCredentialStore::default(),
            &config.base_url,
            &config.model,
        )
        .map_err(|error| ai_error(error, "余额查询失败"))?;
        provider
            .query_balance(&balance_url)
            .map_err(|error| ai_error(error, "余额查询失败"))
    })
    .await
    {
        Ok(Ok(Some(snapshot))) => IpcResponse::success(WorkbenchAiBalanceResult {
            supported: true,
            balance: Some(snapshot.balance),
            currency: snapshot.currency,
            message: "余额已从中转站接口读取。".to_owned(),
        }),
        Ok(Ok(None)) => IpcResponse::success(WorkbenchAiBalanceResult {
            supported: false,
            balance: None,
            currency: None,
            message: "中转站返回的数据中没有识别到余额字段；可以继续统计 token 用量。".to_owned(),
        }),
        Ok(Err(error)) => IpcResponse::error(error),
        Err(error) => IpcResponse::error(storage_error(
            "WORKBENCH_AI_BALANCE_FAILED",
            format!("余额查询任务失败：{error}"),
            true,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{commit_agent_state, is_redundant_public_goal_question, read_state, replace_state, WorkbenchStorageState};
    use serde_json::json;

    #[test]
    fn saves_and_loads_json_state() {
        let directory =
            std::env::temp_dir().join(format!("moji-workbench-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("test directory should be created");
        let path = directory.join("workbench.json");
        replace_state(&path, br#"{"version":2,"tasks":[]}"#).expect("state should save");
        assert_eq!(
            read_state(&path).expect("state should load"),
            Some(json!({ "version": 2, "tasks": [] }))
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn filters_generic_public_fact_questions_but_keeps_disambiguation() {
        assert!(is_redundant_public_goal_question("这个目标达到什么结果才算完成？"));
        assert!(is_redundant_public_goal_question("目标领域包含哪些学科？"));
        assert!(is_redundant_public_goal_question("我这样理解这个目标对吗？"));
        assert!(is_redundant_public_goal_question("你是不是要准备这个考试？"));
        assert!(!is_redundant_public_goal_question("你说的是大学英语四级还是计算机等级考试？"));
        assert!(!is_redundant_public_goal_question("具体是哪种考试？"));
        assert!(!is_redundant_public_goal_question("你目前的基础和薄弱部分是什么？"));
        assert!(!is_redundant_public_goal_question("你每周通常能投入多少时间？"));
    }

    #[test]
    fn workbench_ai_session_can_be_cancelled_and_finished() {
        let state = WorkbenchStorageState::new(std::env::temp_dir().join("moji-workbench-cancel-test.json"));
        let token = state.start_ai_session("cancel-test").expect("session should start");
        assert!(!token.is_cancelled());
        assert!(state.cancel_ai_session("cancel-test"));
        assert!(token.is_cancelled());
        state.finish_ai_session("cancel-test");
        assert!(!state.cancel_ai_session("cancel-test"));
    }

    #[test]
    fn agent_commit_rejects_stale_disk_state() {
        let directory = std::env::temp_dir().join(format!("moji-workbench-commit-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("test directory should be created");
        let path = directory.join("workbench.json");
        replace_state(&path, br#"{"version":1,"tasks":[]}"#).expect("state should save");
        let response = commit_agent_state(&path, json!({"version":0,"tasks":[]}), json!({"version":1,"tasks":[{"id":"t1"}]}));
        assert!(matches!(response, super::IpcResponse::Error { error } if error.code == "WORKBENCH_VERSION_CONFLICT"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
