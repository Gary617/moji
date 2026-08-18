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
| EditorAdapter 契约 | Mock open/edit/saveAs/close，禁止覆盖源文件 | `pnpm test` | PASS，3 个 editor 测试覆盖 |
| EditorAdapter 错误 | ZetaOffice runtime 缺失映射 `ZETA_RUNTIME_UNAVAILABLE` 并给出只读回退 | `pnpm test` | PASS |
| EditorAdapter bridge | 注入 runtime 完成 health/open/edit/saveAs/preview/close 生命周期 | `pnpm test` | PASS |
| OOXML 夹具 | DOCX/PPTX/XLSX 各 8 个，共 24 个；表格、图片、批注、图表、中文字体、复杂排版、公式 | `pnpm generate:office-fixtures` | PASS，24 个可列举 ZIP 夹具 |
| 真实 Office POC | 打开 -> 修改 -> 另存 -> 关闭 -> 重开 -> 预览/ZIP/源哈希校验 | `pnpm test:editor-poc` | BLOCKED（预期非零；runner 子进程码 2）：24 total，PASS 0，DEGRADED 0，FAIL 24；原因 `ZETA_RUNTIME_UNAVAILABLE` |
| 源文件保护 | runtime 缺失时不执行写入；保存失败保留源哈希 | `pnpm test:editor-poc` | PASS（24 条均 `writeAttempted: false`，源文件未覆盖） |

## 当前自动化统计

- 前端：3 个测试文件，7 个测试，通过 7，失败 0。
- Rust：3 个单元测试，通过 3，失败 0。
- Office POC：24 个样本，0 PASS / 0 DEGRADED / 24 FAIL；这是环境阻塞证据，不是 mock 通过。
- 已知非失败输出：MSVC 链接器以中文输出“正在创建库”，Rust 1.97.1 将该 stdout 显示为 `linker_messages` warning；产物和测试均成功。
- 生产构建首次因全局 Node 24.13.0 / pnpm 11.22.0 不满足项目引擎约束而被正确拒绝；切换到 `PROJECT_CONTEXT.md` 要求的 Node 24.19.0 / pnpm 11.19.0 后原命令通过。
