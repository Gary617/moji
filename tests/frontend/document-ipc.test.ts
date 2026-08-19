import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { addAnnotation, openDocument, restoreSnapshot, saveDocument } from "../../src/ipc/document";

describe("document IPC", () => {
  beforeEach(() => invokeMock.mockReset());
  it("uses Document ID requests without exposing a source path", async () => {
    invokeMock.mockResolvedValueOnce({ status: "success", data: { sessionId: "session-1" } });

    await openDocument("doc-1", "edit");

    expect(invokeMock).toHaveBeenCalledWith("document_open", { request: { documentId: "doc-1", mode: "edit" } });
  });

  it("sends the expected hash for save and restore conflict protection", async () => {
    invokeMock.mockResolvedValue({ status: "success", data: {} });

    await saveDocument("doc-1", "hash-before", "next", "assist");
    await restoreSnapshot("doc-1", "snap-1", "hash-after");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "document_save", { request: { documentId: "doc-1", expectedSha256: "hash-before", content: "next", mode: "assist" } });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "document_restore_snapshot", { request: { documentId: "doc-1", snapshotId: "snap-1", expectedSha256: "hash-after" } });
  });

  it("preserves explicit annotation anchors", async () => {
    invokeMock.mockResolvedValueOnce({ status: "success", data: {} });
    const anchor = { kind: "character-range" as const, page: null, slide: null, paragraph: 1, charStart: 2, charEnd: 6, quote: "测试", stable: false };

    await addAnnotation("doc-1", "本地用户", "检查这一段", anchor);

    expect(invokeMock).toHaveBeenCalledWith("document_add_annotation", { request: { documentId: "doc-1", author: "本地用户", body: "检查这一段", anchor } });
  });
});
