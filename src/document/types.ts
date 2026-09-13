import type { DocumentFormat } from "../ipc/library";
import type { DocumentCapabilities, DocumentMode, DocumentOpenResult } from "../ipc/document";

export type ViewerKind = "office" | "pdf" | "text" | "image" | "read-only";

export interface AdapterDescriptor {
  kind: ViewerKind;
  label: string;
  supportsEdit: boolean;
  supportsPreview: boolean;
  fallbackReason: string | null;
}

export interface DocumentAdapter {
  readonly kind: ViewerKind;
  descriptor(format: DocumentFormat, mode: DocumentMode): AdapterDescriptor;
  normalize(opened: DocumentOpenResult): { content: string | null; capabilities: DocumentCapabilities; warning: string | null };
}
