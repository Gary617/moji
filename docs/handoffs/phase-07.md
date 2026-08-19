# 工期 7 交接：安全、冲突恢复与可靠性加固

日期：2026-08-19
分支：`codex/phase-07-security-hardening`
建议提交：`security: harden local data and AI boundaries`

## 真实数据流和信任边界

1. React 只发送 `DocumentId`、页选择、模式和 AI 请求，经 Tauri IPC 进入 Rust。
2. Rust `LibraryService` 从授权 `source_roots` 解析路径；扫描、查看、写回和 OCR 是唯一文件系统入口。
3. OCR 页片段、搜索 FTS、Snapshot 和 `ai_actions` 都写入应用数据目录的 SQLite 数据库；AI Provider 在 Rust 侧读取 Credential Manager 并向外部 Responses API 发起 SSE。
4. WebView2 只允许本地应用资源、Tauri `ipc:` 和 `http://ipc.localhost`；外部文档正文始终是不可信数据。

## 威胁模型

| 威胁 | 边界/影响 | 当前控制 | 证据 |
| --- | --- | --- | --- |
| 本地恶意文件/恶意文档 | 文档正文提示注入、损坏 PDF/OCR 资源消耗 | 统一片段入口、长度上限、`<untrusted_text>` 转义、禁止工具白名单 | Rust 注入测试 |
| 路径穿越 | 读取/写回授权根外文件 | canonical path、Path 组件比较、每次重验 source/document | policy/document tests |
| Symlink/Junction/reparse 与 TOCTOU | 外部替换后跟随链接写回 | 输入路径和父组件检查，普通文件检查，Windows 原子目录项替换 | symlink regression |
| 工具越权 | AI 读取未选文档、写入任意文档或执行命令 | Rust 工具注册、显式上下文目标、autonomous 授权清单，删除/移动/命令永久禁止 | orchestrator tests |
| API Key 泄露 | 前端、日志、DB、错误和审计泄露凭据 | Credential Manager generic credential；错误/审计只存稳定码 | provider tests/static scan |
| 数据库窃取 | OCR 缓存、Snapshot、索引静态泄露 | DPAPI 保护 32 字节密钥；生产 SQLCipher `secure-db` feature；运行时 `cipher_version` 门禁 | crypto test; runtime guard |
| Web 内容/远程资源 | XSS、远程脚本、导航离开应用 | CSP `script-src self`、无 frame/object/form、connect 白名单 | tauri.conf static audit |
| 崩溃/断电/磁盘满/外部修改 | 半写文件、丢任务、错误覆盖 | 临时文件 fsync、原子替换、备份恢复、SHA 冲突、running->paused、20 条 Snapshot 保留 | Rust recovery tests |

## 高风险处理

- H-01 明文 SQLite：已实现 DPAPI 密钥侧车、`secure-db` SQLCipher 构建 feature 和运行时 `PRAGMA cipher_version` 门禁。当前机器缺少 OpenSSL 开发环境（`OPENSSL_DIR`），无法完成 native SQLCipher 构建；这是发布阻断，不得以 bundled 明文 SQLite 运行正式数据。
- H-02 写回路径 TOCTOU：已在读、保存、恢复前重验授权来源及 reparse point，临时文件使用 `create_new`，Windows 使用 `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)`，失败原子恢复备份。
- H-03 提示注入/工具越权：正文、ID、显示名结构化转义；目标工具调用必须在当前显式上下文，autonomous 还需会话授权目标；工具拒绝先于 Provider 事件执行。

## 中低风险和剩余阻断

- M-01 `ai_actions` 当前可被同一用户删除/篡改，尚无防篡改签名或远程审计；发布前需要追加 append-only 校验链和留存策略。
- M-02 Credential Manager ACL、Key 轮换和真实 SSE 取消/重连尚未进行人工桌面冒烟；无批准 Key，不得把 Mock 结果当真实 API 证据。
- M-03 OCR/搜索正文在启用 SQLCipher 前仍是普通 SQLite 表；启用 secure-db 后随数据库整体加密。需要在发布机用十六进制检查验证明文正文不出现在数据库文件。
- L-01 Node 版本 24.13.0 低于声明的 24.15.0，测试通过但有 engine warning。

## 验证结果

- `pnpm test`：PASS，7 files / 17 tests。
- `pnpm test:rust`：PASS，43 tests（包含 DPAPI、symlink、提示注入、Snapshot retention、冲突和恢复）。
- `pnpm build`：PASS，Vite 1811 modules。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all`：PASS。
- `cargo test --no-default-features`（测试 SQLite）：PASS；生产默认启用 `secure-db`，其 native 编译在本机因缺 OpenSSL 开发环境 BLOCKED。

## 工期 8 不得放宽的发布门

1. 在具备 OpenSSL（`OPENSSL_DIR`）+ MSVC 的 Windows 构建机执行 `cargo test --features secure-db`、`pnpm build:desktop`，并启动后确认 `PRAGMA cipher_version` 非空。
2. 创建包含 OCR 文本和 Snapshot 的数据库，关闭进程后用十六进制搜索正文/Key；复制数据库但不复制 DPAPI key 文件必须无法打开。
3. 完成真实 WebView2 CSP/导航/远程资源阻断测试、Credential Manager ACL/轮换、外部 symlink 替换和断电恢复演练。
4. 未完成以上门禁时，发布结论为 BLOCKED；不得删除门禁、关闭运行时检查或回退到明文 SQLite。
