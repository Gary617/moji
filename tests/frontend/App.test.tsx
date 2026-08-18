import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { healthCheckMock } = vi.hoisted(() => ({ healthCheckMock: vi.fn() }));
const { searchLibraryMock, listSourcesMock, listCollectionsMock, listTagsMock } = vi.hoisted(() => ({
  searchLibraryMock: vi.fn(),
  listSourcesMock: vi.fn(),
  listCollectionsMock: vi.fn(),
  listTagsMock: vi.fn(),
}));

vi.mock("../../src/ipc/health", () => ({ healthCheck: healthCheckMock }));
vi.mock("../../src/ipc/library", () => ({
  searchLibrary: searchLibraryMock,
  listSources: listSourcesMock,
  listCollections: listCollectionsMock,
  listTags: listTagsMock,
  createCollection: vi.fn(),
  createTag: vi.fn(),
  recordRecentUse: vi.fn(),
  rebuildSearchIndex: vi.fn(),
  setFavorite: vi.fn(),
}));

import App from "../../src/App";

describe("App", () => {
  beforeEach(() => {
    healthCheckMock.mockReset();
    searchLibraryMock.mockResolvedValue({ status: "success", data: { items: [], total: 0, queryTimeMs: 1 } });
    listSourcesMock.mockResolvedValue({ status: "success", data: [] });
    listCollectionsMock.mockResolvedValue({ status: "success", data: [] });
    listTagsMock.mockResolvedValue({ status: "success", data: [] });
  });

  it("renders the connected local core state", async () => {
    healthCheckMock.mockResolvedValue({
      status: "success",
      data: { backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 },
    });

    render(<App />);

    expect(await screen.findByText("本地核心 v1")).toBeInTheDocument();
  });

  it("retries the health check from the button", async () => {
    const user = userEvent.setup();
    healthCheckMock
      .mockResolvedValueOnce({
        status: "error",
        error: {
          code: "BACKEND_UNAVAILABLE",
          message: "not ready",
          retryable: true,
          details: null,
        },
      })
      .mockResolvedValueOnce({
        status: "success",
        data: { backendStatus: "ok", appVersion: "0.1.1", protocolVersion: 1 },
      });

    render(<App />);
    expect(await screen.findByText("本地核心不可用")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新连接本地核心" }));

    expect(await screen.findByText("本地核心 v1")).toBeInTheDocument();
    expect(healthCheckMock).toHaveBeenCalledTimes(2);
  });

  it("renders the empty library state after the query completes", async () => {
    healthCheckMock.mockResolvedValue({
      status: "success",
      data: { backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 },
    });

    render(<App />);

    expect(await screen.findByText("还没有已授权并扫描的资料")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索资料" })).toBeInTheDocument();
  });
});
