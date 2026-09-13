import { strFromU8, strToU8, zipSync, unzipSync } from "fflate";
import { cellAddress, cellPosition, rangeAddresses, type SpreadsheetWorkbook } from "./model";
import { readSpreadsheet } from "./read";
import { writeSpreadsheet } from "./write";
import { calculateFormula } from "./calc";

function target(book: SpreadsheetWorkbook, name: string) {
  const sheet=book.sheets.find(s=>s.name===name);
  if(!sheet) throw new Error("工作表不存在");
  if(sheet.protected) throw new Error("受保护的工作表不能修改");
  return sheet;
}
export function resizeSpreadsheet(book: SpreadsheetWorkbook,name:string,axis:"row"|"column",index:number,pixels:number) {
  const sheet=target(book,name);
  cellPosition(axis==="row"?`A${index}`:cellAddress(1,index));
  if(!Number.isFinite(pixels)) throw new Error("尺寸无效");
  const field=axis==="row"?"rowHeights":"columnWidths";
  const size=Math.max(axis==="row"?24:40,Math.min(axis==="row"?546:1200,Math.round(pixels)));
  return {...book,sheets:book.sheets.map(s=>s===sheet?{...s,[field]:{...s[field],[index]:size}}:s)};
}
export function mergeSpreadsheet(book: SpreadsheetWorkbook,name:string,range:string,unmerge=false) {
  const sheet=target(book,name), addresses=rangeAddresses(range), chosen=new Set(addresses);
  const overlaps=sheet.merges.filter(m=>rangeAddresses(m).some(a=>chosen.has(a)));
  if(unmerge) return {...book,sheets:book.sheets.map(s=>s===sheet?{...s,merges:s.merges.filter(m=>!overlaps.includes(m))}:s)};
  if(addresses.length<2) throw new Error("请先拖选两个或更多单元格");
  if(overlaps.length) throw new Error("选区包含已合并单元格，请先取消合并");
  if(addresses.slice(1).some(a=>sheet.cells[a]?.value!=null && sheet.cells[a].value!=="" || sheet.cells[a]?.formula)) throw new Error("合并只保留左上角内容。请先移动其他单元格的内容，再合并，避免丢失数据");
  return {...book,sheets:book.sheets.map(s=>s===sheet?{...s,merges:[...s.merges,range]}:s)};
}

/** Structural XML edits preserve cell metadata; unsupported reference-bearing objects block the edit. */
export function changeSpreadsheetAxis(book:SpreadsheetWorkbook,name:string,axis:"row"|"column",index:number,remove=false,count=1) {
  const sheet=target(book,name), limit=axis==="row"?1048576:16384;
  if(!Number.isInteger(index)||index<1||index>limit||!Number.isInteger(count)||count<1||index+count-1>limit) throw new Error("行列位置无效");
  const entries=unzipSync(writeSpreadsheet(readSpreadsheet(zipSync(book.entries)),book));
  const parser=new DOMParser(), serializer=new XMLSerializer();
  const xml=(path:string)=>parser.parseFromString(strFromU8(entries[path]),"application/xml");
  const nodes=(doc:Document|Element,tag:string)=>Array.from(doc.getElementsByTagNameNS("*",tag));
  const wb=xml("xl/workbook.xml");
  if(nodes(wb,"definedName").length) throw new Error("工作簿含命名区域，暂不能安全插入或删除行列");
  const doc=xml(sheet.path);
  const unsupported=["tableParts","drawing","legacyDrawing","conditionalFormatting","dataValidations","hyperlinks","autoFilter","pane","rowBreaks","colBreaks","extLst"];
  if(unsupported.some(tag=>nodes(doc,tag).length)||Object.keys(entries).some(p=>/xl\/(charts|pivot|externalLinks)/.test(p))) throw new Error("工作表含表格、图表、筛选或其他关联对象，暂不能安全插入或删除行列");
  const shift=(n:number)=>remove?(n>=index&&n<index+count?null:n>=index+count?n-count:n):(n>=index?n+count:n);
  const address=(ref:string)=>{
    const p=cellPosition(ref), next=shift(p[axis]);
    if(next===null)return null;
    if(next>limit)throw new Error("插入会超出 Excel 行列上限");
    return cellAddress(axis==="row"?next:p.row,axis==="column"?next:p.column);
  };
  const interval=(a:number,b:number):[number,number]|null=>{
    if(!remove) return [a>=index?a+count:a,b>=index?b+count:b];
    if(a>=index&&a<index+count&&b<index+count)return null;
    const adjust=(n:number)=>n>=index+count?n-count:n>=index?index:n;
    return [adjust(a),adjust(b)];
  };
  const reference=(ref:string)=>{
    const [a,b]=ref.split(":");
    const preserve=(old:string,next:string)=>{const m=/^(\$?)[A-Z]+(\$?)/i.exec(old)!;const p=cellPosition(next);return `${m[1]}${cellAddress(1,p.column).slice(0,-1)}${m[2]}${p.row}`;};
    if(!b){const next=address(a);return next?preserve(a,next):"#REF!";}
    const p=cellPosition(a),q=cellPosition(b), span=interval(p[axis],q[axis]);
    if(!span)return "#REF!";
    const first=cellAddress(axis==="row"?span[0]:p.row,axis==="column"?span[0]:p.column);
    const last=cellAddress(axis==="row"?span[1]:q.row,axis==="column"?span[1]:q.column);
    return `${preserve(a,first)}:${preserve(b,last)}`;
  };
  // Preserve string literals. A1 references (including absolute and quoted sheet names) follow the edit.
  for(const s of book.sheets) {
    const part=s.path===sheet.path?doc:xml(s.path);
    for(const f of nodes(part,"f")) {
      if(f.getAttribute("t") && f.getAttribute("t")!=="normal") throw new Error("共享或数组公式暂不支持结构调整");
      const formula=f.textContent??"";
      if(/[\[\]#]|\b[A-Z]+:[A-Z]+\b|\b\d+:\d+\b|\b(INDIRECT|OFFSET)\s*\(/i.test(formula)) throw new Error("公式含暂不支持的引用形式，未修改文件");
      f.textContent=formula.split(/("(?:[^"]|"")*")/g).map((chunk,i)=>i%2?chunk:chunk.replace(/(?<![\w.])(?:(('(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!))?(\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?)(?![\w(])/gu,(whole,prefix,sheetToken,ref)=>{
        const referenced=sheetToken?sheetToken.replace(/^'|'$/g,"").replace(/''/g,"'"):s.name;
        return referenced.toLowerCase()===name.toLowerCase()?`${prefix??""}${reference(ref)}`:whole;
      })).join("");
    }
    if(s.path!==sheet.path)entries[s.path]=Uint8Array.from(strToU8(serializer.serializeToString(part)));
  }
  for(const c of nodes(doc,"c")){const next=address(c.getAttribute("r")!);if(next)c.setAttribute("r",next);else c.remove();}
  if(axis==="row")for(const row of nodes(doc,"row")){const next=shift(Number(row.getAttribute("r")));if(next===null)row.remove();else {row.setAttribute("r",String(next));row.removeAttribute("spans");}}
  else for(const col of nodes(doc,"col")){const span=interval(Number(col.getAttribute("min")),Number(col.getAttribute("max")));if(!span)col.remove();else{col.setAttribute("min",String(span[0]));col.setAttribute("max",String(span[1]));}}
  // Normalize incorrectly grouped producer cells as well as newly shifted cells.
  const data=nodes(doc,"sheetData")[0];
  for(const c of nodes(doc,"c")){
    const rowNumber=cellPosition(c.getAttribute("r")!).row;
    let row=Array.from(data.children).find(r=>Number(r.getAttribute("r"))===rowNumber);
    if(!row){row=doc.createElementNS(data.namespaceURI,"row");row.setAttribute("r",String(rowNumber));data.insertBefore(row,Array.from(data.children).find(r=>Number(r.getAttribute("r"))>rowNumber)??null);}
    if(c.parentElement!==row)row.append(c);
  }
  for(const m of nodes(doc,"mergeCell")){const ref=reference(m.getAttribute("ref")!);if(ref==="#REF!"||ref.split(":")[0]===ref.split(":")[1])m.remove();else m.setAttribute("ref",ref);}
  for(const m of nodes(doc,"mergeCells"))m.setAttribute("count",String(m.children.length));
  nodes(doc,"dimension").forEach(n=>n.remove());
  entries[sheet.path]=Uint8Array.from(strToU8(serializer.serializeToString(doc)));
  const result=readSpreadsheet(zipSync(entries));
  for(const s of result.sheets)for(const c of Object.values(s.cells))if(c.formula){
    if(c.formula.includes("#REF!")){c.value="#REF!";c.kind="error";continue;}
    try{c.value=calculateFormula(s,c.formula,result.sheets);c.kind="number";}catch{throw new Error("结构修改后的公式暂不能安全重算，已取消此次操作");}
  }
  return result;
}
