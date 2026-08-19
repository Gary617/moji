# OCR 模型与离线部署

工期 5 使用 `ppocr-rs 0.7.3`（Apache-2.0）提供 PP-OCRv6 Tiny 中英识别，底层固定为 `ort 2.0.0-rc.9` / ONNX Runtime CPU 1.26.0（DLL product version `1.26.20260508.2.8c546c3`）。应用不启用 `fetch-models`，运行期间绝不下载、上传或传输用户文档。

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
    onnxruntime_providers_shared.dll
  poppler/
    bin/pdftoppm.exe              # Windows x64 PDF renderer
    etc/                           # Poppler runtime configuration
    share/                         # Poppler data files
```

固定模型标识是 `PP-OCRv6-tiny-2026.08`，检测/识别来源为 PaddlePaddle 的 `PP-OCRv6_tiny_det_onnx` 和 `PP-OCRv6_tiny_rec_onnx` 发布物；可选方向模型来源为 `PP-LCNet_x1_0_doc_ori_onnx`。`dictionary.txt` 必须由同一个识别模型的 `inference.yml` 中 `PostProcess.character_dict` 导出，不能使用通用 `ppocrv6_dict.txt`，否则 CTC 字表与 Tiny 输出维度不匹配。

2026-08-19 的验收安装来自 PaddlePaddle 官方 Hugging Face 仓库。当前网络不能访问 `huggingface.co`，因此经 `hf-mirror.com` 镜像取得相同提交并在落盘后校验 SHA-256；该镜像只用于安装模型，不参与 OCR 推理，用户文档不会发送到镜像或任何网络服务。正式安装仍应把校验后的资产随离线安装介质复制到上述目录，不在应用运行时下载。

| 资产 | 上游提交 | SHA-256 |
| --- | --- | --- |
| `det.onnx` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx@2ba1506c0380b8f0b03dd142459aac66d4421f6c` | `193BAB7A04FCA699A6C82E6ABB5B81BDB28177F0ABD4062552B04908DAFB19F8` |
| `rec.onnx` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx@2612ab37152ae0a677521bae4e1e3d4fb4cf7c30` | `9EF676D6ED3C88256A2D92C640C44F25B0C40947E111B14B8BE8F594091563E6` |
| `dictionary.txt`（6,904 项） | 与上述识别模型相同提交的 `inference.yml` | `C5CBE34EF40C29C4DF07ED012BF96569CB69A2D2A01A07027E9F13CB832BD9CD` |
| `orientation.onnx` | `PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx@7330ab7039123e46af2dc03154b9969aa412c61d` | `AF9A0A4F317FF0709CE752067807F819CB15D883F8ECAD89F28DF1C6EE2D9C92` |
| `onnxruntime.dll` | Microsoft ONNX Runtime CPU 1.26.0 | `EFA14DC0F3E8D6E4FC7CE0B9B5AA70D6E27DEEC908AF05C1FA9A37270F57460B` |
| `onnxruntime_providers_shared.dll` | Microsoft ONNX Runtime CPU 1.26.0 | `44396F2913E798DF4121384F37F84A4B79AA1229EA9467BD35E48711CD6CDF22` |

验收机安装位置是 `%LOCALAPPDATA%/com.moji.desktop/ocr-models/`，模型二进制不提交到 Git。缺少任一必需文件时返回 `OCR_MODEL_MISSING`；ONNX 加载或推理失败返回 `OCR_MODEL_INVALID` 或 `OCR_RUNTIME_UNAVAILABLE`，均可重试。安装完成后应用完全离线推理，不调用云 OCR 或 AI API。

## PDF 渲染

扫描 PDF 优先使用同一受控目录的 `poppler/bin/pdftoppm.exe`，仅在该文件不存在时回退到进程 `PATH`；渲染器在系统临时目录按页生成 200 DPI PNG，OCR 完成后删除该受控临时目录。两处都不可用时返回 `OCR_PDF_RENDERER_UNAVAILABLE`。验收安装为 Poppler 26.05.0，`pdftoppm.exe` SHA-256 是 `742CBBD9A00931AD16C6618410BC40471375D639A45C61C1D86F3DCFC54B6388`。有有效文本层的 PDF 不调用渲染器或模型，而是由 `lopdf 0.38.0` 本地提取页文本；页内只要存在至少一个有效中英文、数字或汉字字符就视为文本层，短标题和页码也不会重复 OCR。

## 性能记录

验收机为 AMD Ryzen 7 8845H / 27.8 GB / Windows 11，使用 release 独立推理进程。9 文件矩阵包含 PNG/JPG/TIFF/BMP、旋转 PNG、空白 PNG、有文本层 PDF、扫描 PDF 和损坏 PNG。中文 `文档管理系统` 与英文 `Local OCR Test 123` 在四种位图和旋转图中均严格逐字匹配；扫描 PDF 的中英目标也逐字匹配，当前合成小样本字符串准确率为 100%。这是小规模功能样本，不能外推为真实业务语料准确率。

- 冷模型加载：263-298 ms。
- 预热后的有文字页：240-271 ms/页；空白页：225 ms。
- 峰值工作集：159.7 MiB。
- 6 个有效 OCR 输入失败 0；损坏输入按预期返回结构化解码错误，空白页返回 0 个文字框。
- 扫描 PDF 平均置信度约 0.9866；旋转样本识别为 270 度，文字框坐标已逆变换回原页。

资料库端到端 debug 流程另以 3 个文档验证 `DocumentId -> OCR/text_layer -> fragments -> FTS -> page/boundingBox`，1/1 PASS，总耗时 25.22 秒；该数字包含扫描、PDF 渲染、数据库和 debug 开销，不作为 release 单页性能。任务表持久化总耗时和每页推理耗时，`ocr_metrics.resource_bytes` 记录加载资产规模。
