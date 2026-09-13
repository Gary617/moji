import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync, zipSync, strToU8 } from "fflate";

// Offline UI regression: real production renderer and Tauri Channel, fixture IPC.
// Run after pnpm build; pass the installed playwright package's index.mjs path.
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = resolve("dist");
const events = JSON.parse(await readFile("tests/fixtures/ai-stream-events.json", "utf8"));
const archive = unzipSync(await readFile("tests/fixtures/office/generated/docx-basic.docx"));
function docx(text) {
  archive["word/document.xml"] = strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return Buffer.from(zipSync(archive)).toString("base64");
}
const before = docx("before");
const after = docx("after");
const server = createServer(async (req, res) => {
  const filename = resolve(root, "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
  if (!filename.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(filename)] ?? "application/octet-stream");
    res.end(await readFile(filename));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ before, after, events }) => {
      localStorage.setItem("moji.product-mode.v1", "documents");
      let changed = false;
      let callbackId = 0;
      const callbacks = new Map();
      const document = { id: "doc-ai", sourceRootId: "source-test", displayName: "AI-check.docx", format: "docx", sizeBytes: 1024, modifiedAtMs: Date.now(), status: "present", contentState: "ready" };
      const sourceLocator = { kind: "paragraph", paragraph: 1, page: null, slide: null, boundingBox: null, available: true, reason: null };
      const context = { sources: [], segmentCount: 1, characterCount: 6, estimatedTokens: 2, truncated: false, permission: "autonomous", untrusted: true };
      const success = (data) => ({ status: "success", data });
      window.__TAURI_INTERNALS__ = {
        transformCallback(fn) { callbacks.set(++callbackId, fn); return callbackId; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args) {
          if (command === "health_check") return success({ backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 });
          if (command === "library_search") return success({ items: [{ document, snippets: [], sourceLocator, tags: [], collections: [], isFavorite: false, indexState: "ready" }], total: 1, queryTimeMs: 1 });
          if (command === "document_open") return success({ sessionId: "test", document, sourceLocator, mode: "read-only", readOnly: true, expectedSha256: changed ? "hash-after" : "hash-before", content: null, binaryContent: changed ? after : before, binaryMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", capabilities: { canEdit: true, canSave: false, canSaveAs: true, canAnnotate: true, supportsPageAnchor: false, supportsParagraphAnchor: true }, warnings: [] });
          if (command === "ai_context_preview") return success(context);
          if (command === "ai_chat_stream") {
            const callback = callbacks.get(args.onEvent.id);
            events.forEach((message, index) => callback({ index, message }));
            callback({ index: events.length, end: true });
            changed = true;
            return success({ sessionId: args.request.sessionId, permission: "autonomous", context, events });
          }
          if (command === "workbench_load") return success(null);
          return success([]);
        },
      };
    }, { before, after, events });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "全部文档", exact: true }).click();
    await page.getByText("AI-check.docx", { exact: true }).first().click();
    await page.locator("section.moji-docx p").filter({ hasText: "before" }).waitFor();
    await page.getByRole("combobox", { name: "AI 权限" }).selectOption("autonomous");
    await page.getByRole("textbox", { name: "AI 请求" }).fill("直接修改原文");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const changedParagraph = page.locator(".moji-docx-ai-changed-paragraph");
    await changedParagraph.waitFor();
    assert.equal(await changedParagraph.textContent(), "after");
    const painted = await changedParagraph.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, width: el.getBoundingClientRect().width }));
    assert.notEqual(painted.background, "rgba(0, 0, 0, 0)");
    assert.ok(painted.width > 0);
    await page.getByLabel("AI 修改位置").getByText("after", { exact: true }).waitFor();
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: `test-results/ai-docx-protocol-${viewport.width}.png`, fullPage: true });
    // Reopening keeps the before/after audit text even though live markers reset.
    await page.getByRole("button", { name: "关闭文档", exact: true }).click();
    await page.getByText("AI-check.docx", { exact: true }).first().click();
    await page.getByText(/已写入文档，正在核对正文/).waitFor();
    await page.locator("section.moji-docx p").filter({ hasText: "after" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: DOCX bytes reloaded, paragraph painted, summary visible, chat retained`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
