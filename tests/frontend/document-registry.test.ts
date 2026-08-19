import { describe, expect, it } from "vitest";

import { adapterRegistry } from "../../src/document/registry";

describe("AdapterRegistry", () => {
  it("routes text, PDF, Office and unsupported formats to distinct capability boundaries", () => {
    expect(adapterRegistry.resolve("markdown").kind).toBe("text");
    expect(adapterRegistry.resolve("pdf").descriptor("pdf", "edit").label).toBe("PDF.js 阅读器");
    expect(adapterRegistry.resolve("docx").descriptor("docx", "edit").fallbackReason).toContain("runtime bridge");
    expect(adapterRegistry.resolve("png").kind).toBe("read-only");
  });
});
