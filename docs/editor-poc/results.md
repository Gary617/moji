# ZetaOffice Editor POC Results

- Conclusion: **BLOCKED**
- Runtime: unavailable
- Samples: 24 total, 0 PASS, 0 DEGRADED, 24 FAIL

| Sample | Format | Features | Status | Reason / fallback |
| --- | --- | --- | --- | --- |
| docx-basic | docx | 正文 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-table | docx | 表格 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-image | docx | 图片 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-comments | docx | 批注 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-cjk-font | docx | 中文字体 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-complex-layout | docx | 复杂排版、页眉页脚 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-header-footer | docx | 页眉页脚 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| docx-long-text | docx | 长文本、中文字体 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-basic | pptx | 单页演示 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-table | pptx | 表格 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-image | pptx | 图片 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-chart | pptx | 图表 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-comments | pptx | 批注 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-cjk-font | pptx | 中文字体 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-complex-layout | pptx | 复杂排版、多页 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| pptx-multi-slide | pptx | 多页、图片、图表 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-basic | xlsx | 单表 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-table | xlsx | 表格 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-image | xlsx | 图片 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-chart | xlsx | 图表 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-comments | xlsx | 批注 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-cjk-font | xlsx | 中文字体 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-complex-layout | xlsx | 复杂排版、合并单元格 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |
| xlsx-formula | xlsx | 公式、图表、中文字体 | FAIL | ZETA_RUNTIME_UNAVAILABLE: 文档无法由 ZetaOffice 打开; read-only-preview |

A FAIL never writes the source fixture. The generated JSON retains source hashes and operation phase for audit.
