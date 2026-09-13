import { Channel, invoke } from "@tauri-apps/api/core";

import type { DocumentSaveResult } from "./document";
import type { IpcResponse } from "./types";

export type AiPermission = "suggest" | "assist" | "autonomous";

export interface ContextSelection {
  documentId: string;
  page: number | null;
}

export interface ContextRequest {
  prompt: string;
  permission?: AiPermission;
  documentIds?: string[];
  selections?: ContextSelection[];
  maxChars?: number;
}

export interface AiConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ContextSource {
  documentId: string;
  displayName: string;
  pages: number[];
  characterCount: number;
}

export interface ContextPreview {
  sources: ContextSource[];
  segmentCount: number;
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
  permission: AiPermission;
  untrusted: boolean;
}

export interface AiChatRequest extends ContextRequest {
  sessionId: string;
  permission: AiPermission;
  confirmed: boolean;
  authorizedDocumentIds?: string[];
  /** Recent turns from this selected document, used to resolve follow-up requests. */
  conversation?: AiConversationMessage[];
}

export type AiStreamEvent =
  | { kind: "textDelta"; text: string }
  | { kind: "toolRequest"; callId: string; name: string; arguments: unknown }
  | { kind: "proposedChange"; proposalId: string; documentId: string; permission: AiPermission; expectedSha256: string; oldContent: string; newContent: string }
  | { kind: "writebackStatus"; proposalId: string; documentId: string; status: "started" | "applied" | "failed"; message: string; code: string | null }
  | { kind: "completed"; responseId: string | null; inputTokens: number | null; outputTokens: number | null }
  | { kind: "error"; code: string; message: string; retryable: boolean };

export interface AiChatResult {
  sessionId: string;
  permission: AiPermission;
  context: ContextPreview;
  events: AiStreamEvent[];
}

export interface AiChangeRequest {
  sessionId: string;
  permission: AiPermission;
  documentId: string;
  expectedSha256: string;
  /** Server verifies this against the stored proposal before applying it. */
  oldContent?: string;
  content: string;
  approved: boolean;
  changeId?: string;
  authorizedDocumentIds?: string[];
}

export interface AiCancelResult {
  sessionId: string;
  cancelled: boolean;
}

export interface AiRejectChangeResult {
  changeId: string;
  rejected: boolean;
}

export interface AiActionRecord {
  id: string;
  sessionId: string;
  documentId: string | null;
  permission: AiPermission;
  tool: string;
  outcome: string;
  details: Record<string, unknown>;
  createdAtMs: number;
}

export interface AiChangeResult {
  action: AiActionRecord;
  save: DocumentSaveResult | null;
}

async function call<T>(command: string, request?: unknown): Promise<IpcResponse<T>> {
  try {
    return await invoke<IpcResponse<T>>(command, request === undefined ? undefined : { request });
  } catch {
    return { status: "error", error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接 AI 服务", retryable: true, details: null } };
  }
}

export function previewAiContext(request: ContextRequest): Promise<IpcResponse<ContextPreview>> {
  return call("ai_context_preview", request);
}

export function chatWithAi(request: AiChatRequest): Promise<IpcResponse<AiChatResult>> {
  return call("ai_chat", request);
}

export function chatWithAiStream(
  request: AiChatRequest,
  onEvent: (event: AiStreamEvent) => void,
): Promise<IpcResponse<AiChatResult>> {
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<IpcResponse<AiChatResult>>("ai_chat_stream", { request, onEvent: channel }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接 AI 服务", retryable: true, details: null },
  }));
}

export function applyAiChange(request: AiChangeRequest): Promise<IpcResponse<AiChangeResult>> {
  return call("ai_apply_change", request);
}

export function cancelAiChat(sessionId: string): Promise<IpcResponse<AiCancelResult>> {
  return call("ai_cancel", { sessionId });
}

export function rejectAiChange(sessionId: string, changeId: string): Promise<IpcResponse<AiRejectChangeResult>> {
  return call("ai_reject_change", { sessionId, changeId });
}

export function listAiActions(sessionId?: string): Promise<IpcResponse<AiActionRecord[]>> {
  return call("ai_list_actions", { sessionId: sessionId ?? null });
}
