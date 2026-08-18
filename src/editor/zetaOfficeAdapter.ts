import { editorError, errorCodeFromCause, messageFromCause } from "./errors.ts";
import {
  formatFromPath,
  isSamePath,
  type DocumentHandle,
  type EditOperation,
  type EditorAdapter,
  type EditorHealth,
  type EditorResult,
  type EditReceipt,
  type OfficeFormat,
  type Preview,
  type SaveReceipt,
} from "./types.ts";

/**
 * This is the only boundary that knows how the ZetaOffice/zetajs runtime is
 * hosted. The browser worker bridge can be replaced without changing callers.
 */
export interface ZetaOfficeRuntime {
  healthCheck(): Promise<{ version: string | null }>;
  open(input: { sourcePath: string; format: OfficeFormat; readOnly: boolean }): Promise<unknown>;
  readOnlyPreview(document: unknown, format: OfficeFormat): Promise<Preview>;
  edit(document: unknown, operation: EditOperation): Promise<void>;
  saveAs(document: unknown, targetPath: string, format: OfficeFormat): Promise<void>;
  close(document: unknown): Promise<void>;
}

/**
 * Minimal shape expected from the resolved `Module.zetajs` promise. The
 * format-specific UNO code stays in this bridge and is intentionally not part
 * of the public EditorAdapter contract.
 */
export interface ZetaJsModuleLike {
  version?: string;
  openDocument(input: { sourcePath: string; format: OfficeFormat; readOnly: boolean }): Promise<{
    readOnlyPreview(format: OfficeFormat): Promise<Preview>;
    edit(operation: EditOperation): Promise<void>;
    saveAs(targetPath: string, format: OfficeFormat): Promise<void>;
    close(): Promise<void>;
  }>;
}

export function createZetaJsRuntime(module: ZetaJsModuleLike): ZetaOfficeRuntime {
  return {
    async healthCheck() {
      return { version: module.version ?? null };
    },
    async open(input) {
      return module.openDocument(input);
    },
    async readOnlyPreview(document, format) {
      return (document as Awaited<ReturnType<ZetaJsModuleLike["openDocument"]>>).readOnlyPreview(format);
    },
    async edit(document, operation) {
      await (document as Awaited<ReturnType<ZetaJsModuleLike["openDocument"]>>).edit(operation);
    },
    async saveAs(document, targetPath, format) {
      await (document as Awaited<ReturnType<ZetaJsModuleLike["openDocument"]>>).saveAs(targetPath, format);
    },
    async close(document) {
      await (document as Awaited<ReturnType<ZetaJsModuleLike["openDocument"]>>).close();
    },
  };
}

export async function createZetaJsRuntimeFromModule(
  modulePromise: Promise<ZetaJsModuleLike>,
): Promise<ZetaOfficeRuntime> {
  return createZetaJsRuntime(await modulePromise);
}

export class UnavailableZetaOfficeRuntime implements ZetaOfficeRuntime {
  private unavailable(): Error {
    return Object.assign(new Error("ZetaOffice/zetajs runtime is not configured"), {
      code: "ZETA_RUNTIME_UNAVAILABLE",
    });
  }

  async healthCheck(): Promise<{ version: string | null }> {
    throw this.unavailable();
  }

  async open(): Promise<unknown> {
    throw this.unavailable();
  }

  async readOnlyPreview(): Promise<Preview> {
    throw this.unavailable();
  }

  async edit(): Promise<void> {
    throw this.unavailable();
  }

  async saveAs(): Promise<void> {
    throw this.unavailable();
  }

  async close(): Promise<void> {
    throw this.unavailable();
  }
}

interface OpenDocument {
  handle: DocumentHandle;
  sourcePath: string;
  runtimeDocument: unknown;
}

export class ZetaOfficeAdapter implements EditorAdapter {
  private readonly documents = new Map<string, OpenDocument>();
  private nextId = 1;
  private readonly runtime: ZetaOfficeRuntime;

  constructor(runtime: ZetaOfficeRuntime = new UnavailableZetaOfficeRuntime()) {
    this.runtime = runtime;
  }

  async healthCheck(): Promise<EditorResult<EditorHealth>> {
    try {
      const health = await this.runtime.healthCheck();
      return {
        status: "success",
        outcome: "PASS",
        data: {
          adapter: "zeta-office",
          runtimeAvailable: true,
          runtimeVersion: health.version,
          supportedFormats: ["docx", "pptx", "xlsx"],
          canEdit: true,
          canSaveAs: true,
        },
        warnings: [],
      };
    } catch (cause) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("ZETA_RUNTIME_UNAVAILABLE", "ZetaOffice/zetajs 运行时不可用", {
          retryable: true,
          details: { cause: messageFromCause(cause, "runtime unavailable") },
          fallback: { mode: "read-only-preview", available: false, reason: "未配置 ZetaOffice 运行时" },
        }),
      };
    }
  }

  async open(sourcePath: string, options: { readOnly?: boolean } = {}): Promise<EditorResult<DocumentHandle>> {
    const format = formatFromPath(sourcePath);
    if (!sourcePath.trim()) {
      return { status: "error", outcome: "FAIL", error: editorError("INVALID_ARGUMENT", "源文件路径不能为空") };
    }
    if (!format) {
      return { status: "error", outcome: "FAIL", error: editorError("UNSUPPORTED_FORMAT", "仅支持 DOCX、PPTX 和 XLSX") };
    }
    try {
      const runtimeDocument = await this.runtime.open({ sourcePath, format, readOnly: options.readOnly ?? false });
      const handle: DocumentHandle = {
        id: `zeta-${this.nextId++}`,
        format,
        mode: options.readOnly ? "read-only" : "edit",
      };
      this.documents.set(handle.id, { handle, sourcePath, runtimeDocument });
      return { status: "success", outcome: "PASS", data: handle, warnings: [] };
    } catch (cause) {
      const code = errorCodeFromCause(cause, "EDITOR_OPEN_FAILED");
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError(code, "文档无法由 ZetaOffice 打开", {
          retryable: code === "ZETA_RUNTIME_UNAVAILABLE",
          details: { cause: messageFromCause(cause, "open failed"), format },
          fallback: {
            mode: "read-only-preview",
            available: code !== "ZETA_RUNTIME_UNAVAILABLE",
            reason: code === "ZETA_RUNTIME_UNAVAILABLE" ? "未配置可用的只读预览运行时" : "编辑器打开失败，保留只读预览回退",
          },
        }),
      };
    }
  }

  async readOnlyPreview(handle: DocumentHandle): Promise<EditorResult<Preview>> {
    const document = this.documents.get(handle.id);
    if (!document) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在") };
    }
    try {
      const preview = await this.runtime.readOnlyPreview(document.runtimeDocument, handle.format);
      return { status: "success", outcome: preview.warnings.length > 0 ? "DEGRADED" : "PASS", data: preview, warnings: preview.warnings };
    } catch (cause) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("EDITOR_PREVIEW_FAILED", "只读预览生成失败", {
          retryable: true,
          details: { cause: messageFromCause(cause, "preview failed") },
          fallback: { mode: "read-only-preview", available: false, reason: "ZetaOffice 预览接口不可用" },
        }),
      };
    }
  }

  async edit(handle: DocumentHandle, operation: EditOperation): Promise<EditorResult<EditReceipt>> {
    const document = this.documents.get(handle.id);
    if (!document) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在") };
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
    try {
      await this.runtime.edit(document.runtimeDocument, operation);
      return { status: "success", outcome: "PASS", data: { operation: operation.kind, changed: true }, warnings: [] };
    } catch (cause) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError(errorCodeFromCause(cause, "EDITOR_EDIT_FAILED"), "文档修改失败", {
          retryable: true,
          details: { cause: messageFromCause(cause, "edit failed") },
          fallback: { mode: "read-only-preview", available: true, reason: "修改失败时保持只读内容" },
        }),
      };
    }
  }

  async saveAs(
    handle: DocumentHandle,
    targetPath: string,
    options: { format?: OfficeFormat } = {},
  ): Promise<EditorResult<SaveReceipt>> {
    const document = this.documents.get(handle.id);
    if (!document) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在") };
    }
    if (!targetPath.trim() || isSamePath(document.sourcePath, targetPath)) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("SOURCE_WRITE_FORBIDDEN", "POC 不允许覆盖样本原件", {
          fallback: { mode: "read-only-preview", available: true, reason: "源文件保持未修改" },
        }),
      };
    }
    const targetFormat = options.format ?? formatFromPath(targetPath);
    if (!targetFormat) {
      return { status: "error", outcome: "FAIL", error: editorError("UNSUPPORTED_FORMAT", "另存目标必须是 DOCX、PPTX 或 XLSX") };
    }
    try {
      await this.runtime.saveAs(document.runtimeDocument, targetPath, targetFormat);
      return {
        status: "success",
        outcome: "PASS",
        data: { targetFormat, targetPath, sourceWasPreserved: true },
        warnings: [],
      };
    } catch (cause) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError(errorCodeFromCause(cause, "EDITOR_SAVE_FAILED"), "文档另存失败", {
          retryable: true,
          details: { cause: messageFromCause(cause, "save failed"), targetFormat },
          fallback: { mode: "read-only-preview", available: true, reason: "保存失败，禁止覆盖源文件" },
        }),
      };
    }
  }

  async close(handle: DocumentHandle): Promise<EditorResult<null>> {
    const document = this.documents.get(handle.id);
    if (!document) {
      return { status: "error", outcome: "FAIL", error: editorError("HANDLE_NOT_FOUND", "编辑器句柄不存在") };
    }
    try {
      await this.runtime.close(document.runtimeDocument);
      this.documents.delete(handle.id);
      return { status: "success", outcome: "PASS", data: null, warnings: [] };
    } catch (cause) {
      return {
        status: "error",
        outcome: "FAIL",
        error: editorError("EDITOR_CLOSE_FAILED", "文档关闭失败", {
          retryable: true,
          details: { cause: messageFromCause(cause, "close failed") },
          fallback: { mode: "read-only-preview", available: true, reason: "关闭失败，文档句柄仍保留" },
        }),
      };
    }
  }
}
