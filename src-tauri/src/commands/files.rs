use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    /// true when the file was valid UTF-8 (with or without BOM); false when
    /// content was lossily decoded from another encoding.
    pub utf8_ok: bool,
    pub byte_len: u64,
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Reads a text file from an arbitrary path chosen by the user through the
/// native dialog. Decodes UTF-8 (BOM aware); falls back to lossy decoding and
/// reports `utf8_ok == false` so the frontend can warn before saving.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    let has_bom = bytes.starts_with(UTF8_BOM);
    let start = if has_bom { UTF8_BOM.len() } else { 0 };
    let mut content = String::new();
    let utf8_ok = match std::str::from_utf8(&bytes[start..]) {
        Ok(s) => {
            content.push_str(s);
            true
        }
        Err(_) => {
            // Not valid UTF-8: decode lossily; keep the BOM if it was present.
            if has_bom {
                content.push('\u{FEFF}');
            }
            content.push_str(&String::from_utf8_lossy(&bytes[start..]));
            false
        }
    };
    Ok(FileReadResult {
        content,
        utf8_ok,
        byte_len: bytes.len() as u64,
    })
}

/// The ONLY command that writes the user's real files (manual Save / Save As).
/// Autosave snapshots never call this.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("无法写入文件：{e}"))
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}
