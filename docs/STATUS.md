# 项目状态

更新日期：2026-08-19

## 当前阶段

工期 2：本地资料库、目录授权与增量索引（已实现）

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

## 当前边界与风险

- `pnpm test:editor-poc` 是 Node 侧注入 runtime bridge runner；当前机器没有该 bridge 时仍会报告 `ZETA_RUNTIME_UNAVAILABLE`/`BLOCKED`，不得用 mock 或浏览器结果静默改写它。
- 浏览器 POC 使用官方 `zetaoffice_latest` CDN，版本随 CDN 更新且依赖网络；正式集成前需要锁定构建或自托管并记录 SHA-256。
- 真实证据来自浏览器 worker，尚未接入 Tauri WebView2 自动化测试；浏览器 PASS 不等同于离线桌面安装包或任意真实用户文件兼容。
- 夹具是结构化代表性输入，批注、图表和复杂排版还需后续视觉核对。
- 当前 worker 使用每任务线程，尚未连接产品 UI、全局并发上限或大目录背压；任务状态和事件仍可通过 IPC 轮询读取。
- 本机全局 Node 为 `24.13.0`，低于仓库要求；本次前端测试与构建通过但输出 engine warning。Rust 命令仍需显式将 `C:\Users\Gary\.cargo\bin` 加入 `PATH`。

## 明确未做

全文检索、正文提取、OCR、标签/集合 UI、Office/PDF 业务 UI、编辑器写回、账号、云同步、正式版本库和真实 ZetaOffice runtime bridge 均未实现。不得把扫描器的 canonical path、SQLite 私有表或 `notify` 事件作为工期 3 的替代数据入口。

## 下一条命令

工期 3 具备开始条件。先阅读 `docs/handoffs/phase-02.md`，以 `DocumentId`、`Document` 元数据和持久化 `ScanEvent` 为唯一数据入口；不得为了搜索再次遍历未授权文件系统或调用编辑器内部实现。
