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
- 边界：本期 worker 只负责元数据扫描，不启动正文提取；产品 UI、全局并发上限和背压属于后续阶段。

## D-016 扫描任务由独立 worker 异步执行

- 日期：2026-08-19
- 状态：已接受
- 决策：`library_start_scan`、watcher 轮询、恢复和失败重试只写入 `queued` 状态并立即返回；后台 worker 使用独立 SQLite 连接执行扫描，按文件条件更新进度。控制命令通过持久化状态让 worker 在文件边界暂停或取消；应用启动连接负责 `running -> paused` 恢复，worker 连接不重复执行该恢复。
- 理由：同步 IPC 无法在扫描期间提供暂停/取消，也无法让前端观察结构化进度；独立连接保持控制命令可用，同时保留稳定 `ScanJobId` 和事件顺序。
- 边界：worker 不移动、复制、重命名或删除原文件；正文提取仍由后续阶段消费 `contentState: pending`。

## D-017 搜索使用 FTS5 trigram 与独立组织关系

- 日期：2026-08-19
- 状态：已接受
- 决策：migration v2 使用 bundled SQLite FTS5 `trigram` 虚拟表索引标题、正文预留字段、路径、标签和 OCR 预留字段；标题/正文/路径/标签/OCR 的 BM25 权重固定为 `12/1/4/3/1`。集合、标签、收藏和最近使用放在独立关系表，不修改 `documents` 的物理路径。
- 理由：trigram 能在不重新遍历授权文件系统的前提下支持中文子串；独立关系表保证同一文档可属于多个集合/标签，并让索引重建不影响元数据。
- 边界：三字以下查询回退到标题、路径、标签的子串条件；正文、OCR 和页码/幻灯片/段落定位均由后续阶段填充。

## D-018 搜索 API 和三栏 UI 成为工期 4 稳定边界

- 日期：2026-08-19
- 状态：已接受
- 决策：`library_search` 返回稳定 `DocumentId`、展示字段、匹配片段、组织关系、收藏状态和 `SourceLocator`；前端导航/结果/工作区三栏及加载、空、无结果、错误状态保留。
- 理由：查看器可以在不改变搜索数据契约的情况下消费选中 Document，并在后续实现来源定位。
- 边界：绝对路径仅是受控展示字段，不能成为主键或跨模块引用；搜索层不得调用编辑器内部 API 或再次遍历未授权路径。

## D-019 工期 4 使用 Document ID 受控查看与写回

- 日期：2026-08-19
- 状态：已接受
- 决策：React 只通过 `document_*` IPC 传递 Document ID 和编辑内容；Rust 从已登记文档解析路径、校验哈希、创建 Snapshot，并以临时文件/备份执行写回。文本格式支持编辑；PDF/Office/图片按 Registry 能力只读降级。
- 理由：保持扫描器授权边界，避免把绝对路径变成前端主键或静默覆盖外部修改；Snapshot 让失败写回和恢复可验证。
- 边界：ZetaOffice POC 仍是工期 1 的能力证据，不代表桌面 runtime bridge 已接入；另存入口保留为冲突状态动作，当前不调用未授权文件对话框。

## D-020 批注优先稳定锚点，无法稳定时显式降级

- 日期：2026-08-19
- 状态：已接受
- 决策：批注保存页码、幻灯片、段落、字符范围、引用文本和 `stable` 标记；当前 PDF 页码为稳定锚点，文本使用引用文本字符范围，Office 和图片使用文档级降级。
- 理由：未完成正文提取/版面解析时不猜测位置，重载后仍能显示用户批注及其定位可信度。

## D-021 本地 PP-OCR 只从受控离线模型目录加载

- 日期：2026-08-19
- 状态：已接受
- 决策：使用 `ppocr-rs 0.7.3` 的 PP-OCRv6 Tiny 和 `ort 2.0.0-rc.9` / ONNX Runtime CPU 1.26.0；运行时只从应用数据目录旁 `ocr-models/` 读取 `det.onnx`、`rec.onnx`、同模型导出的 `dictionary.txt` 和校验过的 CPU runtime DLL。可选 PP-LCNet 方向模型用于旋转页。
- 理由：OCR 文档和模型必须留在本机，模型获取应是可审计的安装步骤而不是隐藏的联网副作用。模型/运行时缺失或损坏需要成为明确、可重试的结构化任务失败。
- 边界：扫描 PDF 依赖本机 `pdftoppm`，有效 PDF 文本层通过 `lopdf` 提取并跳过 OCR；模型取得是显式安装步骤，运行期间完全离线。模型提交、哈希和小样本性能证据记录在 `docs/ocr-models.md`，不得把合成小样本准确率外推为生产准确率。

## D-022 AI 只通过受控 Provider 和统一片段读取文档

- 日期：2026-08-19
- 状态：已接受
- 决策：Rust `AiProvider` 是唯一模型边界；上下文服务只消费明确授权的 `DocumentId`/页片段，前端不得传路径、读取私有表或隐式上传全文。`@文档(id)` 只扩展用户明确选择。
- 理由：复用工期 5 的统一正文入口，避免 AI 模块绕过授权目录和资料库策略。
- 边界：当前文本文档若没有已生成页片段只显示零正文来源，不能通过路径回退读取；后续正文提取必须扩展受控片段接口。

## D-023 API Key 使用 Windows Credential Manager

- 日期：2026-08-19
- 状态：已接受
- 决策：OpenAI Key 只从 Windows Credential Manager 的 generic target `moji/openai/api-key` 读取；不提供 API Key 修改工具，不写前端状态、日志、数据库或错误 details。自动化使用内存凭据/Mock，不需要真实 Key。
- 理由：桌面应用避免把凭据放进源码、配置文件或渲染进程，并保持无 Key 可测试。
- 边界：Credential Manager ACL、轮换和企业策略属于工期 7 手工审计；真实 API 只做手工冒烟。

## D-024 三级权限与工具白名单

- 日期：2026-08-19
- 状态：已接受
- 决策：`suggest` 仅只读和建议工具，`assist` 只产生待审阅变更且需要 `approved=true`，`autonomous` 只允许当前会话明确授权目标。删除、移动、系统命令、未选路径读取和 API Key 工具永久禁止。
- 理由：把建议、用户接受后的协助修改和受限自主修改分开，防止模型输出直接成为写文件权限。
- 边界：工具参数模糊化、会话撤销、SSE 重连去重和审计防篡改列入工期 7 攻击面。

## D-025 AI 写回复用 Snapshot/冲突并审计

- 日期：2026-08-19
- 状态：已接受
- 决策：所有 AI 写回调用既有 `document_save`，沿用写前 Snapshot、SHA-256 外部修改检测、临时文件/备份和恢复；每次工具请求、拒绝、应用或错误写入 v5 `ai_actions`，细节只含稳定码和受控标识。
- 理由：不复制另一套写回逻辑，保持源文件保护和可追溯审阅。
- 边界：审计保留期限和防篡改存储未在本工期实现。
