import { Channel, invoke } from "@tauri-apps/api/core";

import type { IpcResponse } from "./types";

export type DocumentFormat =
  | "doc"
  | "docx"
  | "pptx"
  | "xlsx"
  | "pdf"
  | "markdown"
  | "text"
  | "csv"
  | "png"
  | "jpg"
  | "tiff"
  | "bmp";

export type DocumentStatus = "present" | "missing" | "error";

export interface SourceRootRecord {
  id: string;
  kind: "directory" | "single_file";
  displayName: string;
  createdAtMs: number;
}

export interface SourceRegistration {
  source: SourceRootRecord;
  created: boolean;
}

export interface SourcePickerResult {
  cancelled: boolean;
  source: SourceRegistration | null;
}

export interface CommonLocationScanResult {
  sources: SourceRootRecord[];
  jobs: ScanJobRecord[];
  skipped: string[];
}

export interface ScanFolderNode {
  relativePath: string;
  displayName: string;
  depth: number;
  fileCount: number;
  children: ScanFolderNode[];
  hasMore: boolean;
}

export interface ScanRootPreview {
  sourceId: string;
  label: string;
  root: ScanFolderNode;
}

export interface ScanPreviewResult {
  roots: ScanRootPreview[];
  skipped: string[];
  maxDepth: number;
}

export type ScanPreviewEvent =
  | { kind: "started"; rootCount: number }
  | { kind: "rootStarted"; label: string; rootIndex: number; rootCount: number }
  | { kind: "folder"; label: string; relativePath: string; foldersScanned: number; filesFound: number }
  | { kind: "completed"; foldersScanned: number; filesFound: number };

export interface ScanSelection {
  sourceId: string;
  relativePaths: string[];
}

export interface DocumentRecord {
  id: string;
  sourceRootId: string;
  /** Normalized local path used for the file hover tooltip. */
  path?: string;
  displayName: string;
  format: DocumentFormat;
  sizeBytes: number;
  modifiedAtMs: number;
  status: DocumentStatus;
  contentState: string;
}

export interface TagRecord {
  id: string;
  name: string;
  createdAtMs: number;
}

export interface CollectionRecord {
  id: string;
  name: string;
  createdAtMs: number;
}

export interface SearchSnippet {
  field: "title" | "body" | "path" | "tags" | "ocr";
  text: string;
}

export interface SourceLocator {
  kind: "page" | "slide" | "paragraph" | "document";
  page: number | null;
  slide: number | null;
  paragraph: number | null;
  boundingBox: OcrBoundingBox | null;
  available: boolean;
  reason: string | null;
}

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrBoundingBox {
  points: OcrPoint[];
}

export interface OcrTextBox {
  text: string;
  confidence: number;
  boundingBox: OcrBoundingBox;
}

export interface DocumentFragment {
  documentId: string;
  page: number;
  source: "ocr" | "text_layer" | "blank";
  text: string;
  confidence: number | null;
  width: number;
  height: number;
  rotationDegrees: number;
  boxes: OcrTextBox[];
  sourceLocator: SourceLocator;
}

export interface OcrJobRecord {
  id: string;
  documentId: string;
  sourceRootId: string;
  state: "queued" | "running" | "paused" | "cancelled" | "failed" | "completed";
  pageCount: number;
  processedCount: number;
  failedCount: number;
  retryCount: number;
  errorCode: string | null;
  modelVersion: string;
  runtimeVersion: string;
  inputSha256: string;
  durationMs: number | null;
  modelBytes: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OcrModelStatus {
  modelVersion: string;
  runtimeVersion: string;
  available: boolean;
  modelBytes: number;
  missingAssets: string[];
}

export interface ScanJobRecord {
  id: string;
  sourceRootId: string;
  state: "queued" | "running" | "paused" | "cancelled" | "failed" | "completed";
  scannedCount: number;
  totalCount: number;
  currentFileName: string | null;
  changedCount: number;
  failedCount: number;
  retryCount: number;
  errorCode: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  updatedAtMs: number;
}

export interface ScanSummary {
  job: ScanJobRecord;
  events: unknown[];
}

export interface SearchDocument {
  document: DocumentRecord;
  snippets: SearchSnippet[];
  sourceLocator: SourceLocator;
  tags: TagRecord[];
  collections: CollectionRecord[];
  isFavorite: boolean;
  indexState: "ready" | "error";
}

export interface SearchQuery {
  text?: string;
  formats?: DocumentFormat[];
  modifiedAfterMs?: number;
  modifiedBeforeMs?: number;
  sourceRootIds?: string[];
  collectionId?: string;
  tagIds?: string[];
  statuses?: DocumentStatus[];
  favoriteOnly?: boolean;
  recentOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResults {
  items: SearchDocument[];
  total: number;
  queryTimeMs: number;
}

async function call<T>(command: string, request?: unknown): Promise<IpcResponse<T>> {
  try {
    return await invoke<IpcResponse<T>>(command, request === undefined ? undefined : { request });
  } catch {
    return {
      status: "error",
      error: {
        code: "IPC_TRANSPORT_ERROR",
        message: "无法连接本地资料库",
        retryable: true,
        details: null,
      },
    };
  }
}

export function searchLibrary(query: SearchQuery): Promise<IpcResponse<SearchResults>> {
  return call("library_search", query);
}

export function listSources(): Promise<IpcResponse<SourceRootRecord[]>> {
  return call("library_list_sources");
}

export function pickSourceFolder(): Promise<IpcResponse<SourcePickerResult>> {
  return call("library_pick_source_folder");
}

export function pickSourceFile(): Promise<IpcResponse<SourcePickerResult>> {
  return call("library_pick_source_file");
}

export function scanCommonLocations(): Promise<IpcResponse<CommonLocationScanResult>> {
  return call("library_scan_common_locations");
}

export function previewCommonLocations(onEvent?: (event: ScanPreviewEvent) => void): Promise<IpcResponse<ScanPreviewResult>> {
  const channel = new Channel<ScanPreviewEvent>();
  channel.onmessage = (event) => onEvent?.(event);
  return invoke<IpcResponse<ScanPreviewResult>>("library_preview_common_locations", { onEvent: channel }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接本地资料库", retryable: true, details: null },
  }));
}

export function previewFullDisk(onEvent?: (event: ScanPreviewEvent) => void): Promise<IpcResponse<ScanPreviewResult>> {
  const channel = new Channel<ScanPreviewEvent>();
  channel.onmessage = (event) => onEvent?.(event);
  return invoke<IpcResponse<ScanPreviewResult>>("library_preview_full_disk", { onEvent: channel }).catch(() => ({
    status: "error",
    error: { code: "IPC_TRANSPORT_ERROR", message: "无法连接本地资料库", retryable: true, details: null },
  }));
}

export function startSelectedScan(selections: ScanSelection[]): Promise<IpcResponse<CommonLocationScanResult>> {
  return call("library_start_selected_scan", { selections });
}

export function startScan(sourceRootId: string): Promise<IpcResponse<ScanSummary>> {
  return call("library_start_scan", { sourceRootId });
}

export function scanStatus(scanJobId: string): Promise<IpcResponse<ScanJobRecord>> {
  return call("library_scan_status", { scanJobId });
}

export function pauseScan(scanJobId: string): Promise<IpcResponse<ScanJobRecord>> {
  return call("library_pause_scan", { scanJobId });
}

export function resumeScan(scanJobId: string): Promise<IpcResponse<ScanJobRecord>> {
  return call("library_resume_scan", { scanJobId });
}

export function cancelScan(scanJobId: string): Promise<IpcResponse<ScanJobRecord>> {
  return call("library_cancel_scan", { scanJobId });
}

export function retryScan(scanJobId: string): Promise<IpcResponse<ScanJobRecord>> {
  return call("library_retry_scan", { scanJobId });
}

export function listCollections(): Promise<IpcResponse<CollectionRecord[]>> {
  return call("library_list_collections");
}

export function listTags(): Promise<IpcResponse<TagRecord[]>> {
  return call("library_list_tags");
}

export function createCollection(name: string): Promise<IpcResponse<CollectionRecord>> {
  return call("library_create_collection", { name });
}

export function createTag(name: string): Promise<IpcResponse<TagRecord>> {
  return call("library_create_tag", { name });
}

export function setFavorite(documentId: string, favorite: boolean): Promise<IpcResponse<void>> {
  return call("library_set_favorite", { documentId, favorite });
}

export function removeDocument(documentId: string): Promise<IpcResponse<void>> {
  return call("library_remove_document", { documentId });
}

export function setCollectionMembership(
  documentId: string,
  relationId: string,
  included: boolean,
): Promise<IpcResponse<void>> {
  return call("library_set_collection_membership", { documentId, relationId, included });
}

export function setTagMembership(
  documentId: string,
  relationId: string,
  included: boolean,
): Promise<IpcResponse<void>> {
  return call("library_set_tag_membership", { documentId, relationId, included });
}

export function recordRecentUse(documentId: string): Promise<IpcResponse<void>> {
  return call("library_record_recent_use", { documentId });
}

export function ocrModelStatus(): Promise<IpcResponse<OcrModelStatus>> {
  return call("library_ocr_model_status");
}

export function startOcr(documentId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_start_ocr", { documentId });
}

export function ocrStatus(ocrJobId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_ocr_status", { ocrJobId });
}

export function pauseOcr(ocrJobId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_pause_ocr", { ocrJobId });
}

export function resumeOcr(ocrJobId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_resume_ocr", { ocrJobId });
}

export function cancelOcr(ocrJobId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_cancel_ocr", { ocrJobId });
}

export function retryOcr(ocrJobId: string): Promise<IpcResponse<OcrJobRecord>> {
  return call("library_retry_ocr", { ocrJobId });
}

export function documentFragments(documentId: string, page?: number): Promise<IpcResponse<DocumentFragment[]>> {
  return call("library_document_fragments", { documentId, page });
}
