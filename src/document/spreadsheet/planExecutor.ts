import { previewSpreadsheetPlan, type SpreadsheetChange } from "./operations";
import { validateSpreadsheetAiPlan, type SpreadsheetAiPlan } from "./aiProtocol";
import type { SpreadsheetWorkbook } from "./model";

export interface SpreadsheetPlanExecution {
  workbook: SpreadsheetWorkbook;
  plan: SpreadsheetAiPlan;
  changes: SpreadsheetChange[];
}

/** Validate and execute a model-produced plan only on a cloned workbook. */
export function executeSpreadsheetAiPlan(workbook: SpreadsheetWorkbook, value: unknown, allowClear = false): SpreadsheetPlanExecution {
  const plan = validateSpreadsheetAiPlan(value, workbook);
  const result = previewSpreadsheetPlan(workbook, plan, allowClear);
  return { ...result, plan };
}
