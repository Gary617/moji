import { FileWarning, RefreshCw } from "lucide-react";
import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";
import type { DocxInsertedImage, DocxParagraph, DocxRun, DocxTable } from "./docxBasic";

interface DocxPreviewProps {
  binaryContent: string | null;
  /** A newly inserted AI phrase that remains visibly marked after saving. */
  aiHighlightText?: string | null;
  aiHighlightFocusKey?: number;
  /** Enables native editing on rendered body paragraphs and table cells. */
  editable?: boolean;
  /** Changes to the model that should cause the rendered DOM to be rebuilt. */
  editableRevision?: number;
  editableModel?: { paragraphs: DocxParagraph[]; tables: DocxTable[]; images?: DocxInsertedImage[] };
  onEditableReady?(root: HTMLElement): void;
  onEditableInput?(event: DocxEditableEvent): void;
  onEditableSelection?(paragraphIndex: number, root: HTMLElement): void;
  onEditableKeyDown?(paragraphIndex: number, event: KeyboardEvent, root: HTMLElement): void;
  onEditableImageSelect?(imageId: string): void;
  onEditableImageChange?(imageId: string, patch: Partial<Pick<DocxInsertedImage, "widthPx" | "heightPx" | "xPx" | "yPx">>): void;
}

export type DocxEditableEvent =
  | { kind: "paragraph"; paragraphIndex: number; runs: DocxRun[]; root: HTMLElement }
  | { kind: "table-cell"; tableIndex: number; rowIndex: number; cellIndex: number; text: string };

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const DOCX_SECTION_SELECTOR = "section.moji-docx";
const DOCX_TABLE_SELECTOR = `${DOCX_SECTION_SELECTOR} table`;

function numericStyleValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Keeps a source table's column proportions while making tables wider than
 * the rendered page fit inside the page. The renderer intentionally preserves
 * fixed OOXML widths, so this pass is needed for narrow application panes.
 */
export function constrainOverflowingDocxTables(root: HTMLElement): number {
  let constrainedCount = 0;
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>(DOCX_TABLE_SELECTOR));

  tables.forEach((table) => {
    const section = table.closest<HTMLElement>(DOCX_SECTION_SELECTOR);
    if (!section) return;

    const sectionStyle = window.getComputedStyle(section);
    const sectionWidth = section.getBoundingClientRect().width || section.clientWidth;
    const availableWidth = sectionWidth
      - numericStyleValue(sectionStyle.paddingLeft)
      - numericStyleValue(sectionStyle.paddingRight);
    if (availableWidth <= 0) return;

    const tableWidth = table.getBoundingClientRect().width || table.scrollWidth;
    const cellsOverflow = Array.from(table.querySelectorAll<HTMLTableCellElement>("td, th"))
      .some((cell) => cell.scrollWidth > cell.clientWidth + 1);
    const wasAdjusted = table.dataset.mojiOverflowAdjusted === "true";
    const isOverflowing = wasAdjusted || tableWidth > availableWidth + 1 || cellsOverflow;
    table.classList.toggle("moji-docx-table-overflowing", isOverflowing);
    if (!isOverflowing) return;

    const columns = Array.from(table.querySelectorAll<HTMLElement>(":scope > colgroup > col"));
    const columnWidths = columns.map((column) => column.getBoundingClientRect().width);
    const totalColumnWidth = columnWidths.reduce((sum, width) => sum + width, 0);
    if (columns.length && totalColumnWidth > 0) {
      columns.forEach((column, index) => {
        column.style.setProperty("width", `${(columnWidths[index] / totalColumnWidth) * 100}%`, "important");
      });
    }

    table.style.setProperty("width", "100%", "important");
    table.style.setProperty("max-width", "100%", "important");
    table.style.setProperty("table-layout", "fixed", "important");
    table.dataset.mojiOverflowAdjusted = "true";
    constrainedCount += 1;
  });

  return constrainedCount;
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function renderedTextSegments(root: HTMLElement): Array<{ text: string; runId: string | null }> {
  const segments: Array<{ text: string; runId: string | null }> = [];
  const visit = (node: Node, inheritedRunId: string | null) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (text) segments.push({ text, runId: inheritedRunId });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.tagName === "BR") {
      segments.push({ text: "\n", runId: inheritedRunId });
      return;
    }
    const runId = element.dataset.mojiRunId ?? inheritedRunId;
    Array.from(node.childNodes).forEach((child) => visit(child, runId));
  };
  Array.from(root.childNodes).forEach((child) => visit(child, null));
  return segments;
}

function readRenderedRuns(root: HTMLElement, previousRuns: DocxRun[]): DocxRun[] {
  const templates = new Map(previousRuns.map((run) => [run.id, run]));
  const segments = renderedTextSegments(root).reduce<Array<{ text: string; runId: string | null }>>((merged, segment) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.runId === segment.runId) previous.text += segment.text;
    else merged.push({ ...segment });
    return merged;
  }, []);
  if (!segments.length) {
    const fallback = previousRuns[0];
    return fallback ? [{ ...fallback, text: "" }] : [];
  }
  const used = new Set<string>();
  return segments.map((segment, index) => {
    const template = templates.get(segment.runId ?? "") ?? previousRuns[index] ?? previousRuns[previousRuns.length - 1];
    if (!template) return { id: `rendered-run-${index}`, text: segment.text, bold: false, italic: false, underline: false, fontSize: null, color: null, fontFamily: null };
    const id = segment.runId && !used.has(segment.runId) ? segment.runId : `${template.id}-rendered-${index}`;
    used.add(id);
    return { ...template, id, text: segment.text };
  });
}

function markRenderedRuns(paragraph: HTMLElement, runs: DocxRun[]): void {
  const leaves = Array.from(paragraph.querySelectorAll<HTMLSpanElement>("span")).filter((span) => !span.querySelector("span") && Boolean(span.textContent));
  let runIndex = 0;
  let runOffset = 0;
  leaves.forEach((span) => {
    while (runIndex < runs.length && runOffset >= runs[runIndex].text.length) {
      runIndex += 1;
      runOffset = 0;
    }
    if (runIndex >= runs.length) return;
    span.dataset.mojiRunId = runs[runIndex].id;
    runOffset += span.textContent?.length ?? 0;
  });
}

function directParagraphs(root: HTMLElement): HTMLElement[] {
  const articleParagraphs = Array.from(root.querySelectorAll<HTMLElement>("section.moji-docx p")).filter((paragraph) => {
    const section = paragraph.closest("section.moji-docx");
    const article = paragraph.closest("article");
    return Boolean(section && article && article.closest("section.moji-docx") === section && !paragraph.closest("table"));
  });
  // docx-preview normally renders body paragraphs below an article, but
  // text boxes and documents produced by other Office writers can omit that
  // wrapper. Keep those paragraphs editable instead of silently falling back
  // to a read-only-looking page.
  if (articleParagraphs.length > 0) return articleParagraphs;
  return Array.from(root.querySelectorAll<HTMLElement>("section.moji-docx p")).filter((paragraph) => !paragraph.closest("table"));
}

function aiTextBlocks(root: HTMLElement): HTMLElement[] {
  const sections = Array.from(root.querySelectorAll<HTMLElement>(DOCX_SECTION_SELECTOR));
  const blocks: HTMLElement[] = [];
  sections.forEach((section) => {
    section.querySelectorAll<HTMLElement>("p").forEach((paragraph) => {
      if (!paragraph.closest("header, footer")) blocks.push(paragraph);
    });
    // Some Office renderers omit <p> inside a table cell. Keep those cells
    // locatable without treating an unrelated first paragraph as a fallback.
    section.querySelectorAll<HTMLElement>("td, th").forEach((cell) => {
      if (!cell.querySelector("p") && !cell.closest("header, footer")) blocks.push(cell);
    });
  });
  return blocks;
}

function directTables(root: HTMLElement): HTMLTableElement[] {
  return Array.from(root.querySelectorAll<HTMLTableElement>("section.moji-docx table")).filter((table) => !table.parentElement?.closest("table"));
}

function locateTextRange(root: HTMLElement, text: string): Range | null {
  const index = (root.textContent ?? "").indexOf(text);
  if (index < 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const end = cursor + node.data.length;
    if (!startNode && index >= cursor && index <= end) {
      startNode = node;
      startOffset = index - cursor;
    }
    const targetEnd = index + text.length;
    if (startNode && targetEnd >= cursor && targetEnd <= end) {
      endNode = node;
      endOffset = targetEnd - cursor;
      break;
    }
    cursor = end;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function normalizedQueryMatch(value: string, query: string): string | null {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&"));
  return value.match(new RegExp(escaped.join("\\s+")))?.[0] ?? null;
}

export function markAiEdit(root: HTMLElement, text: string | null | undefined, focus: boolean): () => void {
  const query = text?.trim();
  if (!query) return () => undefined;
  const blocks = aiTextBlocks(root);
  const target = blocks.find((block) => (block.textContent ?? "").includes(query));
  const normalizedTarget = target ?? blocks.find((block) => normalizedQueryMatch(block.textContent ?? "", query));
  if (!normalizedTarget) return () => undefined;
  const exactRange = locateTextRange(normalizedTarget, query);
  const normalizedMatch = exactRange ? null : normalizedQueryMatch(normalizedTarget.textContent ?? "", query);
  const range = exactRange ?? (normalizedMatch ? locateTextRange(normalizedTarget, normalizedMatch) : null);
  const highlights = typeof CSS !== "undefined"
    ? (CSS as typeof CSS & { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }).highlights
    : undefined;
  const HighlightConstructor = (window as Window & { Highlight?: new (range: Range) => unknown }).Highlight;
  // Keep a visible paragraph-level marker in every WebView. Some Chromium
  // builds expose CSS.highlights without painting the custom highlight,
  // which previously made a successful edit appear unmarked.
  normalizedTarget.classList.add("moji-docx-ai-changed-paragraph");
  if (range && highlights && HighlightConstructor) {
    highlights.set("moji-ai-change", new HighlightConstructor(range));
  }
  if (focus) normalizedTarget.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return () => {
    highlights?.delete("moji-ai-change");
    normalizedTarget.classList.remove("moji-docx-ai-changed-paragraph");
  };
}

function cellText(cell: HTMLTableCellElement): string {
  const paragraphs = Array.from(cell.querySelectorAll<HTMLElement>(":scope > p"));
  return paragraphs.length ? paragraphs.map((paragraph) => paragraph.textContent ?? "").join("\n") : (cell.textContent ?? "");
}

function decorateEditableDocument(
  root: HTMLElement,
  model: { paragraphs: DocxParagraph[]; tables: DocxTable[] },
  onInput: (event: DocxEditableEvent) => void,
  onSelection?: (paragraphIndex: number, root: HTMLElement) => void,
  onKeyDown?: (paragraphIndex: number, event: KeyboardEvent, root: HTMLElement) => void,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const paragraphs = directParagraphs(root);
  const editableArticles = Array.from(root.querySelectorAll<HTMLElement>("section.moji-docx article"));
  editableArticles.forEach((article) => {
    article.contentEditable = "true";
    article.setAttribute("contenteditable", "true");
    article.classList.add("moji-docx-editable-surface");
    cleanups.push(() => {
      article.removeAttribute("contenteditable");
      article.classList.remove("moji-docx-editable-surface");
    });
  });

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const source = model.paragraphs[paragraphIndex];
    if (!source) return;
    paragraph.dataset.mojiParagraphIndex = String(paragraphIndex);
    paragraph.dataset.mojiInputBound = "true";
    markRenderedRuns(paragraph, source.runs);
    paragraph.contentEditable = "true";
    paragraph.setAttribute("contenteditable", "true");
    paragraph.classList.add("moji-docx-editable-paragraph");
    const handleInput = () => onInput({ kind: "paragraph", paragraphIndex, runs: readRenderedRuns(paragraph, source.runs), root: paragraph });
    const handleSelection = () => onSelection?.(paragraphIndex, paragraph);
    const handleKeyDown = (event: KeyboardEvent) => onKeyDown?.(paragraphIndex, event, paragraph);
    paragraph.addEventListener("input", handleInput);
    paragraph.addEventListener("focus", handleSelection);
    paragraph.addEventListener("select", handleSelection);
    paragraph.addEventListener("mouseup", handleSelection);
    paragraph.addEventListener("keydown", handleKeyDown);
    cleanups.push(() => {
      paragraph.removeEventListener("input", handleInput);
      paragraph.removeEventListener("focus", handleSelection);
      paragraph.removeEventListener("select", handleSelection);
      paragraph.removeEventListener("mouseup", handleSelection);
      paragraph.removeEventListener("keydown", handleKeyDown);
      paragraph.removeAttribute("contenteditable");
      paragraph.classList.remove("moji-docx-editable-paragraph");
      delete paragraph.dataset.mojiInputBound;
      delete paragraph.dataset.mojiParagraphIndex;
    });
  });

  // Keep a delegated input path for paragraphs that are editable through an
  // article/container but were not decorated individually by docx-preview's
  // exact DOM shape. This is also what makes text boxes editable in-place.
  const handleDelegatedInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const paragraph = target.closest<HTMLElement>("section.moji-docx p");
    if (!paragraph || paragraph.closest("table") || paragraph.dataset.mojiInputBound === "true") return;
    const paragraphIndex = paragraphs.indexOf(paragraph);
    const source = model.paragraphs[paragraphIndex];
    if (paragraphIndex < 0 || !source) return;
    onInput({ kind: "paragraph", paragraphIndex, runs: readRenderedRuns(paragraph, source.runs), root: paragraph });
  };
  root.addEventListener("input", handleDelegatedInput);
  cleanups.push(() => root.removeEventListener("input", handleDelegatedInput));

  directTables(root).forEach((table, tableIndex) => {
    const sourceTable = model.tables[tableIndex];
    if (!sourceTable) return;
    Array.from(table.rows).forEach((row, rowIndex) => {
      Array.from(row.cells).forEach((cell, cellIndex) => {
        if (!sourceTable.rows[rowIndex]?.[cellIndex] || cell.querySelector("img,svg,canvas")) return;
        cell.contentEditable = "true";
        cell.setAttribute("contenteditable", "true");
        cell.classList.add("moji-docx-editable-cell");
        const handleInput = () => onInput({ kind: "table-cell", tableIndex, rowIndex, cellIndex, text: cellText(cell) });
        cell.addEventListener("input", handleInput);
        cleanups.push(() => {
          cell.removeEventListener("input", handleInput);
          cell.removeAttribute("contenteditable");
          cell.classList.remove("moji-docx-editable-cell");
        });
      });
    });
  });
  return cleanups;
}

function decorateEditableImages(
  root: HTMLElement,
  images: DocxInsertedImage[],
  editable: boolean,
  onSelect?: (imageId: string) => void,
  onChange?: (imageId: string, patch: Partial<Pick<DocxInsertedImage, "widthPx" | "heightPx" | "xPx" | "yPx">>) => void,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const imageById = new Map(images.map((image) => [image.id, image]));
  root.querySelectorAll<HTMLImageElement>('img[alt^="moji-image:"]').forEach((image) => {
    const imageId = (image.alt.split(":")[1] ?? "").trim();
    const model = imageById.get(imageId);
    if (!model) return;
    image.dataset.mojiImageId = imageId;
    image.classList.add("moji-inserted-image");
    const select = () => onSelect?.(imageId);
    const pointerDown = (event: PointerEvent) => {
      if (!onChange) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect?.(imageId);
      image.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = model.widthPx;
      const startHeight = model.heightPx;
      const startLeft = model.xPx;
      const startTop = model.yPx;
      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (event.shiftKey) {
          const width = Math.max(32, startWidth + dx);
          const ratio = startHeight / Math.max(1, startWidth);
          image.style.width = `${width}px`;
          image.style.height = `${Math.max(32, width * ratio)}px`;
        } else {
          image.style.transform = `translate(${dx}px, ${dy}px)`;
        }
      };
      const up = (upEvent: PointerEvent) => {
        const dx = upEvent.clientX - startX;
        const dy = upEvent.clientY - startY;
        image.style.transform = "";
        image.style.width = "";
        image.style.height = "";
        if (event.shiftKey) {
          const width = Math.max(32, startWidth + dx);
          onChange(imageId, { widthPx: width, heightPx: Math.max(32, width * startHeight / Math.max(1, startWidth)) });
        } else if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          onChange(imageId, { xPx: Math.max(0, startLeft + dx), yPx: Math.max(0, startTop + dy) });
        }
        image.releasePointerCapture?.(upEvent.pointerId);
        image.removeEventListener("pointermove", move);
        image.removeEventListener("pointerup", up);
        image.removeEventListener("pointercancel", up);
      };
      image.addEventListener("pointermove", move);
      image.addEventListener("pointerup", up);
      image.addEventListener("pointercancel", up);
    };
    image.addEventListener("click", select);
    if (editable) image.addEventListener("pointerdown", pointerDown);
    cleanups.push(() => {
      image.removeEventListener("click", select);
      image.removeEventListener("pointerdown", pointerDown);
      image.classList.remove("moji-inserted-image");
      delete image.dataset.mojiImageId;
    });
  });
  return cleanups;
}

export function DocxPreview({ binaryContent, aiHighlightText = null, aiHighlightFocusKey = 0, editable = false, editableRevision = 0, editableModel, onEditableReady, onEditableInput, onEditableSelection, onEditableKeyDown, onEditableImageSelect, onEditableImageChange }: DocxPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const renderIdRef = useRef(0);
  const modelRef = useRef(editableModel);
  const onReadyRef = useRef(onEditableReady);
  const onInputRef = useRef(onEditableInput);
  const onSelectionRef = useRef(onEditableSelection);
  const onKeyDownRef = useRef(onEditableKeyDown);
  const onImageSelectRef = useRef(onEditableImageSelect);
  const onImageChangeRef = useRef(onEditableImageChange);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  modelRef.current = editableModel;
  onReadyRef.current = onEditableReady;
  onInputRef.current = onEditableInput;
  onSelectionRef.current = onEditableSelection;
  onKeyDownRef.current = onEditableKeyDown;
  onImageSelectRef.current = onEditableImageSelect;
  onImageChangeRef.current = onEditableImageChange;

  useEffect(() => {
    const body = bodyRef.current;
    const style = styleRef.current;
    const renderId = renderIdRef.current + 1;
    renderIdRef.current = renderId;
    if (!body || !style) return;

    body.replaceChildren();
    style.replaceChildren();
    if (!binaryContent) {
      setState({ kind: "error", message: "DOCX 没有可用的二进制内容" });
      return;
    }

    let cancelled = false;
    let frame: number | null = null;
    let delayedPass: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let editableCleanups: Array<() => void> = [];
    let aiHighlightCleanup: (() => void) | null = null;
    setState({ kind: "loading" });
    const render = async () => {
      try {
        await renderAsync(decodeBase64(binaryContent), body, style, {
          className: "moji-docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderAltChunks: true,
          experimental: true,
          useBase64URL: true,
        });
        if (cancelled || renderIdRef.current !== renderId) return;

        // Images and browser fonts can change table metrics after renderAsync
        // resolves. Run once immediately and once after the first layout pass.
        constrainOverflowingDocxTables(body);
        frame = window.requestAnimationFrame(() => constrainOverflowingDocxTables(body));
        delayedPass = window.setTimeout(() => constrainOverflowingDocxTables(body), 120);
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => constrainOverflowingDocxTables(body));
          body.querySelectorAll<HTMLElement>(DOCX_SECTION_SELECTOR).forEach((section) => resizeObserver?.observe(section));
        }
        if (editable && modelRef.current) {
          editableCleanups = decorateEditableDocument(body, modelRef.current, (event) => onInputRef.current?.(event), (paragraphIndex, paragraph) => onSelectionRef.current?.(paragraphIndex, paragraph), (paragraphIndex, event, paragraph) => onKeyDownRef.current?.(paragraphIndex, event, paragraph));
          editableCleanups.push(...decorateEditableImages(body, modelRef.current.images ?? [], true, (imageId) => onImageSelectRef.current?.(imageId), (imageId, patch) => onImageChangeRef.current?.(imageId, patch)));
        } else if (modelRef.current?.images?.length) {
          editableCleanups = decorateEditableImages(body, modelRef.current.images, false, (imageId) => onImageSelectRef.current?.(imageId));
        }
        aiHighlightCleanup = markAiEdit(body, aiHighlightText, aiHighlightFocusKey > 0);
        onReadyRef.current?.(body);
        setState({ kind: "ready" });
      } catch (cause) {
        if (cancelled || renderIdRef.current !== renderId) return;
        body.replaceChildren();
        style.replaceChildren();
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "DOCX 完整预览无法生成" });
      }
    };
    void render();
    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (delayedPass !== null) window.clearTimeout(delayedPass);
      resizeObserver?.disconnect();
      editableCleanups.forEach((cleanup) => cleanup());
      aiHighlightCleanup?.();
    };
  }, [aiHighlightFocusKey, aiHighlightText, binaryContent, editable, editableRevision]);

  return (
    <div className="docx-preview-viewer" aria-label="DOCX 完整预览">
      {state.kind === "loading" && <div className="docx-preview-status" role="status" aria-live="polite"><RefreshCw className="is-spinning" aria-hidden="true" /><span>正在加载预览</span></div>}
      {state.kind === "error" && <div className="docx-preview-status" role="alert"><FileWarning aria-hidden="true" /><span>预览失败：{state.message}</span></div>}
      <div ref={bodyRef} className="docx-preview-scroll" />
      <div ref={styleRef} className="docx-preview-style-host" aria-hidden="true" />
    </div>
  );
}
