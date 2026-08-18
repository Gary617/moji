import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { healthCheck, type HealthCheckData } from "./ipc/health";
import type { IpcError } from "./ipc/types";

type HealthState =
  | { kind: "checking" }
  | { kind: "healthy"; data: HealthCheckData }
  | { kind: "unavailable"; error: IpcError };

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });

  const refreshHealth = useCallback(async () => {
    setHealth({ kind: "checking" });
    const response = await healthCheck();

    if (response.status === "success") {
      setHealth({ kind: "healthy", data: response.data });
      return;
    }

    setHealth({ kind: "unavailable", error: response.error });
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const isChecking = health.kind === "checking";

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="phase-label">工程基线 / PHASE 00</p>
          <h1>墨集</h1>
        </div>
        <span className="build-mark">LOCAL DESKTOP</span>
      </header>

      <section className="health-panel" aria-labelledby="health-title">
        <div className="health-heading">
          <div>
            <p className="section-index">01 / CORE</p>
            <h2 id="health-title">桌面核心</h2>
          </div>
          <button
            className="refresh-button"
            type="button"
            onClick={() => void refreshHealth()}
            disabled={isChecking}
          >
            <RefreshCw aria-hidden="true" className={isChecking ? "is-spinning" : ""} />
            <span>{isChecking ? "检查中" : "重新检查"}</span>
          </button>
        </div>

        <div className="status-row" role="status" aria-live="polite">
          <span
            className={`status-light status-light--${health.kind}`}
            aria-hidden="true"
          />
          <div className="status-copy">
            <span className="status-label">Rust 后端</span>
            {health.kind === "checking" && <strong>正在连接</strong>}
            {health.kind === "healthy" && <strong>运行正常</strong>}
            {health.kind === "unavailable" && <strong>连接失败</strong>}
          </div>
        </div>

        <dl className="metrics">
          <div>
            <dt>应用版本</dt>
            <dd>{health.kind === "healthy" ? health.data.appVersion : "-"}</dd>
          </div>
          <div>
            <dt>IPC 协议</dt>
            <dd>{health.kind === "healthy" ? `v${health.data.protocolVersion}` : "-"}</dd>
          </div>
        </dl>

        {health.kind === "unavailable" && (
          <p className="error-message">
            <span>{health.error.code}</span>
            {health.error.message}
          </p>
        )}
      </section>

      <footer>
        <span>TAURI 2</span>
        <span>REACT</span>
        <span>RUST</span>
      </footer>
    </main>
  );
}
