import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ZetaOfficeAdapter, type EditorAdapter, type EditorError, type EditorResult } from "../src/editor/index.ts";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(scriptRoot, "tests/fixtures/office/manifest.json");
const outputRoot = resolve(scriptRoot, "docs/editor-poc");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  schemaVersion: number;
  samples: Array<{ id: string; format: "docx" | "pptx" | "xlsx"; features: string[]; edit: Record<string, string> }>;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

const reportPrefix = (argValue("report-prefix") ?? "results.node").replace(/[^a-zA-Z0-9._-]/g, "_");

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function errorResult(error: EditorError, phase: string) {
  return { phase, code: error.code, message: error.message, fallback: error.fallback };
}

function validateOutput(path: string, format: string): { valid: boolean; reason?: string } {
  try {
    const bytes = requireBuffer(path);
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { valid: false, reason: "输出不是 ZIP/OOXML 文件" };
    const listing = execFileSync("tar", ["-tf", path], { encoding: "utf8", windowsHide: true });
    const required = format === "docx" ? "word/document.xml" : format === "pptx" ? "ppt/presentation.xml" : "xl/workbook.xml";
    if (!listing.split(/\r?\n/).includes(required)) return { valid: false, reason: `输出缺少 ${required}` };
    return { valid: true };
  } catch (cause) {
    return { valid: false, reason: cause instanceof Error ? cause.message : "无法验证输出文件" };
  }
}

function requireBuffer(path: string): Uint8Array {
  return readFileSync(path);
}

async function loadAdapter(): Promise<EditorAdapter> {
  const runtimeModule = argValue("runtime");
  if (!runtimeModule) return new ZetaOfficeAdapter();
  const loaded = await import(pathToFileURL(resolve(runtimeModule)).href);
  const runtime = loaded.default ?? loaded.createRuntime?.();
  if (!runtime) throw new Error("runtime module must export default or createRuntime()");
  return new ZetaOfficeAdapter(runtime);
}

function asFailure(result: EditorResult<unknown>, phase: string) {
  return result.status === "error" ? errorResult(result.error, phase) : null;
}

const adapter = await loadAdapter();
const health = await adapter.healthCheck();
const runDirectory = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "moji-editor-poc-"));
const results: Array<Record<string, unknown>> = [];

try {
  for (const sample of manifest.samples) {
    const sourcePath = resolve(scriptRoot, "tests/fixtures/office/generated", `${sample.id}.${sample.format}`);
    const targetPath = join(runDirectory, `${sample.id}-edited.${sample.format}`);
    const base = { id: sample.id, format: sample.format, features: sample.features, sourcePath: `tests/fixtures/office/generated/${sample.id}.${sample.format}` };
    let sourceHashBefore: string | null = null;
    try {
      sourceHashBefore = await hashFile(sourcePath);
      await stat(sourcePath);
    } catch {
      results.push({ ...base, status: "FAIL", error: { phase: "preflight", code: "SAMPLE_MISSING", message: "夹具不存在", fallback: { mode: "read-only-preview", available: false, reason: "缺少代表性样本" } } });
      continue;
    }

    const opened = await adapter.open(sourcePath);
    if (opened.status === "error") {
      results.push({ ...base, status: "FAIL", error: errorResult(opened.error, "open"), sourceSha256: sourceHashBefore, writeAttempted: false });
      continue;
    }

    let status: "PASS" | "DEGRADED" | "FAIL" = "PASS";
    let error: Record<string, unknown> | null = null;
    const before = await adapter.readOnlyPreview(opened.data);
    if (before.status === "error") {
      status = "FAIL";
      error = errorResult(before.error, "preview-before");
    }
    if (status !== "FAIL") {
      const edited = await adapter.edit(opened.data, sample.edit as never);
      if (edited.status === "error") {
        status = "FAIL";
        error = errorResult(edited.error, "edit");
      } else if (edited.outcome === "DEGRADED") {
        status = "DEGRADED";
      }
    }
    if (status !== "FAIL") {
      const saved = await adapter.saveAs(opened.data, targetPath);
      if (saved.status === "error") {
        status = "FAIL";
        error = errorResult(saved.error, "save-as");
      } else if (saved.outcome === "DEGRADED") {
        status = "DEGRADED";
      }
    }
    const outputValidation = status === "FAIL" ? { valid: false, reason: "未产生输出" } : validateOutput(targetPath, sample.format);
    if (!outputValidation.valid && status !== "FAIL") {
      status = "FAIL";
      error = { phase: "output-validation", code: "OUTPUT_INVALID", message: outputValidation.reason ?? "输出校验失败", fallback: { mode: "read-only-preview", available: true, reason: "输出损坏，源文件未覆盖" } };
    }
    const closed = await adapter.close(opened.data);
    if (closed.status === "error" && status !== "FAIL") {
      status = "FAIL";
      error = errorResult(closed.error, "close");
    }

    let reopened = false;
    let sourceHashAfter: string | null = null;
    let outputSha256: string | null = null;
    if (status !== "FAIL") {
      const reopenedResult = await adapter.open(targetPath, { readOnly: true });
      if (reopenedResult.status === "error") {
        status = "FAIL";
        error = errorResult(reopenedResult.error, "reopen");
      } else {
        const after = await adapter.readOnlyPreview(reopenedResult.data);
        reopened = after.status === "success";
        if (after.status === "error") {
          status = "FAIL";
          error = errorResult(after.error, "preview-after");
        } else if (!after.data.summary.includes(sample.id)) {
          status = "DEGRADED";
          error = { phase: "reopen-validation", code: "EDITOR_REOPEN_FAILED", message: "重开摘要未包含样本标识，需人工核对内容", fallback: { mode: "read-only-preview", available: true, reason: "保留输出供人工只读核对" } };
        }
        await adapter.close(reopenedResult.data);
      }
      try {
        outputSha256 = await hashFile(targetPath);
      } catch {
        status = "FAIL";
        error = { phase: "output-validation", code: "OUTPUT_INVALID", message: "另存文件不存在", fallback: { mode: "read-only-preview", available: true, reason: "源文件未覆盖" } };
      }
    }
    sourceHashAfter = await hashFile(sourcePath);
    if (sourceHashBefore !== sourceHashAfter) {
      status = "FAIL";
      error = { phase: "source-integrity", code: "SOURCE_WRITE_FORBIDDEN", message: "检测到源文件哈希变化，阻止 POC 通过", fallback: { mode: "read-only-preview", available: true, reason: "源文件完整性失败" } };
    }
    results.push({ ...base, status, sourceSha256: sourceHashBefore, sourceSha256After: sourceHashAfter, outputSha256, reopened, writeAttempted: true, error });
  }
} finally {
  if (!process.env.KEEP_EDITOR_POC_TEMP) await rm(runDirectory, { recursive: true, force: true });
}

const summary = {
  total: results.length,
  pass: results.filter((result) => result.status === "PASS").length,
  degraded: results.filter((result) => result.status === "DEGRADED").length,
  fail: results.filter((result) => result.status === "FAIL").length,
};
const conclusion = summary.fail === 0 ? (summary.degraded === 0 ? "PASS" : "DEGRADED") : summary.fail === summary.total ? "BLOCKED" : "DEGRADED";
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), conclusion, runtimeHealth: health, runDirectory: "<temporary>", summary, samples: results };
const resultsPath = resolve(outputRoot, `${reportPrefix}.json`);
const markdownPath = resolve(outputRoot, `${reportPrefix}.md`);
await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  "# ZetaOffice Editor POC Results",
  "",
  `- Conclusion: **${conclusion}**`,
  `- Runtime: ${health.status === "success" ? `${health.data.runtimeVersion ?? "unknown"} available` : "unavailable"}`,
  `- Samples: ${summary.total} total, ${summary.pass} PASS, ${summary.degraded} DEGRADED, ${summary.fail} FAIL`,
  "",
  "| Sample | Format | Features | Status | Reason / fallback |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((result) => {
    const error = result.error as { code?: string; message?: string; fallback?: { mode: string; reason: string } } | null;
    return `| ${result.id} | ${result.format} | ${(result.features as string[]).join("、")} | ${result.status} | ${error ? `${error.code}: ${error.message}; ${error.fallback?.mode ?? "no fallback"}` : "round-trip verified"} |`;
  }),
  "",
  "A FAIL never writes the source fixture. The generated JSON retains source hashes and operation phase for audit.",
].join("\n");
await writeFile(markdownPath, `${markdown}\n`, "utf8");
console.log(JSON.stringify({ conclusion, summary, resultsPath, markdownPath }, null, 2));
if (conclusion !== "PASS") process.exitCode = 2;
