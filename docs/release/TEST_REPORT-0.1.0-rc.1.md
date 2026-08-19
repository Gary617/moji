# 墨集 0.1.0-rc.1 验收报告

日期：2026-08-19
分支：`codex/phase-08-release`
环境：Windows 工作站；Node `24.13.0`（低于声明的 `>=24.15.0 <25`）、pnpm `11.19.0`、Rust `1.97.1`；未发现 OpenSSL、Perl 或 NSIS 可用构建环境。

## 发布门

| 发布门 | 结果 | 证据 |
| --- | --- | --- |
| 前端单元测试 | PASS | `pnpm test`：17/17 |
| Rust 回归测试 | PASS | `pnpm test:rust`：43/43，`--no-default-features` |
| 前端生产构建 | PASS | `pnpm build`：1811 modules |
| SQLCipher secure-db 测试 | FAIL | `cargo test --features secure-db`；vendored OpenSSL 找不到 `perl` |
| 桌面生产构建 | FAIL | `pnpm build:desktop`；同一 OpenSSL/Perl 错误 |
| NSIS 安装包、SHA-256 | NOT TESTED | 构建未到打包阶段 |
| Windows 10 安装/首次启动 | NOT TESTED | 无安装包 |
| Windows 11 安装/首次启动 | NOT TESTED | 无安装包 |
| 升级、migration、卸载、数据保留/删除 | NOT TESTED | 无安装包/回滚演练 |
| SQLCipher 加密烟测 | NOT TESTED | 无 secure-db 产物 |
| 崩溃/断电恢复 | NOT TESTED | 仅有 Rust 恢复单测 |
| 1366x768、1920x1080 | NOT TESTED | 无本阶段桌面截图证据 |
| 125%、150% DPI | NOT TESTED | 无本阶段实机证据 |
| 键盘导航和状态矩阵 | NOT TESTED | 无本阶段实机证据 |
| 真实 OpenAI API | NOT TESTED | 无批准 Credential Manager Key |
| 搜索 p95 | PASS（范围有限） | 1,000 条内存库，p95 53 ms |
| OCR 单页/内存 | PASS（范围有限） | 240-271 ms/页；159.7 MiB 峰值 |
| Office 浏览器 POC | PASS（范围有限） | 24/24；不等同于 Tauri 宿主 |
| Node Office runner | BLOCKED | `pnpm test:editor-poc`：24 个样本均缺 Node runtime bridge |

## 端到端覆盖

授权目录、扫描、索引、搜索、Document ID 打开、文本 Snapshot/冲突/恢复和 OCR/AI 权限边界均有模块级或 Rust 单测。完整安装桌面中的“授权目录 -> 扫描 -> 搜索 -> 打开 -> 批注/编辑 -> Snapshot -> OCR -> AI 建议/写回 -> 冲突 -> 恢复”路径未完成实机验收，因此总体门为 `NOT TESTED`，不能按模块 PASS 推导发布 PASS。

## 阻断项

1. 高风险：无法构建并运行生产 SQLCipher，必须在有 Perl/MSVC/NSIS 的 Windows 构建机重试。
2. 高风险：没有安装包，无法验证 Windows 10/11 安装、升级、卸载、迁移和恢复。
3. 中风险：真实 WebView2 Office 宿主、Credential Manager ACL/轮换、真实 SSE 取消/重连未测。

## 产物

本次没有可发布安装包或 SHA-256。`src-tauri/target/release/moji-desktop.exe` 是早于本候选的旧输出，未通过当前 secure-db/安装器验证，不能作为发布物；前端 `dist/` 同样仅为开发构建输出。
