export interface IpcError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
}

export type IpcResponse<T> =
  | { status: "success"; data: T }
  | { status: "error"; error: IpcError };
