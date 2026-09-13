import type { DocumentCapabilities, DocumentMode, DocumentOpenResult } from "../ipc/document";
import type { DocumentFormat } from "../ipc/library";
import type { AdapterDescriptor, DocumentAdapter, ViewerKind } from "./types";

const noEdit = (capabilities: DocumentCapabilities): DocumentCapabilities => ({
  ...capabilities,
  canEdit: false,
  canSave: false,
});

class TextAdapter implements DocumentAdapter {
  readonly kind = "text" as const;
  descriptor(_format: DocumentFormat, mode: DocumentMode): AdapterDescriptor {
    return { kind: this.kind, label: mode === "read-only" ? "文本只读" : "文本编辑", supportsEdit: true, supportsPreview: true, fallbackReason: null };
  }
  normalize(opened: DocumentOpenResult) { return { content: opened.content, capabilities: opened.capabilities, warning: null }; }
}

class PdfAdapter implements DocumentAdapter {
  readonly kind = "pdf" as const;
  descriptor(): AdapterDescriptor { return { kind: this.kind, label: "PDF.js 阅读器", supportsEdit: false, supportsPreview: true, fallbackReason: "PDF 当前仅支持阅读和批注" }; }
  normalize(opened: DocumentOpenResult) { return { content: null, capabilities: noEdit(opened.capabilities), warning: "PDF 当前为只读；批注以页码和引用文本锚定" }; }
}

class ImageAdapter implements DocumentAdapter {
  readonly kind = "image" as const;
  descriptor(): AdapterDescriptor { return { kind: this.kind, label: "图片查看器", supportsEdit: false, supportsPreview: true, fallbackReason: null }; }
  normalize(opened: DocumentOpenResult) { return { content: null, capabilities: noEdit(opened.capabilities), warning: null }; }
}

class OfficeAdapter implements DocumentAdapter {
  readonly kind = "office" as const;
  descriptor(format: DocumentFormat): AdapterDescriptor {
    const supportsEdit = format === "docx" || format === "xlsx";
    return { kind: this.kind, label: format === "xlsx" ? "XLSX 表格编辑器" : supportsEdit ? "DOCX 文字编辑器" : "Office 只读查看器", supportsEdit, supportsPreview: true, fallbackReason: supportsEdit ? null : "该 Office 格式当前仅支持只读" };
  }
  normalize(opened: DocumentOpenResult) {
    const supportedEdit = opened.document.format === "docx" || opened.document.format === "xlsx";
    return { content: null, capabilities: supportedEdit ? opened.capabilities : noEdit(opened.capabilities), warning: supportedEdit ? null : "该 Office 格式当前为只读；原文件不会被修改" };
  }
}

class ReadOnlyAdapter implements DocumentAdapter {
  readonly kind = "read-only" as const;
  descriptor(): AdapterDescriptor { return { kind: this.kind, label: "只读降级", supportsEdit: false, supportsPreview: false, fallbackReason: "此格式尚无可用查看器" }; }
  normalize(opened: DocumentOpenResult) { return { content: null, capabilities: noEdit(opened.capabilities), warning: "该格式保持只读，原文件不会被修改" }; }
}

export class AdapterRegistry {
  private readonly adapters: Record<ViewerKind, DocumentAdapter> = {
    text: new TextAdapter(),
    pdf: new PdfAdapter(),
    image: new ImageAdapter(),
    office: new OfficeAdapter(),
    "read-only": new ReadOnlyAdapter(),
  };

  resolve(format: DocumentFormat): DocumentAdapter {
    if (format === "markdown" || format === "text" || format === "csv") return this.adapters.text;
    if (format === "pdf") return this.adapters.pdf;
    if (format === "doc" || format === "docx" || format === "pptx" || format === "xlsx") return this.adapters.office;
    if (format === "png" || format === "jpg" || format === "tiff" || format === "bmp") return this.adapters.image;
    return this.adapters["read-only"];
  }
}

export const adapterRegistry = new AdapterRegistry();
