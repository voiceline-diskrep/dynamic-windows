//! Native Windows Win32 & CoreAudio COM helpers (replaces sys-helper.exe & PowerShell registry calls)

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, BOOL, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
    DRAGDROP_S_USEDEFAULTCURSORS, ERROR_ALREADY_EXISTS, HANDLE, HGLOBAL, HWND, LPARAM, POINT, RECT,
    S_OK,
};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, eRender, AudioSessionStateActive,
    EDataFlow, ERole, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IDataObject, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, CF_UNICODETEXT, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_NONE,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::System::ProcessStatus::K32EmptyWorkingSet;
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, GetCurrentProcessId, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
};
use windows::Win32::UI::Controls::Dialogs::{
    GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
    OPENFILENAMEW,
};
use windows::Win32::UI::Shell::{
    IShellFolder, SHBindToParent, SHParseDisplayName, SHQueryUserNotificationState, ShellExecuteW,
    QUNS_APP, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, IsZoomed, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, HWND_TOPMOST, SPIF_SENDCHANGE,
    SPI_GETWORKAREA, SPI_SETWORKAREA, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
    SW_MAXIMIZE, SW_RESTORE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_EX_APPWINDOW,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

pub struct SingleInstanceGuard {
    handle: HANDLE,
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_invalid() {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

pub fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    let name = to_wide("Local\\DynamicWindowsRustSingleInstanceMutex");
    unsafe {
        let handle = CreateMutexW(None, false, PCWSTR(name.as_ptr())).ok()?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return None;
        }
        Some(SingleInstanceGuard { handle })
    }
}

// -----------------------------------------------------------------------------
// Battery & Fullscreen Detection
// -----------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatteryStatus {
    pub has_battery: bool,
    pub percent: u8,
    pub is_charging: bool,
}

impl BatteryStatus {
    pub fn to_json(&self) -> Value {
        json!({
            "hasBattery": self.has_battery,
            "percent": self.percent,
            "isCharging": self.is_charging
        })
    }
}

pub fn get_battery_status() -> BatteryStatus {
    unsafe {
        let mut sps = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut sps).is_ok() {
            let no_battery = (sps.BatteryFlag & 128) != 0 || sps.BatteryLifePercent > 100;
            let has_battery = !no_battery;
            let percent = if sps.BatteryLifePercent <= 100 {
                sps.BatteryLifePercent
            } else {
                0
            };
            let is_charging =
                has_battery && (sps.ACLineStatus == 1 || (sps.BatteryFlag & 8) != 0);
            return BatteryStatus {
                has_battery,
                percent,
                is_charging,
            };
        }
    }
    BatteryStatus {
        has_battery: false,
        percent: 0,
        is_charging: false,
    }
}

pub fn is_fullscreen_app(own_hwnd_raw: isize) -> bool {
    unsafe {
        let Ok(state) = SHQueryUserNotificationState() else {
            return false;
        };
        if state == QUNS_RUNNING_D3D_FULL_SCREEN {
            return true;
        }
        if state != QUNS_BUSY && state != QUNS_PRESENTATION_MODE && state != QUNS_APP {
            return false;
        }

        // Verify the foreground window actually covers the full monitor (avoids false positives on Focus Assist / desktop / maximized apps)
        let fg = GetForegroundWindow();
        if fg.0.is_null() || (fg.0 as isize) == own_hwnd_raw {
            return false;
        }
        if !IsWindowVisible(fg).as_bool() {
            return false;
        }

        let mut cls_buf = [0u16; 128];
        let cls_len = GetClassNameW(fg, &mut cls_buf);
        if cls_len > 0 {
            let cls = String::from_utf16_lossy(&cls_buf[..cls_len as usize]);
            if matches!(
                cls.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ) {
                return false;
            }
        }

        let mut wr = RECT::default();
        if GetWindowRect(fg, &mut wr).is_err() {
            return false;
        }
        let hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return false;
        }
        let mr = mi.rcMonitor;
        wr.left <= mr.left && wr.top <= mr.top && wr.right >= mr.right && wr.bottom >= mr.bottom
    }
}

// -----------------------------------------------------------------------------
// Overlay Window Styling, Click-Through & Cursor Tracking
// -----------------------------------------------------------------------------

pub fn apply_overlay_styles(hwnd_raw: isize) {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = (ex | (WS_EX_TOOLWINDOW.0 as isize)) & !(WS_EX_APPWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[allow(dead_code)]
pub fn set_click_through(hwnd_raw: isize, ignore: bool) {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if ignore {
            ex | (WS_EX_TRANSPARENT.0 as isize)
        } else {
            ex & !(WS_EX_TRANSPARENT.0 as isize)
        };
        if next != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

#[allow(dead_code)]
pub fn show_inactive_topmost(hwnd_raw: isize) {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[allow(dead_code)]
pub fn hide_window(hwnd_raw: isize) {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

pub fn get_cursor_pos() -> Option<(i32, i32)> {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

pub fn get_window_rect(hwnd_raw: isize) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_ok() {
            Some((r.left, r.top, r.right, r.bottom))
        } else {
            None
        }
    }
}

// -----------------------------------------------------------------------------
// Registry Helpers (Startup & Windows Toast Suppression)
// -----------------------------------------------------------------------------

pub fn set_startup_registry(open_at_login: bool, startup_takeover: bool) -> bool {
    let subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let value_name = to_wide("DynamicWindows");
    unsafe {
        let mut hkey = HKEY::default();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .is_err()
        {
            return false;
        }
        let ok = if open_at_login {
            let exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let cmd = if startup_takeover {
                format!("\"{}\" --startup-mode", exe)
            } else {
                format!("\"{}\"", exe)
            };
            let wide = to_wide(&cmd);
            let bytes =
                std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
            RegSetValueExW(hkey, PCWSTR(value_name.as_ptr()), 0, REG_SZ, Some(bytes)).is_ok()
        } else {
            let _ = RegDeleteValueW(hkey, PCWSTR(value_name.as_ptr()));
            true
        };
        let _ = RegCloseKey(hkey);
        ok
    }
}

// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: controls Windows 10/11 Do Not Disturb (Focus Assist).
// Values: 0 = Off, 1 = Priority Only, 2 = Alarms Only (silences native toast popups while
// UserNotificationListener still receives every notification immediately).
#[repr(C)]
#[derive(Clone, Copy)]
struct WnfStateName {
    data: [u32; 2],
}

const WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: WnfStateName = WnfStateName {
    data: [0xA3BF1C75, 0x0D83063E],
};

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryWnfStateData(
        state_name: *const WnfStateName,
        type_id: *const std::ffi::c_void,
        explicit_scope: *const std::ffi::c_void,
        change_stamp: *mut u32,
        buffer: *mut std::ffi::c_void,
        buffer_size: *mut u32,
    ) -> i32;

    fn NtUpdateWnfStateData(
        state_name: *const WnfStateName,
        buffer: *const std::ffi::c_void,
        length: u32,
        type_id: *const std::ffi::c_void,
        explicit_scope: *const std::ffi::c_void,
        matching_change_stamp: u32,
        check_stamp: i32,
    ) -> i32;
}

static SAVED_DND_PROFILE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

pub fn query_windows_dnd_profile() -> Option<(u32, u32)> {
    unsafe {
        let mut stamp: u32 = 0;
        let mut val: u32 = 0;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        let status = NtQueryWnfStateData(
            &WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED,
            std::ptr::null(),
            std::ptr::null(),
            &mut stamp,
            &mut val as *mut u32 as *mut std::ffi::c_void,
            &mut size,
        );
        if status >= 0 {
            Some((val, stamp))
        } else {
            None
        }
    }
}

pub fn set_windows_dnd_profile(profile: u32) -> bool {
    let stamp = query_windows_dnd_profile().map(|(_, s)| s).unwrap_or(0);
    unsafe {
        let status = NtUpdateWnfStateData(
            &WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED,
            &profile as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
            std::ptr::null(),
            std::ptr::null(),
            stamp,
            0,
        );
        status >= 0
    }
}

fn ensure_legacy_toast_registry_enabled() {
    let subkey =
        to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings");
    let value_name = to_wide("NOC_GLOBAL_SETTING_TOASTS_ENABLED");
    let dword: u32 = 1;
    unsafe {
        let mut hkey = HKEY::default();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .is_ok()
        {
            let bytes = dword.to_le_bytes();
            let _ = RegSetValueExW(hkey, PCWSTR(value_name.as_ptr()), 0, REG_DWORD, Some(&bytes));
            let _ = RegCloseKey(hkey);
        }
    }
}

pub fn set_windows_toast_suppression_registry(suppress: bool) -> bool {
    // Keep legacy registry key at 1 so notifications always flow into UserNotificationListener,
    // and use Windows 10/11 Do Not Disturb (Alarms Only) to actually suppress native toast banners.
    ensure_legacy_toast_registry_enabled();
    if suppress {
        if SAVED_DND_PROFILE.load(std::sync::atomic::Ordering::SeqCst) < 0 {
            let cur = query_windows_dnd_profile().map(|(v, _)| v as i32).unwrap_or(0);
            SAVED_DND_PROFILE.store(cur, std::sync::atomic::Ordering::SeqCst);
        }
        set_windows_dnd_profile(2)
    } else {
        let prev = SAVED_DND_PROFILE.swap(-1, std::sync::atomic::Ordering::SeqCst);
        let restore = if prev >= 0 { prev as u32 } else { 0 };
        set_windows_dnd_profile(restore)
    }
}

/// Re-asserts Do Not Disturb if Windows automatically cleared it (e.g. after exiting a fullscreen game).
pub fn ensure_windows_toast_suppression_active() {
    if let Some((cur, _)) = query_windows_dnd_profile() {
        if cur == 0 {
            let _ = set_windows_dnd_profile(2);
        }
    }
}

// -----------------------------------------------------------------------------
// Clipboard (Zero-overhead sequence check + Unicode read/write)
// -----------------------------------------------------------------------------

pub fn clipboard_sequence_number() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub fn clipboard_read_text() -> Option<String> {
    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return None;
        }
        let mut result = None;
        if let Ok(handle) = GetClipboardData(CF_UNICODETEXT.0 as u32) {
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal) as *const u16;
            if !ptr.is_null() {
                let mut len = 0usize;
                while *ptr.add(len) != 0 && len < 200_000 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(ptr, len);
                result = Some(String::from_utf16_lossy(slice));
                let _ = GlobalUnlock(hglobal);
            }
        }
        let _ = CloseClipboard();
        result
    }
}

pub fn clipboard_write_text(text: &str) -> bool {
    let wide = to_wide(text);
    let byte_len = wide.len() * 2;
    unsafe {
        if OpenClipboard(HWND::default()).is_err() {
            return false;
        }
        let _ = EmptyClipboard();
        let mut ok = false;
        if let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE, byte_len) {
            let ptr = GlobalLock(hmem) as *mut u16;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                let _ = GlobalUnlock(hmem);
                ok = SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hmem.0)).is_ok();
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

// -----------------------------------------------------------------------------
// Shell Execute, WorkArea Restore, File Dialog, Native OLE Drag-Out
// -----------------------------------------------------------------------------

pub fn shell_open(target: &str) {
    let op = to_wide("open");
    let file = to_wide(target);
    unsafe {
        ShellExecuteW(
            HWND::default(),
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_RESTORE,
        );
    }
}

pub fn reveal_in_explorer(target: &str) {
    let path = Path::new(target);
    if path.exists() && path.is_file() {
        let arg = format!("/select,\"{}\"", target);
        let op = to_wide("open");
        let exe = to_wide("explorer.exe");
        let params = to_wide(&arg);
        unsafe {
            ShellExecuteW(
                HWND::default(),
                PCWSTR(op.as_ptr()),
                PCWSTR(exe.as_ptr()),
                PCWSTR(params.as_ptr()),
                PCWSTR::null(),
                SW_RESTORE,
            );
        }
    } else {
        shell_open(target);
    }
}

pub fn restore_work_area() {
    unsafe {
        let mut r = RECT::default();
        if SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut r as *mut _ as *mut _),
            windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
        {
            if r.top != 0 {
                r.top = 0;
                let _ = SystemParametersInfoW(
                    SPI_SETWORKAREA,
                    0,
                    Some(&mut r as *mut _ as *mut _),
                    SPIF_SENDCHANGE,
                );
            }
        }
        unsafe extern "system" fn restore_max_cb(hwnd: HWND, _: LPARAM) -> BOOL {
            if !IsWindowVisible(hwnd).as_bool() || !IsZoomed(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut wr = RECT::default();
            if GetWindowRect(hwnd, &mut wr).is_ok() && wr.top > 0 && wr.top <= 64 {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
            }
            BOOL(1)
        }
        let _ = EnumWindows(Some(restore_max_cb), LPARAM(0));
    }
}

pub fn open_files_dialog() -> Vec<String> {
    let mut buf = vec![0u16; 32768];
    let title = to_wide("Select Files for Drop Zone Shelf");
    let filter = to_wide("All Files (*.*)\0*.*\0\0");
    unsafe {
        let mut ofn = OPENFILENAMEW::default();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = PCWSTR(filter.as_ptr());
        ofn.lpstrFile = PWSTR(buf.as_mut_ptr());
        ofn.nMaxFile = buf.len() as u32;
        ofn.lpstrTitle = PCWSTR(title.as_ptr());
        ofn.Flags = OFN_ALLOWMULTISELECT | OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;

        if !GetOpenFileNameW(&mut ofn).as_bool() {
            return Vec::new();
        }
    }

    // Parse double-null-terminated multi-select result
    let mut parts: Vec<String> = Vec::new();
    let mut start = 0usize;
    for i in 0..buf.len() {
        if buf[i] == 0 {
            if i == start {
                break;
            }
            parts.push(String::from_utf16_lossy(&buf[start..i]));
            start = i + 1;
        }
    }
    if parts.is_empty() {
        Vec::new()
    } else if parts.len() == 1 {
        parts
    } else {
        let dir = &parts[0];
        parts[1..]
            .iter()
            .map(|f| Path::new(dir).join(f).to_string_lossy().to_string())
            .collect()
    }
}

#[implement(IDropSource)]
struct SimpleDropSource;

impl IDropSource_Impl for SimpleDropSource_Impl {
    fn QueryContinueDrag(
        &self,
        fescapepressed: BOOL,
        grfkeystate: MODIFIERKEYS_FLAGS,
    ) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if (grfkeystate.0 & MK_LBUTTON.0) == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Starts a native Windows OLE file drag-and-drop operation (supports Explorer, Chrome, Discord, WhatsApp, etc.).
/// Returns true if the drop completed onto a valid target (or drag ran to completion).
pub fn start_native_file_drag(file_path: &str) -> bool {
    if !Path::new(file_path).exists() {
        return false;
    }
    let wide = to_wide(file_path);
    unsafe {
        let _ = OleInitialize(None);
        let mut pidl_full = std::ptr::null_mut();
        if SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl_full, 0, None).is_err()
            || pidl_full.is_null()
        {
            return false;
        }

        let mut pidl_child = std::ptr::null_mut();
        let parent_res: windows::core::Result<IShellFolder> =
            SHBindToParent(pidl_full, Some(&mut pidl_child));
        if let Ok(folder) = parent_res {
            let children = [pidl_child as *const _];
            let data_obj_res: windows::core::Result<IDataObject> =
                folder.GetUIObjectOf(HWND::default(), &children, None);
            if let Ok(data_obj) = data_obj_res {
                let drop_source: IDropSource = SimpleDropSource.into();
                let mut effect = DROPEFFECT_NONE;
                let hr = DoDragDrop(
                    &data_obj,
                    &drop_source,
                    DROPEFFECT_COPY | DROPEFFECT_LINK,
                    &mut effect,
                );
                windows::Win32::System::Com::CoTaskMemFree(Some(pidl_full as *const _));
                return hr == DRAGDROP_S_DROP || effect != DROPEFFECT_NONE;
            }
        }
        windows::Win32::System::Com::CoTaskMemFree(Some(pidl_full as *const _));
    }
    false
}

// -----------------------------------------------------------------------------
// Process & Window Enumeration / Focus
// -----------------------------------------------------------------------------

fn snapshot_process_names() -> HashMap<u32, String> {
    let mut map = HashMap::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut pe = PROCESSENTRY32W::default();
            pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut pe).is_ok() {
                loop {
                    let len = pe
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(pe.szExeFile.len());
                    let exe = String::from_utf16_lossy(&pe.szExeFile[..len]);
                    let stem = exe
                        .strip_suffix(".exe")
                        .or_else(|| exe.strip_suffix(".EXE"))
                        .unwrap_or(&exe)
                        .to_string();
                    map.insert(pe.th32ProcessID, stem);
                    if Process32NextW(snap, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
    }
    map
}

fn read_window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let written = GetWindowTextW(hwnd, &mut buf);
        if written <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..written as usize])
            .trim()
            .to_string()
    }
}

pub fn focus_process(proc_target: &str) -> bool {
    let target_lower = proc_target
        .trim()
        .trim_end_matches(".exe")
        .to_lowercase();
    if target_lower.is_empty() {
        return false;
    }
    let procs = snapshot_process_names();
    let mut pids = HashSet::new();
    for (pid, name) in &procs {
        let nl = name.to_lowercase();
        if nl == target_lower || nl.contains(&target_lower) {
            pids.insert(*pid);
        }
    }

    struct Ctx {
        pids: HashSet<u32>,
        target_lower: String,
        focused: bool,
    }
    let mut ctx = Ctx {
        pids,
        target_lower,
        focused: false,
    };

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let title = read_window_title(hwnd);
        if title.is_empty() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if ctx.pids.contains(&pid) || title.to_lowercase().contains(&ctx.target_lower) {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
            ctx.focused = true;
            return BOOL(0);
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.focused
}

pub fn get_call_app_window_titles() -> HashMap<String, String> {
    let targets = [
        "Discord",
        "DiscordPTB",
        "DiscordCanary",
        "WhatsApp",
        "WhatsApp.Root",
        "Zoom",
        "Teams",
        "ms-teams",
        "Telegram",
        "PhoneExperienceHost",
        "PhoneLink",
        "Skype",
    ];
    let procs = snapshot_process_names();
    let mut pid_to_target: HashMap<u32, String> = HashMap::new();
    for (pid, pname) in &procs {
        for &t in &targets {
            if pname.eq_ignore_ascii_case(t) {
                pid_to_target.insert(*pid, t.to_string());
                break;
            }
        }
    }
    if pid_to_target.is_empty() {
        return HashMap::new();
    }

    struct Ctx {
        pid_to_target: HashMap<u32, String>,
        result: HashMap<String, String>,
    }
    let mut ctx = Ctx {
        pid_to_target,
        result: HashMap::new(),
    };

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if let Some(proc_name) = ctx.pid_to_target.get(&pid).cloned() {
            let title = read_window_title(hwnd);
            if !title.is_empty()
                && title != "Default IME"
                && title != "MSCTFIME UI"
                && !title.starts_with("GDI+ Window")
                && !title.starts_with("Chrome Legacy Window")
            {
                let replace = match ctx.result.get(&proc_name) {
                    None => true,
                    Some(prev) => title.contains("Discord") || title.len() > prev.len(),
                };
                if replace {
                    ctx.result.insert(proc_name, title);
                }
            }
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.result
}

// -----------------------------------------------------------------------------
// Native Windows CoreAudio (System Volume, Per-App Media Volume, Call Audio)
// -----------------------------------------------------------------------------

fn ensure_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

unsafe fn get_default_device(flow: EDataFlow, role: ERole) -> Option<IMMDevice> {
    ensure_com();
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
    enumerator.GetDefaultAudioEndpoint(flow, role).ok()
}

unsafe fn get_endpoint_volume(flow: EDataFlow, role: ERole) -> Option<IAudioEndpointVolume> {
    let dev = get_default_device(flow, role)?;
    dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
}

unsafe fn get_peak(flow: EDataFlow, role: ERole) -> f32 {
    if let Some(dev) = get_default_device(flow, role) {
        if let Ok(meter) = dev.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) {
            if let Ok(p) = meter.GetPeakValue() {
                return p;
            }
        }
    }
    0.0
}

pub fn get_system_volume() -> Value {
    unsafe {
        if let Some(epv) = get_endpoint_volume(eRender, eMultimedia) {
            let vol = epv.GetMasterVolumeLevelScalar().unwrap_or(0.5);
            let muted = epv.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            return json!({
                "volume": (vol as f64 * 1000.0).round() / 1000.0,
                "muted": muted
            });
        }
    }
    json!({ "volume": 0.5, "muted": false })
}

pub fn set_system_volume(scalar: f32) -> Value {
    let target = scalar.clamp(0.0, 1.0);
    unsafe {
        if let Some(epv) = get_endpoint_volume(eRender, eMultimedia) {
            let _ = epv.SetMasterVolumeLevelScalar(target, &GUID::zeroed());
            if target > 0.0 {
                let _ = epv.SetMute(false, &GUID::zeroed());
            }
            let vol = epv.GetMasterVolumeLevelScalar().unwrap_or(target);
            let muted = epv.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            return json!({
                "volume": (vol as f64 * 1000.0).round() / 1000.0,
                "muted": muted
            });
        }
    }
    json!({ "volume": target, "muted": false })
}

pub fn toggle_system_mute() -> Value {
    unsafe {
        if let Some(epv) = get_endpoint_volume(eRender, eMultimedia) {
            let muted = epv.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            let next = !muted;
            let _ = epv.SetMute(next, &GUID::zeroed());
            let vol = epv.GetMasterVolumeLevelScalar().unwrap_or(0.5);
            return json!({
                "volume": (vol as f64 * 1000.0).round() / 1000.0,
                "muted": next
            });
        }
    }
    json!({ "volume": 0.5, "muted": false })
}

struct AudioSessionItem {
    vol: ISimpleAudioVolume,
    pid: u32,
    proc_name: String,
    session_ident: String,
}

unsafe fn get_all_render_sessions() -> Vec<AudioSessionItem> {
    let mut out = Vec::new();
    let procs = snapshot_process_names();
    let Some(dev) = get_default_device(eRender, eMultimedia) else {
        return out;
    };
    let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
        return out;
    };
    let Ok(enumerator) = mgr.GetSessionEnumerator() else {
        return out;
    };
    let count = enumerator.GetCount().unwrap_or(0);
    for i in 0..count {
        let Ok(ctl) = enumerator.GetSession(i) else {
            continue;
        };
        let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else {
            continue;
        };
        let mut pid = 0u32;
        let mut s_id = String::new();
        if let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() {
            pid = ctl2.GetProcessId().unwrap_or(0);
            if let Ok(pw) = ctl2.GetSessionIdentifier() {
                if let Ok(s) = pw.to_string() {
                    s_id = s;
                }
                windows::Win32::System::Com::CoTaskMemFree(Some(pw.0 as *const _));
            }
        }
        let proc_name = procs.get(&pid).cloned().unwrap_or_default();
        out.push(AudioSessionItem {
            vol,
            pid,
            proc_name,
            session_ident: s_id,
        });
    }
    out
}

unsafe fn find_matching_sessions(hint: &str) -> Vec<AudioSessionItem> {
    let sessions = get_all_render_sessions();
    let hint_trim = hint.trim();
    if !hint_trim.is_empty() {
        if let Ok(hint_pid) = hint_trim.parse::<u32>() {
            if hint_pid > 0 {
                let matched: Vec<_> = sessions.into_iter().filter(|s| s.pid == hint_pid).collect();
                if !matched.is_empty() {
                    return matched;
                }
                return Vec::new();
            }
        }
        let hl = hint_trim.to_lowercase();
        let matched: Vec<_> = sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.proc_name.to_lowercase().contains(&hl)
                    || s.session_ident.to_lowercase().contains(&hl)
            })
            .map(|(idx, _)| idx)
            .collect();
        if !matched.is_empty() {
            return sessions
                .into_iter()
                .enumerate()
                .filter(|(i, _)| matched.contains(i))
                .map(|(_, s)| s)
                .collect();
        }
    }

    let preferred = [
        "liner",
        "spotify",
        "music.ui",
        "applemusic",
        "itunes",
        "wmplayer",
        "foobar2000",
        "aimp",
        "vlc",
        "deezer",
        "tidal",
        "chrome",
        "msedge",
        "firefox",
        "brave",
    ];
    for pref in preferred {
        let idxs: Vec<_> = sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| s.proc_name.to_lowercase().contains(pref))
            .map(|(i, _)| i)
            .collect();
        if !idxs.is_empty() {
            return sessions
                .into_iter()
                .enumerate()
                .filter(|(i, _)| idxs.contains(i))
                .map(|(_, s)| s)
                .collect();
        }
    }

    for s in sessions {
        if s.pid > 0 && !s.proc_name.is_empty() && !s.proc_name.eq_ignore_ascii_case("audiodg") {
            return vec![s];
        }
    }
    Vec::new()
}

pub fn get_media_volume(hint: &str) -> Value {
    unsafe {
        let matched = find_matching_sessions(hint);
        if let Some(first) = matched.first() {
            let v = first.vol.GetMasterVolume().unwrap_or(1.0);
            let m = first.vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            return json!({
                "volume": (v as f64 * 1000.0).round() / 1000.0,
                "muted": m,
                "app": first.proc_name,
                "pid": first.pid
            });
        }
    }
    json!({ "volume": 1.0, "muted": false, "app": "none", "pid": 0 })
}

pub fn set_media_volume(scalar: f32, hint: &str) -> Value {
    let target = scalar.clamp(0.0, 1.0);
    unsafe {
        let matched = find_matching_sessions(hint);
        if matched.is_empty() {
            return json!({ "volume": target, "muted": false, "app": "none", "pid": 0 });
        }
        let g = GUID::zeroed();
        for s in &matched {
            let _ = s.vol.SetMasterVolume(target, &g);
            if target > 0.0 {
                let _ = s.vol.SetMute(false, &g);
            }
        }
        let first = &matched[0];
        let v = first.vol.GetMasterVolume().unwrap_or(target);
        let m = first.vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
        json!({
            "volume": (v as f64 * 1000.0).round() / 1000.0,
            "muted": m,
            "app": first.proc_name,
            "pid": first.pid
        })
    }
}

pub fn toggle_media_mute(hint: &str) -> Value {
    unsafe {
        let matched = find_matching_sessions(hint);
        if matched.is_empty() {
            return json!({ "volume": 1.0, "muted": false, "app": "none", "pid": 0 });
        }
        let cur = matched[0].vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
        let next = !cur;
        let g = GUID::zeroed();
        for s in &matched {
            let _ = s.vol.SetMute(next, &g);
        }
        let v = matched[0].vol.GetMasterVolume().unwrap_or(1.0);
        json!({
            "volume": (v as f64 * 1000.0).round() / 1000.0,
            "muted": next,
            "app": matched[0].proc_name,
            "pid": matched[0].pid
        })
    }
}

pub fn toggle_mic_mute() -> Value {
    unsafe {
        let epv = get_endpoint_volume(eCapture, eCommunications)
            .or_else(|| get_endpoint_volume(eCapture, eMultimedia))
            .or_else(|| get_endpoint_volume(eCapture, eConsole));
        let mut next = false;
        if let Some(ep) = epv {
            let cur = ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            next = !cur;
            let _ = ep.SetMute(next, &GUID::zeroed());
        }
        if let Some(ep2) = get_endpoint_volume(eCapture, eMultimedia) {
            let _ = ep2.SetMute(next, &GUID::zeroed());
        }
        json!({ "micMuted": next })
    }
}

pub fn set_mic_mute(muted: bool) -> Value {
    unsafe {
        if let Some(ep) = get_endpoint_volume(eCapture, eCommunications) {
            let _ = ep.SetMute(muted, &GUID::zeroed());
        }
        if let Some(ep) = get_endpoint_volume(eCapture, eMultimedia) {
            let _ = ep.SetMute(muted, &GUID::zeroed());
        }
        json!({ "micMuted": muted })
    }
}

unsafe fn get_active_capture_apps() -> Vec<String> {
    let mut list = Vec::new();
    let dev = get_default_device(eCapture, eCommunications)
        .or_else(|| get_default_device(eCapture, eMultimedia));
    let Some(dev) = dev else { return list };
    let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
        return list;
    };
    let Ok(enumerator) = mgr.GetSessionEnumerator() else {
        return list;
    };
    let count = enumerator.GetCount().unwrap_or(0);
    let mut active_pids = Vec::new();
    for i in 0..count {
        let Ok(ctl) = enumerator.GetSession(i) else {
            continue;
        };
        let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        if ctl2.GetState().ok() == Some(AudioSessionStateActive) {
            let pid = ctl2.GetProcessId().unwrap_or(0);
            if pid != 0 && !active_pids.contains(&pid) {
                active_pids.push(pid);
            }
        }
    }
    if active_pids.is_empty() {
        return list;
    }
    let procs = snapshot_process_names();
    for pid in active_pids {
        if let Some(name) = procs.get(&pid) {
            if !name.is_empty()
                && !name.eq_ignore_ascii_case("audiodg")
                && !list.contains(name)
            {
                list.push(name.clone());
            }
        }
    }
    list
}

/// Trims cold working-set pages from this process and its descendant WebView2 subprocesses.
pub fn trim_process_tree_memory() {
    unsafe {
        let _ = K32EmptyWorkingSet(GetCurrentProcess());
        let self_pid = GetCurrentProcessId();
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return;
        };
        let mut pairs: Vec<(u32, u32)> = Vec::with_capacity(256);
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut pe).is_ok() {
            loop {
                pairs.push((pe.th32ProcessID, pe.th32ParentProcessID));
                if Process32NextW(snap, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);

        let mut tree = HashSet::new();
        tree.insert(self_pid);
        let mut changed = true;
        while changed {
            changed = false;
            for &(pid, ppid) in &pairs {
                if tree.contains(&ppid) && tree.insert(pid) {
                    changed = true;
                }
            }
        }
        tree.remove(&self_pid);

        for pid in tree {
            if let Ok(h) = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) {
                if !h.is_invalid() {
                    let _ = K32EmptyWorkingSet(h);
                    let _ = CloseHandle(h);
                }
            }
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct CallAudioSnapshot {
    pub mic_muted: bool,
    pub mic_peak: f32,
    pub out_muted: bool,
    pub out_peak: f32,
    pub active_mic_apps: Vec<String>,
    pub window_titles: HashMap<String, String>,
}

pub fn get_call_audio() -> CallAudioSnapshot {
    unsafe {
        let mut out_muted = false;
        if let Some(out_ep) = get_endpoint_volume(eRender, eMultimedia) {
            out_muted = out_ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
        }
        let mut mic_muted = false;
        if let Some(mic_ep) = get_endpoint_volume(eCapture, eCommunications)
            .or_else(|| get_endpoint_volume(eCapture, eMultimedia))
        {
            mic_muted = mic_ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
        }
        let mic_peak =
            get_peak(eCapture, eCommunications).max(get_peak(eCapture, eMultimedia));
        let out_peak = get_peak(eRender, eCommunications).max(get_peak(eRender, eMultimedia));
        let active_mic_apps = get_active_capture_apps();
        let window_titles = get_call_app_window_titles();

        CallAudioSnapshot {
            mic_muted,
            mic_peak,
            out_muted,
            out_peak,
            active_mic_apps,
            window_titles,
        }
    }
}

pub fn set_window_exclude_from_capture(hwnd_raw: isize, exclude: bool) {
    if hwnd_raw == 0 {
        return;
    }
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let affinity = if exclude {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        let _ = SetWindowDisplayAffinity(hwnd, affinity);
    }
}

/// Captures the desktop region directly behind the overlay capsule (excluding our own window
/// when WDA_EXCLUDEFROMCAPTURE is active) and returns a compact PNG data URL for real optical
/// edge distortion in Liquid Glass mode.
pub fn capture_desktop_region_png_data_url(
    hwnd_raw: isize,
    css_x: f64,
    css_y: f64,
    css_w: f64,
    css_h: f64,
    scale: f64,
) -> Option<String> {
    if hwnd_raw == 0 || css_w < 12.0 || css_h < 12.0 {
        return None;
    }
    let scale = if scale.is_finite() && scale > 0.25 { scale } else { 1.0 };
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let mut wrect = RECT::default();
        if GetWindowRect(hwnd, &mut wrect).is_err() {
            return None;
        }
        let src_x = wrect.left + (css_x * scale).round() as i32;
        let src_y = wrect.top + (css_y * scale).round() as i32;
        let src_w = ((css_w * scale).round() as i32).clamp(8, 2000);
        let src_h = ((css_h * scale).round() as i32).clamp(8, 1200);

        // Downsample moderately to keep capture fast (<1ms) and RAM tiny
        let max_dim = 320.0_f64;
        let down = (max_dim / (src_w.max(src_h) as f64)).min(1.0);
        let dst_w = ((src_w as f64 * down).round() as i32).clamp(8, 320);
        let dst_h = ((src_h as f64 * down).round() as i32).clamp(8, 320);

        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return None;
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return None;
        }
        let bmp = CreateCompatibleBitmap(screen_dc, dst_w, dst_h);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
            return None;
        }
        let old = SelectObject(mem_dc, bmp);
        let _ = SetStretchBltMode(mem_dc, HALFTONE);
        let ok = StretchBlt(
            mem_dc,
            0,
            0,
            dst_w,
            dst_h,
            screen_dc,
            src_x,
            src_y,
            src_w,
            src_h,
            SRCCOPY,
        )
        .as_bool();

        let mut rgba = vec![0u8; (dst_w * dst_h * 4) as usize];
        let mut got_bits = false;
        if ok {
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = dst_w;
            bmi.bmiHeader.biHeight = -dst_h; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;

            let rows = GetDIBits(
                mem_dc,
                bmp,
                0,
                dst_h as u32,
                Some(rgba.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            got_bits = rows > 0;
        }

        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        if !got_bits {
            return None;
        }

        // Convert BGRA -> RGBA with opaque alpha
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let mut png_bytes = Vec::with_capacity((dst_w * dst_h) as usize);
        {
            let mut enc = png::Encoder::new(&mut png_bytes, dst_w as u32, dst_h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut writer = enc.write_header().ok()?;
            writer.write_image_data(&rgba).ok()?;
        }

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        Some(format!("data:image/png;base64,{}", b64))
    }
}
