# Phase 08 Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce a reproducible Windows MVP release candidate or an evidence-backed blocked release verdict without weakening the existing security boundary.

**Architecture:** Keep all phase 0-7 contracts frozen. Build SQLCipher with Cargo's vendored OpenSSL feature so the encrypted database production build is self-contained, then configure a per-user NSIS installer that preserves application data on uninstall. Capture every unverified manual/platform check as `NOT TESTED`, never as a pass.

**Tech Stack:** Tauri 2.11, Rust 1.97, rusqlite/libsqlite3-sys SQLCipher, vendored OpenSSL, React/Vite, NSIS.

---

### Task 1: Make the production SQLCipher build self-contained

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `docs/DECISIONS.md`
- Test: `pnpm test:rust`

**Step 1:** Change the `secure-db` feature to forward `rusqlite/bundled-sqlcipher-vendored-openssl`.

**Step 2:** Run `pnpm test:rust` and `pnpm build:desktop` to verify the production feature builds without `OPENSSL_DIR`.

**Step 3:** Record the SQLCipher build decision, compatibility impact, and result without changing database schema or IPC.

### Task 2: Restore installable Windows packaging

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `docs/DECISIONS.md`

**Step 1:** Replace the release script's `--no-bundle` flag with an NSIS bundle target.

**Step 2:** Configure the bundle as a per-user Windows installer so installation, upgrade, and uninstall do not require elevation or delete `%LOCALAPPDATA%` data.

**Step 3:** Run the release build and record the installer path, checksum, and file size if generated.

### Task 3: Capture release evidence and handoff

**Files:**
- Create: `docs/release/0.1.0-rc.1.md`
- Create: `docs/release/KNOWN_LIMITATIONS.md`
- Create: `docs/release/USER_GUIDE.md`
- Create: `docs/release/TEST_REPORT-0.1.0-rc.1.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/TEST_MATRIX.md`
- Create: `docs/handoffs/phase-08.md`

**Step 1:** Record automated test, build, package, performance, security and sample-matrix evidence with `PASS`, `FAIL` or `NOT TESTED` only.

**Step 2:** Document the user workflow, data retention and recovery behavior, upgrade/rollback instructions, third-party notice location, and the Office/OCR/AI limitations.

**Step 3:** State the release verdict from the recorded release gates and leave all missing Windows 10/11, scaling, real-AI and manual UI checks visibly unverified.

### Task 4: Verify and checkpoint the candidate

**Files:**
- Modify: `C:\Users\Gary\.codex\automations\8\memory.md`

**Step 1:** Run frozen install, frontend tests, Rust tests, formatting, frontend build and release packaging.

**Step 2:** Compute checksums only for actual generated artifacts, then run `git diff --check` and inspect the final diff.

**Step 3:** Create a rollback commit only if all files accurately record the evidence and release verdict.
