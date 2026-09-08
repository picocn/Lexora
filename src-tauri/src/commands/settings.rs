use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::paths;

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveSettings {
    pub enabled: bool,
    /// Seconds between autosave ticks.
    pub interval_sec: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: u64,
    pub line_height: f64,
    pub tab_size: u64,
    pub word_wrap: bool,
    pub line_numbers: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSettings {
    pub font_family: String,
    pub font_size: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    /// "builtin" | "vscode"
    pub kind: String,
    /// builtin: "light" | "dark"; vscode: theme file stem
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub autosave: AutosaveSettings,
    pub editor: EditorSettings,
    pub preview: PreviewSettings,
    pub theme: ThemeSettings,
    /// "split" | "edit" | "preview"
    pub layout: String,
    /// Most recently opened files (most recent first), max 10.
    pub recent_files: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            autosave: AutosaveSettings {
                enabled: true,
                interval_sec: 5,
            },
            editor: EditorSettings {
                font_family: "Consolas, 'Courier New', 'Sarasa Mono SC', monospace".into(),
                font_size: 15,
                line_height: 1.6,
                tab_size: 4,
                word_wrap: false,
                line_numbers: true,
            },
            preview: PreviewSettings {
                font_family: "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif".into(),
                font_size: 15,
            },
            theme: ThemeSettings {
                kind: "builtin".into(),
                id: "light".into(),
            },
            layout: "edit".into(),
            recent_files: Vec::new(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths::settings_dir(app)?.join(SETTINGS_FILE))
}

#[tauri::command]
pub fn read_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("无法读取设置：{e}"))?;
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    let stored: AppSettings =
        serde_json::from_str(raw).map_err(|e| format!("设置文件损坏：{e}"))?;
    // Merge with defaults so newly added fields always exist.
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
        recent_files: stored.recent_files.into_iter().take(10).collect(),
    })
}

#[tauri::command]
pub fn write_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("无法写设置：{e}"))
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
}
