import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FileWarning, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

import type { AnnotationAnchor } from "../ipc/document";
import { createPdfAnchor } from "./anchors";

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function textLayerSelection(container: HTMLElement): { start: number; end: number; quote: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const selectedRange = selection.getRangeAt(0);
  if (!container.contains(selectedRange.commonAncestorContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(selectedRange.startContainer, selectedRange.startOffset);
  const quote = selection.toString();
  if (!quote.trim()) return null;
  const start = before.toString().length;
  return { start, end: start + quote.length, quote };
}

function selectTextRange(container: HTMLElement, start: number, end: number): boolean {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.textContent?.length ?? 0;
    if (!startNode && start >= offset && start <= offset + length) {
      startNode = node;
      startOffset = start - offset;
    }
    if (end >= offset && end <= offset + length) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset += length;
  }
  if (!startNode || !endNode) return false;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  (startNode.parentElement ?? container).scrollIntoView({ block: "center" });
  return true;
}

interface PdfViewerProps {
  binaryContent: string | null;
  page: number;
  targetAnchor: AnnotationAnchor | null;
  onPageChange(page: number): void;
  onAnchorChange(anchor: AnnotationAnchor): void;
}

export function PdfViewer({ binaryContent, page, targetAnchor, onPageChange, onAnchorChange }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let task: any = null;
    const load = async () => {
      if (!binaryContent) {
        setState("error");
        return;
      }
      setState("loading");
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
        task = pdfjs.getDocument({ data: decodeBase64(binaryContent) });
        const pdf = await task.promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        if (page > pdf.numPages) onPageChange(pdf.numPages);
      } catch {
        if (!cancelled) setState("error");
      }
    };
    void load();
    return () => {
      cancelled = true;
      pdfRef.current = null;
      void task?.destroy();
    };
  }, [binaryContent]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: any = null;
    let textLayer: any = null;
    const render = async () => {
      const pdf = pdfRef.current;
      const canvas = canvasRef.current;
      const textContainer = textLayerRef.current;
      if (!pdf || !canvas || !textContainer || page < 1 || page > pdf.numPages) return;
      setState("loading");
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const pdfPage = await pdf.getPage(page);
        const viewport = pdfPage.getViewport({ scale: zoom });
        const context = canvas.getContext("2d");
        if (!context || cancelled) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textContainer.replaceChildren();
        textContainer.style.width = `${viewport.width}px`;
        textContainer.style.height = `${viewport.height}px`;
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
        const textContent = await pdfPage.getTextContent();
        textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (cancelled) return;
        setState("ready");
        if (targetAnchor?.page === page && targetAnchor.charStart !== null && targetAnchor.charEnd !== null) {
          selectTextRange(textContainer, targetAnchor.charStart, targetAnchor.charEnd);
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel?.();
    };
  }, [page, pageCount, targetAnchor, zoom]);

  if (state === "error") {
    return <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>PDF 无法在当前环境渲染</p><small>文件保持只读，可继续保存页码批注。</small></div>;
  }

  const goTo = (nextPage: number) => onPageChange(Math.max(1, Math.min(pageCount || 1, nextPage)));
  const publishSelection = () => onAnchorChange(createPdfAnchor(page, textLayerRef.current ? textLayerSelection(textLayerRef.current) : null));

  return <div className="pdf-viewer">
    <header className="viewer-toolbar">
      <div className="page-control">
        <button type="button" className="icon-button" aria-label="PDF 第一页" title="第一页" disabled={page <= 1} onClick={() => goTo(1)}><ChevronsLeft aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="PDF 上一页" title="上一页" disabled={page <= 1} onClick={() => goTo(page - 1)}><ChevronLeft aria-hidden="true" /></button>
        <label><span className="sr-only">PDF 页码</span><input aria-label="PDF 页码" type="number" min={1} max={pageCount || 1} value={page} onChange={(event) => goTo(Number(event.target.value))} /></label><span>/ {pageCount || "-"}</span>
        <button type="button" className="icon-button" aria-label="PDF 下一页" title="下一页" disabled={!pageCount || page >= pageCount} onClick={() => goTo(page + 1)}><ChevronRight aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="PDF 最后一页" title="最后一页" disabled={!pageCount || page >= pageCount} onClick={() => goTo(pageCount)}><ChevronsRight aria-hidden="true" /></button>
      </div>
      <div><button type="button" className="icon-button" aria-label="缩小 PDF" title="缩小" disabled={zoom <= 0.6} onClick={() => setZoom((value) => Math.max(0.6, value - 0.15))}><ZoomOut aria-hidden="true" /></button><span className="zoom-label">{Math.round(zoom * 100)}%</span><button type="button" className="icon-button" aria-label="放大 PDF" title="放大" disabled={zoom >= 2} onClick={() => setZoom((value) => Math.min(2, value + 0.15))}><ZoomIn aria-hidden="true" /></button></div>
    </header>
    <div className="pdf-canvas-wrap">{state === "loading" && <div className="viewer-loading">正在渲染第 {page} 页</div>}<div className="pdf-page" onMouseUp={publishSelection}><canvas ref={canvasRef} aria-label={`PDF 第 ${page} 页`} /><div ref={textLayerRef} className="textLayer pdf-text-layer" /></div></div>
  </div>;
}
