import { Bold, ChevronLeft, ChevronRight, FileWarning, ImagePlus, Italic, Save, Underline, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";

import type { DocumentMode } from "../ipc/document";
import { DocxPreview, type DocxEditableEvent } from "./DocxPreview";
import {
  encodeDocxBasic,
  addDocxImage,
  parseDocxBasic,
  type DocxBasicDocument,
  type DocxParagraph,
  type DocxRun,
  type DocxTable,
  updateDocxImage,
} from "./docxBasic";

interface DocxViewerProps {
  binaryContent: string | null;
  mode: DocumentMode;
  aiHighlightText?: string | null;
  aiHighlightFocusKey?: number;
  onArtifact(binaryContent: string): void;
}

type StyleKey = "bold" | "italic" | "underline";
type RunStylePatch = Partial<Pick<DocxRun, "bold" | "italic" | "underline" | "fontSize" | "color" | "fontFamily">>;

interface FontOption {
  value: string;
  label: string;
  group: "中文字体" | "西文字体" | "等宽字体";
}

const COMMON_FONT_OPTIONS: FontOption[] = [
  { value: "Microsoft YaHei", label: "微软雅黑", group: "中文字体" },
  { value: "Microsoft YaHei UI", label: "微软雅黑 UI", group: "中文字体" },
  { value: "SimSun", label: "宋体", group: "中文字体" },
  { value: "NSimSun", label: "新宋体", group: "中文字体" },
  { value: "FangSong", label: "仿宋", group: "中文字体" },
  { value: "KaiTi", label: "楷体", group: "中文字体" },
  { value: "DengXian", label: "等线", group: "中文字体" },
  { value: "Arial", label: "Arial", group: "西文字体" },
  { value: "Calibri", label: "Calibri", group: "西文字体" },
  { value: "Cambria", label: "Cambria", group: "西文字体" },
  { value: "Times New Roman", label: "Times New Roman", group: "西文字体" },
  { value: "Georgia", label: "Georgia", group: "西文字体" },
  { value: "Verdana", label: "Verdana", group: "西文字体" },
  { value: "Trebuchet MS", label: "Trebuchet MS", group: "西文字体" },
  { value: "Segoe UI", label: "Segoe UI", group: "西文字体" },
  { value: "Segoe UI Symbol", label: "Segoe UI Symbol", group: "西文字体" },
  { value: "Consolas", label: "Consolas", group: "等宽字体" },
  { value: "Cascadia Mono", label: "Cascadia Mono", group: "等宽字体" },
  { value: "Courier New", label: "Courier New", group: "等宽字体" },
  { value: "Source Code Pro", label: "Source Code Pro", group: "等宽字体" },
];

const COMMON_FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72];
const DOCX_NOTICE_STORAGE_KEY = "moji.docx.compatibility-notice.dismissed.v2";

function availableFontOptions(): FontOption[] {
  if (typeof document === "undefined" || !document.fonts || typeof document.fonts.check !== "function") {
    return COMMON_FONT_OPTIONS;
  }
  try {
    const detected = COMMON_FONT_OPTIONS.filter((font) => document.fonts.check(`12px "${font.value}"`, "墨集 Aa"));
    // A WebView may report false until its font cache is ready. Keep the
    // complete curated list instead of leaving the toolbar with no choices.
    return detected.length >= 2 ? detected : COMMON_FONT_OPTIONS;
  } catch {
    return COMMON_FONT_OPTIONS;
  }
}

function parseFontSize(value: string): number | null {
  if (!value.trim()) return null;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1 || size > 200) return null;
  return Math.round(size * 2) / 2;
}

function formatFontSize(size: number | null): string {
  return size === null ? "" : String(size);
}

interface TextSelection {
  paragraphId: string;
  anchor: number;
  focus: number;
}

interface ParagraphEditorProps {
  paragraph: DocxParagraph;
  readOnly: boolean;
  paragraphRefs: MutableRefObject<Map<string, HTMLElement>>;
  onFocus(paragraph: DocxParagraph, root: HTMLElement): void;
  onSelect(paragraph: DocxParagraph, root: HTMLElement): void;
  onMouseUp(paragraph: DocxParagraph, root: HTMLElement): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>, paragraph: DocxParagraph): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onBlur(): void;
  onInput(paragraph: DocxParagraph, root: HTMLElement): void;
}

interface TableCellEditorProps {
  cell: DocxTable["rows"][number][number];
  ariaLabel: string;
  onInput(text: string): void;
  onBlur(): void;
}

const TableCellEditor = memo(function TableCellEditor({ cell, ariaLabel, onInput, onBlur }: TableCellEditorProps) {
  return <div
    contentEditable
    suppressContentEditableWarning
    aria-label={ariaLabel}
    onInput={(event) => onInput(event.currentTarget.textContent ?? "")}
    onBlur={onBlur}
  >{cell.text}</div>;
}, (previous, next) => previous.cell === next.cell && previous.ariaLabel === next.ariaLabel);

/**
 * A paragraph is deliberately isolated from the surrounding toolbar state.
 * React must not reconcile contentEditable children while the browser owns a
 * caret or an IME composition range, otherwise deleted/typed text is replaced
 * by the previous model snapshot and the caret jumps to the beginning.
 */
const ParagraphEditor = memo(function ParagraphEditor({
  paragraph,
  readOnly,
  paragraphRefs,
  onFocus,
  onSelect,
  onMouseUp,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onInput,
}: ParagraphEditorProps) {
  return <p
    ref={(node) => { if (node) paragraphRefs.current.set(paragraph.id, node); else paragraphRefs.current.delete(paragraph.id); }}
    contentEditable={!readOnly}
    suppressContentEditableWarning
    onFocus={(event) => onFocus(paragraph, event.currentTarget)}
    onSelect={(event) => onSelect(paragraph, event.currentTarget)}
    onMouseUp={(event) => onMouseUp(paragraph, event.currentTarget)}
    onKeyDown={(event) => onKeyDown(event, paragraph)}
    onCompositionStart={onCompositionStart}
    onCompositionEnd={onCompositionEnd}
    onBlur={onBlur}
    onInput={(event) => onInput(paragraph, event.currentTarget)}
  >
    {paragraph.runs.length === 0 && <span className="docx-empty-run" aria-hidden="true"> </span>}
    {paragraph.runs.map((run) => <span
      key={run.id}
      className="docx-run"
      data-run-id={run.id}
      style={{ fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? "italic" : undefined, textDecoration: run.underline ? "underline" : undefined, fontSize: run.fontSize ? `${run.fontSize}pt` : undefined, color: run.color ?? undefined, fontFamily: run.fontFamily ?? undefined }}
    >{run.text}</span>)}
  </p>;
}, (previous, next) => previous.paragraph === next.paragraph && previous.readOnly === next.readOnly);

let generatedId = 0;

function uniqueId(prefix: string): string {
  generatedId += 1;
  return `${prefix}-${Date.now()}-${generatedId}`;
}

function emptyRun(id: string): DocxRun {
  return { id, text: "", bold: false, italic: false, underline: false, fontSize: null, color: null, fontFamily: null };
}

function paragraphLength(paragraph: DocxParagraph): number {
  return paragraph.runs.reduce((length, run) => length + run.text.length, 0);
}

function runAtOffset(runs: DocxRun[], offset: number): DocxRun | null {
  if (!runs.length) return null;
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (offset <= end || run === runs[runs.length - 1]) return run;
    cursor = end;
  }
  return runs[runs.length - 1] ?? null;
}

function ensureRuns(runs: DocxRun[], fallbackId = uniqueId("run-empty")): DocxRun[] {
  return runs.length ? runs : [emptyRun(fallbackId)];
}

function splitRunsAtOffset(runs: DocxRun[], rawOffset: number): [DocxRun[], DocxRun[]] {
  const offset = Math.max(0, Math.min(rawOffset, runs.reduce((length, run) => length + run.text.length, 0)));
  if (offset === 0) return [[], runs.map((run) => ({ ...run }))];
  const total = runs.reduce((length, run) => length + run.text.length, 0);
  if (offset >= total) return [runs.map((run) => ({ ...run })), []];

  const before: DocxRun[] = [];
  const after: DocxRun[] = [];
  let cursor = 0;
  runs.forEach((run) => {
    const end = cursor + run.text.length;
    if (end <= offset) {
      before.push({ ...run });
    } else if (cursor >= offset) {
      after.push({ ...run });
    } else {
      const local = offset - cursor;
      before.push({ ...run, text: run.text.slice(0, local) });
      after.push({ ...run, id: uniqueId(`${run.id}-tail`), text: run.text.slice(local) });
    }
    cursor = end;
  });
  return [before, after];
}

function updateRunsInRange(runs: DocxRun[], start: number, end: number, patch: RunStylePatch): DocxRun[] {
  const [before, remainder] = splitRunsAtOffset(runs, start);
  const [middle, after] = splitRunsAtOffset(remainder, Math.max(0, end - start));
  return ensureRuns([...before, ...middle.map((run) => ({ ...run, ...patch })), ...after]);
}

function pointOffset(root: Node, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

function captureSelection(root: HTMLElement, paragraphId: string): TextSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return null;
  const anchor = pointOffset(root, selection.anchorNode, selection.anchorOffset);
  const focus = pointOffset(root, selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return { paragraphId, anchor, focus };
}

function findPoint(root: HTMLElement, rawOffset: number): { node: Node; offset: number } {
  const offset = Math.max(0, rawOffset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let cursor = 0;
  let last: Node | null = null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (offset <= cursor + length) return { node, offset: Math.max(0, offset - cursor) };
    cursor += length;
    last = node;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: root, offset: 0 };
}

function restoreSelection(root: HTMLElement, value: TextSelection): void {
  const selection = window.getSelection();
  if (!selection) return;
  const anchor = findPoint(root, value.anchor);
  const focus = findPoint(root, value.focus);
  root.focus();
  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return;
  }
  const range = document.createRange();
  range.setStart(anchor.node, anchor.offset);
  range.setEnd(focus.node, focus.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function textSegments(root: HTMLElement): Array<{ text: string; runId: string | null }> {
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
    const runId = element.dataset.runId ?? inheritedRunId;
    Array.from(node.childNodes).forEach((child) => visit(child, runId));
  };
  Array.from(root.childNodes).forEach((child) => visit(child, null));
  return segments;
}

function readRunsFromDom(root: HTMLElement, previousRuns: DocxRun[]): DocxRun[] {
  const templates = new Map(previousRuns.map((run) => [run.id, run]));
  const segments = textSegments(root).reduce<Array<{ text: string; runId: string | null }>>((merged, segment) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.runId === segment.runId) previous.text += segment.text;
    else merged.push({ ...segment });
    return merged;
  }, []);
  if (!segments.length) return [emptyRun(previousRuns[0]?.id ?? uniqueId("run-empty"))];
  const used = new Set<string>();
  return ensureRuns(segments.map((segment, index) => {
    const template = templates.get(segment.runId ?? "") ?? previousRuns[index] ?? previousRuns[previousRuns.length - 1] ?? emptyRun(uniqueId("run"));
    const id = segment.runId && !used.has(segment.runId) ? segment.runId : uniqueId(`${template.id}-edit`);
    used.add(id);
    return { ...template, id, text: segment.text };
  }));
}

function tableColumnPercentages(widths: number[]): number[] {
  const safeWidths = widths.map((width) => Math.max(1, width));
  const total = safeWidths.reduce((sum, width) => sum + width, 0) || safeWidths.length || 1;
  return safeWidths.map((width) => (width / total) * 100);
}

export function DocxViewer({ binaryContent, mode, aiHighlightText = null, aiHighlightFocusKey = 0, onArtifact }: DocxViewerProps) {
  const [source, setSource] = useState<DocxBasicDocument | null>(null);
  const [paragraphs, setParagraphs] = useState<DocxParagraph[]>([]);
  const [tables, setTables] = useState<DocxTable[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [showCompatibilityNotice, setShowCompatibilityNotice] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findCursor, setFindCursor] = useState(0);
  const [fontSizeInput, setFontSizeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [layoutRevision, setLayoutRevision] = useState(0);
  // The simplified editor remains mounted as an accessibility/test fallback,
  // but the user should only see the full-fidelity rendered page.
  const [layoutReady, setLayoutReady] = useState(true);
  const [layoutBinaryContent, setLayoutBinaryContent] = useState<string | null>(binaryContent);
  const toolbarScrollRef = useRef<HTMLDivElement | null>(null);
  const paragraphRefs = useRef(new Map<string, HTMLElement>());
  const layoutParagraphRefs = useRef(new Map<number, HTMLElement>());
  const paragraphsRef = useRef<DocxParagraph[]>([]);
  const lastSelectionRef = useRef<TextSelection | null>(null);
  const pendingSelectionRef = useRef<TextSelection | null>(null);
  const composingRef = useRef(false);
  const compositionCommitTimerRef = useRef<number | undefined>(undefined);
  const dirtyParagraphIdsRef = useRef(new Set<string>());
  const tablesRef = useRef<DocxTable[]>([]);
  const fontSizeInputRunRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const artifactTimerRef = useRef<number | undefined>(undefined);
  const readOnly = mode === "read-only";

  useEffect(() => () => {
    if (artifactTimerRef.current !== undefined) window.clearTimeout(artifactTimerRef.current);
  }, []);

  useEffect(() => {
    if (readOnly) {
      setSource(null);
      setParagraphs([]);
      setTables([]);
      tablesRef.current = [];
      paragraphsRef.current = [];
      setError(null);
      setLayoutBinaryContent(binaryContent);
      setLayoutReady(true);
      layoutParagraphRefs.current.clear();
      return;
    }
    if (!binaryContent) {
      setSource(null);
      setParagraphs([]);
      setTables([]);
      tablesRef.current = [];
      paragraphsRef.current = [];
      setError("DOCX 没有可用的二进制内容");
      setLayoutBinaryContent(binaryContent);
      setLayoutReady(true);
      layoutParagraphRefs.current.clear();
      return;
    }
    try {
      const parsed = parseDocxBasic(binaryContent);
      setSource(parsed);
      setParagraphs(parsed.paragraphs);
      setTables(parsed.tables);
      tablesRef.current = parsed.tables;
      paragraphsRef.current = parsed.paragraphs;
      setModelRevision((current) => current + 1);
      setLayoutRevision((current) => current + 1);
      setLayoutReady(true);
      layoutParagraphRefs.current.clear();
      setSelectedRunId(parsed.paragraphs[0]?.runs[0]?.id ?? null);
      setSelectedImageId(null);
      lastSelectionRef.current = null;
      pendingSelectionRef.current = null;
      dirtyParagraphIdsRef.current.clear();
      setError(null);
      setLayoutBinaryContent(binaryContent);
    } catch (cause) {
      setSource(null);
      setParagraphs([]);
      setTables([]);
      tablesRef.current = [];
      paragraphsRef.current = [];
      dirtyParagraphIdsRef.current.clear();
      setModelRevision((current) => current + 1);
      setLayoutReady(false);
      layoutParagraphRefs.current.clear();
      setError(cause instanceof Error ? cause.message : "DOCX 基础文字内容无法读取");
      setLayoutBinaryContent(binaryContent);
    }
  }, [binaryContent, readOnly]);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    // The basic fallback is reconciled by React synchronously. The full DOCX
    // layout is rendered asynchronously by docx-preview and restores its
    // pending caret from onEditableReady instead.
    const root = paragraphRefs.current.get(pending.paragraphId);
    if (!root) return;
    restoreSelection(root, pending);
    lastSelectionRef.current = pending;
    pendingSelectionRef.current = null;
  }, [paragraphs]);

  const selectedRun = useMemo(
    () => paragraphsRef.current.flatMap((paragraph) => paragraph.runs).find((run) => run.id === selectedRunId) ?? null,
    [modelRevision, selectedRunId],
  );
  const selectedParagraph = useMemo(
    () => paragraphsRef.current.find((paragraph) => paragraph.runs.some((run) => run.id === selectedRunId)) ?? null,
    [modelRevision, selectedRunId],
  );
  const fontOptions = useMemo(() => {
    const options = availableFontOptions();
    const current = selectedRun?.fontFamily;
    if (current && !options.some((font) => font.value === current)) {
      return [{ value: current, label: `${current}（当前文档）`, group: "西文字体" as const }, ...options];
    }
    return options;
  }, [selectedRun?.fontFamily]);

  useEffect(() => {
    const runId = selectedRun?.id ?? null;
    if (fontSizeInputRunRef.current === runId) return;
    fontSizeInputRunRef.current = runId;
    setFontSizeInput(formatFontSize(selectedRun?.fontSize ?? null));
  }, [selectedRun?.id, selectedRun?.fontSize]);

  useEffect(() => {
    if (!source?.warnings.length) {
      setShowCompatibilityNotice(false);
      return;
    }
    try {
      setShowCompatibilityNotice(window.localStorage.getItem(DOCX_NOTICE_STORAGE_KEY) !== "1");
    } catch {
      setShowCompatibilityNotice(true);
    }
  }, [source?.warnings.length]);

  const dismissCompatibilityNotice = (remember: boolean) => {
    if (remember) {
      try { window.localStorage.setItem(DOCX_NOTICE_STORAGE_KEY, "1"); } catch { /* storage may be unavailable in a restricted WebView */ }
    }
    setShowCompatibilityNotice(false);
  };

  const findMatches = useMemo(() => {
    if (!findText) return [] as Array<{ paragraphId: string; runId: string; index: number }>;
    return paragraphsRef.current.flatMap((paragraph) => paragraph.runs.flatMap((run) => {
      const matches: Array<{ paragraphId: string; runId: string; index: number }> = [];
      let index = run.text.indexOf(findText);
      while (index >= 0) {
        matches.push({ paragraphId: paragraph.id, runId: run.id, index });
        index = run.text.indexOf(findText, index + Math.max(1, findText.length));
      }
      return matches;
    }));
  }, [findText, modelRevision]);

  const rememberSelection = (paragraph: DocxParagraph, root: HTMLElement) => {
    const selection = captureSelection(root, paragraph.id);
    if (!selection) return;
    lastSelectionRef.current = selection;
    // Never schedule a React render while an IME owns the composition range.
    // React reconciling contentEditable children at this point causes the
    // browser to replay the composing key (for example `d` in `de`).
    if (composingRef.current || compositionCommitTimerRef.current !== undefined) return;
    const currentParagraph = paragraphsRef.current.find((item) => item.id === paragraph.id) ?? paragraph;
    const selected = runAtOffset(currentParagraph.runs, selection.focus);
    // Selection events fire while the user is still editing. Updating toolbar
    // state here would re-render the parent and reconcile stale children; the
    // memoized paragraph editor remains the single source of visible text.
    if (selected && !dirtyParagraphIdsRef.current.has(paragraph.id)) {
      setSelectedRunId((current) => current === selected.id ? current : selected.id);
    }
  };

  const syncDirtyParagraph = (paragraphId: string): DocxParagraph | null => {
    if (!dirtyParagraphIdsRef.current.has(paragraphId)) {
      return paragraphsRef.current.find((item) => item.id === paragraphId) ?? null;
    }
    const root = paragraphRefs.current.get(paragraphId);
    const current = paragraphsRef.current.find((item) => item.id === paragraphId);
    if (!root || !current) return current ?? null;
    const synced = { ...current, runs: readRunsFromDom(root, current.runs) };
    paragraphsRef.current = paragraphsRef.current.map((item) => item.id === paragraphId ? synced : item);
    dirtyParagraphIdsRef.current.delete(paragraphId);
    return synced;
  };

  const syncAllDirtyParagraphs = (): DocxParagraph[] => {
    Array.from(dirtyParagraphIdsRef.current).forEach((paragraphId) => syncDirtyParagraph(paragraphId));
    return paragraphsRef.current;
  };

  const updateParagraphs = (next: DocxParagraph[], selection: TextSelection | null = null) => {
    syncAllDirtyParagraphs();
    paragraphsRef.current = next;
    if (selection) {
      lastSelectionRef.current = selection;
      pendingSelectionRef.current = selection;
    }
    setParagraphs(next);
    setModelRevision((current) => current + 1);
    if (source) {
      try {
        setLayoutBinaryContent(encodeDocxBasic(source, next, tablesRef.current));
        setLayoutRevision((current) => current + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "DOCX 页面更新失败");
      }
    }
    if (source && !readOnly) {
      if (artifactTimerRef.current !== undefined) window.clearTimeout(artifactTimerRef.current);
      artifactTimerRef.current = window.setTimeout(() => {
        artifactTimerRef.current = undefined;
        try { onArtifact(encodeDocxBasic(source, paragraphsRef.current, tablesRef.current)); } catch { /* save button reports serialization errors */ }
      }, 280);
    }
  };

  const updateTableCell = (tableId: string, rowIndex: number, cellIndex: number, text: string) => {
    tablesRef.current = tablesRef.current.map((table) => table.id !== tableId ? table : {
      ...table,
      rows: table.rows.map((row, currentRowIndex) => currentRowIndex !== rowIndex ? row : row.map((cell, currentCellIndex) => currentCellIndex !== cellIndex ? cell : { ...cell, text })),
    });
  };

  const commitTables = () => setTables([...tablesRef.current]);

  const commitParagraphModel = (restoreCaret = false) => {
    syncAllDirtyParagraphs();
    if (restoreCaret && lastSelectionRef.current) pendingSelectionRef.current = lastSelectionRef.current;
    setParagraphs([...paragraphsRef.current]);
    setModelRevision((current) => current + 1);
  };

  const handleInput = (paragraph: DocxParagraph, root: HTMLElement) => {
    if (readOnly) return;
    const currentParagraph = paragraphsRef.current.find((item) => item.id === paragraph.id) ?? paragraph;
    const selection = captureSelection(root, paragraph.id);
    const runs = readRunsFromDom(root, currentParagraph.runs);
    const next = paragraphsRef.current.map((current) => current.id === paragraph.id ? { ...current, runs } : current);
    paragraphsRef.current = next;
    dirtyParagraphIdsRef.current.add(paragraph.id);
    if (selection) lastSelectionRef.current = selection;
    if (source && !readOnly) {
      if (artifactTimerRef.current !== undefined) window.clearTimeout(artifactTimerRef.current);
      artifactTimerRef.current = window.setTimeout(() => {
        artifactTimerRef.current = undefined;
        try { onArtifact(encodeDocxBasic(source, paragraphsRef.current, tablesRef.current)); } catch { /* keep editing responsive */ }
      }, 280);
    }
  };

  const handleLayoutInput = (event: DocxEditableEvent) => {
    if (event.kind === "paragraph") {
      const current = paragraphsRef.current[event.paragraphIndex]
        ?? paragraphsRef.current.find((paragraph) => paragraph.sourceIndex === event.paragraphIndex);
      if (!current) return;
      const next = paragraphsRef.current.map((paragraph) => paragraph.id === current.id ? { ...paragraph, runs: event.runs } : paragraph);
      // The rendered DOCX owns the live caret. Keep this update in refs and
      // refresh only the toolbar/search model, so React never rebuilds it
      // during normal typing or IME composition.
      paragraphsRef.current = next;
      const selection = captureSelection(event.root, current.id);
      if (selection) lastSelectionRef.current = selection;
      setModelRevision((revision) => revision + 1);
      if (source && !readOnly) {
        if (artifactTimerRef.current !== undefined) window.clearTimeout(artifactTimerRef.current);
        artifactTimerRef.current = window.setTimeout(() => {
          artifactTimerRef.current = undefined;
          try { onArtifact(encodeDocxBasic(source, paragraphsRef.current, tablesRef.current)); } catch { /* keep editing responsive */ }
        }, 280);
      }
      return;
    }
    const currentTables = tablesRef.current;
    const table = currentTables[event.tableIndex];
    if (!table || !table.rows[event.rowIndex]?.[event.cellIndex]) return;
    tablesRef.current = currentTables.map((candidate, tableIndex) => tableIndex !== event.tableIndex ? candidate : {
      ...candidate,
      rows: candidate.rows.map((row, rowIndex) => rowIndex !== event.rowIndex ? row : row.map((cell, cellIndex) => cellIndex !== event.cellIndex ? cell : { ...cell, text: event.text })),
    });
    if (source && !readOnly) {
      if (artifactTimerRef.current !== undefined) window.clearTimeout(artifactTimerRef.current);
      artifactTimerRef.current = window.setTimeout(() => {
        artifactTimerRef.current = undefined;
        try { onArtifact(encodeDocxBasic(source, paragraphsRef.current, tablesRef.current)); } catch { /* keep editing responsive */ }
      }, 280);
    }
  };

  const handleLayoutSelection = (paragraphIndex: number, root: HTMLElement) => {
    layoutParagraphRefs.current.set(paragraphIndex, root);
    const paragraph = paragraphsRef.current[paragraphIndex] ?? paragraphsRef.current.find((item) => item.sourceIndex === paragraphIndex);
    if (!paragraph) return;
    const selection = captureSelection(root, paragraph.id);
    if (!selection) return;
    lastSelectionRef.current = selection;
    const selected = runAtOffset(paragraph.runs, selection.focus);
    if (selected) setSelectedRunId(selected.id);
  };

  const updateSelectionStyle = (patch: RunStylePatch) => {
    if (readOnly) return;
    const selection = lastSelectionRef.current;
    const paragraph = selection ? paragraphsRef.current.find((item) => item.id === selection.paragraphId) : selectedParagraph;
    if (!paragraph) return;
    const start = selection ? Math.min(selection.anchor, selection.focus) : 0;
    const end = selection ? Math.max(selection.anchor, selection.focus) : 0;
    const caretRun = selection ? runAtOffset(paragraph.runs, selection.focus) : null;
    const targetRunId = caretRun?.id ?? selectedRunId;
    const runs = end > start
      ? updateRunsInRange(paragraph.runs, start, end, patch)
      : paragraph.runs.map((run) => run.id === targetRunId ? { ...run, ...patch } : run);
    const next = paragraphsRef.current.map((current) => current.id === paragraph.id ? { ...current, runs } : current);
    updateParagraphs(next, selection);
    if (targetRunId) setSelectedRunId(targetRunId);
  };

  const setStyle = (key: StyleKey, value: boolean) => updateSelectionStyle({ [key]: value });

  const handleFontSizeChange = (value: string) => {
    setFontSizeInput(value);
    if (!value.trim()) {
      updateSelectionStyle({ fontSize: null });
      return;
    }
    const size = parseFontSize(value);
    if (size !== null) updateSelectionStyle({ fontSize: size });
  };

  const commitFontSizeInput = () => {
    const size = parseFontSize(fontSizeInput);
    if (fontSizeInput.trim() && size === null) {
      setFontSizeInput(formatFontSize(selectedRun?.fontSize ?? null));
      return;
    }
    if (!fontSizeInput.trim()) {
      setFontSizeInput("");
      updateSelectionStyle({ fontSize: null });
      return;
    }
    const formatted = formatFontSize(size);
    setFontSizeInput(formatted);
    if (size !== null) updateSelectionStyle({ fontSize: size });
  };

  const splitParagraph = (paragraph: DocxParagraph, selection: TextSelection) => {
    const offset = Math.min(selection.anchor, selection.focus);
    const end = Math.max(selection.anchor, selection.focus);
    const [before, remainder] = splitRunsAtOffset(paragraph.runs, offset);
    const [, after] = splitRunsAtOffset(remainder, Math.max(0, end - offset));
    const nextId = uniqueId(`${paragraph.id}-paragraph`);
    const anchor = paragraph.insertAfterSourceIndex ?? paragraph.sourceIndex;
    const siblingOrders = paragraphsRef.current
      .filter((item) => item.insertAfterSourceIndex === anchor)
      .map((item) => item.insertOrder ?? 0);
    const nextParagraph: DocxParagraph = {
      id: nextId,
      runs: ensureRuns(after, `${nextId}-r-0`),
      insertAfterSourceIndex: anchor,
      insertOrder: siblingOrders.length ? Math.max(...siblingOrders) + 1 : 1,
    };
    const next = paragraphsRef.current.flatMap((item) => item.id === paragraph.id
      ? [{ ...item, runs: ensureRuns(before, `${item.id}-r-0`) }, nextParagraph]
      : [item]);
    updateParagraphs(next, { paragraphId: nextId, anchor: 0, focus: 0 });
    setSelectedRunId(nextParagraph.runs[0]?.id ?? null);
  };

  const mergeParagraph = (paragraph: DocxParagraph, other: DocxParagraph) => {
    const mergedRuns = [...paragraph.runs, ...other.runs];
    const next = paragraphsRef.current
      .filter((item) => item.id !== other.id)
      .map((item) => item.id === paragraph.id ? { ...item, runs: ensureRuns(mergedRuns) } : item);
    const caret = paragraphLength(paragraph);
    updateParagraphs(next, { paragraphId: paragraph.id, anchor: caret, focus: caret });
    setSelectedRunId(runAtOffset(mergedRuns, Math.max(0, caret - 1))?.id ?? null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, paragraph: DocxParagraph) => {
    if (readOnly) return;
    const currentParagraph = paragraphsRef.current.find((item) => item.id === paragraph.id) ?? paragraph;
    const root = paragraphRefs.current.get(paragraph.id)
      ?? (paragraph.sourceIndex === undefined ? undefined : layoutParagraphRefs.current.get(paragraphsRef.current.indexOf(paragraph)));
    const selection = root ? captureSelection(root, paragraph.id) : null;
    if (!selection) return;
    const start = Math.min(selection.anchor, selection.focus);
    const end = Math.max(selection.anchor, selection.focus);
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        const [before, remainder] = splitRunsAtOffset(currentParagraph.runs, start);
        const [, after] = splitRunsAtOffset(remainder, Math.max(0, end - start));
        const lineBreak = { ...runAtOffset(currentParagraph.runs, start) ?? emptyRun(uniqueId("run-break")), text: "\n" };
        const nextRuns = ensureRuns([...before, lineBreak, ...after]);
        updateParagraphs(paragraphsRef.current.map((item) => item.id === paragraph.id ? { ...item, runs: nextRuns } : item), { paragraphId: paragraph.id, anchor: start + 1, focus: start + 1 });
      } else {
        splitParagraph(currentParagraph, selection);
      }
      return;
    }
    if (event.key === "Backspace" && start === end && start === 0) {
    const index = paragraphsRef.current.findIndex((item) => item.id === paragraph.id);
      const previous = index > 0 ? paragraphsRef.current[index - 1] : null;
      if (previous) {
        event.preventDefault();
        mergeParagraph(previous, currentParagraph);
      }
      return;
    }
    if (event.key === "Delete" && start === end && end === paragraphLength(currentParagraph)) {
      const index = paragraphsRef.current.findIndex((item) => item.id === paragraph.id);
      const next = paragraphsRef.current[index + 1];
      if (next) {
        event.preventDefault();
        mergeParagraph(currentParagraph, next);
      }
    }
  };

  const handleLayoutKeyDown = (paragraphIndex: number, event: globalThis.KeyboardEvent, root: HTMLElement) => {
    const paragraph = paragraphsRef.current[paragraphIndex];
    if (!paragraph) return;
    layoutParagraphRefs.current.set(paragraphIndex, root);
    handleKeyDown(event as unknown as KeyboardEvent<HTMLElement>, paragraph);
  };

  const saveDraft = () => {
    if (!source || readOnly) return;
    try {
      const latestParagraphs = syncAllDirtyParagraphs();
      onArtifact(encodeDocxBasic(source, latestParagraphs, tablesRef.current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "DOCX 修改无法生成文件");
    }
  };

  const commitImageModel = (nextSource: DocxBasicDocument) => {
    setSource(nextSource);
    try {
      const latestParagraphs = syncAllDirtyParagraphs();
      const artifact = encodeDocxBasic(nextSource, latestParagraphs, tablesRef.current);
      setLayoutBinaryContent(artifact);
      setLayoutRevision((current) => current + 1);
      onArtifact(artifact);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片修改无法写入 DOCX");
    }
  };

  const insertImageFile = async (file: File) => {
    if (!source || readOnly || !file.type.startsWith("image/")) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const imageId = uniqueId("image");
    const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
      const preview = new Image();
      const objectUrl = URL.createObjectURL(file);
      const finish = (value: { width: number; height: number }) => { URL.revokeObjectURL(objectUrl); resolve(value); };
      preview.onload = () => finish({ width: preview.naturalWidth || 640, height: preview.naturalHeight || 360 });
      preview.onerror = () => finish({ width: 640, height: 360 });
      preview.src = objectUrl;
    });
    const scale = Math.min(1, 620 / Math.max(1, dimensions.width));
    const nextSource = addDocxImage(source, {
      id: imageId,
      name: file.name,
      mimeType: file.type || "image/png",
      bytes,
      widthPx: Math.max(32, Math.round(dimensions.width * scale)),
      heightPx: Math.max(32, Math.round(dimensions.height * scale)),
      xPx: 24,
      yPx: 24,
    });
    setSelectedImageId(imageId);
    commitImageModel(nextSource);
  };

  const updateSelectedImage = (patch: Partial<Pick<import("./docxBasic").DocxInsertedImage, "widthPx" | "heightPx" | "xPx" | "yPx">>) => {
    if (!source || !selectedImageId) return;
    commitImageModel(updateDocxImage(source, selectedImageId, patch));
  };

  const addParagraph = () => {
    if (readOnly) return;
    const id = uniqueId("p-new");
    const paragraph: DocxParagraph = { id, runs: [emptyRun(`${id}-r-0`)] };
    updateParagraphs([...paragraphsRef.current, paragraph], { paragraphId: id, anchor: 0, focus: 0 });
    setSelectedRunId(paragraph.runs[0].id);
  };

  const deleteSelectedParagraph = () => {
    if (!selectedRunId || readOnly) return;
    const index = paragraphsRef.current.findIndex((paragraph) => paragraph.id === selectedParagraph?.id);
    const remaining = paragraphsRef.current.filter((paragraph) => paragraph.id !== selectedParagraph?.id);
    const next = remaining.length ? remaining : [{ id: "p-new-empty", runs: [emptyRun("p-new-empty-r-0")] }];
    const target = next[Math.max(0, Math.min(index, next.length - 1))];
    updateParagraphs(next, target ? { paragraphId: target.id, anchor: 0, focus: 0 } : null);
    setSelectedRunId(target?.runs[0]?.id ?? null);
  };

  const findNext = () => {
    if (!findMatches.length) return;
    const match = findMatches[findCursor % findMatches.length];
    const paragraph = paragraphsRef.current.find((item) => item.id === match.paragraphId);
    if (!paragraph) return;
    let offset = 0;
    for (const run of paragraph.runs) {
      if (run.id === match.runId) break;
      offset += run.text.length;
    }
    const selection = { paragraphId: paragraph.id, anchor: offset + match.index, focus: offset + match.index + findText.length };
    const layoutRoot = layoutParagraphRefs.current.get(paragraphsRef.current.indexOf(paragraph));
    if (layoutRoot) {
      restoreSelection(layoutRoot, selection);
      pendingSelectionRef.current = null;
    } else {
      pendingSelectionRef.current = selection;
    }
    lastSelectionRef.current = selection;
    setSelectedRunId(match.runId);
    setParagraphs((current) => [...current]);
    setFindCursor((current) => (current + 1) % findMatches.length);
  };

  const replaceAll = () => {
    if (!findText || readOnly) return;
    const next = paragraphsRef.current.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => ({ ...run, text: run.text.split(findText).join(replaceText) })),
    }));
    updateParagraphs(next);
    setFindCursor(0);
  };

  if (readOnly) {
    return <DocxPreview binaryContent={binaryContent} aiHighlightText={aiHighlightText} aiHighlightFocusKey={aiHighlightFocusKey} />;
  }

  if (error) {
    return <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>DOCX 基础编辑不可用</p><small>{error}</small></div>;
  }

  return <div className="docx-viewer">
    {showCompatibilityNotice && source?.warnings.length ? <div className="docx-notice-modal-layer" role="presentation">
      <section className="docx-notice-modal" role="dialog" aria-modal="true" aria-labelledby="docx-notice-title">
        <header><span className="docx-notice-icon"><FileWarning aria-hidden="true" /></span><div><strong id="docx-notice-title">编辑提示</strong><small>部分复杂对象会保持原样</small></div><button type="button" className="icon-button" aria-label="关闭编辑提示" title="关闭" onClick={() => dismissCompatibilityNotice(false)}><X aria-hidden="true" /></button></header>
        <div className="docx-notice-copy">{source.warnings.map((warning) => <p key={warning}>{warning === "图片和图形保留原样，不支持在此处编辑" ? "图片和图形会保留在原位置，所在段落的文字仍可直接编辑。" : warning}</p>)}</div>
        <footer><button type="button" className="docx-notice-secondary" onClick={() => dismissCompatibilityNotice(false)}>知道了</button><button type="button" className="docx-notice-primary" onClick={() => dismissCompatibilityNotice(true)}>不再提醒</button></footer>
      </section>
    </div> : null}
    {!readOnly && <div className="docx-toolbar-shell" aria-label="文字样式工具栏"><button type="button" className="docx-toolbar-arrow" aria-label="显示前一组工具" title="前一组工具" onClick={() => toolbarScrollRef.current?.scrollBy({ left: -320, behavior: "smooth" })}><ChevronLeft aria-hidden="true" /></button><div className="docx-toolbar-scroll" ref={toolbarScrollRef}><div className="docx-toolbar">
      <div className="docx-toolbar-group docx-toolbar-format" aria-label="文字格式">
        <button type="button" className={selectedRun?.bold ? "is-active" : ""} aria-label="粗体" title="粗体" onMouseDown={(event) => event.preventDefault()} onClick={() => setStyle("bold", !selectedRun?.bold)}><Bold aria-hidden="true" /></button>
        <button type="button" className={selectedRun?.italic ? "is-active" : ""} aria-label="斜体" title="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => setStyle("italic", !selectedRun?.italic)}><Italic aria-hidden="true" /></button>
        <button type="button" className={selectedRun?.underline ? "is-active" : ""} aria-label="下划线" title="下划线" onMouseDown={(event) => event.preventDefault()} onClick={() => setStyle("underline", !selectedRun?.underline)}><Underline aria-hidden="true" /></button>
        <select className="docx-font-family" aria-label="字体" title="字体（会检测当前应用可用字体）" value={selectedRun?.fontFamily ?? ""} onChange={(event) => updateSelectionStyle({ fontFamily: event.target.value || null })}>
          <option value="">默认字体</option>
          {(["中文字体", "西文字体", "等宽字体"] as const).map((group) => <optgroup key={group} label={group}>{fontOptions.filter((font) => font.group === group).map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</optgroup>)}
        </select>
        <label className="docx-font-size-control" title="字号（pt），可输入 1–200"><span>字号</span><input aria-label="字号" type="number" min="1" max="200" step="0.5" list="docx-font-sizes" placeholder="默认" value={fontSizeInput} onChange={(event) => handleFontSizeChange(event.target.value)} onBlur={commitFontSizeInput} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFontSizeInput(); } }} /><span>pt</span></label>
        <datalist id="docx-font-sizes">{COMMON_FONT_SIZES.map((size) => <option key={size} value={size}>{size} pt</option>)}</datalist>
        <label className="docx-color-control" title="文字颜色"><span>颜色</span><input aria-label="文字颜色" type="color" value={selectedRun?.color ?? "#111827"} onChange={(event) => updateSelectionStyle({ color: event.target.value })} /></label>
      </div>
      <div className="docx-toolbar-group docx-toolbar-search" aria-label="文字查找和替换">
        <input aria-label="查找文字" value={findText} onChange={(event) => { setFindText(event.target.value); setFindCursor(0); }} placeholder="查找" />
        <input aria-label="替换为" value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="替换为" />
        <button type="button" onClick={findNext} disabled={!findMatches.length}>查找{findMatches.length ? ` (${findMatches.length})` : ""}</button>
        <button type="button" onClick={replaceAll} disabled={!findMatches.length}>全部替换</button>
      </div>
      <div className="docx-toolbar-group docx-toolbar-actions" aria-label="文档操作">
        <button type="button" onClick={addParagraph} title="新增段落">新增段落</button>
        <button type="button" onClick={deleteSelectedParagraph} disabled={!selectedRunId} title="删除当前段落">删除段落</button>
        <button type="button" className={selectedImageId ? "docx-image-button is-active" : "docx-image-button"} onMouseDown={(event) => event.preventDefault()} onClick={() => imageInputRef.current?.click()} title="插入图片"><ImagePlus aria-hidden="true" /><span>图片</span></button>
        <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void insertImageFile(file); }} />
        {selectedImageId && source?.insertedImages.find((image) => image.id === selectedImageId) && (() => { const image = source.insertedImages.find((candidate) => candidate.id === selectedImageId)!; return <div className="docx-image-controls" aria-label="图片尺寸和位置"><label>宽<input type="number" min="32" max="1600" value={Math.round(image.widthPx)} onChange={(event) => updateSelectedImage({ widthPx: Number(event.target.value) || 32 })} /></label><label>高<input type="number" min="32" max="1600" value={Math.round(image.heightPx)} onChange={(event) => updateSelectedImage({ heightPx: Number(event.target.value) || 32 })} /></label><small>拖动移动 · Shift+拖动缩放</small></div>; })()}
        <button type="button" className="docx-save" onClick={saveDraft}><Save aria-hidden="true" />暂存修改</button>
      </div>
    </div></div><button type="button" className="docx-toolbar-arrow" aria-label="显示下一组工具" title="下一组工具" onClick={() => toolbarScrollRef.current?.scrollBy({ left: 320, behavior: "smooth" })}><ChevronRight aria-hidden="true" /></button></div>}
    <div className="docx-layout-editor" aria-label="DOCX 页面编辑区">
      <DocxPreview
        binaryContent={layoutBinaryContent}
        editable
        editableRevision={layoutRevision}
        editableModel={{ paragraphs, tables, images: source?.insertedImages ?? [] }}
        onEditableReady={(root) => {
          const hasRenderedSection = Boolean(root.querySelector("section.moji-docx"));
          const hasEditableSurface = Boolean(root.querySelector('[contenteditable="true"]'));
          // Do not hide the reliable basic editor when a complex DOCX was
          // rendered but its paragraph structure could not be decorated.
          setLayoutReady(hasRenderedSection && hasEditableSurface);
          const pending = pendingSelectionRef.current;
          if (pending) {
            const candidate = Array.from(root.querySelectorAll<HTMLElement>("[data-moji-paragraph-index]")).find((element) => {
              const index = Number(element.dataset.mojiParagraphIndex);
              return paragraphsRef.current[index]?.id === pending.paragraphId;
            });
            if (candidate) {
              layoutParagraphRefs.current.set(Number(candidate.dataset.mojiParagraphIndex), candidate);
              restoreSelection(candidate, pending);
              lastSelectionRef.current = pending;
              pendingSelectionRef.current = null;
            }
          }
        }}
        onEditableInput={handleLayoutInput}
        onEditableSelection={handleLayoutSelection}
        onEditableKeyDown={handleLayoutKeyDown}
        onEditableImageSelect={setSelectedImageId}
        onEditableImageChange={(_imageId, patch) => updateSelectedImage(patch)}
      />
    </div>
    <div className={`docx-page docx-basic-fallback ${layoutReady ? "is-hidden" : ""}`} aria-label="DOCX 文字内容">
      {paragraphs.map((paragraph) => <ParagraphEditor
        key={paragraph.id}
        paragraph={paragraph}
        readOnly={readOnly}
        paragraphRefs={paragraphRefs}
        onFocus={rememberSelection}
        onSelect={rememberSelection}
        onMouseUp={rememberSelection}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
          if (compositionCommitTimerRef.current !== undefined) window.clearTimeout(compositionCommitTimerRef.current);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionCommitTimerRef.current = window.setTimeout(() => {
            compositionCommitTimerRef.current = undefined;
            commitParagraphModel(true);
          }, 0);
        }}
        onBlur={() => {
          if (compositionCommitTimerRef.current !== undefined) {
            window.clearTimeout(compositionCommitTimerRef.current);
            compositionCommitTimerRef.current = undefined;
          }
          if (!composingRef.current) {
            syncAllDirtyParagraphs();
            commitParagraphModel();
          }
        }}
        onInput={handleInput}
      />)}
      {tables.length > 0 && <section className="docx-table-editor" aria-label="DOCX 表格内容">
        <header><strong>已有表格</strong><span>可修改单元格文字，不支持插入表格或调整行列</span></header>
        {tables.map((table, tableIndex) => {
          const percentages = tableColumnPercentages(table.gridWidthsTwips);
          const sourceWidthPx = Math.round((table.widthTwips ?? table.gridWidthsTwips.reduce((sum, width) => sum + width, 0)) * (96 / 1440));
          return <div className="docx-table-scroll" key={table.id}><table aria-label={`第 ${tableIndex + 1} 个表格`} className="docx-edit-table" style={{ minWidth: sourceWidthPx > 720 ? `${sourceWidthPx}px` : undefined }}>
            <colgroup>{percentages.map((percent, index) => <col key={`${table.id}-column-${index}`} style={{ width: `${percent}%` }} />)}</colgroup>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={`${table.id}-row-${rowIndex}`}>
              {row.filter((cell) => cell.verticalMerge !== "continue").map((cell, cellIndex) => <td key={cell.id} colSpan={cell.gridSpan > 1 ? cell.gridSpan : undefined} rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}>
                <TableCellEditor cell={cell} ariaLabel={`表格 ${tableIndex + 1} 第 ${rowIndex + 1} 行第 ${cellIndex + 1} 列`} onInput={(text) => updateTableCell(table.id, rowIndex, table.rows[rowIndex].indexOf(cell), text)} onBlur={commitTables} />
              </td>)}
            </tr>)}</tbody>
          </table></div>;
        })}
      </section>}
    </div>
  </div>;
}
