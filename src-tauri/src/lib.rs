mod commands;
mod paths;
mod window_state;

/** Force-quits the whole app from the frontend. Called from the window
 * close-request interceptor after session + snapshot sync; bypasses the
 * (already consumed) close request. Persists window geometry first, since
 * app.exit() skips the normal CloseRequested/Destroyed event chain. */
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    window_state::save_now(&app);
    app.exit(0);
}

/// Opens an http(s) URL in the OS default browser. Preview links are never
/// navigated inside the app window; the frontend routes them here.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains('\0') {
        return Err("只允许打开 http(s) 链接".into());
    }
    // rundll32 url.dll,FileProtocolHandler hands the URL to the default
    // browser without spawning a console window.
    let _ = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| format!("无法打开外部浏览器：{e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            window_state::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::path_exists,
            commands::files::read_image_base64,
            commands::snapshots::snapshot_write,
            commands::snapshots::snapshot_list,
            commands::snapshots::snapshot_remove,
            commands::snapshots::snapshot_read,
            commands::settings::read_settings,
            commands::settings::write_settings,
            commands::session::session_save,
            commands::session::session_load,
            exit_app,
            open_external,
            #[cfg(windows)]
            commands::font::pick_system_font,
            #[cfg(windows)]
            commands::bench::bench_targets,
            #[cfg(windows)]
            commands::bench::process_mem_kb,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
