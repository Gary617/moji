# 文档管理系统分阶段实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将《文档管理系统-产品技术方案》拆成 9 个可独立交付、可测试、可跨窗口恢复的开发工期，并为每个新窗口提供一段可直接粘贴的完整提示词。

**Architecture:** 采用 Tauri 2 + React + Rust 的本地单体架构。Rust 负责文件系统、数据库、索引、OCR、版本和权限边界，React 负责界面与编辑器宿主，AI 请求只通过 Rust 代理。高风险的 Office 编辑器 POC 在索引和 AI 之前单独验证。

**Tech Stack:** Windows 10/11, Tauri 2, React, Rust, SQLite/FTS5, SQLCipher（或等价加密封装）, ZetaOffice/zetajs, PDF.js, PP-OCR + ONNX Runtime, OpenAI Responses API。

---

## 一、固定的跨窗口协议

### 1. 事实优先级

每个新窗口都按以下优先级判断事实，不依赖上一个窗口的口头记忆：

1. 当前代码、测试和最近一次提交。
2. `docs/PROJECT_CONTEXT.md`：长期稳定事实，只记录架构、目录、命令和接口约束。
3. `docs/STATUS.md`：当前工期状态和下一步动作。
4. `docs/DECISIONS.md`：已确认的技术决策及替代方案。
5. 当前工期的 `docs/handoffs/phase-XX.md`。
6. 聊天记录和模型记忆只能作为线索，不能覆盖以上内容。

### 2. 每个工期必须留下的文件

每个工期结束时更新：

- `docs/STATUS.md`：当前阶段、已完成、未完成、阻塞、下一条具体命令。
- `docs/DECISIONS.md`：本阶段新增的决策，包含理由和日期。
- `docs/handoffs/phase-XX.md`：给下一个窗口的交接快照。
- `docs/TEST_MATRIX.md`：新增测试样本、命令和结果。

交接快照固定包含：

```text
阶段:
目标:
本次提交:
改动文件:
新增接口/数据库变更:
已验证命令及结果:
已知问题:
未做事项（明确不要误做）:
下一窗口第一步:
```

### 3. 新窗口使用方式

下面 9 个工期各自提供一段完整提示词，不需要再与“通用提示词”拼接。实际执行时：

1. 一个工期使用一个独立的新窗口。
2. 新窗口的第一条消息直接粘贴对应工期的完整提示词。
3. 不粘贴上个窗口的完整聊天记录，只依赖上阶段提交和 `docs/handoffs/phase-XX.md`。
4. 上阶段未通过验收或没有 handoff 时，不允许模型假设其已经完成。
5. 当前工期结束并生成提交与 handoff 后，关闭窗口，再启动下一工期的新窗口。

### 4. Git 与上下文控制

- 正式开发前在项目目录初始化 Git；每个工期使用独立分支，例如 `codex/phase-01-editor-poc`。
- 一个窗口最多围绕一个工期；一个提交只完成一个垂直目标。
- 不在窗口末尾粘贴大段源码；只记录文件路径、接口、命令和结果。
- 发现范围扩大时先停下来，把新需求放进 `docs/STATUS.md` 的“后续工期”，不要偷偷带入当前工期。
- 下一个窗口优先执行交接中的“下一窗口第一步”，然后再读计划，避免重新探索全仓库。

### 5. 新窗口衔接速查

| 新窗口 | 必须先验证的上阶段交接 | 本阶段应产出的交接 | 建议分支 |
| --- | --- | --- | --- |
| 工期 0 | 无；读取产品方案与本计划 | `phase-00.md` | `codex/phase-00-foundation` |
| 工期 1 | `phase-00.md` | `phase-01.md` | `codex/phase-01-editor-poc` |
| 工期 2 | `phase-01.md` 及 POC 决策 | `phase-02.md` | `codex/phase-02-library-indexer` |
| 工期 3 | `phase-02.md` 及数据库/扫描契约 | `phase-03.md` | `codex/phase-03-search-organization` |
| 工期 4 | `phase-01.md` 与 `phase-03.md` | `phase-04.md` | `codex/phase-04-viewer-editor` |
| 工期 5 | `phase-02.md` 至 `phase-04.md` | `phase-05.md` | `codex/phase-05-ocr-pipeline` |
| 工期 6 | `phase-03.md` 至 `phase-05.md` | `phase-06.md` | `codex/phase-06-ai-orchestrator` |
| 工期 7 | `phase-02.md` 至 `phase-06.md` | `phase-07.md` | `codex/phase-07-security-hardening` |
| 工期 8 | 全部 handoff 与发布阻断项 | `phase-08.md` | `codex/phase-08-release` |

---

## 二、工期划分

### 工期 0：工程基线与可运行骨架

**目的**：建立可编译、可测试、可回滚的 Tauri + React + Rust 项目，并固定模块边界。

**范围**：仓库初始化、开发脚本、基础窗口、Rust/前端健康检查 IPC、日志约定、目录约定、文档交接文件。暂不实现扫描、编辑器、数据库业务和 AI。

**交付与验收**：

- `pnpm install`、`pnpm build`、`cargo test`（或项目等价命令）通过。
- Windows 本地启动桌面窗口，点击健康检查按钮能返回 Rust 版本信息。
- 建立 `PROJECT_CONTEXT.md`、`STATUS.md`、`DECISIONS.md`、`TEST_MATRIX.md`。
- 首次提交可在干净目录重新构建。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 0：工程基线与可运行骨架。这是一个新的开发窗口，请从工作区事实重新建立上下文，不要依赖其他窗口的聊天记忆。

【工作区】
C:\Users\Gary\Desktop\墨集

【开始前必须检查】
1. 阅读《文档管理系统-产品技术方案.docx》。
2. 阅读 docs/plans/2026-08-18-document-management-system-plan.md。
3. 列出当前目录，确认是否已经存在项目代码、package.json、Cargo.toml、src-tauri 或测试。
4. 执行 git rev-parse --show-toplevel。只有输出等于当前项目目录时才能使用现有 Git；如果输出指向 C:\Users\Gary 或其他父目录，不得在父仓库提交，应在当前项目目录初始化独立 Git 仓库。
5. 检查现有文件和用户修改，不得删除或覆盖来源不明的内容。

【本工期目标】
建立可编译、可测试、可回滚的 Tauri 2 + React + TypeScript + Rust 最小工程，固定前端、Rust、测试和文档目录边界。实现最小 health_check IPC，使前端可以显示 Rust 后端状态和应用版本。

【必须完成】
1. 建立项目结构和依赖锁文件，优先使用当前稳定版本并记录确切版本。
2. 建立统一 IPC 成功/失败返回结构和最小日志约定。
3. 建立前端单元测试、Rust 单元测试和生产构建命令。
4. 创建 docs/PROJECT_CONTEXT.md、docs/STATUS.md、docs/DECISIONS.md、docs/TEST_MATRIX.md。
5. PROJECT_CONTEXT 必须记录目录结构、架构边界、规范命令、版本要求和错误返回格式。
6. 创建或切换到 codex/phase-00-foundation 分支；如果分支已存在则继续使用，不得覆盖提交历史。

【明确禁止】
不要实现文件扫描、数据库业务、Office/PDF 编辑器、全文检索、OCR、AI、账号、云同步或复杂 UI。不要为了演示而加入后续阶段的假数据层。

【执行方式】
先用 5-10 行报告当前基线、计划创建/修改的准确文件、验证命令和风险，然后继续实施；只有遇到会改变架构或造成数据损失的选择时才停下来询问。采用小步测试和小提交，不要只输出计划而不编码。

【验收】
必须运行 PROJECT_CONTEXT 中记录的安装、前端测试、Rust 测试、生产构建命令，并手工确认桌面窗口能启动、前端能收到 health_check 响应。任何无法执行的验证都要明确说明原因，不能写成“应该通过”。

【结束交接】
更新 STATUS、DECISIONS、TEST_MATRIX，创建 docs/handoffs/phase-00.md。handoff 必须包含提交号、改动文件、规范命令、测试结果、已知问题、明确未做事项和工期 1 的第一步。创建可回滚提交，建议提交信息：chore: establish application foundation。

【最终回复格式】
只报告：完成项、验证命令及结果、未完成/风险、提交号、handoff 路径、工期 1 新窗口应先读取的文件。
```

**下一工期衔接**：工期 1 只读取骨架和交接文件，在既定目录新增编辑器适配边界，不重新选择框架。

### 工期 1：ZetaOffice/zetajs Office 编辑器 POC

**目的**：先验证最高风险的 DOCX/PPTX/XLSX 打开、修改、保存、重开能力。

**范围**：编辑器适配器接口、ZetaOffice/zetajs 最小集成、代表性样本矩阵、错误分类和回退到只读预览。暂不接入索引、OCR、AI 和正式版本库。

**交付与验收**：

- 20-30 个代表性 DOCX/PPTX/XLSX 样本可打开并重新打开。
- 至少覆盖表格、图片、批注、图表、中文字体和复杂排版。
- 每个样本记录“成功、降级、失败及原因”；失败不能静默覆盖原文件。
- 形成 `EditorAdapter` 接口和 mock，供后续编辑器层使用。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 1：ZetaOffice/zetajs Office 编辑器 POC。这是一个新的开发窗口，必须通过工期 0 的代码、提交和交接文件恢复上下文，不得依赖聊天记忆。

【先恢复上阶段事实】
1. 在项目目录执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 docs/PROJECT_CONTEXT.md、docs/STATUS.md、docs/DECISIONS.md、docs/TEST_MATRIX.md、docs/handoffs/phase-00.md。
3. 核对 phase-00.md 中的提交是否存在，重新运行其中的核心测试和构建命令。
4. 若工期 0 未完成、测试失败或 handoff 缺失，先报告差异；只允许做恢复工期 1 所必需的小修复，不能假设基线正常。
5. 从工期 0 完成提交创建或继续 codex/phase-01-editor-poc 分支，保留当前用户改动。

【承接关系】
沿用现有 Tauri/React/Rust 工程、IPC 返回结构、日志规范和测试命令。只在既定边界内增加 EditorAdapter；不要重新选择桌面框架，也不要让业务代码直接依赖 ZetaOffice/zetajs 内部 API。

【本工期目标】
验证 Windows WebView2/Tauri 环境中 DOCX、PPTX、XLSX 的打开、修改、保存、关闭和重新打开能力，并形成可替换的编辑器适配接口和明确的 POC 结论。

【必须完成】
1. 先查阅当前版本官方文档，记录来源、版本、许可证和 Windows 支持状态。
2. 定义最小 EditorAdapter：healthCheck、open、readOnlyPreview、edit、saveAs、close；错误必须结构化。
3. 将 ZetaOffice/zetajs 封装在适配器内部，并提供可测试 mock，但 mock 不能作为 POC 通过证据。
4. 建立 20-30 个代表性 DOCX/PPTX/XLSX 样本矩阵，覆盖表格、图片、批注、图表、中文字体和复杂排版。
5. 建立 round-trip 流程：打开 -> 修改 -> 另存 -> 关闭 -> 重开 -> 校验内容与文件完整性。
6. 对每个样本记录 PASS、DEGRADED 或 FAIL、失败原因和降级方案。

【明确禁止】
不要实现目录扫描、数据库、全文检索、OCR、标签、AI 或正式版本快照。不得覆盖样本原件；保存失败、格式损坏或 API 不可用时不得伪造成功结果。

【验收门】
自动化测试、生产构建和 POC 测试脚本可重复运行。兼容性矩阵必须给出真实结果。最终结论只能是 PASS、DEGRADED 或 BLOCKED：若 BLOCKED，不得让下一工期默认依赖 Office 写回，必须在 handoff 中列出“更换编辑器、首版只读、延后写回”三个决策选项。

【结束交接】
更新 PROJECT_CONTEXT 中的 EditorAdapter 契约和依赖版本，更新 STATUS、DECISIONS、TEST_MATRIX，创建 docs/handoffs/phase-01.md。记录 phase-01 提交号、POC 结论、稳定接口、样本结果、已知问题、禁止下一阶段依赖的内部实现。创建可回滚提交，建议提交信息：feat: validate office editor integration。

【最终回复格式】
只报告：POC 结论、样本通过/降级/失败数量、验证命令、接口路径、风险、提交号、handoff 路径，以及工期 2 是否具备开始条件。
```

**下一工期衔接**：工期 2 只依赖 `EditorAdapter` 契约和 POC 结论；编辑器内部实现不可被索引模块直接调用。

### 工期 2：本地资料库、目录授权与增量索引

**目的**：建立“不移动原文件”的本地文档登记和增量扫描能力。

**范围**：用户授权目录/单文件导入、排除规则、文件元数据、canonical path、Windows File ID、哈希、扫描队列、文件监控、暂停/恢复/失败重试。先登记元数据，再异步提取正文。

**交付与验收**：

- 未授权目录不会被扫描；系统目录、隐藏目录、回收站、`node_modules`、Junction 默认跳过。
- 文件新增、修改、删除、重命名可增量更新；路径改变可通过 File ID/哈希追踪。
- SQLite migration 可重复执行，扫描支持取消、恢复和失败重试。
- 测试覆盖权限不足、外部删除、锁定文件和重复导入。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 2：本地资料库、目录授权与增量索引。这是一个新的开发窗口，请仅通过仓库、工期 1 提交和 handoff 恢复上下文。

【先恢复上阶段事实】
1. 执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX、phase-00.md 和 phase-01.md。
3. 核对 phase-01 的提交与 POC 结论，运行 handoff 中的基线测试。
4. 如果 POC 为 BLOCKED，确认 DECISIONS 中已经选择编辑器降级策略；若没有决策，停止业务实现并报告，不要自行选择。
5. 从上一阶段完成提交创建或继续 codex/phase-02-library-indexer 分支。

【承接关系】
保留工期 0 的 IPC/错误规范，数据库和扫描模块只能通过稳定 Document ID 与后续模块交互。Office 编辑器内部实现不能被扫描器引用；工期 1 的 POC 结论只决定文件能力标记。

【本工期目标】
建立“不移动原文件”的本地文档登记系统，实现用户授权来源、元数据数据库、增量扫描、文件变化追踪和可恢复任务队列。

【必须完成】
1. 设计并测试数据库 migration，以及 Document、SourceRoot、ScanJob 等最小领域模型。
2. 支持授权目录、单文件和文件夹导入；所有路径先规范化，再验证是否位于授权范围。
3. 默认排除系统目录、隐藏目录、回收站、node_modules 和 Windows Junction，规则可查看但不能静默扩大授权范围。
4. 先登记路径、格式、大小、mtime、Windows File ID 和哈希等元数据，正文提取异步排队。
5. 监听新增、修改、删除和重命名；优先使用 File ID，必要时使用哈希辅助重定位。
6. 扫描任务支持取消、暂停、恢复、失败重试和结构化进度事件。
7. 对重复导入、权限不足、锁定文件、外部删除和路径变化编写自动测试。

【明确禁止】
不得移动、复制、重命名或删除用户原文件。不要实现全文搜索、OCR、标签 UI、编辑器写回或 AI。不要把绝对路径作为前端长期主键。

【验收】
migration 可在空库和已有库重复运行；使用临时目录完成新增、修改、删除、重命名、权限失败和任务恢复测试；运行全部前端/Rust 测试和生产构建；记录扫描样本规模、耗时和失败数。

【结束交接】
更新 PROJECT_CONTEXT 的 Document ID、数据库表、migration、扫描事件和规范命令；更新 STATUS、DECISIONS、TEST_MATRIX；创建 docs/handoffs/phase-02.md。记录稳定接口、数据库版本、测试结果、已知问题和工期 3 允许依赖的事件。提交建议：feat: add authorized local document indexer。

【最终回复格式】
报告：扫描/监控完成项、数据库版本、测试样本和结果、权限边界、未完成项、提交号、handoff 路径、工期 3 的唯一数据入口。
```

**下一工期衔接**：工期 3 以 `Document` 和扫描事件为唯一数据源，不再次遍历文件系统实现“搜索”。

### 工期 3：全文检索与资料组织

**目的**：让用户能搜索、筛选和用虚拟集合/标签组织文档，而不改变物理目录。

**范围**：正文/标题/路径/标签/OCR 字段的 FTS5 trigram 索引、搜索结果片段和来源定位、集合、标签、收藏、最近使用、过滤器和中间列表 UI。

**交付与验收**：

- 中文子串搜索、标题/路径/标签加权搜索和格式/时间/来源/集合筛选可用。
- 集合和标签是多对多引用，不移动、不复制原文件。
- 索引更新失败不会破坏元数据；查询结果能定位到页码、幻灯片或段落来源（已有信息不足时明确标记未实现）。
- 代表性数据集上已索引搜索 p95 < 300ms，记录测试规模和硬件。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 3：全文检索与资料组织。这是一个新的开发窗口，必须从工期 2 的提交、数据库契约和 handoff 恢复上下文。

【先恢复上阶段事实】
1. 执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX 和 docs/handoffs/phase-02.md。
3. 核对 phase-02 提交、migration 版本、Document ID 和扫描事件，重新运行扫描器核心测试。
4. 如果数据库或扫描测试失败，先判断是否为本阶段可做的小修复；不得另写一套文件遍历来绕过工期 2。
5. 从上一阶段完成提交创建或继续 codex/phase-03-search-organization 分支。

【承接关系】
Document 和扫描事件是搜索索引的唯一数据源。搜索、集合和标签全部引用稳定 Document ID，不得直接修改物理文件，也不得改变工期 2 的授权模型。

【本工期目标】
实现中文友好的全文检索、筛选、虚拟集合、标签、收藏、最近使用以及可工作的三栏资料库界面。

【必须完成】
1. 设计 FTS5 trigram 索引和可重复 migration，覆盖标题、正文预留字段、路径显示字段、标签和 OCR 预留字段。
2. 实现标题/路径/标签权重、中文子串、匹配片段和格式/时间/来源/集合/状态过滤。
3. 实现 Collection、Tag 多对多关系、收藏和最近使用，不复制、不移动原文件。
4. 查询 API 返回 Document ID、匹配片段、来源定位结构和必要展示字段，禁止用绝对路径作为主键。
5. 实现最小三栏资料库 UI：导航、结果列表、工作区占位；完整处理空、加载、无结果和错误状态。
6. 增量索引失败不能损坏 Document 元数据，并可重建索引。

【明确禁止】
不要实现 OCR 识别、Office/PDF 写回、批注、版本快照和 AI。不要为了搜索再次遍历未授权文件系统。

【验收】
自动测试覆盖中文子串、字段权重、组合过滤、集合/标签多对多、增量更新和索引重建；在记录了数量与硬件的代表性数据集上测量已索引查询 p95，目标低于 300ms；运行全部测试和构建。

【结束交接】
更新 PROJECT_CONTEXT 的搜索 API、FTS schema、来源定位和 UI 状态契约；更新 STATUS、DECISIONS、TEST_MATRIX；创建 docs/handoffs/phase-03.md。记录性能数字、稳定接口、未实现的定位能力和工期 4 不得改变的查询契约。提交建议：feat: add full text search and organization。

【最终回复格式】
报告：搜索能力、数据模型、性能数字、UI 状态、验证结果、风险、提交号、handoff 路径、工期 4 可依赖的稳定契约。
```

**下一工期衔接**：工期 4 在稳定的 Document ID、查询 API 和三栏 UI 上接入查看器/编辑器，不改变搜索数据契约。

### 工期 4：查看器、编辑器适配与批注/版本快照

**目的**：在中间工作区完成阅读、编辑、批注和可恢复写回。

**范围**：PDF.js 阅读/批注、Markdown/TXT/CSV 编辑、工期 1 Office 适配器接入、Annotation 锚点、写回前快照、哈希冲突检测、只读/编辑/协助修改模式。

**交付与验收**：

- 从搜索结果打开文档，能按 Document ID 加载正确适配器。
- 批注持久化并能回到页码/段落/字符范围；文件外部修改时阻止静默覆盖。
- 写回前生成 Snapshot，恢复后原文件内容可验证；写回失败保留原文件。
- UI 具备加载、只读、冲突、损坏和恢复状态。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 4：查看器、编辑器适配、批注和版本快照。这是一个新的开发窗口，请从工期 1 的编辑器契约和工期 3 的搜索契约恢复上下文。

【先恢复上阶段事实】
1. 执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX、phase-01.md、phase-02.md、phase-03.md。
3. 核对 EditorAdapter 的真实 POC 状态，以及 Document ID、查询 API、来源定位和数据库版本。
4. 重新运行编辑器 POC 的可用测试与搜索核心测试；如果 Office POC 为 DEGRADED，只实现 handoff 允许的能力。
5. 从上一阶段完成提交创建或继续 codex/phase-04-viewer-editor 分支。

【承接关系】
查看器通过 Document ID 和受控后端命令加载文档，不从 React 自行拼接绝对路径。Office 使用工期 1 的 EditorAdapter；PDF、Markdown/TXT/CSV 使用同一 Adapter Registry；不得改变工期 3 的搜索返回契约。

【本工期目标】
让用户从搜索结果打开文档，完成安全阅读、可支持格式的编辑、批注、写前快照、冲突检测和版本恢复。

【必须完成】
1. 建立 Adapter Registry，根据格式和能力选择 Office、PDF.js、Markdown/TXT/CSV 适配器或只读降级。
2. 实现统一加载、保存、关闭、错误和能力查询接口。
3. 实现 Annotation 数据与页码/段落/字符范围锚点；无法稳定定位时必须明确降级规则。
4. 每次修改原文件前创建 Snapshot，记录原始哈希、目标 Document ID 和时间。
5. 保存前重新计算哈希；外部修改、锁定或只读时阻止静默覆盖，并提供放弃、另存、比较或恢复入口。
6. 实现只读、正文编辑和协助修改的 UI 状态，但协助修改暂不接 AI。

【明确禁止】
不要实现 OCR 和 AI。不得把原文件复制成资料库主副本，不得绕过 Snapshot 直接写回，不得超出 Office POC 已验证能力。

【验收】
使用样本矩阵测试打开、只读降级、批注保存/重载、正常保存/重开、外部修改冲突、锁定文件、保存失败、Snapshot 创建和恢复；运行全部测试和生产构建；确认失败不会损坏原文件。

【结束交接】
更新 PROJECT_CONTEXT 的 Adapter Registry、Annotation、Snapshot、冲突状态和写回流程；更新 STATUS、DECISIONS、TEST_MATRIX；创建 docs/handoffs/phase-04.md。记录支持矩阵、稳定接口、失败场景、恢复证据和工期 5 应复用的来源定位结构。提交建议：feat: add document viewers editing and recovery。

【最终回复格式】
报告：格式支持、写回和恢复结果、测试样本、已知降级、提交号、handoff 路径，以及工期 5 可写入的正文/定位契约。
```

**下一工期衔接**：工期 5 只把 OCR 结果写入既定正文/来源定位/FTS 契约，不改变查看器和批注模型。

### 工期 5：OCR 与后台任务队列

**目的**：为扫描 PDF 和图片提供本地 OCR、坐标和可搜索文本。

**范围**：PP-OCR 中文/英文模型、ONNX Runtime CPU、PDF 是否有文本层判断、页级 OCR、文本框坐标、后台队列、暂停/恢复/重试、进度和 FTS 入库。

**交付与验收**：

- 无文本层 PDF 和 PNG/JPG/TIFF/BMP 可进入 OCR 队列；有文本层 PDF 不重复 OCR。
- OCR 文本、页码和坐标可检索并回到原始页。
- OCR 在后台执行，不阻塞主界面；失败可重试，模型加载失败有明确提示。
- 记录模型版本、样本准确率、耗时和资源占用。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 5：OCR 与后台任务队列。这是一个新的开发窗口，必须复用工期 2 的任务机制、工期 3 的 FTS 契约和工期 4 的来源定位。

【先恢复上阶段事实】
1. 执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX，以及 phase-02.md、phase-03.md、phase-04.md。
3. 核对 Document ID、任务队列、FTS 字段、Snapshot 和来源定位结构，运行相关核心测试。
4. 如果前述契约互相冲突，先记录冲突并做最小兼容方案，不得另建平行 OCR 文档表绕过现有模型。
5. 从上一阶段完成提交创建或继续 codex/phase-05-ocr-pipeline 分支。

【承接关系】
OCR 只能消费授权 Document ID，通过既有后台任务和来源定位写入结果，并增量更新现有 FTS。OCR 不直接修改原文件，不绕过资料库数据库访问私有路径。

【本工期目标】
为无文本层 PDF 和扫描图片提供本地中文/英文 OCR，保存页码与文本框坐标，并支持后台执行、检索和原页定位。

【必须完成】
1. 接入 PP-OCR 中文/英文模型和 ONNX Runtime CPU，锁定并记录模型及运行时版本。
2. 检测 PDF 是否已有有效文本层；有文本层时提取并跳过重复 OCR，无文本层时按页排队。
3. 支持 PNG、JPG、JPEG、TIFF、BMP，并保存 Document ID、页码、文本、置信度和文字框坐标。
4. 复用后台队列实现进度、取消、暂停、恢复、失败重试和按文档重新执行。
5. OCR 结果增量写入现有全文索引，搜索结果能定位到原始页和区域。
6. 模型缺失、损坏文件、空白页和识别失败必须返回结构化状态。

【明确禁止】
不得上传文档、调用 AI API、阻塞 React 主线程或修改原文件。不要修改查看器/批注契约，除非为兼容来源定位做经过记录的最小扩展。

【验收】
使用中文、英文、旋转页、空白页、有/无文本层 PDF、扫描图片、损坏文件和模型缺失样本；测试任务恢复和重复执行；记录样本数、准确率、单页耗时、内存和失败率；运行全部测试和构建。

【结束交接】
更新 PROJECT_CONTEXT 的 OCR 模型、任务状态、结果 schema、坐标和 FTS 写入契约；更新 STATUS、DECISIONS、TEST_MATRIX；创建 docs/handoffs/phase-05.md。记录性能数字、模型获取方式、离线行为和工期 6 可读取的统一文档片段接口。提交建议：feat: add local OCR processing pipeline。

【最终回复格式】
报告：支持格式、OCR/定位结果、性能数据、失败场景、提交号、handoff 路径、工期 6 只能调用的文档片段接口。
```

**下一工期衔接**：工期 6 只读取统一的文档片段、来源和权限接口，不自行读取磁盘文件或数据库私有表。

### 工期 6：AI 对话、@文档上下文与三级权限

**目的**：在可控权限下提供建议、协助修改和自主修改能力。

**范围**：Rust `AiProvider`、OpenAI Responses API 流式响应、Windows Credential Manager、`@文档` 解析、上下文预览/分段/检索、只读/建议/写入工具、工具白名单、变更审阅、AiAction 审计。

**交付与验收**：

- 前端不接触 API Key；日志和错误信息不泄露 Key 或绝对路径。
- 默认只发送用户明确选中的文档/片段；上下文来源、规模和权限在发送前可见。
- 建议模式不能写入；协助修改需用户接受；自主修改只能作用于授权目标且写回前快照。
- 文档内容视为不可信输入，不能通过文档内指令提升权限或调用禁止工具。
- Mock Provider 测试覆盖超时、限流、断网、无 Key 和工具拒绝；真实 API 仅做手工冒烟。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 6：AI 对话、@文档上下文与三级权限。这是一个新的开发窗口，必须通过工期 3-5 的稳定接口恢复事实，不能让 AI 模块直接读取磁盘或数据库私有表。

【先恢复上阶段事实】
1. 执行 git status、git log -5 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX，以及 phase-03.md、phase-04.md、phase-05.md。
3. 核对搜索、统一文档片段、来源定位、权限范围、Snapshot、写回和 OCR 接口，运行相关核心测试。
4. 检查仓库是否已有 secrets 或 API Key；不得在输出中展示其值。发现硬编码秘密时先报告并安全修复。
5. 从上一阶段完成提交创建或继续 codex/phase-06-ai-orchestrator 分支。

【承接关系】
AI 只通过受控 Rust 服务读取用户明确授权的 Document ID 和片段。所有修改复用工期 4 的 Snapshot、冲突和恢复流程；前端只显示流式事件、来源、权限和审阅结果，不持有 API Key。

【本工期目标】
实现可替换 AiProvider、OpenAI Responses API 流式代理、@文档上下文、权限可见的工具调用、变更审阅和完整审计。

【必须完成】
1. 定义 Rust AiProvider 与 Mock Provider，支持流式文本、工具请求、取消、超时和结构化错误。
2. 使用 Windows Credential Manager 存取 API Key；禁止进入前端状态、日志、数据库和崩溃报告。
3. 实现 @文档解析、片段检索、上下文预览、来源列表、预计规模和发送前确认。
4. 实现建议、协助修改、自主修改三级权限；建议模式不能写入，协助修改逐项/整批确认，自主修改仅限当前会话明确授权目标。
5. 建立只读、建议、写入和禁止工具白名单；所有写工具执行权限校验、目标校验、写前 Snapshot、哈希冲突检查和 AiAction 审计。
6. 把文档正文标记为不可信输入，文档内指令不能改变系统提示、权限、上下文范围或工具白名单。
7. 先用 Mock Provider 完成自动化测试，再做真实 API 手工冒烟。

【明确禁止】
不得实现删除/移动文件、系统命令、未授权目录读取、API Key 修改工具或静默上传全文。不得把外部文档内容当成系统指令。

【验收】
测试无 Key、错误 Key、断网、超时、限流、中途取消、工具拒绝、提示注入、越权目标、外部修改冲突和恢复；验证前端/日志不含 Key 或未授权绝对路径；真实 API 冒烟失败不能影响 Mock 自动测试结论。

【结束交接】
更新 PROJECT_CONTEXT 的 AiProvider、权限模型、工具注册、上下文和审计契约；更新 STATUS、DECISIONS、TEST_MATRIX；创建 docs/handoffs/phase-06.md。记录自动/手工测试结果、允许与禁止工具、数据发送范围和工期 7 的攻击面清单。提交建议：feat: add permissioned AI document assistant。

【最终回复格式】
报告：AI 能力、权限边界、上下文发送规则、工具测试、安全结果、提交号、handoff 路径和工期 7 优先审计项；不得输出任何秘密值。
```

**下一工期衔接**：工期 7 以 AI 工具和写回链路为攻击面做安全加固，不新增业务功能。

### 工期 7：安全、冲突恢复与可靠性加固

**目的**：把方案中的安全边界和异常恢复变成可测试的约束。

**范围**：SQLCipher/本地数据加密、Windows DPAPI、路径穿越与授权校验、WebView2 CSP、外部修改冲突、崩溃恢复、快照清理策略、恶意文档/提示注入测试、依赖许可证审计。

**交付与验收**：

- 数据库、OCR 缓存和快照的密钥不落明文；API Key 不进入前端和日志。
- 未授权目录、路径穿越、符号链接/Junction、恶意文档指令不能越权。
- 进程崩溃、断电模拟、外部修改和写回失败后可恢复或明确回退。
- CSP、资源加载和第三方许可证清单通过检查。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 7：安全、冲突恢复与可靠性加固。这是一个新的开发窗口，本阶段不增加业务功能，而是审计工期 2-6 的真实实现并用测试证明安全边界。

【先恢复上阶段事实】
1. 执行 git status、git log -10 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX，以及 phase-02.md 至 phase-06.md。
3. 运行当前完整测试和生产构建，建立加固前基线。
4. 根据代码而不是方案假设列出实际数据流、信任边界、写回路径、秘密存储和 AI 工具。
5. 从上一阶段完成提交创建或继续 codex/phase-07-security-hardening 分支。

【承接关系】
保持现有 Document ID、数据库、搜索、Adapter、Snapshot、OCR 和 AI 公共契约。只有发现安全缺陷时才做最小兼容修复，并在 DECISIONS 记录原因、迁移影响和回归测试。

【本工期目标】
关闭高风险安全问题，验证未授权访问和提示注入不能越权，并让写回、崩溃和外部修改具有明确的恢复路径。

【必须完成】
1. 建立威胁模型，至少覆盖本地恶意文件、路径穿越、Junction/符号链接、恶意 Web 内容、提示注入、工具越权、秘密泄露和数据库窃取。
2. 审计 SQLCipher/等价数据加密、DPAPI、Credential Manager、OCR 缓存和 Snapshot 密钥，确保秘密不明文落盘或进入日志。
3. 审计路径规范化、授权根目录、TOCTOU、Junction 和外部文件替换。
4. 配置并测试 WebView2 CSP、本地资源协议、导航限制和未知远程资源阻断。
5. 测试文档正文无法提升 AI 权限、扩大上下文或调用禁止工具。
6. 演练文件锁定、磁盘写满、进程崩溃、数据库 migration 失败、外部修改、快照恢复和写回回滚。
7. 审计第三方依赖许可证和版本，生成或更新 THIRD_PARTY_NOTICES。

【明确禁止】
不要新增产品功能，不要重做 UI，不要借安全名义进行无关大规模重构，不要删除失败测试或降低权限要求。

【验收门】
每个高风险问题都有复现测试、修复证据和回归测试。无法修复的问题必须有风险等级、影响、临时缓解和发布阻断结论。运行完整测试、构建、安全检查和恢复演练。

【结束交接】
更新 PROJECT_CONTEXT 的安全不变量和恢复命令，更新 STATUS、DECISIONS、TEST_MATRIX、THIRD_PARTY_NOTICES，创建 docs/handoffs/phase-07.md。记录风险清单、关闭证据、剩余阻断项和工期 8 不得放宽的发布门。提交建议：security: harden local data and AI boundaries。

【最终回复格式】
按高/中/低风险报告发现和处理结果，然后报告测试、恢复演练、剩余阻断项、提交号、handoff 路径和是否允许进入发布验收。
```

**下一工期衔接**：工期 8 只做发布前的完整验收、性能和安装包，不再改变核心数据契约，除非发现阻断性缺陷。

### 工期 8：端到端验收、性能与 Windows 发布

**目的**：形成可安装、可升级、可恢复的首个 MVP 版本。

**范围**：端到端流程、代表性文件矩阵、1366x768/1920x1080、125%/150% 缩放、键盘操作、索引/OCR/大文件性能、崩溃恢复、Windows 10/11 安装/升级/卸载、发布说明和已知限制。

**交付与验收**：

- 覆盖“授权目录 -> 扫描 -> 搜索 -> 打开 -> 批注/编辑 -> 快照 -> AI 建议/写回 -> 恢复”的完整路径。
- 搜索 p95、启动时间、扫描吞吐、OCR 耗时和内存峰值有可复现记录。
- 安装、升级、卸载和数据迁移在 Windows 10/11 通过；失败时有回滚说明。
- 发布包、第三方许可证、用户文档、已知限制和样本测试报告齐全。

**本工期提示词**：

```text
你现在负责“文档管理系统”的工期 8：端到端验收、性能与 Windows 发布。这是一个新的开发窗口，只允许验证完整 MVP 和修复阻断发布的问题，不再扩展功能范围。

【先恢复全部事实】
1. 执行 git status、git log -15 --oneline、git branch --show-current。
2. 阅读 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX、全部 phase-00.md 至 phase-07.md，以及 THIRD_PARTY_NOTICES。
3. 核对 phase-07 是否明确允许进入发布验收；存在未接受的高风险阻断项时，不得宣称可发布。
4. 运行完整测试和生产构建，记录发布前基线。
5. 从上一阶段完成提交创建或继续 codex/phase-08-release 分支。

【承接关系】
把阶段 0-7 的稳定接口视为冻结。只修复阻断发布的缺陷；任何数据契约、migration、安全边界或权限变化都必须有回归测试、兼容说明和 DECISIONS 记录。

【本工期目标】
形成可安装、可升级、可恢复的 Windows 10/11 MVP，并给出基于证据的“可以发布”或“不可发布”结论。

【必须完成】
1. 建立端到端路径：授权目录 -> 扫描 -> 搜索 -> 打开 -> 批注/编辑 -> Snapshot -> OCR -> AI 建议/写回 -> 冲突 -> 恢复。
2. 使用最终 DOCX/PPTX/XLSX、PDF、Markdown、TXT、CSV、图片样本矩阵，保留失败样本和结果。
3. 测试 1366x768、1920x1080、125%/150% 缩放、键盘导航、长文本、空状态、加载和错误状态。
4. 记录冷/热启动、搜索 p95、扫描吞吐、OCR 单页耗时、内存峰值、大文件和后台任务对 UI 的影响。
5. 在可用环境验证 Windows 10/11 安装、首次启动、升级、数据库 migration、卸载、保留/删除用户数据和崩溃恢复。
6. 生成安装包、校验值、发布说明、用户文档、已知限制、测试报告和最终 THIRD_PARTY_NOTICES。
7. 对每个发布门标记 PASS、FAIL 或 NOT TESTED；NOT TESTED 不能自动视为 PASS。

【明确禁止】
不要为了通过验收删除失败样本、跳过安全测试、放宽权限或隐瞒未测试平台。不要加入首版范围外功能。

【发布判定】
只有高风险安全项关闭、核心端到端路径通过、数据迁移/恢复可验证、安装包可复现且无文件损坏时才能判定“可以发布”。否则判定“不可发布”，按优先级列出阻断项和修复所需阶段。

【结束交接】
更新 PROJECT_CONTEXT、STATUS、DECISIONS、TEST_MATRIX、发布说明和已知限制，创建 docs/handoffs/phase-08.md。记录构建环境、安装包路径、校验值、完整测试证据、性能数字和最终发布结论。创建最终可回滚提交或发布候选标签，建议提交信息：release: prepare document manager MVP candidate。

【最终回复格式】
第一行必须是“发布结论：可以发布”或“发布结论：不可发布”。随后报告端到端结果、性能、平台验证、阻断项、产物路径、提交号/标签和 handoff 路径。
```

---

## 三、每个窗口结束时的最短交接模板

复制到 `docs/handoffs/phase-XX.md`，不要写长篇叙述：

```markdown
# Phase XX Handoff

- 阶段状态: complete / partial / blocked
- 当前提交: <git sha>
- 目标: <一句话>
- 已完成: <3-7 条>
- 改动文件: <路径列表>
- 稳定接口/表结构: <名称 + 一句话>
- 验证命令: `<command>`
- 验证结果: PASS/FAIL + 关键数字
- 已知问题: <没有就写 none>
- 明确未做: <防止下个窗口越界>
- 下一窗口第一步: `<exact command or file to open>`
- 下一阶段禁止改变: <契约列表>
```

## 四、遇到上下文压缩或模型开始臆测时的恢复提示词

```text
停止继续编码。你可能发生了上下文压缩。重新读取 git status、git log -5、docs/PROJECT_CONTEXT.md、docs/STATUS.md、docs/DECISIONS.md 和当前阶段 handoff。
只根据这些文件和当前代码重建事实表：已完成、未完成、阻塞、稳定接口、下一步。把不确定内容标记为 UNKNOWN，不要猜测。
先运行 handoff 中的验证命令，再提出不超过 3 个最小行动；没有确认前不要扩大范围或重写已有实现。
```

## 五、推荐的实际执行顺序

按 `0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8` 顺序执行。每个工期完成后先关闭窗口，把提交号和 handoff 文件作为下一个窗口的唯一入口。若工期 1 的 Office POC 失败，应先决定“更换编辑器 / 只读降级 / 延后 Office 写回”，再继续工期 2，避免在错误的技术假设上堆积索引和 AI 功能。
