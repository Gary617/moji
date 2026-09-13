import type { AnnotationAnchor } from "../ipc/document";
import type { DocumentFormat } from "../ipc/library";

interface TextSegment {
  paragraph: number;
  start: number;
  end: number;
}

export interface TextAnchorResolution {
  status: "exact" | "paragraph" | "quote-fallback" | "unresolved";
  start: number | null;
  end: number | null;
  paragraph: number | null;
}

function lineSegments(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;
  let paragraph = 1;
  for (const match of content.matchAll(/\r?\n/g)) {
    const newlineStart = match.index;
    segments.push({ paragraph, start, end: newlineStart });
    start = newlineStart + match[0].length;
    paragraph += 1;
  }
  segments.push({ paragraph, start, end: content.length });
  return segments;
}

function markdownSegments(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const separator = /(?:\r?\n)[\t ]*(?:\r?\n)+/g;
  let start = 0;
  let paragraph = 1;
  for (const match of content.matchAll(separator)) {
    const separatorStart = match.index;
    if (separatorStart > start) {
      segments.push({ paragraph, start, end: separatorStart });
      paragraph += 1;
    }
    start = separatorStart + match[0].length;
  }
  if (start < content.length || segments.length === 0) {
    segments.push({ paragraph, start, end: content.length });
  }
  return segments;
}

function segmentsFor(content: string, format: DocumentFormat): TextSegment[] {
  return format === "markdown" ? markdownSegments(content) : lineSegments(content);
}

function segmentAt(segments: TextSegment[], offset: number): TextSegment {
  return segments.find((segment) => offset >= segment.start && offset <= segment.end)
    ?? segments[segments.length - 1];
}

function paragraphAt(segments: TextSegment[], offset: number): number | null {
  return segmentAt(segments, offset)?.paragraph ?? null;
}

export function createTextAnchor(
  content: string,
  format: DocumentFormat,
  selectionStart: number,
  selectionEnd: number,
): AnnotationAnchor {
  const start = Math.max(0, Math.min(content.length, Math.min(selectionStart, selectionEnd)));
  const rawEnd = Math.max(0, Math.min(content.length, Math.max(selectionStart, selectionEnd)));
  const segments = segmentsFor(content, format);
  const segment = segmentAt(segments, start);
  const hasSelection = rawEnd > start;
  const end = hasSelection ? rawEnd : segment.end;
  const quote = content.slice(hasSelection ? start : segment.start, end) || null;

  return {
    kind: "character-range",
    page: null,
    slide: null,
    paragraph: segment.paragraph,
    charStart: hasSelection ? start : segment.start,
    charEnd: end,
    quote,
    stable: true,
  };
}

function uniqueQuoteIndex(content: string, quote: string): number | null {
  const first = content.indexOf(quote);
  if (first < 0 || content.indexOf(quote, first + 1) >= 0) return null;
  return first;
}

export function resolveTextAnchor(
  content: string,
  format: DocumentFormat,
  anchor: AnnotationAnchor,
): TextAnchorResolution {
  const segments = segmentsFor(content, format);
  const start = anchor.charStart;
  const end = anchor.charEnd;
  const quote = anchor.quote;

  if (start !== null && end !== null && start >= 0 && end >= start && end <= content.length) {
    const exactText = content.slice(start, end);
    if (!quote || exactText === quote) {
      return { status: "exact", start, end, paragraph: paragraphAt(segments, start) };
    }
  }

  if (anchor.paragraph !== null && quote) {
    const segment = segments.find((candidate) => candidate.paragraph === anchor.paragraph);
    if (segment) {
      const withinParagraph = content.slice(segment.start, segment.end).indexOf(quote);
      if (withinParagraph >= 0) {
        const relocatedStart = segment.start + withinParagraph;
        return {
          status: "paragraph",
          start: relocatedStart,
          end: relocatedStart + quote.length,
          paragraph: segment.paragraph,
        };
      }
    }
  }

  if (quote) {
    const relocatedStart = uniqueQuoteIndex(content, quote);
    if (relocatedStart !== null) {
      return {
        status: "quote-fallback",
        start: relocatedStart,
        end: relocatedStart + quote.length,
        paragraph: paragraphAt(segments, relocatedStart),
      };
    }
  }

  return { status: "unresolved", start: null, end: null, paragraph: null };
}

export function createPdfAnchor(
  page: number,
  selection: { start: number; end: number; quote: string } | null,
): AnnotationAnchor {
  if (!selection || !selection.quote.trim()) {
    return {
      kind: "page",
      page,
      slide: null,
      paragraph: null,
      charStart: null,
      charEnd: null,
      quote: null,
      stable: true,
    };
  }
  return {
    kind: "character-range",
    page,
    slide: null,
    paragraph: null,
    charStart: selection.start,
    charEnd: selection.end,
    quote: selection.quote,
    stable: true,
  };
}

