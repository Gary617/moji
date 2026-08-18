export type OfficeFormat = "docx" | "pptx" | "xlsx";

export type EditorOutcome = "PASS" | "DEGRADED" | "FAIL";

export type EditorErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_FORMAT"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_WRITE_FORBIDDEN"
  | "HANDLE_NOT_FOUND"
  | "ZETA_RUNTIME_UNAVAILABLE"
  | "EDITOR_OPEN_FAILED"
  | "EDITOR_PREVIEW_FAILED"
  | "EDITOR_EDIT_FAILED"
  | "EDITOR_SAVE_FAILED"
  | "EDITOR_REOPEN_FAILED"
  | "EDITOR_CLOSE_FAILED"
  | "OUTPUT_INVALID";

export interface EditorError {
  code: EditorErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
  fallback: ReadOnlyFallback | null;
}

export interface ReadOnlyFallback {
  mode: "read-only-preview";
  available: boolean;
  reason: string;
}

export type EditorResult<T> =
  | {
      status: "success";
      outcome: "PASS" | "DEGRADED";
      data: T;
      warnings: string[];
    }
  | {
      status: "error";
      outcome: "FAIL";
      error: EditorError;
    };

export interface EditorHealth {
  adapter: "zeta-office" | "mock";
  runtimeAvailable: boolean;
  runtimeVersion: string | null;
  supportedFormats: OfficeFormat[];
  canEdit: boolean;
  canSaveAs: boolean;
}

export interface DocumentHandle {
  id: string;
  format: OfficeFormat;
  mode: "edit" | "read-only";
}

export interface Preview {
  format: OfficeFormat;
  readOnly: boolean;
  summary: string;
  warnings: string[];
}

export type EditOperation =
  | { kind: "replace-text"; find: string; replace: string }
  | { kind: "append-text"; text: string }
  | { kind: "set-cell-value"; sheet: string; cell: string; value: string };

export interface EditReceipt {
  operation: EditOperation["kind"];
  changed: boolean;
}

export interface SaveReceipt {
  targetFormat: OfficeFormat;
  targetPath: string;
  sourceWasPreserved: true;
}

export interface EditorAdapter {
  healthCheck(): Promise<EditorResult<EditorHealth>>;
  open(sourcePath: string, options?: { readOnly?: boolean }): Promise<EditorResult<DocumentHandle>>;
  readOnlyPreview(handle: DocumentHandle): Promise<EditorResult<Preview>>;
  edit(handle: DocumentHandle, operation: EditOperation): Promise<EditorResult<EditReceipt>>;
  saveAs(
    handle: DocumentHandle,
    targetPath: string,
    options?: { format?: OfficeFormat },
  ): Promise<EditorResult<SaveReceipt>>;
  close(handle: DocumentHandle): Promise<EditorResult<null>>;
}

export function formatFromPath(sourcePath: string): OfficeFormat | null {
  const extension = sourcePath.trim().toLowerCase().split(".").pop();
  return extension === "docx" || extension === "pptx" || extension === "xlsx"
    ? extension
    : null;
}

export function isSamePath(left: string, right: string): boolean {
  return left.trim().replaceAll("/", "\\").toLowerCase() === right.trim().replaceAll("/", "\\").toLowerCase();
}
