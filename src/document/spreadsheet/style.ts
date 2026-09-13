import { strFromU8, strToU8 } from "fflate";
import { cellAddress, cellPosition, rangeAddresses, type SpreadsheetCell, type SpreadsheetStyle, type SpreadsheetWorkbook } from "./model";
import { calculateFormula } from "./calc";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const children = (element: Element | Document, name: string) => Array.from(element.getElementsByTagNameNS("*", name));
const builtinFormats: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 14: "mm-dd-yy", 49: "@" };

export function readCellStyles(doc: Document | null): SpreadsheetStyle[] {
  if (!doc) return [{}];
  const direct = (parent: Element | undefined, name: string) => parent ? Array.from(parent.getElementsByTagNameNS("*", name)).filter(n => n.parentElement === parent) : [];
  const fonts = direct(children(doc, "fonts")[0], "font");
  const fills = direct(children(doc, "fills")[0], "fill");
  const formats = new Map(children(doc, "numFmt").map(n => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode") ?? "General"]));
  const xfNodes = direct(children(doc, "cellXfs")[0], "xf");
  return xfNodes.map(xf => {
    const font = fonts[Number(xf.getAttribute("fontId") ?? 0)];
    const fill = fills[Number(xf.getAttribute("fillId") ?? 0)];
    const alignment = children(xf, "alignment")[0];
    const attr = (name: string, attribute = "val") => font ? children(font, name)[0]?.getAttribute(attribute) ?? undefined : undefined;
    const flag = (name: string) => !!font && children(font, name).some(n => !["0", "false"].includes(n.getAttribute("val") ?? "1"));
    const rgb = (value?: string | null) => value && /^(?:[\da-f]{2})?[\da-f]{6}$/i.test(value) ? `#${value.slice(-6).toUpperCase()}` : undefined;
    const horizontal = alignment?.getAttribute("horizontal");
    const vertical = alignment?.getAttribute("vertical");
    return {
      fontFamily: attr("name"), fontSize: attr("sz") ? Number(attr("sz")) : undefined,
      bold: flag("b"), italic: flag("i"), color: rgb(attr("color", "rgb")),
      backgroundColor: fill && children(fill, "patternFill")[0]?.getAttribute("patternType") === "solid" ? rgb(children(fill, "fgColor")[0]?.getAttribute("rgb")) : undefined,
      horizontal: ["general", "left", "center", "right", "justify"].includes(horizontal ?? "") ? horizontal as SpreadsheetStyle["horizontal"] : undefined,
      vertical: ["top", "center", "bottom"].includes(vertical ?? "") ? vertical as SpreadsheetStyle["vertical"] : undefined,
      numberFormat: formats.get(Number(xf.getAttribute("numFmtId"))) ?? builtinFormats[Number(xf.getAttribute("numFmtId") ?? 0)],
    };
  });
}

export function formatCellDisplay(cell: SpreadsheetCell, date1904 = false): string {
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value !== "number") return String(cell.value);
  const format = cell.style?.numberFormat ?? "General";
  if (["0%", "0.00%"].includes(format)) return `${(cell.value * 100).toFixed(format.includes(".00") ? 2 : 0)}%`;
  if (["yyyy-mm-dd", "mm-dd-yy"].includes(format)) {
    const epoch = Date.UTC(1899, 11, 30) + (cell.value + (date1904 ? 1462 : 0)) * 86400000;
    const date = new Date(epoch);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : String(cell.value);
  }
  if (["#,##0", "#,##0.00"].includes(format)) return cell.value.toLocaleString("zh-CN", { minimumFractionDigits: format.includes(".00") ? 2 : 0, maximumFractionDigits: format.includes(".00") ? 2 : 0 });
  if (format === "0.00") return cell.value.toFixed(2);
  if (format === "0") return cell.value.toFixed(0);
  return String(cell.value);
}

function editableSheet(book: SpreadsheetWorkbook, name: string, addresses: string[]) {
  const sheet = book.sheets.find(s => s.name === name);
  if (!sheet) throw new Error(`工作表不存在：${name}`);
  if (sheet.protected) throw new Error("受保护的工作表不能修改");
  if (addresses.length > 10000) throw new Error("单次最多修改 10000 个单元格");
  const selected = new Set(addresses);
  for (const merge of sheet.merges) if (rangeAddresses(merge).some(a => selected.has(a))) throw new Error("暂不支持修改合并单元格区域");
  return sheet;
}

export function paintSpreadsheetFormat(book: SpreadsheetWorkbook, sheetName: string, range: string, source: Pick<SpreadsheetCell, "style" | "styleIndex">): SpreadsheetWorkbook {
  const addresses = rangeAddresses(range);
  const sheet = editableSheet(book, sheetName, addresses);
  const cells = { ...sheet.cells };
  for (const address of addresses) cells[address] = {
    ...(cells[address] ?? { value: null, kind: "empty" }),
    styleIndex: source.styleIndex ?? 0,
    style: { ...source.style },
  };
  return { ...book, sheets: book.sheets.map(s => s === sheet ? { ...s, cells } : s) };
}

export function applySpreadsheetStyle(book: SpreadsheetWorkbook, sheetName: string, range: string, patch: SpreadsheetStyle): SpreadsheetWorkbook {
  const addresses = rangeAddresses(range);
  const sheet = editableSheet(book, sheetName, addresses);
  if (patch.fontFamily !== undefined && (!patch.fontFamily.trim() || patch.fontFamily.length > 100)) throw new Error("字体名称无效");
  if (patch.fontSize !== undefined && (!Number.isFinite(patch.fontSize) || patch.fontSize < 1 || patch.fontSize > 409)) throw new Error("字号须在 1–409 之间");
  for (const color of [patch.color, patch.backgroundColor]) if (color !== undefined && !/^#[\da-f]{6}$/i.test(color)) throw new Error("颜色格式无效");
  if (patch.numberFormat !== undefined && (!patch.numberFormat || patch.numberFormat.length > 200)) throw new Error("数字格式无效");
  if (patch.horizontal !== undefined && !["general", "left", "center", "right", "justify"].includes(patch.horizontal)) throw new Error("水平对齐无效");
  if (patch.vertical !== undefined && !["top", "center", "bottom"].includes(patch.vertical)) throw new Error("垂直对齐无效");
  const normalized = { ...patch };
  if (normalized.color) normalized.color = normalized.color.toUpperCase();
  if (normalized.backgroundColor) normalized.backgroundColor = normalized.backgroundColor.toUpperCase();
  const cells = { ...sheet.cells };
  for (const a of addresses) cells[a] = { ...(cells[a] ?? { value: null, kind: "empty" }), style: { ...cells[a]?.style, ...normalized } };
  return { ...book, sheets: book.sheets.map(s => s === sheet ? { ...s, cells } : s) };
}

/** Conservative cut/paste: never overwrites occupied destinations or silently changes references. */
export function moveSpreadsheetRange(book: SpreadsheetWorkbook, sheetName: string, range: string, destination: string): SpreadsheetWorkbook {
  const source = rangeAddresses(range), origin = cellPosition(source[0]), target = cellPosition(destination);
  const dest = source.map(a => { const p = cellPosition(a); return cellAddress(p.row - origin.row + target.row, p.column - origin.column + target.column); });
  const sheet = editableSheet(book, sheetName, [...new Set([...source, ...dest])]);
  if (source[0] === dest[0]) return book;
  if (dest.some(a => source.includes(a))) throw new Error("目标区域不能与原区域重叠");
  if (dest.some(a => sheet.cells[a]?.value != null || sheet.cells[a]?.formula)) throw new Error("目标区域已有内容，请选择空白区域");
  // Excel cut semantics require rewriting every dependent reference, including named ranges.
  // Until that is supported, reject moving referenced/formula cells rather than corrupting results.
  const sourceSet = new Set(source);
  for (const a of source) if (sheet.cells[a]?.formula) throw new Error("暂不支持移动公式单元格，请在目标位置重新填写公式");
  if (book.entries["xl/workbook.xml"] && /<(?:\w+:)?definedName\b/.test(strFromU8(book.entries["xl/workbook.xml"]))) throw new Error("工作簿含命名区域，暂不支持安全移动内容");
  for (const s of book.sheets) for (const c of Object.values(s.cells)) if (c.formula) {
    // Conservative across sheets: false positives are preferable to broken dependencies.
    const refs = c.formula.match(/\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?/gi) ?? [];
    if (refs.some(ref => rangeAddresses(ref).some(a => sourceSet.has(a)))) throw new Error("原区域被公式引用，暂不支持安全移动，请复制内容或调整公式后再移动");
  }
  const cells = { ...sheet.cells };
  source.forEach((a, i) => { cells[dest[i]] = { ...(sheet.cells[a] ?? { value: null, kind: "empty" }) }; cells[a] = { value: null, kind: "empty", styleIndex: sheet.cells[a]?.styleIndex, style: sheet.cells[a]?.style }; });
  const candidate = { ...book, sheets: book.sheets.map(s => ({ ...s, cells: Object.fromEntries(Object.entries(s === sheet ? cells : s.cells).map(([a, c]) => [a, { ...c }])) })) };
  for (const s of candidate.sheets) for (const c of Object.values(s.cells)) if (c.formula) {
    if (c.unsupportedFormula) throw new Error("工作簿含共享或数组公式，暂不能安全重算");
    c.value = calculateFormula(s, c.formula, candidate.sheets);
  }
  return candidate;
}

/** Add styles by cloning original records. Never mutate a shared font/xf in place. */
export function createStyleWriter(entries: Record<string, Uint8Array>) {
  const parser = new DOMParser();
  const doc = entries["xl/styles.xml"] ? parser.parseFromString(strFromU8(entries["xl/styles.xml"]), "application/xml") : parser.parseFromString(`<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`, "application/xml");
  const serializer = new XMLSerializer(); let dirty = false;
  const cache = new Map<string, number>();
  const group = (name: string) => {
    let node = children(doc, name)[0];
    if (!node) { node = doc.createElementNS(NS, name); const order = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"]; doc.documentElement.insertBefore(node, Array.from(doc.documentElement.children).find(n => order.indexOf(n.localName) > order.indexOf(name)) ?? null); }
    return node;
  };
  const append = (parent: Element, node: Element) => { const id = parent.children.length; parent.append(node); parent.setAttribute("count", String(parent.children.length)); return id; };
  const element = (name: string, attrs: Record<string, string> = {}) => { const node = doc.createElementNS(NS, name); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); return node; };
  return {
    index(cell: SpreadsheetCell, before?: SpreadsheetCell) {
      const patch = Object.fromEntries(Object.entries(cell.style ?? {}).filter(([,v]) => v !== undefined)) as SpreadsheetStyle;
      const base = cell.styleIndex ?? 0;
      if (!Object.keys(patch).length) return base;
      const key = JSON.stringify([base, patch]); if (cache.has(key)) return cache.get(key)!;
      dirty = true;
      const xfs = group("cellXfs"); const xf = (xfs.children[base]?.cloneNode(true) as Element | undefined) ?? element("xf", {numFmtId:"0",fontId:"0",fillId:"0",borderId:"0",xfId:"0"});
      if ([patch.fontFamily,patch.fontSize,patch.bold,patch.italic,patch.color].some(v => v !== undefined)) {
        const fonts = group("fonts"); const font = (fonts.children[Number(xf.getAttribute("fontId") ?? 0)]?.cloneNode(true) as Element | undefined) ?? element("font");
        for (const [name, value] of [["name",patch.fontFamily],["sz",patch.fontSize],["b",patch.bold],["i",patch.italic],["color",patch.color]] as const) if (value !== undefined) {
          children(font, name).forEach(n => n.remove());
          font.append(element(name, name === "color" ? {rgb:`FF${String(value).slice(1)}`} : {val:typeof value === "boolean" ? value ? "1" : "0" : String(value)}));
        }
        if (patch.fontFamily !== undefined) children(font,"scheme").forEach(n => n.remove());
        xf.setAttribute("fontId", String(append(fonts,font))); xf.setAttribute("applyFont","1");
      }
      if (patch.backgroundColor !== undefined) { const fill = element("fill"); const pattern = element("patternFill", {patternType:"solid"}); pattern.append(element("fgColor",{rgb:`FF${patch.backgroundColor.slice(1)}`}),element("bgColor",{indexed:"64"})); fill.append(pattern); xf.setAttribute("fillId",String(append(group("fills"),fill))); xf.setAttribute("applyFill","1"); }
      if (patch.numberFormat !== undefined) {
        const builtin = Object.entries(builtinFormats).find(([,v]) => v === patch.numberFormat);
        let id = builtin ? Number(builtin[0]) : undefined;
        if (id === undefined) { const formats = group("numFmts"); const existing = Array.from(formats.children).find(n => n.getAttribute("formatCode") === patch.numberFormat); id = existing ? Number(existing.getAttribute("numFmtId")) : Math.max(163,...Array.from(formats.children).map(n => Number(n.getAttribute("numFmtId")))) + 1; if (!existing) append(formats,element("numFmt",{numFmtId:String(id),formatCode:patch.numberFormat})); }
        xf.setAttribute("numFmtId",String(id)); xf.setAttribute("applyNumberFormat","1");
      }
      if (patch.horizontal !== undefined || patch.vertical !== undefined) { let alignment = children(xf,"alignment")[0]; if (!alignment) { alignment=element("alignment"); xf.insertBefore(alignment, Array.from(xf.children).find(n => ["protection","extLst"].includes(n.localName)) ?? null); } if (patch.horizontal !== undefined) alignment.setAttribute("horizontal",patch.horizontal); if (patch.vertical !== undefined) alignment.setAttribute("vertical",patch.vertical); xf.setAttribute("applyAlignment","1"); }
      const id = append(xfs,xf); cache.set(key,id); return id;
    },
    finish() {
      if (!dirty) return;
      entries["xl/styles.xml"] = Uint8Array.from(strToU8(serializer.serializeToString(doc)));
      for (const path of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) {
        if (!entries[path]) throw new Error("工作簿缺少样式关系文件");
        const part = parser.parseFromString(strFromU8(entries[path]),"application/xml"); const root = part.documentElement;
        if (path.endsWith(".rels")) {
          if (!Array.from(root.children).some(n => n.getAttribute("Type")?.endsWith("/styles"))) { const ids = new Set(Array.from(root.children).map(n => n.getAttribute("Id"))); let n=1; while(ids.has(`rIdMojiStyles${n}`)) n++; const rel=part.createElementNS(root.namespaceURI,"Relationship"); rel.setAttribute("Id",`rIdMojiStyles${n}`);rel.setAttribute("Type","http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles");rel.setAttribute("Target","styles.xml");root.append(rel); }
        } else if (!Array.from(root.children).some(n => n.getAttribute("PartName") === "/xl/styles.xml")) { const override=part.createElementNS(root.namespaceURI,"Override");override.setAttribute("PartName","/xl/styles.xml");override.setAttribute("ContentType","application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml");root.append(override); }
        entries[path]=Uint8Array.from(strToU8(serializer.serializeToString(part)));
      }
    }
  };
}
