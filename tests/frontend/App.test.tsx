import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { healthCheckMock } = vi.hoisted(() => ({ healthCheckMock: vi.fn() }));

vi.mock("../../src/ipc/health", () => ({ healthCheck: healthCheckMock }));

import App from "../../src/App";

describe("App", () => {
  beforeEach(() => {
    healthCheckMock.mockReset();
  });

  it("renders backend health and app version", async () => {
    healthCheckMock.mockResolvedValue({
      status: "success",
      data: { backendStatus: "ok", appVersion: "0.1.0", protocolVersion: 1 },
    });

    render(<App />);

    expect(await screen.findByText("运行正常")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
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
    expect(await screen.findByText("连接失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新检查" }));

    expect(await screen.findByText("运行正常")).toBeInTheDocument();
    expect(screen.getByText("0.1.1")).toBeInTheDocument();
    expect(healthCheckMock).toHaveBeenCalledTimes(2);
  });
});
