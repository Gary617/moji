import { FileWarning } from "lucide-react";
import { SpreadsheetGrid } from "./spreadsheet/SpreadsheetGrid";
import { strFromU8, unzipSync } from "fflate";
import { useEffect, useState, type CSSProperties } from "react";
import type { DocumentFormat } from "../ipc/library";

interface OfficePreviewProps {
  binaryContent: string | null;
  format: Extract<DocumentFormat, "pptx" | "xlsx">;
  name: string;
  editable?: boolean;
  onArtifact?(value: string | null): void;
  aiChanges?: Array<{ sheet: string; address: string }>;
  onClearAiChanges?(): void;
}

type PptxRect = { x: number; y: number; width: number; height: number };
type PptxRun = {
  text: string;
  fontSize: number;
  color: string | null;
  fontFamily: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
};
type PptxVisual = PptxRect & { rotation: number; zIndex?: number };
type PptxTextElement = PptxVisual & {
  kind: "text";
  text: string;
  runs: PptxRun[];
  fontSize: number;
  color: string | null;
  fontFamily: string | null;
  bold: boolean;
  italic: boolean;
  align: string | null;
};
type PptxImageElement = PptxVisual & { kind: "image"; src: string; alt: string; crop: { left: number; top: number; right: number; bottom: number } | null };
type PptxShapeElement = PptxVisual & { kind: "shape"; fill: string | null; line: string | null; lineWidth: number | null };
type PptxTableElement = PptxVisual & { kind: "table"; rows: string[][] };
type PptxChartElement = PptxVisual & { kind: "chart"; title: string; values: number[] };
type PptxElement = PptxTextElement | PptxImageElement | PptxShapeElement | PptxTableElement | PptxChartElement;
type Slide = { width: number; height: number; elements: PptxElement[]; title: string; paragraphs: string[]; imageCount: number; background: string | null; backgroundImage: string | null };
type Sheet = { name: string; rows: string[][] };

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DEFAULT_SLIDE_WIDTH = 12192000;
const DEFAULT_SLIDE_HEIGHT = 6858000;
const PRESET_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080",
  orange: "#ffa500", purple: "#800080", transparent: "transparent",
};

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return window.btoa(binary);
}

function xmlEntry(entries: Record<string, Uint8Array>, name: string): Document | null {
  const bytes = entries[name];
  if (!bytes) return null;
  const xml = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  return xml.querySelector("parsererror") ? null : xml;
}

function resolveZipTarget(baseDirectory: string, target: string): string {
  const source = target.startsWith("/") ? target.slice(1) : `${baseDirectory}/${target}`;
  const parts = source.replace(/^\/+/, "").split("/");
  const resolved: string[] = [];
  parts.forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  });
  return resolved.join("/");
}

function local(element: Document | Element | null, name: string): Element[] {
  return element ? Array.from(element.getElementsByTagNameNS("*", name)) : [];
}

function directChildren(element: Document | Element | null): Element[] {
  if (!element) return [];
  return Array.from(element instanceof Document ? element.documentElement?.children ?? [] : element.children);
}

function firstDirect(element: Document | Element | null, name: string): Element | null {
  return element ? directChildren(element).find((child) => child.localName === name) ?? null : null;
}

function firstLocal(element: Document | Element | null, name: string): Element | null {
  return local(element, name)[0] ?? null;
}

function attrNumber(element: Element | null, name: string): number {
  const value = Number(element?.getAttribute(name) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isHidden(element: Element): boolean {
  const metadata = firstLocal(element, "cNvPr");
  const value = metadata?.getAttribute("hidden");
  return value === "1" || value === "true";
}

function transformNode(element: Element, group = false): Element | null {
  if (group) return firstDirect(firstDirect(element, "grpSpPr"), "xfrm") ?? firstLocal(element, "xfrm");
  const properties = firstDirect(element, "spPr") ?? firstDirect(element, "picSpPr") ?? element;
  return firstDirect(properties, "xfrm") ?? firstLocal(properties, "xfrm") ?? firstLocal(element, "xfrm");
}

function shapeRect(element: Element): PptxRect {
  const transform = transformNode(element);
  const offset = firstDirect(transform, "off");
  const extent = firstDirect(transform, "ext");
  return {
    x: attrNumber(offset, "x"),
    y: attrNumber(offset, "y"),
    width: Math.max(1, attrNumber(extent, "cx")),
    height: Math.max(1, attrNumber(extent, "cy")),
  };
}

function rotationOf(element: Element): number {
  return attrNumber(transformNode(element), "rot") / 60000;
}

type GroupTransform = { x: number; y: number; width: number; height: number; childX: number; childY: number; childWidth: number; childHeight: number };

function groupTransform(element: Element): GroupTransform {
  const transform = transformNode(element, true);
  const offset = firstDirect(transform, "off");
  const extent = firstDirect(transform, "ext");
  const childOffset = firstDirect(transform, "chOff");
  const childExtent = firstDirect(transform, "chExt");
  return {
    x: attrNumber(offset, "x"),
    y: attrNumber(offset, "y"),
    width: attrNumber(extent, "cx") || 1,
    height: attrNumber(extent, "cy") || 1,
    childX: attrNumber(childOffset, "x"),
    childY: attrNumber(childOffset, "y"),
    childWidth: attrNumber(childExtent, "cx") || attrNumber(extent, "cx") || 1,
    childHeight: attrNumber(childExtent, "cy") || attrNumber(extent, "cy") || 1,
  };
}

function applyGroup(rect: PptxRect, group: GroupTransform): PptxRect {
  const scaleX = group.width / group.childWidth;
  const scaleY = group.height / group.childHeight;
  return {
    x: group.x + (rect.x - group.childX) * scaleX,
    y: group.y + (rect.y - group.childY) * scaleY,
    width: Math.max(1, rect.width * scaleX),
    height: Math.max(1, rect.height * scaleY),
  };
}

function slideRect(rect: PptxRect, groups: GroupTransform[]): PptxRect {
  return groups.reduceRight((value, group) => applyGroup(value, group), rect);
}

function parseThemeColors(entries: Record<string, Uint8Array>): Map<string, string> {
  const theme = xmlEntry(entries, "ppt/theme/theme1.xml");
  const colors = new Map<string, string>();
  if (!theme) return colors;
  const scheme = firstLocal(theme, "clrScheme");
  directChildren(scheme ?? theme).forEach((role) => {
    const value = firstDirect(role, "srgbClr")?.getAttribute("val") ?? firstDirect(role, "sysClr")?.getAttribute("lastClr");
    if (value) colors.set(role.localName, `#${value}`);
  });
  const aliases: Record<string, string> = { tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" };
  Object.entries(aliases).forEach(([alias, source]) => {
    const value = colors.get(source);
    if (value) colors.set(alias, value);
  });
  return colors;
}

function hexToRgb(value: string): [number, number, number] | null {
  const normalized = value.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return [Number.parseInt(normalized.slice(0, 2), 16), Number.parseInt(normalized.slice(2, 4), 16), Number.parseInt(normalized.slice(4, 6), 16)];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((part) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, "0")).join("")}`;
}

function applyColorModifiers(value: string, element: Element): string {
  const rgb = hexToRgb(value);
  if (!rgb) return value;
  const modified = [...rgb] as [number, number, number];
  const lumMod = firstLocal(element, "lumMod");
  if (lumMod) { const factor = attrNumber(lumMod, "val") / 100000; modified[0] *= factor; modified[1] *= factor; modified[2] *= factor; }
  const lumOff = firstLocal(element, "lumOff");
  if (lumOff) { const amount = 255 * attrNumber(lumOff, "val") / 100000; modified[0] += amount; modified[1] += amount; modified[2] += amount; }
  const shade = firstLocal(element, "shade");
  if (shade) { const factor = attrNumber(shade, "val") / 100000; modified[0] *= factor; modified[1] *= factor; modified[2] *= factor; }
  const tint = firstLocal(element, "tint");
  if (tint) { const factor = attrNumber(tint, "val") / 100000; modified[0] += (255 - modified[0]) * factor; modified[1] += (255 - modified[1]) * factor; modified[2] += (255 - modified[2]) * factor; }
  return rgbToHex(modified);
}

function colorOf(element: Element | null, theme: Map<string, string> = new Map()): string | null {
  if (!element) return null;
  const colorNode = [element, firstLocal(element, "srgbClr"), firstLocal(element, "scrgbClr"), firstLocal(element, "schemeClr"), firstLocal(element, "prstClr"), firstLocal(element, "sysClr")].find((item) => item?.localName?.endsWith("Clr")) ?? null;
  if (!colorNode) return null;
  const value = colorNode.localName === "srgbClr" || colorNode.localName === "scrgbClr" ? colorNode.getAttribute("val") : colorNode.localName === "schemeClr" ? theme.get(colorNode.getAttribute("val") ?? "") : colorNode.localName === "sysClr" ? colorNode.getAttribute("lastClr") : PRESET_COLORS[colorNode.getAttribute("val") ?? ""]?.replace("#", "");
  if (!value) return null;
  const resolved = applyColorModifiers(value.startsWith("#") ? value : `#${value}`, colorNode);
  const alpha = firstLocal(colorNode, "alpha");
  if (!alpha) return resolved;
  const opacity = Math.max(0, Math.min(1, attrNumber(alpha, "val") / 100000));
  const rgb = hexToRgb(resolved);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})` : resolved;
}

function fillColorOf(element: Element, theme: Map<string, string>): string | null {
  if (firstLocal(element, "noFill")) return null;
  const solid = colorOf(firstDirect(element, "solidFill") ?? firstLocal(element, "solidFill"), theme);
  if (solid) return solid;
  const gradient = firstDirect(element, "gradFill") ?? firstLocal(element, "gradFill");
  if (gradient) {
    const stops = local(gradient, "gs").map((stop) => colorOf(stop, theme)).filter(Boolean) as string[];
    const angle = attrNumber(firstLocal(gradient, "lin"), "ang") / 60000;
    if (stops.length > 1) return `linear-gradient(${Number.isFinite(angle) && angle > 0 ? angle : 135}deg, ${stops[0]}, ${stops[stops.length - 1]})`;
    if (stops.length === 1) return stops[0];
  }
  return colorOf(firstLocal(element, "fillRef"), theme);
}

function lineColorOf(element: Element, theme: Map<string, string>): string | null {
  const line = firstDirect(element, "ln") ?? firstLocal(element, "ln");
  if (!line || firstLocal(line, "noFill")) return null;
  return colorOf(firstDirect(line, "solidFill") ?? firstLocal(line, "solidFill"), theme);
}

function lineWidthOf(element: Element): number | null {
  const width = attrNumber(firstDirect(element, "ln") ?? firstLocal(element, "ln"), "w");
  return width > 0 ? width : null;
}

function textContentOf(element: Document | Element): string {
  return local(element, "t").map((item) => item.textContent ?? "").join("");
}

function textOf(element: Document | Element): string {
  return textContentOf(element).trim();
}

function fontFamilyOf(style: Element | null): string | null {
  if (!style) return null;
  return firstDirect(style, "ea")?.getAttribute("typeface") ?? firstDirect(style, "latin")?.getAttribute("typeface") ?? firstDirect(style, "cs")?.getAttribute("typeface") ?? null;
}

function textRunStyle(style: Element | null, theme: Map<string, string>, fallback: Partial<PptxRun> = {}): PptxRun {
  return {
    text: "",
    fontSize: attrNumber(style, "sz") / 100 || fallback.fontSize || 18,
    color: colorOf(style, theme) ?? fallback.color ?? null,
    fontFamily: fontFamilyOf(style) ?? fallback.fontFamily ?? null,
    bold: style?.getAttribute("b") === "1" || fallback.bold === true,
    italic: style?.getAttribute("i") === "1" || fallback.italic === true,
    underline: Boolean(style?.getAttribute("u") && style.getAttribute("u") !== "none") || fallback.underline === true,
  };
}

function parseText(element: Element, theme: Map<string, string>): Omit<PptxTextElement, "x" | "y" | "width" | "height" | "kind" | "rotation"> | null {
  const body = firstDirect(element, "txBody") ?? firstLocal(element, "txBody");
  if (!body) return null;
  const defaultStyle = textRunStyle(firstLocal(body, "defRPr"), theme, { fontSize: 18 });
  const paragraphs = directChildren(body).filter((child) => child.localName === "p");
  const runs: PptxRun[] = [];
  let paragraphAlign: string | null = null;
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphProperties = firstDirect(paragraph, "pPr");
    paragraphAlign = paragraphProperties?.getAttribute("algn") ?? paragraphAlign;
    const paragraphDefault = firstDirect(paragraphProperties, "defRPr");
    const fallback = paragraphDefault ? textRunStyle(paragraphDefault, theme, defaultStyle) : defaultStyle;
    directChildren(paragraph).forEach((child) => {
      if (child.localName === "br") runs.push({ ...fallback, text: "\n" });
      else if (child.localName === "r" || child.localName === "fld") {
        const style = firstDirect(child, "rPr") ?? firstDirect(child, "endParaRPr");
        runs.push({ ...textRunStyle(style, theme, fallback), text: textContentOf(child) });
      }
    });
    if (paragraphIndex < paragraphs.length - 1) runs.push({ ...fallback, text: "\n" });
  });
  const text = runs.map((run) => run.text).join("");
  if (!text.trim()) return null;
  const firstRun = runs.find((run) => run.text.trim()) ?? defaultStyle;
  return { text, runs, fontSize: firstRun.fontSize, color: firstRun.color, fontFamily: firstRun.fontFamily, bold: firstRun.bold, italic: firstRun.italic, align: paragraphAlign };
}

// SmartArt and a few third-party generators put text directly in a graphic
// frame instead of exposing a normal txBody. Preserve that text in a readable
// fallback box instead of dropping the entire object.
function parseLooseText(element: Element, theme: Map<string, string>): Omit<PptxTextElement, "x" | "y" | "width" | "height" | "kind" | "rotation"> | null {
  const paragraphs = local(element, "p");
  const text = paragraphs.length
    ? paragraphs.map((paragraph) => local(paragraph, "t").map((item) => item.textContent ?? "").join("")).join("\n")
    : local(element, "t").map((item) => item.textContent ?? "").join("");
  if (!text.trim()) return null;
  const firstRunStyle = firstLocal(element, "rPr") ?? firstLocal(element, "defRPr");
  const fallback = textRunStyle(firstRunStyle, theme, { fontSize: 18 });
  return { text, runs: [{ ...fallback, text }], fontSize: fallback.fontSize, color: fallback.color, fontFamily: fallback.fontFamily, bold: fallback.bold, italic: fallback.italic, align: null };
}

function parseDiagramText(entries: Record<string, Uint8Array>, relations: Map<string, string>, element: Element, theme: Map<string, string>): Omit<PptxTextElement, "x" | "y" | "width" | "height" | "kind" | "rotation"> | null {
  const relIds = firstLocal(element, "relIds");
  const relationId = relIds?.getAttribute("r:dm") ?? relIds?.getAttributeNS(REL_NS, "dm") ?? "";
  const diagramPath = relations.get(relationId);
  const diagram = diagramPath ? xmlEntry(entries, diagramPath) : null;
  return diagram ? parseLooseText(diagram.documentElement ?? diagram, theme) : null;
}

function parseRelationships(entries: Record<string, Uint8Array>, documentPath: string): Map<string, string> {
  const directory = documentPath.slice(0, documentPath.lastIndexOf("/"));
  const filename = documentPath.slice(documentPath.lastIndexOf("/") + 1);
  const document = xmlEntry(entries, `${directory}/_rels/${filename}.rels`);
  const relations = new Map<string, string>();
  local(document, "Relationship").forEach((relation) => {
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    if (id && target) relations.set(id, resolveZipTarget(directory, target));
  });
  return relations;
}

function parseSlideRelationships(entries: Record<string, Uint8Array>, slidePath: string): Map<string, string> {
  return parseRelationships(entries, slidePath);
}

function parsePptxTable(element: Element): string[][] {
  return local(element, "tr").map((row) => local(row, "tc").map((cell) => textOf(cell)));
}

function imageSource(entries: Record<string, Uint8Array>, relations: Map<string, string>, element: Element, cache?: Map<string, string>): string | null {
  const relationId = firstLocal(element, "blip")?.getAttribute("r:embed") ?? firstLocal(element, "blip")?.getAttributeNS(REL_NS, "embed") ?? "";
  const mediaPath = relations.get(relationId);
  const media = mediaPath ? entries[mediaPath] : undefined;
  if (!media) return null;
  const cached = mediaPath ? cache?.get(mediaPath) : undefined;
  if (cached) return cached;
  const extension = mediaPath?.split(".").pop()?.toLowerCase() ?? "png";
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : extension === "svg" ? "image/svg+xml" : extension === "webp" ? "image/webp" : "image/png";
  const source = `data:${mime};base64,${toBase64(media)}`;
  if (mediaPath) cache?.set(mediaPath, source);
  return source;
}

function imageCrop(element: Element): PptxImageElement["crop"] {
  const source = firstLocal(element, "srcRect");
  if (!source) return null;
  return { left: attrNumber(source, "l") / 100000, top: attrNumber(source, "t") / 100000, right: attrNumber(source, "r") / 100000, bottom: attrNumber(source, "b") / 100000 };
}

function parseChart(entries: Record<string, Uint8Array>, chartPath: string | undefined): { title: string; values: number[] } | null {
  if (!chartPath) return null;
  const chart = xmlEntry(entries, chartPath);
  if (!chart) return null;
  const title = textOf(firstLocal(chart, "title") ?? chart) || "图表";
  const values = local(chart, "numVal").map((item) => Number(firstLocal(item, "v")?.textContent ?? "")).filter((value) => Number.isFinite(value));
  return { title, values: values.slice(0, 16) };
}

function slideBackground(slide: Document | null, relations: Map<string, string>, entries: Record<string, Uint8Array>, theme: Map<string, string>, imageCache?: Map<string, string>): { color: string | null; image: string | null } {
  const background = firstLocal(slide, "bg");
  if (!background) return { color: null, image: null };
  const properties = firstDirect(background, "bgPr") ?? background;
  const image = imageSource(entries, relations, firstDirect(properties, "blipFill") ?? properties, imageCache);
  return { color: fillColorOf(properties, theme), image };
}

function fallbackTextRect(width: number, height: number, index: number): PptxRect {
  return { x: width * 0.08, y: height * (0.08 + index * 0.14), width: width * 0.84, height: height * 0.18 };
}

export function parsePptx(bytes: Uint8Array): Slide[] {
  const entries = unzipSync(bytes);
  const presentation = xmlEntry(entries, "ppt/presentation.xml");
  const presentationRels = xmlEntry(entries, "ppt/_rels/presentation.xml.rels");
  const relMap = new Map<string, string>();
  local(presentationRels, "Relationship").forEach((relation) => {
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    if (id && target) relMap.set(id, resolveZipTarget("ppt", target));
  });
  const size = firstLocal(presentation, "sldSz");
  const width = attrNumber(size, "cx") || DEFAULT_SLIDE_WIDTH;
  const height = attrNumber(size, "cy") || DEFAULT_SLIDE_HEIGHT;
  const theme = parseThemeColors(entries);
  const slidePaths = presentation ? local(presentation, "sldId").map((item) => relMap.get(item.getAttribute("r:id") ?? item.getAttributeNS(REL_NS, "id") ?? "")) : [];
  const fallback = Object.keys(entries).filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const paths = (slidePaths.filter(Boolean) as string[]).concat(fallback.filter((path) => !slidePaths.includes(path)));
  const imageCache = new Map<string, string>();
  return paths.map((path, index) => {
    const slide = xmlEntry(entries, path);
    const relations = parseSlideRelationships(entries, path);
    const layoutPath = Array.from(relations.values()).find((target) => target.startsWith("ppt/slideLayouts/") && target.endsWith(".xml"));
    const layout = layoutPath ? xmlEntry(entries, layoutPath) : null;
    const layoutRelations = layoutPath ? parseRelationships(entries, layoutPath) : new Map<string, string>();
    const masterPath = Array.from(layoutRelations.values()).find((target) => target.startsWith("ppt/slideMasters/") && target.endsWith(".xml"));
    const master = masterPath ? xmlEntry(entries, masterPath) : null;
    const masterRelations = masterPath ? parseRelationships(entries, masterPath) : new Map<string, string>();
    const elements: PptxElement[] = [];
    let fallbackTextIndex = 0;
    let objectOrder = 0;
    const visit = (container: Element | null, groups: GroupTransform[], objectRelations: Map<string, string>, stackBase: number, skipPlaceholders = false): void => {
      if (!container) return;
      directChildren(container).forEach((shape) => {
        const kind = shape.localName;
        if (["nvGrpSpPr", "grpSpPr", "nvSpPr", "spPr", "nvPicPr", "picSpPr", "nvGraphicFramePr"].includes(kind) || isHidden(shape)) return;
        if (skipPlaceholders && (firstLocal(shape, "ph") || /单击此处编辑(?:母版|标题|文本)/.test(textOf(shape)))) return;
        if (kind === "grpSp") { visit(shape, [...groups, groupTransform(shape)], objectRelations, stackBase, skipPlaceholders); return; }
        const localRect = shapeRect(shape);
        const rect = slideRect(localRect, groups);
        const visual = { ...rect, rotation: rotationOf(shape), zIndex: stackBase + objectOrder++ };
        if (kind === "sp" || kind === "cxnSp") {
          const parsedText = parseText(shape, theme);
          if (parsedText) {
            const hasGeometry = localRect.width > 1 && localRect.height > 1;
            const textRect = hasGeometry ? rect : slideRect(fallbackTextRect(width, height, fallbackTextIndex), groups);
            if (!hasGeometry) fallbackTextIndex += 1;
            elements.push({ ...visual, ...textRect, kind: "text", ...parsedText });
          } else {
            const properties = firstDirect(shape, "spPr") ?? shape;
            const fill = fillColorOf(properties, theme);
            const line = lineColorOf(properties, theme);
            const lineWidth = lineWidthOf(properties);
            if (fill || line) elements.push({ ...visual, kind: "shape", fill, line, lineWidth });
          }
        } else if (kind === "pic") {
          const src = imageSource(entries, objectRelations, shape, imageCache);
          if (src) elements.push({ ...visual, kind: "image", src, crop: imageCrop(shape), alt: firstLocal(shape, "cNvPr")?.getAttribute("name") ?? `幻灯片图片 ${elements.filter((item) => item.kind === "image").length + 1}` });
        } else if (kind === "graphicFrame") {
          const table = firstLocal(shape, "tbl");
          if (table) elements.push({ ...visual, kind: "table", rows: parsePptxTable(table) });
          else {
            const chartRef = firstLocal(shape, "chart");
            const chartId = chartRef?.getAttribute("r:id") ?? chartRef?.getAttributeNS(REL_NS, "id") ?? "";
            const chart = parseChart(entries, objectRelations.get(chartId));
            const parsedText = parseText(shape, theme);
            if (chart) elements.push({ ...visual, kind: "chart", ...chart });
            else if (parsedText) elements.push({ ...visual, kind: "text", ...parsedText });
            else {
              const looseText = parseLooseText(shape, theme) ?? parseDiagramText(entries, objectRelations, shape, theme);
              if (looseText) elements.push({ ...visual, kind: "text", ...looseText });
            }
          }
        }
      });
    };
    // Static master/layout objects form the background layer. Their placeholders are
    // intentionally skipped because they are editing hints, not slide content.
    visit(firstLocal(master, "spTree"), [], masterRelations, 10, true);
    visit(firstLocal(layout, "spTree"), [], layoutRelations, 100, true);
    visit(firstLocal(slide, "spTree"), [], relations, 1000);
    const slideBg = slideBackground(slide, relations, entries, theme, imageCache);
    const layoutBg = slideBackground(layout, layoutRelations, entries, theme, imageCache);
    const masterBg = slideBackground(master, masterRelations, entries, theme, imageCache);
    const background = {
      color: slideBg.color ?? layoutBg.color ?? masterBg.color,
      image: slideBg.image ?? layoutBg.image ?? masterBg.image,
    };
    const paragraphs = elements.filter((item): item is PptxTextElement => item.kind === "text").map((item) => item.text).filter(Boolean);
    return { width, height, elements, title: paragraphs[0] ?? `第 ${index + 1} 页`, paragraphs: paragraphs.slice(1), imageCount: elements.filter((item) => item.kind === "image").length, background: background.color, backgroundImage: background.image };
  });
}

export function parseXlsx(bytes: Uint8Array): Sheet[] {
  const entries = unzipSync(bytes);
  const shared = xmlEntry(entries, "xl/sharedStrings.xml");
  const sharedStrings = shared ? local(shared, "si").map((item) => local(item, "t").map((text) => text.textContent ?? "").join("")) : [];
  const workbook = xmlEntry(entries, "xl/workbook.xml");
  const relationships = xmlEntry(entries, "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  local(relationships, "Relationship").forEach((relation) => {
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    if (id && target) relMap.set(id, resolveZipTarget("xl", target));
  });
  const sheetDefs = workbook ? local(workbook, "sheet") : [];
  return sheetDefs.map((definition, sheetIndex) => {
    const name = definition.getAttribute("name") ?? `工作表 ${sheetIndex + 1}`;
    const relationId = definition.getAttribute("r:id") ?? definition.getAttributeNS(REL_NS, "id") ?? "";
    const path = relMap.get(relationId) ?? `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const sheet = xmlEntry(entries, path);
    const rows = sheet ? local(sheet, "row").map((row) => local(row, "c").map((cell) => {
      const type = cell.getAttribute("t");
      const value = firstLocal(cell, "v")?.textContent ?? local(cell, "t").map((item) => item.textContent ?? "").join("");
      return type === "s" ? (sharedStrings[Number(value)] ?? value) : value;
    })) : [];
    return { name, rows };
  });
}

function percent(value: number, total: number): string {
  return `${Math.max(0, Math.min(100, (value / Math.max(1, total)) * 100))}%`;
}

function elementStyle(element: PptxVisual, slide: Slide): CSSProperties {
  return { left: percent(element.x, slide.width), top: percent(element.y, slide.height), width: percent(element.width, slide.width), height: percent(element.height, slide.height), zIndex: element.zIndex, transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined, transformOrigin: element.rotation ? "center center" : undefined };
}

function imageObjectPosition(crop: PptxImageElement["crop"]): string | undefined {
  if (!crop) return undefined;
  const horizontal = Math.max(0, Math.min(100, (crop.left + (1 - crop.left - crop.right) / 2) * 100));
  const vertical = Math.max(0, Math.min(100, (crop.top + (1 - crop.top - crop.bottom) / 2) * 100));
  return `${horizontal}% ${vertical}%`;
}

function slideFontSize(fontSizePt: number, slide: Slide): string {
  // OOXML stores text in points while the slide itself is sized in EMUs. The
  // stage is responsive, so container query units preserve the original
  // proportion instead of rendering every slide at a fixed desktop size.
  return `${Math.max(0.1, (fontSizePt * 12700 / Math.max(1, slide.width)) * 100)}cqw`;
}

export function OfficePreview(props: OfficePreviewProps) {
  if (props.format === "xlsx") return <SpreadsheetGrid binaryContent={props.binaryContent} name={props.name} editable={props.editable} onArtifact={props.onArtifact} aiChanges={props.aiChanges} onClearAiChanges={props.onClearAiChanges} />;
  return <LegacyOfficePreview {...props} />;
}

function LegacyOfficePreview({ binaryContent, format, name }: OfficePreviewProps) {
  const [parsed, setParsed] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "pptx"; slides: Slide[] }
    | { kind: "xlsx"; sheets: Sheet[] }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;
    let mainThreadFallbackStarted = false;
    const fail = (cause: unknown) => {
      if (cancelled) return;
      setParsed({ kind: "error", message: cause instanceof Error ? cause.message : "Office 文件无法解析" });
    };
    setParsed(binaryContent ? { kind: "loading" } : { kind: "error", message: "没有可用的 Office 二进制内容" });
    if (!binaryContent) return () => undefined;
    try {
      const bytes = decodeBase64(binaryContent);
      // Transfer a copy to the worker so the original remains available for
      // embedded WebViews whose Worker lacks DOMParser.
      const fallbackBytes = bytes.slice();
      const parseOnMainThread = () => {
        if (cancelled || mainThreadFallbackStarted) return;
        mainThreadFallbackStarted = true;
        setTimeout(() => {
          if (cancelled) return;
          try {
            setParsed(format === "pptx" ? { kind: "pptx", slides: parsePptx(fallbackBytes) } : { kind: "xlsx", sheets: parseXlsx(fallbackBytes) });
          } catch (cause) { fail(cause); }
        }, 0);
      };
      if (typeof Worker === "function") {
        worker = new Worker(new URL("./office-preview.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ kind: "pptx" | "xlsx"; value: Slide[] | Sheet[] } | { kind: "error"; message: string } | { kind: "unsupported"; reason: string }>) => {
          if (cancelled) return;
          if (event.data.kind === "unsupported") {
            worker?.terminate();
            worker = null;
            parseOnMainThread();
          } else if (event.data.kind === "error" && /DOMParser is not defined/i.test(event.data.message)) {
            worker?.terminate();
            worker = null;
            parseOnMainThread();
          } else if (event.data.kind === "error") setParsed({ kind: "error", message: event.data.message });
          else if (event.data.kind === "pptx") setParsed({ kind: "pptx", slides: event.data.value as Slide[] });
          else setParsed({ kind: "xlsx", sheets: event.data.value as Sheet[] });
        };
        worker.onerror = (event) => {
          if (/DOMParser is not defined/i.test(event.message || "")) parseOnMainThread();
          else fail(event.error ?? new Error(event.message || "Office 后台解析失败"));
        };
        worker.onmessageerror = () => fail(new Error("Office 预览结果无法传回界面"));
        worker.postMessage({ format, bytes: bytes.buffer }, [bytes.buffer]);
      } else {
        // jsdom has no Worker implementation; keep the deterministic synchronous
        // fallback used by unit tests and older embedded WebViews.
        try {
          setParsed(format === "pptx" ? { kind: "pptx", slides: parsePptx(bytes) } : { kind: "xlsx", sheets: parseXlsx(bytes) });
        } catch (cause) { fail(cause); }
      }
    } catch (cause) { fail(cause); }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [binaryContent, format]);

  if (parsed.kind === "loading") return <div className="office-preview-shell office-preview-loading" aria-label={`${format.toUpperCase()} 预览加载中`}><span className="office-preview-spinner" /><strong>正在生成预览</strong><small>复杂演示文稿会在后台解析，窗口仍可操作</small></div>;
  if (parsed.kind === "error") return <div className="office-preview-shell office-preview-error"><FileWarning aria-hidden="true" /><strong>预览无法生成</strong><small>{parsed.message}</small></div>;
  if (parsed.kind === "pptx") return <div className="office-preview-shell" aria-label="PPTX 预览"><span className="sr-only">{name}</span><div className="pptx-slide-list">{parsed.slides.map((slide, index) => <article className="pptx-slide" key={`${slide.title}-${index}`}><div className="pptx-slide-number">{index + 1}</div><div className="pptx-slide-frame"><div className="pptx-slide-stage" style={{ aspectRatio: `${slide.width} / ${slide.height}`, background: slide.background ?? "#fff", backgroundImage: slide.backgroundImage ? `url(${slide.backgroundImage})` : undefined, backgroundSize: slide.backgroundImage ? "cover" : undefined, backgroundPosition: slide.backgroundImage ? "center" : undefined }}>{slide.elements.map((element, elementIndex) => {
    const style = elementStyle(element, slide);
    if (element.kind === "image") return <img className="pptx-element-image" key={`image-${elementIndex}`} src={element.src} alt={element.alt} style={{ ...style, objectFit: element.crop ? "cover" : "fill", objectPosition: imageObjectPosition(element.crop) }} />;
    if (element.kind === "table") return <div className="pptx-element-table" key={`table-${elementIndex}`} style={style}><table><tbody>{element.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
    if (element.kind === "chart") return <div className="pptx-element-chart" key={`chart-${elementIndex}`} style={style} aria-label={`图表 ${element.title}`}><strong>{element.title}</strong>{element.values.length ? <div className="pptx-chart-bars">{element.values.map((value, valueIndex) => <span key={valueIndex} style={{ height: `${Math.max(6, Math.min(100, Math.abs(value) || 6))}%` }} title={String(value)} />)}</div> : <small>图表数据已保留，可在 PowerPoint 中查看完整交互效果</small>}</div>;
    if (element.kind === "shape") return <div className="pptx-element-shape" key={`shape-${elementIndex}`} style={{ ...style, background: element.fill ?? "transparent", border: element.line ? `${Math.max(1, (element.lineWidth ?? 12700) * 100 / slide.width)}cqw solid ${element.line}` : undefined }} />;
    return <div className="pptx-element-text" key={`text-${elementIndex}`} style={{ ...style, color: element.color ?? "#253a35", fontFamily: element.fontFamily ?? undefined, fontSize: slideFontSize(element.fontSize, slide), fontWeight: element.bold ? 700 : undefined, fontStyle: element.italic ? "italic" : undefined, textAlign: element.align === "ctr" ? "center" : element.align === "r" ? "right" : element.align === "just" ? "justify" : "left" }}>{element.runs.length ? element.runs.map((run, runIndex) => <span key={runIndex} style={{ color: run.color ?? undefined, fontFamily: run.fontFamily ?? undefined, fontSize: slideFontSize(run.fontSize, slide), fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? "italic" : undefined, textDecoration: run.underline ? "underline" : undefined }}>{run.text}</span>) : element.text}</div>;
  })}{slide.elements.length === 0 && <p className="office-preview-empty">此页没有可提取的对象</p>}</div></div></article>)}</div></div>;
  return null;
}
