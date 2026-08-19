import { invoke } from "@tauri-apps/api/core";

import type { DocumentFormat, DocumentRecord, SourceLocator } from "./library";
import type { IpcResponse } from "./types";

export type DocumentMode = "read-only" | "edit" | "assist";

export interface DocumentCapabilities {
  canEdit: boolean;
  canSave: boolean;
  canSaveAs: boolean;
  canAnnotate: boolean;
  supportsPageAnchor: boolean;
  supportsParagraphAnchor: boolean;
}

export interface DocumentOpenResult {
  sessionId: string;
  document: DocumentRecord;
  mode: DocumentMode;
  readOnly: boolean;
  expectedSha256: string;
  content: string | null;
  binaryContent: string | null;
  capabilities: DocumentCapabilities;
  sourceLocator: SourceLocator;
  warnings: string[];
}

export interface DocumentSaveResult {
  documentId: string;
  snapshotId: string;
  newSha256: string;
  targetPath: string | null;
  sourcePreserved: boolean;
}

export interface SnapshotRecord {
  id: string;
  documentId: string;
  originalSha256: string;
  createdAtMs: number;
  byteLen: number;
}

export interface AnnotationAnchor {
  kind: "page" | "paragraph" | "character-range" | "document";
  page: number | null;
  slide: number | null;
  paragraph: number | null;
  charStart: number | null;
  charEnd: number | null;
  quote: string | null;
  stable: boolean;
}

export interface AnnotationRecord {
  id: string;
  documentId: string;
  author: string;
  body: string;
  anchor: AnnotationAnchor;
  createdAtMs: number;
  updatedAtMs: number;
}

async function call<T>(command: string, request?: unknown): Promise<IpcResponse<T>> {
  try {
    return await invoke<IpcResponse<T>>(command, request === undefined ? undefined : { request });
  } catch {
    return { status: "error", error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接文档服务", retryable: true, details: null } };
  }
}

export function openDocument(documentId: string, mode: DocumentMode): Promise<IpcResponse<DocumentOpenResult>> {
  return call("document_open", { documentId, mode });
}

export function saveDocument(documentId: string, expectedSha256: string, content: string, mode: DocumentMode): Promise<IpcResponse<DocumentSaveResult>> {
  return call("document_save", { documentId, expectedSha256, content, mode });
}

export function closeDocument(documentId: string): Promise<IpcResponse<void>> {
  return call("document_close", { documentId });
}

export function listSnapshots(documentId: string): Promise<IpcResponse<SnapshotRecord[]>> {
  return call("document_list_snapshots", { documentId });
}

export function restoreSnapshot(documentId: string, snapshotId: string, expectedSha256: string): Promise<IpcResponse<DocumentSaveResult>> {
  return call("document_restore_snapshot", { documentId, snapshotId, expectedSha256 });
}

export function listAnnotations(documentId: string): Promise<IpcResponse<AnnotationRecord[]>> {
  return call("document_list_annotations", { documentId });
}

export function addAnnotation(documentId: string, author: string, body: string, anchor: AnnotationAnchor): Promise<IpcResponse<AnnotationRecord>> {
  return call("document_add_annotation", { documentId, author, body, anchor });
}

export function deleteAnnotation(annotationId: string): Promise<IpcResponse<void>> {
  return call("document_delete_annotation", { annotationId });
}

export function adapterFormat(format: DocumentFormat): "office" | "pdf" | "text" | "read-only" {
  if (format === "docx" || format === "pptx" || format === "xlsx") return "office";
  if (format === "pdf") return "pdf";
  if (format === "markdown" || format === "text" || format === "csv") return "text";
  return "read-only";
}
