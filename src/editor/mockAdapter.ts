import { editorError } from "./errors.ts";
import {
  formatFromPath,
  isSamePath,
  type DocumentHandle,
  type EditOperation,
  type EditorAdapter,
  type EditorResult,
  type EditReceipt,
  type EditorHealth,
  type Preview,
  type SaveReceipt,
} from "./types.ts";

interface MockDocument {
  handle: DocumentHandle;
  sourcePath: string;
  content: string;
  closed: boolean;
}

export class MockEditorAdapter implements EditorAdapter {
  private readonly documents = new Map<string, MockDocument>();
  private readonly writes = new Map<string, string>();
  private nextId = 1;

  async healthCheck(): Promise<EditorResult<EditorHealth>> {
    return {
      status: "success",
      outcome: "PASS",
      data: {
        adapter: "mock",
        runtimeAvailable: true,
        runtimeVersion: "mock-1",
        supportedFormats: ["docx", "pptx", "xlsx"],
        canEdit: true,
        canSaveAs: true,
      },
      warnings: ["Mock results are contract evidence only and must not be used as ZetaOffice POC evidence."],
    };
  }

  async open(sourcePath: string, options: { readOnly?: boolean } = {}): Promise<EditorResult<DocumentHandle>> {
    const format = formatFromPath(sourcePath);
    if (!format) {
      return { status: "error", outcome: "FAIL", error: editorError("UNSUPPORTED_FORMAT", "仅支持 DOCX、PPTX 和 XLSX") };
    }
    if (!sourcePath.trim()) {
      return { status: "error", outcome: "FAIL", error: editorError("INVALID_ARGUMENT", "源文件路径不能为空") };
    }

    const handle: DocumentHandle = {
      id: `mock-${this.nextId++}`,
      format,
      mode: options.readOnly ? "read-only" : "edit",
    };
    this.documents.set(handle.id, {
      handle,
      sourcePath,
      content: `mock document ${sourcePath}`,
      closed: false,
    });
    return { status: "success", outcome: "PASS", data: handle, warnings: [] };
  }

  async readOnlyPreview(handle: DocumentHandle): Promise<EditorResult<Preview>> {
    const document = this.documents.get(handle.id);
    if (!document || document.closed) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在或已关闭") };
    }
    return {
      status: "success",
      outcome: "PASS",
      data: { format: handle.format, readOnly: true, summary: document.content, warnings: [] },
      warnings: [],
    };
  }

  async edit(handle: DocumentHandle, operation: EditOperation): Promise<EditorResult<EditReceipt>> {
    const document = this.documents.get(handle.id);
    if (!document || document.closed) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在或已关闭") };
    }
    if (handle.mode === "read-only") {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("EDITOR_EDIT_FAILED", "当前文档处于只读预览状态", {
          fallback: { mode: "read-only-preview", available: true, reason: "只读预览仍可继续查看" },
        }),
      };
    }
    if (operation.kind === "replace-text") {
      document.content = document.content.replaceAll(operation.find, operation.replace);
    } else if (operation.kind === "append-text") {
      document.content += operation.text;
    } else {
      document.content += ` ${operation.sheet}!${operation.cell}=${operation.value}`;
    }
    return { status: "success", outcome: "PASS", data: { operation: operation.kind, changed: true }, warnings: [] };
  }

  async saveAs(
    handle: DocumentHandle,
    targetPath: string,
    options: { format?: "docx" | "pptx" | "xlsx" } = {},
  ): Promise<EditorResult<SaveReceipt>> {
    const document = this.documents.get(handle.id);
    if (!document || document.closed) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在或已关闭") };
    }
    if (isSamePath(document.sourcePath, targetPath)) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("SOURCE_WRITE_FORBIDDEN", "POC 不允许覆盖样本原件", { retryable: false }),
      };
    }
    const targetFormat = options.format ?? formatFromPath(targetPath);
    if (!targetFormat) {
      return { status: "error", outcome: "FAIL", error: editorError("UNSUPPORTED_FORMAT", "另存目标必须是 DOCX、PPTX 或 XLSX") };
    }
    this.writes.set(targetPath, document.content);
    return {
      status: "success",
      outcome: "PASS",
      data: { targetFormat, targetPath, sourceWasPreserved: true },
      warnings: [],
    };
  }

  async close(handle: DocumentHandle): Promise<EditorResult<null>> {
    const document = this.documents.get(handle.id);
    if (!document || document.closed) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在或已关闭") };
    }
    document.closed = true;
    return { status: "success", outcome: "PASS", data: null, warnings: [] };
  }

  getSavedContent(targetPath: string): string | undefined {
    return this.writes.get(targetPath);
  }
}
