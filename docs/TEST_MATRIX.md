# 测试矩阵

更新日期：2026-08-19

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
| 桌面生产构建 | Tauri release executable，无安装包 | `$env:PATH = "C:\\Users\\Gary\\.cargo\\bin;" + $env:PATH; pnpm build:desktop` | PASS，release 11,130,368 bytes |
| 桌面手工 | Windows 主窗口启动且布局无重叠 | `pnpm tauri dev` | PASS |
| IPC 手工 | 前端显示 Rust 运行正常、应用版本 `0.1.0`、协议 `v1` | `pnpm tauri dev` | PASS；Rust 日志记录 `ipc_command_completed` success |
| EditorAdapter 契约 | Mock open/edit/saveAs/close，禁止覆盖源文件 | `pnpm test` | PASS，3 个 editor 测试覆盖 |
| EditorAdapter 错误 | ZetaOffice runtime 缺失映射 `ZETA_RUNTIME_UNAVAILABLE` 并给出只读回退 | `pnpm test` | PASS |
| EditorAdapter bridge | 注入 runtime 完成 health/open/edit/saveAs/preview/close 生命周期 | `pnpm test` | PASS |
| OOXML 夹具 | DOCX/PPTX/XLSX 各 8 个，共 24 个；表格、图片、批注、图表、中文字体、复杂排版、公式 | `pnpm generate:office-fixtures` | PASS，24 个可列举 ZIP 夹具 |
| Node 侧 Office POC | 打开 -> 修改 -> 另存 -> 关闭 -> 重开 -> 预览/ZIP/源哈希校验 | `pnpm test:editor-poc`（报告 `results.node.{json,md}`） | 环境无 runtime bridge 时 BLOCKED（`ZETA_RUNTIME_UNAVAILABLE`）；不得用 mock 替代 |
| 浏览器真实 Office POC | 24 个 DOCX/PPTX/XLSX：打开 -> 修改 -> OOXML filter 另存 -> 关闭 -> 重开 -> marker/主部件/源哈希校验 | `pnpm dev` + `http://127.0.0.1:1420/editor-poc/index.html` 的 `Run 24-sample matrix` | PASS：24 total，24 PASS，0 DEGRADED，0 FAIL |
| 真实产品方案 DOCX smoke | 真实文档打开 -> 追加正文 -> 另存 -> 关闭 -> 重开 | 同上页面的 `Run DOCX round-trip` | PASS；源文件 SHA-256 `c0da3a...ac7c4c` 保持不变 |
| 源文件保护 | 每个浏览器样本比较源 SHA-256；目标使用独立虚拟路径 | 浏览器真实 Office POC | PASS（24 条 `sourcePreserved: true`，失败路径仍禁止覆盖） |
| SQLite migration | 空库创建 4 张资料库表；重复 migration 保留已有 SourceRoot | `pnpm test:rust`（Rust PATH） | PASS：schema v1，幂等 |
| 授权边界 | 授权目录、同级路径穿越、`node_modules`、隐藏/系统/Junction 策略和格式识别 | `pnpm test:rust`（Rust PATH） | PASS：未授权路径结构化拒绝，默认排除原因可见 |
| 增量扫描 | 临时目录的 DOCX/TXT 和单文件来源新增、未变重扫、修改、删除、重命名、重复导入、未支持格式和 `node_modules` | `pnpm test:rust`（Rust PATH） | PASS：Document ID 在重命名后保持，外部删除标记 missing，事件持久化 |
| 元数据完整性 | canonical path、格式、大小、mtime、File ID（可用时）和 SHA-256 | `pnpm test:rust`（Rust PATH） | PASS：仅登记元数据，未写原文件 |
| 扫描任务 | queued/running/paused/cancelled/failed/completed 转换、非法转换、重试、重开恢复、后台 worker 连接 | `pnpm test:rust`（Rust PATH） | PASS：非法状态返回 `INVALID_JOB_STATE`，重开后 running -> paused，worker 不误暂停现有任务 |
| 文件监控适配 | notify create/rename 事件规范化并过滤未授权路径 | `pnpm test:rust`（Rust PATH） | PASS：授权根外事件被丢弃 |
| 资料库 IPC | SourceRoot/ScanJob stable ID、扫描事件读取和既有成功信封序列化 | `pnpm test:rust`（Rust PATH） | PASS：结构化请求/响应 |

## 当前自动化统计

- 前端：3 个测试文件，7 个测试，通过 7，失败 0。
- Rust：19 个单元测试，通过 19，失败 0。
- 本地资料库：临时目录涵盖新增、未变、修改、删除、重命名、重复导入、未支持格式、授权边界、持久化事件、暂停/恢复/取消/重试和数据库重开恢复；失败 0。权限不足/独占锁定使用相同 `PERMISSION_DENIED`/`HASH_READ_FAILED` 结构化路径，仍需在真实受限 ACL 和独占锁文件上做桌面手工演练。
- Office POC：浏览器真实矩阵 24 个样本，24 PASS / 0 DEGRADED / 0 FAIL；Node runner 在无 runtime bridge 环境仍为 BLOCKED，这是两条不同证据链。
- 已知非失败输出：MSVC 链接器以中文输出“正在创建库”，Rust 1.97.1 将该 stdout 显示为 `linker_messages` warning；产物和测试均成功。
- 生产构建首次因全局 Node 24.13.0 / pnpm 11.22.0 不满足项目引擎约束而被正确拒绝；切换到 `PROJECT_CONTEXT.md` 要求的 Node 24.19.0 / pnpm 11.19.0 后原命令通过。
