use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::paths;

/// Directory holding autosave recovery snapshots: `<exe_dir>/autosave` when
/// portable and writable, otherwise the OS app-data dir (see `crate::paths`).
/// Autosave NEVER writes to the user's original files - only manual Save does.
pub fn snapshots_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    paths::autosave_dir(app)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    /// Original file path the tab was editing, when known.
    #[serde(default)]
    pub original_path: Option<String>,
    pub title: String,
    /// Unix epoch millis when this snapshot was written.
    pub modified_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub key: String,
    pub original_path: Option<String>,
    pub title: String,
    pub modified_at_ms: u64,
    /// First ~120 chars of content, for the recovery dialog preview.
    pub snippet: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Deterministic safe file stem for a snapshot key (docKey = file path or
/// untitled-tab id). Keeps readable chars, hashes the tail for uniqueness.
fn sanitize_stem(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.len() > 80 {
        out.truncate(80);
    }
    if out.is_empty() {
        out = "snapshot".to_string();
    }
    let hash: u32 = raw.bytes().fold(0u32, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(b as u32)
    });
    format!("{out}-{hash:x}")
}

/// Writes (or refreshes) one autosave snapshot: `<key>.md` + `<key>.meta.json`.
#[tauri::command]
pub fn snapshot_write(
    app: AppHandle,
    doc_key: String,
    content: String,
    title: String,
    original_path: Option<String>,
) -> Result<(), String> {
    let dir = snapshots_dir(&app)?;
    let stem = sanitize_stem(&doc_key);
    let content_path = dir.join(format!("{stem}.md"));
    let meta_path = dir.join(format!("{stem}.meta.json"));

    let meta = SnapshotMeta {
        original_path,
        title,
        modified_at_ms: now_ms(),
    };
    fs::write(&content_path, content).map_err(|e| format!("无法写快照：{e}"))?;
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap())
        .map_err(|e| format!("无法写快照元数据：{e}"))?;
    Ok(())
}

/// Lists all snapshots for the startup recovery dialog.
#[tauri::command]
pub fn snapshot_list(app: AppHandle) -> Result<Vec<SnapshotInfo>, String> {
    let dir = match snapshots_dir(&app) {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // File name is `<stem>.meta.json`; Path::file_stem() returns
        // `<stem>.meta`, so strip the trailing ".meta".
        let file_stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let Some(stem) = file_stem.strip_suffix(".meta") else {
            // Not a snapshot metadata file (e.g. stray json) - skip.
            continue;
        };
        let meta: Option<SnapshotMeta> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        let content_path = dir.join(format!("{stem}.md"));
        let snippet = fs::read_to_string(&content_path)
            .ok()
            .map(|c| {
                let flat: String = c.chars().take(120).collect();
                flat.replace(['\n', '\r'], " ")
            })
            .unwrap_or_default();
        if let Some(m) = meta {
            out.push(SnapshotInfo {
                key: stem.to_string(),
                original_path: m.original_path,
                title: m.title,
                modified_at_ms: m.modified_at_ms,
                snippet,
            });
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
    Ok(out)
}

/// Resolves a caller-supplied key to an existing snapshot file stem.
///
/// Two key conventions are in use, and this accepts both:
/// 1. the *already-sanitized file stem* returned by `snapshot_list`
///    (e.g. `D__a.md-1a2b3c`), or
/// 2. a raw document key (file path / untitled id) as passed to
///    `snapshot_write`, which needs sanitizing first.
fn resolve_stem(dir: &std::path::Path, key: &str) -> Option<String> {
    // Convention 1: the key is already the sanitized stem on disk.
    if dir.join(format!("{key}.md")).exists() {
        return Some(key.to_string());
    }
    // Convention 2: sanitize the raw document key like snapshot_write does.
    let stem = sanitize_stem(key);
    if dir.join(format!("{stem}.md")).exists() {
        return Some(stem);
    }
    None
}

/// Removes one snapshot (called after a manual save persisted the content, or
/// when the user discards the recovery).
#[tauri::command]
pub fn snapshot_remove(app: AppHandle, key: String) -> Result<(), String> {
    let dir = match snapshots_dir(&app) {
        Ok(d) => d,
        Err(_) => return Ok(()),
    };
    if let Some(stem) = resolve_stem(&dir, &key) {
        let _ = fs::remove_file(dir.join(format!("{stem}.md")));
        let _ = fs::remove_file(dir.join(format!("{stem}.meta.json")));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContent {
    pub content: String,
    pub original_path: Option<String>,
    pub title: String,
    pub modified_at_ms: u64,
}

/// Reads one snapshot's full content + metadata (used by the recovery dialog).
#[tauri::command]
pub fn snapshot_read(app: AppHandle, key: String) -> Result<SnapshotContent, String> {
    let dir = match snapshots_dir(&app) {
        Ok(d) => d,
        Err(_) => return Err("快照目录不可用".into()),
    };
    let stem = resolve_stem(&dir, &key).ok_or_else(|| "未找到对应快照".to_string())?;
    let content = fs::read_to_string(dir.join(format!("{stem}.md")))
        .map_err(|e| format!("无法读取快照内容：{e}"))?;
    let meta_path = dir.join(format!("{stem}.meta.json"));
    let meta: Option<SnapshotMeta> = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(SnapshotContent {
        content,
        original_path: meta.as_ref().and_then(|m| m.original_path.clone()),
        title: meta.as_ref().map(|m| m.title.clone()).unwrap_or_else(|| "未命名".into()),
        modified_at_ms: meta.map(|m| m.modified_at_ms).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_stem_handles_cjk_spaces_and_slashes() {
        let raw = "D:\\资料 夹\\报告 (1).md";
        let stem = sanitize_stem(raw);
        assert!(!stem.contains('\\'));
        assert!(!stem.contains(' '));
        assert!(!stem.contains('('));
        assert!(!stem.contains(')'));
        assert!(stem.contains(".md-"), "stem was {stem}");
        // Deterministic: stable across calls.
        assert_eq!(stem, sanitize_stem(raw));
    }

    #[test]
    fn sanitize_stem_is_deterministic_and_unique() {
        let a = sanitize_stem("a/b/c");
        let b = sanitize_stem("a/b/c");
        assert_eq!(a, b, "same input must give same stem");
        // Different raw inputs whose normalized stems collide must still differ
        // because the hash is computed over the raw string.
        let c = sanitize_stem("a_b_c");
        assert_ne!(a, c, "hash tail must disambiguate collisions");
    }

    #[test]
    fn sanitize_stem_empty_falls_back() {
        assert!(sanitize_stem("").starts_with("snapshot-"));
    }

    #[test]
    fn resolve_stem_matches_list_key_and_raw_dockey() {
        // Simulate: write uses sanitize(rawDocKey); list returns that stem.
        let dir = std::env::temp_dir().join("mdpad-snap-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let raw_key = "D:\\notes 夹\\报告.md";
        let stem = sanitize_stem(raw_key);
        fs::write(dir.join(format!("{stem}.md")), "hello").unwrap();
        fs::write(dir.join(format!("{stem}.meta.json")), "{}").unwrap();

        // 1) The stem as returned by snapshot_list must resolve as-is.
        assert_eq!(
            resolve_stem(&dir, &stem).as_deref(),
            Some(stem.as_str()),
            "list key must resolve without re-sanitizing"
        );
        // 2) A raw document key (like frontend passes after manual save) must
        // also resolve through sanitization.
        assert_eq!(
            resolve_stem(&dir, raw_key).as_deref(),
            Some(stem.as_str()),
            "raw docKey must resolve via sanitize fallback"
        );
        // 3) Unknown keys resolve to None.
        assert_eq!(resolve_stem(&dir, "does-not-exist"), None);

        let _ = fs::remove_dir_all(&dir);
    }
}
