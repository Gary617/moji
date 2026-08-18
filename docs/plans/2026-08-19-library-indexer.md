# Local Library Indexer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建立不移动原文件的本地资料库核心，支持授权来源、SQLite 元数据、排除规则、增量扫描和可恢复扫描任务。

**Architecture:** Rust library owns canonical path validation, filesystem metadata, SQLite migrations, scan reconciliation, and task state. Tauri IPC exposes only serializable request/response DTOs and stable `DocumentId`/scan-event values; React and the EditorAdapter remain consumers and never access private tables or ZetaOffice internals. A scan registers metadata first; content extraction is represented as a pending field and is out of scope.

**Tech Stack:** Rust 1.97.1, SQLite via `rusqlite` with bundled SQLite, Tauri 2 IPC, `notify` for an optional filesystem watcher, serde/serde_json, and Rust unit tests using temporary directories.

---

### Task 1: Add database and domain dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Step 1: Write the failing test**

Add a library module test that opens an in-memory database and expects a migration version and the `source_roots`, `documents`, and `scan_jobs` tables.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust`
Expected: FAIL because the library/indexer module and SQLite dependency do not exist.

**Step 3: Write minimal implementation**

Add exact `rusqlite` and `notify` dependencies and create the module declarations needed by later tasks.

**Step 4: Run test to verify it passes**

Run: `pnpm test:rust`
Expected: the migration test passes.

**Step 5: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/library
git commit -m "feat: add local library storage foundation"
```

### Task 2: Implement idempotent SQLite migration and domain models

**Files:**
- Create: `src-tauri/src/library/mod.rs`
- Create: `src-tauri/src/library/database.rs`
- Create: `src-tauri/src/library/model.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Write the failing test**

Test migration twice, verify `PRAGMA user_version = 1`, and verify a second run does not delete an inserted source root or document.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust`
Expected: FAIL before schema and model code exists.

**Step 3: Write minimal implementation**

Create tables for `source_roots`, `documents`, `scan_jobs`, and `scan_events`; use stable text IDs, canonical paths, optional Windows file IDs, SHA-256, and status fields. Expose typed `DocumentId`, `SourceRootId`, `ScanJobId`, `DocumentRecord`, `SourceRootRecord`, and `ScanEvent` values.

**Step 4: Run test to verify it passes**

Run: `pnpm test:rust`
Expected: migration and model tests pass.

**Step 5: Commit**

```powershell
git add src-tauri/src/library src-tauri/src/lib.rs
git commit -m "feat: define library metadata schema"
```

### Task 3: Implement authorization, canonical paths, and exclusion rules

**Files:**
- Create: `src-tauri/src/library/policy.rs`
- Modify: `src-tauri/src/library/model.rs`

**Step 1: Write the failing test**

Cover authorized directory and single-file imports, path traversal rejection, files outside a root, hidden/system/recycle-bin/node_modules paths, junction/reparse-point rejection, and duplicate roots.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust`
Expected: FAIL on missing policy implementation.

**Step 3: Write minimal implementation**

Normalize existing paths before authorization, compare case-insensitively on Windows, preserve the normalized path only as metadata, and keep `DocumentId` independent of absolute paths. Make exclusions explicit and inspectable; never expand a user's authorized roots implicitly.

**Step 4: Run test to verify it passes**

Run: `pnpm test:rust`
Expected: all policy tests pass on Windows and portable fallback tests pass elsewhere.

**Step 5: Commit**

```powershell
git add src-tauri/src/library/policy.rs src-tauri/src/library/model.rs
git commit -m "feat: enforce authorized source boundaries"
```

### Task 4: Implement metadata scanner and reconciliation

**Files:**
- Create: `src-tauri/src/library/scanner.rs`
- Modify: `src-tauri/src/library/database.rs`
- Modify: `src-tauri/src/library/mod.rs`

**Step 1: Write the failing test**

Use a temporary authorized directory to test initial registration, unchanged rescans, modification hash/mtime updates, external deletion, rename tracking through file ID or hash, unsupported files, locked/unreadable files, and duplicate imports.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust`
Expected: FAIL because reconciliation is not implemented.

**Step 3: Write minimal implementation**

Walk only authorized roots without following junctions, register supported document extensions and metadata (`format`, `size`, `mtime`, file ID, SHA-256), update rows idempotently, mark missing documents, and emit structured `ScanEvent` values. Read failures become per-file errors and never replace the source file.

**Step 4: Run test to verify it passes**

Run: `pnpm test:rust`
Expected: scanner tests pass with event counts and source hashes asserted.

**Step 5: Commit**

```powershell
git add src-tauri/src/library
git commit -m "feat: add incremental metadata scanner"
```

### Task 5: Add recoverable scan jobs and filesystem watcher adapter

**Files:**
- Create: `src-tauri/src/library/queue.rs`
- Create: `src-tauri/src/library/watcher.rs`
- Modify: `src-tauri/src/library/mod.rs`

**Step 1: Write the failing test**

Test queued/running/paused/cancelled/failed/completed transitions, retry count and resume after reopening the database; test watcher event normalization through a fake event source.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust`
Expected: FAIL because queue and watcher adapters do not exist.

**Step 3: Write minimal implementation**

Persist job state and progress in `scan_jobs`, expose cancel/pause/resume/retry operations, and provide a `notify`-backed watcher adapter that turns filesystem notifications into authorized scan requests. Watcher failures are structured and do not bypass policy.

**Step 4: Run test to verify it passes**

Run: `pnpm test:rust`
Expected: queue and watcher tests pass.

**Step 5: Commit**

```powershell
git add src-tauri/src/library
git commit -m "feat: add recoverable scan jobs"
```

### Task 6: Expose stable Tauri IPC and verify the full baseline

**Files:**
- Create: `src-tauri/src/ipc/library.rs`
- Modify: `src-tauri/src/ipc/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TEST_MATRIX.md`
- Create: `docs/handoffs/phase-02.md`

**Step 1: Write the failing test**

Add serialization tests for source-root registration, scan start/status, and structured permission/scan errors using the existing IPC envelope.

**Step 2: Run test to verify it fails**

Run: `pnpm test:rust; pnpm test`
Expected: FAIL before IPC DTOs and commands exist.

**Step 3: Write minimal implementation**

Add commands for registering authorized sources, starting and controlling scans, and reading scan events/status. Keep absolute paths out of long-lived frontend identifiers and use existing error-envelope conventions.

**Step 4: Run test to verify it passes**

Run: `pnpm test; pnpm test:rust; pnpm build; pnpm build:desktop`
Expected: all tests and both builds pass.

**Step 5: Commit**

```powershell
git add src-tauri/src/ipc src-tauri/src/lib.rs docs
git commit -m "feat: add authorized local document indexer"
```

