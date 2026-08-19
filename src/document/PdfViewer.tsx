import { AlertTriangle, FileWarning, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function PdfViewer({ binaryContent }: { binaryContent: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let task: { destroy(): void; promise: Promise<any> } | null = null;
    const render = async () => {
      if (!binaryContent || !canvasRef.current) {
        setState("error");
        return;
      }
      setState("loading");
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
        task = pdfjs.getDocument({ data: decodeBase64(binaryContent) });
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!cancelled) setState("ready");
        pdf.destroy();
      } catch {
        if (!cancelled) setState("error");
      }
    };
    void render();
    return () => { cancelled = true; task?.destroy(); };
  }, [binaryContent, zoom]);

  if (state === "error") {
    return <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>PDF 无法在当前环境渲染</p><small>文件保持只读，可继续保存批注。</small></div>;
  }
  return <div className="pdf-viewer"><header className="viewer-toolbar"><span>第 1 页</span><div><button type="button" className="icon-button" aria-label="缩小 PDF" title="缩小" disabled={zoom <= 0.7} onClick={() => setZoom((value) => Math.max(0.7, value - 0.15))}><ZoomOut aria-hidden="true" /></button><button type="button" className="icon-button" aria-label="放大 PDF" title="放大" disabled={zoom >= 1.6} onClick={() => setZoom((value) => Math.min(1.6, value + 0.15))}><ZoomIn aria-hidden="true" /></button></div></header>{state === "loading" && <div className="viewer-loading"><AlertTriangle aria-hidden="true" /><span>正在渲染 PDF</span></div>}<div className="pdf-canvas-wrap"><canvas ref={canvasRef} aria-label="PDF 第 1 页" /></div></div>;
}
