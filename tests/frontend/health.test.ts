import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { healthCheck } from "../../src/ipc/health";

describe("healthCheck", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns the structured backend response", async () => {
    invokeMock.mockResolvedValue({
      status: "success",
      data: { backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 },
    });

    await expect(healthCheck()).resolves.toEqual({
      status: "success",
      data: { backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 },
    });
    expect(invokeMock).toHaveBeenCalledWith("health_check");
  });

  it("normalizes a Tauri transport failure", async () => {
    invokeMock.mockRejectedValue(new Error("channel closed"));

    await expect(healthCheck()).resolves.toEqual({
      status: "error",
      error: {
        code: "IPC_TRANSPORT_ERROR",
        message: "channel closed",
        retryable: true,
        details: null,
      },
    });
  });
});
