use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::paths;

/// Rejects absurdly large "images" before they are read into memory.
const MAX_IMAGE_BYTES: u64 = 40 * 1024 * 1024;
/// Hard ceiling for any text file read (beyond this the frontend's own 20/64MB
/// policies can't protect us - refuse up-front instead of OOMing on fs::read).
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;

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
/// paths containing CJK/spaces/any characters work reliably. Size-capped and
/// regular-file gated so hostile references cannot block a worker or force
/// unbounded memory use.
#[tauri::command]
pub async fn read_image_base64(path: String) -> Result<String, String> {
    read_image_base64_impl(&path)
}

fn read_image_base64_impl(path: &str) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("无法读取图片：{e}"))?;
    if !meta.file_type().is_file() {
        return Err("不是常规文件，无法读取图片".to_string());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("图片文件过大（超过 40 MB）".to_string());
    }
    let bytes = fs::read(path).map_err(|e| format!("无法读取图片：{e}"))?;
    Ok(base64_encode(&bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub content: String,
    /// true when the file was valid UTF-8 (with or without BOM); false when
    /// content was lossily decoded from another encoding.
    pub utf8_ok: bool,
    /// true when the file started with a UTF-8 BOM (frontend re-adds it on a
    /// same-file manual save so plain saves don't silently drop the BOM).
    pub utf8_bom: bool,
    pub byte_len: u64,
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF32_LE_BOM: &[u8] = &[0xFF, 0xFE, 0x00, 0x00];
const UTF32_BE_BOM: &[u8] = &[0x00, 0x00, 0xFE, 0xFF];
const UTF16_LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16_BE_BOM: &[u8] = &[0xFE, 0xFF];

/// Reads a text file from an arbitrary path chosen by the user through the
/// native dialog. Decodes UTF-8 (BOM aware). UTF-16/32 files are rejected
/// with guidance instead of being decoded into mojibake; other non-UTF-8
/// encodings decode lossily and report `utf8_ok == false` so the frontend can
/// refuse to overwrite the original without explicit user action (另存为).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<FileReadResult, String> {
    read_text_file_impl(&path)
}

fn read_text_file_impl(path: &str) -> Result<FileReadResult, String> {
    let meta = fs::metadata(path).map_err(|e| format!("无法读取文件：{e}"))?;
    if !meta.file_type().is_file() {
        return Err("不是常规文件，无法读取".to_string());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("文件过大（超过 {} MB）", MAX_TEXT_BYTES / 1048576));
    }
    let bytes = fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
    let (body, utf8_bom) = if bytes.starts_with(UTF8_BOM) {
        (&bytes[UTF8_BOM.len()..], true)
    } else if bytes.starts_with(UTF32_LE_BOM) || bytes.starts_with(UTF32_BE_BOM) {
        return Err("文件是 UTF-32 编码，暂不支持直接编辑；请先另存为 UTF-8 编码再打开。".into());
    } else if bytes.starts_with(UTF16_LE_BOM) || bytes.starts_with(UTF16_BE_BOM) {
        return Err("文件是 UTF-16 编码，暂不支持直接编辑；请先另存为 UTF-8 编码再打开。".into());
    } else {
        (bytes.as_slice(), false)
    };
    let (content, utf8_ok) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), true),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), false),
    };
    Ok(FileReadResult {
        content,
        utf8_ok,
        utf8_bom,
        byte_len: bytes.len() as u64,
    })
}

/// The ONLY command that writes the user's real files (manual Save / Save As).
/// Autosave snapshots never call this. Writes atomically so a crash mid-save
/// cannot truncate the original file.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    write_text_file_impl(&path, &content)
}

fn write_text_file_impl(path: &str, content: &str) -> Result<(), String> {
    paths::atomic_write_text(Path::new(path), content).map_err(|e| format!("无法写入文件：{e}"))
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

    #[test]
    fn read_text_file_strips_utf8_bom_and_reports_it() {
        let dir = std::env::temp_dir().join(format!("lexora-txt-bom-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("带BOM.md");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("你好 world".as_bytes());
        fs::write(&p, &bytes).unwrap();

        let r = read_text_file_impl(&p.to_string_lossy()).unwrap();
        assert!(r.utf8_ok);
        assert!(r.utf8_bom);
        assert_eq!(r.content, "你好 world");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_file_lossy_decodes_non_utf8_without_bom() {
        let dir = std::env::temp_dir().join(format!("lexora-txt-gbk-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("gbk.md");
        // GBK bytes for 中文 - invalid as UTF-8.
        fs::write(&p, [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();
        let r = read_text_file_impl(&p.to_string_lossy()).unwrap();
        assert!(!r.utf8_ok);
        assert!(!r.utf8_bom);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_file_rejects_utf16_and_utf32() {
        let dir = std::env::temp_dir().join(format!("lexora-txt-enc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // UTF-16 LE with BOM.
        let p16 = dir.join("u16.md");
        fs::write(&p16, [0xFF, 0xFE, b'a', 0x00, b'b', 0x00]).unwrap();
        assert!(read_text_file_impl(&p16.to_string_lossy()).is_err());
        // UTF-32 LE with BOM.
        let p32 = dir.join("u32.md");
        fs::write(&p32, [0xFF, 0xFE, 0x00, 0x00, b'a', 0x00, 0x00, 0x00]).unwrap();
        assert!(read_text_file_impl(&p32.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_text_file_is_atomic_and_replaces_existing() {
        let dir = std::env::temp_dir().join(format!("lexora-write-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("out.md");
        fs::write(&p, "old").unwrap();
        write_text_file_impl(&p.to_string_lossy(), "新的内容").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "新的内容");
        // No temp leftovers.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
