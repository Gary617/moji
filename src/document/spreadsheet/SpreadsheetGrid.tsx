import { useMemo, useRef, useState, type CSSProperties } from "react";
import { cellAddress, cellPosition, type SpreadsheetWorkbook, type SpreadsheetStyle } from "./model";
import { readSpreadsheet } from "./read";
import { moveSpreadsheetRange, previewSpreadsheetPlan, type SpreadsheetOperation } from "./operations";
import { applySpreadsheetStyle, formatCellDisplay, paintSpreadsheetFormat } from "./style";
import { spreadsheetBase64, writeSpreadsheet } from "./write";
import { changeSpreadsheetAxis, mergeSpreadsheet, resizeSpreadsheet } from "./structure";

export function SpreadsheetGrid({ binaryContent, name, editable = false, onArtifact, aiChanges = [], onClearAiChanges }: { binaryContent: string | null; name: string; editable?: boolean; onArtifact?(value: string | null): void; aiChanges?: Array<{ sheet: string; address: string }>; onClearAiChanges?(): void }) {
  const parsed = useMemo(() => {
    try { return { book: readSpreadsheet(Uint8Array.from(atob(binaryContent ?? ""), (c) => c.charCodeAt(0))), error: null }; }
    catch (error) { return { book: null, error: error instanceof Error ? error.message : "工作簿无法读取" }; }
  }, [binaryContent]);
  if (!parsed.book) return <div role="alert">{parsed.error}</div>;
  return <WorkbookGrid key={binaryContent} initial={parsed.book} name={name} editable={editable} onArtifact={onArtifact} aiChanges={aiChanges} onClearAiChanges={onClearAiChanges} />;
}

function WorkbookGrid({ initial, name, editable, onArtifact, aiChanges, onClearAiChanges }: { initial: SpreadsheetWorkbook; name: string; editable: boolean; onArtifact?(value: string | null): void; aiChanges: Array<{ sheet: string; address: string }>; onClearAiChanges?(): void }) {
  const [book, setBook] = useState(initial);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [address, setAddress] = useState("A1");
  const [end, setEnd] = useState("A1");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pageRow, setPageRow] = useState(1);
  const [pageColumn, setPageColumn] = useState(1);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [paintSource, setPaintSource] = useState<{ label: string; style: SpreadsheetStyle; styleIndex: number } | null>(null);
  const paintStart = useRef<string | null>(null);
  const [selectionAxis, setSelectionAxis] = useState<"row"|"column"|null>(null);
  const [pendingDelete, setPendingDelete] = useState<"row"|"column"|null>(null);
  const [undo, setUndo] = useState<SpreadsheetWorkbook|null>(null);
  const resizing = useRef<{axis:"row"|"column";index:number;origin:number;size:number;next:number}|null>(null);
  const [resizePreview,setResizePreview]=useState<{axis:"row"|"column";index:number;size:number}|null>(null);
  const axisDrag = useRef<{axis:"row"|"column";anchor:number;current:number;moved:boolean}|null>(null);
  const suppressAxisClick = useRef(false);
  const sheet = book.sheets[sheetIndex];
  const start = cellPosition(address); const finish = cellPosition(end);
  const range = `${cellAddress(Math.min(start.row, finish.row), Math.min(start.column, finish.column))}:${cellAddress(Math.max(start.row, finish.row), Math.max(start.column, finish.column))}`;
  const select = (next: string) => { setSelectionAxis(null); setPendingDelete(null); setAddress(next); setEnd(next); setInput(sheet.cells[next]?.formula ?? String(sheet.cells[next]?.value ?? "")); setError(""); };
  const commit = (next: SpreadsheetWorkbook) => {
    if (onArtifact) onArtifact(spreadsheetBase64(writeSpreadsheet(initial, next)));
    setUndo(book);setBook(next); setDirty(true); setError("");
  };
  const format = (patch: Partial<SpreadsheetStyle>) => {
    if(selectionAxis) {setError("整行/整列已选中。批量字体格式请先拖选具体区域，避免生成百万个空白单元格。");return;}
    try { commit(applySpreadsheetStyle(book, sheet.name, range, patch)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "格式修改失败"); }
  };
  const selectedStyle = sheet.cells[address]?.style ?? {};
  const apply = () => {
    try {
      const operation: SpreadsheetOperation = input.startsWith("=") ? { type: "set_formula", range, formula: input }
        : input === "" ? { type: "clear", range }
        : { type: "set_value", range, value: input.startsWith("'") ? input.slice(1) : input.trim() !== "" && Number.isFinite(Number(input)) ? Number(input) : input };
      const result = previewSpreadsheetPlan(book, { sheet: sheet.name, operations: [operation] }, true);
      commit(result.workbook);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "修改失败"); }
  };
  const pointerCell = (target: EventTarget) => {
    const td = (target as Element).closest?.("td");
    if (!td || !td.closest(".xlsx-grid-wrap")) return null;
    return td.getAttribute("data-address");
  };
  const paint = (from: string, to: string) => {
    if (!paintSource || !editable) return;
    const a = cellPosition(from), b = cellPosition(to);
    const destination = `${cellAddress(Math.min(a.row,b.row),Math.min(a.column,b.column))}:${cellAddress(Math.max(a.row,b.row),Math.max(a.column,b.column))}`;
    try {
      commit(paintSpreadsheetFormat(book, sheet.name, destination, paintSource));
      setAddress(from); setEnd(to); setPaintSource(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "格式刷应用失败"); }
    paintStart.current = null;
  };
  const action = (task:()=>SpreadsheetWorkbook) => {try{commit(task());setPendingDelete(null);setPaintSource(null);}catch(cause){setError(cause instanceof Error?cause.message:"操作失败");}};
  const chooseAxis=(axis:"row"|"column",index:number,current=index)=>{
    const first=Math.min(index,current), last=Math.max(index,current);
    setSelectionAxis(axis);setPendingDelete(null);setPaintSource(null);
    setAddress(axis==="row"?cellAddress(first,1):cellAddress(1,first));
    setEnd(axis==="row"?cellAddress(last,16384):cellAddress(1048576,last));
  };
  const selectedAxisBounds=()=>{
    if(!selectionAxis)return {first:1,last:1,count:1};
    const first=selectionAxis==="row"?Math.min(start.row,finish.row):Math.min(start.column,finish.column);
    const last=selectionAxis==="row"?Math.max(start.row,finish.row):Math.max(start.column,finish.column);
    return {first,last,count:last-first+1};
  };
  const dimension=(axis:"row"|"column",index:number)=>resizePreview?.axis===axis&&resizePreview.index===index?resizePreview.size:(axis==="row"?sheet.rowHeights?.[index]:sheet.columnWidths?.[index])??(axis==="row"?36:120);
  const handle=(axis:"row"|"column",index:number)=><span role="separator" aria-label={`调整${axis==="row"?"行高":"列宽"} ${index}`} aria-orientation={axis==="row"?"horizontal":"vertical"} tabIndex={0} className={`sheet-resize-${axis}`}
    onClick={e=>e.stopPropagation()}
    onKeyDown={e=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();action(()=>resizeSpreadsheet(book,sheet.name,axis,index,dimension(axis,index)+(["ArrowLeft","ArrowUp"].includes(e.key)?-8:8)));}}}
    onPointerDown={e=>{if(!editable||sheet.protected)return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture?.(e.pointerId);const size=dimension(axis,index);resizing.current={axis,index,origin:axis==="row"?e.clientY:e.clientX,size,next:size};}}
    onPointerMove={e=>{const drag=resizing.current;if(!drag)return;const zoom=Number(getComputedStyle(e.currentTarget).getPropertyValue("--document-zoom"))||1;const delta=((drag.axis==="row"?e.clientY:e.clientX)-drag.origin)/zoom;drag.next=Math.max(drag.axis==="row"?24:40,Math.min(drag.axis==="row"?546:1200,drag.size+delta));setResizePreview({axis:drag.axis,index:drag.index,size:drag.next});}}
    onPointerUp={e=>{const drag=resizing.current;if(!drag)return;e.stopPropagation();resizing.current=null;setResizePreview(null);action(()=>resizeSpreadsheet(book,sheet.name,axis,index,drag.next));}}
    onPointerCancel={()=>{resizing.current=null;setResizePreview(null);}}
    onLostPointerCapture={()=>{const drag=resizing.current;if(!drag)return;resizing.current=null;setResizePreview(null);action(()=>resizeSpreadsheet(book,sheet.name,drag.axis,drag.index,drag.next));}}/>;
  return <div className="office-preview-shell spreadsheet-grid" aria-label={editable ? "XLSX 编辑器" : "XLSX 预览"}
    onKeyDownCapture={(e) => { if (e.key === "Escape" && paintSource) { setPaintSource(null); paintStart.current = null; e.stopPropagation(); } }}
    onPointerDownCapture={(e) => {
      paintStart.current = paintSource && e.button === 0 ? pointerCell(e.target) : null;
      // An axis selection is transient: any pointer press outside a row/column header exits it.
      const axisHeader = (e.target as Element).closest?.("button[data-axis]");
      if (!axisHeader && selectionAxis) setSelectionAxis(null);
    }}
    onPointerUpCapture={(e) => { const target = pointerCell(e.target); if (paintStart.current && target) paint(paintStart.current, target); else paintStart.current = null; const drag=axisDrag.current; if(drag){chooseAxis(drag.axis,drag.anchor,drag.current);suppressAxisClick.current=drag.moved;axisDrag.current=null;} }}
    onPointerMoveCapture={(e) => { const drag=axisDrag.current; if(!drag || e.buttons!==1) return; const target=(e.target as Element).closest?.("button[data-axis]") as HTMLElement|null; if(!target) return; const axis=target.dataset.axis as "row"|"column"; const index=Number(target.dataset.index); if(axis===drag.axis && Number.isInteger(index)){drag.current=index;chooseAxis(axis,drag.anchor,index);} }}
    onPointerCancel={() => { paintStart.current = null; }}
    onClickCapture={(e) => { const target = pointerCell(e.target); if (paintSource && target && e.detail === 0) { e.stopPropagation(); paint(target, target); } }}>
    <span className="sr-only">{name}</span>
    <div className="xlsx-sheet-tabs" role="tablist" aria-label="工作表">{book.sheets.map((s, i) => <button key={s.name} role="tab" aria-selected={i === sheetIndex} onClick={() => { setSheetIndex(i); setAddress("A1"); setEnd("A1"); setInput(s.cells.A1?.formula ?? String(s.cells.A1?.value ?? "")); setPageRow(1); setPageColumn(1); setError(""); }}>{s.name}</button>)}</div>
    <div className="spreadsheet-controls"><span aria-label="当前选区">当前选区：{sheet.name}!{selectionAxis==="column"?`${cellAddress(1,Math.min(start.column,finish.column)).replace(/\d/g,"")}:${cellAddress(1,Math.max(start.column,finish.column)).replace(/\d/g,"")}（整列）`:selectionAxis==="row"?`${Math.min(start.row,finish.row)}:${Math.max(start.row,finish.row)}（整行）`:address === end ? address : range}</span></div>
    {editable && <div className="spreadsheet-controls">
      <button disabled={sheet.protected} onClick={()=>{const b=selectedAxisBounds();action(()=>changeSpreadsheetAxis(book,sheet.name,"row",selectionAxis==="row"?b.first:start.row,false,selectionAxis==="row"?b.count:1));}}>插入行</button>
      <button disabled={sheet.protected} onClick={()=>{const b=selectedAxisBounds();action(()=>changeSpreadsheetAxis(book,sheet.name,"column",selectionAxis==="column"?b.first:start.column,false,selectionAxis==="column"?b.count:1));}}>插入列</button>
      <button disabled={sheet.protected} onClick={()=>setPendingDelete("row")}>删除行</button>
      <button disabled={sheet.protected} onClick={()=>setPendingDelete("column")}>删除列</button>
      <button disabled={sheet.protected||!!selectionAxis} onClick={()=>action(()=>mergeSpreadsheet(book,sheet.name,range))}>合并单元格</button>
      <button disabled={sheet.protected||!!selectionAxis} onClick={()=>action(()=>mergeSpreadsheet(book,sheet.name,range,true))}>取消合并</button>
      <button disabled={!undo} onClick={()=>{if(undo)action(()=>undo);}}>撤销上一步</button>
    </div>}
    {pendingDelete && <div role="alert">确认删除第 {pendingDelete==="row"?`${Math.min(start.row,finish.row)}-${Math.max(start.row,finish.row)}`:`${Math.min(start.column,finish.column)}-${Math.max(start.column,finish.column)}`} {pendingDelete==="row"?"行":"列"}及其内容？后续行列会前移。<button onClick={()=>{const b=selectedAxisBounds();action(()=>changeSpreadsheetAxis(book,sheet.name,pendingDelete,b.first,true,b.count));}}>确认删除</button><button onClick={()=>setPendingDelete(null)}>取消删除</button></div>}
    {editable && <fieldset className="spreadsheet-format-controls" disabled={sheet.protected}><legend className="sr-only">选区字体与格式</legend><div className="sheet-tool-group" role="group" aria-label="字体与样式"><span className="sheet-tool-heading">字体与样式</span>
      <button type="button" aria-pressed={!!paintSource} disabled={!!editingCell} onClick={() => {
        paintStart.current = null;
        setPaintSource(paintSource ? null : { label: `${sheet.name}!${address}`, style: { ...selectedStyle }, styleIndex: sheet.cells[address]?.styleIndex ?? 0 });
      }}>{paintSource ? "取消格式刷" : "格式刷"}</button>
      {paintSource && <small aria-live="polite">格式来源：{paintSource.label}。点击或拖选目标区域，仅复制格式；按 Esc 取消。</small>}
      <label>字体<select aria-label="字体" value={selectedStyle.fontFamily ?? "Calibri"} onChange={(e) => format({ fontFamily: e.target.value })}>{["Calibri", "Arial", "微软雅黑", "宋体", "黑体", "Times New Roman"].map((font) => <option key={font}>{font}</option>)}</select></label>
      <label>字号<select aria-label="字号" value={selectedStyle.fontSize ?? 11} onChange={(e) => format({ fontSize: Number(e.target.value) })}>{[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map((size) => <option key={size}>{size}</option>)}</select></label>
      <button type="button" aria-pressed={selectedStyle.bold ?? false} onClick={() => format({ bold: !selectedStyle.bold })}>粗体</button>
      <button type="button" aria-pressed={selectedStyle.italic ?? false} onClick={() => format({ italic: !selectedStyle.italic })}>斜体</button>
      <label>文字颜色<input type="color" aria-label="文字颜色" value={selectedStyle.color ? `#${selectedStyle.color.replace(/^#/, "").slice(-6)}` : "#000000"} onChange={(e) => format({ color: e.target.value })} /></label>
      </div><div className="sheet-tool-group" role="group" aria-label="格式与对齐"><span className="sheet-tool-heading">格式与对齐</span><label>数字格式<select aria-label="数字格式" value={selectedStyle.numberFormat ?? "General"} onChange={(e) => format({ numberFormat: e.target.value })}><option value="General">常规</option><option value="0">整数</option><option value="0.00">两位小数</option><option value="0.00%">百分比</option><option value="#,##0.00">千位分隔</option><option value="yyyy-mm-dd">日期</option><option value="@">文本</option></select></label>
      <label>水平位置<select aria-label="水平对齐" value={selectedStyle.horizontal ?? "left"} onChange={(e) => format({ horizontal: e.target.value as SpreadsheetStyle["horizontal"] })}><option value="left">居左</option><option value="center">居中</option><option value="right">居右</option></select></label>
      <label>垂直位置<select aria-label="垂直对齐" value={selectedStyle.vertical ?? "bottom"} onChange={(e) => format({ vertical: e.target.value as SpreadsheetStyle["vertical"] })}><option value="top">靠上</option><option value="center">居中</option><option value="bottom">靠下</option></select></label>
      </div><div className="sheet-tool-group sheet-move-group" role="group" aria-label="移动选区"><span className="sheet-tool-heading">移动选区</span><label>移至单元格<input aria-label="移动目标单元格" placeholder="例如 D5" value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} /></label><button type="button" onClick={() => { try { commit(moveSpreadsheetRange(book, sheet.name, range, moveTarget)); select(moveTarget.toUpperCase()); } catch (cause) { setError(cause instanceof Error ? cause.message : "移动失败"); } }}>移动选区</button>
      <small>移动仅支持空白目标；公式保留原引用，不会自动调整其他单元格的公式。</small>
    </div></fieldset>}
    {dirty && <div role="status">有未保存的表格草稿，关闭文档会丢失。<button onClick={() => { setBook(initial); setDirty(false); setInput(""); onArtifact?.(null); }}>放弃草稿</button></div>}
    {error && <div role="alert">{error}</div>}
    {aiChanges.filter(change => change.sheet === sheet.name).length > 0 && <div className="spreadsheet-controls" role="status">AI 已修改 {aiChanges.filter(change => change.sheet === sheet.name).map(change => change.address).join("、")}<button type="button" onClick={onClearAiChanges}>知道了</button></div>}
    {sheet.protected && <p>工作表受保护，不能修改。</p>}
      <section className="xlsx-sheet"><h3>{sheet.name}</h3><div className="xlsx-grid-wrap"><table style={{tableLayout:"fixed",width:48+Array.from({length:Math.min(20,16385-pageColumn)},(_,i)=>dimension("column",pageColumn+i)).reduce((a,b)=>a+b,0)}} aria-label={`${sheet.name} 单元格`}><colgroup><col style={{width:48}}/>{Array.from({length:Math.min(20,16385-pageColumn)},(_,i)=><col key={i} style={{width:dimension("column",pageColumn+i)}}/>)}</colgroup><thead><tr><th />{Array.from({ length: Math.min(20, 16385 - pageColumn) }, (_, c) => <th key={c} scope="col"><button data-axis="column" data-index={pageColumn+c} aria-label={`选择整列 ${cellAddress(1,pageColumn+c).slice(0,-1)}`} onPointerDown={e=>{if(e.button===0){axisDrag.current={axis:"column",anchor:pageColumn+c,current:pageColumn+c,moved:false};chooseAxis("column",pageColumn+c);}}} onPointerEnter={()=>{const drag=axisDrag.current;if(drag?.axis==="column"){drag.current=pageColumn+c;drag.moved=drag.current!==drag.anchor;chooseAxis("column",drag.anchor,pageColumn+c);}}} onClick={()=>{if(suppressAxisClick.current){suppressAxisClick.current=false;return;} chooseAxis("column",pageColumn+c);}}>{cellAddress(1, pageColumn + c).replace(/1$/, "")}</button>{editable&&handle("column",pageColumn+c)}</th>)}</tr></thead><tbody>{Array.from({ length: Math.min(50, 1048577 - pageRow) }, (_, r) => <tr key={r} style={{height:dimension("row",pageRow+r)}}><th scope="row"><button data-axis="row" data-index={pageRow+r} aria-label={`选择整行 ${pageRow+r}`} onPointerDown={e=>{if(e.button===0){axisDrag.current={axis:"row",anchor:pageRow+r,current:pageRow+r,moved:false};chooseAxis("row",pageRow+r);}}} onPointerEnter={()=>{const drag=axisDrag.current;if(drag?.axis==="row"){drag.current=pageRow+r;drag.moved=drag.current!==drag.anchor;chooseAxis("row",drag.anchor,pageRow+r);}}} onClick={()=>{if(suppressAxisClick.current){suppressAxisClick.current=false;return;} chooseAxis("row",pageRow+r);}}>{pageRow + r}</button>{editable&&handle("row",pageRow+r)}</th>{Array.from({ length: Math.min(20, 16385 - pageColumn) }, (_, c) => {
      const row = pageRow + r, column = pageColumn + c, cell = cellAddress(row, column); const value = sheet.cells[cell];
      const merged=sheet.merges.map(m=>{const [a,b]=m.split(":");return {a:cellPosition(a),b:cellPosition(b??a)};}).find(m=>row>=m.a.row&&row<=m.b.row&&column>=m.a.column&&column<=m.b.column);
      if(merged&&(row!==Math.max(pageRow,merged.a.row)||column!==Math.max(pageColumn,merged.a.column)))return null;
      const rowSpan=merged?Math.min(pageRow+49,merged.b.row)-row+1:1;
      const colSpan=merged?Math.min(pageColumn+19,merged.b.column)-column+1:1;
      const selected = row >= Math.min(start.row, finish.row) && row <= Math.max(start.row, finish.row) && column >= Math.min(start.column, finish.column) && column <= Math.max(start.column, finish.column);
      const aiChanged = aiChanges.some(change => change.sheet === sheet.name && change.address === cell);
      const style = value?.style ?? {};
      const visual: CSSProperties = { fontFamily: style.fontFamily, fontSize: style.fontSize ? `${style.fontSize}pt` : undefined, fontWeight: style.bold ? "bold" : "normal", fontStyle: style.italic ? "italic" : "normal", color: style.color ? `#${style.color.replace(/^#/, "").slice(-6)}` : undefined, backgroundColor: style.backgroundColor ? `#${style.backgroundColor.replace(/^#/, "").slice(-6)}` : undefined, textAlign: style.horizontal === "general" ? undefined : style.horizontal, verticalAlign: style.vertical === "center" ? "middle" : style.vertical };
return <td key={cell} data-address={cell} rowSpan={rowSpan} colSpan={colSpan} style={visual} className={`${selected ? "is-selected" : ""}${aiChanged ? " is-ai-changed" : ""}`} onPointerDown={() => { if (!editingCell) select(cell); }} onPointerEnter={(e) => { if (e.buttons === 1 && !editingCell) setEnd(cell); }}>{editingCell === cell ? <input className="spreadsheet-cell-editor" autoFocus style={visual} value={input} aria-label={`${sheet.name}!${cell} 编辑`} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setInput(e.target.value)} onBlur={() => { apply(); setEditingCell(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); setEditingCell(null); } if (e.key === "Escape") { e.preventDefault(); setEditingCell(null); } }} /> : <button style={{ ...visual, fontFamily: visual.fontFamily || "inherit" }} type="button" aria-label={`${sheet.name}!${cell}`} aria-pressed={selected} onDoubleClick={() => { if (editable && !sheet.protected) { select(cell); setEditingCell(cell); } }} onClick={(e) => { if (e.detail === 0) select(cell); }} title={value?.formula ?? `${cell} · ${value?.kind ?? "empty"}`}>{value ? formatCellDisplay(value, book.date1904) : ""}</button>}</td>;
    })}</tr>)}</tbody></table></div></section>
    <div className="spreadsheet-controls"><button disabled={pageRow === 1} onClick={() => setPageRow(Math.max(1, pageRow - 50))}>上 50 行</button><button disabled={pageRow + 50 > 1048576} onClick={() => setPageRow(pageRow + 50)}>下 50 行</button><button disabled={pageColumn === 1} onClick={() => setPageColumn(Math.max(1, pageColumn - 20))}>左 20 列</button><button disabled={pageColumn + 20 > 16384} onClick={() => setPageColumn(pageColumn + 20)}>右 20 列</button></div>
  </div>;
}
