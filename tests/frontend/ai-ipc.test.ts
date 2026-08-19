import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { applyAiChange, chatWithAi, previewAiContext } from "../../src/ipc/ai";

describe("AI IPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("previews only explicit document ids and exposes permission/size before sending", async () => {
    invokeMock.mockResolvedValue({ status: "success", data: { sources: [], segmentCount: 0, characterCount: 0, estimatedTokens: 0, truncated: false, permission: "suggest", untrusted: true } });
    await previewAiContext({ prompt: "@文档(doc-1)", permission: "suggest", documentIds: ["doc-1"], maxChars: 1000 });
    expect(invokeMock).toHaveBeenCalledWith("ai_context_preview", { request: { prompt: "@文档(doc-1)", permission: "suggest", documentIds: ["doc-1"], maxChars: 1000 } });
  });

  it("keeps stream events and write authorization in Rust IPC requests", async () => {
    invokeMock.mockResolvedValue({ status: "success", data: { events: [] } });
    await chatWithAi({ sessionId: "s1", prompt: "总结", permission: "assist", confirmed: true, documentIds: ["doc-1"], authorizedDocumentIds: ["doc-1"] });
    await applyAiChange({ sessionId: "s1", permission: "assist", documentId: "doc-1", expectedSha256: "hash", content: "修改", approved: true, authorizedDocumentIds: ["doc-1"] });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_chat", { request: { sessionId: "s1", prompt: "总结", permission: "assist", confirmed: true, documentIds: ["doc-1"], authorizedDocumentIds: ["doc-1"] } });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_apply_change", { request: { sessionId: "s1", permission: "assist", documentId: "doc-1", expectedSha256: "hash", content: "修改", approved: true, authorizedDocumentIds: ["doc-1"] } });
  });
});
