import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "src-tauri/tauri.editor-poc.conf.json");
const reportPath = resolve(root, "docs/editor-poc/results.tauri.json");
const markdownPath = resolve(root, "docs/editor-poc/results.tauri.md");
const timeoutMs = Number(process.env.EDITOR_POC_TIMEOUT_MS ?? 12 * 60 * 1000);
const debugPort = Number(process.env.EDITOR_POC_DEBUG_PORT ?? 9227);
const isWindows = process.platform === "win32";
let child;

function timestamp() {
  return new Date().toISOString();
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildPrerequisiteError(message) {
  return Object.assign(new Error(message), { code: "TAURI_BUILD_PREREQUISITE_MISSING" });
}

function ensureBuildPrerequisites() {
  if (!isWindows) return;
  const perl = spawnSync("perl", ["-v"], { windowsHide: true, stdio: "ignore" });
  if (perl.error?.code === "ENOENT") {
    throw buildPrerequisiteError("Perl is required by the vendored OpenSSL secure-db build but was not found on PATH");
  }
  if (perl.status !== 0) {
    throw buildPrerequisiteError("Perl could not run; the vendored OpenSSL secure-db build cannot start");
  }
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once("error", () => resolvePort(false));
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${safeMessage(lastError)}` : ""}`);
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CDP endpoint returned ${response.status}`);
  return response.json();
}

async function findPocTarget() {
  const targets = await readJson(`http://127.0.0.1:${debugPort}/json/list`);
  return targets.find((target) => target.type === "page" && target.url.includes("/editor-poc/index.html")) ?? null;
}

function tauriDescendantAlive() {
  if (!child || child.exitCode !== null) return false;
  try {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${child.pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && (result.stdout ?? "").includes(String(child.pid));
  } catch {
    return child.exitCode === null;
  }
}

async function evaluate(target, expression) {
  return new Promise((resolveValue, rejectValue) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      rejectValue(new Error("CDP Runtime.evaluate timed out"));
    }, 15_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        rejectValue(new Error(message.error?.message ?? message.result.exceptionDetails.text));
        return;
      }
      resolveValue(message.result?.result?.value ?? null);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectValue(new Error("CDP WebSocket connection failed"));
    });
  });
}

async function pageState(target) {
  return evaluate(target, `JSON.stringify({
    title: document.title,
    statusText: document.querySelector('#status')?.textContent ?? null,
    result: globalThis.__EDITOR_POC_RESULT__ ?? null
  })`).then((value) => JSON.parse(value));
}

function summaryForBlocked() {
  return { total: 0, pass: 0, degraded: 0, fail: 0 };
}

function markdown(report) {
  const summary = report.summary;
  return [
    "# ZetaOffice Tauri/WebView2 POC Results",
    "",
    `- Conclusion: **${report.conclusion}**`,
    `- Host: ${report.host.kind}`,
    `- Generated: ${report.generatedAt}`,
    `- Samples: ${summary.total} total, ${summary.pass} PASS, ${summary.degraded} DEGRADED, ${summary.fail} FAIL`,
    `- Runtime URL: ${report.runtimeUrl ?? "not reached"}`,
    report.error ? `- Error: ${report.error.code}: ${report.error.message}` : "",
    "",
    "This report is produced by a real Tauri/WebView2 process. A BLOCKED result is not browser evidence and must not be counted as Office write-back support.",
  ].filter(Boolean).join("\n").concat("\n");
}

async function writeReport(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  console.log(JSON.stringify({ conclusion: report.conclusion, summary: report.summary, reportPath, markdownPath }, null, 2));
}

function terminateChild() {
  if (!child || child.exitCode !== null || child.killed) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  ensureBuildPrerequisites();
  if (await portOpen(debugPort)) {
    throw new Error(`CDP port ${debugPort} is already in use; set EDITOR_POC_DEBUG_PORT to a free local port`);
  }
  const cargoBin = resolve(process.env.USERPROFILE ?? ".", ".cargo", "bin");
  const cargoTargetDir = resolve(root, "src-tauri", "target-editor-poc");
  const pathWithCargo = `${cargoBin}${isWindows ? ";" : ":"}${process.env.PATH ?? ""}`;
  const existingArgs = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? "";
  const browserArgs = `${existingArgs} --remote-debugging-port=${debugPort}`.trim();
  const tauriCli = resolve(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const tauriCommand = isWindows ? process.execPath : tauriCli;
  const tauriArgs = isWindows ? [tauriCli, "dev", "--config", configPath, "--no-watch"] : ["dev", "--config", configPath, "--no-watch"];
  child = spawn(tauriCommand, tauriArgs, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: pathWithCargo,
      CARGO_TARGET_DIR: cargoTargetDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
    },
  });
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });

  const target = await waitFor(async () => {
    if (exited) throw new Error(`Tauri exited before WebView2 was ready (code ${exited.code}, signal ${exited.signal})`);
    if (!tauriDescendantAlive() && child.exitCode === null) throw new Error("Tauri process tree exited before WebView2 was ready");
    return findPocTarget();
  }, "Tauri WebView2 editor POC target");

  const state = await waitFor(async () => {
    const next = await pageState(target);
    return next.result?.conclusion ? next : null;
  }, "24-sample matrix completion");
  const pageResult = state.result;
  const report = {
    schemaVersion: 1,
    generatedAt: timestamp(),
    conclusion: pageResult.conclusion,
    host: { kind: "tauri-webview2", debugPort, url: target.url },
    runtimeUrl: pageResult.wasmBase ?? null,
    summary: pageResult.summary,
    samples: pageResult.samples,
    pageTitle: state.title,
  };
  await writeReport(report);
  return report.conclusion === "PASS" ? 0 : 2;
}

let exitCode = 2;
try {
  exitCode = await main();
} catch (error) {
  await writeReport({
    schemaVersion: 1,
    generatedAt: timestamp(),
    conclusion: "BLOCKED",
    host: { kind: "tauri-webview2", debugPort, url: null },
    runtimeUrl: null,
    summary: summaryForBlocked(),
    samples: [],
    error: { code: error?.code ?? "WEBVIEW2_HOST_UNAVAILABLE", message: safeMessage(error) },
  });
} finally {
  terminateChild();
}
process.exitCode = exitCode;
