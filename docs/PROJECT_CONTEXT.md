# 墨集项目上下文

## 项目定位

墨集是面向 Windows 10/11 的本地文档管理桌面应用。本仓库采用 Tauri 2 + React + TypeScript + Rust 的本地模块化单体架构。当前已完成工程基线、Office 编辑器 POC、本地资料库元数据/扫描核心、全文检索/虚拟组织、查看器来源定位扩展、本地 OCR 后台管线和受控 AI 文档助手；账号、同步和完整 AI 对话面板仍未实现。

## 目录结构

```text
.
├── docs/                       # 长期上下文、计划、状态、决策、测试和交接
│   ├── plans/                  # 经确认的分阶段实施计划
│   └── handoffs/               # 每个工期的跨窗口交接
├── src/                        # React 产品代码
│   └── ipc/                    # 前端 IPC 类型和调用适配层
├── tests/
│   └── frontend/               # Vitest + Testing Library 前端单元测试
├── src-tauri/                  # Tauri/Rust 桌面核心
│   ├── capabilities/           # Tauri 2 窗口能力声明
│   ├── icons/                  # Tauri 生成的平台图标资源
│   └── src/
│       └── ipc/                # Rust IPC 命令和统一响应结构
│       └── library/            # SQLite migration、授权策略、扫描、任务和监听适配
├── package.json                # 前端、测试和桌面构建命令
├── pnpm-lock.yaml              # Node 依赖锁文件
├── pnpm-workspace.yaml         # pnpm 供应链策略例外记录
└── rust-toolchain.toml         # 固定 Rust 工具链
```

`_docx_render/` 是方案文档的既有渲染产物，来源不明且不属于应用代码，保留在本地并通过 `.gitignore` 排除。

## 架构边界

- React 只负责界面、交互状态和编辑器宿主。所有 Tauri 调用必须经过 `src/ipc/`，组件不得直接调用 `invoke`。
- Rust 是本地能力和权限边界。自定义命令放在 `src-tauri/src/ipc/`，不得把绝对路径、密钥或未授权内容直接暴露给前端。
- `tests/frontend/` 只测试前端状态和 IPC 适配；Rust 单元测试与实现放在同一模块的 `#[cfg(test)]` 中。
- 文档计划和交接放在 `docs/`。稳定事实写入本文件，阶段状态写入 `STATUS.md`，技术取舍写入 `DECISIONS.md`。
- 资料库模块只在 `src-tauri/src/library/` 访问 SQLite 和文件系统；后续模块只能使用稳定 `DocumentId` 与扫描事件，不得绕过授权根目录重新遍历磁盘。
- `SourceRootId`、`DocumentId`、`ScanJobId` 是持久稳定标识；绝对路径是受控元数据，不能作为前端长期主键或跨模块引用。
- 扫描器不移动、复制、重命名或删除用户原文件，也不依赖 `EditorAdapter` 的运行时实现。

## 版本要求

### 工具链

- Windows 10/11 x64，WebView2 Runtime。
- Node.js `>=24.15.0 <25`；本期验证版本 `24.19.0`。
- pnpm `11.19.0`。
- Rust `1.97.1`，目标 `x86_64-pc-windows-msvc`。
- Visual Studio 2022 C++ Build Tools（`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`）。

### 直接依赖

- Tauri Rust `2.11.5`，Tauri Build `2.6.3`，Tauri CLI `2.11.4`，Tauri JS API `2.11.1`。
- React/React DOM `19.2.8`，TypeScript `7.0.2`，Vite `8.2.1`。
- Vitest `4.1.11`，Testing Library React `16.3.2`，jsdom `30.0.1`。
- `zetajs` `1.2.0`（MIT，2025-06-11 release；ZetaOffice/LibreOffice UNO browser wrapper）。ZetaOffice 官方站点（2026-08-18）标记为开放 beta，并列出 Windows 64-bit、32-bit 和 ARM64 桌面下载；本仓库不分发其二进制。浏览器 POC 使用官方 CDN `https://cdn.zetaoffice.net/zetaoffice_latest/`，不是把 WASM/data 提交到仓库。
- `rusqlite` `0.40.2`（`bundled` SQLite）、`file-id` `0.2.3`（Windows File ID）、`notify` `8.2.0`、`lopdf` `0.38.0`、`image` `0.25.9`、`ppocr-rs` `0.7.3`（PP-OCRv6，固定 `ort 2.0.0-rc.9` / ONNX Runtime CPU `1.26.0`）、`sha2` `0.11.0`、serde `1.0.229`，serde_json `1.0.151`，tracing `0.1.44`，tracing-subscriber `0.3.23`。

所有 Node 直接依赖使用精确版本，完整解析结果以 `pnpm-lock.yaml` 为准。所有 Rust 直接依赖使用精确版本，完整解析结果以 `src-tauri/Cargo.lock` 为准。

## 规范命令

在仓库根目录运行。安装 Rustup 后应重新打开终端，使 `%USERPROFILE%\.cargo\bin` 进入 `PATH`。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm test:rust
pnpm build
pnpm build:desktop
pnpm generate:office-fixtures
pnpm test:editor-poc
pnpm tauri dev
```

- `pnpm install --frozen-lockfile`：只按锁文件安装依赖。
- `pnpm test`：运行前端单元测试。
- `pnpm test:rust`：运行 Rust 单元测试。
- `pnpm build`：执行 TypeScript 类型检查和前端生产构建。
- `pnpm build:desktop`：执行前端生产构建并生成不打安装包的 Tauri release 可执行文件。
- `pnpm generate:office-fixtures`：生成 24 个确定性 DOCX/PPTX/XLSX OOXML POC 夹具，不代表编辑器通过。
- `pnpm test:editor-poc`：在临时目录执行注入 `ZetaOfficeRuntime` 的 EditorAdapter round-trip；没有 Node runtime bridge 时必须返回 `BLOCKED`，不得用 mock 代替。Node 报告默认写入 `docs/editor-poc/results.node.{json,md}`，不覆盖浏览器真实证据。
- 浏览器真实 POC：启动 `pnpm dev`，打开 `http://127.0.0.1:1420/editor-poc/index.html`，等待官方 CDN runtime ready，点击 `Run 24-sample matrix`；页面执行真实 `Module.zetajs` worker 回环，结果写入 `docs/editor-poc/results.{json,md}`。
- `pnpm tauri dev`：启动开发服务器和真实桌面窗口，用于手工 IPC 验收。

## IPC 约定

IPC 协议版本从 `1` 开始。Rust 自定义命令必须返回统一信封，不以裸值作为成功响应。可预期业务失败也返回失败信封；Tauri 通道抛出的异常由 `src/ipc/` 归一为 `IPC_TRANSPORT_ERROR`。

成功：

```json
{
  "status": "success",
  "data": {}
}
```

失败：

```json
{
  "status": "error",
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "可向用户展示的简短说明",
    "retryable": false,
    "details": null
  }
}
```

- `code` 使用稳定的大写下划线机器码。
- `message` 不包含密钥、绝对路径或敏感正文。
- `retryable` 明确客户端是否可以提供重试动作。
- `details` 只放经过授权、可序列化且不敏感的结构化信息；无信息时为 `null`。

当前命令：

```text
health_check() -> IpcResponse<HealthCheckData>
HealthCheckData = { backendStatus: "ok", appVersion: string, protocolVersion: 1 }

library_register_source(path) -> IpcResponse<SourceRegistrationData>
library_start_scan({ sourceRootId }) -> IpcResponse<ScanSummary>
library_scan_status({ scanJobId }) -> IpcResponse<ScanJobRecord>
library_scan_events({ scanJobId }) -> IpcResponse<ScanEvent[]>
library_pause_scan({ scanJobId }) -> IpcResponse<ScanJobRecord>
library_resume_scan({ scanJobId }) -> IpcResponse<ScanJobRecord>
library_cancel_scan({ scanJobId }) -> IpcResponse<ScanJobRecord>
library_retry_scan({ scanJobId }) -> IpcResponse<ScanJobRecord>
library_start_watch({ sourceRootId }) -> IpcResponse<WatchStatus>
library_poll_watch({ sourceRootId }) -> IpcResponse<WatchPollResult>
library_ocr_model_status() -> IpcResponse<OcrModelStatus>
library_start_ocr({ documentId }) -> IpcResponse<OcrJobRecord>
library_ocr_status({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_pause_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_resume_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_cancel_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_retry_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_document_fragments({ documentId, page? }) -> IpcResponse<DocumentFragment[]>
```

## 本地资料库契约（工期 2）

SQLite 数据库位于应用数据目录的 `library.sqlite3`，当前 migration 版本为 `5`，且重复运行不删除数据。工期 2 建立的私有表为：

```text
source_roots(id, kind, canonical_path, display_name, created_at_ms, active)
documents(id, source_root_id, canonical_path, display_name, format, size_bytes,
          modified_at_ms, file_identity, content_sha256, status, content_state, ...)
scan_jobs(id, source_root_id, state, scanned_count, changed_count, failed_count,
          retry_count, error_code, created_at_ms, updated_at_ms)
scan_events(id, scan_job_id, document_id?, kind, occurred_at_ms, details_json)
```

- `SourceKind` 是 `directory|single_file`；文件格式记录 DOCX/PPTX/XLSX、PDF、Markdown/TXT/CSV 和常见图片。扫描器只登记元数据并将正文置为 `contentState: "pending"`，工期 5 OCR 通过页片段接口填充图片/PDF 内容。
- 扫描前 canonicalize 来源和候选路径，仅扫描授权目录或单文件。隐藏目录、系统目录、回收站、`node_modules`、符号链接/Junction/reparse point 默认跳过，且跳过原因写入 `ScanEvent`。
- 每个可登记文件保存大小、修改时间、`file-id` 的 Windows File ID（可用时）和 SHA-256。重命名先以 File ID 追踪；File ID 不可用时，仅在唯一失效路径匹配 SHA-256 时作为辅助重定位，避免合并同内容的真实重复文件。
- `ScanEvent.kind` 为 `discovered|updated|renamed|missing|skipped|error`。运行中的任务在重新打开数据库时转为 `paused`；任务支持 `queued|running|paused|cancelled|failed|completed` 和重试计数。
- 错误使用稳定机器码，例如 `UNAUTHORIZED_PATH`、`EXCLUDED_PATH`、`PERMISSION_DENIED`、`HASH_READ_FAILED`、`INVALID_JOB_STATE`。错误消息和事件详情不包含绝对路径或文档正文。
- `library_start_scan` 和 watcher 轮询只创建持久化队列任务并立即返回；后台 worker 在独立 SQLite 连接执行元数据扫描，按文件更新进度，暂停/取消在文件边界生效，恢复/重试重新入队。`library_scan_events` 是结构化进度和结果事件入口。
- `notify` 只被封装在 `library/watcher.rs`；监听事件必须先过滤到授权根目录，再由 `poll_watch` 创建同一套增量扫描任务。下一阶段不得直接使用 `notify` 或 SQLite 私有表。

### 搜索与资料组织契约（工期 3）

- migration v2 新增 `collections`、`tags`、`document_collections`、`document_tags`、`document_usage`、`document_search_state`、`document_search_content` 和 `document_fts`。集合与标签只用 `DocumentId` 多对多引用，绝不移动、复制或更改原文件路径。
- `document_fts` 是 SQLite FTS5 `trigram` 索引，字段为 `title`、`body`、`path`、`tags` 和 `ocr`；扫描器不做正文提取，OCR worker 增量填充 `ocr`。三字及以上查询使用 FTS5 中文子串匹配；一至两字查询以标题、路径和标签 `LIKE` 回退。
- `library_search({ text?, formats?, modifiedAfterMs?, modifiedBeforeMs?, sourceRootIds?, collectionId?, tagIds?, statuses?, favoriteOnly?, recentOnly?, limit?, offset? }) -> IpcResponse<SearchResults>` 是稳定查询 API。结果使用 `DocumentId`，包含展示元数据、匹配片段、标签、集合、收藏状态和 `SourceLocator`；绝对路径不是主键，UI 仅显示路径尾部。
- FTS `bm25` 权重固定为标题 `12`、正文 `1`、路径 `4`、标签 `3`、OCR `1`。过滤条件均为 AND 组合；收藏和最近使用来自 `document_usage`，最近使用以选择结果时的时间戳排序。
- `SourceLocator` 对未处理文档仍为 `available: false` 并给出中文降级原因；OCR/text-layer 页片段可返回 `page` 和可选 `boundingBox`，不得移除或重命名既有字段。
- 搜索相关 IPC 还包括 `library_list_sources`、`library_list_collections`、`library_list_tags`、`library_create_collection`、`library_create_tag`、`library_set_collection_membership`、`library_set_tag_membership`、`library_set_favorite`、`library_record_recent_use` 和 `library_rebuild_search_index`；全部沿用既有成功/失败信封。
- 扫描器是唯一文件/元数据入口。每个文档元数据 upsert 后尝试刷新索引，索引状态独立保存在 `document_search_state`；索引写入失败不会回滚或删除 `Document` 元数据，`library_rebuild_search_index` 可从已登记数据重建。

### OCR 与页片段契约（工期 5）

- migration v4 新增 `ocr_jobs`、`ocr_pages`、`ocr_text_boxes` 和 `ocr_metrics`，全部以既有 `DocumentId` 外键关联；OCR 不得创建平行文档主表或绕过资料库访问路径。
- `ocr_jobs` 复用任务状态 `queued|running|paused|cancelled|failed|completed`、重试计数和独立 SQLite worker。重开时 `running -> paused`，暂停/取消在页边界生效，按文档重新执行创建新的 OCR 任务。
- PDF 先用 `lopdf` 本地提取有效文本层；任何有效文本层 PDF 保存 `text_layer` 页片段并跳过 OCR。无文本层 PDF 仅用本机 `pdftoppm` 生成临时页图；PNG/JPG/JPEG/TIFF/BMP 直接逐页处理。原文件绝不修改。
- OCR 结果写入 `DocumentFragment { documentId, page, source: ocr|text_layer|blank, text, confidence?, width, height, rotationDegrees, boxes, sourceLocator }`。`boxes[].boundingBox.points` 是原始页像素坐标；`SourceLocator` 只增加可选 `boundingBox`，未改名/移除前期字段。
- 所有页文本增量汇总到既有 `document_search_content.ocr` 并刷新 `document_fts`；搜索 OCR 命中优先给出命中文本框的页和坐标。
- PP-OCRv6 Tiny / ONNX Runtime CPU 1.26.0 只能从应用数据目录旁 `ocr-models/` 读取，本应用不自动下载模型。验收资产的上游提交、SHA-256、离线取得方式和真实小样本性能见 `docs/ocr-models.md`；模型加载后推理完全离线。
- 工期 6 唯一允许读取的正文接口是 `library_document_fragments({ documentId, page? })`；不得访问 `ocr_*` 私有表、canonical path 或临时页图。

### AI 助手、上下文与权限契约（工期 6）

- `AiProvider` 是 Rust 内部可替换接口，`MockProvider` 用于自动化测试；`OpenAiResponsesProvider` 只在 Rust 侧通过 Responses API SSE 转换 `TextDelta`、`ToolRequest` 和 `Completed` 事件。前端永远不接触 API Key。
- API Key 仅从 Windows Credential Manager 的 `moji/openai/api-key` generic credential 读取；无 Key、错误 Key、超时、限流、断网和取消均返回稳定 `AI_*` 错误，不回显响应正文或凭据。仓库、日志、数据库和崩溃信息不得保存 Key。
- `ai_context_preview`/`ai_chat` 只接受用户明确给出的 `DocumentId`、`@文档(id)` 和页选择；通过 `LibraryService::ocr_fragments` 读取统一片段，不读取 SQLite 私有表、canonical path 或临时图片。预览返回来源、页、字符规模、预计 token、截断标记、权限和 `untrusted=true`，确认前不得发送。
- 上下文正文包在 `<untrusted_text>` 中，系统提示明确规定文档内容不是指令。文档内文字不能改变系统提示、上下文范围、权限级别或工具白名单。
- 权限级别为 `suggest`（只读/建议，禁止写回）、`assist`（只产生待审阅变更，`approved=true` 后逐项或整批写回）和 `autonomous`（仅当前会话 `authorizedDocumentIds`，写回前必须 Snapshot + SHA-256 冲突检查）。所有写回复用 `document_save`，不提供删除、移动、系统命令、未选路径读取或 API Key 工具。
- 工具注册分为只读、建议、写入、禁止四类；每个工具调用执行名称、参数、权限和目标校验。`ai_actions`（migration v5）记录会话、Document ID、权限、工具、结果和脱敏细节，不记录正文、Key 或绝对路径。`ai_list_actions` 只返回审计结构。

稳定 AI IPC：

```text
ai_context_preview(ContextRequest) -> IpcResponse<ContextPreview>
ai_chat(AiChatRequest) -> IpcResponse<AiChatResult>
ai_chat_stream(AiChatRequest, Channel<AiStreamEvent>) -> IpcResponse<AiChatResult>
ai_apply_change(AiChangeRequest) -> IpcResponse<AiChangeResult>
ai_list_actions({ sessionId? }) -> IpcResponse<AiActionRecord[]>
```

## EditorAdapter 契约（工期 1）

编辑器层只依赖 `src/editor/types.ts` 的 `EditorAdapter`，不直接调用 ZetaOffice/zetajs 或 UNO。最小接口为：

```text
healthCheck() -> EditorResult<EditorHealth>
open(sourcePath, { readOnly? }) -> EditorResult<DocumentHandle>
readOnlyPreview(handle) -> EditorResult<Preview>
edit(handle, operation) -> EditorResult<EditReceipt>
saveAs(handle, targetPath, { format? }) -> EditorResult<SaveReceipt>
close(handle) -> EditorResult<null>
```

`EditorResult` 使用 `status: success|error`、`outcome: PASS|DEGRADED|FAIL`；失败包含稳定 `EditorError.code`、`retryable`、脱敏 `details` 和 `read-only-preview` 回退。`ZetaOfficeAdapter` 的 runtime bridge 是唯一允许接触 `Module.zetajs`、UNO 对象、打开/保存内部 API 的位置；`MockEditorAdapter` 仅用于契约测试，不能作为 POC 证据。`saveAs` 在 Windows 大小写不敏感路径归一化后拒绝覆盖源文件。

浏览器 POC 的实现位于 `public/editor-poc/`：`zetaHelper.js`/`zeta.js` 仅作为 `zetajs@1.2.0` 的运行时封装，`office_thread.js` 在内部处理 Writer/Impress/Calc 的 UNO 对象。页面只向主线程返回结构化回环结果；业务代码不得依赖这些内部对象。真实结果和每个样本的源/输出哈希在 `docs/editor-poc/results.json`。

## 日志约定

Rust 使用 `tracing`。日志事件至少包含稳定的 `event` 字段；IPC 完成事件还包含 `command` 和 `outcome`。当前约定示例：

```text
event="application_started" application="moji-desktop" version="0.1.0"
event="ipc_command_completed" command="health_check" outcome="success"
```

禁止记录 API Key、用户文档正文、未经脱敏的绝对路径和完整 IPC 请求体。工期 0 只输出到进程日志，不引入日志文件轮转或远程采集。

## 查看器、批注与安全写回契约（工期 4）

- `document_open({ documentId, mode })` 是唯一的产品打开入口；前端只传稳定 `DocumentId`，Rust 从资料库解析授权 canonical path，不接受 React 拼接路径。`mode` 为 `read-only|edit|assist`，协助修改模式只记录用户修改，不接 AI。
- `AdapterRegistry` 按 DocumentFormat 选择 Office、PDF.js、Markdown/TXT/CSV 或只读降级适配器。Office 复用 `EditorAdapter`，但桌面 ZetaOffice runtime bridge 未配置时必须明确只读降级；不得把浏览器 POC 结果当产品 runtime。
- `document_open` 返回 `sessionId`、展示元数据、哈希、文本内容或受控 PDF base64 内容、能力和 `SourceLocator`。PDF.js 当前渲染第一页；Markdown/TXT/CSV 使用同一文本编辑器；图片和未支持格式只读。
- `document_save` 只允许 Markdown/TXT/CSV。保存前重新读取源文件并比较打开时 SHA-256；哈希变化返回 `DOCUMENT_CONFLICT`，details 提供放弃、另存、比较、恢复动作。正常写回先在 `document_snapshots` 保存原始字节和哈希，再经过临时文件/备份替换并校验新哈希；失败尝试恢复备份。
- `document_snapshots` 保存 `SnapshotRecord`，`document_restore_snapshot` 恢复前再次创建当前版本快照并做哈希冲突校验。`document_annotations` 保存页码、幻灯片、段落、字符范围、引用文本和 `stable` 标记；无法稳定定位时必须显示引用文本降级，不静默猜测位置。
- 工期 4 的迁移增量为 v3（当前工作树后续迁移总版本可能为 v4）；新增 `document_open/save/close/list_snapshots/restore_snapshot/list_annotations/add_annotation/delete_annotation` IPC，沿用统一成功/失败信封和稳定错误码。
