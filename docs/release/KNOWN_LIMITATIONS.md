# Known Limitations: Moji 0.1.0

Status: release candidate blocked on 2026-08-19.

## Release blockers

- The production `secure-db` build could not complete on this workstation. `rusqlite/bundled-sqlcipher-vendored-openssl` is configured, but the vendored OpenSSL build requires Perl and `perl` is not installed. No plaintext SQLite fallback is allowed.
- No NSIS installer was produced, so Windows 10/11 install, first launch, upgrade, migration, uninstall, data retention/deletion, rollback, and crash recovery remain `NOT TESTED`.
- A production database encryption smoke test has not run. The required checks are non-empty `PRAGMA cipher_version`, encrypted OCR/Snapshot contents, and failure to open a copied database without its DPAPI sidecar key.

## Product limitations

- DOCX/PPTX/XLSX use the read-only degraded product path until a Tauri/WebView2 Office runtime bridge is configured. The browser POC is separate evidence and does not prove the installed desktop path.
- PDF viewing currently renders the first page only. Stable paragraph/page anchoring is incomplete for non-OCR text.
- OCR evidence is a small synthetic matrix: 240-271 ms per warmed text page, 225 ms for a blank page, and 159.7 MiB peak working set. It is not a production-language accuracy or large-file benchmark.
- Search p95 is 53 ms for 1,000 indexed in-memory records and 30 queries. Disk-backed large-library throughput is not established.
- Real OpenAI Credential Manager, SSE cancellation/reconnect, ACL/rotation, and approved-key smoke tests were not run.
- The Node Office runner remains `BLOCKED` without a Node runtime bridge. It must not be replaced by mock or browser evidence.
- The required Windows 10/11 viewport, DPI scaling, keyboard navigation, long-text, loading, empty, and error-state acceptance pass is not recorded in this window.

## Recovery and data handling

- The application never moves or deletes source documents.
- Text write-back uses Snapshot, SHA-256 conflict detection, same-directory temporary files, atomic replacement, and backup recovery. A residual `.moji-tmp` or `.moji-backup` file must be compared before manual cleanup.
- Uninstall is configured as current-user NSIS packaging and is intended to preserve `%LOCALAPPDATA%\\com.moji.desktop`; this retention behavior is not yet installer-tested.
