# Office Editor POC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate a replaceable DOCX/PPTX/XLSX editor boundary and produce honest ZetaOffice/zetajs round-trip evidence without overwriting source files.

**Architecture:** Keep editor code behind a TypeScript `EditorAdapter` contract. `ZetaOfficeAdapter` owns the zetajs-specific bridge and reports structured capability, format, runtime, and round-trip errors. A deterministic `MockEditorAdapter` exercises the contract only; it is never counted as POC evidence. A Node POC runner consumes a checked-in 24-row sample manifest, copies inputs to a temporary workspace, runs open/edit/save/close/reopen/validate, and emits JSON plus Markdown results. When the runtime or sample is unavailable, the runner records `FAIL` and a read-only fallback instead of claiming success.

**Tech Stack:** Tauri 2 + React + TypeScript, `zetajs` `1.2.0` (MIT), Vitest, Node 24.19 workspace runtime, PowerShell/Node POC runner.

---

### Task 1: Define the adapter contract and error taxonomy

**Files:**
- Create: `src/editor/types.ts`
- Create: `src/editor/errors.ts`
- Test: `tests/frontend/editor-adapter.test.ts`

Define document formats, capability state, operation result, structured error codes, read-only fallback metadata, and the six required adapter methods: `healthCheck`, `open`, `readOnlyPreview`, `edit`, `saveAs`, `close`.

### Task 2: Implement mock and ZetaOffice adapters

**Files:**
- Create: `src/editor/mockAdapter.ts`
- Create: `src/editor/zetaOfficeAdapter.ts`
- Modify: `src/editor/index.ts`
- Test: `tests/frontend/editor-adapter.test.ts`

Make the mock deterministic and in-memory. Keep all zetajs object access inside `ZetaOfficeAdapter`, use an injected `ZetaRuntime` bridge, reject unsafe source writes, and map runtime/format/save/reopen failures to stable errors with read-only fallback.

### Task 3: Add fixture manifest and reproducible round-trip runner

**Files:**
- Create: `tests/fixtures/office/manifest.json`
- Create: `scripts/run-editor-poc.mjs`
- Create: `scripts/generate-office-fixtures.mjs`
- Create: `docs/editor-poc/README.md`
- Create: `docs/editor-poc/results.json`
- Create: `docs/editor-poc/results.md`

Declare 24 representative rows across DOCX/PPTX/XLSX, generate minimal deterministic OOXML fixtures with feature metadata, and run the real adapter through a temp copy. Never write the source path; validate output existence and ZIP/XML integrity before reopening. Missing runtime or fixture is a recorded failure.

### Task 4: Wire tests and documentation

**Files:**
- Modify: `package.json`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TEST_MATRIX.md`
- Create: `docs/handoffs/phase-01.md`

Add `test:editor-poc` and `generate:office-fixtures` commands, record official sources/version/license/Windows support, document the stable interface and POC conclusion, and preserve explicit next-phase decision options if blocked.

### Task 5: Verify and commit

Run the frozen install with the workspace Node, frontend tests, Rust tests, production build, fixture generation, and the POC runner. Review `git diff --check`, confirm source fixture hashes are unchanged, then commit as `feat: validate office editor integration`.
