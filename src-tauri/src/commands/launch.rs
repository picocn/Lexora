//! "Open with Lexora" support: files handed to the process on the command
//! line (double-click a `.md` in Explorer, drag onto the exe, `lexora.exe
//! notes.md`) plus files forwarded by a later launch of an already running
//! instance (see the single-instance plugin in `lib.rs`).
//!
//! Paths are never opened by the backend itself - they are queued in managed
//! state (and pushed over the `open-paths` event) so the frontend decides how
//! to place them into tabs.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager};

/// Paths this process should open, in arrival order. The frontend drains it
/// once at startup with `take_launch_paths`; anything forwarded later arrives
/// through the `open-paths` event.
pub struct LaunchPaths(pub Mutex<Vec<String>>);

impl Default for LaunchPaths {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

fn lock(slot: &LaunchPaths) -> MutexGuard<'_, Vec<String>> {
    // A panic while holding the lock must not lose the queue (and must not
    // turn every later launch into a panic of its own).
    slot.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Strips surrounding quotes and whitespace; None for empty entries.
///
/// The OS never quotes argv entries passed to a Rust process, but a
/// single-instance forwarder can hand over a raw command line, and a `.md`
/// path may legitimately contain spaces (so the shell/Explorer quotes it).
fn normalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let unquoted = match trimmed.strip_prefix('"') {
        Some(rest) => rest.strip_suffix('"').unwrap_or(rest),
        None => trimmed,
    };
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

/// True for argv entries that look like a switch rather than a file: `--flag`
/// or `/help` on Windows. A genuinely absolute path (e.g. a Unix-style
/// `/home/x.md` on a Unix build) is kept despite the leading slash.
fn is_switch(arg: &str) -> bool {
    (arg.starts_with('-') || arg.starts_with('/')) && !Path::new(arg).is_absolute()
}

/// Decides which argv entries are files to open: drops switches, keeps only
/// entries that exist and are regular files, and removes duplicates
/// case-insensitively (Windows paths differ only in case) while preserving
/// the original order and spelling.
pub fn collect_open_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in args {
        let Some(arg) = normalize(&raw) else { continue };
        if is_switch(&arg) {
            continue;
        }
        // Directories, missing files and unreadable paths are silently
        // ignored: the frontend only ever receives openable files.
        if !Path::new(&arg).is_file() {
            continue;
        }
        let key = arg.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(arg);
    }
    out
}

/// Appends `paths` to the pending queue, skipping entries already queued
/// (case-insensitive) or duplicated within `paths` itself. Returns the
/// entries actually added, in order.
fn append_pending(app: &AppHandle, paths: Vec<String>) -> Vec<String> {
    let Some(state) = app.try_state::<LaunchPaths>() else {
        return Vec::new();
    };
    let mut pending = lock(&state);
    let mut added: Vec<String> = Vec::new();
    for raw in paths {
        let Some(path) = normalize(&raw) else { continue };
        let key = path.to_lowercase();
        if pending.iter().any(|p| p.to_lowercase() == key)
            || added.iter().any(|p| p.to_lowercase() == key)
        {
            continue;
        }
        pending.push(path.clone());
        added.push(path);
    }
    added
}

/// Brings the main window back to the front (used when a second launch hands
/// over to this instance, with or without files to open).
pub fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Stores the command line of this (first) process without notifying anyone:
/// the frontend is not mounted yet and will pull the queue itself.
pub fn seed_launch_paths(app: &AppHandle, paths: Vec<String>) {
    let _ = append_pending(app, paths);
}

/// Queues paths forwarded by a second launch of the app and tells the running
/// frontend to open them, bringing the main window to the front.
pub fn push_launch_paths(app: &AppHandle, paths: Vec<String>) {
    let added = append_pending(app, paths);
    if added.is_empty() {
        return;
    }
    let _ = app.emit("open-paths", added);
    focus_main(app);
}

/// Drains the pending queue (called once by the frontend on startup).
#[tauri::command]
pub fn take_launch_paths(state: tauri::State<LaunchPaths>) -> Vec<String> {
    std::mem::take(&mut *lock(&state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lexora-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn collect_open_args_keeps_files_and_drops_everything_else() {
        let dir = temp_dir("launch");
        let file = dir.join("笔记.md");
        fs::write(&file, "# hi").unwrap();
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();

        let file_arg = file.to_string_lossy().into_owned();
        let args = vec![
            "lexora-not-a-real-file.exe".to_string(),
            "--flag".to_string(),
            "-h".to_string(),
            "/?".to_string(),
            sub.to_string_lossy().into_owned(),
            dir.join("bogus.md").to_string_lossy().into_owned(),
            String::new(),
            "   ".to_string(),
            file_arg.clone(),
        ];
        assert_eq!(collect_open_args(args), vec![file_arg.clone()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_open_args_dedupes_case_insensitively_and_unquotes() {
        let dir = temp_dir("launch-dedupe");
        let file = dir.join("Notes.md");
        fs::write(&file, "x").unwrap();
        let arg = file.to_string_lossy().into_owned();

        let args = vec![
            arg.clone(),
            format!("\"{arg}\""),
            arg.to_uppercase(),
            format!("  {arg}  "),
        ];
        assert_eq!(collect_open_args(args), vec![arg.clone()]);

        // A bare exe path (argv[0] of the forwarded command line) is a real
        // file and must be filtered by the caller, not silently opened.
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_open_args_on_empty_input_is_empty() {
        assert!(collect_open_args(Vec::new()).is_empty());
        assert!(collect_open_args(vec!["--only-a-flag".to_string()]).is_empty());
    }
}
