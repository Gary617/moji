# 项目状态

更新日期：2026-08-19

## 当前阶段

工期 1：ZetaOffice/zetajs Office 编辑器 POC（已实现，浏览器真实 POC 结论 PASS）

## 已完成

- 已完成工期 0 的 Tauri 2 + React + TypeScript + Rust 基线、IPC、日志、测试和桌面构建。
- 已建立 `EditorAdapter`、ZetaOffice runtime bridge、mock 和 24 个 OOXML 夹具。
- 已在官方 CDN `https://cdn.zetaoffice.net/zetaoffice_latest/` 初始化真实 ZetaOffice WASM runtime，并在浏览器 worker 中执行 `open -> edit -> saveAs -> close -> reopen`。
- 24 个矩阵样本 PASS，0 DEGRADED，0 FAIL；另有真实产品方案 DOCX smoke sample PASS，源文件均未覆盖。
- 已为 DOCX/PPTX/XLSX 保存显式指定 OOXML filter，并修复图片 DOCX 夹具的合法 DrawingML 结构。

## 当前边界与风险

- `pnpm test:editor-poc` 是 Node 侧注入 runtime bridge runner；当前机器没有该 bridge 时仍会报告 `ZETA_RUNTIME_UNAVAILABLE`/`BLOCKED`，不得用 mock 或浏览器结果静默改写它。
- 浏览器 POC 使用官方 `zetaoffice_latest` CDN，版本随 CDN 更新且依赖网络；正式集成前需要锁定构建或自托管并记录 SHA-256。
- 真实证据来自浏览器 worker，尚未接入 Tauri WebView2 自动化测试；浏览器 PASS 不等同于离线桌面安装包或任意真实用户文件兼容。
- 夹具是结构化代表性输入，批注、图表和复杂排版还需后续视觉核对。

## 明确未做

文件扫描、数据库业务、Office/PDF 业务 UI、全文检索、OCR、AI、账号、云同步、正式版本库和真实 ZetaOffice runtime bridge 均未实现。

## 下一条命令

工期 2 具备开始条件，但只能依赖 `EditorAdapter` 契约和本 POC 结论；开始前先阅读 `docs/handoffs/phase-01.md`，不得让业务模块直接依赖 `Module.zetajs`、UNO 对象、浏览器虚拟 FS 或默认假设 Office 写回可用。
