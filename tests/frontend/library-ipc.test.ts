import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { searchLibrary, setCollectionMembership } from "../../src/ipc/library";

describe("library IPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sends search filters through the stable request shape", async () => {
    invokeMock.mockResolvedValue({ status: "success", data: { items: [], total: 0, queryTimeMs: 2 } });

    await expect(searchLibrary({ text: "全文检索", formats: ["markdown"], favoriteOnly: true })).resolves.toEqual({
      status: "success",
      data: { items: [], total: 0, queryTimeMs: 2 },
    });
    expect(invokeMock).toHaveBeenCalledWith("library_search", {
      request: { text: "全文检索", formats: ["markdown"], favoriteOnly: true },
    });
  });

  it("uses DocumentId and relation id for virtual collection membership", async () => {
    invokeMock.mockResolvedValue({ status: "success", data: null });

    await setCollectionMembership("doc-stable-id", "col-stable-id", true);

    expect(invokeMock).toHaveBeenCalledWith("library_set_collection_membership", {
      request: { documentId: "doc-stable-id", relationId: "col-stable-id", included: true },
    });
  });

});
