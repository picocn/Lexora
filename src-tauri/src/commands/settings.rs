use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::paths;

pub const SETTINGS_FILE: &str = "settings.json";

/// Deserializes a positive integer accepting either an integer or a float
/// (the settings dialog's number inputs can transiently produce e.g. "14.5"
/// or "0." while typing; floats are rounded instead of rejecting the payload).
fn de_uint<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    struct V;
    impl serde::de::Visitor<'_> for V {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a non-negative number")
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<u64, E> {
            Ok(v)
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<u64, E> {
            Ok(v.max(0) as u64)
        }
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<u64, E> {
            if v.is_finite() && v >= 0.0 {
                Ok(v.round() as u64)
            } else {
                Err(E::custom("负数或非法数字"))
            }
        }
    }
    d.deserialize_any(V)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Seconds between autosave ticks.
    #[serde(default, deserialize_with = "de_uint")]
    pub interval_sec: u64,
}

impl Default for AutosaveSettings {
    fn default() -> Self {
        AutosaveSettings { enabled: true, interval_sec: 5 }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default)]
    pub font_family: String,
    #[serde(default, deserialize_with = "de_uint")]
    pub font_size: u64,
    #[serde(default)]
    pub line_height: f64,
    #[serde(default, deserialize_with = "de_uint")]
    pub tab_size: u64,
    #[serde(default)]
    pub word_wrap: bool,
    #[serde(default)]
    pub line_numbers: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_family: "Consolas, 'Courier New', 'Sarasa Mono SC', monospace".into(),
            font_size: 15,
            line_height: 1.6,
            tab_size: 4,
            word_wrap: false,
            line_numbers: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSettings {
    #[serde(default)]
    pub font_family: String,
    #[serde(default, deserialize_with = "de_uint")]
    pub font_size: u64,
}

impl Default for PreviewSettings {
    fn default() -> Self {
        PreviewSettings {
            font_family: "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif".into(),
            font_size: 15,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    /// "builtin" | "vscode"
    #[serde(default)]
    pub kind: String,
    /// builtin: "light" | "dark"; vscode: theme file stem
    #[serde(default)]
    pub id: String,
}

impl Default for ThemeSettings {
    fn default() -> Self {
        ThemeSettings { kind: "builtin".into(), id: "light".into() }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilesSettings {
    /// Poll opened files for outside modifications and offer a reload.
    #[serde(default = "default_true")]
    pub watch_external: bool,
}

fn default_true() -> bool {
    true
}

impl Default for FilesSettings {
    fn default() -> Self {
        FilesSettings { watch_external: true }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub autosave: AutosaveSettings,
    #[serde(default)]
    pub files: FilesSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub preview: PreviewSettings,
    #[serde(default)]
    pub theme: ThemeSettings,
    /// "split" | "edit" | "preview"
    #[serde(default)]
    pub layout: String,
    /// Most recently opened files (most recent first), max 20.
    #[serde(default)]
    pub recent_files: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            autosave: AutosaveSettings::default(),
            files: FilesSettings::default(),
            editor: EditorSettings::default(),
            preview: PreviewSettings::default(),
            theme: ThemeSettings::default(),
            layout: "edit".into(),
            recent_files: Vec::new(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths::settings_dir(app)?.join(SETTINGS_FILE))
}

/// Recursively overlays `over` onto `base` (objects merge key-by-key; any
/// non-object value in `over` replaces the base). Used to merge stored
/// settings over the defaults so missing fields keep their default values.
fn merge_json(base: &serde_json::Value, over: &serde_json::Value) -> serde_json::Value {
    match (base, over) {
        (serde_json::Value::Object(b), serde_json::Value::Object(o)) => {
            let mut m = b.clone();
            for (k, v) in o {
                let existing = m.get(k).cloned().unwrap_or(serde_json::Value::Null);
                m.insert(k.clone(), merge_json(&existing, v));
            }
            serde_json::Value::Object(m)
        }
        _ => over.clone(),
    }
}

#[tauri::command]
pub fn read_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("无法读取设置：{e}"))?;
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    // True merge with defaults: overlay the stored JSON onto a full default
    // object, so fields added in newer versions (or hand-edited-away keys)
    // always exist after deserialization. Field-level #[serde(default)] alone
    // would fill scalars with 0/false instead of the documented defaults.
    let stored_val: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("设置文件损坏：{e}"))?;
    let default_val = serde_json::to_value(AppSettings::default()).map_err(|e| e.to_string())?;
    let merged = merge_json(&default_val, &stored_val);
    let stored: AppSettings =
        serde_json::from_value(merged).map_err(|e| format!("设置文件损坏：{e}"))?;
    // Validation / clamping of present (or defaulted) values.
    let def = AppSettings::default();
    Ok(AppSettings {
        autosave: AutosaveSettings {
            enabled: stored.autosave.enabled,
            interval_sec: stored.autosave.interval_sec.max(1),
        },
        editor: EditorSettings {
            font_family: if stored.editor.font_family.is_empty() {
                def.editor.font_family
            } else {
                stored.editor.font_family
            },
            font_size: stored.editor.font_size.max(8),
            line_height: stored.editor.line_height.max(1.0),
            tab_size: stored.editor.tab_size.clamp(1, 16),
            word_wrap: stored.editor.word_wrap,
            line_numbers: stored.editor.line_numbers,
        },
        preview: PreviewSettings {
            font_family: if stored.preview.font_family.is_empty() {
                def.preview.font_family
            } else {
                stored.preview.font_family
            },
            font_size: stored.preview.font_size.max(8),
        },
        theme: stored.theme,
        layout: if ["split", "edit", "preview"].contains(&stored.layout.as_str()) {
            stored.layout
        } else {
            def.layout
        },
        files: FilesSettings { watch_external: stored.files.watch_external },
        recent_files: stored.recent_files.into_iter().take(20).collect(),
    })
}

#[tauri::command]
pub fn write_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    paths::atomic_write_text(&path, &json).map_err(|e| format!("无法写设置：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let d = AppSettings::default();
        assert!(d.autosave.enabled);
        assert_eq!(d.autosave.interval_sec, 5);
        assert_eq!(d.editor.font_size, 15);
        assert!(d.recent_files.is_empty());
    }

    #[test]
    fn layout_validation_helper() {
        let def = AppSettings::default();
        assert_eq!(def.layout, "edit");
        assert!(["split", "edit", "preview"].contains(&def.layout.as_str()));
    }

    /// Parses raw JSON exactly like `read_settings` does (defaults merged in).
    fn parse_like_read(raw: &str) -> AppSettings {
        let stored: serde_json::Value = serde_json::from_str(raw).unwrap();
        let default = serde_json::to_value(AppSettings::default()).unwrap();
        serde_json::from_value(merge_json(&default, &stored)).unwrap()
    }

    #[test]
    fn missing_fields_fall_back_to_defaults_on_parse() {
        // An older/partial settings file must parse, filling in defaults.
        let raw = r#"{
          "autosave": { "enabled": false },
          "editor": { "fontSize": 18, "tabSize": 2 },
          "layout": "split"
        }"#;
        let s = parse_like_read(raw);
        assert!(!s.autosave.enabled);
        assert_eq!(s.autosave.interval_sec, 5, "interval must default");
        assert_eq!(s.editor.font_size, 18);
        assert_eq!(s.editor.tab_size, 2);
        assert!(s.editor.line_numbers, "missing bool must default to true");
        assert!(!s.editor.word_wrap);
        assert_eq!(s.preview.font_family, PreviewSettings::default().font_family);
        assert_eq!(s.theme.kind, "builtin");
        assert_eq!(s.layout, "split");
        assert!(s.recent_files.is_empty());
        assert!(s.files.watch_external, "missing files section must default to watching");
    }

    #[test]
    fn files_settings_round_trips_and_can_be_disabled() {
        let raw = r#"{ "files": { "watchExternal": false } }"#;
        let s = parse_like_read(raw);
        assert!(!s.files.watch_external);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"watchExternal\":false"));
    }

    #[test]
    fn fractional_numbers_are_rounded_not_rejected() {
        // The settings UI may transiently send floats like 14.5 or 0.
        let raw = r#"{
          "editor": { "fontSize": 14.5, "tabSize": 0.0 },
          "preview": { "fontSize": 15.6 },
          "autosave": { "intervalSec": 5.4 }
        }"#;
        let s = parse_like_read(raw);
        assert_eq!(s.editor.font_size, 15); // 14.5 rounds
        assert_eq!(s.editor.tab_size, 0);
        assert_eq!(s.preview.font_size, 16);
        assert_eq!(s.autosave.interval_sec, 5);
    }

    #[test]
    fn merge_json_overlays_deeply_and_keeps_unknown_handles() {
        let base: serde_json::Value =
            serde_json::from_str(r#"{"a": {"x": 1, "y": 2}, "b": "keep"}"#).unwrap();
        let over: serde_json::Value =
            serde_json::from_str(r#"{"a": {"y": 9, "z": 3}}"#).unwrap();
        let merged = merge_json(&base, &over);
        assert_eq!(merged["a"]["x"], 1);
        assert_eq!(merged["a"]["y"], 9);
        assert_eq!(merged["a"]["z"], 3);
        assert_eq!(merged["b"], "keep");
    }
}
