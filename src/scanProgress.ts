import type {
  CommonLocationScanResult,
  ScanFolderNode,
  ScanJobRecord,
  ScanPreviewResult,
  SourceRootRecord,
} from "./ipc/library";

const scanStates: ScanJobRecord["state"][] = [
  "queued",
  "running",
  "paused",
  "cancelled",
  "failed",
  "completed",
];

function rawValue(raw: Record<string, unknown>, camelCase: string, snakeCase: string): unknown {
  return raw[camelCase] ?? raw[snakeCase];
}

export function finiteScanNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function formatScanCount(value: unknown): string {
  return finiteScanNumber(value).toLocaleString("zh-CN");
}

function nullableScanNumber(raw: Record<string, unknown>, camelCase: string, snakeCase: string): number | null {
  const value = rawValue(raw, camelCase, snakeCase);
  return value === null || value === undefined ? null : finiteScanNumber(value);
}

function nullableScanString(raw: Record<string, unknown>, camelCase: string, snakeCase: string): string | null {
  const value = rawValue(raw, camelCase, snakeCase);
  return typeof value === "string" ? value : null;
}

/**
 * IPC data comes from a running desktop process and may outlive the frontend
 * version that created it. Normalize old or partial scan records before any
 * progress calculation or rendering can touch their numeric fields.
 */
export function normalizeScanJob(value: unknown): ScanJobRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : null;
  const sourceRootId = typeof raw.sourceRootId === "string"
    ? raw.sourceRootId
    : typeof raw.source_root_id === "string"
      ? raw.source_root_id
      : null;
  if (!id || !sourceRootId) return null;

  const candidateState = raw.state;
  const state = scanStates.includes(candidateState as ScanJobRecord["state"])
    ? candidateState as ScanJobRecord["state"]
    : "queued";

  return {
    id,
    sourceRootId,
    state,
    scannedCount: finiteScanNumber(rawValue(raw, "scannedCount", "scanned_count")),
    totalCount: finiteScanNumber(rawValue(raw, "totalCount", "total_count")),
    currentFileName: nullableScanString(raw, "currentFileName", "current_file_name"),
    changedCount: finiteScanNumber(rawValue(raw, "changedCount", "changed_count")),
    failedCount: finiteScanNumber(rawValue(raw, "failedCount", "failed_count")),
    retryCount: finiteScanNumber(rawValue(raw, "retryCount", "retry_count")),
    errorCode: nullableScanString(raw, "errorCode", "error_code"),
    createdAtMs: finiteScanNumber(rawValue(raw, "createdAtMs", "created_at_ms")),
    startedAtMs: nullableScanNumber(raw, "startedAtMs", "started_at_ms"),
    completedAtMs: nullableScanNumber(raw, "completedAtMs", "completed_at_ms"),
    updatedAtMs: finiteScanNumber(rawValue(raw, "updatedAtMs", "updated_at_ms")),
  };
}

export function normalizeScanJobs(values: unknown[]): ScanJobRecord[] {
  return values
    .map(normalizeScanJob)
    .filter((job): job is ScanJobRecord => job !== null);
}

function normalizeFolderNode(value: unknown, fallbackDepth = 0): ScanFolderNode | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const relativePath = typeof raw.relativePath === "string"
    ? raw.relativePath
    : typeof raw.relative_path === "string"
      ? raw.relative_path
      : "";
  const displayName = typeof raw.displayName === "string"
    ? raw.displayName
    : typeof raw.display_name === "string"
      ? raw.display_name
      : relativePath || "根目录";
  const children = Array.isArray(raw.children)
    ? raw.children.map((child) => normalizeFolderNode(child, fallbackDepth + 1)).filter((child): child is ScanFolderNode => child !== null)
    : [];
  return {
    relativePath,
    displayName,
    depth: Math.max(0, Math.round(finiteScanNumber(raw.depth, fallbackDepth))),
    fileCount: finiteScanNumber(raw.fileCount ?? raw.file_count),
    children,
    hasMore: raw.hasMore === true || raw.has_more === true,
  };
}

export function normalizeScanPreview(value: unknown): ScanPreviewResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const roots = Array.isArray(raw.roots)
    ? raw.roots.map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const item = candidate as Record<string, unknown>;
      const sourceId = typeof item.sourceId === "string"
        ? item.sourceId
        : typeof item.source_id === "string"
          ? item.source_id
          : null;
      const label = typeof item.label === "string" ? item.label : "资料位置";
      const root = normalizeFolderNode(item.root);
      return sourceId && root ? { sourceId, label, root } : null;
    }).filter((root): root is ScanPreviewResult["roots"][number] => root !== null)
    : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter((item): item is string => typeof item === "string") : [];
  return {
    roots,
    skipped,
    maxDepth: Math.max(1, Math.round(finiteScanNumber(raw.maxDepth ?? raw.max_depth, 3))),
  };
}

export function normalizeScanBatch(value: unknown): CommonLocationScanResult {
  if (!value || typeof value !== "object") return { sources: [], jobs: [], skipped: [] };
  const raw = value as Record<string, unknown>;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const item = candidate as Record<string, unknown>;
      if (typeof item.id !== "string") return null;
      const kind = item.kind === "single_file" ? "single_file" : "directory";
      return {
        id: item.id,
        kind,
        displayName: typeof item.displayName === "string" ? item.displayName : "资料位置",
        createdAtMs: finiteScanNumber(item.createdAtMs ?? item.created_at_ms),
      } satisfies SourceRootRecord;
    }).filter((source): source is SourceRootRecord => source !== null)
    : [];
  const jobs = Array.isArray(raw.jobs) ? normalizeScanJobs(raw.jobs) : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter((item): item is string => typeof item === "string") : [];
  return { sources, jobs, skipped };
}
