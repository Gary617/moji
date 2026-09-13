import { cellPosition, rangeAddresses, type CellValue, type SpreadsheetStyle, type SpreadsheetWorkbook } from "./model";
import type { SpreadsheetOperation, SpreadsheetPlan } from "./operations";

export const SPREADSHEET_AI_PROTOCOL_VERSION = 1;
export type SpreadsheetAiMode = "query" | "plan";
export type SpreadsheetAiOperation = SpreadsheetOperation & { id?: string; reason?: string };
export interface SpreadsheetAiContext {
  version: typeof SPREADSHEET_AI_PROTOCOL_VERSION;
  workbookVersion: string;
  activeSheet: string;
  activeCell: string;
  selectedRange: string;
  sheets: Array<{ name: string; protected: boolean; dimensions: { rows: number; columns: number }; cells: Record<string, { value: CellValue; formula?: string; kind: string }> }>;
}
export interface SpreadsheetAiPlan extends Omit<SpreadsheetPlan, "operations"> {
  version: typeof SPREADSHEET_AI_PROTOCOL_VERSION;
  workbookVersion?: string;
  explanation?: string;
  operations: SpreadsheetAiOperation[];
}

export type SpreadsheetAiResponse =
  | { kind: "answer"; answer: string; evidence?: string[] }
  | { kind: "plan"; plan: SpreadsheetAiPlan };

export function parseSpreadsheetAiResponse(text: string, workbook: SpreadsheetWorkbook): SpreadsheetAiResponse {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return { kind: "answer", answer: text.trim() || "AI 没有返回可显示的结果。" };
  let value: unknown;
  try { value = JSON.parse(candidate); } catch { return { kind: "answer", answer: text.trim() }; }
  if (!value || typeof value !== "object") return { kind: "answer", answer: text.trim() };
  const raw = value as Record<string, unknown>;
  if (raw.kind === "answer" && typeof raw.answer === "string") return { kind: "answer", answer: raw.answer, evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string").slice(0, 20) : undefined };
  if (raw.kind === "plan" && raw.plan && typeof raw.plan === "object") return { kind: "plan", plan: validateSpreadsheetAiPlan(raw.plan, workbook) };
  if (Array.isArray(raw.operations) || raw.plan || raw.operation) return { kind: "plan", plan: validateSpreadsheetAiPlan(raw, workbook) };
  return { kind: "answer", answer: typeof raw.answer === "string" ? raw.answer : text.trim() };
}

export function validateSpreadsheetAiPlan(value: unknown, workbook: SpreadsheetWorkbook): SpreadsheetAiPlan {
  if (!value || typeof value !== "object") throw new Error("AI 返回的表格计划不是对象");
  const raw = value as Record<string, unknown>;
  const source = raw.plan && typeof raw.plan === "object" ? raw.plan as Record<string, unknown> : raw;
  const sheet = typeof source.sheet === "string" ? source.sheet : workbook.sheets[0]?.name;
  const operations = Array.isArray(source.operations) ? source.operations : raw.operation ? [raw.operation] : [];
  if (!sheet || !workbook.sheets.some((item) => item.name === sheet)) throw new Error("AI 计划引用了不存在的工作表");
  if (!operations.length || operations.length > 100) throw new Error("AI 计划必须包含 1-100 个操作");
  const normalized = operations.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 个 AI 操作无效`);
    const operation = item as Record<string, unknown>;
    if (typeof operation.range !== "string") throw new Error(`第 ${index + 1} 个 AI 操作缺少区域`);
    rangeAddresses(operation.range);
    if (operation.type === "set_formula" && typeof operation.formula === "string") return { type: "set_formula" as const, range: operation.range, formula: operation.formula, id: typeof operation.id === "string" ? operation.id : undefined, reason: typeof operation.reason === "string" ? operation.reason : undefined };
    if (operation.type === "set_value" && ["string", "number", "boolean"].includes(typeof operation.value)) return { type: "set_value" as const, range: operation.range, value: operation.value as Exclude<CellValue, null>, id: typeof operation.id === "string" ? operation.id : undefined, reason: typeof operation.reason === "string" ? operation.reason : undefined };
    if (operation.type === "set_format" && operation.style && typeof operation.style === "object") return { type: "set_format" as const, range: operation.range, style: normalizeSpreadsheetStyle(operation.style), id: typeof operation.id === "string" ? operation.id : undefined, reason: typeof operation.reason === "string" ? operation.reason : undefined };
    if (operation.type === "clear") return { type: "clear" as const, range: operation.range, id: typeof operation.id === "string" ? operation.id : undefined, reason: typeof operation.reason === "string" ? operation.reason : undefined };
    throw new Error(`第 ${index + 1} 个 AI 操作类型不受支持`);
  });
  return { version: SPREADSHEET_AI_PROTOCOL_VERSION, sheet, workbookVersion: typeof raw.workbookVersion === "string" ? raw.workbookVersion : undefined, explanation: typeof raw.explanation === "string" ? raw.explanation : undefined, operations: normalized };
}

function normalizeSpreadsheetStyle(value: unknown): SpreadsheetStyle {
  const raw = value as Record<string, unknown>;
  const style: SpreadsheetStyle = {};
  if (typeof raw.fontFamily === "string") style.fontFamily = raw.fontFamily;
  if (typeof raw.fontSize === "number") style.fontSize = raw.fontSize;
  if (typeof raw.bold === "boolean") style.bold = raw.bold;
  if (typeof raw.italic === "boolean") style.italic = raw.italic;
  if (typeof raw.color === "string") style.color = raw.color;
  if (typeof raw.backgroundColor === "string") style.backgroundColor = raw.backgroundColor;
  if (["general", "left", "center", "right", "justify"].includes(String(raw.horizontal))) style.horizontal = raw.horizontal as SpreadsheetStyle["horizontal"];
  if (["top", "center", "bottom"].includes(String(raw.vertical))) style.vertical = raw.vertical as SpreadsheetStyle["vertical"];
  if (typeof raw.numberFormat === "string") style.numberFormat = raw.numberFormat;
  if (!Object.keys(style).length) throw new Error("格式计划不能为空");
  return style;
}

export function buildSpreadsheetAiContext(workbook: SpreadsheetWorkbook, options: { activeSheet?: string; activeCell?: string; selectedRange?: string; workbookVersion?: string } = {}): SpreadsheetAiContext {
  const activeSheet = options.activeSheet && workbook.sheets.some((sheet) => sheet.name === options.activeSheet) ? options.activeSheet : workbook.sheets[0]?.name ?? "";
  return {
    version: SPREADSHEET_AI_PROTOCOL_VERSION,
    workbookVersion: options.workbookVersion ?? "local-draft",
    activeSheet,
    activeCell: options.activeCell ?? "A1",
    selectedRange: options.selectedRange ?? "A1",
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      protected: sheet.protected,
      dimensions: { rows: 1048576, columns: 16384 },
      cells: Object.fromEntries(Object.entries(sheet.cells).filter(([, cell]) => cell.value !== null || cell.formula).slice(0, 5000).map(([address, cell]) => [address, { value: cell.value, formula: cell.formula, kind: cell.kind }])),
    })),
  };
}
