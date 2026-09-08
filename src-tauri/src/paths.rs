use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// Directory resolution for a fully portable ("green") install:
///
///   <exe_dir>/settings/  -> settings.json, window.json
///   <exe_dir>/autosave/  -> recovery snapshots
///
/// If the executable's directory is not writable (e.g. installed under
/// C:\Program Files), we automatically fall back to the per-user OS
/// directories (app config / app data), keeping the old behaviour.
///
/// Writability is probed once per process and cached, so per-snapshot writes
/// never pay the probe cost again.
enum DirKind {
    Settings,
    Autosave,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// Tries `<exe_dir>/<sub>`; returns Some only when the directory could be
/// created *and* a probe file written (i.e. genuinely writable).
fn try_exe_subdir(sub: &str) -> Option<PathBuf> {
    let base = exe_dir()?;
    let dir = base.join(sub);
    fs::create_dir_all(&dir).ok()?;
    let probe = dir.join(format!(".probe-{}", std::process::id()));
    fs::write(&probe, b"").ok()?;
    let _ = fs::remove_file(&probe);
    Some(dir)
}

fn cached(kind: DirKind) -> &'static Option<PathBuf> {
    static SETTINGS: OnceLock<Option<PathBuf>> = OnceLock::new();
    static AUTOSAVE: OnceLock<Option<PathBuf>> = OnceLock::new();
    match kind {
        DirKind::Settings => SETTINGS.get_or_init(|| try_exe_subdir("settings")),
        DirKind::Autosave => AUTOSAVE.get_or_init(|| try_exe_subdir("autosave")),
    }
}

/// Primary settings dir: `<exe_dir>/settings` if writable, else the per-user
/// app-config dir (fallback). Never fails; dirs are created on demand.
pub fn settings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = cached(DirKind::Settings) {
        let _ = fs::create_dir_all(dir);
        return Ok(dir.clone());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir)
}

/// Primary autosave dir: `<exe_dir>/autosave` if writable, else the per-user
/// app-data dir (fallback). Never fails; dirs are created on demand.
pub fn autosave_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = cached(DirKind::Autosave) {
        let _ = fs::create_dir_all(dir);
        return Ok(dir.clone());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("autosave");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建快照目录：{e}"))?;
    Ok(dir)
}
