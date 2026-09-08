use serde::Serialize;
use std::fs;
use std::path::Path;

const BASE64_CHARS: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_CHARS[(n >> 18) as usize & 63] as char);
        out.push(BASE64_CHARS[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { BASE64_CHARS[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_CHARS[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Reads a local image file and returns its base64 payload (no mime prefix),
/// so the frontend can build a data: URL. Bypasses the asset protocol so
/// paths containing CJK/spaces/any characters work reliably.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("无法读取图片：{e}"))?;
    Ok(base64_encode(&bytes))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"\x89PNG\r\n\x1a\n"), "iVBORw0KGgo=");
    }

    #[test]
    fn read_image_base64_reads_cjk_paths() {
        // Simulate the command body over a real temp file with CJK name.
        let dir = std::env::temp_dir().join(format!("lexora-img-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let path = dir.join("截图 甲.png");
        fs::write(&path, png).unwrap();

        let payload = fs::read(&path)
            .map_err(|e| format!("无法读取图片：{e}"))
            .map(|b| base64_encode(&b))
            .unwrap();
        assert_eq!(payload, "iVBORw0KGgoBAgM=");
        let _ = fs::remove_dir_all(&dir);
    }
}
