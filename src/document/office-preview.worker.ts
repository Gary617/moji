import { parsePptx, parseXlsx } from "./OfficePreview";

type WorkerRequest = { format: "pptx" | "xlsx"; bytes: ArrayBuffer };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    const { format, bytes } = event.data;
    // Some embedded WebViews expose Worker but do not provide DOMParser there.
    // Let the UI fall back to its main-thread parser instead of showing a
    // misleading preview error.
    if (typeof DOMParser === "undefined") {
      self.postMessage({ kind: "unsupported", reason: "DOMParser" });
      return;
    }
    const value = format === "pptx" ? parsePptx(new Uint8Array(bytes)) : parseXlsx(new Uint8Array(bytes));
    self.postMessage({ kind: format, value });
  } catch (cause) {
    self.postMessage({ kind: "error", message: cause instanceof Error ? cause.message : "Office 文件无法解析" });
  }
};

export {};
