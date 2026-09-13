import { cellPosition, type SpreadsheetWorkbook } from "./model";
import { previewSpreadsheetPlan, type SpreadsheetPlan } from "./operations";
import { readSpreadsheet } from "./read";
import { spreadsheetBase64, writeSpreadsheet } from "./write";

export type SpreadsheetAiIntent = { plan: SpreadsheetPlan; summary: string };

/** Parse the small, explicit command language used by the spreadsheet assistant. */
export function parseSpreadsheetAiPrompt(prompt: string, sheetName: string): SpreadsheetAiIntent {
  const text = prompt.trim();
  const addresses = [...text.matchAll(/[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?/gi)].map((match) => match[0]);
  const source = addresses[0];
  if (!source) throw new Error("请明确数据区域，例如 B2:B20");
  const sourceParts = source.toUpperCase().split(":");
  const destination = /(?:写入|填入|放到|到|结果(?:写入|在))\s*([A-Z]{1,3}[1-9]\d*)/i.exec(text)?.[1]
    ?? addresses.slice(1).find((value) => !sourceParts.includes(value.toUpperCase()));
  const normalized = text.toLowerCase();
  const isSum = normalized.includes("求和") || normalized.includes("合计") || normalized.includes("总和") || normalized.includes("总销售额") || normalized.includes("sum");
  let inferredDestination = destination;
  if (!inferredDestination && isSum) {
    const parts = source.replace(/\$/g, "").toUpperCase().split(":");
    if (parts.length === 2) {
      const first = cellPosition(parts[0]);
      const last = cellPosition(parts[1]);
      if (first.column === last.column && last.row < 1048576) inferredDestination = `${parts[1].replace(/\d+$/, "")}${last.row + 1}`;
    }
  }
  if (!inferredDestination) throw new Error("请明确结果单元格，例如写入 B21（也可以说“写入区域下一行”）");
  cellPosition(inferredDestination.replace(/\$/g, "").toUpperCase());
  const fn = normalized.includes("平均") || normalized.includes("average") ? "AVERAGE"
    : normalized.includes("计数") || normalized.includes("数量") || normalized.includes("count") ? "COUNT"
    : normalized.includes("最大") || normalized.includes("max") ? "MAX"
    : normalized.includes("最小") || normalized.includes("min") ? "MIN"
    : normalized.includes("非空") || normalized.includes("counta") ? "COUNTA"
    : normalized.includes("求和") || normalized.includes("合计") || normalized.includes("总和") || normalized.includes("总销售额") || normalized.includes("sum") ? "SUM" : null;
  if (!fn) throw new Error("暂支持求和、平均、计数、非空计数、最大值和最小值");
  const cleanSource = source.replace(/\$/g, "").toUpperCase();
  const cleanDestination = inferredDestination.replace(/\$/g, "").toUpperCase();
  return { plan: { sheet: sheetName, operations: [{ type: "set_formula", range: cleanDestination, formula: `=${fn}(${cleanSource})` }] }, summary: `${fn}(${cleanSource}) → ${cleanDestination}` };
}

export function executeSpreadsheetAiPrompt(workbook: SpreadsheetWorkbook, prompt: string, sheetName: string) {
  const intent = parseSpreadsheetAiPrompt(prompt, sheetName);
  const result = previewSpreadsheetPlan(workbook, intent.plan, false);
  return { ...intent, ...result };
}

export function executeSpreadsheetAiBase64(binaryContent: string, prompt: string, sheetName: string) {
  const bytes = Uint8Array.from(atob(binaryContent), (character) => character.charCodeAt(0));
  const initial = readSpreadsheet(bytes);
  const result = executeSpreadsheetAiPrompt(initial, prompt, sheetName);
  return { ...result, binaryContent: spreadsheetBase64(writeSpreadsheet(initial, result.workbook)) };
}
