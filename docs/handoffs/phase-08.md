# 工期 8 交接：端到端验收、性能与 Windows 发布

日期：2026-08-19
分支：`codex/phase-08-release`
建议提交：`release: prepare document manager MVP candidate`

## 发布结论

**不可发布。** 阻断项是生产 SQLCipher 构建环境和由此缺失的安装包/Windows 实机验收，不是通过删除安全门或回退明文数据库解决的问题。

## 本窗口变更

- `secure-db` 改为 `rusqlite/bundled-sqlcipher-vendored-openssl`，保留 SQLCipher 和运行时 `cipher_version` 门禁。
- Tauri bundle 改为 NSIS，`installMode=currentUser`，目标是安装/升级不要求管理员权限，卸载不主动删除应用数据。
- 增加发布说明、用户指南、已知限制和验收报告；全部未测试发布门保持显式 `NOT TESTED`。

## 验证证据

- 前端：17/17 PASS；`pnpm build` PASS，1811 modules。
- Rust 开发路径：43/43 PASS；`pnpm test:rust` 使用 `--no-default-features`。
- 生产路径：FAIL。`cargo test --features secure-db` 和 `pnpm build:desktop` 均在 `openssl-src` 调用 `perl` 时失败。`src-tauri/target/release/moji-desktop.exe` 是旧输出，未通过当前候选验证，不能发布。
- 性能：搜索 p95 53 ms（1,000 条内存库）；OCR 240-271 ms/暖页、225 ms 空白页、159.7 MiB 峰值；均为有限样本。
- Office：浏览器真实 POC 24/24 PASS；Tauri/WebView2 宿主仍未测。

## 待下一构建机完成

1. 安装/提供 Perl、MSVC、NSIS 和满足项目版本约束的 Node `24.15+`，运行完整构建。
2. 生成 NSIS 安装包并记录绝对路径、文件大小、SHA-256。
3. 启动后确认 SQLCipher、DPAPI 侧车、无明文正文/Key，并验证缺侧车 Key 无法打开复制数据库。
4. 在 Windows 10/11 完成安装、升级、migration、卸载、保留/删除数据、崩溃/断电恢复。
5. 完成视口/DPI/键盘、真实 AI、WebView2 CSP、Office 宿主和大文件性能验收后重新判定。

## 关键文档

- [`docs/release/0.1.0-rc.1.md`](../release/0.1.0-rc.1.md)
- [`docs/release/TEST_REPORT-0.1.0-rc.1.md`](../release/TEST_REPORT-0.1.0-rc.1.md)
- [`docs/release/KNOWN_LIMITATIONS.md`](../release/KNOWN_LIMITATIONS.md)
- [`docs/release/USER_GUIDE.md`](../release/USER_GUIDE.md)
