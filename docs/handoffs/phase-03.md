# Phase 03 Handoff

- 阶段状态: complete
- 分支: `codex/phase-03-search-organization`
- 目标: 在工期 2 的 `DocumentId` 和扫描事件之上提供中文全文检索、过滤、虚拟集合/标签和三栏资料库 UI。

## 已完成

- SQLite migration v2 幂等创建 `document_fts` FTS5 trigram 索引，字段为 `title`、`body`、`path`、`tags`、`ocr`，以及 `document_search_content`、`document_search_state`。
- `library_search` 支持中文子串、标题/正文/路径/标签/OCR 权重、格式/时间/来源/集合/标签/状态/收藏/最近使用过滤、分页和匹配片段。
- `Collection`/`Tag` 使用 `document_collections`/`document_tags` 多对多关系；`document_usage` 保存收藏与最近使用。不移动、复制、重命名或覆盖源文件。
- 查询结果稳定返回 `DocumentId`、必要展示字段、`SearchSnippet[]`、标签、集合、收藏状态、索引状态和 `SourceLocator`。当前 `SourceLocator.available=false`，明确标记页码/幻灯片/段落定位未实现。
- 元数据 upsert 后刷新索引，失败写入独立 search state；`library_rebuild_search_index` 从已登记 Document 重建，不会破坏元数据。
- 三栏 React UI 已接入搜索、格式/状态/时间/来源筛选、集合/标签导航、收藏/最近使用、重建索引、选中文档工作区和集合/标签添加动作；加载、空、无结果、错误状态均可见。

## 稳定 IPC

```text
library_search(SearchQuery) -> IpcResponse<SearchResults>
library_list_sources() -> IpcResponse<SourceRootRecord[]>
library_list_collections() -> IpcResponse<CollectionRecord[]>
library_list_tags() -> IpcResponse<TagRecord[]>
library_create_collection({ name }) -> IpcResponse<CollectionRecord>
library_create_tag({ name }) -> IpcResponse<TagRecord>
library_set_collection_membership({ documentId, relationId, included }) -> IpcResponse<null>
library_set_tag_membership({ documentId, relationId, included }) -> IpcResponse<null>
library_set_favorite({ documentId, favorite }) -> IpcResponse<null>
library_record_recent_use({ documentId }) -> IpcResponse<null>
library_rebuild_search_index() -> IpcResponse<IndexRebuildSummary>
```

`SearchQuery` 的字段和 camelCase 序列化由 `src/ipc/library.ts` 固定；工期 4 不得改变 `DocumentId`、`SearchResults.items[].sourceLocator` 或过滤字段名称。

## 验证

- Rust: 22/22 tests PASS；覆盖 migration v2、中文子串、字段权重、组合过滤、多对多、重建和 metadata safety。
- Frontend: 10/10 tests PASS；覆盖新 UI 状态、IPC 请求形状和稳定 Document/关系 ID。
- Build: `pnpm build` PASS；`cargo fmt` PASS；`cargo test --manifest-path src-tauri/Cargo.toml` PASS。
- Performance: 1,000 文档、30 次已索引查询、limit 50，p95 53 ms；AMD Ryzen 7 8845H、8C/16T、27.8 GB RAM、Windows 11 家庭版 10.0.26200。测试使用 bundled SQLite 内存数据库。
- UI: 本地 Vite 页面已用桌面默认视口和 390x844 视口检查，三栏/移动结果列表无重叠；无 Tauri bridge 时显示 `IPC_TRANSPORT_ERROR` 和通用消息，不泄漏 invoke 内部文本。

## 未实现与风险

- 扫描器仍只提供元数据，正文提取、OCR、Office/PDF 查看和页码/幻灯片/段落定位未实现；SourceLocator 已明确标记。
- FTS5 trigram 依赖 bundled SQLite；一至两字查询使用标题/路径/标签 LIKE 回退。超大磁盘库、正文提取后的性能需要后续重新基准。
- `document_fts` 当前存储受控 canonical path 作为可搜索字段；UI 不把它当主键，仅显示路径尾部。后续查看器必须继续通过 DocumentId 取文档。

## 工期 4 依赖

查看器/编辑器可直接消费 `SearchResults.items[]`，以 `document.id` 打开候选文档，并在不改变查询字段、排序/片段结构、SourceLocator 字段和源文件保护不变量的前提下补充定位能力。
