import { FileWarning, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState } from "react";

interface ImageViewerProps {
  binaryContent: string | null;
  mediaType: string | null;
  name: string;
}

export function ImageViewer({ binaryContent, mediaType, name }: ImageViewerProps) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    setState(binaryContent && mediaType ? "loading" : "error");
    setZoom(1);
    setRotation(0);
  }, [binaryContent, mediaType]);

  if (!binaryContent || !mediaType || state === "error") {
    return <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>图片无法解码</p><small>原文件保持只读且不会被修改。</small></div>;
  }

  return (
    <div className="image-viewer">
      <header className="viewer-toolbar"><span>{state === "loading" ? "正在加载图片" : name}</span><div>
        <button type="button" className="icon-button" aria-label="缩小图片" title="缩小" disabled={zoom <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}><ZoomOut aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="按原始大小显示图片" title="原始大小" onClick={() => setZoom(1)}><Maximize2 aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="放大图片" title="放大" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.25))}><ZoomIn aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="顺时针旋转图片" title="旋转" onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw aria-hidden="true" /></button>
      </div></header>
      <div className="image-stage">{state === "loading" && <div className="viewer-loading">正在解码图片</div>}<img src={`data:${mediaType};base64,${binaryContent}`} alt={name} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} onLoad={() => setState("ready")} onError={() => setState("error")} /></div>
    </div>
  );
}

