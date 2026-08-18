# 项目状态

更新日期：2026-08-18

## 当前阶段

工期 1：ZetaOffice/zetajs Office 编辑器 POC（已实现，结论 BLOCKED）

## 已完成

- 已在当前项目目录初始化独立 Git，并切换到 `codex/phase-00-foundation`。
- 已建立 Tauri 2 + React + TypeScript + Rust 工程、Node/Rust 锁文件和目录边界。
- 已实现统一 IPC 信封、`health_check`、最小 `tracing` 日志和健康状态界面。
- 前端单元测试 4/4 通过；Rust 单元测试 3/3 通过。
- 已按 `PROJECT_CONTEXT.md` 完成冻结安装、全部测试、前端生产构建和 Tauri release 构建。
- 已启动真实 Windows 桌面窗口；前端显示 `运行正常`、应用版本 `0.1.0`、IPC 协议 `v1`，Rust 日志记录 `health_check` success。
- release 产物：`src-tauri/target/release/moji-desktop.exe`（8,762,880 bytes，构建目录不入 Git）。
- 已切换到 `codex/phase-01-editor-poc`，建立 `EditorAdapter`、ZetaOffice runtime bridge、mock 和 24 个 OOXML 夹具。
- 已实现 `pnpm test:editor-poc` 的打开 -> 修改 -> 另存 -> 关闭 -> 重开 -> 摘要/ZIP/哈希校验流程；失败不覆盖源文件。
- 真实 POC 结果：24 个样本中 PASS 0、DEGRADED 0、FAIL 24；每条失败为 `ZETA_RUNTIME_UNAVAILABLE`，保留只读预览回退，详见 `docs/editor-poc/results.md`。

## 阻塞

ZetaOffice/zetajs runtime bridge 未配置，机器也未安装 ZetaOffice/LibreOffice；因此不能证明 DOCX/PPTX/XLSX 的真实打开、修改、保存和重开，当前结论为 BLOCKED。下一阶段在依赖 Office 写回前必须做一个明确选择：更换编辑器、首版只读、或延后写回。当前系统全局 PATH 的 Node 24.13.0 仍低于要求；验收使用工作区 Node 24.19.0 / pnpm 11.19.0，Rust 1.97.1 通过显式 PATH 调用。

## 明确未做

文件扫描、数据库业务、Office/PDF 业务 UI、全文检索、OCR、AI、账号、云同步、正式版本库和真实 ZetaOffice runtime bridge 均未实现。

## 下一条命令

工期 2 不具备默认开始条件；开始前必须阅读 `docs/handoffs/phase-01.md`，解决或接受 BLOCKED 决策，并提供真实 runtime bridge 后重跑 `pnpm test:editor-poc`。
