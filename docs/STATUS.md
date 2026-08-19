# 项目状态

更新日期：2026-08-19

## 当前阶段

工期 8：端到端验收、性能与 Windows 发布（发布候选已整理；当前不可发布）

## 已完成

- 已完成工期 0 的 Tauri 2 + React + TypeScript + Rust 基线、IPC、日志、测试和桌面构建。
- 已建立 `EditorAdapter`、ZetaOffice runtime bridge、mock 和 24 个 OOXML 夹具。
- 已在官方 CDN `https://cdn.zetaoffice.net/zetaoffice_latest/` 初始化真实 ZetaOffice WASM runtime，并在浏览器 worker 中执行 `open -> edit -> saveAs -> close -> reopen`。
- 24 个矩阵样本 PASS，0 DEGRADED，0 FAIL；另有真实产品方案 DOCX smoke sample PASS，源文件均未覆盖。
- 工期 1 补充了隔离 Tauri/WebView2 POC 配置和 `pnpm test:editor-poc:tauri` 宿主 runner；当前报告 `docs/editor-poc/results.tauri.{json,md}` 尚未取得宿主矩阵结果，保持 BLOCKED，不计入浏览器 PASS。
- 已为 DOCX/PPTX/XLSX 保存显式指定 OOXML filter，并修复图片 DOCX 夹具的合法 DrawingML 结构。
- 已建立 SQLite migration `v1` 和 `SourceRoot`、`Document`、`ScanJob`、`ScanEvent` 最小模型；重复 migration 不删除已有资料。
- 已实现用户授权目录/单文件注册、canonical path 校验、隐藏/系统/回收站/`node_modules`/Junction 默认排除，以及文件格式、大小、mtime、Windows File ID 和 SHA-256 元数据登记。
- 已实现新增、修改、删除、重命名的增量 reconciliation；重命名优先 File ID，必要时以唯一失效路径的哈希辅助定位。
- 已实现持久化扫描队列：启动和 watcher 轮询异步调度后台 worker，worker 按文件边界响应暂停/取消并持久化进度；恢复和失败重试重新入队，数据库重开时 `running` 任务恢复为 `paused`。`notify` 事件仍只在授权根目录内触发同一套增量扫描。
- 已通过 Rust 19/19、前端 7/7 和前端生产构建验证。
- 已通过带 Rustup PATH 的 `pnpm build:desktop`，生成 release `moji-desktop.exe`（11,130,368 bytes）。
- 已完成 SQLite migration v2：FTS5 trigram 字段 `title/body/path/tags/ocr`、索引状态和可重建索引；中文子串、字段权重、格式/时间/来源/集合/标签/状态/收藏/最近使用组合过滤可用。
- 已完成 Collection/Tag 多对多引用、收藏、最近使用和稳定搜索 IPC；查询结果含 Document ID、匹配片段和结构化 SourceLocator。
- 已完成三栏资料库 UI：导航、搜索结果、工作区占位，覆盖加载、空、无结果和错误状态；UI 不以绝对路径作为主键且仅显示路径尾部。
- 代表性性能测试：内存 bundled SQLite，1,000 条文档、30 次已索引查询、limit 50，AMD Ryzen 7 8845H / 8C16T / 27.8 GB / Windows 11，p95 53 ms。
- 已完成 migration v4、持久化 `ocr_jobs`/页片段/文字框/指标、本地 PP-OCRv6 Tiny + ONNX Runtime CPU 适配、PDF 文本层检测、扫描 PDF 本机页渲染、PNG/JPG/TIFF/BMP 输入、任务控制、OCR FTS 增量与页框来源定位。
- PDF 有有效文本层时仅保存本地 `text_layer` 片段，不进入模型推理；无文本层 PDF 与扫描图片由独立 OCR worker 处理。`library_document_fragments` 是后续阶段唯一正文读取入口。
- 已完成 migration v5 `ai_actions` 审计表、可替换 Rust `AiProvider`、Mock Provider 和 OpenAI Responses API SSE 代理；凭据只从 Windows Credential Manager 读取，前端/日志/数据库不持有 API Key。
- 已完成 `@文档(id)`/`@文档:id`/`@doc:id` 解析、上下文来源/规模/预计 token/权限预览和 `<untrusted_text>` 边界；没有明确 Document ID 或页片段时不会隐式读取全文。
- 已完成 `suggest|assist|autonomous` 三级权限、只读/建议/写入/禁止工具白名单、授权目标校验和 `AiAction` 审计。建议模式不写入；协助修改要求用户接受；自主修改仅作用于会话授权目标，并复用 Snapshot、哈希冲突和恢复流程。
- 已完成前端 AI IPC 适配与 Mock 自动化测试；错误消息只返回稳定码，不含 Key、绝对路径或正文。
- 已加入 Windows DPAPI 保护的数据库密钥侧车文件、运行时 SQLCipher 能力门禁、原子写回和 20 条快照留存上限；密钥生成/DPAPI 回环有 Windows 测试。
- 文档读写/恢复会重新验证授权来源、canonical path、普通文件类型及 reparse point；符号链接回归测试通过。
- AI 上下文对文档 ID、显示名和正文做结构化转义；工具调用必须来自显式上下文，autonomous 还必须在会话授权清单中；提示注入回归测试通过。
- WebView2 CSP 收紧为无远程脚本/导航、无 frame/object/form，资源和连接仅限本地应用协议；许可证清单和阶段威胁模型已更新。

## 当前边界与风险

- `pnpm test:editor-poc` 是 Node 侧注入 runtime bridge runner；当前机器没有该 bridge 时仍会报告 `ZETA_RUNTIME_UNAVAILABLE`/`BLOCKED`，不得用 mock 或浏览器结果静默改写它。
- 浏览器 POC 使用官方 `zetaoffice_latest` CDN，版本随 CDN 更新且依赖网络；正式集成前需要锁定构建或自托管并记录 SHA-256。
- 真实证据来自浏览器 worker；Tauri/WebView2 宿主 runner 已有可重复入口，但本机尚未取得 24 样本结果。浏览器 PASS 不等同于离线桌面安装包或任意真实用户文件兼容。
- 夹具是结构化代表性输入，批注、图表、图片、中文字体和复杂排版还需后续视觉核对。
- 当前 worker 使用每任务线程，尚未连接产品 UI、全局并发上限或大目录背压；任务状态和事件仍可通过 IPC 轮询读取。
- 本机全局 Node 为 `24.13.0`，低于仓库要求；本次前端测试与构建通过但输出 engine warning。Rust 命令仍需显式将 `C:\Users\Gary\.cargo\bin` 加入 `PATH`。
- 已在应用数据目录安装并校验 PP-OCRv6 Tiny、方向模型和 ONNX Runtime CPU 1.26.0；9 文件中英/旋转/空白/有无文本层 PDF/位图/损坏输入矩阵通过。合成字符串严格匹配率 100%，预热 release 推理 240-271 ms/有文字页、峰值工作集 159.7 MiB；样本规模小，不代表生产语料准确率。缺失/损坏资产仍返回结构化错误，不回退到云端或假 OCR。

## 明确未做

Office/PDF 业务 UI、编辑器写回、账号、云同步、正式版本库和真实 ZetaOffice runtime bridge 均未实现。OCR 页码和文本框定位已实现；非 OCR 的幻灯片和段落定位仍可能明确降级。不得把扫描器的 canonical path、SQLite 私有表或 `notify` 事件作为后续模块的替代数据入口。

真实 OpenAI API 手工冒烟尚未执行；没有 Key 时自动化按 `AI_NO_API_KEY` 验证，真实 API 失败不影响 Mock 结论。当前 UI 已有上下文预览、权限选择、流式事件和工具待审阅展示；逐项接受并提交 AI 变更的完整审阅面板仍属于后续产品 UI 工作。

## 工期 4 结果

- 已实现 Document ID 受控打开、统一 Adapter Registry、文本编辑器、PDF.js 第一页只读查看、Office 只读降级和只读/编辑/协助修改模式。
- 已实现 migration v3 增量的 Snapshot/Annotation 表和 IPC（当前工作树后续迁移总版本为 v4）；文本写回前创建原始哈希快照，外部修改返回 `DOCUMENT_CONFLICT`，失败保留/恢复原文件。
- Rust 文档服务测试 3/3 PASS；Rust 库单测总计 29/29 PASS；前端 6 个测试文件、15/15 PASS；`pnpm build` PASS。
- Office 产品桌面 bridge 尚未接入；PDF 页码、Office 幻灯片、正文段落稳定定位仍是明确降级，批注保留引用文本或页码锚点。

## 下一条命令

工期 7 优先审计：提示注入与工具参数模糊化、会话授权生命周期和撤销、SSE 重连/重复事件、Credential Manager ACL/轮换、审计防篡改与留存、上下文 token 上限及大文档分段、真实桌面流式取消，以及未授权目标/外部修改并发竞态。继续以 `library_document_fragments({ documentId, page? })` 读取正文，不得读取 OCR 私有表、路径或临时页图，也不得改变 FTS、Document ID 或源文件不移动不复制不覆盖不变量。

## 工期 7 结果

- 高风险关闭证据：DPAPI 密钥保护、SQLCipher 运行时门禁、路径/reparse 校验、原子写回、快照清理、AI 工具目标授权、提示注入转义和 CSP 均有实现与回归测试。
- 发布阻断（阶段 7 历史）：本机缺少 OpenSSL 开发环境（`OPENSSL_DIR`），无法编译初始 `rusqlite` SQLCipher native 依赖；生产代码在 `PRAGMA cipher_version` 缺失时拒绝打开数据库，禁止以明文 SQLite 发布。工期 8 已切换 vendored OpenSSL，当前阻断见下文的 Perl 前置。
- 43 个 Rust 单测、17 个前端单测和 `pnpm build` 已通过；Node 版本仍为 24.13.0，产生 engine warning。

## 工期 8 结果

- 已创建 `codex/phase-08-release`，冻结阶段 0-7 稳定接口。
- 已将生产 secure-db feature 改为 vendored OpenSSL，并把 Tauri 发布目标改为 NSIS `currentUser`；未改变 schema、IPC、权限或恢复协议。
- `pnpm test` 17/17 PASS、`pnpm test:rust` 43/43 PASS（no-default-features）、`pnpm build` PASS、格式检查 PASS。
- `cargo test --features secure-db` 和 `pnpm build:desktop` FAIL：vendored OpenSSL 在 Windows 构建时缺少 Perl；没有生成安装包或校验值。
- Windows 10/11 安装/升级/卸载/migration/回滚、SQLCipher 数据库烟测、DPI/键盘/真实 WebView2/真实 AI 和完整桌面端到端路径均为 NOT TESTED。
- 发布结论：不可发布。下一步必须在具备 Perl、MSVC、NSIS 和 Node 24.15+ 的 Windows 构建机完成生产构建与实机验收。
