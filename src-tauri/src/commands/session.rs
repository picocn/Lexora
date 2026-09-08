use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::paths;

/// Session persistence: remembers the tabs open when the app exited so the
/// next launch can re-open all previously opened files.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Ordered list of editor file paths (one tab each) at exit time.
    pub paths: Vec<String>,
    /// The path of the tab that was active at exit time, if any.
    pub active_path: Option<String>,
}

const SESSION_FILE: &str = "session.json";

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths::settings_dir(app)?.join(SESSION_FILE))
}

#[tauri::command]
pub fn session_save(
    app: AppHandle,
    paths: Vec<String>,
    active_path: Option<String>,
) -> Result<(), String> {
    let session = Session { paths, active_path };
    let path = session_path(&app)?;
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    paths::atomic_write_text(&path, &json).map_err(|e| format!("无法写会话：{e}"))
}

#[tauri::command]
pub fn session_load(app: AppHandle) -> Result<Session, String> {
    let path = session_path(&app)?;
    if !path.exists() {
        return Ok(Session::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("无法读取会话：{e}"))?;
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    let s: Session = serde_json::from_str(raw).map_err(|e| format!("会话文件损坏：{e}"))?;
    // Keep sane limits and drop empty entries.
    let paths: Vec<String> = s.paths.into_iter().filter(|p| !p.is_empty()).take(200).collect();
    let active = s.active_path.filter(|p| paths.contains(p));
    Ok(Session { paths, active_path: active })
}
