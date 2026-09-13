import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Music2, Play, Pause, SkipBack, SkipForward, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import "./FocusMusic.css";

type Playback = { connected: boolean; title: string; artist: string; playing: boolean; canPlay: boolean; canPause: boolean; canNext: boolean; canPrevious: boolean };
const players = [{ id: "qq", name: "QQ 音乐" }, { id: "netease", name: "网易云音乐" }, { id: "kugou", name: "酷狗音乐" }];
export function FocusMusic() {
  const desktop = isTauri();
  const [player, setPlayer] = useState("qq");
  const [status, setStatus] = useState<Playback | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    const token = ++generation.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setStatus(null);
    if (!desktop) return;
    const poll = async () => {
      try {
        const next = await invoke<Playback>("music_status", { player });
        if (!cancelled && generation.current === token) setStatus(next);
      } catch {
        if (!cancelled && generation.current === token) { setStatus(null); setError("暂时无法读取播放状态，请检查音乐软件后重试。"); }
      } finally { if (!cancelled) timer = setTimeout(poll, 4000); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [player, desktop, refresh]);
  async function act(action: string) {
    if (acting.current) return;
    acting.current = true;
    ++generation.current;
    setBusy(true); setError("");
    try {
      if (action === "open") await invoke<boolean>("music_open", { player });
      else await invoke("music_control", { player, action });
    } catch (cause) { setError(typeof cause === "string" ? cause : "操作失败，请稍后重试。"); }
    finally { acting.current = false; setStatus(null); setRefresh(n => n + 1); setBusy(false); }
  }
  const canToggle = !!status && (status.playing ? status.canPause : status.canPlay);
  return <section className={`focus-music${collapsed ? " is-collapsed" : ""}`} aria-label="专注音乐">
    <header><div><Music2 aria-hidden="true" /><strong>专注音乐</strong><span>跟随你的节奏</span></div><button type="button" aria-label={collapsed ? "展开播放器" : "收起播放器"} aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</button></header>
    {!collapsed && <div className="focus-music-body">
      <div className="focus-music-source"><label>音乐来源<select aria-label="音乐来源" disabled={busy} value={player} onChange={e => { setPlayer(e.target.value); setError(""); setStatus(null); }}>{players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button type="button" disabled={!desktop || busy} onClick={() => void act("open")}><ExternalLink />打开软件</button></div>
      <div className="focus-music-track"><div className={`focus-music-art${status?.playing ? " is-playing" : ""}`} aria-hidden="true"><Music2 /><i className="music-bars"><b /><b /><b /><b /><b /></i></div><div><strong>{status?.title || (status?.connected ? "等待歌曲信息" : "让音乐陪你专注")}</strong><span>{status?.artist || "在所选音乐软件中播放一首歌"}</span></div></div>
      <div className="focus-music-transport"><button type="button" aria-label="上一首" disabled={!status?.canPrevious || busy} onClick={() => void act("previous")}><SkipBack /></button><button className="focus-music-play" type="button" aria-label={status?.playing ? "暂停音乐" : "播放音乐"} disabled={!canToggle || busy} onClick={() => void act(status?.playing ? "pause" : "play")}>{status?.playing ? <Pause /> : <Play />}</button><button type="button" aria-label="下一首" disabled={!status?.canNext || busy} onClick={() => void act("next")}><SkipForward /></button></div>
      <p className="focus-music-note">{!desktop ? "桌面版可连接本机音乐软件，网页预览暂不支持。" : status?.connected ? "已连接 · 可用操作由音乐软件提供" : "打开软件并播放后连接；部分版本需开启系统媒体控制。"}</p>
      {error && <p role="alert" className="focus-music-error">{error}</p>}
    </div>}
  </section>;
}
