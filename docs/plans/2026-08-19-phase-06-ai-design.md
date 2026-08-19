# 工期 6 AI 文档助手设计

## 目标与边界

AI 能力只通过 Rust 受控服务消费用户明确选择的 `DocumentId` 和统一页片段。前端不接触 API Key，也不能传入路径或直接读取正文。文档正文在请求中始终标记为不可信上下文；其中的指令不能修改系统提示、权限、上下文范围或工具白名单。

## 组件

- `AiProvider`：同步的流式事件接口；`MockProvider` 用于自动化测试，`OpenAiResponsesProvider` 负责 Responses API SSE 代理。
- `CredentialStore`：Windows 实现使用 Credential Manager 读取 `moji/openai/api-key`，测试使用内存实现。Key 只存在于 provider 请求生命周期。
- `ContextService`：解析 `@文档(...)`/`@文档:<id>`，通过 `LibraryService` 的 `DocumentId` 和 `library_document_fragments` 读取片段，生成可预览来源、字符数和 token 估算。
- `ToolRegistry`：只读、建议、写入和禁止四类工具。每次工具请求都校验权限、会话授权目标和参数，再写入 `AiAction` 审计。
- `AiOrchestrator`：固定系统提示、上下文封装、流式事件归一化，以及建议/协助/自主三级执行策略。写回复用 `document_save`，因此必经 Snapshot、哈希冲突检测和恢复流程。

## 数据流与错误

1. 前端提交 prompt、明确的 Document ID 和权限级别。
2. Rust 返回 ContextPreview；用户确认后才允许发起 provider 请求。
3. provider 发出 TextDelta 或 ToolRequest；受控服务只转发脱敏事件。
4. 建议模式永不写入；协助修改产生待审阅变更，只有 `approved=true` 才写入；自主修改限制在会话授权目标。
5. 失败只返回稳定机器码：`AI_NO_API_KEY`、`AI_RATE_LIMITED`、`AI_TIMEOUT`、`AI_NETWORK`、`AI_TOOL_DENIED`、`AI_DOCUMENT_CONFLICT` 等，不包含 Key、绝对路径或正文。

## 测试策略

Mock Provider 覆盖正常流式文本、工具调用、超时、限流、断网、无 Key、中途取消和工具拒绝；Context 覆盖 @文档解析、来源预览、规模估算和提示注入隔离；写回覆盖三级权限、越权目标、外部修改冲突和 Snapshot。真实 OpenAI 只作为手工冒烟，不影响自动化结论。
