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
| SQLite migration | 空库创建工期 2 表和 v2 搜索/组织表；重复 migration 保留已有 SourceRoot | `pnpm test:rust`（Rust PATH） | PASS：schema v2，幂等 |
| 授权边界 | 授权目录、同级路径穿越、`node_modules`、隐藏/系统/Junction 策略和格式识别 | `pnpm test:rust`（Rust PATH） | PASS：未授权路径结构化拒绝，默认排除原因可见 |
| 增量扫描 | 临时目录的 DOCX/TXT 和单文件来源新增、未变重扫、修改、删除、重命名、重复导入、未支持格式和 `node_modules` | `pnpm test:rust`（Rust PATH） | PASS：Document ID 在重命名后保持，外部删除标记 missing，事件持久化 |
| 元数据完整性 | canonical path、格式、大小、mtime、File ID（可用时）和 SHA-256 | `pnpm test:rust`（Rust PATH） | PASS：仅登记元数据，未写原文件 |
| 扫描任务 | queued/running/paused/cancelled/failed/completed 转换、非法转换、重试、重开恢复、后台 worker 连接 | `pnpm test:rust`（Rust PATH） | PASS：非法状态返回 `INVALID_JOB_STATE`，重开后 running -> paused，worker 不误暂停现有任务 |
| 文件监控适配 | notify create/rename 事件规范化并过滤未授权路径 | `pnpm test:rust`（Rust PATH） | PASS：授权根外事件被丢弃 |
| 资料库 IPC | SourceRoot/ScanJob stable ID、扫描事件读取和既有成功信封序列化 | `pnpm test:rust`（Rust PATH） | PASS：结构化请求/响应 |
| FTS 中文子串 | 标题、正文预留字段、路径、标签、OCR 预留字段的 trigram 索引和三字以下回退 | `pnpm test:rust`（Rust PATH） | PASS：中文“全文检索”命中并返回片段 |
| 搜索权重/组合筛选 | 标题/路径/标签权重、格式/时间/来源/集合/标签/状态/收藏/最近使用 AND 过滤 | `pnpm test:rust`（Rust PATH） | PASS |
| 虚拟组织 | Collection/Tag 多对多、收藏、最近使用，Document ID 稳定且原文件不动 | `pnpm test:rust`、`pnpm test` | PASS |
| 增量索引完整性 | 元数据 upsert 后索引失败独立记录；重建可恢复 FTS | `pnpm test:rust` | PASS：Document 元数据不被索引错误破坏 |
| 索引性能 | 1,000 条文档、30 次查询、limit 50，AMD Ryzen 7 8845H / 8C16T / 27.8 GB / Windows 11 | `cargo test ... indexed_query_p95... -- --nocapture` | PASS：p95 53 ms |
| 三栏资料库 UI | 导航、结果、工作区；加载/空/无结果/错误和过滤器 | `pnpm test`、本地浏览器截图 | PASS：前端 10/10；桌面和 390px 小屏无重叠 |

## 当前自动化统计

- 前端：6 个测试文件，15 个测试，通过 15，失败 0。
- Rust：当前工作树 29 个单元测试，通过 29，失败 0；其中工期 4 文档服务新增 3 个测试、工期 5 新增 3 个测试。
- 本地资料库：临时目录涵盖新增、未变、修改、删除、重命名、重复导入、未支持格式、授权边界、持久化事件、暂停/恢复/取消/重试和数据库重开恢复；失败 0。权限不足/独占锁定使用相同 `PERMISSION_DENIED`/`HASH_READ_FAILED` 结构化路径，仍需在真实受限 ACL 和独占锁文件上做桌面手工演练。
- Office POC：浏览器真实矩阵 24 个样本，24 PASS / 0 DEGRADED / 0 FAIL；Node runner 在无 runtime bridge 环境仍为 BLOCKED，这是两条不同证据链。
- 已知非失败输出：MSVC 链接器以中文输出“正在创建库”，Rust 1.97.1 将该 stdout 显示为 `linker_messages` warning；产物和测试均成功。
- 搜索性能测试记录硬件和样本规模：1,000 文档、30 次查询、limit 50，p95 53 ms；这是一项 bundled SQLite 内存数据库基准，不代表大规模磁盘库或正文提取后的最终性能。
- 生产构建首次因全局 Node 24.13.0 / pnpm 11.22.0 不满足项目引擎约束而被正确拒绝；切换到 `PROJECT_CONTEXT.md` 要求的 Node 24.19.0 / pnpm 11.19.0 后原命令通过。

## 工期 4 查看器与恢复

| 层级 | 样本/目标 | 命令 | 结果 |
| --- | --- | --- | --- |
| Rust 文档服务 | Markdown 保存前快照、正常重开和快照恢复 | `cargo test --manifest-path src-tauri/Cargo.toml library::document::tests::saves_text_only_after_snapshot_and_restores_original_bytes` | PASS |
| Rust 冲突安全 | 外部修改阻止静默覆盖，原文件保持外部内容 | `cargo test --manifest-path src-tauri/Cargo.toml library::document::tests::detects_external_modification_without_overwriting_file` | PASS |
| Rust 批注 | 引用文本字符范围锚点保存/重载 | `cargo test --manifest-path src-tauri/Cargo.toml library::document::tests::persists_annotations_with_explicit_unstable_anchor_fallback` | PASS |
| 前端 IPC | Document ID、哈希、模式、批注锚点请求形状 | `pnpm test` | PASS，14/14 |
| 前端 Registry | Markdown/TXT/CSV、PDF.js、Office、未支持格式分流 | `pnpm test` | PASS |
| 前端构建 | PDF.js worker、查看器工作区和状态 UI | `pnpm build` | PASS |

已知降级：Office 产品宿主 runtime bridge 未配置，保持只读；PDF 只渲染第一页；非 OCR 的段落稳定定位尚未完成；另存入口显示但等待受控文件对话框能力。

## 工期 5 OCR 与后台任务队列

| 层级 | 样本/目标 | 命令 | 结果 |
| --- | --- | --- | --- |
| Rust OCR schema/片段 | v4、OCR 任务元数据与进度、页文本/置信度/文字框、OCR FTS 与命中页框 | `pnpm test:rust` | PASS：Rust 29/29 |
| Rust OCR 离线失败 | 必需 PP-OCR/ORT 资产缺失返回 `OCR_MODEL_MISSING`，不访问网络 | `pnpm test:rust` | PASS：缺少 4 项资产被结构化报告 |
| 前端 OCR IPC | 仅用 `DocumentId` 创建 OCR、仅用 `DocumentId/page` 读片段 | `pnpm test` | PASS：15/15 |
| OCR 真实样本 | 中文、英文、旋转、空白、有/无文本层 PDF、PNG/JPG/TIFF/BMP、损坏输入、恢复/重试；准确率/耗时/内存/失败率 | 已安装批准的离线模型后运行桌面手工矩阵 | BLOCKED：当前环境无法取得并校验模型资产，未伪造性能数据 |
