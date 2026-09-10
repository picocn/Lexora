//! Print support.
//!
//! The frontend renders the printable document (a self-contained HTML string)
//! and stages it here; a dedicated `print` webview window then loads the normal
//! app entry, notices its own window label, pulls the staged document once and
//! prints it. Keeping the staging in Rust means the print window needs no
//! query-string/state plumbing, and the payload never has to survive a reload.

use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Label of the print window; the frontend switches on it to render the print
/// document instead of the editor.
pub const PRINT_WINDOW_LABEL: &str = "print";

/// Hard ceiling for a staged document. Anything larger is a frontend bug
/// (an entire document is serialized), and 32 MB is far beyond a print job's
/// practical size.
pub const MAX_HTML_BYTES: usize = 32 * 1024 * 1024;

/// Sub-directory of the system temp directory used by `print_in_browser`.
pub const PRINT_TEMP_DIR: &str = "lexora-print";

/// One printable document: the window title and the fully rendered HTML.
#[derive(Clone, Serialize, Deserialize)]
pub struct PrintDoc {
    pub title: String,
    pub html: String,
}

/// Holds the document staged by the editor until the print window takes it.
pub struct PrintSlot(pub Mutex<Option<PrintDoc>>);

impl Default for PrintSlot {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn lock(slot: &PrintSlot) -> MutexGuard<'_, Option<PrintDoc>> {
    slot.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn stage_print_doc_impl(slot: &PrintSlot, title: &str, html: &str) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("打印内容为空".into());
    }
    if html.len() > MAX_HTML_BYTES {
        return Err(format!(
            "打印内容过大（超过 {} MB）",
            MAX_HTML_BYTES / 1048576
        ));
    }
    *lock(slot) = Some(PrintDoc {
        title: title.to_string(),
        html: html.to_string(),
    });
    Ok(())
}

pub fn take_print_doc_impl(slot: &PrintSlot) -> Option<PrintDoc> {
    // Take (not clone): the document can be tens of megabytes and the print
    // window only ever asks for it once.
    lock(slot).take()
}

/// Stages the document to print. The print window must already be opening (or
/// will be asked to open right after) - this only stores the payload.
#[tauri::command]
pub fn stage_print_doc(state: State<PrintSlot>, title: String, html: String) -> Result<(), String> {
    stage_print_doc_impl(&state, &title, &html)
}

/// Consumes the staged document. Returns None when nothing was staged (or a
/// previous print window already took it), so a reload cannot print twice.
#[tauri::command]
pub fn take_print_doc(state: State<PrintSlot>) -> Option<PrintDoc> {
    take_print_doc_impl(&state)
}

/// Focuses the existing print window, or creates it. The window loads the
/// normal frontend entry and detects its own label.
///
/// MUST stay `async`: a synchronous command runs on the main thread, and
/// `WebviewWindowBuilder::build()` dispatches to the main thread and waits for
/// it — called from the main thread that deadlocks the whole app (the window
/// opens blank and the UI stops responding, including its close button).
#[tauri::command]
pub async fn open_print_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        PRINT_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("打印 - Lexora")
    .inner_size(920.0, 1020.0)
    .min_inner_size(520.0, 420.0)
    .build()
    .map_err(|e| format!("无法创建打印窗口：{e}"))?;
    Ok(())
}

/// Closes the print window when present; a missing window is the success (the
/// frontend calls this after printing, and the user may have closed it first).
/// Async for the same reason as `open_print_window` (it talks to the main
/// thread from the command thread).
#[tauri::command]
pub async fn close_print_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        window
            .destroy()
            .map_err(|e| format!("无法关闭打印窗口：{e}"))?;
    }
    Ok(())
}

/// Opens the **system** print dialog for the print window's document.
///
/// This deliberately does not use `window.print()`: inside WebView2 that
/// switches the webview to Chromium's own `edge://print` preview, which is a
/// separate, undecorated page that some WebView2 runtime builds render blank
/// and cannot be dismissed (`ShowPrintUI` with the *system* dialog avoids that
/// preview entirely).
///
/// Async on purpose: `with_webview` runs its closure on the main thread and
/// waits for it, so calling this from a synchronous command (which already runs
/// on the main thread) would deadlock the app.
#[tauri::command]
pub async fn print_window_show_dialog(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(PRINT_WINDOW_LABEL)
            .ok_or_else(|| "打印窗口不存在（请重新发起打印）".to_string())?;
        let shared: std::sync::Arc<std::sync::Mutex<Result<(), String>>> = std::sync::Arc::new(
            std::sync::Mutex::new(Err("打印窗口忙或未响应（可能已有一个打印对话框打开）".into())),
        );
        let slot = std::sync::Arc::clone(&shared);
        window
            .with_webview(move |platform| {
                let outcome = show_system_print_dialog(&platform);
                if let Ok(mut guard) = slot.lock() {
                    *guard = outcome;
                }
            })
            .map_err(|e| format!("无法调度打印对话框：{e}"))?;
        shared
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }    #[cfg(not(windows))]
    {
        let _ = app;
        Err("系统打印对话框仅 Windows 支持".into())
    }
}

/// Calls `ICoreWebView2_16::ShowPrintUI` with the OS print dialog for the
/// webview hosted by `platform`. Runs on the webview's UI thread.
#[cfg(windows)]
fn show_system_print_dialog(platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows_core::Interface;

    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("无法访问打印页：{e}"))?;
    let core16: ICoreWebView2_16 = core
        .cast()
        .map_err(|e| format!("当前 WebView2 运行时不支持系统打印对话框：{e}"))?;
    unsafe { core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM) }
        .map_err(|e| format!("打开打印对话框失败：{e}"))
}

/// Writes a self-contained printable HTML file and opens it with the default
/// browser, whose print preview is a normal, closable browser dialog. Used as
/// the fallback when the WebView2 system dialog is unavailable.
#[tauri::command]
pub async fn print_in_browser(title: String, html: String) -> Result<String, String> {
    if html.trim().is_empty() {
        return Err("打印内容为空".into());
    }
    if html.len() > MAX_HTML_BYTES {
        return Err(format!("打印内容过大（超过 {} MB）", MAX_HTML_BYTES / 1048576));
    }
    let path = write_print_temp_file(&title, &html)?;
    let target = path.to_string_lossy().into_owned();
    // rundll32's FileProtocolHandler hands the file to the default browser for
    // .html without spawning a console window.
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &target])
        .spawn()
        .map_err(|e| format!("无法用默认浏览器打开打印页：{e}"))?;
    Ok(target)
}

/// Temp file that `print_in_browser` hands to the browser. The directory is
/// pruned of day-old files on every call so it cannot grow without bound.
pub fn write_print_temp_file(title: &str, html: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join(PRINT_TEMP_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建打印临时目录：{e}"))?;
    prune_print_temp_dir(&dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{}-{stamp}.html", sanitize_file_stem(title));
    let path = dir.join(name);
    std::fs::write(&path, html).map_err(|e| format!("无法写入打印临时文件：{e}"))?;
    Ok(path)
}

/// `true` when an entry is a printable temp file this command created.
fn is_print_temp_name(name: &str) -> bool {
    name.starts_with("lexora-") && name.ends_with(".html")
}

/// Removes print temp files older than a day (best effort).
fn prune_print_temp_dir(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_print_temp_name(&name) {
            continue;
        }
        let too_old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if too_old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Filesystem-safe stem for a document title (keeps CJK, drops separators).
pub fn sanitize_file_stem(title: &str) -> String {
    let mut out = String::with_capacity(title.len() + 8);
    for ch in title.chars().take(60) {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim().trim_matches('_').to_string();
    if trimmed.is_empty() {
        "lexora-print".to_string()
    } else {
        format!("lexora-{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_then_take_returns_the_document_once() {
        let slot = PrintSlot::default();
        assert!(take_print_doc_impl(&slot).is_none());

        stage_print_doc_impl(&slot, "报告", "<p>你好</p>").unwrap();
        let doc = take_print_doc_impl(&slot).expect("staged document");
        assert_eq!(doc.title, "报告");
        assert_eq!(doc.html, "<p>你好</p>");
        // Second take must be empty: a reloaded print window cannot print the
        // previous job again.
        assert!(take_print_doc_impl(&slot).is_none());

        // A new stage replaces (and is independent of) the previous one.
        stage_print_doc_impl(&slot, "a", "<b>1</b>").unwrap();
        stage_print_doc_impl(&slot, "b", "<b>2</b>").unwrap();
        let doc = take_print_doc_impl(&slot).unwrap();
        assert_eq!(doc.title, "b");
        assert_eq!(doc.html, "<b>2</b>");
    }

    #[test]
    fn stage_rejects_empty_and_oversized_html() {        let slot = PrintSlot::default();
        assert!(stage_print_doc_impl(&slot, "t", "").is_err());
        assert!(stage_print_doc_impl(&slot, "t", "   \n\t ").is_err());
        assert!(take_print_doc_impl(&slot).is_none(), "nothing was staged");

        let big = "a".repeat(MAX_HTML_BYTES + 1);
        assert!(stage_print_doc_impl(&slot, "t", &big).is_err());
        assert!(take_print_doc_impl(&slot).is_none(), "nothing was staged");

        // Exactly at the limit is still accepted.
        let at_limit = "a".repeat(MAX_HTML_BYTES);
        stage_print_doc_impl(&slot, "t", &at_limit).unwrap();
        assert_eq!(take_print_doc_impl(&slot).unwrap().html.len(), MAX_HTML_BYTES);
    }

    #[test]
    fn print_temp_stem_is_filesystem_safe() {
        assert_eq!(sanitize_file_stem("报告 v2"), "lexora-报告 v2");
        assert_eq!(sanitize_file_stem(r"a\b/c:d*e"), "lexora-a_b_c_d_e");
        assert_eq!(sanitize_file_stem("   "), "lexora-print");
        assert_eq!(sanitize_file_stem(""), "lexora-print");
    }

    #[test]
    fn print_temp_file_round_trips_and_is_named_for_pruning() {
        let path = write_print_temp_file("单元测试", "<h1>hi</h1>").unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(is_print_temp_name(&name), "unexpected name: {name}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<h1>hi</h1>");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prune_ignores_foreign_files_and_keeps_fresh_ones() {
        let dir = std::env::temp_dir().join(format!("{PRINT_TEMP_DIR}-prune-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("lexora-keep.html");
        let foreign = dir.join("someone-elses.txt");
        std::fs::write(&keep, "x").unwrap();
        std::fs::write(&foreign, "x").unwrap();
        prune_print_temp_dir(&dir);
        assert!(keep.exists(), "a fresh print file must survive pruning");
        assert!(foreign.exists(), "foreign files are never touched");
        let _ = std::fs::remove_file(&keep);
        let _ = std::fs::remove_file(&foreign);
        let _ = std::fs::remove_dir(&dir);
    }
}
