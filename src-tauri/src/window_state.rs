use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, LogicalSize, Manager};

use crate::paths;

/// Remembers the main window's size (and maximized state) across sessions.
/// Window size / position persistence happens entirely in Rust: latest bounds
/// are captured on every resize and written once on window destroy.
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowState {
    /// Logical (DPI-scaled) width, CSS pixels.
    pub width: f64,
    /// Logical (DPI-scaled) height, CSS pixels.
    pub height: f64,
    pub maximized: bool,
}

const STATE_FILE: &str = "window.json";

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths::settings_dir(app)?.join(STATE_FILE))
}

/// Reads the previously persisted window state (defaults to 1280x840 when
/// nothing is stored yet). Tolerates a UTF-8 BOM (files may be hand-edited).
pub fn load(app: &AppHandle) -> WindowState {
    let path = match state_path(app) {
        Ok(p) => p,
        Err(_) => return WindowState::default(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return WindowState::default(),
    };
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    serde_json::from_str(raw)
        .ok()
        .filter(|s: &WindowState| s.width >= 320.0 && s.height >= 240.0)
        .unwrap_or(WindowState::default())
}

fn save(app: &AppHandle, state: WindowState) {
    if let (Ok(path), Ok(json)) = (state_path(app), serde_json::to_string_pretty(&state)) {
        let _ = fs::write(path, json);
    }
}

/// Captures the current logical size + maximized flag of the window.
fn capture(app: &AppHandle) -> WindowState {
    let mut state = WindowState::default();
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(true) = win.is_maximized() {
            state.maximized = true;
        }
        if let Ok(physical) = win.inner_size() {
            let sf = win.scale_factor().unwrap_or(1.0);
            state.width = physical.width as f64 / sf;
            state.height = physical.height as f64 / sf;
        }
    }
    state
}

/// Captures and immediately persists the current window geometry.
/// Used by the force-quit path, which bypasses window close events.
pub fn save_now(app: &AppHandle) {
    save(app, capture(app));
}

/// Installs persistence on the main window and applies the stored size.
/// Called from Tauri setup. The window is created with `visible: false` so we
/// can restore geometry (and maximize state) before showing it, avoiding a
/// flash of the default size.
pub fn init(app: &AppHandle) {
    let mut shown = false;
    if let Some(win) = app.get_webview_window("main") {
        let stored = load(app);
        if stored.width > 0.0 && stored.height > 0.0 {
            shown = win.set_size(LogicalSize::new(stored.width, stored.height)).is_ok();
        }
        if stored.maximized {
            let _ = win.maximize();
        }
        // Make the window visible only after geometry has been applied.
        let _ = win.show();
        let _ = win.set_focus();
    }
    // Safety net: never leave every window hidden, even if the main-window
    // lookup above failed (e.g. a different label was configured).
    if !shown {
        for (_, win) in app.webview_windows() {
            let _ = win.show();
        }
    }

    // Track changes and persist once when the window goes away.
    let app = app.clone();
    let latest = std::sync::Mutex::new(capture(&app));
    if let Some(win) = app.get_webview_window("main") {
        let app_live = app.clone();
        win.on_window_event(move |event| {
            use tauri::WindowEvent;
            match event {
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    if let Ok(mut guard) = latest.lock() {
                        *guard = capture(&app_live);
                    }
                }
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                    if let Ok(guard) = latest.lock() {
                        save(&app_live, *guard);
                    }
                }
                _ => {}
            }
        });
    }
}
