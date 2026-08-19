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

- 前端：7 个测试文件，17 个测试，通过 17，失败 0。
- Rust：当前工作树 38 个单元测试，通过 38，失败 0；其中工期 6 新增 Provider、上下文、权限、审计和写回冲突测试。
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
| OCR 真实样本 | 9 文件：中文、英文、旋转、空白、有/无文本层 PDF、PNG/JPG/TIFF/BMP、损坏输入 | 本地 PP-OCRv6 Tiny + ONNX Runtime CPU 1.26.0 release 探针及资料库端到端测试 | PASS：合成目标字符串严格匹配 100%（小样本）；预热文字页 240-271 ms，空白页 225 ms，峰值 159.7 MiB，有效 OCR 输入 6/6 成功 |
| OCR 资料库端到端 | 授权单文件 -> 扫描 -> DocumentId -> OCR/text_layer -> fragments -> FTS -> page/boundingBox，源哈希不变 | 工期 5 基线的 ignored real-model integration test | PASS：1/1，3 文档 debug 总耗时 25.22 秒；有文本层 PDF 未调用 OCR，搜索返回页 1 与文字框 |

## 工期 6 AI 对话、上下文与权限

| 层级 | 样本/目标 | 命令 | 结果 |
| --- | --- | --- | --- |
| Rust Mock Provider | 流式文本、Completed、无 Key、限流、断网、超时、中途取消 | `pnpm test:rust` | PASS：Mock 结构化事件/错误 |
| Rust Provider 安全 | API Key 不进入事件、错误或日志；OpenAI 请求只由 Rust 代理 | `pnpm test:rust`、静态 `rg` 审计 | PASS：未发现硬编码 Key；错误不含凭据/正文 |
| @文档 上下文 | `@文档(id)`、`@文档:id`、`@doc:id`、显式页选择、来源/规模/token 预览和截断 | `pnpm test:rust` | PASS：无显式 Document ID 不读取；`untrusted=true` |
| 提示注入隔离 | 文档正文包含改变权限/系统提示/工具白名单的指令 | `pnpm test:rust` | PASS：正文仅作为 `<untrusted_text>`，工具白名单固定 |
| 工具白名单 | 只读/建议/写入/禁止工具和越权目标拒绝 | `pnpm test:rust` | PASS：`AI_TOOL_DENIED`，写工具未执行 |
| 三级权限 | suggest 不写；assist 未接受不写；autonomous 仅授权目标 | `pnpm test:rust` | PASS；写回复用 Snapshot/哈希冲突 |
| AiAction 审计 | 请求、拒绝、应用、Provider 错误，细节不含正文/路径/Key | `pnpm test:rust` | PASS：migration v5、审计可查询 |
| 前端 AI IPC | ContextPreview、流式事件、权限/授权目标请求形状，传输异常脱敏 | `pnpm test` | PASS：17/17 |
| 前端生产构建 | AI IPC/助手面板类型检查 + Vite production | `pnpm build` | PASS：1811 modules transformed |
| 真实 OpenAI API | Windows Credential Manager Key、SSE 文本/工具事件、手工取消 | 受控桌面环境手工冒烟 | NOT RUN：无批准 Key；不影响 Mock 结论 |

## 工期 7 安全、冲突恢复与可靠性

| 层级 | 样本/目标 | 命令 | 结果 |
| --- | --- | --- | --- |
| DPAPI 密钥 | 32 字节数据库密钥保护/解保护，密文不等于明文 | `pnpm test:rust` | PASS：Windows DPAPI round-trip |
| 数据库加密门禁 | SQLCipher `cipher_version` 缺失时阻断启动，不回退明文 | 阶段 7 `pnpm test:rust` / `pnpm build:desktop` | BLOCKED（历史）：初始构建缺 `OPENSSL_DIR`；工期 8 改用 vendored OpenSSL 后仍须验证 Perl 构建前置 |
| 路径授权 | `..` 兄弟路径、文件 symlink、Junction/reparse、外部替换 | `pnpm test:rust` | PASS：canonical/source 重验和 symlink 回归 |
| 写回恢复 | 锁定/外部修改、临时文件 create_new、原子替换、备份恢复、Snapshot 留存 | `pnpm test:rust` | PASS：冲突不覆盖；43 Rust tests 全部通过；Snapshot 上限 20 |
| 提示注入 | 正文尝试闭合不可信标签、提升权限、调用禁止工具、读取未选目标 | `pnpm test:rust` | PASS：转义、目标授权和禁止工具拒绝 |
| CSP/资源边界 | 远程脚本、导航、frame/object/form、非 IPC connect | 静态审计 `src-tauri/tauri.conf.json` | PASS：self/ipc/`http://ipc.localhost` 白名单 |
| 秘密/日志扫描 | API Key、绝对路径、正文不得出现在日志/错误/审计细节 | `rg -n "sk-|api.?key|canonical_path|content" src-tauri/src/logging.rs src-tauri/src/ai src-tauri/src/ipc` | PASS：仅稳定码/受控 ID |
| 依赖许可证 | Node/Rust direct dependency license and version inventory | `THIRD_PARTY_NOTICES.md` + lockfiles | PASS：清单已生成；发布前仍需供应链扫描 |

## 工期 8 发布验收

| 发布门 | 目标 | 命令/证据 | 结果 |
| --- | --- | --- | --- |
| 安全生产 Rust | SQLCipher + DPAPI 生产 feature | `cargo test --manifest-path src-tauri/Cargo.toml --features secure-db` | FAIL：vendored OpenSSL 构建需要 Perl，当前工作站未安装 |
| 桌面生产构建 | NSIS `currentUser` 安装包 | `pnpm build:desktop` | FAIL：同一 OpenSSL/Perl 阻断，未生成包 |
| 安装包校验 | 安装包路径、大小、SHA-256 | 生成 NSIS 后 `Get-FileHash` | NOT TESTED：无安装包 |
| Windows 10 | 安装、首次启动、升级、migration、卸载、数据保留/删除 | 实机手工 | NOT TESTED |
| Windows 11 | 安装、首次启动、升级、migration、卸载、数据保留/删除 | 实机手工 | NOT TESTED |
| 加密烟测 | `cipher_version`、无明文正文/Key、缺 DPAPI key 拒绝打开 | 生产数据库 + 十六进制/恢复演练 | NOT TESTED |
| 完整桌面 E2E | 授权目录 -> 扫描 -> 搜索 -> 打开 -> 编辑/批注 -> Snapshot -> OCR -> AI -> 冲突 -> 恢复 | Windows Tauri 实机 | NOT TESTED |
| 视口/DPI/键盘 | 1366x768、1920x1080、125%、150%、键盘导航和状态 | Windows Tauri 实机 | NOT TESTED |
| 崩溃恢复 | 任务暂停、临时文件/备份残留、恢复命令 | Windows 实机演练 | NOT TESTED |
| 真实 AI | Credential Manager、SSE、取消/限流/断网 | 受控 Key 手工冒烟 | NOT TESTED |
| 发布性能 | 冷/热启动、扫描吞吐、大文件/UI 影响 | release 安装包 | NOT TESTED；仅有历史小样本基线 |

工期 8 的完整证据与阻断说明见 `docs/release/TEST_REPORT-0.1.0-rc.1.md`。
