import {
  Activity, ArrowLeft, ArrowRight, BarChart3, BookOpen, Brain, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, Database,
  Eye, EyeOff, HelpCircle, Inbox, KeyRound, Layers3, Lightbulb, MessageSquareText, Pencil, Plus, Radio, RotateCcw, Save, Search, Settings2, ShieldCheck, Sparkles, Trash2, Wifi, X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  answerGoalQuestion,
  confirmGoalResearch,
  applyPlanProposal,
  createDailyRebalanceProposal,
  createReplanProposal,
  createStarterTaskProposal,
  deleteMemory,
  extractExplicitMemoryCandidate,
  recordExplicitMemoryFromChat,
  minutesLabel,
  parseTemporaryArrangement,
  relevantMemories,
  memoryLifecycle,
} from "./engine";
import { createWorkbenchId, localDateKey, type AiMessage, type DailyCheckIn, type MemoryEntry, type PlanProposal, type WorkbenchAiConfig, type WorkbenchState } from "./model";
import { buildWorkbenchAgentSnapshot, workbenchStateVersion } from "./agentContext";
import { parseAgentResponse } from "./agentProtocol";
import { filterChangesForPermission, requiresConfirmation, type AgentPermissionMode } from "./agentPermissions";
import { cancelDesktopWorkbenchAi, checkDesktopWorkbenchAiBalance, clearDesktopWorkbenchAiCredentials, commitDesktopWorkbenchAgentState, getDesktopWorkbenchAiCredentialStatus, askDesktopWorkbenchAi, isDesktopWorkbench, saveDesktopWorkbenchAiCredentials, testDesktopWorkbenchAiConnection, validateDesktopWorkbenchGoalAnswer, type WorkbenchAgentEvent } from "../ipc/workbench";

type UpdateData = (updater: (current: WorkbenchState) => WorkbenchState) => void;

const AGENT_PERMISSION_OPTIONS: Array<{ value: AgentPermissionMode; label: string; detail: string }> = [
  { value: "suggest", label: "建议：只分析", detail: "只提供分析与建议" },
  { value: "assist", label: "协助：确认后执行", detail: "执行前需要你的确认" },
  { value: "autonomous", label: "自主：仅低风险动作", detail: "仅自动处理低风险动作" },
];

function AgentPermissionPicker({ value, onChange, disabled }: { value: AgentPermissionMode; onChange: (value: AgentPermissionMode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(0, AGENT_PERMISSION_OPTIONS.findIndex((option) => option.value === value));
  const activeOption = AGENT_PERMISSION_OPTIONS[activeIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const choose = (next: AgentPermissionMode) => {
    onChange(next);
    setOpen(false);
  };

  return <div className={`agent-permission-picker${open ? " is-open" : ""}`} ref={rootRef}>
    <button
      type="button"
      className="agent-permission-trigger"
      role="combobox"
      aria-label="Agent 权限"
      aria-expanded={open}
      aria-controls="agent-permission-options"
      aria-haspopup="listbox"
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setOpen(false); return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const next = AGENT_PERMISSION_OPTIONS[(activeIndex + delta + AGENT_PERMISSION_OPTIONS.length) % AGENT_PERMISSION_OPTIONS.length];
          choose(next.value);
        }
        if ((event.key === "Enter" || event.key === " ") && open) { event.preventDefault(); setOpen(false); }
      }}
    >
      <span className="agent-permission-trigger-copy"><strong>{activeOption.label}</strong><small>{activeOption.detail}</small></span>
      <ChevronDown aria-hidden="true" />
    </button>
    {open && <div id="agent-permission-options" className="agent-permission-menu" role="listbox" aria-label="Agent 权限选项">
      {AGENT_PERMISSION_OPTIONS.map((option) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        className={`agent-permission-option${option.value === value ? " is-selected" : ""}`}
        key={option.value}
        onClick={() => choose(option.value)}
      ><span><strong>{option.label}</strong><small>{option.detail}</small></span>{option.value === value && <Check aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}

function normalizeAssistantText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]*[—–][ \t]*/g, "\n")
    .replace(/(^|\n)[ \t]*[-*•][ \t]+/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Ordinary chat never uses the confirmation gate for memory. Models from an
 * older prompt may still append a polite "是否确认保存..." sentence, so keep
 * this cleanup independent from the local candidate extractor. This also
 * cleans messages persisted by an older desktop build when they are rendered.
 */
function stripMemoryConfirmation(value: string): string {
  const hasMemoryTemplate = /(?:拟保存内容|保存内容|保存理由|记忆依据|建议作为(?:可复用的)?个人背景保存|建议写入本地记忆|建议保存为记忆|保存这条记忆|写入本地记忆)/i.test(value);
  const cleaned = hasMemoryTemplate
    ? value
      .replace(/(?:^|\n)[ \t]*(?:[*_`#-]+[ \t]*)?(?:拟保存内容|保存内容|保存理由|记忆依据|依据|用途|不确定性)[ \t]*[:：][^\n]*(?:\n|$)/gi, "\n")
      .replace(/(?:^|\n)[^\n]*(?:建议作为(?:可复用的)?个人背景保存|建议写入本地记忆|建议保存为记忆)[^\n]*(?:\n|$)/g, "\n")
      .replace(/(?:^|\n)[^\n]*(?:是否确认|请确认|要不要|需不需要|是否需要)[^\n]{0,80}(?:保存|记住|写入|加入)[^\n]{0,40}(?:记忆|本地)[^\n]*(?:\n|$)/g, "\n")
      .replace(/(?:是否确认|请确认|要不要|需不需要|是否需要)[^。！？\n]{0,80}(?:保存|记住|写入|加入)[^。！？\n]{0,40}(?:记忆|本地)[^。！？\n]*[。！？]?/g, "")
    : value;
  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAutoMemoryReply(value: string, hasAutoMemory: boolean): string {
  const normalized = stripMemoryConfirmation(normalizeAssistantText(value));
  if (!hasAutoMemory) return normalized || "我会根据这次对话自动判断是否需要记录本地记忆。你也可以随时在本地记忆中查看或删除。";
  const lines = normalized.split("\n").filter((line) => {
    const plain = line.replace(/[*_`]/g, "");
    return !/(是否确认|要不要|需不需要|是否需要|可以帮你).{0,40}(保存|记住|写入).{0,40}(记忆|本地)/.test(plain);
  });
  const cleaned = lines.join("\n")
    .replace(/建议作为(?:可复用的)?个人背景保存/g, "我已将这条稳定的个人背景记录到本地记忆中")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || "我已自动记录这条稳定的个人背景。你可以随时在本地记忆中修改、停用或删除。";
}

function displayChatTurnText(turn: { role: "user" | "assistant"; text: string }): string {
  if (turn.role === "user") return turn.text;
  return stripMemoryConfirmation(normalizeAssistantText(turn.text));
}

function isLegacyOrdinaryMemoryMessage(message: AiMessage): boolean {
  if (message.kind !== "information" || message.goalId || message.taskId || message.countdownId) return false;
  const original = normalizeAssistantText(message.body);
  const cleaned = stripMemoryConfirmation(original);
  return cleaned !== original && /记忆|个人背景/.test(original);
}

export function AiSettingsDialog({ data, updateData, close }: { data: WorkbenchState; updateData: UpdateData; close: () => void }) {
  const initialConfig = data.preferences.aiConfig;
  const [config, setConfig] = useState<WorkbenchAiConfig>(initialConfig);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [credentialState, setCredentialState] = useState<"checking" | "configured" | "missing" | "unavailable">("checking");
  const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [connectionCheck, setConnectionCheck] = useState<{ status: "running" | "success" | "error"; address: string; model: string; elapsedMs: number | null; protocol: string; detail: string; modelDirectory: string; modelFound: string; modelCount: number | null; modelProbeLatencyMs: number | null } | null>(null);

  useEffect(() => { void getDesktopWorkbenchAiCredentialStatus().then((response) => {
    if (response.status === "success") setCredentialState(response.data.configured ? "configured" : "missing");
    else setCredentialState("unavailable");
  }); }, []);

  const validate = () => {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) { setMessage({ tone: "error", text: "中转站地址必须以 http:// 或 https:// 开头。" }); return null; }
    if (!config.model.trim()) { setMessage({ tone: "error", text: "请填写模型名称。" }); return null; }
    const balanceUrl = config.balanceUrl?.trim() ?? "";
    if (balanceUrl && !/^https?:\/\//i.test(balanceUrl)) { setMessage({ tone: "error", text: "余额查询地址必须以 http:// 或 https:// 开头。" }); return null; }
    return { baseUrl, model: config.model.trim(), balanceUrl };
  };

  const persistConfig = (nextConfig: WorkbenchAiConfig) => updateData((current) => ({ ...current, preferences: { ...current.preferences, aiConfig: nextConfig } }));
  const testFailureLabel = (code: string) => code === "AI_CONNECTION_TIMEOUT" ? "连接测试超过 20 秒" : code === "AI_TIMEOUT" ? "中转站在规定时间内没有完成响应" : code === "AI_NETWORK" ? "无法建立网络连接" : code === "AI_INVALID_API_KEY" ? "API Key 无效或模型无权限" : code === "AI_RATE_LIMITED" ? "请求频率受限或账户额度不足" : code === "AI_NO_API_KEY" ? "本机尚未保存 API Key" : code === "AI_RESEARCH_TIMEOUT" ? "在线研究超过 100 秒" : "中转站接口或返回格式不兼容";

  const runConnectionTest = async (nextConfig: WorkbenchAiConfig) => {
    const startedAt = performance.now();
    setConnectionCheck({ status: "running", address: nextConfig.baseUrl, model: nextConfig.model, elapsedMs: null, protocol: "先检测模型目录，再发送最小推理请求", detail: "正在检查凭据、模型目录和真实回复，请保持窗口打开。", modelDirectory: "检测中", modelFound: "检测中", modelCount: null, modelProbeLatencyMs: null });
    const response = await testDesktopWorkbenchAiConnection(nextConfig);
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (response.status === "success") {
      const modelDirectory = response.data.modelDirectorySupported === true ? "可用" : response.data.modelDirectorySupported === false ? "未提供（不影响推理）" : "未返回目录";
      const modelFound = response.data.modelFound === true ? "已找到" : response.data.modelFound === false ? "目录未找到，仍已尝试推理" : "未返回目录";
      setConnectionCheck({ status: "success", address: nextConfig.baseUrl, model: response.data.model, elapsedMs: response.data.latencyMs ?? elapsedMs, protocol: response.data.protocol ?? "OpenAI 兼容接口", detail: response.data.reply ? `模型回复：${response.data.reply}` : "中转站已返回有效的模型内容。", modelDirectory, modelFound, modelCount: response.data.modelCount ?? null, modelProbeLatencyMs: response.data.modelProbeLatencyMs ?? null });
    } else {
      setConnectionCheck({ status: "error", address: nextConfig.baseUrl, model: nextConfig.model, elapsedMs, protocol: response.error.code, detail: `${testFailureLabel(response.error.code)}。${response.error.message}`, modelDirectory: response.error.code.includes("MODEL") ? "目标模型检查失败" : "未完成", modelFound: "未完成", modelCount: null, modelProbeLatencyMs: null });
    }
    return response;
  };

  const save = async () => {
    const nextConfig = validate();
    if (!nextConfig) return;
    if (credentialState === "checking") { setMessage({ tone: "info", text: "正在检查本机凭据，请稍候再试。" }); return; }
    if (credentialState === "unavailable") { setMessage({ tone: "error", text: "网页预览无法保存 API Key。请安装并打开墨集桌面端后配置。" }); return; }
    if (credentialState !== "configured" && !apiKey.trim()) { setMessage({ tone: "error", text: "请先填写 API Key，再保存并连接。" }); return; }
    setBusy("save"); setMessage(null);
    if (apiKey.trim()) {
      const response = await saveDesktopWorkbenchAiCredentials(apiKey.trim());
      if (response.status === "error") { setBusy(null); setMessage({ tone: "error", text: response.error.message }); return; }
      setCredentialState("configured"); setApiKey("");
    }
    persistConfig(nextConfig); setConfig(nextConfig);
    const response = await runConnectionTest(nextConfig);
    setBusy(null);
    if (response.status === "success") setMessage({ tone: "success", text: `配置已保存并连接成功，当前模型：${response.data.model}` });
    else setMessage({ tone: "error", text: `配置已保存，但连接失败：${response.error.message}` });
  };

  const test = async () => {
    const nextConfig = validate();
    if (!nextConfig) return;
    setBusy("test"); setMessage(null);
    if (apiKey.trim()) {
      const saved = await saveDesktopWorkbenchAiCredentials(apiKey.trim());
      if (saved.status === "error") { setBusy(null); setMessage({ tone: "error", text: saved.error.message }); return; }
      setCredentialState("configured"); setApiKey("");
    }
    const response = await runConnectionTest(nextConfig);
    setBusy(null);
    if (response.status === "success") { persistConfig(nextConfig); setConfig(nextConfig); setMessage({ tone: "success", text: `连接成功，当前模型：${response.data.model}` }); }
    else setMessage({ tone: "error", text: response.error.message });
  };

  const clear = async () => {
    setBusy("clear"); setMessage(null);
    const response = await clearDesktopWorkbenchAiCredentials();
    setBusy(null);
    if (response.status === "success") { setCredentialState("missing"); setMessage({ tone: "success", text: "API Key 已从本机凭据中清除。" }); }
    else setMessage({ tone: "error", text: response.error.message });
  };


  return <div className="workbench-dialog-layer"><section className="workbench-dialog ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
    <header><div><span>AI PROVIDER</span><h2 id="ai-settings-title">配置 AI 助手</h2><p>设置中转站地址和模型，API Key 会安全保存在本机凭据管理器。</p></div><button aria-label="关闭 AI 配置" onClick={close}><X /></button></header>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <section className="ai-settings-status"><div className={`ai-settings-status-dot is-${credentialState}`} /><div><strong>{credentialState === "configured" ? "API Key 已保存在本机" : credentialState === "checking" ? "正在检查凭据" : credentialState === "missing" ? "尚未配置 API Key" : "网页预览不支持远程 AI 配置"}</strong><span>{credentialState === "configured" ? "点击保存并连接，确认中转站和模型确实可用。" : credentialState === "unavailable" ? "请使用墨集桌面端保存 Key、测试连接和使用远程对话。" : "没有 Key 时，本地主动提醒和计划分析仍然可以继续。"}</span></div></section>
      <label>Base URL（中转站 API 地址）<input aria-label="中转站 API 地址" value={config.baseUrl} onChange={(event) => { setConfig((current) => ({ ...current, baseUrl: event.target.value })); setConnectionCheck(null); }} placeholder="https://你的中转站.example/v1" /><small>填写服务商提供的 Base URL，通常以 /v1 结尾。自动兼容 Responses 与 Chat Completions；也可填写完整接口路径。</small></label>
      <div className="ai-settings-grid"><label>模型名称<input aria-label="AI 模型名称" value={config.model} onChange={(event) => { setConfig((current) => ({ ...current, model: event.target.value })); setConnectionCheck(null); }} placeholder="例如：gpt-5、deepseek-chat" /></label><label>API Key<input aria-label="AI API Key" type={showKey ? "text" : "password"} value={apiKey} disabled={credentialState === "unavailable"} onChange={(event) => { setApiKey(event.target.value); setConnectionCheck(null); }} placeholder={credentialState === "configured" ? "已保存，留空保持不变" : credentialState === "unavailable" ? "请在桌面端配置" : "粘贴你的 API Key"} /><button type="button" className="ai-settings-key-toggle" disabled={credentialState === "unavailable"} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff /> : <Eye />}</button></label></div>
      <label>余额查询地址（可选）<input aria-label="余额查询地址" value={config.balanceUrl ?? ""} disabled={credentialState === "unavailable"} onChange={(event) => setConfig((current) => ({ ...current, balanceUrl: event.target.value }))} placeholder="中转站提供余额接口时填写，例如 https://.../billing" /></label>
      <div className="ai-settings-hint"><KeyRound /><span>Key 不会写入工作台 JSON、日志或记忆库。更换 Key 时直接粘贴新的值并保存。</span></div>
      {connectionCheck && <section className={`ai-connection-check is-${connectionCheck.status}`} role="status" aria-live="polite"><header><span className="ai-connection-check-mark">{connectionCheck.status === "running" ? <Radio /> : connectionCheck.status === "success" ? <CheckCircle2 /> : <CircleAlert />}</span><div><strong>{connectionCheck.status === "running" ? "正在测试 AI 连接" : connectionCheck.status === "success" ? "AI 连接测试成功" : "AI 连接测试失败"}</strong><span>{connectionCheck.status === "running" ? "正在等待中转站和模型返回真实内容" : connectionCheck.detail}</span></div></header><dl><div><dt>测试地址</dt><dd>{connectionCheck.address}</dd></div><div><dt>测试模型</dt><dd>{connectionCheck.model}</dd></div><div><dt>接口检测</dt><dd>{connectionCheck.protocol}</dd></div><div><dt>模型目录</dt><dd>{connectionCheck.modelDirectory}{connectionCheck.modelCount === null ? "" : ` · ${connectionCheck.modelCount} 个模型`}</dd></div><div><dt>目标模型</dt><dd>{connectionCheck.modelFound}</dd></div><div><dt>目录耗时</dt><dd>{connectionCheck.modelProbeLatencyMs === null ? "测试中" : `${connectionCheck.modelProbeLatencyMs} ms`}</dd></div><div><dt>总耗时</dt><dd>{connectionCheck.elapsedMs === null ? "测试中" : connectionCheck.elapsedMs < 1000 ? `${connectionCheck.elapsedMs} ms` : `${(connectionCheck.elapsedMs / 1000).toFixed(1)} 秒`}</dd></div></dl></section>}
      {message && <p className={`ai-settings-message is-${message.tone}`} role="status">{message.text}</p>}
      <footer><button type="button" className="ai-settings-clear" disabled={busy !== null || credentialState !== "configured"} onClick={() => void clear()}><RotateCcw />清除 Key</button><div><button type="button" disabled={busy !== null} onClick={() => { setConfig(initialConfig); setMessage(null); }}><RotateCcw />恢复默认</button><button type="button" disabled={busy !== null || credentialState === "unavailable"} onClick={() => void test()}><Wifi />{busy === "test" ? "测试中" : "单独测试"}</button><button className="is-primary" disabled={busy !== null || credentialState === "unavailable"}><Save />{busy === "save" ? "连接中" : "保存并连接"}</button></div></footer>
    </form>
  </section></div>;
}

export function AiUsagePage({ data, openSettings }: { data: WorkbenchState; openSettings: () => void }) {
  const records = [...(data.aiUsageRecords ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const inputTokens = records.reduce((total, record) => total + (record.inputTokens ?? 0), 0);
  const outputTokens = records.reduce((total, record) => total + (record.outputTokens ?? 0), 0);
  const todayKey = localDateKey();
  const todayRecords = records.filter((record) => localDateKey(new Date(record.createdAt)) === todayKey);
  const todayInput = todayRecords.reduce((total, record) => total + (record.inputTokens ?? 0), 0);
  const todayOutput = todayRecords.reduce((total, record) => total + (record.outputTokens ?? 0), 0);
  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index));
    const key = localDateKey(date);
    const dayRecords = records.filter((record) => localDateKey(new Date(record.createdAt)) === key);
    return { key, label: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date), input: dayRecords.reduce((total, record) => total + (record.inputTokens ?? 0), 0), output: dayRecords.reduce((total, record) => total + (record.outputTokens ?? 0), 0), requests: dayRecords.length };
  });
  const maxDaily = Math.max(1, ...daily.map((day) => day.input + day.output));
  const [credentialState, setCredentialState] = useState<"checking" | "configured" | "missing" | "unavailable">("checking");
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceMessage, setBalanceMessage] = useState<string | null>(null);

  useEffect(() => { void getDesktopWorkbenchAiCredentialStatus().then((response) => setCredentialState(response.status === "success" ? response.data.configured ? "configured" : "missing" : "unavailable")); }, []);

  const inferredBalanceUrl = () => {
    const configured = data.preferences.aiConfig.balanceUrl?.trim();
    if (configured) return configured;
    try {
      const url = new URL(data.preferences.aiConfig.baseUrl);
      if (url.hostname.toLowerCase() === "api.deepseek.com") return `${url.origin}/user/balance`;
    } catch {
      // Invalid provider URLs are handled by the connection settings.
    }
    return "";
  };

  const checkBalance = async () => {
    if (credentialState === "unavailable") { setBalanceMessage("请在墨集桌面端查询余额。"); return; }
    if (credentialState !== "configured") { setBalanceMessage("尚未配置 API Key，请先打开 AI 配置完成连接。"); return; }
    const balanceUrl = inferredBalanceUrl();
    if (!balanceUrl) { setBalanceMessage("余额：未知。当前中转站没有可识别的余额接口，Token 用量仍会记录。"); return; }
    setBalanceBusy(true); setBalanceMessage(null);
    const response = await checkDesktopWorkbenchAiBalance(data.preferences.aiConfig);
    setBalanceBusy(false);
    if (response.status === "success") setBalanceMessage(response.data.supported && response.data.balance !== null ? `当前余额：${response.data.balance}${response.data.currency ? ` ${response.data.currency}` : ""}` : "余额：未知。中转站没有返回可识别的余额字段，Token 用量仍会记录。");
    else setBalanceMessage(`余额：未知。${response.error.message}`);
  };

  return <section className="workbench-page usage-page">
    <header className="page-heading usage-heading"><div><span>AI 监测中心</span><h1>AI 用量</h1><p>查看 AI 实际消耗的 Token、请求趋势和中转站余额。所有用量记录保存在本地。</p></div><button onClick={openSettings}><Settings2 />配置 AI</button></header>
    <section className="usage-overview" aria-label="AI 用量概览"><article><span>累计请求</span><strong>{records.length}</strong><small>已完成的远程 AI 请求</small></article><article><span>累计输入</span><strong>{inputTokens.toLocaleString()}</strong><small>发送给模型的 Token</small></article><article><span>累计输出</span><strong>{outputTokens.toLocaleString()}</strong><small>模型生成的 Token</small></article><article><span>累计合计</span><strong>{(inputTokens + outputTokens).toLocaleString()}</strong><small>输入与输出总量</small></article></section>
    <section className="usage-grid"><article className="usage-card usage-chart-card"><header><div><span>最近 7 天</span><h2>Token 消耗趋势</h2></div><Activity /></header><div className="usage-chart" aria-label="最近七天 Token 用量">{daily.map((day) => <div key={day.key}><span>{day.input + day.output ? (day.input + day.output).toLocaleString() : ""}</span><i><b style={{ height: `${Math.max(4, (day.input + day.output) / maxDaily * 100)}%` }} /></i><strong>{day.label}</strong><small>{day.requests ? `${day.requests} 次` : "无请求"}</small></div>)}</div></article><article className="usage-card usage-today-card"><header><div><span>今天 · {todayRecords.length} 次请求</span><h2>今日用量</h2></div><BarChart3 /></header><div className="usage-today-stats"><div><strong>{(todayInput + todayOutput).toLocaleString()}</strong><span>合计 Token</span></div><div><strong>{todayInput.toLocaleString()}</strong><span>输入 Token</span></div><div><strong>{todayOutput.toLocaleString()}</strong><span>输出 Token</span></div></div><p>{todayRecords.length ? "用量来自已完成的远程 AI 对话，失败请求不会计入。" : "今天还没有完成远程 AI 请求。"}</p></article></section>
    <section className="usage-card usage-balance-card"><header><div><span>中转站账户</span><h2>余额查询</h2></div><Radio /></header><div className="usage-balance-row"><div className={`usage-connection-dot is-${credentialState}`} /><div><strong>{credentialState === "configured" ? "API Key 已配置" : credentialState === "missing" ? "尚未配置 API Key" : credentialState === "checking" ? "正在检查凭据" : "网页预览不可用"}</strong><p>{data.preferences.aiConfig.balanceUrl ? `查询地址：${data.preferences.aiConfig.balanceUrl}` : "在 AI 配置中填写中转站提供的余额查询地址。"}</p></div><button disabled={balanceBusy || credentialState === "unavailable"} onClick={() => void checkBalance()}><Radio />{balanceBusy ? "查询中" : "查询余额"}</button></div>{balanceMessage && <p className="usage-balance-message" role="status">{balanceMessage}</p>}<small>余额接口由中转站自行提供，不同服务商格式可能不同；未提供接口时，Token 用量仍然可正常统计。</small></section>
    <section className="usage-card usage-history-card"><header><div><span>本地记录</span><h2>最近请求</h2></div><span>{records.length} 条</span></header>{records.length ? <div className="usage-history-list">{records.slice(0, 12).map((record) => <article key={record.id}><div><strong>{record.model}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(record.createdAt)}</span></div><dl><div><dt>输入</dt><dd>{record.inputTokens === null ? "未返回" : record.inputTokens.toLocaleString()}</dd></div><div><dt>输出</dt><dd>{record.outputTokens === null ? "未返回" : record.outputTokens.toLocaleString()}</dd></div><div><dt>合计</dt><dd>{record.inputTokens === null || record.outputTokens === null ? "未返回" : (record.inputTokens + record.outputTokens).toLocaleString()}</dd></div></dl></article>)}</div> : <div className="usage-empty"><Activity /><strong>还没有用量记录</strong><span>完成一次远程 AI 对话后，这里会出现真实 Token 数据。</span></div>}</section>
  </section>;
}

function messageKindLabel(message: AiMessage): string {
  if (message.kind === "question") return "需要你的回答";
  if (message.kind === "anomaly") return "主动提醒";
  if (message.kind === "suggestion") return "行动建议";
  return "状态更新";
}

export function AssistantInbox({ data, updateData }: { data: WorkbenchState; updateData: UpdateData }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [agentPermissionMode, setAgentPermissionMode] = useState<AgentPermissionMode>("assist");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [answerBusy, setAnswerBusy] = useState<Record<string, boolean>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [thinkingStage, setThinkingStage] = useState<"连接在线模型" | "整理工作台信息" | "生成回复">("连接在线模型");
  const latestRun = [...(data.agentRuns ?? [])].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const persistedRunBusy = latestRun ? ["planning", "retrieving", "executing"].includes(latestRun.status) : false;
  const activeSessionRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const [confirmation, setConfirmation] = useState<{ kind: "research"; messageId: string } | { kind: "plan"; proposalId: string } | null>(null);
  const messages = [...data.aiMessages]
    .filter((message) => !message.dedupeKey.startsWith("assistant:") && !isLegacyOrdinaryMemoryMessage(message))
    .sort((a, b) => a.createdAt - b.createdAt);
  const unread = messages.filter((message) => message.status === "unread").length;
  const pendingProposal = [...data.planProposals].reverse().find((proposal) => proposal.status === "pending");
  const chatTurns = data.aiChatHistory ?? [];
  const legacyChatTurns = data.aiMessages
    .filter(isLegacyOrdinaryMemoryMessage)
    .map((message) => ({ id: `legacy-${message.id}`, role: "assistant" as const, text: stripMemoryConfirmation(normalizeAssistantText(message.body)), createdAt: message.createdAt }));
  const allChatTurns = [...chatTurns, ...legacyChatTurns];
  const transientAssistantText = new Set(allChatTurns.filter((turn) => turn.role === "assistant").map((turn) => displayChatTurnText(turn)));
  const visibleMessages = messages.filter((message) => !transientAssistantText.has(message.body));
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const timeline = [
    ...visibleMessages.map((message) => ({ type: "message" as const, at: message.createdAt, message })),
    ...allChatTurns.map((turn) => ({ type: "turn" as const, at: turn.createdAt, turn })),
    ...(pendingProposal ? [{ type: "proposal" as const, at: pendingProposal.createdAt, proposal: pendingProposal }] : []),
  ].sort((a, b) => a.at - b.at);
  useEffect(() => {
    const node = chatScrollRef.current;
    if (node) {
      if (typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      else node.scrollTop = node.scrollHeight;
    }
  }, [timeline.length, assistantBusy]);

  const updateMessage = (id: string, status: AiMessage["status"]) => updateData((current) => ({
    ...current,
    aiMessages: current.aiMessages.map((message) => message.id === id ? { ...message, status, readAt: Date.now() } : message),
  }));

  const createActionProposal = (message: AiMessage) => {
    updateData((current) => {
      const proposal = message.taskId
        ? createStarterTaskProposal(current, message.taskId)
        : createDailyRebalanceProposal(current);
      return proposal ? {
        ...current,
        aiMessages: current.aiMessages.map((item) => item.id === message.id ? { ...item, status: "resolved" as const, readAt: Date.now() } : item),
        planProposals: [...current.planProposals, proposal],
      } : current;
    });
  };

  const confirmResearch = (message: AiMessage) => {
    updateData((current) => confirmGoalResearch(current, message.id));
    setConfirmation(null);
    updateData((current) => ({ ...current, aiChatHistory: [...(current.aiChatHistory ?? []), { id: createWorkbenchId("chat"), role: "assistant" as const, text: `已确认“${message.title}”，我会继续根据在线资料补充你的目标计划。`, createdAt: Date.now() }].slice(-200) }));
  };

  const confirmPlan = async (proposalId: string) => {
    const proposal = data.planProposals.find((item) => item.id === proposalId);
    const next = applyPlanProposal(data, proposalId);
    if (next === data) {
      setAssistantError("这份方案已过期或与当前工作台冲突，未执行修改。");
      return;
    }
    if (isDesktopWorkbench()) {
      const committed = await commitDesktopWorkbenchAgentState(data, next);
      if (committed.status === "error") {
        setAssistantError(`${committed.error.message}，本次修改未执行。`);
        return;
      }
    }
    updateData(() => next);
    setConfirmation(null);
    if (proposal) updateData((current) => ({ ...current, aiChatHistory: [...(current.aiChatHistory ?? []), { id: createWorkbenchId("chat"), role: "assistant" as const, text: `已按你的确认应用“${proposal.title}”，接下来可以按新的安排继续。`, createdAt: Date.now() }].slice(-200) }));
  };

  const submitGoalAnswer = async (event: FormEvent, message: AiMessage) => {
    event.preventDefault();
    const answer = answers[message.id]?.trim();
    const goal = message.goalId ? data.goals.find((item) => item.id === message.goalId) : null;
    if (!answer || !goal || !message.questionKey || message.questionKey === "researchConfirmation") return;
    if (!isDesktopWorkbench()) {
      setAnswerErrors((current) => ({ ...current, [message.id]: "目标资料审核需要联网并打开桌面端，回答不会写入本地记忆。" }));
      return;
    }
    setAnswerBusy((current) => ({ ...current, [message.id]: true }));
    setAnswerErrors((current) => ({ ...current, [message.id]: "" }));
    const response = await validateDesktopWorkbenchGoalAnswer({ goalTitle: goal.title, questionKey: message.questionKey, question: message.body, answer }, data.preferences.aiConfig);
    setAnswerBusy((current) => ({ ...current, [message.id]: false }));
    if (response.status === "error") {
      setAnswerErrors((current) => ({ ...current, [message.id]: `${response.error.message}。回答未保存。` }));
      return;
    }
    updateData((current) => {
      const next = response.data.accepted ? answerGoalQuestion(current, message.id, response.data.normalized) : current;
      return {
        ...next,
        aiUsageRecords: [...next.aiUsageRecords.slice(-199), {
          id: createWorkbenchId("ai-usage"), model: response.data.model ?? data.preferences.aiConfig.model,
          inputTokens: response.data.inputTokens ?? null, outputTokens: response.data.outputTokens ?? null, createdAt: Date.now(),
        }],
      };
    });
    if (response.data.accepted) {
      setAnswers((current) => ({ ...current, [message.id]: "" }));
      setAnswerErrors((current) => ({ ...current, [message.id]: "" }));
    } else {
      setAnswerErrors((current) => ({ ...current, [message.id]: `${response.data.reason || "这条回答暂时不能作为目标资料"}，请重新回答；本次没有写入记忆。` }));
    }
  };

  const askAssistant = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = assistantPrompt.trim();
    if (!prompt || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantError("");
    const turnId = createWorkbenchId("chat");
    const agentRunId = createWorkbenchId("run");
    activeSessionRef.current = turnId;
    cancelRequestedRef.current = false;
    const explicitMemory = extractExplicitMemoryCandidate(prompt);
    // Record only high-confidence, explicitly stated facts before the request so
    // the current AI call can use the new memory immediately. The parser rejects
    // questions, temporary arrangements and uncertain wording.
    const memoryContext = explicitMemory ? recordExplicitMemoryFromChat(data, explicitMemory) : data;
    setThinkingStage("整理工作台信息");
    updateData((current) => ({ ...current, agentRuns: [...(current.agentRuns ?? []).slice(-49), { id: agentRunId, sessionId: turnId, status: "planning", snapshotVersion: agentSnapshot.snapshotVersion, startedAt: Date.now(), finishedAt: null, currentStep: "整理工作台信息", trace: [{ id: createWorkbenchId("trace"), runId: agentRunId, kind: "stage", label: "整理工作台信息", createdAt: Date.now() }], requiresConfirmation: false, error: null }] }));
    updateData((current) => {
      const withMemory = explicitMemory ? recordExplicitMemoryFromChat(current, explicitMemory) : current;
      return { ...withMemory, aiChatHistory: [...(withMemory.aiChatHistory ?? []), { id: `${turnId}-user`, role: "user" as const, text: prompt, createdAt: Date.now() }].slice(-200) };
    });
    const activeGoalIds = new Set(memoryContext.goals.filter((goal) => goal.status !== "completed").map((goal) => goal.id));
    const memories = memoryContext.goals.flatMap((goal) => relevantMemories(memoryContext, goal.id))
      .concat(relevantMemories(memoryContext, null))
      .filter((memory, index, all) => all.findIndex((item) => item.id === memory.id) === index);
    const usageId = createWorkbenchId("memory-usage");
    const usageStartedAt = Date.now();
    updateData((current) => ({
      ...current,
      memoryUsageEvents: [...current.memoryUsageEvents.slice(-99), {
        id: usageId,
        trigger: "assistant_chat",
        promptSummary: prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt,
        memories: memories.map((memory) => ({ id: memory.id, category: memory.category, value: memory.value, goalId: memory.goalId, lifecycle: "active" as const })),
        status: "pending",
        createdAt: usageStartedAt,
        completedAt: null,
      }],
    }));
    setThinkingStage("连接在线模型");
    const agentSnapshot = buildWorkbenchAgentSnapshot(memoryContext, localDateKey());
    const activeGoal = memoryContext.aiMessages
      .filter((message) => message.kind === "question" && message.status !== "resolved" && message.status !== "dismissed" && message.goalId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((message) => memoryContext.goals.find((goal) => goal.id === message.goalId))
      .find((goal): goal is NonNullable<typeof goal> => Boolean(goal))
      ?? memoryContext.goals.find((goal) => goal.status !== "completed")
      ?? null;
    const response = await askDesktopWorkbenchAi(prompt, {
      ...agentSnapshot,
      activeGoal,
      activeGoalRule: activeGoal ? `当前对话优先处理目标“${activeGoal.title}”（id: ${activeGoal.id}）。除非用户明确切换目标，不得列出其他目标要求用户重新选择。` : "当前没有活动目标。",
      currentDate: localDateKey(),
      currentTime: new Date().toISOString(),
      goals: memoryContext.goals.filter((goal) => activeGoalIds.has(goal.id)),
      projects: memoryContext.projects,
      tasks: memoryContext.tasks.filter((task) => !task.completedAt).slice(0, 40),
      countdowns: memoryContext.countdowns,
      scheduleExceptions: memoryContext.scheduleExceptions,
      recentHistory: [...new Set(memoryContext.tasks.map((task) => task.scheduledFor))].sort().reverse().slice(0, 30).map((date) => ({
        date,
        tasks: memoryContext.tasks.filter((task) => task.scheduledFor === date).map((task) => ({ title: task.title, status: task.completedAt ? "已完成" : "未完成", projectId: task.projectId, completedAt: task.completedAt })),
        focus: memoryContext.focusRecords.filter((record) => new Date(record.endedAt).toISOString().slice(0, 10) === date).map((record) => ({ minutes: record.actualMinutes, outcome: record.outcome, note: record.note })),
        checkIn: memoryContext.dailyCheckIns.find((item) => item.date === date)?.note ?? "",
      })),
      memories,
      memoryAudit: memoryContext.memories.map((memory) => ({ id: memory.id, category: memory.category, value: memory.value, goalId: memory.goalId, lifecycle: memoryLifecycle(memoryContext, memory) })),
      pendingPlanProposals: memoryContext.planProposals.filter((proposal) => proposal.status === "pending").slice(-10),
      recentChat: (memoryContext.aiChatHistory ?? []).slice(-24).map((turn) => ({ role: turn.role, text: turn.text, createdAt: turn.createdAt })),
      preferences: memoryContext.preferences,
    }, turnId, agentRunId, (event: WorkbenchAgentEvent) => {
      updateData((current) => ({ ...current, agentRuns: current.agentRuns.map((run) => {
        if (run.id !== agentRunId) return run;
        const trace = event.kind === "tool"
          ? { id: createWorkbenchId("trace"), runId: agentRunId, kind: "tool" as const, label: `${event.name} · ${event.status}`, detail: event.detail ?? undefined, createdAt: Date.now() }
          : event.kind === "stage"
            ? { id: createWorkbenchId("trace"), runId: agentRunId, kind: "stage" as const, label: event.label, detail: event.detail ?? undefined, createdAt: Date.now() }
            : null;
        return { ...run, currentStep: event.kind === "tool" ? `工具：${event.name}` : event.kind === "stage" ? event.label : run.currentStep, trace: trace ? [...run.trace, trace].slice(-100) : run.trace };
      }) }));
    }, agentPermissionMode);
    setAssistantBusy(false);
    activeSessionRef.current = null;
    if (response.status === "error") {
      const cancelled = cancelRequestedRef.current || response.error.code === "AI_CANCELLED";
      updateData((current) => ({ ...current, agentRuns: current.agentRuns.map((run) => run.id === agentRunId ? { ...run, status: cancelled ? "cancelled" : "failed", currentStep: cancelled ? "已取消" : "请求失败", finishedAt: Date.now(), error: cancelled ? null : response.error.message, trace: [...run.trace, { id: createWorkbenchId("trace"), runId: agentRunId, kind: cancelled ? "stage" as const : "error" as const, label: cancelled ? "用户取消分析" : "请求失败", detail: cancelled ? undefined : response.error.message, createdAt: Date.now() }] } : run) }));
      updateData((current) => ({ ...current, memoryUsageEvents: current.memoryUsageEvents.map((event) => event.id === usageId ? { ...event, status: "failed", completedAt: Date.now() } : event) }));
      setAssistantError(cancelled ? "本次 AI 分析已取消，未执行任何工作台修改。" : `${response.error.message}。你仍可使用下方本地分析与调整功能。`);
      updateData((current) => ({ ...current, aiChatHistory: [...(current.aiChatHistory ?? []), { id: `${turnId}-error`, role: "assistant" as const, text: `这次在线 AI 请求没有完成：${response.error.message}。请打开“AI 配置”重新测试连接。`, createdAt: Date.now() }].slice(-200) }));
      return;
    }
    const now = Date.now();
    const structured = parseAgentResponse(response.data.text);
    const permissionMode = agentPermissionMode;
    const permittedChanges = structured.kind === "proposal" ? filterChangesForPermission(structured.changes, permissionMode) : [];
    if (structured.kind === "proposal" && permittedChanges.length > 0) {
      const proposal = {
        id: createWorkbenchId("agent-proposal"),
        kind: "replan" as const,
        title: structured.title,
        summary: structured.summary,
        evidence: structured.evidence,
        changes: permittedChanges,
        status: "pending" as const,
        createdAt: now,
        snapshotVersion: workbenchStateVersion(memoryContext),
      };
      updateData((current) => {
        const withProposal = { ...current, planProposals: [...current.planProposals, proposal] };
        return permissionMode === "autonomous" && !requiresConfirmation(permittedChanges, permissionMode)
          ? applyPlanProposal(withProposal, proposal.id)
          : withProposal;
      });
    }
    updateData((current) => ({ ...current, agentRuns: current.agentRuns.map((run) => run.id === agentRunId ? { ...run, status: structured.kind === "proposal" && permittedChanges.length > 0 ? "waiting_confirmation" : "completed", currentStep: structured.kind === "proposal" && permittedChanges.length > 0 ? "等待确认" : "已完成", finishedAt: Date.now(), requiresConfirmation: structured.kind === "proposal" && permittedChanges.length > 0, trace: [...run.trace, { id: createWorkbenchId("trace"), runId: agentRunId, kind: structured.kind === "proposal" ? "proposal" as const : "stage" as const, label: structured.kind === "proposal" ? "生成变更提案" : "生成回复", createdAt: Date.now() }] } : run) }));
    const assistantText = structured.kind === "clarification"
      ? `${structured.question}${structured.known.length ? `\n已知：${structured.known.join("；")}` : ""}`
      : structured.kind === "proposal"
        ? `${structured.title}\n${structured.summary}${structured.evidence.length ? `\n依据：${structured.evidence.join("；")}` : ""}${requiresConfirmation(permittedChanges, permissionMode) ? "\n待你确认后执行。" : ""}`
        : normalizeAutoMemoryReply(structured.kind === "answer" ? `${structured.answer}${structured.evidence.length ? `\n依据：${structured.evidence.join("、")}` : ""}` : structured.message, Boolean(explicitMemory));
    updateData((current) => ({
      ...current,
      memoryUsageEvents: current.memoryUsageEvents.map((event) => event.id === usageId ? { ...event, status: "completed", completedAt: now } : event),
      aiUsageRecords: [...current.aiUsageRecords.slice(-199), { id: createWorkbenchId("ai-usage"), model: response.data.model ?? data.preferences.aiConfig.model, inputTokens: response.data.inputTokens ?? null, outputTokens: response.data.outputTokens ?? null, createdAt: now }],
    }));
    updateData((current) => ({ ...current, aiChatHistory: [...(current.aiChatHistory ?? []), { id: `${turnId}-assistant`, role: "assistant" as const, text: assistantText, createdAt: now }].slice(-200) }));
    setAssistantPrompt("");
  };

  const cancelAssistant = async () => {
    const sessionId = activeSessionRef.current;
    if (!sessionId || !assistantBusy) return;
    cancelRequestedRef.current = true;
    setAssistantError("正在取消 AI 分析…");
    const response = await cancelDesktopWorkbenchAi(sessionId);
    if (response.status === "error") setAssistantError(response.error.message);
  };

  return <section className="workbench-page coach-page">
    <header className="page-heading coach-heading">
      <div><span>主动式 AI · 对话中心</span><h1>和墨集一起处理今天</h1><p>AI 会在发现异常、需要补充信息或生成计划时，在这条对话里和你确认。</p></div>
      <div className="coach-heading-stat"><Inbox /><strong>{unread}</strong><span>条待处理</span></div>
    </header>
    <section className="coach-chat" aria-label="AI 助手对话">
      <header className="coach-chat-header"><div className="coach-chat-avatar"><Sparkles /></div><div><strong>墨集 AI</strong><span>在线工作台教练 · 持续监测任务、目标和行程 · 任务变更需确认，稳定背景自动记忆</span></div><span className="coach-chat-live"><i />在线监测中</span></header>
      <div className="coach-chat-scroll" aria-live="polite" ref={chatScrollRef}>
        {visibleMessages.length === 0 && chatTurns.length === 0 && <div className="coach-chat-welcome"><div className="coach-chat-welcome-mark"><MessageSquareText /></div><strong>今天想先从哪件事开始？</strong><span>我会结合你的目标、倒数日、可用时间和近期完成情况，给出下一步建议。</span></div>}
        {timeline.map((item) => {
        if (item.type === "turn") return <article className={`coach-user-bubble coach-user-bubble--${item.turn.role}`} key={item.turn.id}><span>{item.turn.role === "user" ? "你" : "墨集 AI"}</span><p>{displayChatTurnText(item.turn)}</p></article>;
        if (item.type === "proposal") return <article className="coach-message-bubble coach-message-bubble--confirmation" aria-label="待确认的计划调整" key={`proposal-${item.proposal.id}`}><div className="coach-message-meta"><span className="coach-message-agent"><span className="coach-message-icon"><CircleAlert /></span>待你确认</span><small>计划建议 · {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(item.proposal.createdAt)}</small></div><h2>{item.proposal.title}</h2><p>{item.proposal.summary}</p><small className="coach-confirmation-hint">我已经把变更整理好了，确认前不会修改任务或日程。</small><footer className="coach-message-actions"><button onClick={() => setConfirmation({ kind: "plan", proposalId: item.proposal.id })}>查看调整方案<ChevronRight /></button></footer></article>;
        const message = item.message;
        const goal = data.goals.find((item) => item.id === message.goalId);
        const open = message.status === "unread" || message.status === "read";
        return <article className={`coach-message-bubble coach-message-bubble--${message.kind} is-${message.severity} ${open ? "is-open" : "is-closed"}`} key={message.id}>
          <div className="coach-message-meta"><span className="coach-message-agent"><span className="coach-message-icon">{message.kind === "question" ? <MessageSquareText /> : message.kind === "anomaly" ? <CircleAlert /> : <Lightbulb />}</span>{messageKindLabel(message)}</span><small>{goal?.title ?? "个人工作台"} · {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(message.createdAt)}</small></div>
          <h2>{message.title}</h2><p>{normalizeAssistantText(message.body)}</p>
          {message.evidence.length > 0 && <details><summary>查看判断依据</summary><ul>{message.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details>}
          {message.kind === "question" && message.questionKey === "researchConfirmation" && open && <footer className="coach-message-actions"><button className="is-primary" onClick={() => setConfirmation({ kind: "research", messageId: message.id })}><Check />查看确认</button><button onClick={() => updateMessage(message.id, "dismissed")}>不是这个目标</button></footer>}
          {message.kind === "question" && message.questionKey !== "researchConfirmation" && open && <form className="coach-answer" onSubmit={(event) => void submitGoalAnswer(event, message)}>
            <input aria-label={`回答 ${message.title}`} value={answers[message.id] ?? ""} onChange={(event) => { setAnswers((current) => ({ ...current, [message.id]: event.target.value })); setAnswerErrors((current) => ({ ...current, [message.id]: "" })); }} placeholder="回答会先由在线 AI 审核，通过后才保存为记忆" />
            <button disabled={!answers[message.id]?.trim() || answerBusy[message.id]}>{answerBusy[message.id] ? "审核中" : "提交审核"}<ArrowRight /></button>
          </form>}
          {message.kind === "question" && message.questionKey !== "researchConfirmation" && open && answerErrors[message.id] && <p className="coach-answer-error" role="alert">{answerErrors[message.id]}</p>}
          {message.kind === "anomaly" && open && <footer className="coach-message-actions">
            <button className="is-primary" onClick={() => createActionProposal(message)}>{message.taskId ? "拆成启动任务" : "生成调整方案"}<ChevronRight /></button>
            <button onClick={() => updateMessage(message.id, "dismissed")}>这次忽略</button>
          </footer>}
          {message.kind === "information" && open && <footer className="coach-message-actions"><button onClick={() => updateMessage(message.id, "resolved")}><Check />我知道了</button></footer>}
          {!open && <small className="coach-message-status">{message.status === "dismissed" ? "已忽略" : "已处理"}</small>}
        </article>;
      })}
        {(assistantBusy || persistedRunBusy) && <article className="coach-thinking" role="status" aria-live="polite"><span className="coach-thinking-mark"><Sparkles /></span><div><strong>墨集 AI 正在联网分析</strong><span className="coach-thinking-stage">当前阶段：{latestRun?.currentStep ?? thinkingStage}</span><span>运行 {latestRun?.id.slice(-8) ?? "准备中"} · 已记录上下文和操作轨迹</span>{latestRun?.trace.slice(-3).map((event) => <span key={event.id}>{event.label}{event.detail ? `：${event.detail.slice(0, 80)}` : ""}</span>)}<span>任务和日程不会直接修改；明确的稳定个人信息会自动筛选并记录到本地记忆。</span></div>{assistantBusy && <button type="button" className="coach-cancel-button" onClick={() => void cancelAssistant()}>取消分析</button>}<i className="coach-thinking-dots" aria-hidden="true"><b /><b /><b /></i></article>}
        {!assistantBusy && latestRun?.status === "failed" && <article className="coach-thinking is-error" role="status"><span className="coach-thinking-mark"><CircleAlert /></span><div><strong>本次 Agent 运行未完成</strong><span className="coach-thinking-stage">{latestRun.currentStep}</span><span>{latestRun.error ?? "请求失败，未执行工作台修改。"}</span></div></article>}
        {!assistantBusy && latestRun?.status === "cancelled" && <article className="coach-thinking is-error" role="status"><span className="coach-thinking-mark"><X /></span><div><strong>本次 Agent 运行已取消</strong><span className="coach-thinking-stage">未执行工作台修改</span><span>你可以重新发送请求继续分析。</span></div></article>}
        {!assistantBusy && latestRun?.status === "waiting_confirmation" && <article className="coach-thinking is-pending" role="status"><span className="coach-thinking-mark"><ShieldCheck /></span><div><strong>Agent 已生成待确认方案</strong><span className="coach-thinking-stage">等待你确认后执行</span><span>{latestRun.trace.filter((event) => event.kind === "proposal").at(-1)?.label ?? "变更提案"}</span></div></article>}
      </div>
      <form className="coach-chat-composer" onSubmit={askAssistant}><div className="coach-chat-input"><Sparkles /><input id="coach-question" aria-label="向 AI 助手提问" value={assistantPrompt} onChange={(event) => { setAssistantPrompt(event.target.value); setAssistantError(""); }} placeholder="告诉在线 AI 你现在遇到的安排或困难…" /><button aria-label={assistantBusy ? "分析中" : "发送消息"} disabled={!assistantPrompt.trim() || assistantBusy}>{assistantBusy ? "分析中" : <ArrowRight />}</button></div><div className="agent-permission"><span>Agent 权限</span><AgentPermissionPicker value={agentPermissionMode} onChange={setAgentPermissionMode} disabled={assistantBusy} /></div><small>AI 对话和目标研究需要联网；高风险任务、改期和日程调整始终需要确认</small>{assistantError && <p>{assistantError}</p>}</form>
    </section>
    {confirmation?.kind === "research" && (() => {
      const message = data.aiMessages.find((item) => item.id === confirmation.messageId);
      const goal = message?.goalId ? data.goals.find((item) => item.id === message.goalId) : null;
      const countdown = message?.countdownId ? data.countdowns.find((item) => item.id === message.countdownId) : null;
      const goalTitle = goal?.title ?? countdown?.title ?? message?.title.replace(/^确认目标[“"]?/, "").replace(/[”"]$/, "") ?? "这个目标";
      return message ? <GoalResearchConfirmationDialog message={message} goalTitle={goalTitle} close={() => setConfirmation(null)} confirm={() => confirmResearch(message)} /> : null;
    })()}
    {confirmation?.kind === "plan" && (() => { const proposal = data.planProposals.find((item) => item.id === confirmation.proposalId && item.status === "pending"); return proposal ? <PlanProposalDialog proposal={proposal} data={data} updateData={updateData} close={() => setConfirmation(null)} onApplied={() => confirmPlan(proposal.id)} /> : null; })()}
  </section>;
}

export function MemoryCenter({ data, updateData, openMessages }: { data: WorkbenchState; updateData: UpdateData; openMessages?: () => void }) {
  const tutorialVersion = 2;
  const [tutorialOpen, setTutorialOpen] = useState((data.preferences.memoryTutorialVersion ?? 0) < tutorialVersion);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [memoryValue, setMemoryValue] = useState("");
  const [memoryCategory, setMemoryCategory] = useState<MemoryEntry["category"]>("preference");
  const [memoryGoalId, setMemoryGoalId] = useState("");
  const [memoryExpiresAt, setMemoryExpiresAt] = useState("");
  const [filter, setFilter] = useState<MemoryEntry["category"] | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "needs_review" | "expired" | "completed">("all");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingCategory, setEditingCategory] = useState<MemoryEntry["category"]>("preference");
  const [editingGoalId, setEditingGoalId] = useState("");
  const [editingExpiresAt, setEditingExpiresAt] = useState("");

  const categoryLabels: Record<MemoryEntry["category"], string> = { profile: "个人档案", goal: "目标资料", habit: "行为习惯", preference: "规划偏好" };
  const categoryKeys: MemoryEntry["category"][] = ["profile", "goal", "habit", "preference"];
  const categoryDescriptions: Record<MemoryEntry["category"], string> = { profile: "基础信息，例如身份、学习阶段和长期背景", goal: "与某个目标直接相关的科目、基础和结果", habit: "AI 根据多次行为观察出的稳定规律", preference: "你明确告诉 AI 的安排偏好和限制" };
  const now = Date.now();
  const memoryStatus = (memory: MemoryEntry) => memoryLifecycle(data, memory, now);
  const visibleMemories = [...data.memories].reverse().filter((memory) => {
    if (filter !== "all" && memory.category !== filter) return false;
    if (statusFilter !== "all" && memoryStatus(memory) !== statusFilter) return false;
    const query = search.trim().toLowerCase();
    return !query || `${memory.value} ${memory.key} ${categoryLabels[memory.category]}`.toLowerCase().includes(query);
  });
  const counts = data.memories.reduce<Record<string, number>>((result, memory) => { result[memory.category] = (result[memory.category] ?? 0) + 1; return result; }, {});
  const pendingCount = data.memories.filter((memory) => !memory.confirmed).length;
  const activeMemories = data.memories.filter((memory) => memoryStatus(memory) === "active");
  const expiredCount = data.memories.filter((memory) => memoryStatus(memory) === "expired").length;
  const completedCount = data.memories.filter((memory) => memoryStatus(memory) === "completed").length;
  const reviewCount = data.memories.filter((memory) => memoryStatus(memory) === "needs_review").length;
  const usageEvents = [...data.memoryUsageEvents].reverse();
  const recentUsageCount = usageEvents.filter((event) => event.createdAt >= now - 7 * 86_400_000).length;
  const tutorialSlides = [
    { icon: <Brain />, eyebrow: "01 · 本地记忆", title: "它不是聊天记录，而是 AI 的长期依据", body: "这里集中管理会长期影响计划的资料。先看顶部概览和调用预览，确认目前有哪些内容可能参与分析。", points: ["记忆文件保存在当前设备", "完整对话不会自动成为记忆", "所有条目都能查看、修改和删除"] },
    { icon: <Database />, eyebrow: "02 · 日常容量", title: "先告诉 AI，你平常一天能安排多少", body: "“每天可投入”是普通一天的可规划时间；“计划缓冲”会预留休息和突发时间。例如每天 240 分钟、缓冲 20%，AI 会按约 192 分钟安排任务。", points: ["填写长期平均值，不必每天修改", "临时有事请使用侧栏的临时安排", "番茄钟只作辅助，不决定容量"] },
    { icon: <Plus />, eyebrow: "03 · 手动补充", title: "只保存未来还会影响计划的信息", body: "选择类型、作用范围和有效期后保存。长期身份信息可不设期限，某一阶段的时间限制建议设置到期日。", points: ["个人档案记录稳定背景", "目标资料和规划偏好可限定目标", "短期安排设置有效期，避免以后误用"] },
    { icon: <Radio />, eyebrow: "04 · 调用监测", title: "每次 AI 分析用了什么，都留下可核对记录", body: "你在 AI 消息中主动提问后，这里会显示调用状态、问题摘要和当次实际发送的记忆快照。失败调用也会保留并明确标注。", points: ["分析中、已完成、未完成三种状态", "历史快照不会被后续编辑悄悄改写", "没有匹配记忆时也会如实记录"] },
    { icon: <Layers3 />, eyebrow: "05 · 记忆管理", title: "发现不准确，就在这里纠正或停用", body: "用类型、状态和搜索快速定位条目。停用后 AI 不再调用；过期记忆可以编辑有效期并重新启用。", points: ["来源区分你提供和 AI 推断", "推断记忆展示证据次数与可信度", "目标范围决定它在哪些分析中生效"] },
    { icon: <MessageSquareText />, eyebrow: "06 · 目标资料", title: "让 AI 逐步补齐每个目标的关键背景", body: "倒数日会形成目标资料卡。完成结果、目标领域、当前基础和每周时间越完整，AI 越能判断任务量是否现实。", points: ["不要求首次使用就填写全部", "点击“在 AI 消息中完善”逐步回答", "不同目标的资料彼此隔离"] },
    { icon: <ShieldCheck />, eyebrow: "07 · 使用规则", title: "确认、匹配、可追踪，才进入 AI 上下文", body: "只有已启用、未过期且作用范围匹配的条目会参与分析。你主动发起 AI 分析时，它们才会交给当前配置的 AI 服务。", points: ["先看调用监测确认使用内容", "建议不合适时修正相关记忆", "再回到 AI 消息重新生成建议"] },
  ];
  const openTutorialAt = (step: number) => { setTutorialStep(step); setTutorialOpen(true); };
  const closeTutorial = (dismiss: boolean) => {
    if (dismiss) updateData((current) => ({ ...current, preferences: { ...current.preferences, memoryTutorialVersion: tutorialVersion } }));
    setTutorialOpen(false); setTutorialStep(0);
  };
  const startEdit = (memory: MemoryEntry) => {
    setEditingId(memory.id);
    setEditingValue(memory.value);
    setEditingCategory(memory.category);
    setEditingGoalId(memory.goalId ?? "");
    setEditingExpiresAt(memory.expiresAt ? localDateKey(new Date(memory.expiresAt)) : "");
  };
  const saveEdit = (event: FormEvent, memory: MemoryEntry) => {
    event.preventDefault();
    const value = editingValue.trim();
    if (!value) return;
    updateData((current) => ({ ...current, memories: current.memories.map((item) => item.id === memory.id ? {
      ...item,
      category: editingCategory,
      value,
      goalId: editingGoalId || null,
      expiresAt: editingExpiresAt ? new Date(editingExpiresAt).getTime() : null,
      confirmed: true,
      updatedAt: Date.now(),
    } : item) }));
    setEditingId(null);
  };
  const addMemory = (event: FormEvent) => {
    event.preventDefault();
    const value = memoryValue.trim();
    if (!value) return;
    updateData((current) => ({ ...current, memories: [...current.memories, {
      id: createWorkbenchId("memory"), category: memoryCategory, key: memoryCategory === "profile" ? "userProfile" : "userNote", value,
      goalId: memoryGoalId || null, source: "user", confidence: 100, evidenceCount: 1, confirmed: true,
      createdAt: Date.now(), updatedAt: Date.now(), expiresAt: memoryExpiresAt ? new Date(memoryExpiresAt).getTime() : null,
    }] }));
    setMemoryValue(""); setMemoryGoalId(""); setMemoryExpiresAt("");
  };

  return <section className="workbench-page memory-page">
    <header className="page-heading memory-heading"><div><span>本地记忆 · 可控的个人上下文</span><h1>让 AI 记住真正有用的事</h1><p>你可以查看、修改、停用或删除每一条记忆。每次 AI 实际调用哪些内容，也会在这里留下记录。</p></div><div className="memory-heading-actions"><button type="button" className="memory-tutorial-button" onClick={() => openTutorialAt(0)}><BookOpen />使用教程</button><div className="memory-privacy-badge"><ShieldCheck /><span>记忆文件保存在本机</span></div></div></header>
    <section className="memory-overview" aria-label="记忆概览"><article><span>全部记忆</span><strong>{data.memories.length}</strong><small>条</small></article><article><span>当前可调用</span><strong>{activeMemories.length}</strong><small>条</small></article><article><span>待审核 / 过期 / 完成</span><strong>{reviewCount + expiredCount + completedCount}</strong><small>条</small></article><article><span>近 7 天调用</span><strong>{recentUsageCount}</strong><small>次</small></article><article className="memory-overview-note"><CheckCircle2 /><div><strong>选择性记忆</strong><span>目标回答会先经过在线 AI 筛选；未通过的内容只保留待审核记录，不会参与后续分析。</span></div></article></section>
    <section className="memory-use-preview" aria-label="AI 记忆调用预览"><div className="memory-use-icon"><Sparkles /></div><div className="memory-use-copy"><span>AI 调用预览</span><strong>{activeMemories.length ? `当前有 ${activeMemories.length} 条记忆可以参与分析` : "当前没有可调用的长期记忆"}</strong><p>{activeMemories.length ? activeMemories.slice(0, 3).map((memory) => memory.value).join(" · ") : "添加并启用个人资料、目标信息或规划偏好后，AI 才会在相关计划中使用。"}</p></div><div className="memory-use-actions"><button type="button" aria-label="了解 AI 调用预览" onClick={() => openTutorialAt(3)}><HelpCircle /></button><button type="button" onClick={() => { setStatusFilter("active"); document.getElementById("memory-records-panel")?.scrollIntoView({ behavior: "smooth" }); }}>查看调用内容<ChevronRight /></button></div></section>
    <section className="memory-monitor" aria-label="AI 记忆调用监测">
      <header><div className="memory-monitor-title"><span className="memory-monitor-mark"><Radio /></span><div><span>动态监测</span><h2>AI 最近使用了哪些记忆</h2><p>记录只用于核对调用范围，不会反过来生成新的长期记忆。</p></div></div><button type="button" className="memory-section-help" aria-label="了解调用监测" onClick={() => openTutorialAt(3)}><HelpCircle />怎么使用</button></header>
      {usageEvents.length ? <div className="memory-monitor-list">{usageEvents.slice(0, 6).map((event) => <article key={event.id} className={`memory-monitor-event is-${event.status}`} aria-label={`记忆调用记录 ${event.promptSummary}`}>
        <div className="memory-monitor-event-state"><i /><span>{event.status === "pending" ? "分析中" : event.status === "completed" ? "已完成" : "未完成"}</span><time>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(event.createdAt)}</time></div>
        <div className="memory-monitor-event-main"><strong>{event.promptSummary}</strong><p>{event.memories.length ? `本次向 AI 提供了 ${event.memories.length} 条匹配记忆` : "本次没有匹配的长期记忆，AI 只使用任务、目标和安排。"}</p>{event.memories.length > 0 && <details><summary>查看实际调用内容</summary><ul>{event.memories.map((memory) => <li key={`${event.id}-${memory.id}`}><span className={`memory-category memory-category--${memory.category}`}>{categoryLabels[memory.category]}</span><div><strong>{memory.value}</strong><small>{memory.goalId ? `用于目标：${data.goals.find((goal) => goal.id === memory.goalId)?.title ?? "原目标已删除"}` : "全局记忆，对所有目标生效"}</small></div></li>)}</ul></details>}</div>
      </article>)}</div> : <div className="memory-monitor-empty"><Radio /><div><strong>还没有 AI 调用记录</strong><span>前往 AI 消息提出一个问题，回来后就能核对本次使用了哪些记忆。</span></div><button type="button" onClick={openMessages}>去 AI 消息试一次<ArrowRight /></button></div>}
    </section>
    <div className="memory-layout">
      <section className="memory-settings memory-settings-card">
        <header><Database /><div><span>规划基础</span><h2>日常容量设置</h2></div><button type="button" className="memory-section-help is-icon" aria-label="了解日常容量设置" onClick={() => openTutorialAt(1)}><HelpCircle /></button></header>
        <label>通常每天可投入<input aria-label="每天可用分钟" type="number" min="30" max="960" step="30" value={data.preferences.defaultDailyCapacityMinutes} onChange={(event) => updateData((current) => ({ ...current, preferences: { ...current.preferences, defaultDailyCapacityMinutes: Math.max(30, Number(event.target.value) || 30) } }))} /><span>分钟</span></label>
        <label>计划缓冲<input aria-label="计划缓冲比例" type="range" min="0" max="40" step="5" value={data.preferences.bufferPercent} onChange={(event) => updateData((current) => ({ ...current, preferences: { ...current.preferences, bufferPercent: Number(event.target.value) } }))} /><span>{data.preferences.bufferPercent}%</span></label>
        <label className="memory-toggle"><input type="checkbox" checked={data.preferences.proactiveMessages} onChange={(event) => updateData((current) => ({ ...current, preferences: { ...current.preferences, proactiveMessages: event.target.checked } }))} />允许 AI 主动发现异常并发送应用内消息</label>
        <div className="memory-settings-note"><ShieldCheck /><span>番茄钟只作为辅助记录，不会单独决定你的日容量。</span></div>
      </section>
      <section className="memory-add-card">
        <header><Plus /><div><span>手动补充</span><h2>添加一条记忆</h2></div><button type="button" className="memory-section-help is-icon" aria-label="了解如何添加记忆" onClick={() => openTutorialAt(2)}><HelpCircle /></button></header>
        <form className="memory-add" onSubmit={addMemory}><label>记忆内容<input aria-label="新增长期偏好" value={memoryValue} onChange={(event) => setMemoryValue(event.target.value)} placeholder="例如：周三晚上通常没有时间" required /></label><div className="memory-form-grid"><label>类型<select aria-label="记忆类型" value={memoryCategory} onChange={(event) => setMemoryCategory(event.target.value as MemoryEntry["category"])}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>作用范围<select aria-label="记忆关联目标" value={memoryGoalId} onChange={(event) => setMemoryGoalId(event.target.value)}><option value="">适用于所有目标</option>{data.goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select></label><label>有效期<input aria-label="记忆有效期" type="date" value={memoryExpiresAt} onChange={(event) => setMemoryExpiresAt(event.target.value)} /></label></div><small>{categoryDescriptions[memoryCategory]}</small><button disabled={!memoryValue.trim()}><Plus />保存到本地</button></form>
      </section>
    </div>
    <section className="memory-records memory-records-panel" id="memory-records-panel" aria-label="记忆管理">
      <header className="memory-records-toolbar"><div><Brain /><div><span>选择性记忆</span><h2>已保存内容</h2></div></div><div className="memory-records-actions"><label className="memory-search"><Search /><input aria-label="搜索记忆" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索记忆内容" /></label><button type="button" className="memory-section-help is-icon" aria-label="了解记忆管理" onClick={() => openTutorialAt(4)}><HelpCircle /></button></div></header>
    <div className="memory-filter-row"><nav className="memory-filters" aria-label="记忆类型筛选">{(["all", ...categoryKeys] as const).map((value) => <button type="button" key={value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : categoryLabels[value]}<small>{value === "all" ? data.memories.length : counts[value] ?? 0}</small></button>)}</nav><label className="memory-status-filter"><span>状态</span><select aria-label="记忆状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">全部状态</option><option value="active">可调用</option><option value="paused">已停用</option><option value="needs_review">待审核</option><option value="expired">已过期</option><option value="completed">已完成</option></select></label></div>
      {visibleMemories.length ? <div className="memory-record-grid">{visibleMemories.map((memory) => <article className={`memory-record-card${memory.confirmed ? " is-confirmed" : " is-pending"}`} key={memory.id}>
        {editingId === memory.id ? <form className="memory-edit-form" onSubmit={(event) => saveEdit(event, memory)}><label>内容<input aria-label={`编辑记忆 ${memory.value}`} value={editingValue} onChange={(event) => setEditingValue(event.target.value)} autoFocus /></label><div className="memory-form-grid"><label>类型<select aria-label="编辑记忆类型" value={editingCategory} onChange={(event) => setEditingCategory(event.target.value as MemoryEntry["category"])}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>作用范围<select aria-label="编辑记忆关联目标" value={editingGoalId} onChange={(event) => setEditingGoalId(event.target.value)}><option value="">适用于所有目标</option>{data.goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select></label><label>有效期<input aria-label="编辑记忆有效期" type="date" value={editingExpiresAt} onChange={(event) => setEditingExpiresAt(event.target.value)} /></label></div><small>保存后会重新启用；留空表示长期有效。</small><footer><button type="button" onClick={() => setEditingId(null)}>取消</button><button className="is-primary" aria-label="确认保存记忆">保存修改</button></footer></form> : <><header><span className={`memory-category memory-category--${memory.category}`}>{categoryLabels[memory.category]}</span><span className="memory-source">{memory.source === "user" ? "你提供" : "AI 推断"}</span><div><button type="button" aria-label={`编辑记忆 ${memory.value}`} onClick={() => startEdit(memory)}><Pencil /></button><button type="button" aria-label={`删除记忆 ${memory.value}`} onClick={() => updateData((current) => deleteMemory(current, memory.id))}><Trash2 /></button></div></header><strong>{memory.value}</strong><p>{memory.goalId ? data.goals.find((goal) => goal.id === memory.goalId)?.title ?? "已删除目标" : "适用于全部目标"}{memory.expiresAt ? ` · ${memoryStatus(memory) === "expired" ? "已过期" : `有效至 ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(memory.expiresAt)}`}` : " · 长期有效"}</p><footer><span>{memory.source === "inferred" ? `${memory.evidenceCount} 次行为证据 · 可信度 ${memory.confidence}%` : "由你明确提供"}</span>{memoryStatus(memory) === "expired" ? <span className="memory-expired">编辑有效期后可重新调用</span> : <button type="button" className={memory.confirmed ? "memory-status is-enabled" : "memory-status"} onClick={() => updateData((current) => ({ ...current, memories: current.memories.map((item) => item.id === memory.id ? { ...item, confirmed: !item.confirmed, updatedAt: Date.now() } : item) }))}>{memory.confirmed ? <><Check />已启用</> : <><ShieldCheck />已停用</>}</button>}</footer></>}
      </article>)}</div> : <div className="memory-empty"><Search /><strong>{data.memories.length ? "没有匹配的记忆" : "还没有保存的记忆"}</strong><span>{data.memories.length ? "试试其他关键词或切换分类。" : "AI 只会保存你明确提供的资料，或有足够证据的稳定习惯。"}</span></div>}
    </section>
    <section className="goal-memory-section">
      <header className="section-heading"><div><span>目标上下文</span><h2>目标资料完整度</h2></div><div className="goal-memory-heading-actions"><small>资料越完整，AI 的计划越贴近你的实际情况</small><button type="button" className="memory-section-help is-icon" aria-label="了解目标资料" onClick={() => openTutorialAt(5)}><HelpCircle /></button></div></header>
      <div className="goal-memory-grid">{data.goals.length ? data.goals.map((goal) => { const filled = [goal.outcome, goal.dimensions.length ? goal.dimensions.join("、") : "", goal.currentLevel, goal.weeklyAvailableMinutes ? String(goal.weeklyAvailableMinutes) : ""].filter(Boolean).length; return <article key={goal.id}><header><div><strong>{goal.title}</strong><span>{goal.primary ? "主目标" : "并行目标"}</span></div><b>{filled}/4</b></header><div className="goal-memory-progress"><span><i style={{ width: `${filled / 4 * 100}%` }} /></span></div><dl><div><dt>完成结果</dt><dd>{goal.outcome || "等待补充"}</dd></div><div><dt>目标领域</dt><dd>{goal.dimensions.join("、") || "等待补充"}</dd></div><div><dt>当前基础</dt><dd>{goal.currentLevel || "等待补充"}</dd></div><div><dt>每周时间</dt><dd>{goal.weeklyAvailableMinutes ? minutesLabel(goal.weeklyAvailableMinutes) : "等待补充"}</dd></div></dl><button type="button" className="goal-memory-action" onClick={openMessages}><MessageSquareText />在 AI 消息中完善</button>{goal.status !== "completed" && <button type="button" className="goal-memory-action" onClick={() => updateData((current) => ({ ...current, goals: current.goals.map((item) => item.id === goal.id ? { ...item, status: "completed", updatedAt: Date.now() } : item) }))}><Check />标记目标完成</button>}</article>; }) : <div className="memory-empty">创建倒数日后，AI 会逐步建立对应的目标资料。</div>}</div>
    </section>
    {tutorialOpen && <div className="memory-tutorial-layer"><section className="memory-tutorial" role="dialog" aria-modal="true" aria-labelledby="memory-tutorial-title"><header><div><span>MEMORY GUIDE</span><small>{tutorialStep + 1} / {tutorialSlides.length}</small></div><button type="button" aria-label="关闭记忆教程" onClick={() => closeTutorial(false)}><X /></button></header><div className="memory-tutorial-body"><div className="memory-tutorial-art"><div>{tutorialSlides[tutorialStep].icon}</div><span>{String(tutorialStep + 1).padStart(2, "0")}</span></div><article><span>{tutorialSlides[tutorialStep].eyebrow}</span><h2 id="memory-tutorial-title">{tutorialSlides[tutorialStep].title}</h2><p>{tutorialSlides[tutorialStep].body}</p><ul>{tutorialSlides[tutorialStep].points.map((point) => <li key={point}><Check />{point}</li>)}</ul></article></div><div className="memory-tutorial-dots" aria-label="教程进度">{tutorialSlides.map((slide, index) => <button type="button" aria-label={`查看教程第 ${index + 1} 页`} className={index === tutorialStep ? "is-active" : ""} onClick={() => setTutorialStep(index)} key={slide.title} />)}</div><footer><button type="button" className="memory-tutorial-dismiss" onClick={() => closeTutorial(true)}>不再提醒</button><div>{tutorialStep > 0 && <button type="button" onClick={() => setTutorialStep((step) => step - 1)}><ArrowLeft />上一步</button>}{tutorialStep < tutorialSlides.length - 1 ? <button type="button" className="is-primary" onClick={() => setTutorialStep((step) => step + 1)}>下一步<ArrowRight /></button> : <button type="button" className="is-primary" onClick={() => closeTutorial(true)}>开始管理记忆<Check /></button>}</div></footer></section></div>}
  </section>;
}

export function TemporaryArrangementDialog({ data, updateData, close }: { data: WorkbenchState; updateData: UpdateData; close: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return <div className="workbench-dialog-layer"><section className="workbench-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title">
    <header><div><span>TEMPORARY SCHEDULE</span><h2 id="schedule-dialog-title">告诉 AI 临时安排</h2></div><button aria-label="关闭临时安排" onClick={close}><X /></button></header>
    <form onSubmit={(event) => {
      event.preventDefault();
      const parsed = parseTemporaryArrangement(value);
      if (!parsed) { setError("请说明日期、可用时间或具体安排。"); return; }
      const proposal = createReplanProposal(data, parsed.exception);
      updateData((current) => ({ ...current, planProposals: [...current.planProposals, proposal] }));
      close();
    }}>
      <label>自然语言安排<textarea autoFocus aria-label="临时安排内容" rows={4} value={value} onChange={(event) => { setValue(event.target.value); setError(""); }} placeholder="例如：明天只能学习两个小时，下午三点去医院" /></label>
      <small>AI 会先生成调整预览，不会直接改动任务。</small>
      {error && <p className="workbench-form-error">{error}</p>}
      <footer><button type="button" onClick={close}>取消</button><button className="is-primary" disabled={!value.trim()}>分析并生成预览</button></footer>
    </form>
  </section></div>;
}

export function DailyCheckInDialog({ data, updateData, close }: { data: WorkbenchState; updateData: UpdateData; close: () => void }) {
  const today = localDateKey();
  const existing = [...data.dailyCheckIns].reverse().find((item) => item.date === today);
  const [state, setState] = useState<DailyCheckIn["state"]>(existing?.state ?? "normal");
  const [minutes, setMinutes] = useState(existing?.availableMinutes ?? data.preferences.defaultDailyCapacityMinutes);
  const [note, setNote] = useState(existing?.note ?? "");
  return <div className="workbench-dialog-layer"><section className="workbench-dialog checkin-dialog" role="dialog" aria-modal="true" aria-labelledby="checkin-dialog-title">
    <header><div><span>DAILY CHECK-IN</span><h2 id="checkin-dialog-title">更新今天的状态</h2></div><button aria-label="关闭今日状态" onClick={close}><X /></button></header>
    <form onSubmit={(event) => {
      event.preventDefault();
      updateData((current) => {
        const checkIn: DailyCheckIn = { id: existing?.id ?? createWorkbenchId("checkin"), date: today, availableMinutes: Math.max(30, minutes), state, note: note.trim(), createdAt: existing?.createdAt ?? Date.now() };
        const next = { ...current, dailyCheckIns: [...current.dailyCheckIns.filter((item) => item.date !== today), checkIn] };
        return { ...next, planProposals: [...next.planProposals, createDailyRebalanceProposal(next, today)] };
      });
      close();
    }}>
      <fieldset><legend>当前状态</legend><div className="checkin-states">{(["low", "normal", "high"] as const).map((value) => <button type="button" className={state === value ? "is-active" : ""} key={value} onClick={() => setState(value)}>{value === "low" ? "偏低" : value === "normal" ? "正常" : "良好"}</button>)}</div></fieldset>
      <label>今天实际可投入<input aria-label="今日可用分钟" type="number" min="30" max="960" step="30" value={minutes} onChange={(event) => setMinutes(Number(event.target.value) || 0)} /><span>分钟</span></label>
      <label>补充说明<textarea aria-label="今日状态说明" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：昨晚休息较少，下午还有一场会议" /></label>
      <small>保存后会生成今日调整预览，确认前不会移动任务。</small>
      <footer><button type="button" onClick={close}>取消</button><button className="is-primary">保存并检查计划</button></footer>
    </form>
  </section></div>;
}

function changeLabel(proposal: PlanProposal, change: PlanProposal["changes"][number], data: WorkbenchState): string {
  if (change.type === "rescheduleTask") return `将“${data.tasks.find((task) => task.id === change.taskId)?.title ?? "任务"}”从 ${change.fromDate} 调整到 ${change.toDate}`;
  if (change.type === "createTask") return `创建“${change.task.title}” · ${minutesLabel(change.task.estimateMinutes)}`;
  if (change.type === "addScheduleException") return `记录 ${change.exception.date} 的临时安排：${change.exception.title}`;
  if (change.type === "updateGoal") return `更新目标资料：${change.patch.outcome || change.patch.currentLevel || "补充目标信息"}`;
  return `保存一条记忆：${change.memory.value}`;
}

function GoalResearchConfirmationDialog({ message, goalTitle, close, confirm }: { message: AiMessage; goalTitle: string; close: () => void; confirm: () => void }) {
  return <div className="workbench-dialog-layer"><section className="workbench-dialog coach-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-confirm-title">
    <header><div><span>ONLINE GOAL CHECK</span><h2 id="goal-confirm-title">确认这条目标资料</h2></div><button aria-label="关闭目标确认" onClick={close}><X /></button></header>
    <div className="coach-confirm-content"><p>我根据在线资料把“{goalTitle}”理解为：</p><strong>{message.body}</strong>{message.evidence.length > 0 && <details open><summary>查看判断依据</summary><ul>{message.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details>}<small>确认后才会继续研究并写入目标资料；关闭不会保存任何内容。</small></div>
    <footer><button type="button" onClick={close}>暂不确认</button><button type="button" className="is-primary" onClick={(event) => { event.preventDefault(); event.stopPropagation(); confirm(); }}><Check />确认这个目标</button></footer>
  </section></div>;
}

export function PlanProposalDialog({ proposal, data, updateData, close, onApplied }: { proposal: PlanProposal; data: WorkbenchState; updateData: UpdateData; close?: () => void; onApplied?: () => void }) {
  const dismiss = close ?? (() => updateData((current) => ({ ...current, planProposals: current.planProposals.map((item) => item.id === proposal.id ? { ...item, status: "rejected" } : item) })));
  const apply = onApplied ?? (() => updateData((current) => applyPlanProposal(current, proposal.id)));
  return <div className="workbench-dialog-layer"><section className="workbench-dialog plan-change-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-change-title">
    <header><div><span>PLAN PREVIEW</span><h2 id="plan-change-title">{proposal.title}</h2></div><button aria-label="关闭计划确认" onClick={dismiss}><X /></button></header>
    <div className="plan-change-content"><p>{proposal.summary}</p>{proposal.sourceDocumentIds?.length ? <div className="plan-source-note"><BookOpen /><span>本方案参考了 {proposal.sourceDocumentIds.length} 份项目资料；资料内容不会被写入任务或本地记忆。</span></div> : null}{proposal.deadlineDate ? <div className="plan-deadline-note"><CalendarClock /><div><strong>{proposal.deadlineSource?.startsWith("倒数日：") ? "行动截止节点" : "资料中识别到的交付日期"}</strong><span>{proposal.deadlineDate}{proposal.deadlineSource ? ` · ${proposal.deadlineSource}` : ""}</span>{proposal.deadlineEvidence ? <small>{proposal.deadlineEvidence}</small> : null}</div></div> : proposal.sourceDocumentIds?.length ? <div className="plan-deadline-note plan-deadline-note--neutral"><CalendarClock /><div><strong>未发现明确交付时间</strong><span>方案按资料顺序和你的每日可用容量安排。</span></div></div> : null}<section><span>准备执行的变化</span>{proposal.changes.length ? proposal.changes.map((change, index) => <article key={index}><strong>{index + 1}</strong><p>{changeLabel(proposal, change, data)}</p></article>) : <div className="plan-change-none">没有任务需要改期，只记录新的可用时间。</div>}</section><details open><summary>判断依据</summary><ul>{proposal.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details><small>确认前不会修改任务、目标或临时安排。</small></div>
    <footer><button onClick={dismiss}>暂不处理</button><button className="is-primary" onClick={apply}><Check />确认应用调整</button></footer>
  </section></div>;
}
