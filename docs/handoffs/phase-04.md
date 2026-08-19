# Phase 04 Handoff

- 阶段状态：complete；提交建议：`feat: add document viewers editing and recovery`
- 目标：从 `library_search` 结果通过稳定 Document ID 打开文档，在中间工作区阅读、编辑、批注和安全恢复。

## 稳定接口

```text
document_open({ documentId, mode }) -> IpcResponse<DocumentOpenResult>
document_save({ documentId, expectedSha256, content, mode }) -> IpcResponse<DocumentSaveResult>
document_close({ documentId }) -> IpcResponse<null>
document_list_snapshots({ documentId }) -> IpcResponse<SnapshotRecord[]>
document_restore_snapshot({ documentId, snapshotId, expectedSha256 }) -> IpcResponse<DocumentSaveResult>
document_list_annotations({ documentId }) -> IpcResponse<AnnotationRecord[]>
document_add_annotation({ documentId, author, body, anchor }) -> IpcResponse<AnnotationRecord>
document_delete_annotation({ annotationId }) -> IpcResponse<null>
```

前端入口位于 `src/ipc/document.ts`；`src/document/registry.ts` 是格式到适配器的唯一分流点。现有 `library_search` 返回字段、过滤参数、Document ID 和 SourceLocator 未改名。

## 格式支持矩阵

| 格式 | 适配器 | 阅读 | 编辑/写回 | 批注锚点 | 降级 |
| --- | --- | --- | --- | --- | --- |
| Markdown/TXT/CSV | text | PASS | PASS，写前 Snapshot + SHA-256 冲突检测 | 字符范围 + 引用文本，当前 unstable | 需正文解析后提升稳定性 |
| PDF | PDF.js | PASS，第一页 | READ-ONLY | 页码锚点 | 多页导航/文本定位待后续 |
| DOCX/PPTX/XLSX | Office / EditorAdapter | DEGRADED | READ-ONLY | 文档级降级 | 桌面 ZetaOffice bridge 未接入；不可把浏览器 POC 代替产品 runtime |
| PNG/JPG/TIFF/BMP/其他 | read-only | metadata fallback | READ-ONLY | 文档级降级 | 无业务查看器 |

## 写回与恢复证据

`document_snapshots` 在每次文本写回前存储原始字节、原始 SHA-256、Document ID 和时间。保存前重新读取文件；哈希变化返回 `DOCUMENT_CONFLICT`，不创建 Snapshot、不写文件，并给出放弃、另存、比较、恢复动作。写回使用临时文件、备份和结果哈希校验；失败时尝试从备份恢复。恢复 Snapshot 前再次创建当前版本 Snapshot 并执行相同冲突校验。该表和 Annotation 表由 v3 增量创建；当前工作树若已有后续迁移，最终 schema 版本更高不影响接口。

Rust 文档服务测试覆盖：正常保存/重开/恢复、外部修改不覆盖原文件、批注保存/重载；当前 25/25 Rust 库测试通过。前端 IPC/Registry 测试 14/14 通过，生产构建通过。

## 工期 5 复用契约

- 正文写入搜索索引必须继续使用 `DocumentId`，不能从前端路径读取或重扫未授权目录。
- 稳定来源定位扩展 `SourceLocator` 的既有 `kind/page/slide/paragraph/available/reason` 字段；批注锚点可在解析完成后把 `stable` 从 false 提升为 true，但保留 quote 作为回退证据。
- Office bridge 接入必须复用 `EditorAdapter` 的 `healthCheck/open/readOnlyPreview/edit/saveAs/close`，并由 Registry 能力查询决定 UI 是否开启编辑；不得绕过 Snapshot 和冲突检测。
- OCR 不属于工期 4 的实现或验收范围；当前工作树若包含并发 OCR 模块，工期 4 不消费其接口，也不把它当作本阶段证据。
