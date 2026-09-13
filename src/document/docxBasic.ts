import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCUMENT_XML = "word/document.xml";

export interface DocxRun {
  id: string;
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontSize: number | null;
  color: string | null;
  fontFamily: string | null;
}

export interface DocxParagraph {
  id: string;
  runs: DocxRun[];
  /** Explicitly protected paragraphs are kept byte-for-byte during save. */
  protectedContent?: boolean;
  /** The paragraph contains drawings/images but its text runs remain editable. */
  hasDrawing?: boolean;
  /** Index in the original body; absent only for a paragraph created in the editor. */
  sourceIndex?: number;
  /** Original paragraph index after which a new paragraph should be inserted. */
  insertAfterSourceIndex?: number;
  /** Stable order for multiple new paragraphs anchored at the same source paragraph. */
  insertOrder?: number;
}

export interface DocxTableCell {
  id: string;
  text: string;
  gridStart: number;
  gridSpan: number;
  verticalMerge: "none" | "restart" | "continue";
  rowSpan: number;
}

export interface DocxTable {
  id: string;
  gridWidthsTwips: number[];
  widthTwips: number | null;
  rows: DocxTableCell[][];
}

export interface DocxInsertedImage {
  id: string;
  name: string;
  mimeType: string;
  entryName: string;
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  xPx: number;
  yPx: number;
}

export interface DocxBasicDocument {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  warnings: string[];
  entries: Record<string, Uint8Array>;
  documentXml: string;
  insertedImages: DocxInsertedImage[];
}

function normalizeBytes(bytes: Uint8Array): Uint8Array {
  // Tauri/WebView and jsdom can provide a Uint8Array from another realm.
  // Copy byte-by-byte using the constructor owned by fflate so its ZIP
  // directory walker does not mistake a cross-realm byte array for a folder.
  const FflateBytes = strToU8("\0", true).constructor as typeof Uint8Array;
  const normalized = new FflateBytes(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) normalized[index] = bytes[index];
  return normalized;
}

function parseDocxBytes(bytes: Uint8Array): DocxBasicDocument {
  const entries = unzipSync(normalizeBytes(bytes));
  const xmlBytes = entries[DOCUMENT_XML];
  if (!xmlBytes) throw new Error("DOCX 缺少 word/document.xml");
  const documentXml = strFromU8(xmlBytes);
  const parsed = new DOMParser().parseFromString(documentXml, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("DOCX 主文档 XML 无法读取");
  const paragraphs = editableParagraphs(parsed).map((paragraph, paragraphIndex) => {
    const id = `p-${paragraphIndex}`;
    const runs = textRunElements(paragraph).map((run, runIndex) => parseRun(run, `${id}-r-${runIndex}`));
    return {
      id,
      runs: runs.length ? runs : [{ ...emptyRun(`${id}-r-0`) }],
      hasDrawing: elements(paragraph, "drawing").length > 0 || elements(paragraph, "pict").length > 0,
      sourceIndex: paragraphIndex,
    };
  });
  const tables = topLevelTables(parsed).map((table, tableIndex) => ({
    id: `table-${tableIndex}`,
    gridWidthsTwips: directElements(directElements(table, "tblGrid")[0] ?? table, "gridCol").map((column) => parseTwips(column.getAttribute("w:w") ?? column.getAttributeNS(WORD_NS, "w") ?? "")),
    widthTwips: parseTableWidth(directElements(directElements(table, "tblPr")[0] ?? table, "tblW")[0]),
    rows: directElements(table, "tr").map((row, rowIndex) => directElements(row, "tc").map((cell, cellIndex) => ({
      id: `table-${tableIndex}-row-${rowIndex}-cell-${cellIndex}`,
      text: directElements(cell, "p").map((paragraph) => elements(paragraph, "t").map((text) => text.textContent ?? "").join("")).join("\n"),
      gridStart: 0,
      gridSpan: parseGridSpan(cell),
      verticalMerge: parseVerticalMerge(cell),
      rowSpan: 1,
    }))),
  })).map(resolveTableLayout);
  const warnings: string[] = [];
  if (tables.length > 0) warnings.push("表格单元格支持修改文字；不支持插入表格、增删行列或调整表格结构");
  if (elements(parsed, "drawing").length > 0 || elements(parsed, "pict").length > 0) warnings.push("图片和图形保留原样，不支持在此处编辑");
  if (Object.keys(entries).some((name) => /^word\/(header|footer)\d+\.xml$/.test(name))) warnings.push("页眉页脚保留原样，不支持在此处编辑");
  return { paragraphs, tables, warnings, entries, documentXml, insertedImages: [] };
}

function parseTwips(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function parseTableWidth(element: Element | undefined): number | null {
  if (!element) return null;
  const value = element.getAttribute("w:w") ?? element.getAttributeNS(WORD_NS, "w") ?? "";
  const width = parseTwips(value);
  return width > 0 ? width : null;
}

function parseGridSpan(cell: Element): number {
  const properties = directElements(cell, "tcPr")[0];
  const span = directElements(properties ?? cell, "gridSpan")[0];
  const value = span?.getAttribute("w:val") ?? span?.getAttributeNS(WORD_NS, "val") ?? "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 1;
}

function parseVerticalMerge(cell: Element): DocxTableCell["verticalMerge"] {
  const properties = directElements(cell, "tcPr")[0];
  const merge = directElements(properties ?? cell, "vMerge")[0];
  if (!merge) return "none";
  const value = merge.getAttribute("w:val") ?? merge.getAttributeNS(WORD_NS, "val");
  return value === "restart" ? "restart" : "continue";
}

function resolveTableLayout(table: DocxTable): DocxTable {
  let nextGridStart = 0;
  const rows = table.rows.map((row) => {
    let gridStart = 0;
    const next = row.map((cell) => {
      const resolved = { ...cell, gridStart: gridStart };
      gridStart += resolved.gridSpan;
      return resolved;
    });
    nextGridStart = Math.max(nextGridStart, gridStart);
    return next;
  });
  const rowSpanRows = rows.map((row, rowIndex) => row.map((cell) => {
    if (cell.verticalMerge !== "restart") return cell;
    let rowSpan = 1;
    for (let nextRowIndex = rowIndex + 1; nextRowIndex < rows.length; nextRowIndex += 1) {
      const continuation = rows[nextRowIndex].find((candidate) => candidate.gridStart === cell.gridStart && candidate.verticalMerge === "continue");
      if (!continuation) break;
      rowSpan += 1;
    }
    return { ...cell, rowSpan };
  }));
  const gridWidthsTwips = table.gridWidthsTwips.length ? table.gridWidthsTwips : Array.from({ length: nextGridStart }, () => 1);
  return { ...table, gridWidthsTwips, rows: rowSpanRows };
}

function emptyRun(id: string): DocxRun {
  return { id, text: "", bold: false, italic: false, underline: false, fontSize: null, color: null, fontFamily: null };
}

function fromBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/\s/g, "");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("DOCX 二进制内容不是有效的 Base64 数据");
  }
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
  let offset = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index]);
    const b = alphabet.indexOf(clean[index + 1]);
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2]);
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("DOCX 二进制内容不是有效的 Base64 数据");
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < bytes.length) bytes[offset++] = (chunk >> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (chunk >> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = chunk & 255;
  }
  return bytes;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}

function elements(parent: ParentNode, localName: string): Element[] {
  const namespaceParent = parent as Document | Element;
  return Array.from(namespaceParent.getElementsByTagNameNS(WORD_NS, localName));
}

function directElements(parent: ParentNode, localName: string): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === localName && (node as Element).namespaceURI === WORD_NS);
}

function first(parent: ParentNode, localName: string): Element | null {
  return elements(parent, localName)[0] ?? null;
}

function hasProperty(runProperties: Element | null, localName: string): boolean {
  return Boolean(runProperties && first(runProperties, localName));
}

function propertyValue(runProperties: Element | null, localName: string, attribute = "val"): string | null {
  if (!runProperties) return null;
  const property = first(runProperties, localName);
  return property?.getAttributeNS(WORD_NS, attribute) ?? property?.getAttribute(attribute) ?? null;
}

function isInsideTable(element: Element): boolean {
  let current: Element | null = element.parentElement;
  while (current) {
    if (current.localName === "tbl" && current.namespaceURI === WORD_NS) return true;
    current = current.parentElement;
  }
  return false;
}

function topLevelTables(documentXml: Document): Element[] {
  return elements(documentXml, "tbl").filter((table) => !isInsideTable(table));
}

function editableParagraphs(documentXml: Document): Element[] {
  const body = first(documentXml, "body");
  if (!body) return [];
  return elements(body, "p").filter((paragraph) => !isInsideTable(paragraph));
}

function textRunElements(paragraph: Element): Element[] {
  return elements(paragraph, "r").filter((run) => elements(run, "t").length > 0 || elements(run, "delText").length > 0 || elements(run, "instrText").length > 0);
}

function parseRun(run: Element, id: string): DocxRun {
  const properties = first(run, "rPr");
  const size = propertyValue(properties, "sz");
  const color = propertyValue(properties, "color");
  const fonts = properties ? first(properties, "rFonts") : null;
  return {
    id,
    text: elements(run, "t").map((text) => text.textContent ?? "").join(""),
    bold: hasProperty(properties, "b"),
    italic: hasProperty(properties, "i"),
    underline: hasProperty(properties, "u"),
    fontSize: size && /^\d+$/.test(size) ? Number(size) / 2 : null,
    color: color && color.toLowerCase() !== "auto" ? `#${color.replace(/^#/, "").toLowerCase()}` : null,
    fontFamily: fonts?.getAttribute("ascii") ?? fonts?.getAttributeNS(WORD_NS, "ascii") ?? null,
  };
}

export function parseDocxBasic(binaryContent: string): DocxBasicDocument {
  return parseDocxBytes(fromBase64(binaryContent));
}

export { parseDocxBytes };

function setAttribute(element: Element, name: string, value: string): void {
  element.setAttributeNS(WORD_NS, `w:${name}`, value);
}

function ensureProperties(run: Element): Element {
  const current = first(run, "rPr");
  if (current) return current;
  const properties = run.ownerDocument!.createElementNS(WORD_NS, "w:rPr");
  run.insertBefore(properties, run.firstChild);
  return properties;
}

function setToggle(properties: Element, localName: string, enabled: boolean): void {
  const current = first(properties, localName);
  if (enabled && !current) {
    const created = properties.ownerDocument!.createElementNS(WORD_NS, `w:${localName}`);
    if (localName === "u") setAttribute(created, "val", "single");
    properties.appendChild(created);
  }
  if (!enabled && current) current.remove();
}

function setValue(properties: Element, localName: string, value: string | null): void {
  const current = first(properties, localName);
  if (!value) {
    current?.remove();
    return;
  }
  const target = current ?? properties.ownerDocument!.createElementNS(WORD_NS, `w:${localName}`);
  setAttribute(target, "val", value);
  if (!current) properties.appendChild(target);
}

function applyRun(documentXml: Document, runElement: Element, run: DocxRun): void {
  const textNodes = elements(runElement, "t");
  const textNode = textNodes[0] ?? runElement.ownerDocument!.createElementNS(WORD_NS, "w:t");
  if (!textNodes.length) {
    const firstNonProperty = Array.from(runElement.children).find((child) => child.localName !== "rPr");
    runElement.appendChild(textNode);
    if (firstNonProperty) runElement.insertBefore(textNode, firstNonProperty);
  }
  textNode.textContent = run.text;
  setAttribute(textNode, "space", "preserve");
  for (const extra of textNodes.slice(1)) extra.textContent = "";
  const properties = ensureProperties(runElement);
  setToggle(properties, "b", run.bold);
  setToggle(properties, "i", run.italic);
  setToggle(properties, "u", run.underline);
  setValue(properties, "sz", run.fontSize === null ? null : String(Math.max(1, Math.round(run.fontSize * 2))));
  setValue(properties, "color", run.color ? run.color.replace(/^#/, "").toUpperCase() : null);
  if (run.fontFamily) {
    const fonts = first(properties, "rFonts") ?? runElement.ownerDocument!.createElementNS(WORD_NS, "w:rFonts");
    for (const name of ["ascii", "hAnsi", "eastAsia", "cs"]) setAttribute(fonts, name, run.fontFamily);
    if (!fonts.parentElement) properties.insertBefore(fonts, properties.firstChild);
  } else {
    first(properties, "rFonts")?.remove();
  }
}

function applyTableCell(cellElement: Element, text: string): void {
  const paragraphs = directElements(cellElement, "p");
  if (!paragraphs.length) return;
  const lines = text.split("\n");
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const textNodes = elements(paragraph, "t");
    const textNode = textNodes[0] ?? (() => {
      const run = directElements(paragraph, "r")[0] ?? paragraph.ownerDocument!.createElementNS(WORD_NS, "w:r");
      if (!run.parentElement) paragraph.appendChild(run);
      const created = paragraph.ownerDocument!.createElementNS(WORD_NS, "w:t");
      run.appendChild(created);
      return created;
    })();
    textNode.textContent = lines[paragraphIndex] ?? "";
    setAttribute(textNode, "space", "preserve");
    textNodes.slice(1).forEach((node) => { node.textContent = ""; });
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function imageParagraphXml(image: DocxInsertedImage, relationId: string, drawingId: number): string {
  const width = Math.max(32, Math.round(image.widthPx * 9525));
  const height = Math.max(32, Math.round(image.heightPx * 9525));
  const x = Math.max(0, Math.round(image.xPx * 9525));
  const y = Math.max(0, Math.round(image.yPx * 9525));
  const name = xmlEscape(`moji-image:${image.id}:${image.name}`);
  return `<w:p xmlns:w="${WORD_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${drawingId}" name="${name}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
}

function relationshipEntry(source: DocxBasicDocument, images: DocxInsertedImage[]): { name: string; bytes: Uint8Array; ids: Map<string, string> } {
  const name = "word/_rels/document.xml.rels";
  const original = source.entries[name] ? strFromU8(source.entries[name]) : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"></Relationships>`;
  const parsed = new DOMParser().parseFromString(original, "application/xml");
  const root = parsed.documentElement;
  const existing = new Set(Array.from(root.children).map((child) => child.getAttribute("Id") ?? ""));
  const ids = new Map<string, string>();
  let nextId = 1;
  images.forEach((image) => {
    let id = `rIdMoji${nextId}`;
    while (existing.has(id)) id = `rIdMoji${++nextId}`;
    existing.add(id);
    ids.set(image.id, id);
    const relation = parsed.createElementNS(root.namespaceURI, "Relationship");
    relation.setAttribute("Id", id);
    relation.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
    relation.setAttribute("Target", image.entryName.replace(/^word\//, ""));
    root.appendChild(relation);
    nextId += 1;
  });
  return { name, bytes: strToU8(new XMLSerializer().serializeToString(parsed)), ids };
}

function contentTypesEntry(source: DocxBasicDocument, images: DocxInsertedImage[]): { name: string; bytes: Uint8Array } {
  const name = "[Content_Types].xml";
  const original = source.entries[name] ? strFromU8(source.entries[name]) : `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;
  const parsed = new DOMParser().parseFromString(original, "application/xml");
  const root = parsed.documentElement;
  const defaults = new Set(Array.from(root.children).filter((child) => child.localName === "Default").map((child) => `${child.getAttribute("Extension")}:${child.getAttribute("ContentType")}`));
  images.forEach((image) => {
    const extension = imageExtension(image.mimeType);
    const contentType = image.mimeType || "image/png";
    const key = `${extension}:${contentType}`;
    if (defaults.has(key)) return;
    const target = parsed.createElementNS(root.namespaceURI, "Default");
    target.setAttribute("Extension", extension);
    target.setAttribute("ContentType", contentType);
    root.appendChild(target);
    defaults.add(key);
  });
  return { name, bytes: strToU8(new XMLSerializer().serializeToString(parsed)) };
}

export function addDocxImage(source: DocxBasicDocument, image: Omit<DocxInsertedImage, "entryName">): DocxBasicDocument {
  const extension = imageExtension(image.mimeType);
  const entryName = `word/media/moji-${image.id}.${extension}`;
  return { ...source, entries: { ...source.entries, [entryName]: normalizeBytes(image.bytes) }, insertedImages: [...source.insertedImages, { ...image, entryName }] };
}

export function updateDocxImage(source: DocxBasicDocument, imageId: string, patch: Partial<Pick<DocxInsertedImage, "widthPx" | "heightPx" | "xPx" | "yPx">>): DocxBasicDocument {
  return { ...source, insertedImages: source.insertedImages.map((image) => image.id === imageId ? { ...image, ...patch } : image) };
}

export function serializeDocxBasic(source: DocxBasicDocument, paragraphs: DocxParagraph[], tables: DocxTable[] = source.tables, imageRelationIds: Map<string, string> = new Map()): string {
  const parsed = new DOMParser().parseFromString(source.documentXml, "application/xml");
  const nodes = editableParagraphs(parsed);
  const editsBySourceIndex = new Map(
    paragraphs
      .filter((paragraph) => paragraph.sourceIndex !== undefined)
      .map((paragraph) => [paragraph.sourceIndex!, paragraph]),
  );

  const createParagraphElement = (paragraph: DocxParagraph): Element => {
    const paragraphElement = parsed.createElementNS(WORD_NS, "w:p");
    paragraph.runs.forEach((run) => {
      const runElement = parsed.createElementNS(WORD_NS, "w:r");
      paragraphElement.appendChild(runElement);
      applyRun(parsed, runElement, run);
    });
    return paragraphElement;
  };
  const anchoredNewParagraphs = new Map<number, DocxParagraph[]>();
  const unanchoredNewParagraphs: DocxParagraph[] = [];
  paragraphs.filter((paragraph) => paragraph.sourceIndex === undefined).forEach((paragraph) => {
    if (paragraph.insertAfterSourceIndex === undefined) {
      unanchoredNewParagraphs.push(paragraph);
      return;
    }
    const current = anchoredNewParagraphs.get(paragraph.insertAfterSourceIndex) ?? [];
    current.push(paragraph);
    anchoredNewParagraphs.set(paragraph.insertAfterSourceIndex, current);
  });
  anchoredNewParagraphs.forEach((items) => items.sort((left, right) => (left.insertOrder ?? 0) - (right.insertOrder ?? 0)));

  nodes.forEach((paragraphElement, paragraphIndex) => {
    const original = source.paragraphs[paragraphIndex];
    const paragraph = editsBySourceIndex.get(paragraphIndex);
    // Drawing/shape paragraphs stay byte-for-byte XML equivalent: even an
    // empty text run must not receive a generated <w:t> during save.
    if (original?.protectedContent) return;
    if (!paragraph) {
      paragraphElement.remove();
      return;
    }
    // Reconcile only text-bearing runs. Drawings, fields, and other non-text
    // runs stay in their original XML position while nearby text is edited.
    const runs = textRunElements(paragraphElement);
    paragraph.runs.forEach((run, runIndex) => {
      const target = runs[runIndex] ?? parsed.createElementNS(WORD_NS, "w:r");
      if (!target.parentElement) paragraphElement.appendChild(target);
      applyRun(parsed, target, run);
    });
    for (let index = paragraph.runs.length; index < runs.length; index += 1) {
      const empty = parseRun(runs[index], `empty-${index}`);
      applyRun(parsed, runs[index], { ...empty, text: "" });
    }
    const insertBefore = nodes[paragraphIndex + 1] ?? first(parsed, "sectPr");
    anchoredNewParagraphs.get(paragraphIndex)?.forEach((newParagraph) => {
      const created = createParagraphElement(newParagraph);
      if (insertBefore?.parentNode) insertBefore.parentNode.insertBefore(created, insertBefore);
      else paragraphElement.parentNode?.appendChild(created);
    });
  });

  const tableElements = topLevelTables(parsed);
  tables.forEach((table, tableIndex) => {
    const tableElement = tableElements[tableIndex];
    if (!tableElement) return;
    const rows = directElements(tableElement, "tr");
    table.rows.forEach((row, rowIndex) => {
      const cells = directElements(rows[rowIndex] ?? tableElement, "tc");
      row.forEach((cell, cellIndex) => {
        if (cells[cellIndex]) applyTableCell(cells[cellIndex], cell.text);
      });
    });
  });

  const body = first(parsed, "body");
  if (body) {
    // A document can contain paragraph-level section breaks. Only the
    // section properties directly owned by w:body are a valid insertion
    // anchor; using a descendant sectPr causes DOM insertBefore to throw.
    const section = directElements(body, "sectPr")[0] ?? null;
    unanchoredNewParagraphs.forEach((paragraph) => {
      const paragraphElement = createParagraphElement(paragraph);
      if (section) body.insertBefore(paragraphElement, section);
      else body.appendChild(paragraphElement);
    });
    source.insertedImages.forEach((image, imageIndex) => {
      const fragment = new DOMParser().parseFromString(imageParagraphXml(image, imageRelationIds.get(image.id) ?? `rIdMoji${imageIndex + 1}`, 10_000 + imageIndex), "application/xml");
      const imageParagraph = fragment.documentElement;
      // Keep inserted images in document flow after the existing body
      // content. Inserting them before the first paragraph makes a page-sized
      // anchor cover the title/body in docx-preview even though the XML is
      // technically valid.
      if (section?.parentNode === body) body.insertBefore(parsed.importNode(imageParagraph, true), section);
      else body.appendChild(parsed.importNode(imageParagraph, true));
    });
  }
  return new XMLSerializer().serializeToString(parsed);
}

export function encodeDocxBasic(source: DocxBasicDocument, paragraphs: DocxParagraph[], tables: DocxTable[] = source.tables): string {
  const entries = Object.fromEntries(Object.entries(source.entries).map(([name, bytes]) => [name, normalizeBytes(bytes)]));
  const images = source.insertedImages;
  if (images.length) {
    const relationships = relationshipEntry(source, images);
    entries[DOCUMENT_XML] = normalizeBytes(strToU8(serializeDocxBasic(source, paragraphs, tables, relationships.ids)));
    entries[relationships.name] = normalizeBytes(relationships.bytes);
    const types = contentTypesEntry(source, images);
    entries[types.name] = normalizeBytes(types.bytes);
    images.forEach((image) => { entries[image.entryName] = normalizeBytes(image.bytes); });
  } else {
    entries[DOCUMENT_XML] = normalizeBytes(strToU8(serializeDocxBasic(source, paragraphs, tables)));
  }
  // Keep the archive input flat: fflate treats non-byte objects as folders.
  for (const [name, bytes] of Object.entries(entries)) {
    if (!(bytes instanceof Uint8Array)) throw new Error(`DOCX entry is not bytes: ${name}`);
  }
  return toBase64(zipSync(entries, { level: 6 }));
}
