import { buildSpreadsheetAiContext, type SpreadsheetAiContext } from "./aiProtocol";
import type { SpreadsheetWorkbook } from "./model";

export function serializeSpreadsheetAiContext(workbook: SpreadsheetWorkbook, options: Parameters<typeof buildSpreadsheetAiContext>[1] = {}): { context: SpreadsheetAiContext; text: string } {
  const context = buildSpreadsheetAiContext(workbook, options);
  const text = JSON.stringify(context);
  if (text.length > 500_000) throw new Error("表格上下文过大，请先缩小选区或分步处理");
  return { context, text };
}
