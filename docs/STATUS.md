# 项目状态

更新日期：2026-08-19

## 当前阶段

工期 4：查看器、编辑器适配、批注和版本快照（已实现，Office 产品 bridge 只读降级）

## 已完成

- 已完成工期 0 的 Tauri 2 + React + TypeScript + Rust 基线、IPC、日志、测试和桌面构建。
- 已建立 `EditorAdapter`、ZetaOffice runtime bridge、mock 和 24 个 OOXML 夹具。
- 已在官方 CDN `https://cdn.zetaoffice.net/zetaoffice_latest/` 初始化真实 ZetaOffice WASM runtime，并在浏览器 worker 中执行 `open -> edit -> saveAs -> close -> reopen`。
- 24 个矩阵样本 PASS，0 DEGRADED，0 FAIL；另有真实产品方案 DOCX smoke sample PASS，源文件均未覆盖。
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

## 当前边界与风险

- `pnpm test:editor-poc` 是 Node 侧注入 runtime bridge runner；当前机器没有该 bridge 时仍会报告 `ZETA_RUNTIME_UNAVAILABLE`/`BLOCKED`，不得用 mock 或浏览器结果静默改写它。
- 浏览器 POC 使用官方 `zetaoffice_latest` CDN，版本随 CDN 更新且依赖网络；正式集成前需要锁定构建或自托管并记录 SHA-256。
- 真实证据来自浏览器 worker，尚未接入 Tauri WebView2 自动化测试；浏览器 PASS 不等同于离线桌面安装包或任意真实用户文件兼容。
- 夹具是结构化代表性输入，批注、图表和复杂排版还需后续视觉核对。
- 当前 worker 使用每任务线程，尚未连接产品 UI、全局并发上限或大目录背压；任务状态和事件仍可通过 IPC 轮询读取。
- 本机全局 Node 为 `24.13.0`，低于仓库要求；本次前端测试与构建通过但输出 engine warning。Rust 命令仍需显式将 `C:\Users\Gary\.cargo\bin` 加入 `PATH`。

## 明确未做

正文提取、OCR、Office/PDF 业务 UI、编辑器写回、账号、云同步、正式版本库和真实 ZetaOffice runtime bridge 均未实现。页码、幻灯片和段落来源定位当前明确标记未实现。不得把扫描器的 canonical path、SQLite 私有表或 `notify` 事件作为后续模块的替代数据入口。

## 工期 4 结果

- 已实现 Document ID 受控打开、统一 Adapter Registry、文本编辑器、PDF.js 第一页只读查看、Office 只读降级和只读/编辑/协助修改模式。
- 已实现 migration v3 增量的 Snapshot/Annotation 表和 IPC（当前工作树后续迁移总版本为 v4）；文本写回前创建原始哈希快照，外部修改返回 `DOCUMENT_CONFLICT`，失败保留/恢复原文件。
- Rust 文档服务测试 3/3 PASS；Rust 库单测总计 28/28 PASS（包含当前工作树已有的后续 OCR 用例）；前端 6 个测试文件、15/15 PASS；`pnpm build` PASS。
- Office 产品桌面 bridge 尚未接入；PDF 页码、Office 幻灯片、正文段落稳定定位仍是明确降级，批注保留引用文本或页码锚点。

## 下一条命令

工期 4 应以稳定的 `DocumentId`、`library_search` 查询结果和 `SourceLocator` 结构接入查看器；不得改变 FTS 字段、过滤参数、Document ID 或源文件不移动不复制不覆盖不变量。
