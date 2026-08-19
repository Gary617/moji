# Phase 06 Handoff

- 阶段状态：implementation complete；真实 OpenAI 仅待受控桌面手工冒烟
- 分支：`codex/phase-06-ai-orchestrator`
- 建议提交：`feat: add permissioned AI document assistant`

## 已完成

- Rust `AiProvider` 可替换接口和 `MockProvider`：流式文本、工具请求、完成事件、取消和结构化 `AI_*` 错误。
- `OpenAiResponsesProvider` 使用 reqwest blocking SSE 代理 `response.output_text.delta`、`response.function_call_arguments.done`、`response.completed`；Key 只从 Windows Credential Manager generic target `moji/openai/api-key` 读取。无 Key/错误 Key/超时/限流/断网不会泄露凭据。
- `@文档(id)`、`@文档:id`、`@doc:id` 解析；上下文只通过 `DocumentContextSource for LibraryService` 调用 `document()` 和 `ocr_fragments()`，没有读取 SQLite 私有 OCR 表、canonical path 或临时页图。
- `ContextPreview` 返回来源 Document ID/展示名、页码、片段数、字符数、预计 token、截断标记、权限和 `untrusted=true`；正文使用 `<untrusted_text>`，文档内指令不能改变系统提示或工具白名单。
- 工具注册表分为只读、建议、写入、禁止；`suggest` 不写入，`assist` 要求 `approved=true`，`autonomous` 要求 `authorizedDocumentIds` 包含目标。删除/移动/系统命令/未选路径/API Key 工具永久拒绝。
- migration v5 新增 `ai_actions` 审计表和查询 IPC；请求、拒绝、Provider 错误、应用结果均记录稳定标识和脱敏细节。
- 所有 AI 写回复用 `document_save`，复用写前 Snapshot、当前 SHA-256 冲突、临时文件/备份和恢复流程。
- 前端新增 `src/ipc/ai.ts`，只传 Document ID/片段选择/权限/确认状态，不保存或读取 API Key。
- 文档工作区新增轻量 AI 面板：上下文预览、权限选择、Tauri Channel 流式事件和工具待审阅展示；逐项接受并提交变更仍待后续 UI 工期。

## 稳定 IPC

```text
ai_context_preview(ContextRequest) -> IpcResponse<ContextPreview>
ai_chat(AiChatRequest) -> IpcResponse<AiChatResult>
ai_chat_stream(AiChatRequest, Channel<AiStreamEvent>) -> IpcResponse<AiChatResult>
ai_apply_change(AiChangeRequest) -> IpcResponse<AiChangeResult>
ai_list_actions({ sessionId? }) -> IpcResponse<AiActionRecord[]>
```

## 允许与禁止工具

允许：`read_document_fragments`、`search_documents`；建议/协助阶段另允许 `propose_edit`、`create_annotation`；自主阶段才允许 `apply_document_edit`，且必须校验授权目标。禁止：`delete_document`、`move_document`、`system_command`、`read_unselected_path`、`set_api_key`。

## 数据发送规则

默认只发送请求中的 `documentIds`、`@文档` 明确 ID 和 `selections` 页片段。发送前返回来源、规模、预计 token、截断和权限预览；无明确 ID 不读取全文。文档正文被视为不可信数据，仅嵌入 `<untrusted_text>`。

## 验证

- `cargo test --manifest-path src-tauri/Cargo.toml`：38/38 PASS。
- `pnpm test`：7 个测试文件、17/17 PASS。
- `pnpm build`：PASS，1811 modules transformed；当前 Node 24.13.0 低于项目要求 24.15.0，只有 engine warning。
- 静态秘密审计：未发现硬编码 OpenAI Key；仓库仅出现错误码、Credential Manager API 和文档说明。未输出任何 Key 值。
- 真实 API 手工冒烟未运行：当前环境没有批准的 Credential Manager Key；不影响 Mock 自动测试结论。

## 工期 7 攻击面清单

1. 提示注入与工具参数模糊化、结构化参数 schema 和多轮工具调用去重。
2. 会话授权生命周期、撤销、并发请求和 autonomous 目标集合竞态。
3. SSE 重连、重复事件、断流恢复、超时取消和响应大小上限。
4. Credential Manager ACL、Key 轮换、企业代理/TLS、错误响应脱敏和审计留存防篡改。
5. 上下文 token 上限、大文档分段检索、正文提取覆盖率和 UI 流式审阅/逐项接受。
6. 真实 Tauri Channel 流式取消、前端状态清理、Provider 供应链和依赖漏洞扫描。
