# Third-Party Notices

本清单覆盖本仓库直接依赖及其发布时必须保留的许可证信息。完整传递依赖和版本以 `pnpm-lock.yaml`、`src-tauri/Cargo.lock` 为准；发布流水线必须重新运行许可证与漏洞扫描。

## JavaScript / TypeScript

| Dependency | Version | License / source |
| --- | --- | --- |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT |
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT |
| `react`, `react-dom` | 19.2.8 | MIT |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 |
| `lucide-react` | 1.32.0 | ISC |
| `fflate` | 0.8.2 | MIT |
| `vite`, `typescript`, `vitest` | 8.2.1 / 7.0.2 / 4.1.11 | MIT |
| `@testing-library/*`, `jsdom` | pinned in `package.json` | MIT |

## Rust

| Dependency | Version | License / source |
| --- | --- | --- |
| `tauri`, `tauri-build` | 2.11.5 / 2.6.3 | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.7.2 | Apache-2.0 OR MIT |
| `base64` | 0.22.1 | MIT OR Apache-2.0 |
| `rusqlite` / bundled SQLite | 0.40.2 / lockfile | MIT; SQLite public domain; production feature requires SQLCipher (BSD-style) |
| `reqwest` | 0.13.4 | MIT OR Apache-2.0 |
| `notify` | 8.2.0 | CC0-1.0 |
| `lopdf` | 0.38.0 | MIT |
| `image` | 0.25.9 | MIT OR Apache-2.0 |
| `ppocr-rs` | 0.7.3 | Apache-2.0 |
| `file-id` | 0.2.3 | MIT OR Apache-2.0 |
| `serde`, `serde_json` | 1.0.229 / 1.0.151 | MIT OR Apache-2.0 |
| `sha2` | 0.11.0 | MIT OR Apache-2.0 |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 |
| `zip` | 6.0.0 | MIT |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 |
| `tracing`, `tracing-subscriber` | 0.1.44 / 0.3.23 | MIT |

## Runtime assets

- WebView2 Runtime is a Microsoft redistributable dependency and must follow its Microsoft license and evergreen runtime terms.
- DOCX basic editor uses the bundled `fflate` JavaScript dependency only. It does not use a network runtime, ZetaOffice, LibreOffice, or Microsoft Office.
- PP-OCR/ONNX model and runtime files are offline installation assets, not committed to this repository; their upstream licenses and hashes must be attached to the release artifact.
- The release build uses `rusqlite/bundled-sqlcipher-vendored-openssl`; the vendored OpenSSL source is built by Cargo and remains subject to its upstream Apache-2.0 license and NOTICE requirements.
- NSIS is the Windows installer target. Its installer/runtime licensing and any bundled WebView2 redistributable terms must be attached to the final installer artifact.
