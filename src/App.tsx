import {
  Clock3,
  Eye,
  FileWarning,
  FolderKanban,
  FolderOpen,
  History,
  LayoutList,
  MessageSquarePlus,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Star,
  Tag,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { healthCheck, type HealthCheckData } from "./ipc/health";
import {
  addAnnotation,
  closeDocument,
  listAnnotations,
  listSnapshots,
  openDocument,
  restoreSnapshot,
  saveDocument,
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
  listSources,
  listTags,
  recordRecentUse,
  rebuildSearchIndex,
  searchLibrary,
  setCollectionMembership,
  setFavorite,
  setTagMembership,
  type CollectionRecord,
  type DocumentFormat,
  type DocumentStatus,
  type SearchDocument,
  type SearchQuery,
  type SourceRootRecord,
  type TagRecord,
} from "./ipc/library";
import type { IpcError } from "./ipc/types";
import { chatWithAiStream, previewAiContext, type AiPermission, type AiStreamEvent, type ContextPreview } from "./ipc/ai";
import { adapterRegistry } from "./document/registry";
import { PdfViewer } from "./document/PdfViewer";

type HealthState =
  | { kind: "checking" }
  | { kind: "healthy"; data: HealthCheckData }
  | { kind: "unavailable"; error: IpcError };

type View = "all" | "favorites" | "recent";

type LibraryState =
  | { kind: "loading" }
  | { kind: "ready"; items: SearchDocument[]; total: number; queryTimeMs: number }
  | { kind: "error"; error: IpcError };

type WorkspaceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: IpcError }
  | { kind: "ready"; opened: DocumentOpenResult; draft: string; error: IpcError | null; notice: string | null };

const formatLabels: Record<DocumentFormat, string> = {
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

function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" / ");
}

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

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });
  const [library, setLibrary] = useState<LibraryState>({ kind: "loading" });
  const [sources, setSources] = useState<SourceRootRecord[]>([]);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [view, setView] = useState<View>("all");
  const [searchText, setSearchText] = useState("");
  const [format, setFormat] = useState<DocumentFormat | "">("");
  const [status, setStatus] = useState<DocumentStatus | "">("");
  const [sourceId, setSourceId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [tagId, setTagId] = useState("");
  const [modifiedWindow, setModifiedWindow] = useState("all");
  const [selected, setSelected] = useState<SearchDocument | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: "idle" });
  const [mode, setMode] = useState<DocumentMode>("read-only");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [annotationBody, setAnnotationBody] = useState("");
  const [snapshotChoice, setSnapshotChoice] = useState("");
  const [collectionChoice, setCollectionChoice] = useState("");
  const [tagChoice, setTagChoice] = useState("");
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [aiPermission, setAiPermission] = useState<AiPermission>("suggest");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPreview, setAiPreview] = useState<ContextPreview | null>(null);
  const [aiEvents, setAiEvents] = useState<AiStreamEvent[]>([]);
  const [aiBusy, setAiBusy] = useState(false);

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
      formats: format ? [format] : undefined,
      statuses: status ? [status] : undefined,
      sourceRootIds: sourceId ? [sourceId] : undefined,
      collectionId: collectionId || undefined,
      tagIds: tagId ? [tagId] : undefined,
      modifiedAfterMs: modifiedAfterMs ?? modifiedAfterMonth,
      favoriteOnly: view === "favorites",
      recentOnly: view === "recent",
      limit: 100,
    };
  }, [collectionId, format, modifiedWindow, searchText, sourceId, status, tagId, view]);

  const refreshMetadata = useCallback(async () => {
    const [sourceResponse, collectionResponse, tagResponse] = await Promise.all([listSources(), listCollections(), listTags()]);
    if (sourceResponse.status === "success") setSources(sourceResponse.data);
    if (collectionResponse.status === "success") setCollections(collectionResponse.data);
    if (tagResponse.status === "success") setTags(tagResponse.data);
  }, []);

  const refreshResults = useCallback(async () => {
    setLibrary({ kind: "loading" });
    const response = await searchLibrary(query);
    if (response.status === "success") {
      setLibrary({ kind: "ready", ...response.data });
      setSelected((current) => response.data.items.find((item) => item.document.id === current?.document.id) ?? null);
    } else {
      setLibrary({ kind: "error", error: response.error });
    }
  }, [query]);

  useEffect(() => {
    void refreshHealth();
    void refreshMetadata();
  }, [refreshHealth, refreshMetadata]);

  useEffect(() => {
    void refreshResults();
  }, [refreshResults]);

  const chooseView = (next: View) => {
    setView(next);
    setSelected(null);
    setWorkspace({ kind: "idle" });
  };

  const loadDocument = async (item: SearchDocument, requestedMode: DocumentMode) => {
    setWorkspace({ kind: "loading" });
    setAnnotations([]);
    setSnapshots([]);
    const response = await openDocument(item.document.id, requestedMode);
    if (response.status === "error") {
      setWorkspace({ kind: "error", error: response.error });
      return;
    }
    const adapter = adapterRegistry.resolve(item.document.format);
    const normalized = adapter.normalize(response.data);
    const [annotationResponse, snapshotResponse] = await Promise.all([listAnnotations(item.document.id), listSnapshots(item.document.id)]);
    setAnnotations(annotationResponse.status === "success" ? annotationResponse.data : []);
    setSnapshots(snapshotResponse.status === "success" ? snapshotResponse.data : []);
    setWorkspace({ kind: "ready", opened: { ...response.data, capabilities: normalized.capabilities, content: normalized.content }, draft: normalized.content ?? "", error: null, notice: normalized.warning });
  };

  const selectDocument = async (item: SearchDocument) => {
    setSelected(item);
    await recordRecentUse(item.document.id);
    await loadDocument(item, mode);
  };

  const changeMode = async (nextMode: DocumentMode) => {
    setMode(nextMode);
    if (selected) await loadDocument(selected, nextMode);
  };

  const saveWorkspace = async () => {
    if (workspace.kind !== "ready") return;
    const { opened, draft } = workspace;
    const response = await saveDocument(opened.document.id, opened.expectedSha256, draft, opened.mode);
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    const snapshotResponse = await listSnapshots(opened.document.id);
    if (snapshotResponse.status === "success") setSnapshots(snapshotResponse.data);
    setWorkspace((current) => current.kind === "ready" ? { ...current, opened: { ...current.opened, expectedSha256: response.data.newSha256 }, error: null, notice: `已创建快照 ${response.data.snapshotId.slice(0, 12)}` } : current);
  };

  const discardLocalChanges = async () => {
    if (selected) await loadDocument(selected, mode);
  };

  const restoreSelectedSnapshot = async () => {
    if (workspace.kind !== "ready" || !snapshotChoice) return;
    const response = await restoreSnapshot(workspace.opened.document.id, snapshotChoice, workspace.opened.expectedSha256);
    if (response.status === "error") {
      setWorkspace((current) => current.kind === "ready" ? { ...current, error: response.error } : current);
      return;
    }
    if (selected) await loadDocument(selected, mode);
  };

  const createAnnotation = async () => {
    if (workspace.kind !== "ready" || !annotationBody.trim()) return;
    const { opened, draft } = workspace;
    const adapter = adapterRegistry.resolve(opened.document.format);
    const anchor: AnnotationAnchor = opened.document.format === "pdf"
      ? { kind: "page", page: 1, slide: null, paragraph: null, charStart: null, charEnd: null, quote: null, stable: true }
      : adapter.kind === "text"
        ? { kind: "character-range", page: null, slide: null, paragraph: 1, charStart: 0, charEnd: Math.min(draft.length, 160), quote: draft.slice(0, 160) || null, stable: false }
        : { kind: "document", page: null, slide: null, paragraph: null, charStart: null, charEnd: null, quote: null, stable: false };
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

  const addCollection = async () => {
    const name = window.prompt("新建集合");
    if (!name?.trim()) return;
    const response = await createCollection(name);
    if (response.status === "success") {
      await refreshMetadata();
      setCollectionId(response.data.id);
    }
  };

  const addTag = async () => {
    const name = window.prompt("新建标签");
    if (!name?.trim()) return;
    const response = await createTag(name);
    if (response.status === "success") {
      await refreshMetadata();
      setTagId(response.data.id);
    }
  };

  const rebuild = async () => {
    setIsRebuilding(true);
    const response = await rebuildSearchIndex();
    setIsRebuilding(false);
    if (response.status === "success") void refreshResults();
  };

  const previewAi = async () => {
    if (!selected || !aiPrompt.trim()) return;
    const response = await previewAiContext({ prompt: aiPrompt.trim(), permission: aiPermission, documentIds: [selected.document.id] });
    if (response.status === "success") setAiPreview(response.data);
  };

  const runAi = async () => {
    if (!selected || !aiPrompt.trim() || !aiPreview) return;
    setAiBusy(true);
    setAiEvents([]);
    const response = await chatWithAiStream(
      { sessionId: `session-${Date.now()}`, prompt: aiPrompt.trim(), permission: aiPermission, confirmed: true, documentIds: [selected.document.id] },
      (event) => setAiEvents((events) => [...events, event]),
    );
    if (response.status === "error") setAiEvents([{ kind: "error", code: response.error.code, message: response.error.message, retryable: response.error.retryable }]);
    setAiBusy(false);
  };

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

  const hasFilters = Boolean(format || status || sourceId || collectionId || tagId || modifiedWindow !== "all" || searchText);
  const isChecking = health.kind === "checking";

  return (
    <main className="library-shell">
      <aside className="library-nav" aria-label="资料库导航">
        <div className="brand-row"><div className="brand-mark" aria-hidden="true">墨</div><div><strong>墨集</strong><span>资料库</span></div></div>

        <nav className="primary-nav">
          <button type="button" className={view === "all" ? "nav-item is-active" : "nav-item"} onClick={() => chooseView("all")}><LayoutList aria-hidden="true" />全部资料</button>
          <button type="button" className={view === "favorites" ? "nav-item is-active" : "nav-item"} onClick={() => chooseView("favorites")}><Star aria-hidden="true" />收藏</button>
          <button type="button" className={view === "recent" ? "nav-item is-active" : "nav-item"} onClick={() => chooseView("recent")}><Clock3 aria-hidden="true" />最近使用</button>
        </nav>

        <section className="nav-section" aria-labelledby="collections-title">
          <div className="nav-heading"><span id="collections-title">集合</span><button type="button" className="icon-button" aria-label="新建集合" title="新建集合" onClick={() => void addCollection()}><Plus aria-hidden="true" /></button></div>
          {collections.map((collection) => <button type="button" key={collection.id} className={collectionId === collection.id ? "tree-item is-active" : "tree-item"} onClick={() => { setCollectionId(collectionId === collection.id ? "" : collection.id); setView("all"); }}><FolderKanban aria-hidden="true" />{collection.name}</button>)}
        </section>

        <section className="nav-section" aria-labelledby="tags-title">
          <div className="nav-heading"><span id="tags-title">标签</span><button type="button" className="icon-button" aria-label="新建标签" title="新建标签" onClick={() => void addTag()}><Plus aria-hidden="true" /></button></div>
          {tags.map((tag) => <button type="button" key={tag.id} className={tagId === tag.id ? "tree-item is-active" : "tree-item"} onClick={() => { setTagId(tagId === tag.id ? "" : tag.id); setView("all"); }}><Tag aria-hidden="true" />{tag.name}</button>)}
        </section>

        <div className="library-health"><span className={`health-dot health-dot--${health.kind}`} aria-hidden="true" /><span>{health.kind === "healthy" ? `本地核心 v${health.data.protocolVersion}` : health.kind === "checking" ? "连接本地核心" : "本地核心不可用"}</span><button type="button" className="icon-button" aria-label="重新连接本地核心" title="重新连接" onClick={() => void refreshHealth()} disabled={isChecking}><RefreshCw aria-hidden="true" className={isChecking ? "is-spinning" : ""} /></button></div>
      </aside>

      <section className="result-pane" aria-label="搜索结果">
        <header className="result-header">
          <label className="search-box"><Search aria-hidden="true" /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索标题、路径、标签和已索引正文" aria-label="搜索资料" /><button type="button" className={searchText ? "search-clear" : "search-clear is-hidden"} aria-label="清除搜索" title="清除搜索" onClick={() => setSearchText("")}><X aria-hidden="true" /></button></label>
          <button type="button" className="icon-button utility-button" aria-label="重建全文索引" title="重建全文索引" disabled={isRebuilding} onClick={() => void rebuild()}><RefreshCw aria-hidden="true" className={isRebuilding ? "is-spinning" : ""} /></button>
        </header>

        <div className="filters" aria-label="搜索过滤器">
          <select value={format} onChange={(event) => setFormat(event.target.value as DocumentFormat | "")} aria-label="格式筛选"><option value="">所有格式</option>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select value={status} onChange={(event) => setStatus(event.target.value as DocumentStatus | "")} aria-label="状态筛选"><option value="">所有状态</option><option value="present">可用</option><option value="missing">已缺失</option><option value="error">有错误</option></select>
          <select value={modifiedWindow} onChange={(event) => setModifiedWindow(event.target.value)} aria-label="时间筛选"><option value="all">所有时间</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option></select>
          <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} aria-label="来源筛选"><option value="">所有来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select>
          {hasFilters && <button type="button" className="clear-filters" onClick={() => { setSearchText(""); setFormat(""); setStatus(""); setSourceId(""); setCollectionId(""); setTagId(""); setModifiedWindow("all"); }}>清除筛选</button>}
        </div>

        <div className="results-label"><span>{view === "all" ? "全部资料" : view === "favorites" ? "收藏" : "最近使用"}</span>{library.kind === "ready" && <small>{library.total} 项 · {library.queryTimeMs} ms</small>}</div>

        <div className="result-list" aria-live="polite">
          {library.kind === "loading" && <div className="state-block"><RefreshCw className="is-spinning" aria-hidden="true" /><p>正在检索资料库</p></div>}
          {library.kind === "error" && <div className="state-block state-block--error"><p>无法读取资料库</p><small>{library.error.code} · {library.error.message}</small><button type="button" onClick={() => void refreshResults()}>重试</button></div>}
          {library.kind === "ready" && library.total === 0 && <div className="state-block"><FolderOpen aria-hidden="true" /><p>{sources.length === 0 ? "还没有已授权并扫描的资料" : hasFilters || view !== "all" ? "没有符合当前筛选的资料" : "资料库暂时为空"}</p></div>}
          {library.kind === "ready" && library.items.map((item) => <article key={item.document.id} className={selected?.document.id === item.document.id ? "result-item is-selected" : "result-item"} onClick={() => void selectDocument(item)}>
            <div className={`format-badge format-badge--${item.document.format}`}>{formatLabels[item.document.format]}</div>
            <div className="result-copy"><h2>{item.document.displayName}</h2><p>{pathTail(item.document.canonicalPath)}</p>{item.snippets[0] && <p className="result-snippet">{renderSnippet(item.snippets[0].text)}</p>}<div className="result-meta"><span>{modifiedLabel(item.document.modifiedAtMs)}</span>{item.tags.map((tag) => <span className="tag-chip" key={tag.id}>{tag.name}</span>)}</div></div>
            <button type="button" className={item.isFavorite ? "icon-button favorite-button is-favorite" : "icon-button favorite-button"} aria-label={item.isFavorite ? "取消收藏" : "收藏资料"} title={item.isFavorite ? "取消收藏" : "收藏资料"} onClick={(event) => void toggleFavorite(event, item)}><Star aria-hidden="true" fill={item.isFavorite ? "currentColor" : "none"} /></button>
          </article>)}
        </div>
      </section>

      <section className="workspace" aria-label="工作区">
        {!selected && <div className="workspace-empty"><FolderOpen aria-hidden="true" /><h1>选择一份资料</h1><p>搜索结果会在这里打开受控查看器。</p></div>}
        {selected && workspace.kind === "loading" && <div className="workspace-empty"><RefreshCw className="is-spinning" aria-hidden="true" /><h1>正在打开文档</h1><p>正在通过 Document ID 请求受控内容。</p></div>}
        {selected && workspace.kind === "error" && <div className="workspace-empty workspace-empty--error"><FileWarning aria-hidden="true" /><h1>无法打开文档</h1><p>{workspace.error.code} · {workspace.error.message}</p><button type="button" onClick={() => void loadDocument(selected, mode)}>重试</button></div>}
        {selected && workspace.kind === "ready" && (() => {
          const adapter = adapterRegistry.resolve(workspace.opened.document.format);
          const descriptor = adapter.descriptor(workspace.opened.document.format, workspace.opened.mode);
          const canSave = workspace.opened.capabilities.canSave && !workspace.opened.readOnly;
          return <div className="viewer-workspace">
            <header className="viewer-header"><div><p className="workspace-overline">{descriptor.label}</p><h1>{selected.document.displayName}</h1><p className="workspace-path">{pathTail(selected.document.canonicalPath)}</p></div><div className="mode-control" aria-label="文档模式"><button type="button" className={mode === "read-only" ? "is-active" : ""} onClick={() => void changeMode("read-only")} title="只读"><Eye aria-hidden="true" /></button><button type="button" className={mode === "edit" ? "is-active" : ""} onClick={() => void changeMode("edit")} title="编辑"><PenLine aria-hidden="true" /></button><button type="button" className={mode === "assist" ? "is-active" : ""} onClick={() => void changeMode("assist")} title="协助修改"><Sparkles aria-hidden="true" /></button></div></header>
            {(workspace.notice || workspace.opened.warnings.length > 0 || descriptor.fallbackReason) && <div className="viewer-notice"><FileWarning aria-hidden="true" /><span>{workspace.notice ?? workspace.opened.warnings[0] ?? descriptor.fallbackReason}</span></div>}
            {workspace.error && <div className="conflict-panel" role="alert"><strong>{workspace.error.code}</strong><p>{workspace.error.message}</p><div><button type="button" onClick={() => void discardLocalChanges()}>放弃本地修改</button><button type="button" onClick={() => void loadDocument(selected, "read-only")}>比较当前文件</button><button type="button" onClick={() => setSnapshotChoice(snapshots[0]?.id ?? "")}>恢复快照</button><button type="button" disabled title="另存将保留为下一阶段的系统文件对话框入口">另存</button></div></div>}
            <div className="viewer-body">
              <div className="document-surface">
                {adapter.kind === "text" && <textarea aria-label="文档正文" value={workspace.draft} readOnly={!canSave} onChange={(event) => setWorkspace((current) => current.kind === "ready" ? { ...current, draft: event.target.value, notice: null } : current)} />}
                {adapter.kind === "pdf" && <PdfViewer binaryContent={workspace.opened.binaryContent} />}
                {(adapter.kind === "office" || adapter.kind === "read-only") && <div className="viewer-fallback"><FileWarning aria-hidden="true" /><p>{descriptor.fallbackReason}</p><small>当前文档保持受控只读，批注可独立保存。</small></div>}
              </div>
              <aside className="annotation-pane"><div className="annotation-heading"><span>批注</span><MessageSquarePlus aria-hidden="true" /></div><textarea aria-label="新批注" value={annotationBody} onChange={(event) => setAnnotationBody(event.target.value)} placeholder="添加批注" /><button type="button" onClick={() => void createAnnotation()} disabled={!annotationBody.trim()}>保存批注</button><div className="annotation-list">{annotations.length === 0 ? <p>暂无批注</p> : annotations.map((annotation) => <article key={annotation.id}><strong>{annotation.anchor.kind}{annotation.anchor.page ? ` · 第 ${annotation.anchor.page} 页` : ""}</strong><p>{annotation.body}</p><small>{annotation.anchor.stable ? "稳定锚点" : "引用文本锚点"}</small></article>)}</div><section className="ai-panel" aria-labelledby="ai-title"><div className="annotation-heading"><span id="ai-title">AI 助手</span><Sparkles aria-hidden="true" /></div><select aria-label="AI 权限" value={aiPermission} onChange={(event) => { setAiPermission(event.target.value as AiPermission); setAiPreview(null); }}><option value="suggest">建议（只读）</option><option value="assist">协助修改（需接受）</option><option value="autonomous">自主修改（限当前文档）</option></select><textarea aria-label="AI 请求" value={aiPrompt} onChange={(event) => { setAiPrompt(event.target.value); setAiPreview(null); }} placeholder="输入问题或修改要求" /><div className="ai-actions"><button type="button" onClick={() => void previewAi()} disabled={!aiPrompt.trim() || aiBusy}>预览上下文</button><button type="button" onClick={() => void runAi()} disabled={!aiPreview || aiBusy}>{aiBusy ? "生成中" : "发送"}</button></div>{aiPreview && <div className="ai-preview"><strong>发送前确认</strong><span>{aiPreview.sources.length} 个来源 · {aiPreview.characterCount} 字 · 约 {aiPreview.estimatedTokens} tokens</span><span>权限：{aiPreview.permission} · 文档内容不可信</span></div>}<div className="ai-events" aria-live="polite">{aiEvents.map((event, index) => <article key={`${event.kind}-${index}`}><strong>{event.kind === "textDelta" ? "AI" : event.kind === "toolRequest" ? "工具请求" : event.kind === "completed" ? "完成" : event.code}</strong><p>{event.kind === "textDelta" ? event.text : event.kind === "toolRequest" ? `${event.name}（待审阅）` : event.kind === "error" ? event.message : "已收到完整响应"}</p></article>)}</div></section></aside>
            </div>
            <footer className="viewer-footer"><div><button type="button" className="icon-button" aria-label="查看快照" title="快照"><History aria-hidden="true" /></button><select aria-label="恢复快照" value={snapshotChoice} onChange={(event) => setSnapshotChoice(event.target.value)}><option value="">选择快照恢复</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAtMs).toLocaleString("zh-CN")} · {snapshot.byteLen} B</option>)}</select><button type="button" className="icon-button" aria-label="恢复所选快照" title="恢复快照" disabled={!snapshotChoice} onClick={() => void restoreSelectedSnapshot()}><RotateCcw aria-hidden="true" /></button></div><div><button type="button" className="icon-button" aria-label="关闭文档" title="关闭" onClick={() => { void closeDocument(selected.document.id); setWorkspace({ kind: "idle" }); setSelected(null); }}><X aria-hidden="true" /></button><button type="button" className="save-button" disabled={!canSave} onClick={() => void saveWorkspace()}><Save aria-hidden="true" />保存</button></div></footer>
          </div>;
        })()}
      </section>
    </main>
  );
}
