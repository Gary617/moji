# 测试矩阵

更新日期：2026-08-18

| 层级 | 样本/目标 | 命令 | 结果 |
| --- | --- | --- | --- |
| 前端单元 | IPC 成功响应透传 | `pnpm test` | PASS |
| 前端单元 | Tauri 传输异常归一为 `IPC_TRANSPORT_ERROR` | `pnpm test` | PASS |
| 前端单元 | 成功状态和 `0.1.0` 版本渲染 | `pnpm test` | PASS |
| 前端单元 | 失败后点击重新检查恢复 | `pnpm test` | PASS |
| Rust 单元 | `health_check` 返回状态、应用版本和协议版本 | `pnpm test:rust` | PASS |
| Rust 单元 | IPC 成功信封 JSON 形状 | `pnpm test:rust` | PASS |
| Rust 单元 | IPC 失败信封 JSON 形状与 `details: null` | `pnpm test:rust` | PASS |
| 冻结安装 | `pnpm-lock.yaml` 不漂移 | `pnpm install --frozen-lockfile` | PASS，Already up to date |
| 前端生产构建 | TypeScript 类型检查 + Vite production | `pnpm build` | PASS，1799 modules transformed |
| 桌面生产构建 | Tauri release executable，无安装包 | `pnpm build:desktop` | PASS，release 8,762,880 bytes |
| 桌面手工 | Windows 主窗口启动且布局无重叠 | `pnpm tauri dev` | PASS |
| IPC 手工 | 前端显示 Rust 运行正常、应用版本 `0.1.0`、协议 `v1` | `pnpm tauri dev` | PASS；Rust 日志记录 `ipc_command_completed` success |

## 当前自动化统计

- 前端：2 个测试文件，4 个测试，通过 4，失败 0。
- Rust：3 个单元测试，通过 3，失败 0。
- 已知非失败输出：MSVC 链接器以中文输出“正在创建库”，Rust 1.97.1 将该 stdout 显示为 `linker_messages` warning；产物和测试均成功。
- 生产构建首次因全局 Node 24.13.0 / pnpm 11.22.0 不满足项目引擎约束而被正确拒绝；切换到 `PROJECT_CONTEXT.md` 要求的 Node 24.19.0 / pnpm 11.19.0 后原命令通过。
