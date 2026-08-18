# Office Editor POC

This POC keeps Office editing behind `EditorAdapter`. The production boundary is `src/editor/zetaOfficeAdapter.ts`; callers do not use UNO or zetajs objects directly. `MockEditorAdapter` is contract-test evidence only and is never counted as a ZetaOffice result.

## Official sources checked on 2026-08-18

| Source | Version / status | License and Windows fact |
| --- | --- | --- |
| [allotropia/zetajs README](https://github.com/allotropia/zetajs) | Latest GitHub release `v1.2.0`, published 2025-06-11 | MIT; browser JavaScript wrapper over ZetaOffice/LibreOffice UNO |
| [zetajs package.json](https://raw.githubusercontent.com/allotropia/zetajs/v1.2.0/package.json) | npm `zetajs@1.2.0` | MIT; exports `zeta.js` and `zetaHelper.js` |
| [zetajs starting points](https://raw.githubusercontent.com/allotropia/zetajs/main/docs/start.md) | Current main documentation | Requires a `Module.zetajs` Promise; plain builds require an HTML canvas and worker integration |
| [ZetaOffice official site](https://zetaoffice.net/) | Open beta, checked 2026-08-18 | Based on LibreOffice; site advertises native Windows 64-bit, 32-bit and ARM64 desktop downloads plus browser/CDN/self-hosted deployment |

The checked-in dependency is `zetajs` `1.2.0`. The repository does not bundle ZetaOffice binaries. On a machine without a configured **Node** runtime bridge, `pnpm test:editor-poc` records `ZETA_RUNTIME_UNAVAILABLE` and `BLOCKED`; it never substitutes the mock or claims a round trip. The real browser evidence in `results.json` was produced by the official CDN runtime and is a separate, explicitly labelled path. `pnpm generate:office-fixtures` writes the same deterministic bytes to both the Node fixture directory and the browser fixture directory.

## Reproduce

```powershell
pnpm install --frozen-lockfile
pnpm generate:office-fixtures
pnpm test:editor-poc
```

The runner copies each fixture to a temporary directory before saving. It validates the output as an OOXML ZIP, closes it, reopens it in read-only mode, compares the preview marker, and verifies the source SHA-256 is unchanged. By default Node reports are written to `docs/editor-poc/results.node.json` and `docs/editor-poc/results.node.md`, so a missing Node bridge cannot overwrite the checked-in browser evidence in `results.json`/`results.md`. Use `--report-prefix=results` only when intentionally replacing the primary report.

The runner exits `0` only for `PASS`; `DEGRADED` or `BLOCKED` sets child exit code `2` after writing both reports (pnpm may normalize the lifecycle exit to `1`) so CI cannot treat a blocked editor as a passing gate.

### Browser runtime POC

The checked-in browser harness exercises real `Module.zetajs` rather than the mock. It uses the official CDN, writes each input into the worker virtual file system, and always saves to a separate target:

```powershell
pnpm dev
# open http://127.0.0.1:1420/editor-poc/index.html?run=matrix
# wait for "ZetaOffice runtime ready"
# with no query string, click "Run DOCX round-trip" and "Run 24-sample matrix" manually
```

The matrix runs 24 samples (8 per format) and checks the edited marker after reopening, OOXML ZIP magic and the required package part, output SHA-256, and unchanged source SHA-256. `public/editor-poc/office_thread.js` is the only place that calls Writer/Impress/Calc UNO methods. CDN `zetaoffice_latest` is intentionally not treated as a release lock; a production integration must pin or self-host the runtime.

To run against a real browser/worker bridge, provide a module exporting a `ZetaOfficeRuntime`-compatible object:

```powershell
node --experimental-strip-types scripts/run-editor-poc.ts --runtime=C:\path\to\zeta-runtime-bridge.mjs
```

The bridge is the only place that may call `Module.zetajs`, `loadComponentFromURL`, UNO edit methods, and `storeAsURL`. `createZetaJsRuntime()` in `src/editor/zetaOfficeAdapter.ts` adapts a resolved `Module.zetajs` object to the stable runtime shape. The bridge must preserve the source path and throw on failed open/edit/save/reopen operations.

## Fallback policy

- `PASS`: open, edit, save-as, close, reopen, preview marker, output package and source hash all validate.
- `DEGRADED`: the file round-trips but the adapter reports a warning or the reopened preview requires manual review.
- `FAIL`: an operation or integrity check fails. The source fixture is never overwritten. The result includes a stable error code and either an available read-only fallback or an explicit unavailable fallback.
