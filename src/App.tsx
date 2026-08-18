import {
  Clock3,
  FolderKanban,
  FolderOpen,
  LayoutList,
  Plus,
  RefreshCw,
  Search,
  Star,
  Tag,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { healthCheck, type HealthCheckData } from "./ipc/health";
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

type HealthState =
  | { kind: "checking" }
  | { kind: "healthy"; data: HealthCheckData }
  | { kind: "unavailable"; error: IpcError };

type View = "all" | "favorites" | "recent";

type LibraryState =
  | { kind: "loading" }
  | { kind: "ready"; items: SearchDocument[]; total: number; queryTimeMs: number }
  | { kind: "error"; error: IpcError };

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
  const [collectionChoice, setCollectionChoice] = useState("");
  const [tagChoice, setTagChoice] = useState("");
  const [isRebuilding, setIsRebuilding] = useState(false);

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
  };

  const selectDocument = async (item: SearchDocument) => {
    setSelected(item);
    await recordRecentUse(item.document.id);
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
        {selected ? <div className="document-workspace"><div className={`workspace-file workspace-file--${selected.document.format}`}>{formatLabels[selected.document.format]}</div><div><p className="workspace-overline">{selected.document.status === "present" ? "已索引资料" : "文件不可用"}</p><h1>{selected.document.displayName}</h1><p className="workspace-path">{pathTail(selected.document.canonicalPath)}</p></div><div className="workspace-rule" /><div className="workspace-details"><div><span>来源定位</span><strong>{selected.sourceLocator.available ? selected.sourceLocator.kind : "未实现"}</strong><p>{selected.sourceLocator.reason}</p></div><div><span>索引状态</span><strong>{selected.indexState === "ready" ? "可搜索" : "索引异常"}</strong><p>正文与 OCR 字段为后续提取流程预留。</p></div></div><div className="organize-controls"><label>加入集合<select value={collectionChoice} onChange={(event) => setCollectionChoice(event.target.value)}><option value="">选择集合</option>{collections.filter((collection) => !selected.collections.some((current) => current.id === collection.id)).map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button type="button" className="icon-button" aria-label="加入所选集合" title="加入集合" disabled={!collectionChoice} onClick={() => void addSelectedCollection()}><Plus aria-hidden="true" /></button></label><label>添加标签<select value={tagChoice} onChange={(event) => setTagChoice(event.target.value)}><option value="">选择标签</option>{tags.filter((tag) => !selected.tags.some((current) => current.id === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select><button type="button" className="icon-button" aria-label="添加所选标签" title="添加标签" disabled={!tagChoice} onClick={() => void addSelectedTag()}><Plus aria-hidden="true" /></button></label></div></div> : <div className="workspace-empty"><FolderOpen aria-hidden="true" /><h1>选择一份资料</h1><p>搜索结果会在这里显示来源和后续查看器入口。</p></div>}
      </section>
    </main>
  );
}
