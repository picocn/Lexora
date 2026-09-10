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
#[tauri::command]
pub fn open_print_window(app: tauri::AppHandle) -> Result<(), String> {
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

/// Closes the print window when present; a missing window is a success (the
/// frontend calls this after printing, and the user may have closed it first).
#[tauri::command]
pub fn close_print_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        window
            .destroy()
            .map_err(|e| format!("无法关闭打印窗口：{e}"))?;
    }
    Ok(())
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
    fn stage_rejects_empty_and_oversized_html() {
        let slot = PrintSlot::default();
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
}
