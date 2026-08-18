# 墨集项目上下文

## 项目定位

墨集是面向 Windows 10/11 的本地文档管理桌面应用。本仓库采用 Tauri 2 + React + TypeScript + Rust 的本地模块化单体架构。工期 0 只建立可运行骨架和 IPC 基线，不包含文件、数据库、编辑器、检索、OCR、AI、账号或同步业务。

## 目录结构

```text
.
├── docs/                       # 长期上下文、计划、状态、决策、测试和交接
│   ├── plans/                  # 经确认的分阶段实施计划
│   └── handoffs/               # 每个工期的跨窗口交接
├── src/                        # React 产品代码
│   └── ipc/                    # 前端 IPC 类型和调用适配层
├── tests/
│   └── frontend/               # Vitest + Testing Library 前端单元测试
├── src-tauri/                  # Tauri/Rust 桌面核心
│   ├── capabilities/           # Tauri 2 窗口能力声明
│   ├── icons/                  # Tauri 生成的平台图标资源
│   └── src/
│       └── ipc/                # Rust IPC 命令和统一响应结构
├── package.json                # 前端、测试和桌面构建命令
├── pnpm-lock.yaml              # Node 依赖锁文件
├── pnpm-workspace.yaml         # pnpm 供应链策略例外记录
└── rust-toolchain.toml         # 固定 Rust 工具链
```

`_docx_render/` 是方案文档的既有渲染产物，来源不明且不属于应用代码，保留在本地并通过 `.gitignore` 排除。

## 架构边界

- React 只负责界面、交互状态和编辑器宿主。所有 Tauri 调用必须经过 `src/ipc/`，组件不得直接调用 `invoke`。
- Rust 是本地能力和权限边界。自定义命令放在 `src-tauri/src/ipc/`，不得把绝对路径、密钥或未授权内容直接暴露给前端。
- `tests/frontend/` 只测试前端状态和 IPC 适配；Rust 单元测试与实现放在同一模块的 `#[cfg(test)]` 中。
- 文档计划和交接放在 `docs/`。稳定事实写入本文件，阶段状态写入 `STATUS.md`，技术取舍写入 `DECISIONS.md`。
- 工期 0 不建立后续功能的假数据、占位仓储或业务接口。

## 版本要求

### 工具链

- Windows 10/11 x64，WebView2 Runtime。
- Node.js `>=24.15.0 <25`；本期验证版本 `24.19.0`。
- pnpm `11.19.0`。
- Rust `1.97.1`，目标 `x86_64-pc-windows-msvc`。
- Visual Studio 2022 C++ Build Tools（`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`）。

### 直接依赖

- Tauri Rust `2.11.5`，Tauri Build `2.6.3`，Tauri CLI `2.11.4`，Tauri JS API `2.11.1`。
- React/React DOM `19.2.8`，TypeScript `7.0.2`，Vite `8.2.1`。
- Vitest `4.1.11`，Testing Library React `16.3.2`，jsdom `30.0.1`。
- serde `1.0.229`，serde_json `1.0.151`，tracing `0.1.44`，tracing-subscriber `0.3.23`。

所有 Node 直接依赖使用精确版本，完整解析结果以 `pnpm-lock.yaml` 为准。所有 Rust 直接依赖使用精确版本，完整解析结果以 `src-tauri/Cargo.lock` 为准。

## 规范命令

在仓库根目录运行。安装 Rustup 后应重新打开终端，使 `%USERPROFILE%\.cargo\bin` 进入 `PATH`。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm test:rust
pnpm build
pnpm build:desktop
pnpm tauri dev
```

- `pnpm install --frozen-lockfile`：只按锁文件安装依赖。
- `pnpm test`：运行前端单元测试。
- `pnpm test:rust`：运行 Rust 单元测试。
- `pnpm build`：执行 TypeScript 类型检查和前端生产构建。
- `pnpm build:desktop`：执行前端生产构建并生成不打安装包的 Tauri release 可执行文件。
- `pnpm tauri dev`：启动开发服务器和真实桌面窗口，用于手工 IPC 验收。

## IPC 约定

IPC 协议版本从 `1` 开始。Rust 自定义命令必须返回统一信封，不以裸值作为成功响应。可预期业务失败也返回失败信封；Tauri 通道抛出的异常由 `src/ipc/` 归一为 `IPC_TRANSPORT_ERROR`。

成功：

```json
{
  "status": "success",
  "data": {}
}
```

失败：

```json
{
  "status": "error",
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "可向用户展示的简短说明",
    "retryable": false,
    "details": null
  }
}
```

- `code` 使用稳定的大写下划线机器码。
- `message` 不包含密钥、绝对路径或敏感正文。
- `retryable` 明确客户端是否可以提供重试动作。
- `details` 只放经过授权、可序列化且不敏感的结构化信息；无信息时为 `null`。

当前命令：

```text
health_check() -> IpcResponse<HealthCheckData>
HealthCheckData = { backendStatus: "ok", appVersion: string, protocolVersion: 1 }
```

## 日志约定

Rust 使用 `tracing`。日志事件至少包含稳定的 `event` 字段；IPC 完成事件还包含 `command` 和 `outcome`。当前约定示例：

```text
event="application_started" application="moji-desktop" version="0.1.0"
event="ipc_command_completed" command="health_check" outcome="success"
```

禁止记录 API Key、用户文档正文、未经脱敏的绝对路径和完整 IPC 请求体。工期 0 只输出到进程日志，不引入日志文件轮转或远程采集。
