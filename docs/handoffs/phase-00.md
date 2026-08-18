# 工期 0 交接

阶段：工期 0 - 工程基线与可运行骨架

目标：建立可编译、可测试、可回滚的 Tauri 2 + React + TypeScript + Rust 最小工程，并让前端通过统一 IPC 显示 Rust 后端状态和应用版本。

分支：`codex/phase-00-foundation`

本次提交：`3f6194432ebecb359997496ead2a88afd7b693d8`（`chore: establish application foundation`）

## 改动文件

- 根工程：`.editorconfig`、`.gitignore`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`rust-toolchain.toml`、`index.html`、`tsconfig.json`、`vite.config.ts`。
- React：`src/App.tsx`、`src/App.css`、`src/main.tsx`、`src/vite-env.d.ts`、`src/ipc/health.ts`、`src/ipc/types.ts`。
- 前端测试：`tests/frontend/App.test.tsx`、`tests/frontend/health.test.ts`、`tests/frontend/setup.ts`。
- Tauri/Rust：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/build.rs`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/{main.rs,lib.rs,logging.rs}`、`src-tauri/src/ipc/{mod.rs,response.rs,health.rs}`。
- Windows 资源：`src-tauri/app-icon.svg` 与 `src-tauri/icons/` 下已提交的 ICO、PNG、Store Logo。
- 文档：`docs/PROJECT_CONTEXT.md`、`docs/STATUS.md`、`docs/DECISIONS.md`、`docs/TEST_MATRIX.md`。
- 初始需求基线纳入版本控制：`文档管理系统-产品技术方案.docx`、`docs/plans/2026-08-18-document-management-system-plan.md`。
- 既有 `_docx_render/` 未修改且未提交；Android、iOS、macOS 派生图标保留在本地但被精确忽略。

## 新增接口/数据库变更

新增 Tauri 命令：

```text
health_check() -> IpcResponse<HealthCheckData>
HealthCheckData = { backendStatus: "ok", appVersion: string, protocolVersion: 1 }
```

统一成功响应：`{ "status": "success", "data": ... }`。

统一失败响应：`{ "status": "error", "error": { "code", "message", "retryable", "details" } }`。

数据库变更：无。工期 0 未引入数据库或 migration。

## 规范命令

要求 Node `>=24.15.0 <25`、pnpm `11.19.0`、Rust `1.97.1`。安装 Rustup 后需重开终端。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm test:rust
pnpm build
pnpm build:desktop
pnpm tauri dev
```

## 已验证命令及结果

- `pnpm install --frozen-lockfile`：PASS，锁文件无漂移，pnpm 11.19.0。
- `pnpm test`：PASS，2 个测试文件，4/4 测试通过。
- `pnpm test:rust`：PASS，3/3 Rust 单元测试通过。
- `pnpm build`：PASS，TypeScript 检查通过，Vite 转换 1799 个模块。
- `pnpm build:desktop`：PASS，release profile 4 分 04 秒完成，生成 `moji-desktop.exe`，8,762,880 bytes。
- `pnpm tauri dev`：PASS，真实 Windows 主窗口启动。
- 实机 IPC：PASS，窗口显示 `运行正常`、`0.1.0`、`v1`；Rust 日志记录 `event="ipc_command_completed" command="health_check" outcome="success"`。
- `cargo fmt --all -- --check`：PASS。
- `git diff --cached --check`：PASS。

## 已知问题

- 当前系统全局 PATH 中是 Node 24.13.0 / pnpm 11.22.0，不满足项目要求；本期验收使用工作区 Node 24.19.0 / pnpm 11.19.0。工期 1 开始前必须先执行 `node --version`、`pnpm --version`，不能通过降低 `engines` 绕过。
- Rust 1.97.1 会把 MSVC 中文链接器 stdout“正在创建库”显示为 `linker_messages` warning；测试、debug 和 release 产物均成功。
- React StrictMode 在开发模式可能调用初始只读 `health_check` 两次；release 不受影响，命令无副作用。
- `build:desktop` 只生成 release 可执行文件，不生成安装包；签名、安装器和升级不属于工期 0。

## 未做事项（明确不要误做）

未实现文件扫描、目录授权、数据库业务、migration、Office/PDF 编辑器、全文检索、OCR、AI、账号、云同步、复杂 UI 或后续阶段假数据层。不得在工期 1 之前把这些能力塞入骨架，也不得让前端绕过 `src/ipc/` 直接调用 Tauri。

## 工期 1 的第一步

1. 在仓库根目录执行 `git status --short --branch`、`git log -5 --oneline`、`git branch --show-current`。
2. 先读取 `docs/PROJECT_CONTEXT.md`、`docs/STATUS.md`、`docs/DECISIONS.md`、`docs/TEST_MATRIX.md` 和本文件。
3. 确认提交 `3f6194432ebecb359997496ead2a88afd7b693d8` 存在，并核对 Node/pnpm/Rust 版本。
4. 重新运行冻结安装、前端测试、Rust 测试和生产构建；任何失败先记录差异，不得假设工期 0 正常。
5. 基线复验通过后，再从完成提交创建或继续 `codex/phase-01-editor-poc`，只新增 `EditorAdapter` POC 边界。
