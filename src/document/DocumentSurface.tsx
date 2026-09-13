import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export function DocumentSurface({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom(value => Math.max(50, Math.min(300, value + (event.deltaY < 0 ? 10 : -10))));
    };
    element.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => element.removeEventListener("wheel", wheel, true);
  }, []);
  return <div ref={root} className="document-surface has-content-zoom" style={{ "--document-zoom": zoom / 100 } as CSSProperties}>
    {children}
    <button type="button" className="document-zoom-reset" title="Ctrl + 滚轮缩放文档；点击恢复 100%" aria-label={`文档缩放 ${zoom}%，点击恢复原始大小`} onClick={() => setZoom(100)}>{zoom}%</button>
  </div>;
}
