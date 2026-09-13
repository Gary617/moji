import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

import type { GoalResearchSource, WorkbenchAiConfig, WorkbenchState } from "../workbench/model";
import type { IpcResponse } from "./types";

export interface WorkbenchBackupInfo { name: string; byteCount: number; createdAt: number }
export function listWorkbenchBackups(): Promise<IpcResponse<WorkbenchBackupInfo[]>> { return invoke<IpcResponse<WorkbenchBackupInfo[]>>("workbench_list_backups"); }
export function restoreWorkbenchBackup(name: string): Promise<IpcResponse<WorkbenchSaveResult>> { return invoke<IpcResponse<WorkbenchSaveResult>>("workbench_restore_backup", { name }); }

export interface WorkbenchSaveResult {
  saved: boolean;
  byteCount: number;
}

export interface WorkbenchAiAssistResult {
  text: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  skills?: string[];
}
export interface WorkbenchAgentRequest {
  sessionId: string;
  agentRunId: string;
  snapshotVersion: string;
  prompt: string;
  context: unknown;
  permission?: "suggest" | "assist" | "autonomous";
}

export interface WorkbenchAiCancelResult { sessionId: string; cancelled: boolean }
export type WorkbenchAgentEvent = { kind: "stage"; label: string; detail?: string | null } | { kind: "tool"; name: string; status: string; detail?: string | null } | { kind: "completed" };

export interface WorkbenchAiCredentialStatus {
  configured: boolean;
}

export interface WorkbenchAiConnectionResult {
  model: string;
  protocol?: string;
  latencyMs?: number;
  reply?: string;
  modelDirectorySupported?: boolean;
  modelFound?: boolean | null;
  modelCount?: number | null;
  modelProbeLatencyMs?: number;
}

export interface WorkbenchAiBalanceResult {
  supported: boolean;
  balance: number | null;
  currency: string | null;
  message: string;
}

export interface WorkbenchAiResearchResult {
  interpretation: string;
  summary: string;
  question: string | null;
  needsConfirmation: boolean;
  suggestedOutcome?: string | null;
  suggestedDimensions?: string[];
  sources: GoalResearchSource[];
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  skills?: string[];
}

export interface WorkbenchAiGoalAnswerValidationResult {
  accepted: boolean;
  normalized: string;
  reason: string;
  confidence: number;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  skills?: string[];
}

export function isDesktopWorkbench(): boolean {
  return isTauri();
}

export function loadDesktopWorkbenchState(): Promise<IpcResponse<WorkbenchState | null>> {
  return invoke<IpcResponse<WorkbenchState | null>>("workbench_load_state").catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法读取桌面工作台数据", retryable: true, details: null },
  } as const));
}

export function saveDesktopWorkbenchState(state: WorkbenchState): Promise<IpcResponse<WorkbenchSaveResult>> {
  return invoke<IpcResponse<WorkbenchSaveResult>>("workbench_save_state", { request: { state } }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法保存桌面工作台数据", retryable: true, details: null },
  } as const));
}

export function askDesktopWorkbenchAi(prompt: string, context: unknown, sessionId?: string, agentRunId?: string, onEvent?: (event: WorkbenchAgentEvent) => void, permission: WorkbenchAgentRequest["permission"] = "suggest"): Promise<IpcResponse<WorkbenchAiAssistResult>> {
  const channel = new Channel<WorkbenchAgentEvent>();
  if (onEvent) channel.onmessage = onEvent;
  const request: Promise<IpcResponse<WorkbenchAiAssistResult>> = invoke<IpcResponse<WorkbenchAiAssistResult>>("workbench_ai_assist", { request: { prompt, context, permission, sessionId: sessionId ?? `workbench-${Date.now()}`, agentRunId: agentRunId ?? `run-${Date.now()}`, snapshotVersion: typeof context === "object" && context && "snapshotVersion" in context ? String((context as { snapshotVersion: unknown }).snapshotVersion) : "unknown" } satisfies WorkbenchAgentRequest, onEvent: channel }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接 AI 服务", retryable: true, details: null },
  } as const));
  const timeout = new Promise<IpcResponse<WorkbenchAiAssistResult>>((resolve) => window.setTimeout(() => resolve({
    status: "error",
    error: { code: "AI_REQUEST_TIMEOUT", message: "AI 请求超过 240 秒仍未返回，请打开 AI 配置查看分阶段诊断。", retryable: true, details: null },
  }), 240_000));
  return Promise.race([request, timeout]);
}

export function commitDesktopWorkbenchAgentState(expectedState: WorkbenchState, nextState: WorkbenchState): Promise<IpcResponse<WorkbenchSaveResult>> {
  return invoke<IpcResponse<WorkbenchSaveResult>>("workbench_agent_commit_state", { request: { expectedState, nextState } }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法提交 Agent 修改", retryable: true, details: null },
  }));
}

export function cancelDesktopWorkbenchAi(sessionId: string): Promise<IpcResponse<WorkbenchAiCancelResult>> {
  return invoke<IpcResponse<WorkbenchAiCancelResult>>("workbench_ai_cancel", { request: { sessionId } }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法取消 AI 请求", retryable: true, details: null },
  }));
}

export function researchDesktopWorkbenchAi(query: string, config: WorkbenchAiConfig, details?: { kind: string; targetDate: string; daysRemaining: number; progress: number }): Promise<IpcResponse<WorkbenchAiResearchResult>> {
  const request = invoke<IpcResponse<WorkbenchAiResearchResult>>("workbench_ai_research", { request: { query, details: details ?? null, config: { baseUrl: config.baseUrl, model: config.model } } }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接在线 AI 研究服务", retryable: true, details: null },
  }));
  const timeout = new Promise<IpcResponse<WorkbenchAiResearchResult>>((resolve) => window.setTimeout(() => resolve({
    status: "error",
    error: { code: "AI_RESEARCH_TIMEOUT", message: "在线目标研究超过 100 秒仍未返回；搜索和模型推理可能被中转站阻塞。", retryable: true, details: null },
  }), 100_000));
  return Promise.race([request, timeout]);
}

export function validateDesktopWorkbenchGoalAnswer(request: { goalTitle: string; questionKey: string; question: string; answer: string }, config: WorkbenchAiConfig): Promise<IpcResponse<WorkbenchAiGoalAnswerValidationResult>> {
  const call = invoke<IpcResponse<WorkbenchAiGoalAnswerValidationResult>>("workbench_ai_validate_goal_answer", { request: { ...request, config: { baseUrl: config.baseUrl, model: config.model } } }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接在线 AI 审核服务", retryable: true, details: null },
  }));
  const timeout = new Promise<IpcResponse<WorkbenchAiGoalAnswerValidationResult>>((resolve) => window.setTimeout(() => resolve({
    status: "error",
    error: { code: "AI_REQUEST_TIMEOUT", message: "在线审核超过 90 秒仍未返回，请检查中转站连接。", retryable: true, details: null },
  }), 90_000));
  return Promise.race([call, timeout]);
}

export function getDesktopWorkbenchAiCredentialStatus(): Promise<IpcResponse<WorkbenchAiCredentialStatus>> {
  return invoke<IpcResponse<WorkbenchAiCredentialStatus>>("workbench_ai_credentials_status").catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法读取 AI 凭据状态", retryable: true, details: null },
  }));
}

export function saveDesktopWorkbenchAiCredentials(apiKey: string): Promise<IpcResponse<WorkbenchAiCredentialStatus>> {
  return invoke<IpcResponse<WorkbenchAiCredentialStatus>>("workbench_ai_save_credentials", { request: { apiKey } }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法保存 AI 凭据", retryable: true, details: null },
  }));
}

export function clearDesktopWorkbenchAiCredentials(): Promise<IpcResponse<WorkbenchAiCredentialStatus>> {
  return invoke<IpcResponse<WorkbenchAiCredentialStatus>>("workbench_ai_clear_credentials").catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法清除 AI 凭据", retryable: true, details: null },
  }));
}

export function testDesktopWorkbenchAiConnection(config: WorkbenchAiConfig): Promise<IpcResponse<WorkbenchAiConnectionResult>> {
  const call = invoke<IpcResponse<WorkbenchAiConnectionResult>>("workbench_ai_test_connection", { config: { baseUrl: config.baseUrl, model: config.model } }).catch(() => ({
    status: "error" as const,
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法测试 AI 连接", retryable: true, details: null },
  }));
  const timeout = new Promise<IpcResponse<WorkbenchAiConnectionResult>>((resolve) => window.setTimeout(() => resolve({
    status: "error",
    error: { code: "AI_CONNECTION_TIMEOUT", message: "连接测试超过 130 秒仍未完成；请检查网络、防火墙和中转站地址。", retryable: true, details: null },
  }), 130_000));
  return Promise.race([call, timeout]);
}

export function checkDesktopWorkbenchAiBalance(config: WorkbenchAiConfig): Promise<IpcResponse<WorkbenchAiBalanceResult>> {
  return invoke<IpcResponse<WorkbenchAiBalanceResult>>("workbench_ai_balance", { config: { baseUrl: config.baseUrl, model: config.model, balanceUrl: config.balanceUrl ?? "" } }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法查询 AI 余额", retryable: true, details: null },
  }));
}
