import { useEffect, useRef, useState } from "react";

import type { AnnotationAnchor } from "../ipc/document";
import type { DocumentFormat } from "../ipc/library";
import { createTextAnchor, resolveTextAnchor, type TextAnchorResolution } from "./anchors";

interface TextViewerProps {
  content: string;
  format: DocumentFormat;
  readOnly: boolean;
  targetAnchor: AnnotationAnchor | null;
  aiHighlight?: AnnotationAnchor | null;
  onClearAiHighlight?(): void;
  onChange(content: string): void;
  onAnchorChange(anchor: AnnotationAnchor): void;
}

function HighlightedText({ content, start, end }: { content: string; start: number; end: number }) {
  return <>{content.slice(0, start)}<mark>{content.slice(start, end)}</mark>{content.slice(end)}</>;
}

function normalizedRange(content: string, query: string): { start: number; end: number } | null {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const pattern = new RegExp(parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  const match = pattern.exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

export function TextViewer({ content, format, readOnly, targetAnchor, aiHighlight = null, onClearAiHighlight, onChange, onAnchorChange }: TextViewerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const [location, setLocation] = useState<TextAnchorResolution | null>(null);
  const resolvedAiHighlight = aiHighlight ? resolveTextAnchor(content, format, aiHighlight) : null;
  // The saved document may normalize line endings or Markdown separators after
  // an AI write. Fall back to the quote itself so a valid change is still
  // visible even when its original character offsets moved.
  const aiQuoteIndex = aiHighlight?.quote ? content.indexOf(aiHighlight.quote) : -1;
  const aiNormalizedRange = aiHighlight?.quote && aiQuoteIndex < 0 ? normalizedRange(content, aiHighlight.quote) : null;
  const aiHighlightLocation = resolvedAiHighlight?.start !== null && resolvedAiHighlight?.end !== null
    ? resolvedAiHighlight
    : aiQuoteIndex >= 0
      ? { status: "quote-fallback" as const, start: aiQuoteIndex, end: aiQuoteIndex + (aiHighlight?.quote?.length ?? 0), paragraph: null }
      : aiNormalizedRange
        ? { status: "quote-fallback" as const, ...aiNormalizedRange, paragraph: null }
      : resolvedAiHighlight;
  const aiHighlightRange = aiHighlightLocation && aiHighlightLocation.start !== null && aiHighlightLocation.end !== null
    ? { start: aiHighlightLocation.start, end: aiHighlightLocation.end }
    : null;

  useEffect(() => {
    if (!targetAnchor || !textareaRef.current) return;
    const resolved = resolveTextAnchor(content, format, targetAnchor);
    setLocation(resolved);
    if (resolved.start === null || resolved.end === null) return;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(resolved.start, resolved.end);
  }, [format, targetAnchor]);

  useEffect(() => {
    if (!aiHighlightLocation || aiHighlightLocation.start === null || !highlightRef.current) return;
    highlightRef.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [aiHighlightLocation?.end, aiHighlightLocation?.start]);

  const publishSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    onAnchorChange(createTextAnchor(content, format, textarea.selectionStart, textarea.selectionEnd));
  };

  return (
    <div className="text-viewer">
      {location?.status === "quote-fallback" && <div className="anchor-status">原位置已变化，已通过唯一引用文本定位</div>}
      {location?.status === "unresolved" && <div className="anchor-status anchor-status--error">正文已变化，无法可靠定位此批注</div>}
      {readOnly && aiHighlightRange
        ? <div className="ai-text-change-preview" aria-label="AI 修改高亮">
          <div className="ai-text-change-preview__bar"><span>本次 AI 修改已标注</span>{onClearAiHighlight && <button type="button" onClick={onClearAiHighlight}>清除标记</button>}</div>
          <pre ref={highlightRef} tabIndex={-1}><HighlightedText content={content} start={aiHighlightRange.start} end={aiHighlightRange.end} /></pre>
        </div>
        : <textarea ref={textareaRef} aria-label="文档正文" value={content} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} onSelect={publishSelection} />}
    </div>
  );
}
