import type { EditorError, EditorErrorCode, ReadOnlyFallback } from "./types.ts";

export function editorError(
  code: EditorErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    details?: Record<string, unknown> | null;
    fallback?: ReadOnlyFallback | null;
  } = {},
): EditorError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    details: options.details ?? null,
    fallback: options.fallback ?? null,
  };
}

export function errorCodeFromCause(cause: unknown, fallbackCode: EditorErrorCode): EditorErrorCode {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code as EditorErrorCode;
    }
  }
  return fallbackCode;
}

export function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}
