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
        // Single-instance MUST be the first plugin: a second launch (e.g. the
        // user double-clicks another `.md`) must not start a competing process;
        // its command line is forwarded to this one instead and queued for the
        // frontend, which opens the files as tabs.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // argv[0] is the forwarded executable path, not a file to open.
            let paths = commands::launch::collect_open_args(argv.into_iter().skip(1));
            commands::launch::push_launch_paths(app, paths);
            // A plain relaunch (no files) must still surface the running window
            // instead of looking like nothing happened.
            commands::launch::focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::launch::LaunchPaths::default())
        .manage(commands::print_doc::PrintSlot::default())
        .setup(|app| {
            window_state::init(app.handle());
            // Files this process was started with ("open with Lexora"): queued
            // now, drained by the frontend once it has mounted.
            let initial = commands::launch::collect_open_args(std::env::args().skip(1));
            commands::launch::seed_launch_paths(app.handle(), initial);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::path_exists,
            commands::files::read_image_base64,
            commands::files::file_stat,
            commands::files::classify_paths,
            commands::launch::take_launch_paths,
            commands::print_doc::stage_print_doc,
            commands::print_doc::take_print_doc,
            commands::print_doc::open_print_window,
            commands::print_doc::close_print_window,
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
            #[cfg(windows)]
            commands::assoc::assoc_status,
            #[cfg(windows)]
            commands::assoc::register_md_association,
            #[cfg(windows)]
            commands::assoc::unregister_md_association,
            #[cfg(windows)]
            commands::assoc::open_default_apps_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
