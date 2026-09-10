//! Windows ".md -> Lexora" integration: default-app registration for markdown
//! files.
//!
//! Everything lives under `HKCU\Software\Classes`, so registering never needs
//! an administrator prompt and never touches a machine-wide (HKLM) setting.
//! The registry is driven through `reg.exe` with `CREATE_NO_WINDOW`, so no
//! console window flashes at the user while registering.
//!
//! The work is split in two: a pure *plan* (`register_plan` / `unregister_plan`
//! -> `Vec<RegOp>`) that is fully unit-tested, and a thin executor that turns
//! each op into a `reg.exe` call. Plans are built before anything runs, so a
//! mid-way failure never leaves a half-written plan behind silently.

#![cfg(windows)]

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;

/// ProgID owned by this app. `HKCU\Software\Classes\Lexora.md` and the `.md`
/// default value both point at it.
pub const PROG_ID: &str = "Lexora.md";

/// Key name under `HKCU\Software\Classes\Applications` (Explorer's "Open with"
/// list is keyed by executable file name).
const APP_KEY_NAME: &str = "lexora.exe";

const CLASSES: &str = "HKCU\\Software\\Classes";
/// User's explicit "always open with" choice; Explorer writes it and it wins
/// over our ProgID, which is why it is reported separately by `assoc_status`.
const USER_CHOICE_KEY: &str =
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice";

/// `CREATE_NO_WINDOW`: keeps every reg.exe/cmd.exe child headless.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One registry mutation, in a form that is easy to test and easy to run.
pub enum RegOp {
    /// `reg add <key> [/v name | /ve] /d <data> /f`
    Add {
        key: String,
        /// `Some(name)` for a named value, `None` for the key's default value.
        value: Option<String>,
        data: String,
    },
    /// `reg delete <key> /f`
    DeleteKey { key: String },
    /// `reg delete <key> [/v name | /ve] /f`; an empty `value` targets the
    /// key's default value.
    DeleteValue { key: String, value: String },
}

/// Translates an op into `reg.exe` arguments. Each element is one argv entry -
/// no shell is involved, so quotes, spaces and `%1` are passed through
/// verbatim (the `%1` placeholder must survive for Explorer to substitute the
/// opened file).
pub fn to_argv(op: &RegOp) -> Vec<String> {
    match op {
        RegOp::Add { key, value, data } => {
            let mut argv = vec!["add".to_string(), key.clone()];
            match value {
                Some(name) => {
                    argv.push("/v".to_string());
                    argv.push(name.clone());
                }
                None => argv.push("/ve".to_string()),
            }
            argv.push("/d".to_string());
            argv.push(data.clone());
            argv.push("/f".to_string());
            argv
        }
        RegOp::DeleteKey { key } => vec!["delete".to_string(), key.clone(), "/f".to_string()],
        RegOp::DeleteValue { key, value } => {
            let mut argv = vec!["delete".to_string(), key.clone()];
            if value.is_empty() {
                argv.push("/ve".to_string());
            } else {
                argv.push("/v".to_string());
                argv.push(value.clone());
            }
            argv.push("/f".to_string());
            argv
        }
    }
}

fn default_icon(exe: &str) -> String {
    format!("\"{exe}\",0")
}

fn open_command(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

fn prog_id_key() -> String {
    format!("{CLASSES}\\{PROG_ID}")
}

fn app_key() -> String {
    format!("{CLASSES}\\Applications\\{APP_KEY_NAME}")
}

/// The full per-user registration: our ProgID (icon, verb, command), the `.md`
/// extension mapping, and the `Applications\lexora.exe` entry that feeds the
/// "Open with" picker.
pub fn register_plan(exe: &str) -> Vec<RegOp> {
    let prog = prog_id_key();
    let app = app_key();
    let add = |key: String, value: Option<String>, data: String| RegOp::Add { key, value, data };
    vec![
        add(prog.clone(), None, "Markdown 文档".to_string()),
        add(
            format!("{prog}\\DefaultIcon"),
            None,
            default_icon(exe),
        ),
        add(
            format!("{prog}\\shell\\open"),
            None,
            "打开(&O)".to_string(),
        ),
        add(
            format!("{prog}\\shell\\open\\command"),
            None,
            open_command(exe),
        ),
        add(format!("{CLASSES}\\.md"), None, PROG_ID.to_string()),
        add(
            format!("{app}\\shell\\open\\command"),
            None,
            open_command(exe),
        ),
        add(
            format!("{app}\\SupportedTypes"),
            Some(".md".to_string()),
            String::new(),
        ),
        add(format!("{app}\\FriendlyAppName"), None, "Lexora".to_string()),
        add(format!("{app}\\DefaultIcon"), None, default_icon(exe)),
    ]
}

/// Removes everything `register_plan` created.
///
/// The `exe` argument is part of the symmetric API but unused on purpose:
/// unregistering must not depend on knowing where the app currently lives.
///
/// The `.md` default value is only deleted when it still names our ProgID;
/// whether that is the case is decided by the executor (it needs a registry
/// query), which is why the op is always part of the plan.
pub fn unregister_plan(_exe: &str) -> Vec<RegOp> {
    vec![
        RegOp::DeleteKey {
            key: prog_id_key(),
        },
        RegOp::DeleteKey { key: app_key() },
        RegOp::DeleteValue {
            key: format!("{CLASSES}\\.md"),
            value: String::new(),
        },
    ]
}

/// Pulls the data of the first `REG_SZ`-style line out of `reg.exe query`
/// output, e.g.
///
/// ```text
/// HKEY_CURRENT_USER\Software\Classes\.md
///     (默认)    REG_SZ    Lexora.md
/// ```
///
/// The value *name* column is localised (`(Default)` / `(默认)`), so parsing
/// keys off the type token instead.
///
/// An existing key whose default value was never written prints a localised
/// placeholder in the data column and still exits 0, e.g.
///
/// ```text
/// HKEY_CURRENT_USER\Software\Classes\.md
///     (Default)    REG_SZ    (value not set)
/// ```
///
/// That placeholder means "not set" and must not be reported as data (the
/// wording is localised, so *any* fully parenthesised data is treated as
/// unset - no real ProgID or `shell\open\command` value looks like that).
/// None is returned for a missing key, a missing value, or a placeholder.
fn parse_reg_sz(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        for tag in ["REG_SZ", "REG_EXPAND_SZ"] {
            let Some(idx) = line.find(tag) else { continue };
            let data = line[idx + tag.len()..].trim();
            if data.starts_with('(') && data.ends_with(')') {
                return None;
            }
            return Some(data.to_string());
        }
    }
    None
}

/// Reads a value with `reg.exe query`. Unreadable, missing or empty values are
/// all reported as None - a missing key is not an error condition here.
fn reg_query(key: &str, value: Option<&str>) -> Option<String> {
    let mut argv = vec!["query".to_string(), key.to_string()];
    match value {
        Some(name) => {
            argv.push("/v".to_string());
            argv.push(name.to_string());
        }
        None => argv.push("/ve".to_string()),
    }
    let output = Command::new("reg.exe")
        .args(&argv)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_reg_sz(&String::from_utf8_lossy(&output.stdout))
}

/// Currently registered default ProgID for `.md`, when readable.
pub fn md_default_progid() -> Option<String> {
    reg_query(&format!("{CLASSES}\\.md"), None)
}

fn current_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether a stored `shell\open\command` value points at `exe`. Compared
/// case-insensitively because a path can be spelled with different case.
fn command_points_to(command: &str, exe: &str) -> bool {
    command.trim().eq_ignore_ascii_case(open_command(exe).as_str())
}

/// Register state reported to the frontend. Everything here is best-effort
/// readable: an unreadable registry is "not registered", never an error.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssocStatus {
    /// Full path of the running executable (`""` when it cannot be resolved).
    pub exe_path: String,
    pub prog_id: String,
    /// Our ProgID is written and its open command points at this executable.
    pub registered: bool,
    /// Current default ProgID of `.md`, or None when unset/unreadable.
    pub md_default: Option<String>,
    /// `.md` currently maps to our ProgID.
    pub md_points_to_us: bool,
    /// User's explicit "always open with" pick (Explorer's UserChoice), which
    /// takes precedence over anything we register.
    pub user_choice: Option<String>,
    /// Platform capability flag (always true on Windows).
    pub supported: bool,
}

/// Reads the current state without changing anything.
pub fn assoc_status_impl() -> AssocStatus {
    let exe_path = current_exe_path();
    let md_default = md_default_progid();
    let registered = reg_query(
        &format!("{}\\shell\\open\\command", prog_id_key()),
        None,
    )
    .map(|cmd| command_points_to(&cmd, &exe_path))
    .unwrap_or(false);
    AssocStatus {
        md_points_to_us: md_default
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case(PROG_ID))
            .unwrap_or(false),
        exe_path,
        prog_id: PROG_ID.to_string(),
        registered,
        md_default,
        user_choice: reg_query(USER_CHOICE_KEY, Some("ProgId")),
        supported: true,
    }
}

/// Runs one op, surfacing a real `reg.exe` failure.
fn run_op(op: &RegOp) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(to_argv(op))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法调用注册表命令：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            "未知错误"
        } else {
            detail
        };
        return Err(format!("注册表写入失败：{detail}"));
    }
    Ok(())
}

/// Runs a deletion op. Deleting something that is already gone counts as
/// success; only being unable to run `reg.exe` at all is reported.
fn run_cleanup(op: &RegOp) -> Result<(), String> {
    Command::new("reg.exe")
        .args(to_argv(op))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|_| ())
        .map_err(|e| format!("无法调用注册表命令：{e}"))
}

#[tauri::command]
pub fn assoc_status() -> AssocStatus {
    assoc_status_impl()
}

/// Writes the per-user `.md` association and returns the new state.
#[tauri::command]
pub fn register_md_association() -> Result<AssocStatus, String> {
    let exe = current_exe_path();
    if exe.is_empty() {
        return Err("无法定位程序路径，关联未生效".into());
    }
    for op in register_plan(&exe) {
        run_op(&op)?;
    }
    Ok(assoc_status_impl())
}

/// Removes the per-user `.md` association and returns the new state.
#[tauri::command]
pub fn unregister_md_association() -> Result<AssocStatus, String> {
    let exe = current_exe_path();
    // Query first: give `.md` back only when it is still ours. If another app
    // (or the user's own choice) owns it, its default value stays untouched.
    let md_is_ours = md_default_progid()
        .map(|v| v.eq_ignore_ascii_case(PROG_ID))
        .unwrap_or(false);
    for op in unregister_plan(&exe) {
        if !md_is_ours && matches!(op, RegOp::DeleteValue { .. }) {
            continue;
        }
        run_cleanup(&op)?;
    }
    Ok(assoc_status_impl())
}

/// Opens the Windows "默认应用" settings page, where the user can finish the
/// choice Explorer's UserChoice hash requires a human for.
#[tauri::command]
pub fn open_default_apps_settings() -> Result<(), String> {
    Command::new("cmd")
        .args(["/c", "start", "", "ms-settings:defaultapps"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("无法打开系统设置：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "C:\\Program Files\\Lexora\\lexora.exe";

    fn argv_strings(op: &RegOp) -> Vec<String> {
        to_argv(op)
    }

    #[test]
    fn to_argv_add_default_value_is_shell_free_and_keeps_placeholders() {
        let op = RegOp::Add {
            key: format!("{CLASSES}\\{PROG_ID}\\shell\\open\\command"),
            value: None,
            data: open_command(EXE),
        };
        assert_eq!(
            argv_strings(&op),
            vec![
                "add",
                "HKCU\\Software\\Classes\\Lexora.md\\shell\\open\\command",
                "/ve",
                "/d",
                "\"C:\\Program Files\\Lexora\\lexora.exe\" \"%1\"",
                "/f",
            ]
        );
        // The command value is one argv entry: quotes and `%1` reach reg.exe
        // verbatim (nothing re-parses or strips them).
        let argv = argv_strings(&op);
        assert_eq!(argv.len(), 6);
        assert!(argv[4].contains("%1"));
        assert!(argv[4].starts_with('"'));
    }

    #[test]
    fn to_argv_add_named_value_passes_empty_data() {
        let op = RegOp::Add {
            key: format!("{CLASSES}\\Applications\\lexora.exe\\SupportedTypes"),
            value: Some(".md".to_string()),
            data: String::new(),
        };
        assert_eq!(
            argv_strings(&op),
            vec![
                "add",
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\SupportedTypes",
                "/v",
                ".md",
                "/d",
                "",
                "/f",
            ]
        );
    }

    #[test]
    fn to_argv_uses_ve_for_a_delete_of_an_empty_value_name() {
        assert_eq!(
            argv_strings(&RegOp::DeleteKey {
                key: "HKCU\\Software\\Classes\\Lexora.md".to_string()
            }),
            vec!["delete", "HKCU\\Software\\Classes\\Lexora.md", "/f"]
        );
        assert_eq!(
            argv_strings(&RegOp::DeleteValue {
                key: "HKCU\\Software\\Classes\\.md".to_string(),
                value: String::new(),
            }),
            vec!["delete", "HKCU\\Software\\Classes\\.md", "/ve", "/f"]
        );
        assert_eq!(
            argv_strings(&RegOp::DeleteValue {
                key: "HKCU\\Software\\Classes\\Applications\\lexora.exe\\SupportedTypes"
                    .to_string(),
                value: ".md".to_string(),
            }),
            vec![
                "delete",
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\SupportedTypes",
                "/v",
                ".md",
                "/f"
            ]
        );
    }

    #[test]
    fn register_plan_covers_the_documented_keys_and_values() {
        let plan = register_plan(EXE);
        let pairs: Vec<(String, Option<String>, String)> = plan
            .iter()
            .map(|op| match op {
                RegOp::Add { key, value, data } => (key.clone(), value.clone(), data.clone()),
                other => panic!("unexpected non-Add op: {:?}", argv_strings(other)),
            })
            .collect();

        assert_eq!(pairs.len(), 9, "full registration is 9 values");
        assert_eq!(
            pairs[0],
            (
                "HKCU\\Software\\Classes\\Lexora.md".to_string(),
                None,
                "Markdown 文档".to_string()
            )
        );
        assert_eq!(
            pairs[1],
            (
                "HKCU\\Software\\Classes\\Lexora.md\\DefaultIcon".to_string(),
                None,
                format!("\"{EXE}\",0")
            )
        );
        assert_eq!(pairs[2].2, "打开(&O)");
        assert_eq!(
            pairs[3],
            (
                "HKCU\\Software\\Classes\\Lexora.md\\shell\\open\\command".to_string(),
                None,
                format!("\"{EXE}\" \"%1\"")
            )
        );
        assert_eq!(
            pairs[4],
            (
                "HKCU\\Software\\Classes\\.md".to_string(),
                None,
                "Lexora.md".to_string()
            )
        );
        assert_eq!(
            pairs[5],
            (
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\shell\\open\\command"
                    .to_string(),
                None,
                format!("\"{EXE}\" \"%1\"")
            )
        );
        assert_eq!(
            pairs[6],
            (
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\SupportedTypes".to_string(),
                Some(".md".to_string()),
                String::new()
            )
        );
        assert_eq!(
            pairs[7],
            (
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\FriendlyAppName".to_string(),
                None,
                "Lexora".to_string()
            )
        );
        assert_eq!(
            pairs[8],
            (
                "HKCU\\Software\\Classes\\Applications\\lexora.exe\\DefaultIcon".to_string(),
                None,
                format!("\"{EXE}\",0")
            )
        );

        // Every key touched is per-user; nothing may need admin rights.
        for (key, _, _) in &pairs {
            assert!(key.starts_with("HKCU\\"), "key escapes HKCU: {key}");
        }
    }

    #[test]
    fn unregister_plan_drops_the_progid_app_key_and_md_mapping() {
        let plan = unregister_plan(EXE);
        assert_eq!(plan.len(), 3);
        assert!(matches!(
            &plan[0],
            RegOp::DeleteKey { key } if key == "HKCU\\Software\\Classes\\Lexora.md"
        ));
        assert!(matches!(
            &plan[1],
            RegOp::DeleteKey { key } if key == "HKCU\\Software\\Classes\\Applications\\lexora.exe"
        ));
        assert!(matches!(
            &plan[2],
            RegOp::DeleteValue { key, value }
                if key == "HKCU\\Software\\Classes\\.md" && value.is_empty()
        ));
    }

    #[test]
    fn parse_reg_sz_reads_the_default_value_line() {
        let en = "HKEY_CURRENT_USER\\Software\\Classes\\.md\r\n    (Default)    REG_SZ    Lexora.md\r\n";
        assert_eq!(parse_reg_sz(en).as_deref(), Some("Lexora.md"));
        let zh = "HKEY_CURRENT_USER\\Software\\Classes\\.md\r\n    (默认)    REG_SZ    Lexora.md\r\n\r\n";
        assert_eq!(parse_reg_sz(zh).as_deref(), Some("Lexora.md"));
        let expand = "    (Default)    REG_EXPAND_SZ    %SystemRoot%\\notepad.exe\r\n";
        assert_eq!(
            parse_reg_sz(expand).as_deref(),
            Some("%SystemRoot%\\notepad.exe")
        );
        // A named value (used for Explorer's UserChoice ProgId), as printed on
        // this machine.
        let named = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice\r\n    ProgId    REG_SZ    Trae CN.md\r\n";
        assert_eq!(parse_reg_sz(named).as_deref(), Some("Trae CN.md"));
        // A value with a trailing space is trimmed.
        assert_eq!(
            parse_reg_sz("    (Default)    REG_SZ    spaced value  \r\n").as_deref(),
            Some("spaced value")
        );
        // An existing key whose default value was never written exits 0 and
        // prints a placeholder - that is "not set", not data.
        let placeholder =
            "HKEY_CURRENT_USER\\Software\\Classes\\.md\r\n    (Default)    REG_SZ    (value not set)\r\n";
        assert_eq!(parse_reg_sz(placeholder), None);
        // A key without any default value line, and empty output.
        assert_eq!(parse_reg_sz("HKEY_CURRENT_USER\\X\r\n"), None);
        assert_eq!(parse_reg_sz(""), None);
    }

    #[test]
    fn command_points_to_matches_the_exact_registration_only() {
        assert!(command_points_to(&format!("\"{EXE}\" \"%1\""), EXE));
        assert!(command_points_to(
            &format!("\"{}\" \"%1\"", EXE.to_uppercase()),
            EXE
        ));
        assert!(!command_points_to(
            "\"C:\\Other\\lexora.exe\" \"%1\"",
            EXE
        ));
        assert!(!command_points_to("", EXE));
        assert!(!command_points_to("\"C:\\x\\lexora.exe\"", EXE));
    }

    /// Exercises the real `reg.exe` query path read-only: a key that cannot
    /// exist is "not registered" (never an error), and the parser never turns
    /// the localised "(value not set)" placeholder into data.
    #[test]
    fn queries_never_fail_and_never_report_a_placeholder() {
        assert_eq!(
            reg_query("HKCU\\Software\\Classes\\Lexora-does-not-exist", None),
            None
        );
        assert_eq!(
            reg_query("HKCU\\Software\\Classes\\Lexora-does-not-exist", Some(".md")),
            None
        );
        if let Some(value) = md_default_progid() {
            assert!(!value.is_empty());
            assert!(
                !(value.starts_with('(') && value.ends_with(')')),
                "placeholder leaked as data: {value}"
            );
        }
        // The status command must be usable on any machine, registered or not.
        let status = assoc_status_impl();
        assert_eq!(status.prog_id, PROG_ID);
        assert!(status.supported);
        assert_eq!(status.md_points_to_us, status.md_default.as_deref() == Some(PROG_ID));
    }
}
