import { strFromU8, unzipSync } from "fflate";
import { cellAddress, cellPosition, type SpreadsheetCell, type SpreadsheetWorkbook } from "./model";
import { readCellStyles } from "./style";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const nodes = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS("*", name));

/** Read only: unsupported package parts and formula metadata remain in entries. */
export function readSpreadsheet(bytes: Uint8Array): SpreadsheetWorkbook {
  if (bytes.length > 50 * 1024 * 1024) throw new Error("工作簿超过 50 MB，暂不支持编辑");
  let expanded = 0;
  const entries = unzipSync(bytes, { filter(entry) {
    expanded += entry.originalSize;
    if (expanded > 200 * 1024 * 1024) throw new Error("工作簿解压后超过安全大小限制");
    return true;
  } });
  const xml = (path: string) => {
    const value = entries[path];
    if (!value) throw new Error(`工作簿缺少文件：${path}`);
    const doc = new DOMParser().parseFromString(strFromU8(value), "application/xml");
    if (nodes(doc, "parsererror").length) throw new Error(`工作簿 XML 损坏：${path}`);
    return doc;
  };
  const book = xml("xl/workbook.xml");
  const rels = nodes(xml("xl/_rels/workbook.xml.rels"), "Relationship");
  const strings = entries["xl/sharedStrings.xml"] ? nodes(xml("xl/sharedStrings.xml"), "si").map((si) => nodes(si, "t").map((t) => t.textContent ?? "").join("")) : [];
  const styleDoc = entries["xl/styles.xml"] ? xml("xl/styles.xml") : null;
  const cellStyles = readCellStyles(styleDoc);
  const formats = new Map(styleDoc ? nodes(styleDoc, "numFmt").map((n) => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode") ?? ""]) : []);
  const styles = styleDoc ? Array.from(nodes(styleDoc, "cellXfs")[0]?.children ?? []) : [];
  const sheets = nodes(book, "sheet").map((sheet) => {
    const relation = rels.find((r) => r.getAttribute("Id") === sheet.getAttributeNS(REL, "id"));
    if (!relation || relation.getAttribute("TargetMode") === "External") throw new Error("不支持外部工作表关系");
    const target = relation.getAttribute("Target") ?? "";
    const parts: string[] = target.startsWith("/") ? [] : ["xl"];
    for (const part of target.split("/")) {
      if (part === "..") { if (!parts.length) throw new Error("无效工作表路径"); parts.pop(); }
      else if (part && part !== ".") parts.push(part);
    }
    const path = parts.join("/");
    if (!path.startsWith("xl/")) throw new Error("无效工作表路径");
    const doc = xml(path);
    const cells: Record<string, SpreadsheetCell> = Object.create(null);
    const allCells = nodes(doc, "c");
    if (allCells.length > 200_000) throw new Error("单表超过 200000 个非空单元格，暂不支持编辑");
    allCells.forEach((cell) => {
      const pos = cellPosition(cell.getAttribute("r") ?? "");
      const address = cellAddress(pos.row, pos.column);
      if (cells[address]) throw new Error(`工作簿存在重复单元格：${address}`);
      const raw = nodes(cell, "v")[0]?.textContent ?? "";
      const type = cell.getAttribute("t");
      const styleIndex = Number(cell.getAttribute("s") ?? 0);
      const formatId = Number(styles[styleIndex]?.getAttribute("numFmtId") ?? 0);
      const format = (formats.get(formatId) ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
      const date = (formatId >= 14 && formatId <= 22) || (formatId >= 45 && formatId <= 47) || /[ydhs]/i.test(format);
      let value: SpreadsheetCell["value"] = raw === "" ? null : Number(raw);
      let kind: SpreadsheetCell["kind"] = value === null ? "empty" : date ? "date" : "number";
      if (type === "s") {
        if (!/^\d+$/.test(raw) || strings[Number(raw)] === undefined) throw new Error("无效共享字符串引用");
        value = strings[Number(raw)]; kind = "text";
      } else if (type === "inlineStr") { value = nodes(cell, "t").map((t) => t.textContent ?? "").join(""); kind = "text"; }
      else if (type === "str" || type === "e" || type === "d") { value = raw; kind = type === "e" ? "error" : type === "d" ? "date" : "text"; }
      else if (type === "b") { value = raw === "1"; kind = "boolean"; }
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`无效数值：${address}`);
      const f = nodes(cell, "f")[0];
      cells[address] = { value, kind, styleIndex, style: cellStyles[styleIndex] ?? {}, ...(f ? { formula: `=${f.textContent ?? ""}`, unsupportedFormula: Boolean(f.getAttribute("t") && f.getAttribute("t") !== "normal") } : {}) };
    });
    const columnWidths: Record<number, number> = {};
    for (const col of nodes(doc, "col")) {
      const min = Number(col.getAttribute("min")), max = Number(col.getAttribute("max")), width = Number(col.getAttribute("width"));
      if (min >= 1 && max <= 16384 && Number.isFinite(width) && width > 0) for (let i=min;i<=max;i++) columnWidths[i] = width * 7 + 5;
    }
    const rowHeights: Record<number, number> = {};
    for (const row of nodes(doc,"row")) if (row.hasAttribute("ht")) rowHeights[Number(row.getAttribute("r"))] = Number(row.getAttribute("ht")) * 4 / 3;
    return { name: sheet.getAttribute("name") ?? "", path, cells, columnWidths, rowHeights, merges: nodes(doc, "mergeCell").map((n) => n.getAttribute("ref") ?? ""), protected: nodes(doc, "sheetProtection").length > 0 };
  });
  if (!sheets.length || new Set(sheets.map((s) => s.name.toLowerCase())).size !== sheets.length) throw new Error("工作表名称缺失或重复");
  return { sheets, entries, date1904: ["1", "true"].includes(nodes(book, "workbookPr")[0]?.getAttribute("date1904") ?? "") };
}
