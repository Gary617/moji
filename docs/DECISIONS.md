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

## D-010 ZetaOffice POC 结论为 BLOCKED

- 日期：2026-08-18
- 状态：已接受
- 决策：官方资料确认 `zetajs` `1.2.0` 为 MIT、ZetaOffice 开放 beta 且提供 Windows 安装包，但当前机器没有 runtime bridge/安装包；24 个真实 runner 样本全部 FAIL（`ZETA_RUNTIME_UNAVAILABLE`），不能宣称支持写回。
- 选项：下一阶段前更换编辑器；首版只读；或延后 Office 写回。索引模块不得默认依赖 Office 写回。
