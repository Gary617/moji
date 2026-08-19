import { UnavailableZetaOfficeRuntime, ZetaOfficeAdapter } from "../editor";
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
    return { kind: this.kind, label: mode === "read-only" ? "文本只读" : "文本编辑", supportsEdit: mode !== "read-only", supportsPreview: true, fallbackReason: null };
  }
  normalize(opened: DocumentOpenResult) { return { content: opened.content, capabilities: opened.capabilities, warning: null }; }
}

class PdfAdapter implements DocumentAdapter {
  readonly kind = "pdf" as const;
  descriptor(): AdapterDescriptor { return { kind: this.kind, label: "PDF.js 阅读器", supportsEdit: false, supportsPreview: true, fallbackReason: "PDF 当前仅支持阅读和批注" }; }
  normalize(opened: DocumentOpenResult) { return { content: null, capabilities: noEdit(opened.capabilities), warning: "PDF 当前为只读；批注以页码和引用文本锚定" }; }
}

class OfficeAdapter implements DocumentAdapter {
  readonly kind = "office" as const;
  private readonly adapter = new ZetaOfficeAdapter(new UnavailableZetaOfficeRuntime());
  descriptor(): AdapterDescriptor { return { kind: this.kind, label: "Office 适配器", supportsEdit: false, supportsPreview: false, fallbackReason: "桌面 ZetaOffice runtime bridge 尚未配置，Office 仅显示受控降级状态" }; }
  normalize(opened: DocumentOpenResult) {
    void this.adapter.healthCheck();
    return { content: null, capabilities: noEdit(opened.capabilities), warning: "Office POC 已验证 round-trip；产品宿主 bridge 未接入，因此本版本不提供编辑或预览" };
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
    office: new OfficeAdapter(),
    "read-only": new ReadOnlyAdapter(),
  };

  resolve(format: DocumentFormat): DocumentAdapter {
    if (format === "markdown" || format === "text" || format === "csv") return this.adapters.text;
    if (format === "pdf") return this.adapters.pdf;
    if (format === "docx" || format === "pptx" || format === "xlsx") return this.adapters.office;
    return this.adapters["read-only"];
  }
}

export const adapterRegistry = new AdapterRegistry();
