import { calculateFormula, translateFormula } from "./calc";
import { applySpreadsheetStyle } from "./style";
import { rangeAddresses, type CellValue, type SpreadsheetStyle, type SpreadsheetWorkbook } from "./model";
export { moveSpreadsheetRange } from "./style";

export type SpreadsheetOperation =
  | { type: "set_formula"; range: string; formula: string }
  | { type: "set_value"; range: string; value: Exclude<CellValue, null> }
  | { type: "set_format"; range: string; style: SpreadsheetStyle }
  | { type: "clear"; range: string };
export interface SpreadsheetPlan { sheet: string; operations: SpreadsheetOperation[] }
export interface SpreadsheetChange { sheet: string; address: string; before: CellValue; after: CellValue; formula?: string; formatChanged?: boolean }

/** Produces an isolated preview. Does not grant authority or save a source file. */
export function previewSpreadsheetPlan(workbook: SpreadsheetWorkbook, plan: SpreadsheetPlan, allowClear = false): { workbook: SpreadsheetWorkbook; changes: SpreadsheetChange[] } {
  if (!plan.operations.length || plan.operations.length > 100) throw new Error("操作数量必须为 1–100");
  const original = workbook.sheets.find((s) => s.name === plan.sheet);
  if (!original) throw new Error(`工作表不存在：${plan.sheet}`);
  if (original.protected) throw new Error("受保护的工作表不能修改");
  const candidate: SpreadsheetWorkbook = { ...workbook, sheets: workbook.sheets.map((s) => ({ ...s, cells: Object.fromEntries(Object.entries(s.cells).map(([a, c]) => [a, { ...c }])) })) };
  const target = candidate.sheets.find((s) => s.name === plan.sheet)!;
  const touched = new Set<string>();
  const merged = new Set(original.merges.flatMap(rangeAddresses));
  for (const operation of plan.operations) {
    const addresses = rangeAddresses(operation.range);
    if (operation.type === "clear" && !allowClear) throw new Error("清空区域需要明确授权");
    for (const address of addresses) {
      if (touched.has(address)) throw new Error("多项操作区域重叠，请合并操作");
      if (touched.size >= 10000) throw new Error("单次最多修改 10000 个单元格");
      if (merged.has(address)) throw new Error("第一版暂不允许修改合并单元格区域");
      if (target.cells[address]?.unsupportedFormula) throw new Error("不能覆盖共享或数组公式");
      const styleIndex = target.cells[address]?.styleIndex;
      const style = target.cells[address]?.style;
      if (operation.type === "set_formula") {
        if (!operation.formula.startsWith("=")) throw new Error("公式必须以等号开始");
        target.cells[address] = { value: null, kind: "number", styleIndex, style, formula: translateFormula(operation.formula, addresses[0], address) };
      } else if (operation.type === "set_value") {
        const value = operation.value;
        if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || (typeof value === "number" && !Number.isFinite(value))) throw new Error("单元格值类型无效");
        if (typeof value === "string" && value.length > 32767) throw new Error("单元格文字过长");
        target.cells[address] = { value, kind: typeof value === "string" ? "text" : typeof value === "number" ? "number" : "boolean", styleIndex, style };
      } else if (operation.type === "set_format") {
        const patch = operation.style;
        if (!patch || typeof patch !== "object") throw new Error("格式参数无效");
        const formatted = applySpreadsheetStyle(candidate, plan.sheet, operation.range, patch);
        const formattedSheet = formatted.sheets.find((item) => item.name === plan.sheet)!;
        for (const address of addresses) target.cells[address] = formattedSheet.cells[address];
      } else if (operation.type === "clear") target.cells[address] = { value: null, kind: "empty", styleIndex, style };
      else throw new Error("不支持的操作类型");
      touched.add(address);
    }
  }
  // Recalculate supported formulas, not just destination cells. Any failure
  // aborts the preview instead of persisting an apparently successful result.
  for (const s of candidate.sheets) for (const cell of Object.values(s.cells)) {
    if (cell.formula) {
      if (cell.unsupportedFormula) throw new Error("工作簿含共享或数组公式，暂不能安全重算");
      cell.value = calculateFormula(s, cell.formula, candidate.sheets);
      cell.kind = "number";
    }
  }
  return { workbook: candidate, changes: [...touched].map((address) => ({ sheet: target.name, address, before: original.cells[address]?.value ?? null, after: target.cells[address].value, formula: target.cells[address].formula, formatChanged: JSON.stringify(original.cells[address]?.style ?? {}) !== JSON.stringify(target.cells[address]?.style ?? {}) })) };
}
