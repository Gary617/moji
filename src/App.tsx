import { DocumentSurface } from "./document/DocumentSurface";
import {
  ArrowLeft,
  ArrowUp,
  Clock3,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Eye,
  ExternalLink,
  FileWarning,
  FolderKanban,
  CalendarDays,
  CircleCheck,
  History,
  LayoutList,
  LibraryBig,
  ListFilter,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ArrowDownAZ,
  FolderOpen,
  HardDrive,
  Highlighter,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  ScanLine,
  Sparkles,
  Star,
  Square,
  Trash2,
  Tag,
  X,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { healthCheck, type HealthCheckData } from "./ipc/health";
import {
  addAnnotation,
  closeDocument,
  listAnnotations,
  listSnapshots,
  openDocument,
  openDocumentExternal,
  restoreSnapshot,
  saveBinaryDocument,
  saveDocument,
  saveDocumentAs,
  type AnnotationAnchor,
  type AnnotationRecord,
  type DocumentMode,
  type DocumentOpenResult,
  type SnapshotRecord,
} from "./ipc/document";
import {
  createCollection,
  createTag,
  listCollections,
  listTags,
  recordRecentUse,
  removeDocument as removeDocumentFromLibrary,
  searchLibrary,
  setCollectionMembership,
  setFavorite,
  setTagMembership,
  cancelScan,
  pauseScan,
  pickSourceFile,
  pickSourceFolder,
  previewCommonLocations,
  previewFullDisk,
  resumeScan,
  scanStatus,
  startScan,
  startSelectedScan,
  type ScanJobRecord,
  type ScanFolderNode,
  type ScanPreviewEvent,
  type ScanPreviewResult,
  type CollectionRecord,
  type DocumentFormat,
  type DocumentStatus,
  type SearchDocument,
  type SearchQuery,
  type TagRecord,
} from "./ipc/library";
import type { IpcError } from "./ipc/types";
import { applyAiChange, cancelAiChat, chatWithAiStream, previewAiContext, rejectAiChange, type AiChangeRequest, type AiConversationMessage, type AiPermission, type AiStreamEvent, type ContextPreview } from "./ipc/ai";
import { adapterRegistry } from "./document/registry";
import { PdfViewer } from "./document/PdfViewer";
import { TextViewer } from "./document/TextViewer";
import { ImageViewer } from "./document/ImageViewer";
import { DocxViewer } from "./document/DocxViewer";
import { OfficePreview } from "./document/OfficePreview";
import { readSpreadsheet } from "./document/spreadsheet/read";
import type { SpreadsheetPlan } from "./document/spreadsheet/operations";
import { spreadsheetBase64, writeSpreadsheet } from "./document/spreadsheet/write";
import { serializeSpreadsheetAiContext } from "./document/spreadsheet/context";
import { executeSpreadsheetAiPlan } from "./document/spreadsheet/planExecutor";
import { parseSpreadsheetAiResponse } from "./document/spreadsheet/aiProtocol";
import { createPdfAnchor, createTextAnchor } from "./document/anchors";
import { finiteScanNumber, formatScanCount, normalizeScanBatch, normalizeScanJob, normalizeScanJobs, normalizeScanPreview } from "./scanProgress";
import { ProductModeSwitch, type ProductMode } from "./workbench/ProductModeSwitch";
import { Workbench } from "./workbench/Workbench";

type HealthState =
  | { kind: "checking" }
  | { kind: "healthy"; data: HealthCheckData }
  | { kind: "unavailable"; error: IpcError };

type View = "all" | "favorites" | "recent";
type SidebarView = "navigation" | "results";
type SidebarMotion = "idle" | "leaving" | "entering";
type AiTurn = { role: "user" | "assistant" | "tool" | "error"; text: string };
type AiPhase = "idle" | "preparing" | "thinking" | "reading" | "drafting" | "writing" | "done" | "timeout" | "error";
type AiEditHighlight = {
  documentId: string;
  text: string;
  before: string;
  after: string;
  location: string;
  anchor: AnnotationAnchor | null;
  createdAtMs: number;
};
type AiProposal = {
  kind: "proposedChange";
  proposalId: string;
  documentId: string;
  permission: AiPermission;
  expectedSha256: string;
  oldContent: string;
  newContent: string;
};
type XlsxPlanReview = {
  plan: SpreadsheetPlan;
  binaryContent: string;
  changes: { sheet: string; address: string; before: string | number | boolean | null; after: string | number | boolean | null; formula?: string; formatChanged?: boolean }[];
  answer?: string;
};

function rememberedAutonomousProposal(ref: { current: AiProposal | null }): AiProposal | null {
  const proposal = ref.current;
  return proposal?.permission === "autonomous" ? proposal : null;
}
export type AiResponseLine = { kind: "paragraph" | "heading" | "ordered" | "bullet"; text: string; number: string | null };
type RelationCreateKind = "collection" | "tag";

type ScanSourceLabel = Record<string, string>;

type ScanPreviewKind = "common" | "full-disk";

type ScanEnumerationProgress = {
  phase: "starting" | "enumerating" | "completed";
  label: string | null;
  relativePath: string | null;
  foldersScanned: number;
  filesFound: number;
  rootIndex: number;
  rootCount: number;
};

const emptyScanEnumerationProgress = (): ScanEnumerationProgress => ({
  phase: "starting",
  label: null,
  relativePath: null,
  foldersScanned: 0,
  filesFound: 0,
  rootIndex: 0,
  rootCount: 0,
});

type LibraryState =
  | { kind: "loading" }
  | { kind: "ready"; items: SearchDocument[]; total: number; queryTimeMs: number }
  | { kind: "error"; error: IpcError };

type WorkspaceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: IpcError }
  | { kind: "ready"; opened: DocumentOpenResult; draft: string; error: IpcError | null; notice: string | null; comparison: DocumentOpenResult | null };

const formatLabels: Record<DocumentFormat, string> = {
  doc: "DOC",
  docx: "DOCX",
  pptx: "PPTX",
  xlsx: "XLSX",
  pdf: "PDF",
  markdown: "Markdown",
  text: "文本",
  csv: "CSV",
  png: "PNG",
  jpg: "JPG",
  tiff: "TIFF",
  bmp: "BMP",
};

const LIBRARY_PAGE_SIZE = 200;
const LIBRARY_FORMATS: DocumentFormat[] = ["docx", "doc", "pptx", "xlsx", "pdf", "markdown", "text", "csv"];
const FORMAT_ORDER: DocumentFormat[] = LIBRARY_FORMATS;
const formatRank = (format: DocumentFormat): number => FORMAT_ORDER.indexOf(format);

const AI_CONVERSATIONS_STORAGE_KEY = "moji.ai-conversations.v1";
const MAX_PERSISTED_AI_TURNS = 80;
const MAX_PERSISTED_AI_DOCUMENTS = 40;
const MAX_PERSISTED_AI_TURN_CHARS = 24_000;

function readPersistedAiConversations(): Record<string, AiTurn[]> {
  try {
    const raw = window.localStorage.getItem(AI_CONVERSATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, AiTurn[]> = {};
    for (const [documentId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const turns = value.filter((turn): turn is AiTurn => {
        if (!turn || typeof turn !== "object") return false;
        const candidate = turn as { role?: unknown; text?: unknown };
        return (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "tool" || candidate.role === "error")
          && typeof candidate.text === "string" && candidate.text.trim().length > 0;
      }).map((turn) => ({ ...turn, text: turn.text.slice(0, MAX_PERSISTED_AI_TURN_CHARS) })).slice(-MAX_PERSISTED_AI_TURNS);
      if (turns.length > 0) result[documentId] = turns;
    }
    return result;
  } catch {
    return {};
  }
}

function persistAiConversation(documentId: string | null, turns: AiTurn[]) {
  if (!documentId) return;
  try {
    const all = readPersistedAiConversations();
    all[documentId] = turns.slice(-MAX_PERSISTED_AI_TURNS).map((turn) => ({ ...turn, text: turn.text.slice(0, MAX_PERSISTED_AI_TURN_CHARS) }));
    const entries = Object.entries(all).slice(-MAX_PERSISTED_AI_DOCUMENTS);
    window.localStorage.setItem(AI_CONVERSATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A restricted WebView or full local storage must not break AI requests.
  }
}

function loadPersistedAiConversation(documentId: string): AiTurn[] {
  return readPersistedAiConversations()[documentId] ?? [];
}

const COMMON_AI_PROMPTS = [
  { label: "提炼核心观点", prompt: "请提炼这份文档的核心观点，并给出简明摘要。" },
  { label: "整理行动事项", prompt: "请整理这份文档中的行动事项、日期与负责人。" },
  { label: "梳理文档结构", prompt: "请梳理这份文档的结构，列出主要章节及其关系。" },
  { label: "提取关键数据", prompt: "请提取这份文档中的关键数据、结论和需要特别关注的内容。" },
  { label: "生成复习提纲", prompt: "请根据这份文档生成一份分层的复习提纲，并标注重点。" },
  { label: "检查遗漏风险", prompt: "请检查这份文档中可能遗漏的信息、矛盾之处或需要补充的内容。" },
] as const;

function modifiedLabel(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

function renderSnippet(text: string) {
  const parts = text.split(/(<mark>|<\/mark>)/g);
  let highlighted = false;
  return parts.map((part, index) => {
    if (part === "<mark>") {
      highlighted = true;
      return null;
    }
    if (part === "</mark>") {
      highlighted = false;
      return null;
    }
    return highlighted ? <mark key={`${part}-${index}`}>{part}</mark> : part;
  });
}

function localDocumentText(workspace: WorkspaceState, selected: SearchDocument): string {
  if (workspace.kind === "ready" && workspace.draft.trim()) return workspace.draft.trim();
  return selected.snippets.map((snippet) => snippet.text.replace(/<[^>]+>/g, "")).join("\n").trim();
}

function isTextDocument(format: DocumentFormat): boolean {
  return format === "markdown" || format === "text" || format === "csv";
}

function explicitlyRequestsDocumentEdit(prompt: string): boolean {
  const value = prompt.toLowerCase();
  if (["不要修改", "不需要修改", "不用修改", "只给建议", "只需要建议", "不要改"].some((marker) => value.includes(marker))) return false;
  return ["修改", "改一下", "改成", "润色", "重写", "替换", "编辑", "写回", "帮我改", "帮我修改", "直接修改", "优化一下"].some((marker) => value.includes(marker));
}

function createAiEditHighlight(
  proposal: Extract<AiStreamEvent, { kind: "proposedChange" }>,
  format: DocumentFormat,
): AiEditHighlight {
  if (!isTextDocument(format)) {
    return {
      documentId: proposal.documentId,
      text: proposal.newContent,
      before: proposal.oldContent,
      after: proposal.newContent,
      location: "DOCX 正文或表格段落（按原文定位）",
      anchor: null,
      createdAtMs: Date.now(),
    };
  }
  let prefix = 0;
  while (prefix < proposal.oldContent.length && prefix < proposal.newContent.length && proposal.oldContent[prefix] === proposal.newContent[prefix]) prefix += 1;
  let oldSuffix = proposal.oldContent.length;
  let newSuffix = proposal.newContent.length;
  while (oldSuffix > prefix && newSuffix > prefix && proposal.oldContent[oldSuffix - 1] === proposal.newContent[newSuffix - 1]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  const replacement = proposal.newContent.slice(prefix, newSuffix);
  const fallbackStart = Math.max(0, Math.min(proposal.newContent.length, prefix));
  const fallbackEnd = Math.min(proposal.newContent.length, Math.max(fallbackStart + 1, fallbackStart + 48));
  const start = replacement ? prefix : fallbackStart;
  const end = replacement ? newSuffix : fallbackEnd;
  return {
    documentId: proposal.documentId,
    text: replacement || proposal.newContent.slice(fallbackStart, fallbackEnd),
    before: proposal.oldContent.slice(Math.max(0, prefix - 80), Math.min(proposal.oldContent.length, oldSuffix + 80)),
    after: proposal.newContent.slice(Math.max(0, prefix - 80), Math.min(proposal.newContent.length, newSuffix + 80)),
    location: "正文文本（已定位到变更字符）",
    anchor: createTextAnchor(proposal.newContent, format, start, end),
    createdAtMs: Date.now(),
  };
}

function buildLocalAnalysis(task: "summary" | "actions", content: string, name: string): string {
  if (!content) return `“${name}”当前没有可供本地分析的正文。可以继续使用只读查看器，或配置 AI 服务后进行远程分析。`;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (task === "summary") {
    const excerpt = lines.slice(0, 5).join("；").slice(0, 480);
    return `本地快速摘要\n\n${excerpt}${content.length > excerpt.length ? "……" : ""}\n\n共识别 ${lines.length} 个文本段落。`;
  }
  const actionLines = lines.filter((line) => /(待办|任务|行动|负责人|截止|日期|需要|应该|TODO|FIXME)/i.test(line)).slice(0, 8);
  return actionLines.length
    ? `本地识别到以下可能的行动项：\n\n${actionLines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`
    : "本地分析没有识别出明确的行动项。你可以在输入框中补充更具体的问题，交给远程 AI 进一步判断。";
}

function aiPhaseLabel(phase: AiPhase): string {
  switch (phase) {
    case "preparing": return "正在准备当前文档上下文";
    case "thinking": return "正在分析你的要求";
    case "reading": return "正在读取相关文档内容";
    case "drafting": return "正在生成修改方案";
    case "writing": return "正在安全写回当前文档";
    case "done": return "本次处理已完成";
    case "timeout": return "服务响应超时";
    case "error": return "本次处理未完成";
    default: return "等待你的消息";
  }
}

/** Convert common model Markdown into plain, structured UI content without exposing formatting tokens. */
export function parseAiResponseLines(text: string): AiResponseLine[] {
  const stripInlineMarkers = (value: string) => value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/[|]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return text.replace(/\r\n?/g, "\n").split("\n").flatMap((rawLine) => {
    let line = rawLine.trim();
    if (!line || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) return [];
    if (/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?$/.test(line)) return [];
    line = line.replace(/^>\s?/, "");
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const ordered = line.match(/^(\d+)[.、)]\s*(.+)$/);
    const bullet = line.match(/^(?:[-*+•])\s+(.+)$/);
    const tableLine = line.startsWith("|") || line.endsWith("|");
    const candidate = heading?.[1] ?? ordered?.[2] ?? bullet?.[1] ?? (tableLine ? line.replace(/^\|\s?|\s*\|$/g, "") : line);
    const wrappedHeading = candidate.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)$/);
    const clean = stripInlineMarkers(wrappedHeading?.[1] ?? candidate);
    if (!clean) return [];
    return [{
      kind: heading || (wrappedHeading && !ordered && !bullet) ? "heading" : ordered ? "ordered" : bullet ? "bullet" : "paragraph",
      text: clean,
      number: ordered?.[1] ?? null,
    }];
  });
}

function AiResponseText({ text }: { text: string }): ReactNode {
  const lines = parseAiResponseLines(text);
  return <div className="ai-response-text">{lines.map((line, index) => {
    if (line.kind === "heading") return <strong className="ai-response-heading" key={`${line.kind}-${index}`}>{line.text}</strong>;
    if (line.kind === "ordered") return <div className="ai-response-line ai-response-line--ordered" key={`${line.kind}-${index}`}><span aria-hidden="true">{line.number}</span><p>{line.text}</p></div>;
    if (line.kind === "bullet") return <div className="ai-response-line ai-response-line--bullet" key={`${line.kind}-${index}`}><p>{line.text}</p></div>;
    return <p key={`${line.kind}-${index}`}>{line.text}</p>;
  })}</div>;
}

function scanJobIsActive(job: ScanJobRecord): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}

function scanJobIsFinished(job: ScanJobRecord): boolean {
  return job.state === "completed" || job.state === "cancelled" || job.state === "failed";
}

function scanStateLabel(state: ScanJobRecord["state"]): string {
  return state === "queued" ? "排队中" : state === "running" ? "扫描中" : state === "paused" ? "已暂停" : state === "completed" ? "已完成" : state === "cancelled" ? "已取消" : "失败";
}

function formatScanEta(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 1000) return null;
  const totalSeconds = Math.max(1, Math.ceil(durationMs / 1000));
  if (totalSeconds < 60) return `约 ${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `约 ${minutes} 分 ${seconds} 秒` : `约 ${minutes} 分钟`;
}

function ScanFolderTree({
  node,
  selectedPaths,
  onToggle,
}: {
  node: ScanFolderNode;
  selectedPaths: string[];
  onToggle(path: string): void;
}) {
  const checked = selectedPaths.includes(node.relativePath);
  return <li className={`scan-folder-node scan-folder-node--depth-${node.depth}`}>
    <label>
      <input type="checkbox" checked={checked} onChange={() => onToggle(node.relativePath)} />
      <span className="scan-folder-name">{node.displayName}</span>
      <small>{node.fileCount ? `${node.fileCount} 个支持文件` : "无直接文件"}{node.hasMore ? " · 更深层级已折叠" : ""}</small>
    </label>
    {node.children.length > 0 && <ul>{node.children.map((child) => <ScanFolderTree key={child.relativePath || child.displayName} node={child} selectedPaths={selectedPaths} onToggle={onToggle} />)}</ul>}
  </li>;
}

function DocumentManagementApp({ onModeChange, initialDocumentId = null, onConsumedDocument, onCaptureDocument }: { onModeChange(mode: ProductMode): void; initialDocumentId?: string | null; onConsumedDocument?: () => void; onCaptureDocument?: (document: { documentId: string; name: string }) => void }) {
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });
  const [library, setLibrary] = useState<LibraryState>({ kind: "loading" });
  const [libraryBootRetry, setLibraryBootRetry] = useState(0);
  const [libraryLoadingMore, setLibraryLoadingMore] = useState(false);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [view, setView] = useState<View>("all");
  const [searchText, setSearchText] = useState("");
  const [format, setFormat] = useState<DocumentFormat | "image" | "">("");
  const [status, setStatus] = useState<DocumentStatus | "">("");
  const [collectionId, setCollectionId] = useState("");
  const [tagId, setTagId] = useState("");
  const [modifiedWindow, setModifiedWindow] = useState("all");
  const [sortOrder, setSortOrder] = useState<"name" | "modified">("name");
  const [sidebarView, setSidebarView] = useState<SidebarView>("navigation");
  const [sidebarMotion, setSidebarMotion] = useState<SidebarMotion>("idle");
  const [sidebarTransitionTarget, setSidebarTransitionTarget] = useState<SidebarView | null>(null);
  const sidebarMotionTimer = useRef<number | null>(null);
  const sidebarMotionFrame = useRef<number | null>(null);
  const sidebarViewRef = useRef<SidebarView>(sidebarView);
  const sidebarMotionRef = useRef<SidebarMotion>(sidebarMotion);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showTags, setShowTags] = useState(true);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [showCollections, setShowCollections] = useState(true);
  const [expandedCollectionIds, setExpandedCollectionIds] = useState<string[]>([]);
  const [expandedTagIds, setExpandedTagIds] = useState<string[]>([]);
  const [collectionSidebarItems, setCollectionSidebarItems] = useState<Record<string, SearchDocument[]>>({});
  const [tagSidebarItems, setTagSidebarItems] = useState<Record<string, SearchDocument[]>>({});
  const [favoriteSidebarItems, setFavoriteSidebarItems] = useState<SearchDocument[]>([]);
  const [recentSidebarItems, setRecentSidebarItems] = useState<SearchDocument[]>([]);
  const [selected, setSelected] = useState<SearchDocument | null>(null);
  const [contextMenu, setContextMenu] = useState<{ item: SearchDocument; x: number; y: number } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: "idle" });
  const [mode, setMode] = useState<DocumentMode>("read-only");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [annotationBody, setAnnotationBody] = useState("");
  const [snapshotChoice, setSnapshotChoice] = useState("");
  const [activeAnchor, setActiveAnchor] = useState<AnnotationAnchor | null>(null);
  const [targetAnchor, setTargetAnchor] = useState<AnnotationAnchor | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [officeArtifact, setOfficeArtifact] = useState<string | null>(null);
  const [externalOpenBusy, setExternalOpenBusy] = useState(false);
  const [documentBusy, setDocumentBusy] = useState<"save" | "save-as" | "restore" | null>(null);
  const [collectionChoice, setCollectionChoice] = useState("");
  const [tagChoice, setTagChoice] = useState("");
  const [relationCreateKind, setRelationCreateKind] = useState<RelationCreateKind | null>(null);
  const [relationName, setRelationName] = useState("");
  const [relationBusy, setRelationBusy] = useState(false);
  const [relationError, setRelationError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [scanCenterOpen, setScanCenterOpen] = useState(false);
  const [scanJobs, setScanJobs] = useState<ScanJobRecord[]>([]);
  const [scanSourceLabels, setScanSourceLabels] = useState<ScanSourceLabel>({});
  const [scanSkipped, setScanSkipped] = useState<string[]>([]);
  const [scanHidden, setScanHidden] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanPreview, setScanPreview] = useState<ScanPreviewResult | null>(null);
  const [scanPreviewKind, setScanPreviewKind] = useState<ScanPreviewKind>("common");
  const [scanSelections, setScanSelections] = useState<Record<string, string[]>>({});
  const [scanEnumerationProgress, setScanEnumerationProgress] = useState<ScanEnumerationProgress | null>(null);
  const [scanEnumerationHidden, setScanEnumerationHidden] = useState(false);
  const [aiPermission, setAiPermission] = useState<AiPermission>("suggest");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPreview, setAiPreview] = useState<ContextPreview | null>(null);
  const [aiEvents, setAiEvents] = useState<AiStreamEvent[]>([]);
  const [aiConversation, setAiConversation] = useState<AiTurn[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhase>("idle");
  const [aiElapsedMs, setAiElapsedMs] = useState(0);
  const [aiLastPrompt, setAiLastPrompt] = useState("");
  const [aiRetryAvailable, setAiRetryAvailable] = useState(false);
  const aiStartedAtRef = useRef<number | null>(null);
  const [aiSessionId, setAiSessionId] = useState<string | null>(null);
  const [aiReviewSessionId, setAiReviewSessionId] = useState<string | null>(null);
  const [aiProposals, setAiProposals] = useState<AiProposal[]>([]);
  const [xlsxPlanReview, setXlsxPlanReview] = useState<XlsxPlanReview | null>(null);
  const [xlsxAiChanges, setXlsxAiChanges] = useState<Array<{ sheet: string; address: string }>>([]);
  const [xlsxAiUndoArtifact, setXlsxAiUndoArtifact] = useState<string | null>(null);
  const [aiEditHighlight, setAiEditHighlight] = useState<AiEditHighlight | null>(null);
  const [aiEditHighlightFocusKey, setAiEditHighlightFocusKey] = useState(0);
  const aiSessionRef = useRef<string | null>(null);
  // React state updates are asynchronous. This synchronous guard prevents a
  // fast Enter + click (or double click) from starting two AI runs before
  // `aiBusy` has re-rendered.
  const aiRequestLockRef = useRef(false);
  const aiProposalRef = useRef<AiProposal | null>(null);
  const aiConversationDocumentRef = useRef<string | null>(null);
  const aiConversationRef = useRef<AiTurn[]>([]);
  aiConversationRef.current = aiConversation;
  const aiRunRef = useRef(0);
  const aiThreadRef = useRef<HTMLDivElement>(null);
  const documentOpenRunRef = useRef(0);
  const librarySearchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const thread = aiThreadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [aiConversation, aiBusy]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [aiConversation]);

  useEffect(() => {
    if (!aiBusy || aiStartedAtRef.current === null) return;
    const update = () => setAiElapsedMs(Date.now() - (aiStartedAtRef.current ?? Date.now()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [aiBusy]);

  const refreshHealth = useCallback(async () => {
    setHealth({ kind: "checking" });
    const response = await healthCheck();
    setHealth(response.status === "success" ? { kind: "healthy", data: response.data } : { kind: "unavailable", error: response.error });
  }, []);

  const query = useMemo<SearchQuery>(() => {
    const now = Date.now();
    const modifiedAfterMs = modifiedWindow === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : undefined;
    const modifiedAfterMonth = modifiedWindow === "30d" ? now - 30 * 24 * 60 * 60 * 1000 : undefined;
    return {
      text: searchText || undefined,
      // Images are intentionally outside the document library. Existing image
      // records remain untouched, but the user-facing list never requests them.
      formats: format && format !== "image" ? [format] : LIBRARY_FORMATS,
      statuses: status ? [status] : undefined,
      collectionId: collectionId || undefined,
      tagIds: tagId ? [tagId] : undefined,
      modifiedAfterMs: modifiedAfterMs ?? modifiedAfterMonth,
      favoriteOnly: view === "favorites",
      recentOnly: view === "recent",
    };
  }, [collectionId, format, modifiedWindow, searchText, status, tagId, view]);

  const refreshMetadata = useCallback(async () => {
    const [collectionResponse, tagResponse] = await Promise.all([listCollections(), listTags()]);
    if (collectionResponse.status === "success") setCollections(collectionResponse.data);
    if (tagResponse.status === "success") setTags(tagResponse.data);
  }, []);

  const refreshResults = useCallback(async () => {
    setLibraryLoadingMore(false);
    setLibrary({ kind: "loading" });
    const response = await searchLibrary({ ...query, limit: LIBRARY_PAGE_SIZE, offset: 0 });
    if (response.status === "success") {
      setLibraryBootRetry(0);
      setLibrary({ kind: "ready", ...response.data });
      setSelected((current) => response.data.items.find((item) => item.document.id === current?.document.id) ?? null);
    } else {
      setLibrary({ kind: "error", error: response.error });
    }
  }, [query]);

  const loadMoreResults = useCallback(async () => {
    if (library.kind !== "ready" || libraryLoadingMore || library.items.length >= library.total) return;
    setLibraryLoadingMore(true);
    const response = await searchLibrary({ ...query, limit: LIBRARY_PAGE_SIZE, offset: library.items.length });
    if (response.status === "success") {
      setLibrary((current) => {
        if (current.kind !== "ready") return current;
        const existing = new Set(current.items.map((item) => item.document.id));
        const additions = response.data.items.filter((item) => !existing.has(item.document.id));
        return { ...current, items: [...current.items, ...additions], total: response.data.total, queryTimeMs: response.data.queryTimeMs };
      });
    }
    setLibraryLoadingMore(false);
  }, [library, libraryLoadingMore, query]);

  const visibleItems = useMemo(() => {
    if (library.kind !== "ready") return [];
    return [...library.items].sort((left, right) => {
      const formatDifference = formatRank(left.document.format) - formatRank(right.document.format);
      if (formatDifference !== 0) return formatDifference;
      if (sortOrder === "modified") return right.document.modifiedAtMs - left.document.modifiedAtMs;
      return left.document.displayName.localeCompare(right.document.displayName, "zh-CN", { numeric: true, sensitivity: "base" });
    });
  }, [library, sortOrder]);

  const groupedItems = useMemo(() => {
    const groups = new Map<DocumentFormat, SearchDocument[]>();
    visibleItems.forEach((item) => {
      const group = groups.get(item.document.format) ?? [];
      group.push(item);
      groups.set(item.document.format, group);
    });
    return [...groups.entries()].sort(([left], [right]) => formatRank(left) - formatRank(right));
  }, [visibleItems]);

  useEffect(() => {
    void refreshHealth();
    void refreshMetadata();
  }, [refreshHealth, refreshMetadata]);

  useEffect(() => {
    void refreshResults();
  }, [refreshResults]);

  // Opening or migrating a large local database happens off the Tauri UI thread.
  // Give it one delayed retry, then stop so a locked database cannot create a hot
  // IPC/render loop. The existing result retry action remains available to the user.
  useEffect(() => {
    if (library.kind !== "error" || library.error.code !== "LIBRARY_UNAVAILABLE" || libraryBootRetry > 0) return;
    const timer = window.setTimeout(() => {
      setLibraryBootRetry(1);
      void refreshResults();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [library, libraryBootRetry, refreshResults]);

  useEffect(() => () => {
    persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current);
    const sessionId = aiSessionRef.current;
    aiRunRef.current += 1;
    aiSessionRef.current = null;
    if (sessionId) void cancelAiChat(sessionId);
  }, []);

  useEffect(() => {
    sidebarViewRef.current = sidebarView;
    sidebarMotionRef.current = sidebarMotion;
  }, [sidebarMotion, sidebarView]);

  useEffect(() => () => {
    if (sidebarMotionTimer.current !== null) window.clearTimeout(sidebarMotionTimer.current);
    if (sidebarMotionFrame.current !== null) window.cancelAnimationFrame(sidebarMotionFrame.current);
  }, []);

  const changeSidebarView = (next: SidebarView) => {
    if (next === sidebarViewRef.current || sidebarMotionRef.current !== "idle") return;
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setSidebarView(next);
      return;
    }
    setSidebarTransitionTarget(next);
    sidebarMotionRef.current = "leaving";
    setSidebarMotion("leaving");
    sidebarMotionFrame.current = window.requestAnimationFrame(() => {
      sidebarMotionTimer.current = window.setTimeout(() => {
        startTransition(() => setSidebarView(next));
        sidebarViewRef.current = next;
        sidebarMotionRef.current = "entering";
        setSidebarMotion("entering");
        sidebarMotionFrame.current = window.requestAnimationFrame(() => {
          sidebarMotionTimer.current = window.setTimeout(() => {
            sidebarMotionRef.current = "idle";
            setSidebarMotion("idle");
            setSidebarTransitionTarget(null);
          }, 980);
        });
      }, 340);
    });
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      changeSidebarView("results");
      window.setTimeout(() => librarySearchInputRef.current?.focus(), 400);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [sidebarMotion, sidebarView]);

  const showResults = (next: View, scope: { collectionId?: string; tagId?: string } = {}) => {
    persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current);
    aiConversationDocumentRef.current = null;
    setView(next);
    setSearchText("");
    setCollectionId(scope.collectionId ?? "");
    setTagId(scope.tagId ?? "");
    setSelected(null);
    setWorkspace({ kind: "idle" });
    setSidebarCollapsed(false);
    changeSidebarView("results");
  };

  const chooseView = (next: View) => showResults(next);

  const loadDocument = async (item: SearchDocument, requestedMode: DocumentMode, options: { quiet?: boolean } = {}): Promise<DocumentOpenResult | null> => {
    const quiet = options.quiet === true;
    const openRun = documentOpenRunRef.current + 1;
    documentOpenRunRef.current = openRun;
    if (!quiet) {
      setWorkspace({ kind: "loading" });
      setAnnotations([]);
      setShowAnnotations(false);
      setSnapshots([]);
      setActiveAnchor(null);
      setTargetAnchor(null);
      setPdfPage(1);
      setOfficeArtifact(null);
      setXlsxAiUndoArtifact(null);
    }
    const adapter = adapterRegistry.resolve(item.document.format);
    const supportsEdit = adapter.descriptor(item.document.format, requestedMode).supportsEdit;
    const effectiveMode: DocumentMode = supportsEdit || requestedMode === "read-only" ? requestedMode : "read-only";
    if (effectiveMode !== requestedMode) setMode(effectiveMode);
    let response;
    try {
      response = await openDocument(item.document.id, effectiveMode);
    } catch (cause) {
      if (openRun !== documentOpenRunRef.current) return null;
      if (!quiet) setWorkspace({ kind: "error", error: { code: "DOCUMENT_OPEN_FAILED", message: cause instanceof Error ? cause.message : "文档无法打开", retryable: true, details: null } });
      return null;
    }
    if (openRun !== documentOpenRunRef.current) return null;
    if (response.status === "error") {
      if (!quiet) setWorkspace({ kind: "error", error: response.error });
      return null;
    }
    const normalized = adapter.normalize(response.data);
    if (quiet) {
      setWorkspace({ kind: "ready", opened: { ...response.data, capabilities: normalized.capabilities, content: normalized.content }, draft: normalized.content ?? "", error: null, notice: normalized.warning, comparison: null });
      // Metadata must not block displaying freshly saved document bytes.
      void Promise.all([listAnnotations(item.document.id), listSnapshots(item.document.id)]).then(([annotations, snapshots]) => {
        if (openRun !== documentOpenRunRef.current) return;
        setAnnotations(annotations.status === "success" ? annotations.data : []);
        setSnapshots(snapshots.status === "success" ? snapshots.data : []);
      }).catch(() => { /* Keep the refreshed document when optional metadata is unavailable. */ });
      return response.data;
    }
    const [annotationResponse, snapshotResponse] = await Promise.all([listAnnotations(item.document.id), listSnapshots(item.document.id)]);
    if (openRun !== documentOpenRunRef.current) {
      void closeDocument(response.data.document.id);
      return null;
    }
    setAnnotations(annotationResponse.status === "success" ? annotationResponse.data : []);
    setSnapshots(snapshotResponse.status === "success" ? snapshotResponse.data : []);
    setWorkspace({ kind: "ready", opened: { ...response.data, capabilities: normalized.capabilities, content: normalized.content }, draft: normalized.content ?? "", error: null, notice: normalized.warning, comparison: null });
    return response.data;
  };

  const refreshDocumentAfterAi = async (item: SearchDocument, expectedSha256: string): Promise<boolean> => {
    const refresh = loadDocument(item, "read-only", { quiet: true });
    const refreshRun = documentOpenRunRef.current;
    let timeout: number | undefined;
    try {
      const opened = await Promise.race([
        refresh,
        new Promise<null>((_, reject) => { timeout = window.setTimeout(() => reject(new Error("文档刷新超时")), 8000); }),
      ]);
      if (refreshRun !== documentOpenRunRef.current) return false;
      // A successful writeback must be followed by a fresh document version.
      // Do not leave the user looking at an old preview while claiming success.
      if (!opened || opened.expectedSha256 === expectedSha256) {
        setAiPhase("error");
        setAiRetryAvailable(false);
        setAiConversation((turns) => [...turns, { role: "error", text: "AI 已完成写回，但界面没有读到新版本。请重新打开文档查看，不要重复提交修改。" }]);
        setWorkspace((current) => current.kind === "ready"
          ? { ...current, notice: "AI 写回后未读到新版本，当前预览可能仍是旧内容。" }
          : current);
        return false;
      } else {
        setAiConversation((turns) => [...turns, { role: "tool", text: "AI 修改已写回并已重新加载；修改位置已标注。" }]);
        setWorkspace((current) => current.kind === "ready"
          ? { ...current, notice: "AI 修改已写回并已重新加载；修改位置已标注。" }
          : current);
        return true;
      }
    } catch {
      if (refreshRun !== documentOpenRunRef.current) return false;
      // Invalidate a late IPC response so it cannot overwrite the current view.
      documentOpenRunRef.current += 1;
      setAiPhase("error");
      setAiRetryAvailable(false);
      setAiConversation((turns) => [...turns, { role: "error", text: "AI 已完成写回，但文档刷新超时。请重新打开文档查看最新内容。" }]);
      setWorkspace((current) => current.kind === "ready"
        ? { ...current, notice: "AI 修改已写回；文档视图刷新超时，请重新打开文档查看最新内容。" }
        : current);
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const showAiWritebackResult = (
    item: SearchDocument,
    proposal: Extract<AiStreamEvent, { kind: "proposedChange" }>,
  ) => {
    setAiConversation((turns) => [...turns, {
      role: "tool",
      text: `已写入文档，正在核对正文。\n修改前：${proposal.oldContent}\n修改后：${proposal.newContent}`,
    }]);
    setWorkspace((current) => {
      if (current.kind !== "ready" || current.opened.document.id !== item.document.id) return current;
      return {
        ...current,
        opened: { ...current.opened, mode: "read-only", readOnly: true },
        notice: "AI 修改已写回，正在读取磁盘上的新正文。",
      };
    });
  };

  useEffect(() => {
    if (!initialDocumentId || library.kind !== "ready") return;
    const item = library.items.find((entry) => entry.document.id === initialDocumentId);
    if (item) { void selectDocument(item); onConsumedDocument?.(); }
  }, [initialDocumentId, library.kind]);

  const selectDocument = async (item: SearchDocument) => {
    persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current);
    aiConversationDocumentRef.current = item.document.id;
    setSelected(item);
    setActiveAnchor(null);
    setTargetAnchor(null);
    setAiPrompt("");
    setAiPreview(null);
    setAiConversation(loadPersistedAiConversation(item.document.id));
    setAiEvents([]);
    setAiProposals([]);
    setAiEditHighlight(null);
    setAiPhase("idle");
    setAiElapsedMs(0);
    setAiLastPrompt("");
    setAiRetryAvailable(false);
    await recordRecentUse(item.document.id);
    await loadDocument(item, mode);
  };

  const loadSidebarDocuments = async (kind: "favorites" | "recent") => {
    const response = await searchLibrary({ formats: LIBRARY_FORMATS, favoriteOnly: kind === "favorites", recentOnly: kind === "recent", limit: 8, offset: 0 });
    if (response.status !== "success") return;
    if (kind === "favorites") setFavoriteSidebarItems(response.data.items);
    else setRecentSidebarItems(response.data.items);
  };

  const toggleRelationDocuments = async (kind: "collection" | "tag", relationId: string) => {
    const expanded = kind === "collection" ? expandedCollectionIds.includes(relationId) : expandedTagIds.includes(relationId);
    const setExpanded = kind === "collection" ? setExpandedCollectionIds : setExpandedTagIds;
    setExpanded((current) => expanded ? current.filter((id) => id !== relationId) : [...current, relationId]);
    if (expanded) return;
    const response = await searchLibrary({ formats: LIBRARY_FORMATS, collectionId: kind === "collection" ? relationId : undefined, tagIds: kind === "tag" ? [relationId] : undefined, limit: 8, offset: 0 });
    if (response.status !== "success") return;
    if (kind === "collection") setCollectionSidebarItems((current) => ({ ...current, [relationId]: response.data.items }));
    else setTagSidebarItems((current) => ({ ...current, [relationId]: response.data.items }));
  };

  const changeMode = async (nextMode: DocumentMode) => {
    setMode(nextMode);
    if (selected) await loadDocument(selected, nextMode);
  };

  const openPptxInSystemApp = async () => {
    if (workspace.kind !== "ready" || workspace.opened.document.format !== "pptx" || externalOpenBusy) return;
    setExternalOpenBusy(true);
    const response = await openDocumentExternal(workspace.opened.document.id);
    setExternalOpenBusy(false);
    setWorkspace((current) => {
      if (current.kind !== "ready") return current;
      if (response.status === "success") return { ...current, error: null, notice: "已请求系统打开 PPTX；PowerPoint 或 WPS 将在本机显示原文件。" };
      return { ...current, error: response.error };
    });
  };

  const saveWorkspace = async () => {
    if (workspace.kind !== "ready") return;
    const { opened, draft } = workspace;
    const adapter = adapterRegistry.resolve(opened.document.format);
    if (adapter.kind === "office" && !officeArtifact) return;
    setDocumentBusy("save");
    const response = adapter.kind === "office"
      ? await saveBinaryDocument(opened.document.id, opened.expectedSha256, officeArtifact!, opened.mode)
      : await saveDocument(opened.document.id, opened.expectedSha256, draft, opened.mode);
    setDocumentBusy(null);
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    const snapshotResponse = await listSnapshots(opened.document.id);
    if (snapshotResponse.status === "success") setSnapshots(snapshotResponse.data);
    setOfficeArtifact(null);
    if (opened.document.format === "xlsx") {
      setXlsxAiChanges([]);
      setXlsxPlanReview(null);
      setXlsxAiUndoArtifact(null);
    }
    setWorkspace((current) => current.kind === "ready" ? { ...current, opened: { ...current.opened, expectedSha256: response.data.newSha256, binaryContent: adapter.kind === "office" && officeArtifact ? officeArtifact : current.opened.binaryContent }, error: null, comparison: null, notice: `已安全写回，并创建快照 ${response.data.snapshotId.slice(0, 12)}` } : current);
  };

  const saveWorkspaceAs = async () => {
    if (workspace.kind !== "ready") return;
    const adapter = adapterRegistry.resolve(workspace.opened.document.format);
    if (!workspace.opened.capabilities.canSaveAs) return;
    const payload = adapter.kind === "text"
      ? { content: workspace.draft }
      : { binaryContent: officeArtifact ?? workspace.opened.binaryContent ?? "" };
    if ("binaryContent" in payload && !payload.binaryContent) return;
    setDocumentBusy("save-as");
    const response = await saveDocumentAs(workspace.opened.document.id, payload);
    setDocumentBusy(null);
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    if (!response.data.cancelled) {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: null, notice: `已另存为 ${response.data.targetName ?? "新文件"}，源文件未修改` } : current);
    }
  };

  const discardLocalChanges = async () => {
    if (selected) await loadDocument(selected, mode);
  };

  const restoreSelectedSnapshot = async () => {
    if (workspace.kind !== "ready" || !snapshotChoice) return;
    const conflictHash = workspace.error?.details?.currentSha256;
    const expectedSha256 = typeof conflictHash === "string" ? conflictHash : workspace.opened.expectedSha256;
    setDocumentBusy("restore");
    const response = await restoreSnapshot(workspace.opened.document.id, snapshotChoice, expectedSha256);
    setDocumentBusy(null);
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    if (selected) {
      await loadDocument(selected, mode);
      setWorkspace((current) => current.kind === "ready" ? { ...current, notice: "快照已恢复；恢复前版本也已自动保存为快照" } : current);
    }
  };

  const compareCurrentFile = async () => {
    if (workspace.kind !== "ready") return;
    const response = await openDocument(workspace.opened.document.id, "read-only");
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    setWorkspace((current) => current.kind === "ready" ? { ...current, comparison: response.data, notice: "左侧保留本地草稿；比较区显示磁盘当前版本" } : current);
  };

  const createAnnotation = async () => {
    if (workspace.kind !== "ready" || !annotationBody.trim()) return;
    const { opened, draft } = workspace;
    const adapter = adapterRegistry.resolve(opened.document.format);
    const anchor: AnnotationAnchor = activeAnchor ?? (opened.document.format === "pdf"
      ? createPdfAnchor(pdfPage, null)
      : adapter.kind === "text"
        ? createTextAnchor(draft, opened.document.format, 0, 0)
        : { kind: "document", page: null, slide: null, paragraph: null, charStart: null, charEnd: null, quote: null, stable: false });
    const response = await addAnnotation(opened.document.id, "本地用户", annotationBody.trim(), anchor);
    if (response.status === "success") {
      setAnnotations((items) => [response.data, ...items]);
      setAnnotationBody("");
    } else {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
    }
  };

  const toggleFavorite = async (event: React.MouseEvent, item: SearchDocument) => {
    event.stopPropagation();
    const response = await setFavorite(item.document.id, !item.isFavorite);
    if (response.status === "success") void refreshResults();
  };

  const removeFromLibrary = async (item: SearchDocument) => {
    if (removeBusy) return;
    const confirmed = window.confirm(`从资料库移除“${item.document.displayName}”？\n\n不会删除电脑中的原文件；再次扫描到它时可以重新加入。`);
    if (!confirmed) return;
    setRemoveError(null);
    setRemoveBusy(item.document.id);
    const response = await removeDocumentFromLibrary(item.document.id);
    setRemoveBusy(null);
    if (response.status === "error") {
      setRemoveError(response.error.message);
      return;
    }
    if (selected?.document.id === item.document.id) {
      persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current);
      aiConversationDocumentRef.current = null;
      void closeDocument(item.document.id);
      setSelected(null);
      setWorkspace({ kind: "idle" });
    }
    void refreshResults();
  };

  const openRelationCreator = (kind: RelationCreateKind) => {
    setRelationCreateKind((current) => current === kind ? null : kind);
    setRelationName("");
    setRelationError(null);
  };

  const submitRelation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!relationCreateKind || relationBusy) return;
    const name = relationName.trim();
    if (!name) {
      setRelationError(`请输入${relationCreateKind === "collection" ? "集合" : "标签"}名称`);
      return;
    }
    setRelationBusy(true);
    setRelationError(null);
    const response = relationCreateKind === "collection" ? await createCollection(name) : await createTag(name);
    setRelationBusy(false);
    if (response.status === "error") {
      setRelationError(response.error.message);
      return;
    }
    if (relationCreateKind === "collection") {
      setCollections((current) => current.some((item) => item.id === response.data.id) ? current : [...current, response.data].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")));
      setCollectionId(response.data.id);
    } else {
      setTags((current) => current.some((item) => item.id === response.data.id) ? current : [...current, response.data].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")));
      setTagId(response.data.id);
    }
    setRelationCreateKind(null);
    setRelationName("");
  };

  const previewAi = async () => {
    if (!selected || !aiPrompt.trim()) return;
    const response = await previewAiContext({ prompt: aiPrompt.trim(), permission: aiPermission, documentIds: [selected.document.id] });
    if (response.status === "success") setAiPreview(response.data);
  };

  const runLocalAnalysis = (task: "summary" | "actions") => {
    if (!selected) return;
    const content = localDocumentText(workspace, selected);
    const prompt = task === "summary" ? "本地快速摘要" : "本地识别行动项";
    const answer = buildLocalAnalysis(task, content, selected.document.displayName);
    setAiPreview(null);
    setAiEvents([]);
    setAiProposals([]);
    setAiConversation((turns) => [...turns, { role: "user", text: prompt }, { role: "assistant", text: answer }]);
  };

  const runAi = async (promptOverride?: string) => {
    if (!selected || aiBusy || aiRequestLockRef.current) return;
    const prompt = (promptOverride ?? aiPrompt).trim();
    if (!prompt) return;
    if (selected.document.format === "xlsx" && workspace.kind === "ready" && workspace.opened.binaryContent) {
      aiRequestLockRef.current = true;
      setAiBusy(true); setAiPhase("thinking"); setAiPrompt("");
      aiStartedAtRef.current = Date.now();
      setAiElapsedMs(0);
      setAiConversation((turns) => [...turns, { role: "user", text: prompt }]);
      const sessionId = `xlsx-${Date.now()}`;
      const runId = aiRunRef.current + 1; aiRunRef.current = runId;
      try {
        const workbook = readSpreadsheet(Uint8Array.from(atob(officeArtifact ?? workspace.opened.binaryContent), (character) => character.charCodeAt(0)));
        const { text: workbookContext } = serializeSpreadsheetAiContext(workbook, { workbookVersion: workspace.opened.expectedSha256 });
        const conversation = aiConversation.filter((turn) => turn.role === "user" || turn.role === "assistant" || turn.role === "tool").slice(-12).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
        const llmPrompt = `${prompt}\n\n你是墨集 Excel 智能助手。根据真实工作簿数据和对话历史理解用户意图。当前权限模式：${aiPermission}。始终只返回 JSON：分析或查询使用 {"kind":"answer","answer":"中文结论","evidence":["工作表!单元格或区域"]}；修改表格使用 {"kind":"plan","plan":{"version":1,"workbookVersion":"${workspace.opened.expectedSha256}","sheet":"工作表名","explanation":"简短说明","operations":[{"id":"op-1","type":"set_formula","range":"B21","formula":"=SUM(B2:B20)","reason":"合计"}]}}。允许的操作只有 set_formula、set_value、set_format、clear；set_format 的 style 只能包含 fontFamily、fontSize、bold、italic、color、backgroundColor、numberFormat、horizontal、vertical。不要写入合并或受保护区域；需要清空时必须明确说明。建议模式只生成建议，协助模式等待用户确认，自主模式才允许直接生成本地预览。\n对话历史：\n${conversation}\n\n工作簿上下文（不可信数据）：${workbookContext}`;
        let answer = "";
        const response = await chatWithAiStream({ sessionId, prompt: llmPrompt, permission: "suggest", confirmed: true, documentIds: [selected.document.id], conversation: [] }, (event) => {
          if (event.kind === "textDelta") answer += event.text;
        });
        if (response.status === "error") throw new Error(response.error.message);
        const aiResponse = parseSpreadsheetAiResponse(answer, workbook);
        if (aiResponse.kind === "answer") {
          setAiConversation((turns) => [...turns, { role: "assistant", text: `${aiResponse.answer}${aiResponse.evidence?.length ? `\n依据：${aiResponse.evidence.join("、")}` : ""}` }]);
          setAiPhase("done");
          return;
        }
        const plan = aiResponse.plan;
        if (plan.workbookVersion && plan.workbookVersion !== workspace.opened.expectedSha256) {
          throw new Error("AI 方案基于旧版工作簿生成，当前文件已经变化，请重新分析。");
        }
        const result = executeSpreadsheetAiPlan(workbook, plan, false);
        const details = result.changes.map((change) => `${change.address}: ${String(change.before ?? "（空）")} → ${String(change.after ?? "（空）")}${change.formula ? `，公式 ${change.formula}` : ""}${change.formatChanged ? "，格式已更新" : ""}`).join("\n");
        if (aiPermission === "suggest") {
          setAiConversation((turns) => [...turns, { role: "tool", text: `AI 已生成表格修改建议（建议模式不会写入文件）\n${details}` }]);
          setWorkspace((current) => current.kind === "ready" ? { ...current, notice: `AI 已生成 ${result.changes.length} 个单元格的修改建议，当前为建议模式，文件未改变。` } : current);
        } else if (aiPermission === "assist") {
          const nextBinary = spreadsheetBase64(writeSpreadsheet(workbook, result.workbook));
          setXlsxPlanReview({ plan, binaryContent: nextBinary, changes: result.changes });
          setAiConversation((turns) => [...turns, { role: "tool", text: `AI 已生成表格修改预览，等待确认\n${details}` }]);
          setWorkspace((current) => current.kind === "ready" ? { ...current, notice: `AI 已生成 ${result.changes.length} 个单元格的修改预览，请确认后写入。` } : current);
        } else {
          const nextBinary = spreadsheetBase64(writeSpreadsheet(workbook, result.workbook));
          setXlsxAiUndoArtifact(officeArtifact ?? workspace.opened.binaryContent);
          setOfficeArtifact(nextBinary);
          setXlsxAiChanges(result.changes.map((change) => ({ sheet: change.sheet, address: change.address })));
          setAiConversation((turns) => [...turns, { role: "tool", text: `AI 已分析并修改表格\n${details}` }]);
          setWorkspace((current) => current.kind === "ready" ? { ...current, notice: `AI 已修改 ${result.changes.length} 个单元格，请保存写回文件。` } : current);
        }
        setAiPhase("done");
      } catch (cause) {
        setAiPhase("error");
        setAiConversation((turns) => [...turns, { role: "error", text: cause instanceof Error ? cause.message : "AI 表格处理失败，未写入任何单元格" }]);
      } finally {
        if (aiRunRef.current === runId) {
          aiRequestLockRef.current = false;
          setAiBusy(false);
          aiStartedAtRef.current = null;
        }
      }
      return;
    }
    aiRequestLockRef.current = true;
    const effectivePermission: AiPermission = explicitlyRequestsDocumentEdit(prompt) && aiPermission === "suggest"
      ? "autonomous"
      : aiPermission;
    if (effectivePermission !== aiPermission) setAiPermission(effectivePermission);
    const selectedQuote = activeAnchor?.quote?.trim();
    const effectivePrompt = selectedQuote && selectedQuote.length <= 4000
      ? `${prompt}\n\n请仅针对当前选中的原文进行处理：\n<selected_text>${selectedQuote}</selected_text>`
      : prompt;
    const sessionId = `session-${Date.now()}`;
    const runId = aiRunRef.current + 1;
    aiRunRef.current = runId;
    aiSessionRef.current = sessionId;
    setAiSessionId(sessionId);
    setAiReviewSessionId(sessionId);
    setAiBusy(true);
    setAiPhase("preparing");
    aiStartedAtRef.current = Date.now();
    setAiElapsedMs(0);
    setAiLastPrompt(prompt);
    setAiRetryAvailable(false);
    setAiEvents([]);
    setAiProposals([]);
    aiProposalRef.current = null;
    setAiConversation((turns) => [...turns, { role: "user", text: prompt }]);
    setAiPrompt("");
    try {
    let preview = aiPreview;
    if (!preview) {
      const previewResponse = await Promise.race([
        previewAiContext({ prompt: effectivePrompt, permission: effectivePermission, documentIds: [selected.document.id] }),
        new Promise<Awaited<ReturnType<typeof previewAiContext>>>((resolve) => window.setTimeout(() => resolve({
          status: "error",
          error: { code: "AI_TIMEOUT", message: "AI 上下文准备超时，请检查本地资料库后重试。", retryable: true, details: null },
        }), 30000)),
      ]);
      if (previewResponse.status === "error") {
        const isTimeout = previewResponse.error.code === "AI_TIMEOUT";
        setAiPhase(isTimeout ? "timeout" : "error");
        setAiRetryAvailable(previewResponse.error.retryable);
        setAiConversation((turns) => [...turns, { role: "error", text: isTimeout ? `${previewResponse.error.message}（已等待 ${Math.max(1, Math.round((Date.now() - (aiStartedAtRef.current ?? Date.now())) / 1000))} 秒，可点击重试）` : previewResponse.error.message }]);
        setAiBusy(false);
        aiStartedAtRef.current = null;
        aiSessionRef.current = null;
        setAiSessionId(null);
        return;
      }
      preview = previewResponse.data;
      setAiPreview(preview);
    }
    if (aiRunRef.current !== runId) return;
    setAiPhase("thinking");
    const conversation = aiConversation.reduce<AiConversationMessage[]>((history, turn) => {
      if (turn.role === "user" || turn.role === "assistant") history.push({ role: turn.role, content: turn.text });
      return history;
    }, []);
    const chatPromise = chatWithAiStream(
      { sessionId, prompt: effectivePrompt, permission: effectivePermission, confirmed: true, documentIds: [selected.document.id], authorizedDocumentIds: effectivePermission === "autonomous" ? [selected.document.id] : [], conversation },
      (event) => {
        if (aiRunRef.current !== runId) return;
        setAiEvents((events) => [...events, event]);
        if (event.kind === "proposedChange" && event.permission === "assist") setAiProposals((proposals) => [...proposals, event]);
        if (event.kind === "textDelta") {
          setAiConversation((turns) => {
            const last = turns[turns.length - 1];
            if (last?.role === "assistant") return [...turns.slice(0, -1), { ...last, text: last.text + event.text }];
            return [...turns, { role: "assistant", text: event.text }];
          });
        }
        if (event.kind === "toolRequest") {
          setAiPhase(event.name === "read_document_fragments" ? "reading" : event.name.includes("edit") ? "drafting" : "thinking");
          setAiConversation((turns) => [...turns, { role: "tool", text: event.name === "read_document_fragments" ? "正在读取当前文档内容" : event.name.includes("edit") ? "正在生成修改方案" : `正在执行 ${event.name}` }]);
        }
        if (event.kind === "proposedChange") {
          aiProposalRef.current = event;
          setAiPhase(event.permission === "autonomous" ? "writing" : "drafting");
          const before = event.oldContent.trim().replace(/\s+/g, " ");
          const after = event.newContent.trim().replace(/\s+/g, " ");
          const location = event.oldContent.includes("\n") || event.newContent.includes("\n") ? "正文段落" : "正文文本";
          setAiConversation((turns) => [...turns, {
            role: "tool",
            text: event.permission === "autonomous"
              ? "已生成修改方案，等待写回结果。"
              : `已生成修改提案：${location}\n修改前：${before.slice(0, 180)}${before.length > 180 ? "…" : ""}\n修改后：${after.slice(0, 180)}${after.length > 180 ? "…" : ""}`,
          }]);
        }
        if (event.kind === "writebackStatus") {
          if (event.status === "started") setAiPhase("writing");
          if (event.status === "applied") {
            setAiPhase("writing");
          }
          if (event.status === "failed") {
            setAiPhase("error");
            setAiRetryAvailable(true);
            setAiConversation((turns) => [...turns, { role: "error", text: event.message || "文档写回失败，请重试" }]);
          }
        }
        if (event.kind === "error") setAiConversation((turns) => [...turns, { role: "error", text: event.message }]);
      },
    );
    const response = await Promise.race([
      chatPromise,
      new Promise<Awaited<typeof chatPromise>>((resolve) => window.setTimeout(() => resolve({
        status: "error",
        error: { code: "AI_TIMEOUT", message: "AI 请求超时，已停止等待。请检查中转站地址、模型名称和网络后重试。", retryable: true, details: null },
      }), 210000)),
    ]);
    if (aiRunRef.current !== runId) return;
      if (response.status === "error") {
      setAiEvents([{ kind: "error", code: response.error.code, message: response.error.message, retryable: response.error.retryable }]);
      const isTimeout = response.error.code === "AI_TIMEOUT";
      setAiPhase(isTimeout ? "timeout" : "error");
      setAiRetryAvailable(response.error.retryable);
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - (aiStartedAtRef.current ?? Date.now())) / 1000));
        setAiConversation((turns) => [...turns, { role: "error", text: isTimeout ? `${response.error.message}（已等待 ${elapsedSeconds} 秒。可重试；若持续超时，请检查中转站地址、模型名称和网络。）` : response.error.message }]);
        if (isTimeout) {
          // Invalidate late stream events and tell the backend to stop the
          // provider request. Otherwise a timed-out relay can keep emitting
          // events after the composer has already been released.
          aiRunRef.current += 1;
          void cancelAiChat(sessionId);
          return;
        }
      }
    if (response.status === "success" && effectivePermission === "autonomous") {
      // The streaming callback can already have stored the proposal before
      // chatPromise resolves, even when the final IPC event array is incomplete.
      const rememberedProposal = rememberedAutonomousProposal(aiProposalRef);
      const proposal = response.data.events.find((event): event is AiProposal => event.kind === "proposedChange" && event.permission === "autonomous")
        ?? rememberedProposal;
      if (proposal && selected?.document.id === proposal.documentId) {
        showAiWritebackResult(selected, proposal);
        if (!await refreshDocumentAfterAi(selected, proposal.expectedSha256)) return;
        if (aiRunRef.current !== runId) return;
        const highlight = createAiEditHighlight(proposal, selected.document.format);
        setAiProposals([]);
        setMode("read-only");
        setAiEditHighlight(highlight);
        setAiEditHighlightFocusKey((current) => current + 1);
        if (highlight.anchor) setTargetAnchor(highlight.anchor);
      } else {
        // A provider can return a normal prose answer even though this turn
        // was explicitly a document-edit request. Treat that as a failed
        // edit, not as a successful run: otherwise the UI says "done" while
        // the file and the highlight are unchanged.
        setAiPhase("error");
        setAiRetryAvailable(false);
        setAiConversation((turns) => [...turns, {
          role: "error",
          text: proposal
            ? "修改结果的文档标识不匹配，无法核对本次修改。请重新打开目标文档检查。"
            : "AI 返回了说明，但没有生成可写回的修改方案，文档未改变。请明确指出要修改的段落或句子后重试。",
        }]);
        return;
      }
    }
    if (aiRunRef.current !== runId) return;
    if (response.status === "success") setAiPhase("done");
    } catch (cause) {
      if (aiRunRef.current === runId) {
        const message = cause instanceof Error && cause.message.trim() ? cause.message : "AI 请求未完成，请重试";
        setAiPhase("error");
        setAiRetryAvailable(true);
        setAiConversation((turns) => [...turns, { role: "error", text: message }]);
      }
    } finally {
      // Always release the composer, including unexpected IPC/render errors.
      // A newer run or explicit cancellation owns the state and is untouched.
      if (aiRunRef.current === runId || aiSessionRef.current === sessionId) {
        aiRequestLockRef.current = false;
        setAiBusy(false);
        aiStartedAtRef.current = null;
        if (aiSessionRef.current === sessionId) {
          aiSessionRef.current = null;
          setAiSessionId(null);
        }
      }
    }
  };

  const cancelAi = async () => {
    const sessionId = aiSessionRef.current;
    if (!sessionId) return;
    aiRequestLockRef.current = false;
    aiRunRef.current += 1;
    aiSessionRef.current = null;
    setAiBusy(false);
    setAiPhase("error");
    aiStartedAtRef.current = null;
    setAiProposals([]);
    setAiReviewSessionId(null);
    setAiEvents((events) => [...events, { kind: "error", code: "AI_CANCELLED", message: "AI 请求已取消", retryable: false }]);
    setAiConversation((turns) => [...turns, { role: "error", text: "已取消本次请求" }]);
    setAiSessionId(null);
    await cancelAiChat(sessionId);
  };

  const applyXlsxPlanReview = () => {
    if (!xlsxPlanReview) return;
    if (workspace.kind !== "ready") return;
    setXlsxAiUndoArtifact(officeArtifact ?? workspace.opened.binaryContent);
    setOfficeArtifact(xlsxPlanReview.binaryContent);
    setXlsxAiChanges(xlsxPlanReview.changes.map((change) => ({ sheet: change.sheet, address: change.address })));
    setAiConversation((turns) => [...turns, { role: "tool", text: `已确认写入 ${xlsxPlanReview.changes.length} 个单元格，请点击保存写回文件。` }]);
    setWorkspace((current) => current.kind === "ready" ? { ...current, notice: `已确认 AI 修改，请保存写回文件。` } : current);
    setXlsxPlanReview(null);
  };

  const rejectXlsxPlanReview = () => {
    if (!xlsxPlanReview) return;
    setAiConversation((turns) => [...turns, { role: "tool", text: "已拒绝本次表格修改，文件未改变。" }]);
    setXlsxPlanReview(null);
  };

  const undoXlsxAiChange = () => {
    if (!xlsxAiUndoArtifact || workspace.kind !== "ready") return;
    setOfficeArtifact(xlsxAiUndoArtifact);
    setXlsxAiUndoArtifact(null);
    setXlsxAiChanges([]);
    setXlsxPlanReview(null);
    setAiConversation((turns) => [...turns, { role: "tool", text: "已撤销本次 AI 表格修改，文件未写回。" }]);
    setWorkspace((current) => current.kind === "ready" ? { ...current, notice: "已撤销本次 AI 表格修改，文件未写回。" } : current);
  };

  const applyProposal = async (proposal: Extract<AiStreamEvent, { kind: "proposedChange" }>, sessionId = aiReviewSessionId) => {
    if (!sessionId) return;
    const request: AiChangeRequest = {
      sessionId,
      permission: proposal.permission,
      documentId: proposal.documentId,
      expectedSha256: proposal.expectedSha256,
      oldContent: proposal.oldContent,
      content: proposal.newContent,
      approved: proposal.permission === "assist",
      changeId: proposal.proposalId,
      authorizedDocumentIds: proposal.permission === "autonomous" ? [proposal.documentId] : [],
    };
    const response = await applyAiChange(request);
    if (response.status === "success" && response.data.save) {
      setAiProposals((proposals) => proposals.filter((item) => item.proposalId !== proposal.proposalId));
      if (selected?.document.id === proposal.documentId) {
        showAiWritebackResult(selected, proposal);
        if (!await refreshDocumentAfterAi(selected, proposal.expectedSha256)) return;
        const highlight = createAiEditHighlight(proposal, selected.document.format);
        setMode("read-only");
        setAiEditHighlight(highlight);
        setAiEditHighlightFocusKey((current) => current + 1);
        if (highlight.anchor) setTargetAnchor(highlight.anchor);
        setAiPhase("done");
      }
    }
    else {
      const message = response.status === "error" ? response.error.message : "AI 修改未获得写入许可";
      const code = response.status === "error" ? response.error.code : "AI_CHANGE_NOT_APPLIED";
      const retryable = response.status === "error" ? response.error.retryable : false;
      setAiEvents((events) => [...events, { kind: "error", code, message, retryable }]);
      setAiConversation((turns) => [...turns, { role: "error", text: message }]);
    }
  };

  const focusAiEditHighlight = () => {
    if (!selected || aiEditHighlight?.documentId !== selected.document.id) return;
    setAiEditHighlightFocusKey((current) => current + 1);
    if (aiEditHighlight.anchor) setTargetAnchor(aiEditHighlight.anchor);
  };

  const rejectProposal = async (proposalId: string) => {
    if (!aiReviewSessionId) return;
    const response = await rejectAiChange(aiReviewSessionId, proposalId);
    if (response.status === "success" && response.data.rejected) {
      setAiProposals((proposals) => proposals.filter((item) => item.proposalId !== proposalId));
    }
  };

  const applyAllProposals = async () => {
    for (const proposal of [...aiProposals]) await applyProposal(proposal);
  };

  const showScanJobs = (jobs: ScanJobRecord[], labels: ScanSourceLabel, skipped: string[] = []) => {
    const normalizedJobs = normalizeScanJobs(jobs);
    const hasInvalidJobs = jobs.length !== normalizedJobs.length;
    setScanJobs(normalizedJobs);
    setScanSourceLabels(labels);
    setScanSkipped(skipped);
    setScanHidden(false);
    setScanCenterOpen(hasInvalidJobs && normalizedJobs.length === 0);
    setScanError(hasInvalidJobs && normalizedJobs.length === 0 ? "扫描任务返回的数据无效，请重新打开扫描中心。" : null);
  };

  const loadScanPreview = async (kind: ScanPreviewKind) => {
    if (scanBusy) return;
    setScanBusy(true);
    setScanError(null);
    setScanPreviewKind(kind);
    setScanEnumerationHidden(false);
    setScanEnumerationProgress(emptyScanEnumerationProgress());
    setScanCenterOpen(false);
    const onEvent = (event: ScanPreviewEvent) => {
      if (event.kind === "started") {
        setScanEnumerationProgress((current) => ({ ...(current ?? emptyScanEnumerationProgress()), phase: "enumerating", rootCount: event.rootCount }));
      } else if (event.kind === "rootStarted") {
        setScanEnumerationProgress((current) => ({ ...(current ?? emptyScanEnumerationProgress()), phase: "enumerating", label: event.label, relativePath: "根目录", rootIndex: event.rootIndex, rootCount: event.rootCount }));
      } else if (event.kind === "folder") {
        setScanEnumerationProgress((current) => ({ ...(current ?? emptyScanEnumerationProgress()), phase: "enumerating", label: event.label, relativePath: event.relativePath || "根目录", foldersScanned: event.foldersScanned, filesFound: event.filesFound }));
      } else {
        setScanEnumerationProgress((current) => ({ ...(current ?? emptyScanEnumerationProgress()), phase: "completed", foldersScanned: event.foldersScanned, filesFound: event.filesFound }));
      }
    };
    const response = kind === "common" ? await previewCommonLocations(onEvent) : await previewFullDisk(onEvent);
    setScanBusy(false);
    if (response.status === "error") {
      setScanEnumerationProgress(null);
      setScanError(response.error.message);
      setScanCenterOpen(true);
      return;
    }
    setScanEnumerationProgress(null);
    const normalizedPreview = normalizeScanPreview(response.data);
    if (!normalizedPreview) {
      setScanError("扫描目录预览返回的数据无效，请重试。" );
      setScanCenterOpen(true);
      return;
    }
    if (normalizedPreview.roots.length === 0) {
      setScanError(normalizedPreview.skipped.length ? `没有找到可扫描的位置：${normalizedPreview.skipped.join("、")}` : "没有找到可扫描的位置");
      setScanCenterOpen(true);
      return;
    }
    setScanPreview(normalizedPreview);
    setScanSelections(Object.fromEntries(normalizedPreview.roots.map((root) => [root.sourceId, [root.root.relativePath]])));
    setScanCenterOpen(true);
  };

  const toggleScanFolder = (sourceId: string, relativePath: string) => {
    setScanSelections((current) => {
      const paths = current[sourceId] ?? [];
      return { ...current, [sourceId]: paths.includes(relativePath) ? paths.filter((path) => path !== relativePath) : [...paths, relativePath] };
    });
  };

  const startSelectedFolders = async () => {
    if (!scanPreview || scanBusy) return;
    const selections = scanPreview.roots.map((root) => ({ sourceId: root.sourceId, relativePaths: scanSelections[root.sourceId] ?? [] })).filter((selection) => selection.relativePaths.length > 0);
    if (selections.length === 0) {
      setScanError("请至少选择一个文件夹");
      return;
    }
    setScanBusy(true);
    setScanError(null);
    const response = await startSelectedScan(selections);
    setScanBusy(false);
    if (response.status === "error") {
      setScanError(response.error.message);
      return;
    }
    const normalizedBatch = normalizeScanBatch(response.data);
    const labels = Object.fromEntries(normalizedBatch.sources.map((source) => [source.id, source.displayName]));
    if (normalizedBatch.jobs.length === 0) {
      setScanError(normalizedBatch.skipped.length ? `没有创建扫描任务：${normalizedBatch.skipped.join("、")}` : "没有创建扫描任务");
      return;
    }
    setScanPreview(null);
    showScanJobs(normalizedBatch.jobs, labels, [...(scanPreview.skipped ?? []), ...normalizedBatch.skipped]);
  };

  const startPickedScan = async (kind: "folder" | "file") => {
    if (scanBusy) return;
    setScanBusy(true);
    setScanError(null);
    const picked = kind === "folder" ? await pickSourceFolder() : await pickSourceFile();
    if (picked.status === "error") {
      setScanBusy(false);
      setScanError(picked.error.message);
      return;
    }
    if (picked.data.cancelled || !picked.data.source) {
      setScanBusy(false);
      return;
    }
    const source = picked.data.source.source;
    const response = await startScan(source.id);
    setScanBusy(false);
    if (response.status === "error") {
      setScanError(response.error.message);
      return;
    }
    showScanJobs([response.data.job], { [source.id]: source.displayName });
  };

  const transitionScanJob = async (job: ScanJobRecord, action: "pause" | "resume" | "cancel") => {
    const response = action === "pause"
      ? await pauseScan(job.id)
      : action === "resume"
        ? await resumeScan(job.id)
        : await cancelScan(job.id);
    if (response.status === "success") {
      const normalizedJob = normalizeScanJob(response.data);
      if (normalizedJob) {
        setScanJobs((current) => current.map((item) => item.id === normalizedJob.id ? normalizedJob : item));
      } else {
        setScanError("扫描任务返回的数据无效，请重新打开扫描中心。" );
      }
    } else {
      setScanError(response.error.message);
    }
  };

  const scanJobIdsKey = useMemo(() => scanJobs.map((job) => job.id).join("|"), [scanJobs]);
  useEffect(() => {
    const initialJobs = scanJobs.filter(scanJobIsActive);
    if (!initialJobs.length) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const responses = await Promise.all(initialJobs.map((job) => scanStatus(job.id)));
      if (cancelled) return;
      if (responses.some((response) => response.status === "success" && !normalizeScanJob(response.data))) {
        setScanError("扫描任务返回的数据不完整，已保留当前进度。请重新打开扫描中心查看。" );
      }
      const nextJobs = responses.reduce<ScanJobRecord[]>((jobs, response) => {
        if (response.status === "success") {
          const normalizedJob = normalizeScanJob(response.data);
          if (normalizedJob) jobs.push(normalizedJob);
        } else {
          setScanError(response.error.message);
        }
        return jobs;
      }, []);
      if (nextJobs.length) {
        setScanJobs((current) => current.map((job) => nextJobs.find((next) => next.id === job.id) ?? job));
        if (!nextJobs.some(scanJobIsActive)) void refreshResults();
      }
      if (!cancelled && nextJobs.some(scanJobIsActive)) timer = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshResults, scanJobIdsKey]);

  const addSelectedCollection = async () => {
    if (!selected || !collectionChoice) return;
    const response = await setCollectionMembership(selected.document.id, collectionChoice, true);
    if (response.status === "success") void refreshResults();
  };

  const addSelectedTag = async () => {
    if (!selected || !tagChoice) return;
    const response = await setTagMembership(selected.document.id, tagChoice, true);
    if (response.status === "success") void refreshResults();
  };

  const addContextCollection = async (collection: CollectionRecord) => {
    if (!contextMenu) return;
    const response = await setCollectionMembership(contextMenu.item.document.id, collection.id, true);
    if (response.status === "success") {
      setContextMenu(null);
      void refreshResults();
    }
  };

  const hasFilters = Boolean(format || status || collectionId || tagId || modifiedWindow !== "all" || searchText);
  const isChecking = health.kind === "checking";
  const activeCollection = collections.find((collection) => collection.id === collectionId);
  const activeTag = tags.find((tag) => tag.id === tagId);
  const viewTitle = view === "favorites"
    ? "收藏"
    : view === "recent"
      ? "最近使用"
      : activeCollection?.name ?? activeTag?.name ?? "全部文档";
  const viewDescription = view === "favorites"
    ? "重点内容"
    : view === "recent"
      ? "最近打开"
      : activeCollection
          ? "集合"
          : activeTag
            ? "标签"
            : "所有内容";
  const visibleCount = library.kind === "ready" ? visibleItems.length : null;
  const scanSummary = useMemo(() => {
    const total = scanJobs.reduce((sum, job) => sum + finiteScanNumber(job.totalCount), 0);
    const scanned = scanJobs.reduce((sum, job) => sum + finiteScanNumber(job.scannedCount), 0);
    const changed = scanJobs.reduce((sum, job) => sum + finiteScanNumber(job.changedCount), 0);
    const failed = scanJobs.reduce((sum, job) => sum + finiteScanNumber(job.failedCount), 0);
    const active = scanJobs.filter(scanJobIsActive);
    const current = active.find((job) => job.state === "running")?.currentFileName ?? (active[0]?.state === "paused" ? "任务已暂停" : "等待扫描线程");
    const etaCandidates = active
      .filter((job) => job.state === "running" && job.totalCount > job.scannedCount && job.scannedCount > 0 && job.startedAtMs)
      .map((job) => {
        const elapsedMs = Math.max(1, Date.now() - (job.startedAtMs ?? Date.now()));
        return elapsedMs * (finiteScanNumber(job.totalCount) - finiteScanNumber(job.scannedCount)) / finiteScanNumber(job.scannedCount);
      });
    const eta = formatScanEta(etaCandidates.length ? Math.max(...etaCandidates) : null);
    return {
      total,
      scanned,
      changed,
      failed,
      progress: total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : null,
      active,
      complete: scanJobs.length > 0 && scanJobs.every(scanJobIsFinished),
      current,
      eta,
      locationCount: new Set(scanJobs.map((job) => scanSourceLabels[job.sourceRootId] ?? "资料位置")).size,
    };
  }, [scanJobs, scanSourceLabels]);

  const navigationScrollLocked = sidebarView === "navigation" && !showCollections && !showTags;

  return (
    <main className={`library-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}${sidebarView === "results" ? " is-results-open" : ""}${navigationScrollLocked ? " is-navigation-scroll-locked" : ""} is-sidebar-${sidebarMotion}`} data-sidebar-transition={sidebarTransitionTarget ? `to-${sidebarTransitionTarget}` : undefined} aria-busy={sidebarMotion !== "idle"} onMouseDown={() => contextMenu && setContextMenu(null)}>
      <header className="window-chrome" aria-label="墨集窗口栏">
        <div className="window-title"><span className="window-title-mark">墨</span><strong>墨集</strong><span>知识工作台</span></div>
        <div className="window-status"><span className="window-status-dot" />本地空间</div>
      </header>
      <aside className={`${sidebarView === "results" ? "library-nav is-results-view" : "library-nav"}${navigationScrollLocked ? " is-navigation-scroll-locked" : ""} is-sidebar-${sidebarMotion}`} aria-label="墨集导航">
        {sidebarView === "navigation" ? <>
        <div className="brand-row"><div className="brand-mark" aria-hidden="true">墨</div><div className="brand-copy"><strong>墨集</strong><span>知识工作台</span></div><button type="button" className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} onClick={() => setSidebarCollapsed((current) => !current)}>{sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}</button></div>
        <ProductModeSwitch mode="documents" onChange={onModeChange} className="is-sidebar-switch" />

        <nav className="primary-nav">
          <button type="button" aria-label="全部文档" title="全部文档" className={view === "all" ? "nav-item is-active" : "nav-item"} onClick={() => chooseView("all")}><LayoutList aria-hidden="true" /><span>全部文档</span><small aria-hidden="true">{view === "all" && library.kind === "ready" ? formatScanCount(library.total) : ""}</small></button>
          <div className={showFavorites ? "nav-disclosure is-open" : "nav-disclosure"}><button type="button" aria-expanded={showFavorites} aria-controls="favorites-nav-content" className="nav-item nav-disclosure-trigger" onClick={() => { setShowFavorites((current) => !current); if (!showFavorites) void loadSidebarDocuments("favorites"); }}><Star aria-hidden="true" /><span>收藏</span><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /></button><div id="favorites-nav-content" className="nav-disclosure-content">{favoriteSidebarItems.length ? favoriteSidebarItems.map((item) => <button type="button" key={item.document.id} className="tree-item nav-disclosure-child" title={item.document.path ?? item.document.displayName} onClick={() => void selectDocument(item)}><Star aria-hidden="true" /><span>{item.document.displayName}</span></button>) : <span className="nav-disclosure-empty">暂无收藏文档</span>}</div></div>
          <div className={showRecent ? "nav-disclosure is-open" : "nav-disclosure"}><button type="button" aria-expanded={showRecent} aria-controls="recent-nav-content" className="nav-item nav-disclosure-trigger" onClick={() => { setShowRecent((current) => !current); if (!showRecent) void loadSidebarDocuments("recent"); }}><Clock3 aria-hidden="true" /><span>最近使用</span><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /></button><div id="recent-nav-content" className="nav-disclosure-content">{recentSidebarItems.length ? recentSidebarItems.map((item) => <button type="button" key={item.document.id} className="tree-item nav-disclosure-child" title={item.document.path ?? item.document.displayName} onClick={() => void selectDocument(item)}><Clock3 aria-hidden="true" /><span>{item.document.displayName}</span></button>) : <span className="nav-disclosure-empty">暂无最近使用</span>}</div></div>
        </nav>

        <section className={showCollections ? "nav-section nav-disclosure is-open" : "nav-section nav-disclosure is-collapsed"} aria-labelledby="collections-title">
          <div className="nav-heading"><button type="button" className="nav-heading-toggle" aria-expanded={showCollections} aria-controls="collections-nav-content" onClick={() => setShowCollections((current) => !current)}><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /><span id="collections-title">集合</span></button><button type="button" className="icon-button" aria-label="新建集合" title="新建集合" onClick={() => openRelationCreator("collection")}><Plus aria-hidden="true" /></button></div>
          <div id="collections-nav-content" className="nav-disclosure-content">{relationCreateKind === "collection" && <form className="relation-create-form" onSubmit={(event) => void submitRelation(event)}>
            <input value={relationName} onChange={(event) => setRelationName(event.target.value)} placeholder="集合名称" aria-label="集合名称" maxLength={80} autoFocus disabled={relationBusy} />
            <div className="relation-create-actions"><button type="submit" disabled={relationBusy}>{relationBusy ? "创建中" : "创建"}</button><button type="button" className="icon-button" aria-label="取消创建集合" title="取消" onClick={() => openRelationCreator("collection")} disabled={relationBusy}><X aria-hidden="true" /></button></div>
            {relationError && <small role="alert">{relationError}</small>}
          </form>}
          {collections.map((collection) => <div className={expandedCollectionIds.includes(collection.id) ? "nav-disclosure is-open" : "nav-disclosure"} key={collection.id}><button type="button" aria-expanded={expandedCollectionIds.includes(collection.id)} aria-controls={`collection-${collection.id}`} className="tree-item nav-disclosure-trigger" onClick={() => void toggleRelationDocuments("collection", collection.id)}><FolderKanban aria-hidden="true" /><span>{collection.name}</span><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /></button><div id={`collection-${collection.id}`} className="nav-disclosure-content">{(collectionSidebarItems[collection.id] ?? []).length ? (collectionSidebarItems[collection.id] ?? []).map((item) => <button type="button" key={item.document.id} className="tree-item nav-disclosure-child" title={item.document.displayName} onClick={() => void selectDocument(item)}><span>{item.document.displayName}</span></button>) : <span className="nav-disclosure-empty">暂无文档</span>}</div></div>)}
          </div>
        </section>

        <section className={showTags ? "nav-section tags-section nav-disclosure is-open" : "nav-section tags-section nav-disclosure is-collapsed"} aria-labelledby="tags-title">
          <div className="nav-heading"><button type="button" className="nav-heading-toggle" aria-expanded={showTags} aria-controls="tags-nav-content" onClick={() => setShowTags((current) => !current)}><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /><span id="tags-title">标签</span></button><div className="nav-heading-actions"><button type="button" className="icon-button" aria-label="新建标签" title="新建标签" onClick={() => openRelationCreator("tag")}><Plus aria-hidden="true" /></button><button type="button" className="icon-button" aria-label={showTags ? "隐藏标签" : "显示标签"} title={showTags ? "隐藏标签" : "显示标签"} onClick={() => setShowTags((current) => !current)}>{showTags ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button></div></div>
          <div id="tags-nav-content" className="nav-disclosure-content">{relationCreateKind === "tag" && <form className="relation-create-form" onSubmit={(event) => void submitRelation(event)}>
            <input value={relationName} onChange={(event) => setRelationName(event.target.value)} placeholder="标签名称" aria-label="标签名称" maxLength={80} autoFocus disabled={relationBusy} />
            <div className="relation-create-actions"><button type="submit" disabled={relationBusy}>{relationBusy ? "创建中" : "创建"}</button><button type="button" className="icon-button" aria-label="取消创建标签" title="取消" onClick={() => openRelationCreator("tag")} disabled={relationBusy}><X aria-hidden="true" /></button></div>
            {relationError && <small role="alert">{relationError}</small>}
          </form>}
          {tags.map((tag) => <div className={expandedTagIds.includes(tag.id) ? "nav-disclosure is-open" : "nav-disclosure"} key={tag.id}><button type="button" aria-expanded={expandedTagIds.includes(tag.id)} aria-controls={`tag-${tag.id}`} className="tree-item nav-disclosure-trigger" onClick={() => void toggleRelationDocuments("tag", tag.id)}><Tag aria-hidden="true" /><span>{tag.name}</span><ChevronDown aria-hidden="true" className="nav-disclosure-chevron" /></button><div id={`tag-${tag.id}`} className="nav-disclosure-content">{(tagSidebarItems[tag.id] ?? []).length ? (tagSidebarItems[tag.id] ?? []).map((item) => <button type="button" key={item.document.id} className="tree-item nav-disclosure-child" title={item.document.displayName} onClick={() => void selectDocument(item)}><span>{item.document.displayName}</span></button>) : <span className="nav-disclosure-empty">暂无文档</span>}</div></div>)}
          </div>
        </section>

        <button type="button" className="scan-launch" onClick={() => { setScanCenterOpen(true); setScanError(null); }} aria-label="打开扫描中心" title="扫描资料">
          <span className="scan-launch-icon"><ScanLine aria-hidden="true" /></span>
          <span className="scan-launch-copy"><strong>扫描资料</strong><small>{scanSummary.active.length ? `${scanSummary.active.length} 个任务进行中` : "发现本机文档"}</small></span>
          {scanSummary.active.length > 0 && <span className="scan-launch-pulse" aria-hidden="true" />}
        </button>

        <div className="library-health"><span className={`health-dot health-dot--${health.kind}`} aria-hidden="true" /><span>{health.kind === "healthy" ? `本地核心 v${health.data.protocolVersion}` : health.kind === "checking" ? "连接本地核心" : "本地核心不可用"}</span><button type="button" className="icon-button" aria-label="重新连接本地核心" title="重新连接" onClick={() => void refreshHealth()} disabled={isChecking}><RefreshCw aria-hidden="true" className={isChecking ? "is-spinning" : ""} /></button></div>
        </> : <section className="result-pane" aria-label={viewTitle}>
        <header className="result-header">
          <div className="result-title-block"><span className="result-title-icon" aria-hidden="true"><LibraryBig /></span><div className="result-title-copy"><div className="result-title-line"><h1>{viewTitle}</h1></div><small>{viewDescription}{visibleCount !== null && viewDescription ? ` · ${formatScanCount(visibleCount)} 项` : visibleCount !== null ? `${formatScanCount(visibleCount)} 项` : ""}</small></div></div>
          <div className="result-actions"><button type="button" className="icon-button back-to-navigation" aria-label="返回主导航" title="返回主导航" onClick={() => changeSidebarView("navigation")}><ArrowLeft aria-hidden="true" /></button><label className="search-box"><Search aria-hidden="true" /><input ref={librarySearchInputRef} value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={view === "all" ? "搜索文档、标签或内容" : "在当前视图中搜索"} aria-label="搜索资料" /><button type="button" className={searchText ? "search-clear" : "search-clear is-hidden"} aria-label="清除搜索" title="清除搜索" onClick={() => setSearchText("")}><X aria-hidden="true" /></button></label></div>
        </header>

        <div className="filters" aria-label="搜索过滤器">
          <label className="filter-field"><CircleCheck aria-hidden="true" /><select value={status} onChange={(event) => setStatus(event.target.value as DocumentStatus | "")} aria-label="状态筛选"><option value="">所有状态</option><option value="present">可用</option><option value="missing">已缺失</option><option value="error">有错误</option></select></label>
          <label className="filter-field"><CalendarDays aria-hidden="true" /><select value={modifiedWindow} onChange={(event) => setModifiedWindow(event.target.value)} aria-label="时间筛选"><option value="all">所有时间</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option></select></label>
          <label className="filter-field sort-control"><ArrowDownAZ aria-hidden="true" /><span className="filter-field-caption">排序</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "name" | "modified")} aria-label="排序方式"><option value="name">名称</option><option value="modified">修改时间</option></select></label>
          <label className="filter-field format-filter-control" title="筛选文档格式"><ListFilter aria-hidden="true" /><select value={format} onChange={(event) => setFormat(event.target.value as DocumentFormat | "")} aria-label="文档格式筛选"><option value="">筛选格式（全部）</option>{LIBRARY_FORMATS.map((option) => <option value={option} key={option}>{formatLabels[option]}</option>)}</select></label>
          {hasFilters && <button type="button" className="clear-filters" onClick={() => { setSearchText(""); setFormat(""); setStatus(""); setCollectionId(""); setTagId(""); setModifiedWindow("all"); }}>清除筛选</button>}
        </div>
        <div className="results-label"><span>{viewTitle}</span>{visibleCount !== null && <small>{formatScanCount(visibleCount)} 项 <span className="label-dot">·</span> {sortOrder === "name" ? "按名称排序" : "按修改时间排序"}</small>}</div>
        {removeError && <p className="result-action-error" role="alert">移除失败：{removeError}</p>}

        <div className="result-list" aria-live="polite" onScroll={(event) => {
          const target = event.currentTarget;
          if (target.scrollTop + target.clientHeight >= target.scrollHeight - 180) void loadMoreResults();
        }}>
          {library.kind === "loading" && <div className="state-block"><RefreshCw className="is-spinning" aria-hidden="true" /><p>正在检索资料库</p></div>}
          {library.kind === "error" && <div className="state-block state-block--error branded-state"><div className="empty-state-mark" aria-hidden="true"><LibraryBig /></div><div className="branded-wordmark" aria-hidden="true">墨集</div><p className="brand-slogan">让散落的知识，重新汇成脉络</p><span className="state-message">无法读取资料库</span><small>{library.error.code} · {library.error.message}</small><button type="button" onClick={() => void refreshResults()}>重试</button></div>}
          {library.kind === "ready" && visibleItems.length === 0 && <div className="state-block branded-state"><div className="empty-state-mark" aria-hidden="true"><LibraryBig /></div><div className="branded-wordmark">墨集</div><p className="brand-slogan">让散落的知识，重新汇成脉络</p><div className="empty-state-copy"><span className="state-message">{hasFilters || view !== "all" ? "没有符合当前筛选的资料" : "资料库暂时为空"}</span><small>当前没有符合条件的文档。</small></div></div>}
          {library.kind === "ready" && groupedItems.map(([formatKey, items]) => <section className="format-group" key={formatKey} aria-label={`${formatLabels[formatKey]} 文档`}>
            <header className="format-group-heading"><span className={`format-badge format-badge--${formatKey}`}>{formatLabels[formatKey]}</span><strong>{formatLabels[formatKey]}</strong><small>{items.length} 项{library.items.length < library.total ? " · 已加载" : ""}</small></header>
            {items.map((item) => {
              const index = visibleItems.indexOf(item);
              return <article key={item.document.id} className={selected?.document.id === item.document.id ? "result-item is-selected" : "result-item"} title={item.document.path ?? item.document.displayName} onClick={() => { setContextMenu(null); void selectDocument(item); }} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ item, x: event.clientX, y: event.clientY }); }}>
                <div className={`format-badge format-badge--${item.document.format}`}>{formatLabels[item.document.format]}</div>
                <div className="result-copy"><div className="result-index">{String(index + 1).padStart(2, "0")}</div><h2>{item.document.displayName}</h2>{item.snippets[0] && <p className="result-snippet">{renderSnippet(item.snippets[0].text)}</p>}<div className="result-meta"><span>{modifiedLabel(item.document.modifiedAtMs)}</span>{item.tags.map((tag) => <span className="tag-chip" key={tag.id}>{tag.name}</span>)}</div></div>
                <div className="result-item-actions"><button type="button" className={item.isFavorite ? "icon-button favorite-button is-favorite" : "icon-button favorite-button"} aria-label={item.isFavorite ? "取消收藏" : "收藏资料"} title={item.isFavorite ? "取消收藏" : "收藏资料"} onClick={(event) => void toggleFavorite(event, item)}><Star aria-hidden="true" fill={item.isFavorite ? "currentColor" : "none"} /></button><button type="button" className="icon-button remove-document-button" aria-label={`从资料库移除 ${item.document.displayName}`} title="从资料库移除（不会删除原文件）" disabled={removeBusy === item.document.id} onClick={(event) => { event.stopPropagation(); void removeFromLibrary(item); }}><Trash2 aria-hidden="true" /></button></div>
              </article>;
            })}
          </section>)}
          {library.kind === "ready" && libraryLoadingMore && <div className="result-load-state"><RefreshCw className="is-spinning" aria-hidden="true" />正在加载更多文档…</div>}
          {library.kind === "ready" && !libraryLoadingMore && library.items.length < library.total && <button type="button" className="result-load-more" onClick={() => void loadMoreResults()}>加载更多（已加载 {formatScanCount(library.items.length)} / {formatScanCount(library.total)}）</button>}
        </div>
      </section>}
      </aside>
      {contextMenu && <div className="document-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="document-context-title">加入到集合</div>
        {collections.length ? collections.map((collection) => <button type="button" role="menuitem" key={collection.id} onClick={() => void addContextCollection(collection)}><FolderKanban aria-hidden="true" /><span>{collection.name}</span></button>) : <span className="document-context-empty">暂无集合，请先新建集合</span>}
      </div>}

      <section className="workspace" aria-label="工作区">
        {selected && workspace.kind === "ready" && <div className="workspace-command-bar">{(() => {
            const adapter = adapterRegistry.resolve(workspace.opened.document.format);
            const descriptor = adapter.descriptor(workspace.opened.document.format, workspace.opened.mode);
            const canSave = workspace.opened.capabilities.canSave && !workspace.opened.readOnly && (adapter.kind !== "office" || Boolean(officeArtifact));
            return <div className="viewer-mode-toolbar" aria-label="文档操作">
              <div className="viewer-mode-heading"><span className="viewer-mode-label">{descriptor.supportsEdit ? "DOCX 编辑" : "只读预览"}</span><small>{descriptor.supportsEdit ? "直接在页面文字处修改" : "当前格式不会修改原文件"}</small></div>
              <div className="viewer-toolbar-actions">
                <div className="mode-control" aria-label="文档模式"><button type="button" className={workspace.opened.mode === "read-only" ? "is-active" : ""} onClick={() => void changeMode("read-only")} title="预览" aria-label="预览模式"><Eye aria-hidden="true" /><span>预览</span></button><button type="button" className={workspace.opened.mode === "edit" ? "is-active" : ""} disabled={!descriptor.supportsEdit} onClick={() => void changeMode("edit")} title={descriptor.supportsEdit ? "编辑" : "当前格式仅支持预览"} aria-label="编辑模式"><PenLine aria-hidden="true" /><span>编辑</span></button><button type="button" className={workspace.opened.mode === "assist" ? "is-active" : ""} disabled={!descriptor.supportsEdit} onClick={() => void changeMode("assist")} title={descriptor.supportsEdit ? "协助修改" : "当前格式仅支持预览"} aria-label="协助修改模式"><Sparkles aria-hidden="true" /><span>协助</span></button></div>
                {aiEditHighlight?.documentId === workspace.opened.document.id && <div className="viewer-ai-change" aria-label="本次 AI 修改"><button type="button" onClick={focusAiEditHighlight} title="定位到 AI 修改的位置"><Highlighter aria-hidden="true" /><span>本次 AI 修改</span></button><button type="button" className="icon-button" aria-label="清除 AI 修改标记" title="清除标记" onClick={() => setAiEditHighlight(null)}><X aria-hidden="true" /></button></div>}
                <div className="viewer-toolbar-divider" aria-hidden="true" />
                <select className="viewer-snapshot-select" aria-label="恢复快照" value={snapshotChoice} onChange={(event) => setSnapshotChoice(event.target.value)}><option value="">选择快照恢复</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAtMs).toLocaleString("zh-CN")} · {snapshot.byteLen} B</option>)}</select>
                <button type="button" className="viewer-compact-action" aria-label="恢复所选快照" title="恢复快照" disabled={!snapshotChoice || documentBusy !== null} onClick={() => void restoreSelectedSnapshot()}><RotateCcw aria-hidden="true" /></button>
                {workspace.opened.document.format === "pptx" && <button type="button" className="viewer-compact-action viewer-compact-action--external" onClick={() => void openPptxInSystemApp()} disabled={externalOpenBusy} title="用 PowerPoint 或 WPS 打开" aria-label="用本机 PowerPoint 或 WPS 打开"><ExternalLink aria-hidden="true" /><span>{externalOpenBusy ? "打开中" : "本机打开"}</span></button>}
                <button type="button" className="viewer-compact-action" aria-label="保存到工作台收集箱" title="保存到收集箱" onClick={() => { onCaptureDocument?.({ documentId: selected.document.id, name: selected.document.displayName }); onModeChange("workbench"); }}><Plus aria-hidden="true" /></button>
                <button type="button" className="viewer-compact-action viewer-compact-action--remove" onClick={() => void removeFromLibrary(selected)} disabled={removeBusy === selected.document.id} title="从资料库移除（不会删除原文件）" aria-label="从资料库移除"><Trash2 aria-hidden="true" /></button>
                <button type="button" className={showAnnotations ? "viewer-compact-action is-active" : "viewer-compact-action"} onClick={() => setShowAnnotations((value) => !value)} aria-pressed={showAnnotations} title={showAnnotations ? "收起批注" : "展开批注"} aria-label={`批注${showAnnotations ? "（收起）" : "（展开）"}`}><MessageSquarePlus aria-hidden="true" />{annotations.length > 0 && <b>{annotations.length}</b>}</button>
                <button type="button" className="viewer-compact-action" aria-label="另存文档副本" title="另存副本" disabled={!workspace.opened.capabilities.canSaveAs || documentBusy !== null} onClick={() => void saveWorkspaceAs()}><Copy aria-hidden="true" /></button>
                <button type="button" className="viewer-compact-action" aria-label="关闭文档" title="关闭" onClick={() => { persistAiConversation(aiConversationDocumentRef.current, aiConversationRef.current); aiConversationDocumentRef.current = null; void closeDocument(selected.document.id); setWorkspace({ kind: "idle" }); setSelected(null); setAiConversation([]); }}><X aria-hidden="true" /></button>
                <button type="button" className="save-button" disabled={!canSave || documentBusy !== null} onClick={() => void saveWorkspace()}><Save aria-hidden="true" />{documentBusy === "save" ? "保存中" : "保存"}</button>
              </div>
            </div>;
          })()}</div>}
        {!selected && <div className="workspace-empty brand-workspace"><div className="brand-workspace-topline"><span>MOJI / WORKSPACE</span><span>LOCAL SPACE</span></div><div className="brand-lockup"><div className="brand-emblem" aria-hidden="true"><span>墨</span></div><small>MOJI KNOWLEDGE STUDIO</small><h1>墨集</h1><p>让散落的知识，重新汇成脉络</p></div><div className="brand-baseline"><span>LOCAL LIBRARY / READY</span><span>{library.kind === "ready" ? `${formatScanCount(library.total)} 项内容` : "等待连接本地核心"}</span></div></div>}
        {selected && workspace.kind === "loading" && <div className="workspace-empty"><RefreshCw className="is-spinning" aria-hidden="true" /><h1>正在打开文档</h1><p>正在通过 Document ID 请求受控内容。</p></div>}
        {selected && workspace.kind === "error" && <div className="workspace-empty workspace-empty--error"><FileWarning aria-hidden="true" /><h1>{workspace.error.code === "DOCUMENT_CORRUPT" ? "文档已损坏" : workspace.error.code === "DOCUMENT_LOCKED" ? "文档已锁定" : "无法打开文档"}</h1><p>{workspace.error.code} · {workspace.error.message}</p><button type="button" onClick={() => void loadDocument(selected, mode)}>重试</button></div>}
        {selected && workspace.kind === "ready" && (() => {
          const adapter = adapterRegistry.resolve(workspace.opened.document.format);
          const descriptor = adapter.descriptor(workspace.opened.document.format, workspace.opened.mode);
          const canSave = workspace.opened.capabilities.canSave && !workspace.opened.readOnly && (adapter.kind !== "office" || Boolean(officeArtifact));
          return <div className={showAnnotations ? "viewer-workspace has-annotations" : "viewer-workspace"}>
            {workspace.error && <div className={`conflict-panel conflict-panel--${workspace.error.code.toLowerCase()}`} role="alert"><strong>{workspace.error.code}</strong><p>{workspace.error.code === "DOCUMENT_LOCKED" ? "文件当前被 Excel、WPS 或资源管理器预览占用，无法覆盖保存。请关闭占用文件后重试，或直接选择“另存副本”。" : workspace.error.message}</p><div><button type="button" onClick={() => void discardLocalChanges()}>放弃本地修改</button><button type="button" onClick={() => void compareCurrentFile()}>比较当前文件</button><button type="button" disabled={!snapshots.length} onClick={() => setSnapshotChoice(snapshots[0]?.id ?? "")}>选择最近快照</button><button type="button" disabled={!workspace.opened.capabilities.canSaveAs || documentBusy !== null} onClick={() => void saveWorkspaceAs()}>另存副本</button></div></div>}
            <div className={showAnnotations ? "viewer-body has-annotations" : "viewer-body"}>
              <DocumentSurface key={workspace.opened.document.id}>
                {adapter.kind === "text" && <TextViewer content={workspace.draft} format={workspace.opened.document.format} readOnly={!canSave} targetAnchor={targetAnchor} aiHighlight={aiEditHighlight?.documentId === workspace.opened.document.id ? aiEditHighlight.anchor : null} onClearAiHighlight={() => setAiEditHighlight(null)} onAnchorChange={setActiveAnchor} onChange={(draft) => setWorkspace((current) => current.kind === "ready" ? { ...current, draft, notice: null, comparison: null } : current)} />}
                {adapter.kind === "pdf" && <PdfViewer binaryContent={workspace.opened.binaryContent} page={pdfPage} targetAnchor={targetAnchor} onPageChange={setPdfPage} onAnchorChange={setActiveAnchor} />}
                {adapter.kind === "image" && <ImageViewer binaryContent={workspace.opened.binaryContent} mediaType={workspace.opened.binaryMediaType} name={workspace.opened.document.displayName} />}
                {adapter.kind === "office" && workspace.opened.document.format === "docx" && <DocxViewer binaryContent={workspace.opened.binaryContent} mode={workspace.opened.mode} aiHighlightText={aiEditHighlight?.documentId === workspace.opened.document.id ? aiEditHighlight.text : null} aiHighlightFocusKey={aiEditHighlight?.documentId === workspace.opened.document.id ? aiEditHighlightFocusKey : 0} onArtifact={setOfficeArtifact} />}
                {adapter.kind === "office" && workspace.opened.document.format === "pptx" && <OfficePreview binaryContent={workspace.opened.binaryContent} format="pptx" name={workspace.opened.document.displayName} />}
                {adapter.kind === "office" && workspace.opened.document.format === "xlsx" && <OfficePreview binaryContent={officeArtifact ?? workspace.opened.binaryContent} format="xlsx" name={workspace.opened.document.displayName} editable={!workspace.opened.readOnly} onArtifact={setOfficeArtifact} aiChanges={xlsxAiChanges} onClearAiChanges={() => setXlsxAiChanges([])} />}
                {adapter.kind === "office" && workspace.opened.document.format === "doc" && <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>DOC 暂只读</p><small>传统 DOC 暂未接入安全编辑器；请转换为 DOCX 后编辑。</small></div>}
                {adapter.kind === "read-only" && <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>{descriptor.fallbackReason}</p><small>当前文档保持受控只读，批注可独立保存。</small></div>}
              </DocumentSurface>
              {showAnnotations && <aside className="annotation-pane">
                <div className="annotation-heading"><span>批注</span><MessageSquarePlus aria-hidden="true" /></div>
                {activeAnchor && <div className="active-anchor">{activeAnchor.page ? `第 ${activeAnchor.page} 页` : activeAnchor.paragraph ? `第 ${activeAnchor.paragraph} 段` : "当前选择"}{activeAnchor.quote ? ` · ${activeAnchor.quote.slice(0, 24)}` : ""}</div>}
                <textarea aria-label="新批注" value={annotationBody} onChange={(event) => setAnnotationBody(event.target.value)} placeholder="添加批注" />
                <button type="button" onClick={() => void createAnnotation()} disabled={!annotationBody.trim()}>保存批注</button>
                <div className="annotation-list">{annotations.length === 0 ? <p>暂无批注</p> : annotations.map((annotation) => <button type="button" key={annotation.id} onClick={() => { setActiveAnchor(annotation.anchor); setTargetAnchor(annotation.anchor); if (annotation.anchor.page) setPdfPage(annotation.anchor.page); }}><strong>{annotation.anchor.kind}{annotation.anchor.page ? ` · 第 ${annotation.anchor.page} 页` : annotation.anchor.paragraph ? ` · 第 ${annotation.anchor.paragraph} 段` : ""}</strong><p>{annotation.body}</p><small>{annotation.anchor.stable ? "稳定锚点" : "引用文本回退"}</small></button>)}</div>
              </aside>}
            </div>
            {workspace.comparison && <div className="comparison-panel"><header><strong>磁盘当前版本</strong><button type="button" className="icon-button" aria-label="关闭比较" title="关闭比较" onClick={() => setWorkspace((current) => current.kind === "ready" ? { ...current, comparison: null } : current)}><X aria-hidden="true" /></button></header>{workspace.comparison.content !== null ? <pre>{workspace.comparison.content}</pre> : <p>二进制文档当前 SHA-256：<code>{workspace.comparison.expectedSha256}</code></p>}</div>}
          </div>;
        })()}
      </section>

      <aside className="assistant-home ai-workbench" aria-label="AI 助理">
        <header>
          <div className="assistant-heading">
            <span className="assistant-mark" aria-hidden="true"><PenLine /></span>
            <div><span className="eyebrow">智能工作台</span><h2>AI 助理</h2></div>
          </div>
          <span className="assistant-fixed-badge" aria-label="AI 助理固定开启" title="AI 助理固定开启"><Pin aria-hidden="true" /></span>
        </header>
        <div className="assistant-context-note">
          <span aria-hidden="true" />
          <div><strong>{selected ? "当前对话范围" : "等待文档"}</strong><small title={selected?.document.displayName}>{selected ? selected.document.displayName : "从左侧文档列表选择一份资料"}</small></div>
        </div>
        {selected ? <section className="ai-panel" aria-labelledby="ai-title">
          <div className="ai-control-label"><span id="ai-title">对话</span><small>{aiConversation.length ? `${aiConversation.length} 条记录` : "围绕当前文档提问"}</small></div>
          {aiEditHighlight?.documentId === selected.document.id && <section className="ai-change-summary ai-change-summary--pinned" aria-label="AI 修改位置">
            <header><div><strong>AI 已修改的位置</strong><small>{aiEditHighlight.location}</small></div><span className="ai-change-summary-actions"><button type="button" onClick={focusAiEditHighlight} title="定位到修改位置"><Highlighter aria-hidden="true" /><span>定位</span></button><button type="button" onClick={() => setAiEditHighlight(null)} title="取消高亮并关闭修改提示"><CircleCheck aria-hidden="true" /><span>知道了</span></button></span></header>
            <div className="ai-change-summary-row"><span>修改前</span><p>{aiEditHighlight.before || "（无可显示的原文）"}</p></div>
            <div className="ai-change-summary-row is-after"><span>修改后</span><p>{aiEditHighlight.after || "（无可显示的新文）"}</p></div>
          </section>}
          <div className="ai-thread" aria-live="polite" ref={aiThreadRef}>
            {aiConversation.length === 0 && <article className="ai-turn ai-turn--assistant ai-thread-empty"><span className="ai-turn-label">墨集 AI</span><p>你好，我会围绕当前文档回答问题。你可以直接提问，也可以从下方常用提示词开始。</p></article>}
            {aiConversation.map((turn, index) => <article key={`${turn.role}-${index}`} className={`ai-turn ai-turn--${turn.role}`}><span className="ai-turn-label">{turn.role === "user" ? "你" : turn.role === "assistant" ? "墨集 AI" : turn.role === "tool" ? "工作动作" : "状态"}</span>{turn.role === "assistant" ? <AiResponseText text={turn.text} /> : <p>{turn.text}</p>}</article>)}
            {aiBusy && <article className="ai-turn ai-turn--status" aria-live="polite"><span className="ai-turn-label">墨集 AI</span><p><span className="ai-thinking-dot" aria-hidden="true" />{aiPhaseLabel(aiPhase)} · 已等待 {Math.max(0, Math.floor(aiElapsedMs / 1000))} 秒</p></article>}
            {aiPhase === "timeout" && aiRetryAvailable && <div className="ai-retry-row"><span>中转站没有在限定时间内返回结果，聊天内容已保留。</span><button type="button" onClick={() => void runAi(aiLastPrompt)} disabled={aiBusy}>重试</button></div>}
          </div>
          <div className="ai-composer">
            <div className="ai-composer-top"><span className="ai-composer-context"><span className="ai-composer-dot" />当前文档</span><label><span>工作方式</span><select aria-label="AI 权限" value={aiPermission} onChange={(event) => { setAiPermission(event.target.value as AiPermission); setAiPreview(null); }}><option value="suggest">建议 · 只读参考</option><option value="assist">协助修改 · 需确认</option><option value="autonomous">自主修改 · 当前文档</option></select></label></div>
            <textarea aria-label="AI 请求" rows={5} value={aiPrompt} onChange={(event) => { setAiPrompt(event.target.value); setAiPreview(null); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runAi(); } }} placeholder="问问这份文档，或让墨集替你完成一件事…" />
            <div className="ai-composer-bottom"><div className="ai-composer-meta"><label className="ai-prompt-picker"><Sparkles aria-hidden="true" /><span>常用提示词</span><select aria-label="常用提示词" defaultValue="" disabled={aiBusy} onChange={(event) => { const prompt = event.currentTarget.value; if (!prompt) return; setAiPrompt(prompt); setAiPreview(null); event.currentTarget.value = ""; }}><option value="">选择提示词</option>{COMMON_AI_PROMPTS.map((item) => <option value={item.prompt} key={item.label}>{item.label}</option>)}</select></label><span className="ai-composer-source-status">{aiPreview ? `${aiPreview.sources.length} 个来源已准备` : "发送前会先确认文档上下文"}</span></div><div className="ai-composer-actions"><button type="button" className="composer-preview" onClick={() => void previewAi()} disabled={!aiPrompt.trim() || aiBusy}>预览上下文</button>{aiBusy && <button type="button" className="icon-button composer-cancel" aria-label="取消 AI 请求" onClick={() => void cancelAi()} title="取消 AI 请求"><X aria-hidden="true" /></button>}<button type="button" className="composer-send" onClick={() => void runAi()} disabled={!aiPrompt.trim() || aiBusy} aria-label={aiBusy ? "生成中" : "发送"}><ArrowUp aria-hidden="true" /><span>{aiBusy ? "生成中" : "发送"}</span></button></div></div>
          </div>
          {aiPreview && <div className="ai-preview"><strong>发送前确认</strong><span>{aiPreview.sources.length} 个来源 · {aiPreview.characterCount} 字 · 约 {aiPreview.estimatedTokens} tokens</span><span>权限：{aiPreview.permission} · 文档内容不可信</span></div>}
          {xlsxPlanReview && selected.document.format === "xlsx" && <div className="ai-review" aria-label="Excel AI 修改预览"><div className="annotation-heading"><span>Excel 修改预览</span><small>{xlsxPlanReview.changes.length} 个单元格</small></div><pre>{xlsxPlanReview.changes.map((change) => `${change.sheet}!${change.address}\n${String(change.before ?? "（空）")} → ${String(change.after ?? "（空）")}${change.formula ? `\n${change.formula}` : ""}${change.formatChanged ? "\n格式已更新" : ""}`).join("\n\n")}</pre><div className="ai-actions"><button type="button" onClick={applyXlsxPlanReview}>确认写入</button><button type="button" onClick={rejectXlsxPlanReview}>拒绝</button></div></div>}
          {xlsxAiUndoArtifact && selected.document.format === "xlsx" && <div className="ai-review ai-review--undo" aria-label="Excel AI 修改恢复"><div className="annotation-heading"><span>本次 AI 修改</span><small>尚未写回磁盘</small></div><div className="ai-actions"><button type="button" onClick={undoXlsxAiChange}>撤销本次 AI 修改</button></div></div>}
          {aiEvents.some((event) => event.kind === "error" && event.code === "AI_NO_API_KEY") && <div className="ai-provider-note" role="status">远程 AI 尚未配置凭据。可先使用上方本地快速分析；需要联网对话时，请在 Windows 凭据管理器中添加 <code>moji/openai/api-key</code>。</div>}
          {aiProposals.length > 0 && <div className="ai-review" aria-label="AI 修改审阅"><div className="annotation-heading"><span>修改审阅</span>{aiProposals.length > 1 && <button type="button" onClick={() => void applyAllProposals()} disabled={aiBusy}>全部接受</button>}</div>{aiProposals.map((proposal) => <article key={proposal.proposalId}><strong>{proposal.documentId} · {proposal.permission}</strong><pre aria-label="原内容">{proposal.oldContent}</pre><pre aria-label="建议内容">{proposal.newContent}</pre><div className="ai-actions"><button type="button" onClick={() => void applyProposal(proposal)} disabled={aiBusy}>接受</button><button type="button" onClick={() => void rejectProposal(proposal.proposalId)}>拒绝</button></div></article>)}</div>}
        </section> : <div className="assistant-empty"><div className="assistant-empty-mark" aria-hidden="true"><PenLine /></div><strong>从一份文档开始</strong><p>选择左侧文档后，墨集 AI 会基于当前上下文协助你阅读、整理与修改。</p><div className="assistant-principles" aria-label="墨集工作原则"><div><span>01</span><strong>以文档为证</strong><small>只引用已选内容</small></div><div><span>02</span><strong>先看上下文</strong><small>再给出可执行建议</small></div><div><span>03</span><strong>每步可追溯</strong><small>修改前明确确认</small></div></div><div className="assistant-idle-composer"><textarea aria-label="选择文档后开始对话" disabled placeholder="选择一份文档后开始对话…" /><button type="button" disabled aria-label="发送"><ArrowUp aria-hidden="true" /></button></div><div className="assistant-empty-rule"><span>墨集 AI</span><span>仅处理明确选中的内容</span></div></div>}
        <small className="assistant-footnote">仅使用你明确选择的文档内容</small>
      </aside>

      {scanCenterOpen && <div className="scan-modal-layer" role="presentation" onMouseDown={() => !scanBusy && setScanCenterOpen(false)}>
        <section className="scan-modal" role="dialog" aria-modal="true" aria-labelledby="scan-modal-title" onMouseDown={(event) => event.stopPropagation()}>
          <header className="scan-modal-header"><div><span className="scan-modal-eyebrow">LOCAL DISCOVERY</span><h2 id="scan-modal-title">{scanPreview ? "选择扫描范围" : "扫描资料"}</h2><p>{scanPreview ? `先查看文件夹，再选择要扫描的内容（最多展示 ${scanPreview.maxDepth} 级）。` : "先枚举本机文件夹，确认范围后再读取文档。"}</p></div><button type="button" className="icon-button" aria-label="关闭扫描中心" title="关闭" onClick={() => { setScanCenterOpen(false); setScanPreview(null); }} disabled={scanBusy}><X aria-hidden="true" /></button></header>
          <div className="scan-modal-rule" />
          {!scanPreview ? <>
            <div className="scan-modal-options">
              <button type="button" className="scan-option scan-option--primary" onClick={() => void loadScanPreview("common")} disabled={scanBusy}>
                <span className="scan-option-icon"><ScanLine aria-hidden="true" /></span><span><strong>{scanBusy && scanPreviewKind === "common" ? "正在枚举文件夹" : "选择常用位置"}</strong><small>桌面、文档、下载、OneDrive、微信资料及系统盘之外的所有磁盘</small></span><ArrowUp aria-hidden="true" />
              </button>
              <button type="button" className="scan-option scan-option--warning" onClick={() => void loadScanPreview("full-disk")} disabled={scanBusy}>
                <span className="scan-option-icon"><HardDrive aria-hidden="true" /></span><span><strong>{scanBusy && scanPreviewKind === "full-disk" ? "正在枚举磁盘" : "排除系统文件的全盘扫描"}</strong><small>扫描可用磁盘，自动跳过 Windows、Program Files、隐藏目录和链接</small></span><ArrowUp aria-hidden="true" />
              </button>
              <button type="button" className="scan-option" onClick={() => void startPickedScan("folder")} disabled={scanBusy}>
                <span className="scan-option-icon"><FolderOpen aria-hidden="true" /></span><span><strong>选择文件夹</strong><small>扫描你指定的整个文件夹</small></span><ArrowUp aria-hidden="true" />
              </button>
              <button type="button" className="scan-option" onClick={() => void startPickedScan("file")} disabled={scanBusy}>
                <span className="scan-option-icon"><FileWarning aria-hidden="true" /></span><span><strong>选择单个文件</strong><small>支持 DOC、DOCX、PDF、PPTX、XLSX 和文本</small></span><ArrowUp aria-hidden="true" />
              </button>
            </div>
            <div className="scan-modal-foot"><span><span className="scan-modal-dot" />不扫描图片；DOC / DOCX / PDF / PPTX / XLSX / 文本可加入资料库</span><span>隐藏后仍在后台扫描</span></div>
          </> : <>
            <div className="scan-selection-summary"><strong>{scanPreviewKind === "full-disk" ? "全盘范围" : "常用位置"}</strong><span>勾选文件夹后开始扫描，父级文件夹会包含其子文件夹。</span></div>
            <div className="scan-folder-roots">{scanPreview.roots.map((root) => <section className="scan-folder-root" key={root.sourceId}><header><strong>{root.label}</strong><small>{root.root.hasMore ? "第 3 级以下仍有内容" : "目录预览完成"}</small></header><ul><ScanFolderTree node={root.root} selectedPaths={scanSelections[root.sourceId] ?? []} onToggle={(path) => toggleScanFolder(root.sourceId, path)} /></ul></section>)}</div>
            <div className="scan-selection-actions"><button type="button" className="scan-secondary-button" onClick={() => setScanPreview(null)} disabled={scanBusy}>返回</button><button type="button" className="scan-option scan-option--primary scan-start-button" onClick={() => void startSelectedFolders()} disabled={scanBusy}><ScanLine aria-hidden="true" />{scanBusy ? "正在创建任务" : "开始扫描所选文件夹"}</button></div>
          </>}
          {scanError && <p className="scan-modal-error" role="alert">{scanError}</p>}
        </section>
      </div>}

      {scanEnumerationProgress && !scanEnumerationHidden && <aside className="scan-enumeration-popover" aria-label="目录枚举进度">
        <header className="scan-progress-header"><div><span className="scan-modal-eyebrow">FOLDER ENUMERATION</span><strong>{scanEnumerationProgress.phase === "completed" ? "文件夹枚举完成" : "正在枚举文件夹"}</strong></div><button type="button" className="icon-button" aria-label="最小化枚举进度" title="最小化" onClick={() => setScanEnumerationHidden(true)}><Minimize2 aria-hidden="true" /></button></header>
        <div className="scan-enumeration-summary"><span className="scan-progress-live-dot" /><strong>{scanEnumerationProgress.label ?? "准备扫描位置"}</strong><small>{scanEnumerationProgress.rootCount ? `${scanEnumerationProgress.rootIndex || 1} / ${scanEnumerationProgress.rootCount} 个位置` : "正在启动后台任务"}</small></div>
        <div className="scan-progress-track is-indeterminate"><span /></div>
        <div className="scan-progress-current"><span className="scan-progress-live-dot" />{scanEnumerationProgress.relativePath ?? "正在准备目录读取"}</div>
        <div className="scan-enumeration-counts"><span>已枚举文件夹 <strong>{formatScanCount(scanEnumerationProgress.foldersScanned)}</strong></span><span>发现支持文件 <strong>{formatScanCount(scanEnumerationProgress.filesFound)}</strong></span></div>
      </aside>}
      {scanEnumerationProgress && scanEnumerationHidden && <button type="button" className="scan-enumeration-minimized" onClick={() => setScanEnumerationHidden(false)} aria-label="展开枚举进度" title="展开枚举进度"><ScanLine aria-hidden="true" /><span><strong>正在枚举文件夹</strong><small>{formatScanCount(scanEnumerationProgress.foldersScanned)} 个文件夹 · {formatScanCount(scanEnumerationProgress.filesFound)} 个文件</small></span><Maximize2 aria-hidden="true" /></button>}

      {scanJobs.length > 0 && !scanHidden && <aside className="scan-progress-popover" aria-label="扫描进度">
        <header className="scan-progress-header"><div><span className="scan-modal-eyebrow">SCAN TASKS</span><strong>{scanSummary.complete ? "扫描已结束" : "正在扫描资料"}</strong></div><div className="scan-progress-header-actions"><button type="button" className="icon-button" aria-label="最小化扫描进度" title="最小化" onClick={() => setScanHidden(true)}><Minimize2 aria-hidden="true" /></button><button type="button" className="icon-button" aria-label="关闭扫描进度" title="关闭窗口" onClick={() => { setScanJobs([]); setScanSkipped([]); setScanError(null); }}><X aria-hidden="true" /></button></div></header>
        <div className="scan-progress-summary"><div className="scan-progress-number">{scanSummary.progress === null ? "--" : `${scanSummary.progress}%`}</div><div><strong>{formatScanCount(scanSummary.scanned)} <small>/ {scanSummary.total ? formatScanCount(scanSummary.total) : "枚举中"}</small></strong><span>{scanSummary.locationCount} 个位置 · {formatScanCount(scanSummary.changed)} 项更新 · {formatScanCount(scanSummary.failed)} 项失败{scanSummary.eta ? ` · ${scanSummary.eta}` : ""}</span></div></div>
        <div className={scanSummary.progress === null ? "scan-progress-track is-indeterminate" : "scan-progress-track"}><span style={scanSummary.progress === null ? undefined : { width: `${scanSummary.progress}%` }} /></div>
        <div className="scan-progress-current"><span className="scan-progress-live-dot" />{scanSummary.current ?? "准备扫描线程"}</div>
        <div className="scan-progress-jobs">{scanJobs.map((job) => <div className="scan-job-row" key={job.id}><div><strong>{scanSourceLabels[job.sourceRootId] ?? "资料位置"}</strong><span>{scanStateLabel(job.state)} · {formatScanCount(job.scannedCount)}{job.totalCount ? ` / ${formatScanCount(job.totalCount)}` : ""}</span></div><div className="scan-job-actions">{job.state === "running" && <button type="button" className="icon-button" aria-label={`暂停${scanSourceLabels[job.sourceRootId] ?? "扫描"}`} title="暂停" onClick={() => void transitionScanJob(job, "pause")}><Pause aria-hidden="true" /></button>}{job.state === "paused" && <button type="button" className="icon-button" aria-label={`继续${scanSourceLabels[job.sourceRootId] ?? "扫描"}`} title="继续" onClick={() => void transitionScanJob(job, "resume")}><Play aria-hidden="true" /></button>}{scanJobIsActive(job) && <button type="button" className="icon-button scan-stop" aria-label={`取消${scanSourceLabels[job.sourceRootId] ?? "扫描"}`} title="取消" onClick={() => void transitionScanJob(job, "cancel")}><Square aria-hidden="true" /></button>}</div></div>)}</div>
        {scanSkipped.length > 0 && <small className="scan-progress-skipped">已跳过 {scanSkipped.join("、")}</small>}
      </aside>}

      {scanJobs.length > 0 && scanHidden && <button type="button" className="scan-progress-minimized" onClick={() => setScanHidden(false)} aria-label="展开扫描进度" title="展开扫描进度"><ScanLine aria-hidden="true" /><span><strong>{scanSummary.complete ? "扫描已完成" : "扫描进行中"}</strong><small>{scanSummary.progress === null ? "正在枚举文件" : `${scanSummary.progress}% · ${formatScanCount(scanSummary.scanned)} 项`}</small></span><Maximize2 aria-hidden="true" /></button>}
    </main>
  );
}

const PRODUCT_MODE_KEY = "moji.product-mode.v1";

export default function App() {
  const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(null);
  const [capturedDocument, setCapturedDocument] = useState<{ documentId: string; name: string } | null>(null);
  const [productMode, setProductMode] = useState<ProductMode>(() => window.localStorage.getItem(PRODUCT_MODE_KEY) === "documents" ? "documents" : "workbench");
  const [modeMotion, setModeMotion] = useState<"idle" | "leaving" | "entering">("idle");
  const [modeTransitionTarget, setModeTransitionTarget] = useState<ProductMode | null>(null);
  const modeMotionTimer = useRef<number | null>(null);
  const modeMotionFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (modeMotionTimer.current !== null) window.clearTimeout(modeMotionTimer.current);
    if (modeMotionFrame.current !== null) window.cancelAnimationFrame(modeMotionFrame.current);
  }, []);

  const changeProductMode = (nextMode: ProductMode) => {
    if (nextMode === productMode || modeMotion !== "idle") return;
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      window.localStorage.setItem(PRODUCT_MODE_KEY, nextMode);
      setProductMode(nextMode);
      return;
    }
    setModeTransitionTarget(nextMode);
    setModeMotion("leaving");
    modeMotionFrame.current = window.requestAnimationFrame(() => {
      // Both application surfaces are already mounted. Start their opposing
      // transforms together instead of waiting for one to unmount first.
      setModeMotion("entering");
      modeMotionTimer.current = window.setTimeout(() => {
        window.localStorage.setItem(PRODUCT_MODE_KEY, nextMode);
        startTransition(() => setProductMode(nextMode));
        modeMotionFrame.current = window.requestAnimationFrame(() => {
          setModeMotion("idle");
          setModeTransitionTarget(null);
        });
      }, 820);
    });
  };

  const documentsActive = productMode === "documents";
  const workbenchActive = productMode === "workbench";
  const inProductTransition = modeMotion !== "idle" && modeTransitionTarget !== null;
  const surfaceClassName = (mode: ProductMode, active: boolean) => {
    if (!inProductTransition) return active ? " is-active" : "";
    return mode === modeTransitionTarget ? " is-active is-entering" : active ? " is-active is-leaving" : "";
  };

  return <div className={`product-mode-stage is-${modeMotion}`} data-transition={modeTransitionTarget ? `to-${modeTransitionTarget}` : undefined} aria-busy={modeMotion !== "idle"}>
    <section className={`product-mode-surface product-mode-surface--documents${surfaceClassName("documents", documentsActive)}`} aria-hidden={!documentsActive} inert={!documentsActive}>
      <DocumentManagementApp initialDocumentId={pendingDocumentId} onConsumedDocument={() => setPendingDocumentId(null)} onCaptureDocument={(document) => { setCapturedDocument(document); changeProductMode("workbench"); }} onModeChange={changeProductMode} />
    </section>
    <section className={`product-mode-surface product-mode-surface--workbench${surfaceClassName("workbench", workbenchActive)}`} aria-hidden={!workbenchActive} inert={!workbenchActive}>
      <div className="workbench-window">
        <header className="workbench-window-chrome" aria-label="墨集窗口栏">
          <div className="window-title"><span className="window-title-mark">墨</span><strong>墨集</strong><span>个人工作台</span></div>
          <div className="window-status"><span className="window-status-dot" />本地空间</div>
        </header>
        <Workbench captureDocument={capturedDocument} onCaptured={() => setCapturedDocument(null)} onModeChange={changeProductMode} onOpenDocument={(documentId) => { setPendingDocumentId(documentId); changeProductMode("documents"); }} />
      </div>
    </section>
  </div>;
}
