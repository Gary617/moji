import { BriefcaseBusiness, LibraryBig } from "lucide-react";

export type ProductMode = "workbench" | "documents";

export function ProductModeSwitch({ mode, onChange, className = "" }: { mode: ProductMode; onChange(mode: ProductMode): void; className?: string }) {
  return <div className={`product-mode-switch${className ? ` ${className}` : ""}`} data-mode={mode} role="tablist" aria-label="产品模式">
    <button type="button" role="tab" aria-label="个人工作台" aria-selected={mode === "workbench"} className={mode === "workbench" ? "is-active" : ""} onClick={() => onChange("workbench")}><BriefcaseBusiness aria-hidden="true" /><span>个人工作台</span></button>
    <button type="button" role="tab" aria-label="文档管理" aria-selected={mode === "documents"} className={mode === "documents" ? "is-active" : ""} onClick={() => onChange("documents")}><LibraryBig aria-hidden="true" /><span>文档管理</span></button>
  </div>;
}
