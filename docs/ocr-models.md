# OCR 模型与离线部署

工期 5 使用 `ppocr-rs 0.7.3`（Apache-2.0）提供 PP-OCRv6 Tiny 中英识别，底层固定为 `ort 2.0.0-rc.9` / ONNX Runtime CPU 1.28。应用不启用 `fetch-models`，运行期间绝不下载、上传或传输用户文档。

## 本地模型布局

应用数据目录中 `library.sqlite3` 同级的 `ocr-models/` 是唯一模型来源：

```text
ocr-models/
  pp-ocrv6-tiny/
    det.onnx
    rec.onnx
    dictionary.txt
    orientation.onnx              # 可选；PP-LCNet 文档旋转 0/90/180/270
  runtime/
    onnxruntime.dll               # Windows x64 CPU runtime
```

固定模型标识是 `PP-OCRv6-tiny-2026.08`，检测/识别来源为 PaddlePaddle 的 `PP-OCRv6_tiny_det_onnx` 和 `PP-OCRv6_tiny_rec_onnx` 发布物；可选方向模型来源为 `PP-LCNet_x1_0_doc_ori_onnx`。`dictionary.txt` 必须由同一个识别模型的 `inference.yml` 中 `PostProcess.character_dict` 导出，不能使用通用 `ppocrv6_dict.txt`，否则 CTC 字表与 Tiny 输出维度不匹配。

模型取得是安装/运维时的显式离线步骤：从批准的发布物下载到隔离机器，记录 SHA-256、文件大小、来源提交和取得日期，再复制到上述目录。当前开发环境无法连接 Hugging Face，未记录未经验证的二进制校验值，也没有把模型二进制提交到 Git。缺少任一必需文件时返回 `OCR_MODEL_MISSING`；ONNX 加载或推理失败返回 `OCR_MODEL_INVALID` 或 `OCR_RUNTIME_UNAVAILABLE`，均可重试。

## PDF 渲染

扫描 PDF 使用本机 `pdftoppm` 在系统临时目录按页生成 200 DPI PNG，OCR 完成后删除该受控临时目录。`pdftoppm` 不存在时返回 `OCR_PDF_RENDERER_UNAVAILABLE`。有有效文本层的 PDF 不调用渲染器或模型，而是由 `lopdf 0.38.0` 本地提取页文本。

## 性能记录

本期自动化验证没有可校验的 PP-OCR/ONNX 模型样本，因此不声明准确率、单页耗时、内存峰值或失败率。任务表已持久化模型字节数、总耗时和每页推理耗时；`ocr_metrics` 记录 `resource_bytes`（加载的模型与运行时总字节数）以便安装模型后按同一 schema 采集。上线验收必须以中英、旋转、空白、文本层/扫描 PDF、PNG/JPG/TIFF/BMP 与损坏输入跑完整样本矩阵，并在 `TEST_MATRIX.md` 填入真实数字。
