//! System font picker using the Windows common-dialog ChooseFontW.
//! Lets the user pick a font family + size through the OS dialog instead of
//! typing a font name by hand.

#![cfg(windows)]

use serde::Serialize;
use std::mem;
use std::os::raw::{c_int, c_uchar, c_uint, c_ushort, c_void};

const LF_FACESIZE: usize = 32;

const CF_SCREENFONTS: c_uint = 0x0000_0001;
const CF_INITTOLOGFONTSTRUCT: c_uint = 0x0000_0040;
const CF_TTONLY: c_uint = 0x0004_0000;
const CF_FORCEFONTEXIST: c_uint = 0x0001_0000;
const CF_NOSCRIPTSEL: c_uint = 0x0080_0000;

const DEFAULT_CHARSET: c_uchar = 1; // DEFAULT_CHARSET

#[repr(C)]
struct LogFontW {
    lf_height: c_int,
    lf_width: c_int,
    lf_escapement: c_int,
    lf_orientation: c_int,
    lf_weight: c_int,
    lf_italic: c_uchar,
    lf_underline: c_uchar,
    lf_strike_out: c_uchar,
    lf_char_set: c_uchar,
    lf_out_precision: c_uchar,
    lf_clip_precision: c_uchar,
    lf_quality: c_uchar,
    lf_pitch_and_family: c_uchar,
    lf_face_name: [u16; LF_FACESIZE],
}

#[repr(C)]
struct ChooseFontW {
    l_struct_size: c_uint,
    hwnd_owner: *mut c_void,
    h_dc: *mut c_void,
    lp_log_font: *mut LogFontW,
    i_point_size: c_int,
    flags: c_uint,
    rgb_colors: c_uint,
    l_cust_data: isize,
    lpfn_hook: *mut c_void,
    lp_template_name: *const u16,
    h_instance: *mut c_void,
    lpsz_style: *mut u16,
    n_font_type: c_ushort,
    _missing_alignment: c_ushort,
    n_size_min: c_int,
    n_size_max: c_int,
}

#[link(name = "comdlg32")]
unsafe extern "system" {
    fn ChooseFontW(lpcf: *mut ChooseFontW) -> c_int;
}

/// Picked font family name + point size.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPick {
    pub family: String,
    /// Selected font size in points (as shown by the OS dialog).
    pub size_pt: f64,
}

fn face_from_utf16(buf: &[u16; LF_FACESIZE]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// lfHeight is in device pixels; a negative value means "character height".
/// points -> pixels at 96 dpi: px = pt * 4 / 3.
fn point_size_to_lfheight(size_pt: f64) -> c_int {
    -(size_pt * 4.0 / 3.0).round() as c_int
}

fn lfheight_to_point_size(lf_height: c_int) -> f64 {
    ((-lf_height) as f64 * 3.0 / 4.0).max(1.0)
}

/// Opens the Windows font dialog. `current_family` seeds the initial face and
/// `current_size_pt` seeds the initial size; returns what the user chose, or
/// None when they cancelled.
///
/// `async`: sync Tauri commands run inline on the WebView2/main thread, so a
/// blocking dialog there would freeze the whole UI. An async command body runs
/// on the async runtime's worker thread; the spawned dialog thread blocks only
/// that worker while the modal is open.
#[tauri::command]
pub async fn pick_system_font(
    current_family: Option<String>,
    current_size_pt: Option<f64>,
) -> Result<Option<FontPick>, String> {
    // Run the modal dialog on a dedicated thread that seeds its own message
    // queue, so it never blocks the async runtime's main responsibilities.
    let handle = std::thread::spawn(move || {
        let initial_family = current_family.unwrap_or_else(|| "Microsoft YaHei".to_string());
        let size_pt = current_size_pt.unwrap_or(14.0);
        run_dialog(&initial_family, size_pt)
    });
    handle.join().map_err(|_| "字体对话框异常终止".to_string())
}

fn run_dialog(initial_family: &str, size_pt: f64) -> Option<FontPick> {
    // Create a message queue on this thread before showing the modal dialog.
    let mut msg: winapi_mini::Msg = unsafe { mem::zeroed() };
    unsafe {
        winapi_mini::PeekMessageW(&mut msg, 0, 0, 0, 0);
    }

    let mut lf: LogFontW = unsafe { mem::zeroed() };
    lf.lf_height = point_size_to_lfheight(size_pt);
    lf.lf_char_set = DEFAULT_CHARSET;
    lf.lf_out_precision = 0; // OUT_DEFAULT_PRECIS
    lf.lf_clip_precision = 0;
    lf.lf_quality = 0;
    lf.lf_pitch_and_family = 0; // DEFAULT_PITCH | FF_DONTCARE

    let face: Vec<u16> = initial_family.encode_utf16().chain(std::iter::once(0)).collect();
    for (i, c) in face.iter().take(LF_FACESIZE - 1).enumerate() {
        lf.lf_face_name[i] = *c;
    }

    let mut cf: ChooseFontW = unsafe { mem::zeroed() };
    cf.l_struct_size = mem::size_of::<ChooseFontW>() as c_uint;
    cf.lp_log_font = &mut lf;
    cf.flags = CF_SCREENFONTS
        | CF_INITTOLOGFONTSTRUCT
        | CF_TTONLY
        | CF_FORCEFONTEXIST
        | CF_NOSCRIPTSEL;
    cf.i_point_size = (size_pt * 10.0).round() as c_int;

    let chosen = unsafe { ChooseFontW(&mut cf) };
    if chosen == 0 {
        return None; // user cancelled
    }
    let family = face_from_utf16(&lf.lf_face_name).trim().to_string();
    let pt = if cf.i_point_size > 0 {
        cf.i_point_size as f64 / 10.0
    } else {
        lfheight_to_point_size(lf.lf_height)
    };
    Some(FontPick { family, size_pt: pt })
}

/// Minimal MSG + PeekMessage wrapper used only to seed a message queue on the
/// dialog thread (ChooseFontW needs a queue to run its modal loop).
#[allow(clippy::upper_case_acronyms)]
mod winapi_mini {
    #[repr(C)]
    pub struct Msg {
        pub hwnd: usize,
        pub message: u32,
        pub w_param: usize,
        pub l_param: isize,
        pub time: u32,
        pub pt_x: i32,
        pub pt_y: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn PeekMessageW(
            lp_msg: *mut Msg,
            h_wnd: usize,
            w_msg_filter_min: u32,
            w_msg_filter_max: u32,
            w_remove_msg: u32,
        ) -> i32;
    }
}
