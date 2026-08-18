import { invoke } from "@tauri-apps/api/core";

import type { IpcResponse } from "./types";

export interface HealthCheckData {
  backendStatus: "ok";
  appVersion: string;
  protocolVersion: 1;
}

export async function healthCheck(): Promise<IpcResponse<HealthCheckData>> {
  try {
    return await invoke<IpcResponse<HealthCheckData>>("health_check");
  } catch (cause) {
    return {
      status: "error",
      error: {
        code: "IPC_TRANSPORT_ERROR",
        message: cause instanceof Error ? cause.message : "无法连接 Rust 后端",
        retryable: true,
        details: null,
      },
    };
  }
}
