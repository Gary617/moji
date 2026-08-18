import { invoke } from "@tauri-apps/api/core";

import type { IpcResponse } from "./types";

export type DocumentFormat =
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
  canonicalPath: string;
  displayName: string;
  createdAtMs: number;
}

export interface DocumentRecord {
  id: string;
  sourceRootId: string;
  canonicalPath: string;
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
  available: boolean;
  reason: string | null;
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

export interface IndexRebuildSummary {
  indexedCount: number;
  failedCount: number;
  durationMs: number;
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

export function rebuildSearchIndex(): Promise<IpcResponse<IndexRebuildSummary>> {
  return call("library_rebuild_search_index");
}
