use serde::Serialize;
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;
use windows::Media::Control::{GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status};

fn executable(player: &str) -> Result<&'static str, String> {
    match player { "qq" => Ok("QQMusic.exe"), "kugou" => Ok("KuGou.exe"), "netease" => Ok("cloudmusic.exe"), _ => Err("请选择支持的音乐软件".into()) }
}
fn matches_player(source: &str, player: &str) -> bool {
    let source = source.to_ascii_lowercase();
    match player { "qq" => source.contains("qqmusic"), "kugou" => source.contains("kugou"), "netease" => source.contains("cloudmusic") || source.contains("netease"), _ => false }
}
fn find_session(player: &str) -> Result<Option<Session>, String> {
    executable(player)?;
    (|| -> windows::core::Result<Option<Session>> {
        let manager = Manager::RequestAsync()?.get()?;
        for session in manager.GetSessions()? {
            if matches_player(&session.SourceAppUserModelId()?.to_string(), player) { return Ok(Some(session)); }
        }
        Ok(None)
    })().map_err(|_| "暂时无法连接 Windows 媒体服务，请稍后重试".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicStatus { connected: bool, title: String, artist: String, playing: bool, can_play: bool, can_pause: bool, can_next: bool, can_previous: bool }
fn status(player: &str) -> Result<MusicStatus, String> {
    let Some(session) = find_session(player)? else { return Ok(MusicStatus { connected:false, title:String::new(), artist:String::new(), playing:false, can_play:false, can_pause:false, can_next:false, can_previous:false }); };
    (|| -> windows::core::Result<MusicStatus> {
        let media = session.TryGetMediaPropertiesAsync()?.get()?;
        let info = session.GetPlaybackInfo()?;
        let controls = info.Controls()?;
        Ok(MusicStatus { connected:true, title:media.Title()?.to_string(), artist:media.Artist()?.to_string(), playing:info.PlaybackStatus()? == Status::Playing, can_play:controls.IsPlayEnabled()?, can_pause:controls.IsPauseEnabled()?, can_next:controls.IsNextEnabled()?, can_previous:controls.IsPreviousEnabled()? })
    })().map_err(|_| "音乐软件暂未提供歌曲信息".into())
}
#[tauri::command]
pub async fn music_status(player: String) -> Result<MusicStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&player)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn music_control(player: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = find_session(&player)?.ok_or("所选软件没有可控制的播放会话")?;
        let result = match action.as_str() {
            "play" => session.TryPlayAsync(), "pause" => session.TryPauseAsync(),
            "next" => session.TrySkipNextAsync(), "previous" => session.TrySkipPreviousAsync(),
            _ => return Err("不支持的播放操作".into()),
        };
        match result.and_then(|op| op.get()) { Ok(true) => Ok(()), _ => Err("音乐软件暂不支持此操作，请在原软件中控制".into()) }
    }).await.map_err(|e| e.to_string())?
}
fn installed_path(player: &str) -> Option<PathBuf> {
    let paths: &[&str] = match player {
        "qq" => &["Tencent/QQMusic/QQMusic.exe", "QQMusic/QQMusic.exe"],
        "kugou" => &["KuGou/KGMusic/KuGou.exe", "KuGou/KuGou.exe"],
        "netease" => &["NetEase/CloudMusic/cloudmusic.exe", "CloudMusic/cloudmusic.exe"], _ => &[],
    };
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].into_iter().filter_map(std::env::var_os)
        .flat_map(|root| paths.iter().map(move |p| PathBuf::from(&root).join(p))).find(|p| p.is_file())
}
#[tauri::command]
pub async fn music_open(app: tauri::AppHandle, player: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let expected = executable(&player)?;
        // Relaunching an existing player can resume its paused track.
        if find_session(&player)?.is_some() {
            return Err("音乐软件已连接，请从任务栏打开窗口；为保留暂停状态，不会重复启动。".into());
        }
        let path = match installed_path(&player) {
            Some(path) => path,
            None => {
                let picked = app.dialog().file().set_title("选择音乐软件的主程序").add_filter("音乐软件", &["exe"]).blocking_pick_file();
                let Some(picked) = picked else { return Ok(false); };
                picked.into_path().map_err(|_| "无法读取程序路径")?
            }
        };
        if !path.file_name().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case(expected)) { return Err(format!("请选择 {expected}")); }
        std::process::Command::new(&path).current_dir(path.parent().ok_or("无效路径")?).spawn().map_err(|_| "无法打开音乐软件，请检查安装位置")?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn windows_media_service_is_reachable() {
        for player in ["qq", "netease", "kugou"] {
            let state = status(player).expect("Windows media service");
            println!("{player}: connected={}", state.connected);
        }
    }
    #[test]
    fn session_is_scoped_to_selected_player() {
        assert!(matches_player("QQMusic.exe", "qq"));
        assert!(matches_player("Netease.CloudMusic_example", "netease"));
        assert!(!matches_player("QQMusic.exe", "netease"));
        assert!(!matches_player("chrome.exe", "qq"));
        assert!(executable("powershell").is_err());
    }
}
