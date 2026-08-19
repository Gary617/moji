# Phase 05 Handoff

- 阶段状态: implementation complete; real-model benchmark pending approved offline model artifacts
- 分支: `codex/phase-05-ocr-pipeline`
- 目标: 以稳定 `DocumentId` 为边界，为扫描 PDF 和图片提供后台本地 OCR、页码、文本框坐标、FTS 写入与原页定位。

## 已完成

- SQLite migration v4 新增 `ocr_jobs`、`ocr_pages`、`ocr_text_boxes`、`ocr_metrics`；没有创建平行文档表。OCR 结果始终外键关联既有 `documents.id`。
- `library_start_ocr` 只消费授权 `DocumentId` 并立即创建持久化任务；`library_ocr_status`、暂停、恢复、取消、重试复用既有 `queued|running|paused|cancelled|failed|completed` 状态模型和独立 SQLite worker 模式。
- 支持 PDF、PNG、JPG/JPEG、TIFF、BMP。PDF 先由 `lopdf` 判断有效文本层：存在文本层时保存 `text_layer` 页片段并跳过 OCR；无文本层 PDF 使用本机 `pdftoppm` 按页渲染后进入 PP-OCR。
- PP-OCRv6 Tiny 通过 `ppocr-rs 0.7.3` 在 ONNX Runtime CPU 上运行；可选 PP-LCNet 方向模型支持 0/90/180/270 度，并将文字框坐标逆变换回原始页空间。模型只能从应用数据目录本地读取，不提供网络下载路径。
- 每页保存文本、平均置信度、图像宽高、旋转角、文字框四点坐标和来源 (`ocr|text_layer|blank`)；OCR 文本增量写入既有 `document_search_content.ocr` / `document_fts.ocr`。
- 搜索命中 OCR 文本时，现有 `SourceLocator` 仅最小增加 `boundingBox`，并返回 `page` 与坐标。工期 4 的字段没有重命名或移除。

## 稳定 IPC

```text
library_ocr_model_status() -> IpcResponse<OcrModelStatus>
library_start_ocr({ documentId }) -> IpcResponse<OcrJobRecord>
library_ocr_status({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_pause_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_resume_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_cancel_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_retry_ocr({ ocrJobId }) -> IpcResponse<OcrJobRecord>
library_document_fragments({ documentId, page? }) -> IpcResponse<DocumentFragment[]>
```

## 工期 6 唯一正文入口

工期 6 只能通过 `library_document_fragments({ documentId, page? })` 读取统一文档片段。每个 `DocumentFragment` 包含 `documentId/page/source/text/confidence/width/height/rotationDegrees/boxes/sourceLocator`，其中 `boxes[].boundingBox.points` 是原页像素坐标。不得读取 `ocr_*` 私有表、canonical path 或临时 PNG。

## 失败与离线行为

- `OCR_MODEL_MISSING`：本地模型或 `onnxruntime.dll` 缺失；可重试。
- `OCR_MODEL_INVALID`、`OCR_RUNTIME_UNAVAILABLE`：模型损坏/不兼容或运行时加载失败；可重试。
- `OCR_CORRUPT_DOCUMENT`：损坏或空 PDF/图片；`OCR_PDF_RENDERER_UNAVAILABLE`：缺少本机渲染器；`OCR_INPUT_CHANGED`：排队后源文件修改；`OCR_PAGE_FAILED`：页渲染/识别失败。
- 应用重开将 `running` OCR 任务转为 `paused`；恢复或重试均由新的后台 worker 处理。原文件始终只读。

## 验证与性能

- Rust 单元：29/29 PASS；覆盖 v4 migration、OCR 任务元数据/进度、页片段/坐标、OCR FTS 与命中页定位、模型缺失、PDF 文本层阈值。
- 前端 IPC：新增 OCR 任务与文档片段请求形状测试。
- 真实模型样本、准确率、单页耗时、内存与失败率尚未产生：当前环境不能连接批准的模型来源，详见 [ocr-models.md](../ocr-models.md)。`ocr_metrics` 已准备记录每页及总耗时和模型/运行时字节数；不得在未运行模型前宣称性能。
