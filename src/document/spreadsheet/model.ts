export type CellValue = string | number | boolean | null;
export interface SpreadsheetStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  backgroundColor?: string;
  horizontal?: "general" | "left" | "center" | "right" | "justify";
  vertical?: "top" | "center" | "bottom";
  wrapText?: boolean;
  numberFormat?: string;
}
export interface SpreadsheetCell {
  value: CellValue;
  kind: "text" | "number" | "boolean" | "date" | "empty" | "error";
  formula?: string;
  styleIndex?: number;
  style?: SpreadsheetStyle;
  unsupportedFormula?: boolean;
}
export interface SpreadsheetSheet {
  name: string;
  path: string;
  cells: Record<string, SpreadsheetCell>;
  merges: string[];
  protected: boolean;
  columnWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
}
export interface SpreadsheetWorkbook {
  sheets: SpreadsheetSheet[];
  date1904: boolean;
  /** Retained for subsequent surgical OOXML updates, never rebuilt from a value matrix. */
  entries: Record<string, Uint8Array>;
}
export const MAX_RANGE_CELLS = 100_000;
export function cellPosition(address: string): { row: number; column: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(address);
  if (!match) throw new Error(`无效单元格地址：${address}`);
  const column = [...match[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new Error(`单元格超出 Excel 范围：${address}`);
  return { row, column };
}
export function cellAddress(row: number, column: number): string {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 1 || row > 1048576 || column < 1 || column > 16384) throw new Error("单元格超出 Excel 范围");
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return `${letters}${row}`;
}
export function rangeAddresses(range: string): string[] {
  const parts = range.split(":");
  if (parts.length > 2) throw new Error(`无效区域：${range}`);
  const start = cellPosition(parts[0]);
  const end = cellPosition(parts[1] ?? parts[0]);
  if (end.row < start.row || end.column < start.column) throw new Error("区域终点不能在起点之前");
  if ((end.row - start.row + 1) * (end.column - start.column + 1) > MAX_RANGE_CELLS) throw new Error("单次区域超过 100000 个单元格，请缩小范围");
  const result: string[] = [];
  for (let row = start.row; row <= end.row; row++) for (let col = start.column; col <= end.column; col++) result.push(cellAddress(row, col));
  return result;
}
