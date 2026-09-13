import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./App.css";
import "./Glass.css";

type ErrorBoundaryState = { hasError: boolean; message: string };

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : "界面渲染失败" };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    console.error("墨集界面渲染失败", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32, color: "#243b36", background: "#f4f6f2", fontFamily: "Microsoft YaHei UI, Segoe UI, sans-serif" }}><section style={{ maxWidth: 520, padding: 28, background: "#fff", border: "1px solid #d9e2dc", borderRadius: 12, boxShadow: "0 16px 40px rgba(35, 66, 58, .12)" }}><h1 style={{ margin: "0 0 10px", fontSize: 20 }}>墨集界面出现异常</h1><p style={{ margin: "0 0 18px", color: "#60746d", lineHeight: 1.6 }}>扫描任务仍可能在后台运行。可以先重载界面，已登记的资料不会被删除。</p><small style={{ display: "block", marginBottom: 18, color: "#9a5b4e", overflowWrap: "anywhere" }}>{this.state.message}</small><button type="button" onClick={() => window.location.reload()} style={{ minHeight: 36, padding: "0 14px", color: "#fff", background: "#2f7569", border: 0, borderRadius: 7, cursor: "pointer" }}>重载界面</button></section></main>;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
