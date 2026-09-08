//! Internal performance-benchmark support (inert unless the user places
//! `settings/bench-targets.json` next to the executable; never enabled by
//! normal usage). Used to measure open-time + memory while opening many
//! large markdown files.
#![cfg(windows)]

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::AppHandle;

use crate::paths;

/// `{ "files": ["C:\\...\\md01.md", ...], "out": "C:\\...\\results.json" }`
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchTargets {
    pub files: Vec<String>,
    pub out: String,
}

/// Returns the bench targets when `settings/bench-targets.json` exists, else
/// an error (the frontend treats any error as "bench disabled").
#[tauri::command]
pub fn bench_targets(app: AppHandle) -> Result<BenchTargets, String> {
    let dir = paths::settings_dir(&app).map_err(|e| e)?;
    let path = dir.join("bench-targets.json");
    if !path.exists() {
        return Err("__no_bench_targets__".into());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    serde_json::from_str(raw).map_err(|e| e.to_string())
}

/// Current process working-set size in KiB (PSAPI).
#[tauri::command]
pub fn process_mem_kb() -> u64 {
    working_set_kb()
}

fn working_set_kb() -> u64 {
    use std::ffi::c_void;
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }
    unsafe {
        let mut c = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let ok = K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb);
        if ok != 0 {
            (c.working_set_size / 1024) as u64
        } else {
            0
        }
    }
}
