import { strFromU8, strToU8, zipSync } from "fflate";
import { cellPosition, type SpreadsheetWorkbook } from "./model";
import { readSpreadsheet } from "./read";
import { createStyleWriter } from "./style";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
/** Patch only changed cell XML; preserve charts, images, comments and styles. */
export function writeSpreadsheet(original: SpreadsheetWorkbook, edited: SpreadsheetWorkbook): Uint8Array {
  // Structural edits carry a transformed package baseline; do not restore stale row XML.
  if (original.entries !== edited.entries) original = readSpreadsheet(zipSync(edited.entries));
  const entries = { ...original.entries };
  const styleWriter = createStyleWriter(entries);
  const parser = new DOMParser(); const serializer = new XMLSerializer();
  const xml = (path: string) => parser.parseFromString(strFromU8(entries[path]), "application/xml");
  if (original.sheets.length !== edited.sheets.length) throw new Error("不能改变工作表结构");
  for (let i = 0; i < original.sheets.length; i++) {
    const before = original.sheets[i], after = edited.sheets[i];
    if (before.name !== after.name || before.path !== after.path) throw new Error("不能改变工作表结构");
    const changed = Object.keys(after.cells).filter((a) => JSON.stringify(before.cells[a]) !== JSON.stringify(after.cells[a]));
    const layoutChanged = JSON.stringify([before.merges,before.columnWidths,before.rowHeights]) !== JSON.stringify([after.merges,after.columnWidths,after.rowHeights]);
    if (!changed.length && !layoutChanged) continue;
    if (before.protected) throw new Error("不能保存受保护的工作表");
    const doc = xml(before.path);
    const data = doc.getElementsByTagNameNS(NS, "sheetData")[0];
    if (!data) throw new Error("工作表缺少 sheetData");
    if (layoutChanged) {
      if (JSON.stringify(before.merges) !== JSON.stringify(after.merges)) {
        Array.from(doc.getElementsByTagNameNS(NS,"mergeCells")).forEach(n=>n.remove());
        if (after.merges.length) {
          const merges = doc.createElementNS(NS,"mergeCells"); merges.setAttribute("count",String(after.merges.length));
          after.merges.forEach(ref=>{const n=doc.createElementNS(NS,"mergeCell");n.setAttribute("ref",ref);merges.append(n);});
          const following = ["phoneticPr","conditionalFormatting","dataValidations","hyperlinks","printOptions","pageMargins","pageSetup","headerFooter","rowBreaks","colBreaks","customProperties","cellWatches","ignoredErrors","smartTags","drawing","legacyDrawing","legacyDrawingHF","picture","oleObjects","controls","webPublishItems","tableParts","extLst"];
          doc.documentElement.insertBefore(merges,Array.from(doc.documentElement.children).find(n=>following.includes(n.localName)) ?? null);
        }
      }
      for (const [key,height] of Object.entries(after.rowHeights ?? {})) if (height !== before.rowHeights?.[Number(key)]) {
        let row = Array.from(data.children).find(n=>n.getAttribute("r")===key);
        if (!row) {row=doc.createElementNS(NS,"row");row.setAttribute("r",key);data.insertBefore(row,Array.from(data.children).find(n=>Number(n.getAttribute("r"))>Number(key)) ?? null);}
        row.setAttribute("ht",String(height*3/4));row.setAttribute("customHeight","1");
      }
      for (const [key,width] of Object.entries(after.columnWidths ?? {})) if (width !== before.columnWidths?.[Number(key)]) {
        const index=Number(key); let cols=doc.getElementsByTagNameNS(NS,"cols")[0];
        if (!cols) {cols=doc.createElementNS(NS,"cols");doc.documentElement.insertBefore(cols,data);}
        let base: Element | undefined;
        for (const col of Array.from(cols.children)) {
          const min=Number(col.getAttribute("min")),max=Number(col.getAttribute("max"));
          if (min<=index && max>=index) {
            base=col.cloneNode(true) as Element;
            if(min<index) {const left=col.cloneNode(true) as Element;left.setAttribute("max",String(index-1));cols.insertBefore(left,col);}
            if(max>index) {const right=col.cloneNode(true) as Element;right.setAttribute("min",String(index+1));cols.insertBefore(right,col);}
            col.remove();
          }
        }
        const col=base ?? doc.createElementNS(NS,"col");col.setAttribute("min",key);col.setAttribute("max",key);col.setAttribute("width",String((width-5)/7));col.setAttribute("customWidth","1");
        cols.insertBefore(col,Array.from(cols.children).find(n=>Number(n.getAttribute("min"))>index) ?? null);
      }
    }
    for (const address of changed) {
      const cell = after.cells[address]; const point = cellPosition(address);
      let row = Array.from(data.children).find((r) => Number(r.getAttribute("r")) === point.row);
      const existingGlobal = Array.from(data.getElementsByTagNameNS(NS, "c")).find((c) => c.getAttribute("r") === address);
      if (existingGlobal?.parentElement) row = existingGlobal.parentElement;
      if (!row) { row = doc.createElementNS(NS, "row"); row.setAttribute("r", String(point.row)); data.insertBefore(row, Array.from(data.children).find((r) => Number(r.getAttribute("r")) > point.row) ?? null); }
      // Some producers emit cells out of row order; search the whole row before creating one.
      let node = Array.from(row.getElementsByTagNameNS(NS, "c")).find((c) => c.getAttribute("r") === address) ?? existingGlobal;
      if (node) Array.from(row.getElementsByTagNameNS(NS, "c")).filter((c) => c !== node && c.getAttribute("r") === address).forEach((duplicate) => duplicate.remove());
      if (!node) { node = doc.createElementNS(NS, "c"); node.setAttribute("r", address); row.insertBefore(node, Array.from(row.children).find((c) => cellPosition(c.getAttribute("r") ?? "A1").column > point.column) ?? null); }
      Array.from(node.children).filter((c) => ["v", "f", "is"].includes(c.localName)).forEach((c) => c.remove());
      node.removeAttribute("t");
      node.setAttribute("s", String(styleWriter.index(cell, before.cells[address])));
      const add = (name: string, value: string) => { const el = doc.createElementNS(NS, name); el.textContent = value; node!.append(el); return el; };
      if (cell.formula) add("f", cell.formula.replace(/^=/, ""));
      if (typeof cell.value === "string") {
        if (cell.kind === "error") { node.setAttribute("t", "e"); add("v", cell.value); }
        else if (cell.formula) { node.setAttribute("t", "str"); add("v", cell.value); }
        else { node.setAttribute("t", "inlineStr"); const inline = add("is", ""); const t = doc.createElementNS(NS, "t"); t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); t.textContent = cell.value; inline.append(t); }
      } else if (typeof cell.value === "boolean") { node.setAttribute("t", "b"); add("v", cell.value ? "1" : "0"); }
      else if (cell.value !== null) { if (!Number.isFinite(cell.value)) throw new Error("无效计算结果"); add("v", String(cell.value)); }
    }
    // Optional used-range and calculation-chain caches must not retain stale references.
    Array.from(doc.getElementsByTagNameNS(NS, "dimension")).forEach((n) => n.remove());
    entries[before.path] = Uint8Array.from(strToU8(serializer.serializeToString(doc)));
  }
  styleWriter.finish();
  const workbook = xml("xl/workbook.xml");
  let calc = workbook.getElementsByTagNameNS(NS, "calcPr")[0];
  if (!calc) { calc = workbook.createElementNS(NS, "calcPr"); workbook.documentElement.append(calc); }
  calc.setAttribute("fullCalcOnLoad", "1"); calc.setAttribute("forceFullCalc", "1"); calc.setAttribute("calcMode", "auto");
  entries["xl/workbook.xml"] = Uint8Array.from(strToU8(serializer.serializeToString(workbook)));
  for (const path of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) {
    if (!entries[path]) continue;
    const doc = xml(path);
    for (const child of Array.from(doc.documentElement.children)) {
      if (child.getAttribute("Type")?.endsWith("/calcChain") || child.getAttribute("PartName") === "/xl/calcChain.xml") child.remove();
    }
    entries[path] = Uint8Array.from(strToU8(serializer.serializeToString(doc)));
  }
  delete entries["xl/calcChain.xml"];
  const bytes = zipSync(entries);
  const verified = readSpreadsheet(bytes);
  for (let i = 0; i < edited.sheets.length; i++) for (const [address, expected] of Object.entries(edited.sheets[i].cells)) {
    const actual = verified.sheets[i].cells[address];
    if (!actual || actual.value !== expected.value || actual.formula !== expected.formula) throw new Error(`保存校验失败：${address}`);
  }
  return bytes;
}

export function spreadsheetBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
