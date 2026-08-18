# 技术决策

## D-001 当前目录使用独立 Git 仓库

- 日期：2026-08-18
- 状态：已接受
- 决策：在 `C:\Users\Gary\Desktop\墨集` 初始化独立 Git，分支为 `codex/phase-00-foundation`。
- 理由：开始检查发现父级 Git 顶层为 `C:\Users\Gary`，在父仓库提交会污染整个用户目录并扩大数据风险。

## D-002 使用最小手工脚手架并精确固定版本

- 日期：2026-08-18
- 状态：已接受
- 决策：依据 Tauri 2 标准目录手工建立最小工程，Node 和 Rust 直接依赖使用 2026-08-18 查询到的稳定精确版本，解析结果写入锁文件。
- 替代方案：在非空目录直接运行通用脚手架；该方案可能改写既有文档或生成无关示例，因此未采用。

## D-003 IPC 使用显式成功/失败信封

- 日期：2026-08-18
- 状态：已接受
- 决策：所有自定义命令返回 `{ status: "success", data }` 或 `{ status: "error", error }`，失败对象包含 `code`、`message`、`retryable`、`details`。
- 理由：让前端稳定区分业务失败与 Tauri 传输异常，并为后续阶段保留可演进的错误码边界。

## D-004 Rust 日志采用稳定事件字段

- 日期：2026-08-18
- 状态：已接受
- 决策：使用 `tracing`，至少记录 `event`，IPC 完成事件记录 `command` 和 `outcome`；禁止敏感正文、密钥和未脱敏路径。
- 替代方案：引入文件日志插件；工期 0 不需要文件轮转，暂不增加插件和权限面。

## D-005 工期 0 界面只展示真实健康状态

- 日期：2026-08-18
- 状态：已接受
- 决策：首屏仅展示品牌、Rust 后端状态、应用版本、IPC 协议和重新检查动作。
- 理由：满足可运行验收，同时避免用假数据提前实现资料库、搜索或编辑器界面。

## D-006 生产构建基线使用 `--no-bundle`

- 日期：2026-08-18
- 状态：已接受
- 决策：`pnpm build:desktop` 调用 `tauri build --no-bundle`，验收 release 可执行文件而不生成安装包。
- 理由：工期 0 验证编译和运行骨架；安装器、签名和升级属于发布工期。

## D-007 不因本机全局工具漂移降低版本要求

- 日期：2026-08-18
- 状态：已接受
- 决策：保留 Node `>=24.15.0 <25` 和 pnpm `11.19.0` 要求；本期使用工作区 Node 24.19.0 / pnpm 11.19.0 验收。
- 理由：系统 PATH 中另有 Node 24.13.0 / pnpm 11.22.0，Tauri 子进程首次命中后被引擎检查拒绝。降低要求会违背 jsdom 等直接依赖的稳定引擎声明，也会掩盖新窗口环境漂移。

## D-008 EditorAdapter 隔离 ZetaOffice/zetajs

- 日期：2026-08-18
- 状态：已接受
- 决策：`src/editor/types.ts` 固定 `healthCheck`、`open`、`readOnlyPreview`、`edit`、`saveAs`、`close` 六个方法；`ZetaOfficeAdapter` 通过注入的 `ZetaOfficeRuntime` bridge 调用 zetajs，React/业务层不得接触 UNO 对象。
- 理由：ZetaOffice/zetajs 的 worker、canvas、UNO 生命周期属于高风险可替换实现；隔离后可以在不改业务契约的情况下更换编辑器或保留只读模式。

## D-009 POC 失败必须结构化并回退只读

- 日期：2026-08-18
- 状态：已接受
- 决策：运行时不可用、格式/保存/重开失败分别映射稳定错误码；`saveAs` 归一化后禁止覆盖源文件；runner 对每个样本记录 PASS/DEGRADED/FAIL、阶段、错误、回退和源哈希。
- 理由：不能把 mock 或“调用成功”当作文件完整性证据；保存失败时保留源文件是最高优先级的不变量。

## D-010 Node runner 初始结论为 BLOCKED

- 日期：2026-08-18
- 状态：已接受
- 决策：官方资料确认 `zetajs` `1.2.0` 为 MIT、ZetaOffice 开放 beta 且提供 Windows 安装包；在没有 Node runtime bridge 的环境中，`pnpm test:editor-poc` 必须保留 `ZETA_RUNTIME_UNAVAILABLE`/`BLOCKED`，不能宣称 Node runner 支持写回。
- 选项：下一阶段前更换编辑器；首版只读；或延后 Office 写回。索引模块不得默认依赖 Office 写回。

## D-011 浏览器 POC 使用官方 CDN runtime

- 日期：2026-08-19
- 状态：已接受
- 决策：工期 1 使用官方 `https://cdn.zetaoffice.net/zetaoffice_latest/` 加载 `soffice.js`、WASM 和 data，在 `public/editor-poc/` 的 worker 中封装 UNO；不把二进制提交到仓库。
- 理由：Windows 浏览器/WebView2 边界可以在不安装桌面 MSI 的情况下验证真实 `Module.zetajs` 生命周期；CDN 响应已确认 CORS/`Cross-Origin-Resource-Policy` 可用。
- 约束：`zetaoffice_latest` 不是锁定版本；正式发布前必须锁定构建或自托管并记录校验值。

## D-012 浏览器真实矩阵结论为 PASS

- 日期：2026-08-19
- 状态：已接受
- 决策：24 个代表性 DOCX/PPTX/XLSX 夹具在真实浏览器 ZetaOffice runtime 中全部通过打开、修改、OOXML filter 另存、关闭、重开、编辑标记、主部件和源 SHA-256 校验；另有真实产品方案 DOCX smoke sample 通过。POC 结论为 `PASS`。
- 边界：该 PASS 证明浏览器 worker 的格式回环，不证明所有真实用户文件的视觉保真、不证明离线 CDN 可用，也不替代 Node/Tauri WebView2 自动化 runner。

## D-013 本地资料库使用 migration v1 的内置 SQLite

- 日期：2026-08-19
- 状态：已接受
- 决策：使用 `rusqlite 0.40.2` 的 `bundled` SQLite，在应用数据目录创建 `library.sqlite3`，以 `PRAGMA user_version = 1` 管理 `source_roots`、`documents`、`scan_jobs`、`scan_events`。migration 可重复运行，不删除已有记录。
- 理由：资料库必须离线、可测试且不依赖用户安装的 SQLite。Document、SourceRoot 和 ScanJob 均使用独立稳定 ID，避免以绝对路径作为跨模块主键。
- 边界：本期不加密数据库、不做全文索引或正文提取；SQLCipher 和 FTS5 分别属于安全和搜索工期。

## D-014 扫描只处理显式授权来源并默认排除高风险路径

- 日期：2026-08-19
- 状态：已接受
- 决策：授权来源必须 canonicalize；目录扫描仅限授权根，单文件仅限该文件。隐藏/系统/回收站/`node_modules`、符号链接/Junction/reparse point 默认跳过，原因写入 `ScanEvent`。扫描器绝不移动、复制、重命名或删除用户文件。
- 理由：目录遍历是本地应用最直接的权限边界，必须在进入队列前固定授权范围并避开可越界的 Junction。
- 边界：Windows File ID 是重命名首选键；哈希仅在唯一的失效路径候选中辅助重定位，不能把同内容的不同文件合并。

## D-015 扫描任务持久化且重启后停在可恢复状态

- 日期：2026-08-19
- 状态：已接受
- 决策：`ScanJob` 持久化 `queued|running|paused|cancelled|failed|completed`、进度、错误和重试次数。应用重开时所有 `running` 任务归一为 `paused`，需要显式恢复；`notify` 事件只在授权过滤后触发增量扫描请求。
- 理由：进程退出不能让前端认为任务仍在运行；明确的状态转换让暂停、取消和失败重试可测试。
- 边界：本期提供 `notify` watcher adapter，不启动产品级常驻调度循环；后续队列执行器必须复用同一状态机。
