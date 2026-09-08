mod commands;
mod paths;
mod window_state;

/** Force-quits the whole app from the frontend (used after the quit
 * confirm dialog, bypassing close-requested interception entirely).
 * Persists the window geometry first, since app.exit() skips the normal
 * CloseRequested/Destroyed event chain. */
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    window_state::save_now(&app);
    app.exit(0);
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
            #[cfg(windows)]
            commands::font::pick_system_font,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
