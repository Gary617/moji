import {
  MockEditorAdapter,
  ZetaOfficeAdapter,
  createZetaJsRuntime,
  type EditOperation,
  type ZetaOfficeRuntime,
} from "../../src/editor";
import { describe, expect, it } from "vitest";

describe("EditorAdapter contract", () => {
  it("runs a mock round trip without allowing source overwrite", async () => {
    const adapter = new MockEditorAdapter();
    const health = await adapter.healthCheck();
    expect(health.status).toBe("success");
    if (health.status !== "success") return;

    const opened = await adapter.open("C:/samples/中文表格.docx");
    expect(opened.status).toBe("success");
    if (opened.status !== "success") return;

    const operation: EditOperation = { kind: "append-text", text: " [round-trip]" };
    expect((await adapter.edit(opened.data, operation)).status).toBe("success");
    expect((await adapter.saveAs(opened.data, "C:/temp/中文表格-edited.docx")).status).toBe("success");

    const overwrite = await adapter.saveAs(opened.data, "C:/samples/中文表格.docx");
    expect(overwrite.status).toBe("error");
    expect(overwrite.status === "error" && overwrite.error.code).toBe("SOURCE_WRITE_FORBIDDEN");
    expect(adapter.getSavedContent("C:/temp/中文表格-edited.docx")).toContain("round-trip");
    expect((await adapter.close(opened.data)).status).toBe("success");
  });

  it("maps an unavailable real runtime to a structured failure and fallback", async () => {
    const adapter = new ZetaOfficeAdapter();
    const health = await adapter.healthCheck();
    expect(health).toMatchObject({ status: "error", outcome: "FAIL" });
    if (health.status !== "error") return;
    expect(health.error).toMatchObject({
      code: "ZETA_RUNTIME_UNAVAILABLE",
      retryable: true,
      fallback: { mode: "read-only-preview", available: false },
    });

    const opened = await adapter.open("C:/samples/report.pptx");
    expect(opened.status).toBe("error");
    expect(opened.status === "error" && opened.error.code).toBe("ZETA_RUNTIME_UNAVAILABLE");
  });

  it("keeps zetajs details inside the adapter while supporting a runtime bridge", async () => {
    const runtime: ZetaOfficeRuntime = createZetaJsRuntime({
      version: "zeta-test",
      openDocument: async () => ({
        readOnlyPreview: async () => ({ format: "xlsx", readOnly: true, summary: "月度收入 [round-trip]", warnings: [] }),
        edit: async () => undefined,
        saveAs: async () => undefined,
        close: async () => undefined,
      }),
    });
    const adapter = new ZetaOfficeAdapter(runtime);
    const health = await adapter.healthCheck();
    expect(health.status === "success" && health.data.runtimeVersion).toBe("zeta-test");
    const opened = await adapter.open("C:/samples/收入图表.xlsx");
    expect(opened.status).toBe("success");
    if (opened.status !== "success") return;
    expect((await adapter.edit(opened.data, { kind: "set-cell-value", sheet: "Sheet1", cell: "B2", value: "42" })).status).toBe("success");
    expect((await adapter.saveAs(opened.data, "C:/temp/收入图表-edited.xlsx")).status).toBe("success");
    const preview = await adapter.readOnlyPreview(opened.data);
    expect(preview.status === "success" && preview.data.summary).toContain("round-trip");
    expect((await adapter.close(opened.data)).status).toBe("success");
  });
});
