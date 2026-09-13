import fs from "node:fs/promises";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = "C:/Users/Gary/Desktop/墨集/test-output";
await fs.mkdir(outputDir, { recursive: true });
const workbook = Workbook.create();

const guide = workbook.worksheets.add("操作说明");
guide.getRange("A1:B10").values = [
  ["墨集 Excel AI 测试工作簿", null],
  ["用途", "验证单元格定位、公式计算、条件统计和跨表引用"],
  ["测试 1", "将 销售明细!B2:B11 求和，结果写入 B12"],
  ["测试 2", "计算 销售明细!B2:B11 平均值，结果写入 B13"],
  ["测试 3", "统计 销售明细!A2:A11 中“已完成”的数量，写入 B14"],
  ["测试 4", "把 销售明细!B2:B11 中大于 100 的金额求和，写入 B15"],
  ["测试 5", "在 销售明细!C2:C11 填充公式 =B2*1.1，并向下填充"],
  ["测试 6", "将 汇总!B2 改为引用 销售明细!B12"],
  ["测试 7", "把 销售明细!B2 改成 999，观察相关公式是否更新"],
  ["注意", "B12:B15 是预留结果区域；建议先复制文件测试。"],
];
guide.getRange("A1:B1").merge();
guide.getRange("A1:B1").format = { fill: "#315b52", font: { bold: true, color: "#FFFFFF", size: 15 } };
guide.getRange("A:A").format.columnWidth = 16;
guide.getRange("B:B").format.columnWidth = 72;
guide.showGridLines = false;

const sales = workbook.worksheets.add("销售明细");
sales.getRange("A1:E12").values = [
  ["状态", "金额", "含税金额（预留）", "负责人", "备注"],
  ["已完成", 120, null, "小王", "华东客户"],
  ["待处理", 80, null, "小李", "需要补充资料"],
  ["已完成", 260, null, "小张", "年度合同"],
  ["已完成", 95, null, "小王", "续费"],
  ["待处理", 180, null, "小李", "等待确认"],
  ["已完成", 320, null, "小张", "重点客户"],
  ["已完成", 60, null, "小王", "小额订单"],
  ["待处理", 140, null, "小李", "本周跟进"],
  ["已完成", 210, null, "小张", "已回款"],
  ["已完成", 155, null, "小王", "新客户"],
  ["合计", null, null, null, "AI 结果写入 B12:B15"],
];
sales.getRange("A1:E1").format = { fill: "#315b52", font: { bold: true, color: "#FFFFFF" } };
sales.getRange("A12:E12").format = { fill: "#f4eee5", font: { bold: true, color: "#65472e" } };
sales.getRange("B2:C15").format.numberFormat = "#,##0.00";
sales.getRange("A:A").format.columnWidth = 16;
sales.getRange("B:C").format.columnWidth = 18;
sales.getRange("D:D").format.columnWidth = 14;
sales.getRange("E:E").format.columnWidth = 24;
sales.freezePanes.freezeRows(1);
sales.showGridLines = false;

const summary = workbook.worksheets.add("汇总");
summary.getRange("A1:B5").values = [["指标", "结果"], ["销售明细总金额", null], ["已完成订单数", null], ["金额平均值", null], ["大于100的金额合计", null]];
summary.getRange("B2:B5").formulas = [[`=SUM('销售明细'!B2:B11)`], [`=COUNTIF('销售明细'!A2:A11,"已完成")`], [`=AVERAGE('销售明细'!B2:B11)`], [`=SUMIF('销售明细'!B2:B11,">100",'销售明细'!B2:B11)`]];
summary.getRange("A1:B1").format = { fill: "#315b52", font: { bold: true, color: "#FFFFFF" } };
summary.getRange("A:A").format.columnWidth = 26;
summary.getRange("B:B").format.columnWidth = 18;
summary.showGridLines = false;

const cross = workbook.worksheets.add("跨表测试");
cross.getRange("A1:C5").values = [["跨表引用测试", null, null], ["来源", "值", "说明"], ["销售明细!B2", null, "应显示 120"], ["销售明细!B3", null, "应显示 80"], ["合计（可改）", null, "可让 AI 写入公式"]];
cross.getRange("B3:B4").formulas = [["='销售明细'!B2"], ["='销售明细'!B3"]];
cross.getRange("A1:C1").merge();
cross.getRange("A1:C1").format = { fill: "#315b52", font: { bold: true, color: "#FFFFFF", size: 14 } };
cross.getRange("A2:C2").format = { fill: "#edf3ef", font: { bold: true } };
cross.getRange("A:A").format.columnWidth = 24;
cross.getRange("B:B").format.columnWidth = 16;
cross.getRange("C:C").format.columnWidth = 28;
cross.showGridLines = false;

workbook.recalculate();
const check = await workbook.inspect({ kind: "table", range: "汇总!A1:B5", include: "values,formulas", tableMaxRows: 8, tableMaxCols: 4 });
console.log(check.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 100 }, summary: "formula errors" });
console.log(errors.ndjson);
const preview = await workbook.render({ sheetName: "汇总", range: "A1:B5", scale: 1, format: "png" });
await fs.writeFile(`${outputDir}/excel-ai-test-summary.png`, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(`${outputDir}/墨集-Excel-AI测试文件.xlsx`);
