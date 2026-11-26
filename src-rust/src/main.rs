#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod antigravity;
mod assets;
mod calls;
mod config;
mod drop_zone;
mod hooks_server;
mod media;
mod notifications;
mod sys_win;
mod updater;
mod user_data;

use antigravity::AntigravityMonitor;
use calls::CallMonitor;
use config::{ConfigManager, APP_VERSION};
use drop_zone::DropZone;
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use hooks_server::{start_hooks_server, AgentHooksHandle, HookEvent};
use media::MediaController;
use notifications::NotificationMonitor;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Icon as WindowIcon, Window, WindowBuilder, WindowId};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon as TrayIconImg, TrayIcon, TrayIconBuilder};
use user_data::UserDataManager;
use wry::http::{header::CONTENT_TYPE, Response, StatusCode};
use wry::{
    DragDropEvent, MemoryUsageLevel, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

const ISLAND_W: f64 = 1040.0;
const ISLAND_H: f64 = 420.0;

// Shared lean Chromium arguments for both Island and Settings WebView2 instances
// (identical args allow both windows to share a single WebContext / browser process).
// Note: GPU DirectComposition, V8 JIT, and Web Speech API are kept enabled.
const LOW_MEM_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,BackForwardCache,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,AutofillServerCommunication,HeavyAdIntervention,SpellCheck,PaintHolding ",
    "--enable-features=RemoveRedirectionBitmap ",
    "--disable-extensions --disable-sync --disable-background-networking ",
    "--disable-component-update --disable-default-apps --disable-domain-reliability ",
    "--disable-client-side-phishing-detection --no-pings ",
    "--no-first-run --no-default-browser-check ",
    "--renderer-process-limit=1 --disable-site-isolation-trials ",
    "--gpu-program-cache-size-kb=512 --disk-cache-size=1048576 --media-cache-size=1048576"
);

fn allow_webview_microphone(wv: &WebView) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;
    unsafe {
        if let Ok(core) = wv.controller().CoreWebView2() {
            let mut token = 0i64;
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    if args.PermissionKind(&mut kind).is_ok()
                        && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    {
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                }
                Ok(())
            }));
            let _ = core.add_PermissionRequested(&handler, &mut token);
        }
    }
}

fn run_native_speech_fallback(lang: &str) -> Value {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let safe_lang = match lang {
        "id-ID" | "en-US" | "zh-CN" | "de-DE" | "es-ES" => lang,
        _ => "en-US",
    };
    let ps = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         Add-Type -AssemblyName System.Speech; \
         $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers(); \
         $match = $installed | Where-Object {{ $_.Culture.Name -ieq '{lang}' }} | Select-Object -First 1; \
         if (-not $match) {{ $match = $installed | Select-Object -First 1 }}; \
         if (-not $match) {{ Write-Output ''; exit 0 }}; \
         $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($match.Culture); \
         $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); \
         $rec.SetInputToDefaultAudioDevice(); \
         $rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5); \
         $rec.BabbleTimeout = [TimeSpan]::FromSeconds(4); \
         $rec.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900); \
         $res = $rec.Recognize([TimeSpan]::FromSeconds(9)); \
         $rec.Dispose(); \
         if ($res -and $res.Text) {{ Write-Output $res.Text }}",
        lang = safe_lang
    );
    match Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            json!({ "ok": !text.is_empty(), "text": text, "engine": "windows-sapi" })
        }
        Err(_) => json!({ "ok": false, "text": "", "engine": "windows-sapi" }),
    }
}

fn spawn_lean<F: FnOnce() + Send + 'static>(name: &str, stack_kb: usize, f: F) {
    let _ = thread::Builder::new()
        .name(name.into())
        .stack_size(stack_kb * 1024)
        .spawn(f);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowTarget {
    Island,
    Settings,
    All,
}

#[derive(Debug)]
enum UserEvent {
    IpcFromIsland(String),
    IpcFromSettings(String),
    DispatchJs {
        target: WindowTarget,
        channel: String,
        payload: Value,
    },
    ResolveInvoke {
        target: WindowTarget,
        id: u64,
        ok: bool,
        payload: Value,
    },
    EvalIsland(String),
    SetIgnoreCursor(bool),
    SetOverlayVisible(bool),
    SetOnboardingFullscreen(bool),
    TriggerOnboarding,
    Hook(HookEvent),
    FullscreenChanged(bool),
    MediaTick,
    MediaChanged,
    AntigravityChanged,
    CallChanged,
    NotificationsPollResult(Vec<Value>, bool),
    BatteryChanged(sys_win::BatteryStatus),
    ClipboardChanged(Value),
    DragOver(f64, f64),
    DragLeave,
    DropFiles(Vec<String>, bool),
    ShelfAutoClear(String),
    TrayMenu(String),
    Hotkey(u32),
    StartupUpdateAvailable(Value),
    OpenSettings,
    ExitApp,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn decode_app_icon_rgba() -> Option<(Vec<u8>, u32, u32)> {
    let mut decoder = png::Decoder::new(assets::APP_ICON_PNG);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let bytes = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => bytes.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in bytes.chunks_exact(3) {
                out.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for chunk in bytes.chunks_exact(2) {
                out.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &g in bytes {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        _ => return None,
    };
    Some((rgba, info.width, info.height))
}

#[derive(Clone)]
struct ClipboardItem {
    id: String,
    text: String,
    time: u64,
    pinned: bool,
}

impl ClipboardItem {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "text": self.text,
            "time": self.time,
            "pinned": self.pinned
        })
    }
}

struct AppState {
    config: Arc<Mutex<ConfigManager>>,
    user_data: Arc<Mutex<UserDataManager>>,
    drop_zone: Arc<DropZone>,
    antigravity: Arc<Mutex<AntigravityMonitor>>,
    media: Arc<MediaController>,
    calls: Arc<Mutex<CallMonitor>>,
    notifications: Arc<Mutex<NotificationMonitor>>,
    clipboard_history: Arc<Mutex<Vec<ClipboardItem>>>,
    last_clip_text: Arc<Mutex<String>>,
    battery: Arc<Mutex<sys_win::BatteryStatus>>,

    game_mode_enabled: Arc<AtomicBool>,
    is_fullscreen: Arc<AtomicBool>,
    game_mode_ipc_hidden: Arc<AtomicBool>,
    ignore_mouse: Arc<AtomicBool>,
    overlay_hwnd: Arc<AtomicIsize>,
    overlay_scale: Arc<Mutex<f64>>,
    stop_all: Arc<AtomicBool>,

    last_media_sig: Mutex<String>,
    last_media_vol_sig: Mutex<String>,
    media_vol_tick: AtomicU64,
    hooks: Option<AgentHooksHandle>,

    tray: Option<TrayIcon>,
    tray_game_mode_item: Option<CheckMenuItem>,
}

impl AppState {
    fn is_paused_for_game_mode(&self) -> bool {
        self.game_mode_enabled.load(Ordering::SeqCst)
            && (self.is_fullscreen.load(Ordering::SeqCst)
                || self.game_mode_ipc_hidden.load(Ordering::SeqCst))
    }

    fn sync_monitors_paused(&self, paused: bool) {
        if let Ok(mut ag) = self.antigravity.lock() {
            ag.paused = paused;
        }
        if let Ok(mut c) = self.calls.lock() {
            c.paused = paused;
        }
        if let Ok(mut n) = self.notifications.lock() {
            n.paused = paused;
        }
    }

    fn enriched_dropzone_files(&self) -> Value {
        let raw = self.drop_zone.get_files();
        let ud = self.user_data.lock().unwrap();
        let enriched: Vec<Value> = raw
            .into_iter()
            .map(|mut f| {
                let fp = f
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let one_time = ud.is_one_time_file(&fp);
                if let Some(obj) = f.as_object_mut() {
                    obj.insert("oneTime".into(), Value::Bool(one_time));
                }
                f
            })
            .collect();
        Value::Array(enriched)
    }

    fn clipboard_json(&self) -> Value {
        let list = self.clipboard_history.lock().unwrap();
        Value::Array(list.iter().map(|c| c.to_json()).collect())
    }
}

fn dispatch_to_webview(wv: &WebView, channel: &str, payload: &Value) {
    let ch_json = serde_json::to_string(channel).unwrap_or_else(|_| "\"\"".into());
    let pl_json = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
    let script = format!(
        "window.__dwDispatch && window.__dwDispatch({}, {});",
        ch_json, pl_json
    );
    let _ = wv.evaluate_script(&script);
}

fn resolve_in_webview(wv: &WebView, id: u64, ok: bool, payload: &Value) {
    let pl_json = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
    let script = format!(
        "window.__dwResolve && window.__dwResolve({}, {}, {});",
        id, ok, pl_json
    );
    let _ = wv.evaluate_script(&script);
}

fn serve_protocol(path: &str) -> Response<Cow<'static, [u8]>> {
    if let Some(asset) = assets::get_asset(path) {
        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, asset.mime)
            .header("Access-Control-Allow-Origin", "*")
            .body(Cow::Borrowed(asset.bytes))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_TYPE, "text/plain")
            .body(Cow::Borrowed(&b"Not Found"[..]))
            .unwrap()
    }
}

fn build_settings_window(
    elwt: &EventLoopWindowTarget<UserEvent>,
    web_ctx: &mut WebContext,
    proxy: EventLoopProxy<UserEvent>,
    init_state_js: &str,
) -> Option<(Window, WebView)> {
    let mut wb = WindowBuilder::new()
        .with_title("Settings & Preferences — Dynamic Windows")
        .with_inner_size(LogicalSize::new(780.0, 580.0))
        .with_min_inner_size(LogicalSize::new(680.0, 500.0))
        .with_visible(true);

    if let Some((rgba, w, h)) = decode_app_icon_rgba() {
        if let Ok(icon) = WindowIcon::from_rgba(rgba, w, h) {
            wb = wb.with_window_icon(Some(icon));
        }
    }

    let window = wb.build(elwt).ok()?;
    let p_ipc = proxy.clone();
    let webview = WebViewBuilder::with_web_context(web_ctx)
        .with_additional_browser_args(LOW_MEM_BROWSER_ARGS)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_browser_extensions_enabled(false)
        .with_initialization_script(init_state_js)
        .with_custom_protocol("dw".into(), |_id, req| serve_protocol(req.uri().path()))
        .with_ipc_handler(move |req| {
            let _ = p_ipc.send_event(UserEvent::IpcFromSettings(req.body().clone()));
        })
        .with_url("dw://localhost/src/renderer/settings.html")
        .with_devtools(cfg!(debug_assertions))
        .build(&window)
        .ok()?;
    let _ = webview.set_memory_usage_level(MemoryUsageLevel::Low);
    Some((window, webview))
}

fn send_media_state(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
    force: bool,
) {
    if !force && state.is_paused_for_game_mode() {
        return;
    }
    let ms = state.media.get_state();
    let tr = ms.get("track");
    let has_media = tr
        .and_then(|t| t.get("source"))
        .and_then(|v| v.as_str())
        .map(|s| s != "none")
        .unwrap_or(false);
    let is_playing = ms
        .get("isPlaying")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let sig = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        if has_media { 1 } else { 0 },
        if is_playing { 1 } else { 0 },
        tr.and_then(|t| t.get("title")).and_then(|v| v.as_str()).unwrap_or(""),
        tr.and_then(|t| t.get("artist")).and_then(|v| v.as_str()).unwrap_or(""),
        tr.and_then(|t| t.get("album")).and_then(|v| v.as_str()).unwrap_or(""),
        tr.and_then(|t| t.get("source")).and_then(|v| v.as_str()).unwrap_or(""),
        ms.get("progress_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        ms.get("duration_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        tr.and_then(|t| t.get("image_url")).and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0),
        tr.and_then(|t| t.get("lyrics")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        tr.and_then(|t| t.get("timedLyrics")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
    );

    let changed = {
        let mut last = state.last_media_sig.lock().unwrap();
        if force || *last != sig {
            *last = sig;
            true
        } else {
            false
        }
    };
    if changed {
        let _ = proxy.send_event(UserEvent::DispatchJs {
            target: WindowTarget::Island,
            channel: "media-state".into(),
            payload: ms,
        });
    }

    let tick = state.media_vol_tick.fetch_add(1, Ordering::Relaxed) % 3;
    if force || is_playing || (has_media && tick == 0) {
        let hint = state.media.active_app_hint();
        let vol = sys_win::get_media_volume(&hint);
        let vsig = format!(
            "{}:{}:{}",
            vol.get("volume").and_then(|v| v.as_f64()).unwrap_or(1.0),
            if vol.get("muted").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 },
            vol.get("app").and_then(|v| v.as_str()).unwrap_or("")
        );
        let vchanged = {
            let mut lv = state.last_media_vol_sig.lock().unwrap();
            if force || *lv != vsig {
                *lv = vsig;
                true
            } else {
                false
            }
        };
        if vchanged {
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "media-volume-update".into(),
                payload: vol,
            });
        }
    }
}

fn push_initial_states(state: &AppState, proxy: &EventLoopProxy<UserEvent>) {
    let send = |ch: &str, val: Value| {
        let _ = proxy.send_event(UserEvent::DispatchJs {
            target: WindowTarget::Island,
            channel: ch.to_string(),
            payload: val,
        });
    };

    let ag_state = state.antigravity.lock().unwrap().get_state();
    send("antigravity-state", ag_state);
    send_media_state(state, proxy, true);
    let call_state = state.calls.lock().unwrap().get_state();
    send("call-state", call_state);
    send("dropzone-files", state.enriched_dropzone_files());

    let (
        display_mode,
        anim_speed,
        dyn_lyrics,
        live_lyrics,
        album_grad,
        opacity,
        liquid_glass,
        lite_mode,
        reduced_motion,
        sfx_en,
        sfx_vol,
        sfx_preset,
        font_family,
        user_name,
        clock_24h,
        show_secs,
        show_ampm,
    ) = {
        let cfg = state.config.lock().unwrap();
        (
            cfg.get_str("displayMode", "island"),
            cfg.get_f64("animationSpeed", 1.0),
            cfg.get_bool("dynamicLyrics", true),
            cfg.get_bool("liveLyrics", true),
            cfg.get_bool("albumColorGradient", true),
            cfg.get_f64("islandOpacity", 0.95),
            cfg.get_bool("liquidGlass", false),
            cfg.get_bool("liteMode", false),
            cfg.get_bool("reducedMotion", false),
            cfg.get_bool("soundEffects", true),
            cfg.get_f64("soundVolume", 0.7),
            cfg.get_str("soundPreset", "modern"),
            cfg.get_str("fontFamily", "Segoe UI Variable Text"),
            cfg.get_str("userName", ""),
            cfg.get_bool("clock24h", false),
            cfg.get_bool("showSeconds", false),
            cfg.get_bool("showAmPm", true),
        )
    };

    send("display-mode", json!(display_mode));
    send("animation-speed", json!(anim_speed));
    send("dynamic-lyrics-toggled", json!({ "enabled": dyn_lyrics }));
    send("live-lyrics-toggled", json!({ "enabled": live_lyrics }));
    send(
        "album-color-gradient-toggled",
        json!({ "enabled": album_grad }),
    );
    send("island-opacity-changed", json!({ "opacity": opacity }));
    let hwnd_init = state.overlay_hwnd.load(Ordering::SeqCst);
    sys_win::set_window_exclude_from_capture(hwnd_init, liquid_glass);
    send("liquid-glass-toggled", json!({ "enabled": liquid_glass }));
    {
        let cfg = state.config.lock().unwrap();
        send(
            "fps-limit-changed",
            json!({ "fpsLimit": cfg.get("fpsLimit").and_then(|v| v.as_u64()).unwrap_or(0) }),
        );
        send(
            "tab-bar-config-changed",
            json!({
                "tabBarPosition": cfg.get_str("tabBarPosition", "top"),
                "tabBarOrder": cfg.get("tabBarOrder").cloned().unwrap_or_else(|| json!([])),
                "tabBarHidden": cfg.get("tabBarHidden").cloned().unwrap_or_else(|| json!([]))
            }),
        );
        if let Some(arr) = cfg.get("aiProviders").and_then(|v| v.as_array()) {
            let list: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
            if let Ok(mut ag) = state.antigravity.lock() {
                ag.set_enabled_providers(&list);
            }
        }
    }
    send(
        "performance-settings-changed",
        json!({ "liteMode": lite_mode, "reducedMotion": reduced_motion }),
    );
    send(
        "sound-effects-config",
        json!({ "enabled": sfx_en, "volume": sfx_vol, "preset": sfx_preset }),
    );
    send("font-family-changed", json!({ "fontFamily": font_family }));
    send("user-name-changed", json!({ "userName": user_name }));
    send(
        "clock-settings-changed",
        json!({ "clock24h": clock_24h, "showSeconds": show_secs, "showAmPm": show_ampm }),
    );
    let notifs = state.notifications.lock().unwrap().get_notifications();
    send("notifications-updated", notifs);
    let batt = state.battery.lock().unwrap().to_json();
    send("battery-status-changed", batt);
}

fn apply_game_mode_visibility(state: &AppState, proxy: &EventLoopProxy<UserEvent>) {
    let hwnd = state.overlay_hwnd.load(Ordering::SeqCst);
    if hwnd == 0 {
        return;
    }
    let gm = state.game_mode_enabled.load(Ordering::SeqCst);
    let full = state.is_fullscreen.load(Ordering::SeqCst);
    if gm && full {
        let _ = proxy.send_event(UserEvent::SetOverlayVisible(false));
        state.sync_monitors_paused(true);
    } else {
        state.game_mode_ipc_hidden.store(false, Ordering::SeqCst);
        let was_paused = state.antigravity.lock().map(|g| g.paused).unwrap_or(false);
        state.sync_monitors_paused(false);
        let _ = proxy.send_event(UserEvent::SetOverlayVisible(true));
        if was_paused {
            *state.last_media_sig.lock().unwrap() = String::new();
            *state.last_media_vol_sig.lock().unwrap() = String::new();
            send_media_state(state, proxy, true);
        }
    }
}

fn set_game_mode(state: &AppState, proxy: &EventLoopProxy<UserEvent>, enabled: bool, source: &str) {
    state.game_mode_enabled.store(enabled, Ordering::SeqCst);
    state
        .config
        .lock()
        .unwrap()
        .set_key("gameMode", Value::Bool(enabled));
    apply_game_mode_visibility(state, proxy);
    if let Some(ref item) = state.tray_game_mode_item {
        item.set_checked(enabled);
    }
    let _ = proxy.send_event(UserEvent::DispatchJs {
        target: WindowTarget::All,
        channel: "game-mode-toggled".into(),
        payload: json!({
            "enabled": enabled,
            "isFullscreen": state.is_fullscreen.load(Ordering::SeqCst),
            "source": source
        }),
    });
}

fn handle_ipc_message(
    raw: &str,
    from: WindowTarget,
    state: &mut AppState,
    proxy: &EventLoopProxy<UserEvent>,
) {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let kind = msg.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let channel = msg.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    let args = msg
        .get("args")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let arg0 = args.first().cloned().unwrap_or(Value::Null);

    if kind == "invoke" {
        let req_id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let reply = |val: Value| {
            let _ = proxy.send_event(UserEvent::ResolveInvoke {
                target: from,
                id: req_id,
                ok: true,
                payload: val,
            });
        };

        match channel {
            "get-app-settings" => {
                let cfg = state.config.lock().unwrap().all_value();
                let dz_count = state.drop_zone.get_files().len();
                reply(json!({
                    "config": cfg,
                    "version": APP_VERSION,
                    "dropZonePath": state.drop_zone.dir.to_string_lossy().to_string(),
                    "dropZoneCount": dz_count
                }));
            }
            "save-app-settings" => {
                let patch = arg0.as_object().cloned().unwrap_or_default();
                let updated = state.config.lock().unwrap().merge(&patch);

                let bcast = |ch: &str, payload: Value| {
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::All,
                        channel: ch.into(),
                        payload,
                    });
                };

                if let Some(dm) = patch.get("displayMode").and_then(|v| v.as_str()) {
                    bcast("display-mode", json!(dm));
                }
                if let Some(sp) = patch.get("animationSpeed").and_then(|v| v.as_f64()) {
                    bcast("animation-speed", json!(sp));
                }
                if let Some(gm) = patch.get("gameMode").and_then(|v| v.as_bool()) {
                    set_game_mode(state, proxy, gm, "settings");
                }
                if let Some(dl) = patch.get("dynamicLyrics").and_then(|v| v.as_bool()) {
                    bcast("dynamic-lyrics-toggled", json!({ "enabled": dl }));
                }
                if let Some(ll) = patch.get("liveLyrics").and_then(|v| v.as_bool()) {
                    bcast("live-lyrics-toggled", json!({ "enabled": ll }));
                }
                if let Some(ag) = patch.get("albumColorGradient").and_then(|v| v.as_bool()) {
                    bcast("album-color-gradient-toggled", json!({ "enabled": ag }));
                }
                if let Some(op) = patch.get("islandOpacity").and_then(|v| v.as_f64()) {
                    bcast("island-opacity-changed", json!({ "opacity": op }));
                }
                if let Some(lg) = patch.get("liquidGlass").and_then(|v| v.as_bool()) {
                    let hwnd = state.overlay_hwnd.load(Ordering::SeqCst);
                    sys_win::set_window_exclude_from_capture(hwnd, lg);
                    bcast("liquid-glass-toggled", json!({ "enabled": lg }));
                }
                if patch.contains_key("tabBarPosition")
                    || patch.contains_key("tabBarOrder")
                    || patch.contains_key("tabBarHidden")
                {
                    let cfg = state.config.lock().unwrap();
                    bcast(
                        "tab-bar-config-changed",
                        json!({
                            "tabBarPosition": cfg.get_str("tabBarPosition", "top"),
                            "tabBarOrder": cfg.get("tabBarOrder").cloned().unwrap_or_else(|| json!([])),
                            "tabBarHidden": cfg.get("tabBarHidden").cloned().unwrap_or_else(|| json!([]))
                        }),
                    );
                }
                if patch.contains_key("liteMode") || patch.contains_key("reducedMotion") {
                    let cfg = state.config.lock().unwrap();
                    bcast(
                        "performance-settings-changed",
                        json!({
                            "liteMode": cfg.get_bool("liteMode", false),
                            "reducedMotion": cfg.get_bool("reducedMotion", false)
                        }),
                    );
                }
                if let Some(sup) = patch.get("suppressWindowsToasts").and_then(|v| v.as_bool()) {
                    state
                        .notifications
                        .lock()
                        .unwrap()
                        .set_suppress_windows_toasts(sup);
                }
                if patch.contains_key("soundEffects")
                    || patch.contains_key("soundVolume")
                    || patch.contains_key("soundPreset")
                {
                    let cfg = state.config.lock().unwrap();
                    bcast(
                        "sound-effects-config",
                        json!({
                            "enabled": cfg.get_bool("soundEffects", true),
                            "volume": cfg.get_f64("soundVolume", 0.7),
                            "preset": cfg.get_str("soundPreset", "modern")
                        }),
                    );
                }
                if let Some(ff) = patch.get("fontFamily").and_then(|v| v.as_str()) {
                    bcast("font-family-changed", json!({ "fontFamily": ff }));
                }
                if let Some(fps) = patch.get("fpsLimit").and_then(|v| v.as_u64()) {
                    bcast("fps-limit-changed", json!({ "fpsLimit": fps }));
                }
                if let Some(arr) = patch.get("aiProviders").and_then(|v| v.as_array()) {
                    let list: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
                    if let Ok(mut ag) = state.antigravity.lock() {
                        ag.set_enabled_providers(&list);
                    }
                    bcast("ai-providers-changed", json!({ "aiProviders": list }));
                }
                if let Some(mon) = patch.get("antigravityMonitor").and_then(|v| v.as_bool()) {
                    if let Ok(mut ag) = state.antigravity.lock() {
                        ag.paused = !mon;
                    }
                }
                if let Some(un) = patch.get("userName").and_then(|v| v.as_str()) {
                    bcast("user-name-changed", json!({ "userName": un }));
                }
                if patch.contains_key("clock24h")
                    || patch.contains_key("showSeconds")
                    || patch.contains_key("showAmPm")
                {
                    let cfg = state.config.lock().unwrap();
                    bcast(
                        "clock-settings-changed",
                        json!({
                            "clock24h": cfg.get_bool("clock24h", false),
                            "showSeconds": cfg.get_bool("showSeconds", false),
                            "showAmPm": cfg.get_bool("showAmPm", true)
                        }),
                    );
                }
                reply(updated);
            }
            "capture-liquid-backdrop" => {
                let hwnd = state.overlay_hwnd.load(Ordering::SeqCst);
                let scale = *state.overlay_scale.lock().unwrap();
                let x = arg0.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = arg0.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let w = arg0.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = arg0.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let p = proxy.clone();
                thread::spawn(move || {
                    let data_url = sys_win::capture_desktop_region_png_data_url(hwnd, x, y, w, h, scale);
                    let _ = p.send_event(UserEvent::ResolveInvoke {
                        target: from,
                        id: req_id,
                        ok: true,
                        payload: json!({ "dataUrl": data_url }),
                    });
                });
            }
            "check-github-update" => {
                let (owner, repo) = {
                    let cfg = state.config.lock().unwrap();
                    (
                        cfg.get_str("repoOwner", "voiceline-diskrep"),
                        cfg.get_str("repoName", "dynamic-windows"),
                    )
                };
                let p = proxy.clone();
                thread::spawn(move || {
                    let res = updater::check_for_github_update(&owner, &repo, APP_VERSION);
                    let _ = p.send_event(UserEvent::ResolveInvoke {
                        target: from,
                        id: req_id,
                        ok: true,
                        payload: res,
                    });
                });
            }
            "get-font-family" => {
                let ff = state.config.lock().unwrap().get_str("fontFamily", "Theater");
                reply(json!(ff));
            }
            "get-user-name" => {
                let un = state.config.lock().unwrap().get_str("userName", "");
                reply(json!(un));
            }
            "get-battery-status" => {
                let batt = sys_win::get_battery_status();
                *state.battery.lock().unwrap() = batt.clone();
                reply(batt.to_json());
            }
            "get-system-volume" => {
                reply(sys_win::get_system_volume());
            }
            "get-media-volume" => {
                let hint = arg0
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| state.media.active_app_hint());
                reply(sys_win::get_media_volume(&hint));
            }
            "get-notifications" => {
                let list = state.notifications.lock().unwrap().get_notifications();
                reply(list);
            }
            "calendar-get-notes" => {
                let notes = state.user_data.lock().unwrap().get_calendar_notes();
                reply(notes);
            }
            "calendar-get-categories" => {
                let cats = state.user_data.lock().unwrap().get_calendar_categories();
                reply(cats);
            }
            "calendar-add-category" => {
                let cat = arg0.as_str().unwrap_or("");
                let (ok, cats) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.add_calendar_category(cat);
                    (r, ud.get_calendar_categories())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "calendar-categories-updated".into(),
                    payload: cats,
                });
                reply(json!(ok));
            }
            "calendar-add-note" => {
                let (created, all, cats) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let c = ud.add_calendar_note(&arg0);
                    let a = ud.get_calendar_notes();
                    let cs = ud.get_calendar_categories();
                    (c, a, cs)
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "calendar-notes-updated".into(),
                    payload: all,
                });
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "calendar-categories-updated".into(),
                    payload: cats,
                });
                reply(created);
            }
            "calendar-delete-note" => {
                let id = arg0.as_str().unwrap_or("");
                let (ok, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.delete_calendar_note(id);
                    (r, ud.get_calendar_notes())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "calendar-notes-updated".into(),
                    payload: all,
                });
                reply(json!(ok));
            }
            "todo-get-data" => {
                let data = state.user_data.lock().unwrap().get_todos();
                reply(data);
            }
            "todo-add-task" => {
                let (created, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let c = ud.add_todo_task(&arg0);
                    (c, ud.get_todos())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "todo-data-updated".into(),
                    payload: all,
                });
                reply(created);
            }
            "todo-toggle-task" => {
                let id = arg0.as_str().unwrap_or("");
                let (upd, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let u = ud.toggle_todo_task(id);
                    (u, ud.get_todos())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "todo-data-updated".into(),
                    payload: all,
                });
                reply(upd);
            }
            "todo-delete-task" => {
                let id = arg0.as_str().unwrap_or("");
                let (ok, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.delete_todo_task(id);
                    (r, ud.get_todos())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "todo-data-updated".into(),
                    payload: all,
                });
                reply(json!(ok));
            }
            "todo-add-category" => {
                let cat = arg0.as_str().unwrap_or("");
                let (ok, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.add_todo_category(cat);
                    (r, ud.get_todos())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "todo-data-updated".into(),
                    payload: all,
                });
                reply(json!(ok));
            }
            "todo-delete-category" => {
                let cat = arg0.as_str().unwrap_or("");
                let (ok, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.delete_todo_category(cat);
                    (r, ud.get_todos())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "todo-data-updated".into(),
                    payload: all,
                });
                reply(json!(ok));
            }
            "notes-get-all" => {
                let list = state.user_data.lock().unwrap().get_notes();
                reply(list);
            }
            "notes-add" => {
                let (created, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let c = ud.add_note(&arg0);
                    (c, ud.get_notes())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "notes-updated".into(),
                    payload: all,
                });
                reply(created);
            }
            "notes-update" => {
                let (upd, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let u = ud.update_note(&arg0);
                    (u, ud.get_notes())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "notes-updated".into(),
                    payload: all,
                });
                reply(upd);
            }
            "notes-delete" => {
                let id = arg0.as_str().unwrap_or("");
                let (ok, all) = {
                    let mut ud = state.user_data.lock().unwrap();
                    let r = ud.delete_note(id);
                    (r, ud.get_notes())
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "notes-updated".into(),
                    payload: all,
                });
                reply(json!(ok));
            }
            "clock-get-state" => {
                let st = state.user_data.lock().unwrap().get_clock_state();
                reply(st);
            }
            "shelf-get-metadata" => {
                let md = state.user_data.lock().unwrap().get_shelf_metadata();
                reply(md);
            }
            "native-speech-recognize" => {
                let lang = arg0
                    .get("lang")
                    .and_then(|v| v.as_str())
                    .or_else(|| arg0.as_str())
                    .unwrap_or("en-US")
                    .to_string();
                let p = proxy.clone();
                spawn_lean("dw-speech", 256, move || {
                    let res = run_native_speech_fallback(&lang);
                    let _ = p.send_event(UserEvent::ResolveInvoke {
                        target: from,
                        id: req_id,
                        ok: true,
                        payload: res,
                    });
                });
            }
            _ => {
                reply(Value::Null);
            }
        }
        return;
    }

    // Handle fire-and-forget `send` channels
    match channel {
        "__dw-renderer-ready" => {
            if from == WindowTarget::Island {
                config::append_log("server.log", "[Renderer] island.html ready");
                push_initial_states(state, proxy);
            }
        }
        "log-renderer-error" => {
            if let Some(s) = arg0.as_str() {
                config::append_log("renderer_error.log", s);
            }
        }
        "set-ignore-mouse-events" => {
            let ignore = arg0.as_bool().unwrap_or(true);
            state.ignore_mouse.store(ignore, Ordering::SeqCst);
            let _ = proxy.send_event(UserEvent::SetIgnoreCursor(ignore));
        }
        "set-onboarding-fullscreen" => {
            let full = arg0.as_bool().unwrap_or(false);
            let _ = proxy.send_event(UserEvent::SetOnboardingFullscreen(full));
        }
        "trigger-first-time-onboarding" => {
            let _ = proxy.send_event(UserEvent::TriggerOnboarding);
        }
        "window-bounds-update" | "island-hover-start" | "island-hover-end" => {}
        "focus-antigravity" => {
            let ag = state.antigravity.clone();
            let p = proxy.clone();
            let provider_hint = arg0
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| {
                    arg0.get("provider")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            thread::spawn(move || {
                let focused = if provider_hint.to_lowercase().contains("claude") {
                    sys_win::focus_process("Claude")
                        || sys_win::focus_process("WindowsTerminal")
                        || sys_win::focus_process("Code")
                } else if provider_hint.to_lowercase().contains("codex") {
                    sys_win::focus_process("Codex")
                        || sys_win::focus_process("ChatGPT")
                        || sys_win::focus_process("WindowsTerminal")
                } else {
                    sys_win::focus_process("Antigravity")
                };
                if !focused && provider_hint.is_empty() {
                    let mut g = ag.lock().unwrap();
                    g.mark_not_running();
                    let st = g.get_state();
                    let _ = p.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::Island,
                        channel: "antigravity-state".into(),
                        payload: st,
                    });
                }
            });
        }
        "permission-response" => {
            let id = arg0.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let allow = arg0.get("allow").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(ref h) = state.hooks {
                h.respond_permission(id, allow);
            }
        }
        "media-play-pause" => {
            let m = state.media.clone();
            let p = proxy.clone();
            thread::spawn(move || {
                m.play_pause();
                let _ = p.send_event(UserEvent::MediaChanged);
            });
        }
        "media-next" => {
            let m = state.media.clone();
            thread::spawn(move || m.next_track());
        }
        "media-prev" => {
            let m = state.media.clone();
            thread::spawn(move || m.prev_track());
        }
        "media-seek" => {
            let ms = arg0.as_f64().unwrap_or(0.0).round() as i64;
            let m = state.media.clone();
            let p = proxy.clone();
            thread::spawn(move || {
                m.seek(ms);
                let _ = p.send_event(UserEvent::MediaChanged);
            });
        }
        "media-set-speed" => {
            let rate = arg0.as_f64();
            state.media.set_playback_speed(rate);
            send_media_state(state, proxy, true);
        }
        "media-set-offset" => {
            let off = arg0.as_f64().unwrap_or(0.0).round() as i64;
            state.media.set_lyric_offset(off);
            send_media_state(state, proxy, true);
        }
        "set-game-mode" => {
            let enabled = arg0.as_bool().unwrap_or(true);
            set_game_mode(state, proxy, enabled, "ui");
        }
        "toggle-game-mode" => {
            let cur = state.game_mode_enabled.load(Ordering::SeqCst);
            set_game_mode(state, proxy, !cur, "ui");
        }
        "game-mode-hide" => {
            let hide = arg0.as_bool().unwrap_or(false);
            if hide && state.game_mode_enabled.load(Ordering::SeqCst) {
                state.game_mode_ipc_hidden.store(true, Ordering::SeqCst);
                let _ = proxy.send_event(UserEvent::SetOverlayVisible(false));
                state.sync_monitors_paused(true);
            } else {
                state.game_mode_ipc_hidden.store(false, Ordering::SeqCst);
                state.sync_monitors_paused(false);
                let _ = proxy.send_event(UserEvent::SetOverlayVisible(true));
            }
        }
        "open-dropzone" | "settings-open-dropzone" => {
            state.drop_zone.reveal_in_explorer(None);
        }
        "dropzone-add-file" => {
            let (fp, is_one_time) = if let Some(s) = arg0.as_str() {
                (s.to_string(), false)
            } else {
                (
                    arg0.get("filePath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    arg0.get("isOneTime")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                )
            };
            if !fp.is_empty() {
                if let Some(dest) = state.drop_zone.add_file(&fp) {
                    state
                        .user_data
                        .lock()
                        .unwrap()
                        .set_file_shelf_metadata(&dest.to_string_lossy(), is_one_time);
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::Island,
                        channel: "dropzone-files".into(),
                        payload: state.enriched_dropzone_files(),
                    });
                }
            }
        }
        "dropzone-open-file" => {
            if let Some(name) = arg0.as_str() {
                state.drop_zone.open_file(name);
            }
        }
        "dropzone-delete-file" => {
            if let Some(name) = arg0.as_str() {
                let full = if Path::new(name).is_absolute() {
                    name.to_string()
                } else {
                    state.drop_zone.dir.join(name).to_string_lossy().to_string()
                };
                state
                    .user_data
                    .lock()
                    .unwrap()
                    .remove_file_shelf_metadata(&full);
                let base = Path::new(name)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| name.to_string());
                state.drop_zone.delete_file(&base);
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "dropzone-files".into(),
                    payload: state.enriched_dropzone_files(),
                });
            }
        }
        "dropzone-clear-all" => {
            state.drop_zone.clear_all();
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "dropzone-files".into(),
                payload: state.enriched_dropzone_files(),
            });
        }
        "dropzone-browse-file" => {
            let dz = state.drop_zone.clone();
            let p = proxy.clone();
            thread::spawn(move || {
                let picked = sys_win::open_files_dialog();
                if !picked.is_empty() {
                    for fp in &picked {
                        dz.add_file(fp);
                    }
                    let _ = p.send_event(UserEvent::DropFiles(Vec::new(), false));
                }
            });
        }
        "shelf-drag-start" => {
            let (fp, payload_one_time) = if let Some(s) = arg0.as_str() {
                (s.to_string(), false)
            } else {
                (
                    arg0.get("filePath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    arg0.get("oneTime")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                )
            };
            if !fp.is_empty() && Path::new(&fp).exists() {
                let should_clear = payload_one_time
                    || state.user_data.lock().unwrap().is_one_time_file(&fp);
                let dropped = sys_win::start_native_file_drag(&fp);
                if should_clear && dropped {
                    let p = proxy.clone();
                    let clear_path = fp.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(350));
                        let _ = p.send_event(UserEvent::ShelfAutoClear(clear_path));
                    });
                }
            }
        }
        "shelf-drag-completed" => {
            if let Some(fp) = arg0.as_str() {
                let is_ot = state.user_data.lock().unwrap().is_one_time_file(fp);
                if is_ot {
                    let _ = proxy.send_event(UserEvent::ShelfAutoClear(fp.to_string()));
                }
            }
        }
        "shelf-set-metadata" => {
            let fp = arg0.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
            let is_ot = arg0
                .get("isOneTime")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let md = {
                let mut ud = state.user_data.lock().unwrap();
                ud.set_file_shelf_metadata(fp, is_ot);
                ud.get_shelf_metadata()
            };
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "shelf-metadata-updated".into(),
                payload: md,
            });
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "dropzone-files".into(),
                payload: state.enriched_dropzone_files(),
            });
        }
        "shelf-remove-metadata" => {
            if let Some(fp) = arg0.as_str() {
                let md = {
                    let mut ud = state.user_data.lock().unwrap();
                    ud.remove_file_shelf_metadata(fp);
                    ud.get_shelf_metadata()
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "shelf-metadata-updated".into(),
                    payload: md,
                });
            }
        }
        "set-display-mode" => {
            if let Some(mode) = arg0.as_str() {
                if mode == "island" || mode == "notch" {
                    let (speed, dl) = {
                        let mut cfg = state.config.lock().unwrap();
                        cfg.set_key("displayMode", json!(mode));
                        (
                            cfg.get_f64("animationSpeed", 1.0),
                            cfg.get_bool("dynamicLyrics", true),
                        )
                    };
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::All,
                        channel: "display-mode".into(),
                        payload: json!(mode),
                    });
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::All,
                        channel: "animation-speed".into(),
                        payload: json!(speed),
                    });
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::All,
                        channel: "dynamic-lyrics-toggled".into(),
                        payload: json!({ "enabled": dl }),
                    });
                }
            }
        }
        "set-dynamic-lyrics" => {
            let enabled = arg0.as_bool().unwrap_or(true);
            state
                .config
                .lock()
                .unwrap()
                .set_key("dynamicLyrics", json!(enabled));
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::All,
                channel: "dynamic-lyrics-toggled".into(),
                payload: json!({ "enabled": enabled }),
            });
        }
        "set-font-family" => {
            if let Some(f) = arg0.as_str() {
                let clean = f.trim().to_string();
                if !clean.is_empty() {
                    state
                        .config
                        .lock()
                        .unwrap()
                        .set_key("fontFamily", json!(clean));
                    let _ = proxy.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::All,
                        channel: "font-family-changed".into(),
                        payload: json!({ "fontFamily": clean }),
                    });
                }
            }
        }
        "set-user-name" => {
            if let Some(n) = arg0.as_str() {
                let clean = n.trim().to_string();
                state
                    .config
                    .lock()
                    .unwrap()
                    .set_key("userName", json!(clean));
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::All,
                    channel: "user-name-changed".into(),
                    payload: json!({ "userName": clean }),
                });
            }
        }
        "set-system-volume" => {
            let v = arg0.as_f64().unwrap_or(0.5) as f32;
            let p = proxy.clone();
            thread::spawn(move || {
                let res = sys_win::set_system_volume(v);
                let _ = p.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::All,
                    channel: "volume-update".into(),
                    payload: res,
                });
            });
        }
        "toggle-system-mute" => {
            let p = proxy.clone();
            thread::spawn(move || {
                let res = sys_win::toggle_system_mute();
                let _ = p.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::All,
                    channel: "volume-update".into(),
                    payload: res,
                });
            });
        }
        "set-media-volume" => {
            let (val, app_hint) = if let Some(obj) = arg0.as_object() {
                (
                    obj.get("val").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32,
                    obj.get("app")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            } else {
                (arg0.as_f64().unwrap_or(1.0) as f32, String::new())
            };
            let hint = if app_hint.is_empty() {
                state.media.active_app_hint()
            } else {
                app_hint
            };
            let p = proxy.clone();
            thread::spawn(move || {
                let res = sys_win::set_media_volume(val, &hint);
                let _ = p.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::All,
                    channel: "media-volume-update".into(),
                    payload: res,
                });
            });
        }
        "toggle-media-mute" => {
            let hint = arg0
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| state.media.active_app_hint());
            let p = proxy.clone();
            thread::spawn(move || {
                let res = sys_win::toggle_media_mute(&hint);
                let _ = p.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::All,
                    channel: "media-volume-update".into(),
                    payload: res,
                });
            });
        }
        "clipboard-get" => {
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "clipboard-update".into(),
                payload: state.clipboard_json(),
            });
        }
        "clipboard-copy" => {
            if let Some(cid) = arg0.as_str() {
                let mut hist = state.clipboard_history.lock().unwrap();
                if let Some(item) = hist.iter_mut().find(|c| c.id == cid) {
                    let txt = item.text.clone();
                    item.time = now_ms();
                    sys_win::clipboard_write_text(&txt);
                    *state.last_clip_text.lock().unwrap() = txt;
                }
                let mut pinned: Vec<_> = hist.iter().filter(|c| c.pinned).cloned().collect();
                let unpinned: Vec<_> = hist.iter().filter(|c| !c.pinned).cloned().collect();
                pinned.extend(unpinned);
                *hist = pinned;
                drop(hist);
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "clipboard-update".into(),
                    payload: state.clipboard_json(),
                });
            }
        }
        "clipboard-pin" => {
            if let Some(cid) = arg0.as_str() {
                let mut hist = state.clipboard_history.lock().unwrap();
                if let Some(item) = hist.iter_mut().find(|c| c.id == cid) {
                    item.pinned = !item.pinned;
                }
                let mut pinned: Vec<_> = hist.iter().filter(|c| c.pinned).cloned().collect();
                let unpinned: Vec<_> = hist.iter().filter(|c| !c.pinned).cloned().collect();
                pinned.extend(unpinned);
                *hist = pinned;
                drop(hist);
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "clipboard-update".into(),
                    payload: state.clipboard_json(),
                });
            }
        }
        "clipboard-clear" => {
            {
                let mut hist = state.clipboard_history.lock().unwrap();
                hist.retain(|c| c.pinned);
            }
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "clipboard-update".into(),
                payload: state.clipboard_json(),
            });
        }
        "open-settings" => {
            let _ = proxy.send_event(UserEvent::OpenSettings);
        }
        "open-external-url" => {
            if let Some(u) = arg0.as_str() {
                if u.starts_with("https://") || u.starts_with("http://") {
                    sys_win::shell_open(u);
                }
            }
        }
        "call-action" => {
            if let Some(act) = arg0.as_str() {
                let act_s = act.to_string();
                let calls = state.calls.clone();
                let p = proxy.clone();
                thread::spawn(move || {
                    let st = {
                        let mut c = calls.lock().unwrap();
                        c.handle_action(&act_s);
                        c.get_state()
                    };
                    let _ = p.send_event(UserEvent::DispatchJs {
                        target: WindowTarget::Island,
                        channel: "call-state".into(),
                        payload: st,
                    });
                });
            }
        }
        "dismiss-notification" => {
            if let Some(id) = arg0.as_str() {
                let list = {
                    let mut n = state.notifications.lock().unwrap();
                    n.dismiss(id);
                    n.get_notifications()
                };
                let _ = proxy.send_event(UserEvent::DispatchJs {
                    target: WindowTarget::Island,
                    channel: "notifications-updated".into(),
                    payload: list,
                });
            }
        }
        "clear-all-notifications" => {
            let list = {
                let mut n = state.notifications.lock().unwrap();
                n.clear_all();
                n.get_notifications()
            };
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "notifications-updated".into(),
                payload: list,
            });
        }
        "mark-notifications-read" => {
            let list = {
                let mut n = state.notifications.lock().unwrap();
                n.mark_all_read();
                n.get_notifications()
            };
            let _ = proxy.send_event(UserEvent::DispatchJs {
                target: WindowTarget::Island,
                channel: "notifications-updated".into(),
                payload: list,
            });
        }
        "focus-app" => {
            if let Some(app_name) = arg0.as_str() {
                let name = app_name.to_string();
                thread::spawn(move || {
                    sys_win::focus_process(&name);
                });
            }
        }
        "clock-save-state" => {
            state.user_data.lock().unwrap().save_clock_state(&arg0);
        }
        "exit-app" => {
            let _ = proxy.send_event(UserEvent::ExitApp);
        }
        _ => {}
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        config::append_log("crash.log", &format!("[PANIC] {}", info));
    }));

    let _single_instance = match sys_win::acquire_single_instance() {
        Some(g) => g,
        None => return,
    };

    sys_win::restore_work_area();

    let cfg_mgr = ConfigManager::new();
    let initial_game_mode = cfg_mgr.get_bool("gameMode", true);
    let initial_suppress_toasts = cfg_mgr.get_bool("suppressWindowsToasts", false);
    let hooks_port = cfg_mgr
        .get("hooksPort")
        .and_then(|v| v.as_u64())
        .unwrap_or(47823) as u16;
    let auto_check_updates = cfg_mgr.get_bool("autoCheckUpdates", true);
    let repo_owner = cfg_mgr.get_str("repoOwner", "voiceline-diskrep");
    let repo_name = cfg_mgr.get_str("repoName", "dynamic-windows");

    let config = Arc::new(Mutex::new(cfg_mgr));
    let user_data = Arc::new(Mutex::new(UserDataManager::new()));
    let drop_zone = Arc::new(DropZone::new());
    let antigravity = Arc::new(Mutex::new(AntigravityMonitor::new()));
    let media = Arc::new(MediaController::new());
    let calls = Arc::new(Mutex::new(CallMonitor::new()));
    let notifications = Arc::new(Mutex::new(NotificationMonitor::new(initial_suppress_toasts)));
    let clipboard_history = Arc::new(Mutex::new(Vec::<ClipboardItem>::new()));
    let last_clip_text = Arc::new(Mutex::new(String::new()));
    let battery = Arc::new(Mutex::new(sys_win::get_battery_status()));

    let game_mode_enabled = Arc::new(AtomicBool::new(initial_game_mode));
    let is_fullscreen = Arc::new(AtomicBool::new(false));
    let game_mode_ipc_hidden = Arc::new(AtomicBool::new(false));
    let ignore_mouse = Arc::new(AtomicBool::new(true));
    let overlay_hwnd = Arc::new(AtomicIsize::new(0));
    let overlay_scale = Arc::new(Mutex::new(1.0f64));
    let stop_all = Arc::new(AtomicBool::new(false));

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Shared WebView2 UserDataFolder in %LOCALAPPDATA%\DynamicWindows\WebView2
    let wv2_dir = config::log_dir()
        .parent()
        .map(|p| p.join("WebView2"))
        .unwrap_or_else(|| config::data_dir().join("WebView2"));
    let _ = std::fs::create_dir_all(&wv2_dir);
    let mut web_ctx = WebContext::new(Some(wv2_dir));

    // Calculate centered top-of-screen physical coordinates
    let (init_x, init_scale) = if let Some(mon) = event_loop.primary_monitor() {
        let size = mon.size();
        let pos = mon.position();
        let scale = mon.scale_factor();
        let phys_w = (ISLAND_W * scale).round() as i32;
        (pos.x + (size.width as i32 - phys_w) / 2, scale)
    } else {
        (440, 1.0)
    };
    *overlay_scale.lock().unwrap() = init_scale;

    let init_state_js = format!(
        "window.__DW_INIT_STATE__ = {{ gameMode: {{ enabled: {}, isFullscreen: false }}, dropzoneFiles: [] }};",
        if initial_game_mode { "true" } else { "false" }
    );

    let island_window = WindowBuilder::new()
        .with_title("Dynamic Windows")
        .with_inner_size(LogicalSize::new(ISLAND_W, ISLAND_H))
        .with_position(PhysicalPosition::new(init_x, 0))
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_resizable(false)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .with_visible(true)
        .build(&event_loop)
        .expect("Failed to create overlay window");

    let hwnd_raw = island_window.hwnd();
    overlay_hwnd.store(hwnd_raw, Ordering::SeqCst);
    let _ = island_window.set_ignore_cursor_events(true);
    sys_win::apply_overlay_styles(hwnd_raw);

    let p_ipc = proxy.clone();
    let p_dd = proxy.clone();
    let scale_dd = overlay_scale.clone();

    let island_webview = WebViewBuilder::with_web_context(&mut web_ctx)
        .with_additional_browser_args(LOW_MEM_BROWSER_ARGS)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_browser_extensions_enabled(false)
        .with_transparent(true)
        .with_initialization_script(&init_state_js)
        .with_custom_protocol("dw".into(), |_id, req| serve_protocol(req.uri().path()))
        .with_ipc_handler(move |req| {
            let _ = p_ipc.send_event(UserEvent::IpcFromIsland(req.body().clone()));
        })
        .with_drag_drop_handler(move |ev| {
            let scale = *scale_dd.lock().unwrap();
            match ev {
                DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
                    let _ = p_dd.send_event(UserEvent::DragOver(
                        position.0 as f64 / scale,
                        position.1 as f64 / scale,
                    ));
                }
                DragDropEvent::Leave => {
                    let _ = p_dd.send_event(UserEvent::DragLeave);
                }
                DragDropEvent::Drop { paths, position } => {
                    let lx = position.0 as f64 / scale;
                    let is_one_time = lx < (ISLAND_W / 2.0);
                    let list: Vec<String> = paths
                        .into_iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();
                    let _ = p_dd.send_event(UserEvent::DropFiles(list, is_one_time));
                }
                _ => {}
            }
            true
        })
        .with_url("dw://localhost/src/renderer/island.html")
        .with_devtools(cfg!(debug_assertions))
        .build(&island_window)
        .expect("Failed to initialize WebView2");
    allow_webview_microphone(&island_webview);
    let _ = island_webview.set_memory_usage_level(MemoryUsageLevel::Low);

    // System Tray
    let tray_menu = Menu::new();
    let item_game_mode = CheckMenuItem::with_id(
        "tray_game_mode",
        "Game Mode (Auto-hide in games)",
        true,
        initial_game_mode,
        None,
    );
    let item_dropzone = MenuItem::with_id("tray_dropzone", "Open Drop Zone Folder", true, None);
    let item_settings =
        MenuItem::with_id("tray_settings", "Settings & Preferences...", true, None);
    let item_exit = MenuItem::with_id("tray_exit", "Exit Dynamic Windows", true, None);
    let _ = tray_menu.append_items(&[
        &item_game_mode,
        &PredefinedMenuItem::separator(),
        &item_dropzone,
        &item_settings,
        &PredefinedMenuItem::separator(),
        &item_exit,
    ]);

    let tray = decode_app_icon_rgba()
        .and_then(|(rgba, w, h)| TrayIconImg::from_rgba(rgba, w, h).ok())
        .and_then(|icon| {
            TrayIconBuilder::new()
                .with_tooltip(format!("Dynamic Windows (v{})", APP_VERSION))
                .with_icon(icon)
                .with_menu(Box::new(tray_menu))
                .build()
                .ok()
        });

    let p_menu = proxy.clone();
    spawn_lean("dw-tray", 128, move || {
        let rx = MenuEvent::receiver();
        while let Ok(ev) = rx.recv() {
            let _ = p_menu.send_event(UserEvent::TrayMenu(ev.id.0));
        }
    });

    // Global Hotkeys (Ctrl+Shift+G, Ctrl+Alt+T, Ctrl+Alt+H)
    let _hotkey_mgr = GlobalHotKeyManager::new().ok();
    let hk_gamemode = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyG);
    let hk_untuck = HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);
    let hk_tuck = HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyH);
    let hk_gamemode_id = hk_gamemode.id();
    let hk_untuck_id = hk_untuck.id();
    let hk_tuck_id = hk_tuck.id();
    if let Some(ref mgr) = _hotkey_mgr {
        let _ = mgr.register(hk_gamemode);
        let _ = mgr.register(hk_untuck);
        let _ = mgr.register(hk_tuck);
    }
    let p_hk = proxy.clone();
    spawn_lean("dw-hotkeys", 128, move || {
        let rx = GlobalHotKeyEvent::receiver();
        while let Ok(ev) = rx.recv() {
            if ev.state == HotKeyState::Pressed {
                let _ = p_hk.send_event(UserEvent::Hotkey(ev.id));
            }
        }
    });

    // Agent Hooks & MCP HTTP Server (127.0.0.1:47823)
    let p_hooks = proxy.clone();
    let ag_state_ref = antigravity.clone();
    let cfg_state_ref = config.clone();
    let dz_state_ref = drop_zone.clone();
    let hooks_handle = start_hooks_server(
        hooks_port,
        move |evt| {
            let _ = p_hooks.send_event(UserEvent::Hook(evt));
        },
        move || {
            let status = ag_state_ref
                .lock()
                .map(|g| {
                    g.get_state()
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("idle")
                        .to_string()
                })
                .unwrap_or_else(|_| "idle".to_string());
            let dm = cfg_state_ref
                .lock()
                .map(|c| c.get_str("displayMode", "island"))
                .unwrap_or_else(|_| "island".to_string());
            json!({
                "status": status,
                "displayMode": dm,
                "shelfFiles": dz_state_ref.get_files()
            })
        },
    );

    // 1. Cursor-forwarding thread for click-through hover/lump interaction (emulates Electron forward:true)
    {
        let stop = stop_all.clone();
        let ign = ignore_mouse.clone();
        let hwnd_ref = overlay_hwnd.clone();
        let scale_ref = overlay_scale.clone();
        let p = proxy.clone();
        spawn_lean("dw-cursor", 256, move || {
            let mut was_inside = false;
            let mut last_pt = (i32::MIN, i32::MIN);
            while !stop.load(Ordering::SeqCst) {
                let hwnd = hwnd_ref.load(Ordering::SeqCst);
                if hwnd != 0 && ign.load(Ordering::SeqCst) {
                    if let (Some((cx, cy)), Some((l, t, r, _b))) =
                        (sys_win::get_cursor_pos(), sys_win::get_window_rect(hwnd))
                    {
                        let sc = *scale_ref.lock().unwrap();
                        // While click-through (collapsed), only monitor the narrow top capsule strip (~96px)
                        // so normal mouse work in the top half of the screen never triggers JS evals.
                        let hover_band_bottom = t + (96.0 * sc).round() as i32;
                        let inside = cx >= l && cx < r && cy >= t && cy < hover_band_bottom;
                        if inside {
                            if (cx, cy) != last_pt || !was_inside {
                                last_pt = (cx, cy);
                                was_inside = true;
                                let lx = (cx - l) as f64 / sc;
                                let ly = (cy - t) as f64 / sc;
                                let _ = p.send_event(UserEvent::EvalIsland(format!(
                                    "window.__dwForwardMouse && window.__dwForwardMouse({:.1}, {:.1});",
                                    lx, ly
                                )));
                            }
                            thread::sleep(Duration::from_millis(24));
                            continue;
                        } else if was_inside {
                            was_inside = false;
                            last_pt = (i32::MIN, i32::MIN);
                            let _ = p.send_event(UserEvent::EvalIsland(
                                "window.__dwForwardMouseLeave && window.__dwForwardMouseLeave();"
                                    .to_string(),
                            ));
                        }
                        let near_top = cy < hover_band_bottom + 120;
                        thread::sleep(Duration::from_millis(if near_top { 32 } else { 85 }));
                        continue;
                    }
                } else {
                    was_inside = false;
                }
                thread::sleep(Duration::from_millis(32));
            }
        });
    }

    // 2. Native WinRT GSMTC Media + Periodic Sync Thread (450ms poll, 1500ms tick)
    {
        let stop = stop_all.clone();
        let m = media.clone();
        let p = proxy.clone();
        let p_lyrics = proxy.clone();
        let on_lyrics = Arc::new(move || {
            let _ = p_lyrics.send_event(UserEvent::MediaChanged);
        });
        spawn_lean("dw-media", 256, move || {
            let mut tick_accum = 0u64;
            while !stop.load(Ordering::SeqCst) {
                if m.poll_gsmtc(on_lyrics.clone()) {
                    let _ = p.send_event(UserEvent::MediaChanged);
                }
                tick_accum += 450;
                if tick_accum >= 1500 {
                    tick_accum = 0;
                    let _ = p.send_event(UserEvent::MediaTick);
                }
                thread::sleep(Duration::from_millis(450));
            }
        });
    }

    // 3. Consolidated background monitors & idle working-set trimmer (single 256 KB thread)
    {
        let stop = stop_all.clone();
        let hwnd_ref = overlay_hwnd.clone();
        let ag = antigravity.clone();
        let c = calls.clone();
        let n = notifications.clone();
        let batt_ref = battery.clone();
        let hist_ref = clipboard_history.clone();
        let last_ref = last_clip_text.clone();
        let gm = game_mode_enabled.clone();
        let full = is_fullscreen.clone();
        let p = proxy.clone();

        spawn_lean("dw-monitors", 256, move || {
            let first_batt = sys_win::get_battery_status();
            let has_batt = first_batt.has_battery;
            *batt_ref.lock().unwrap() = first_batt.clone();
            let _ = p.send_event(UserEvent::BatteryChanged(first_batt));

            let mut last_full = false;
            let mut last_seq = sys_win::clipboard_sequence_number();
            let start = Instant::now();
            let mut last_ag = Instant::now() - Duration::from_secs(10);
            let mut ag_active = false;
            let mut last_call = Instant::now() - Duration::from_secs(10);
            let mut in_call = false;
            let mut last_clip = Instant::now();
            let mut last_notif = Instant::now() - Duration::from_secs(10);
            let mut last_batt = Instant::now();
            let mut initial_trim_done = false;

            while !stop.load(Ordering::SeqCst) {
                let now = Instant::now();

                // Fullscreen Game Mode check (~500ms)
                let f = sys_win::is_fullscreen_app(hwnd_ref.load(Ordering::SeqCst));
                if f != last_full {
                    last_full = f;
                    let _ = p.send_event(UserEvent::FullscreenChanged(f));
                }

                // Antigravity transcript check (500ms active / 1500ms idle)
                let ag_iv = if ag_active {
                    Duration::from_millis(500)
                } else {
                    Duration::from_millis(1500)
                };
                if now.duration_since(last_ag) >= ag_iv {
                    last_ag = now;
                    let (changed, active) = {
                        let mut g = ag.lock().unwrap();
                        let ch = g.poll();
                        (ch, g.has_active())
                    };
                    ag_active = active;
                    if changed {
                        let _ = p.send_event(UserEvent::AntigravityChanged);
                    }
                }

                // Clipboard check (1s)
                if now.duration_since(last_clip) >= Duration::from_secs(1) {
                    last_clip = now;
                    if !(gm.load(Ordering::SeqCst) && full.load(Ordering::SeqCst)) {
                        let seq = sys_win::clipboard_sequence_number();
                        if seq != last_seq {
                            last_seq = seq;
                            if let Some(text) = sys_win::clipboard_read_text() {
                                if !text.is_empty() && *last_ref.lock().unwrap() != text {
                                    *last_ref.lock().unwrap() = text.clone();
                                    let clean = text.trim().to_string();
                                    if !clean.is_empty() && clean.len() <= 50_000 {
                                        let json_list = {
                                            let mut hist = hist_ref.lock().unwrap();
                                            let was_pinned = hist
                                                .iter()
                                                .find(|it| it.text == clean)
                                                .map(|it| it.pinned)
                                                .unwrap_or(false);
                                            hist.retain(|it| it.text != clean);
                                            let item = ClipboardItem {
                                                id: format!("clip_{}_{:x}", now_ms(), seq),
                                                text: clean,
                                                time: now_ms(),
                                                pinned: was_pinned,
                                            };
                                            let mut pinned: Vec<_> =
                                                hist.iter().filter(|it| it.pinned).cloned().collect();
                                            let unpinned: Vec<_> = hist
                                                .iter()
                                                .filter(|it| !it.pinned)
                                                .cloned()
                                                .collect();
                                            let mut next = Vec::with_capacity(25);
                                            if was_pinned {
                                                next.push(item);
                                                next.extend(pinned);
                                                next.extend(unpinned);
                                            } else {
                                                next.append(&mut pinned);
                                                next.push(item);
                                                next.extend(unpinned);
                                            }
                                            next.truncate(25);
                                            let arr =
                                                Value::Array(next.iter().map(|it| it.to_json()).collect());
                                            *hist = next;
                                            arr
                                        };
                                        let _ = p.send_event(UserEvent::ClipboardChanged(json_list));
                                    }
                                }
                            }
                        }
                    }
                }

                // Call check (1s in call / 3s idle)
                let call_iv = if in_call {
                    Duration::from_secs(1)
                } else {
                    Duration::from_secs(3)
                };
                if now.duration_since(last_call) >= call_iv {
                    last_call = now;
                    let (changed, active_call) = {
                        let mut g = c.lock().unwrap();
                        let ch = g.poll();
                        (ch, g.is_in_call())
                    };
                    in_call = active_call;
                    if changed {
                        let _ = p.send_event(UserEvent::CallChanged);
                    }
                }

                // Native WinRT Toast Notifications check (1.5s when suppressing toasts, 3s normal)
                let notif_iv = {
                    let g = n.lock().unwrap();
                    if g.suppress_windows_toasts {
                        Duration::from_millis(1500)
                    } else {
                        Duration::from_secs(3)
                    }
                };
                if now.duration_since(last_notif) >= notif_iv {
                    last_notif = now;
                    let (alerts, updated) = {
                        let mut g = n.lock().unwrap();
                        g.poll()
                    };
                    if updated || !alerts.is_empty() {
                        let _ = p.send_event(UserEvent::NotificationsPollResult(alerts, updated));
                    }
                }

                // Battery check (15s on laptops only)
                if has_batt && now.duration_since(last_batt) >= Duration::from_secs(15) {
                    last_batt = now;
                    if !(gm.load(Ordering::SeqCst) && full.load(Ordering::SeqCst)) {
                        let next = sys_win::get_battery_status();
                        let changed = {
                            let mut g = batt_ref.lock().unwrap();
                            if *g != next {
                                *g = next.clone();
                                true
                            } else {
                                false
                            }
                        };
                        if changed {
                            let _ = p.send_event(UserEvent::BatteryChanged(next));
                        }
                    }
                }

                // Working-set trim once after startup settles (+8s) — avoid periodic trimming
                // during active sessions so live V8/GPU code pages are never evicted and re-faulted.
                if !initial_trim_done && now.duration_since(start) >= Duration::from_secs(8) {
                    initial_trim_done = true;
                    sys_win::trim_process_tree_memory();
                }

                thread::sleep(Duration::from_millis(500));
            }
        });
    }

    // 4. Startup GitHub Update Check (+3.5s)
    if auto_check_updates {
        let p = proxy.clone();
        spawn_lean("dw-updater", 256, move || {
            thread::sleep(Duration::from_millis(3500));
            let res = updater::check_for_github_update(&repo_owner, &repo_name, APP_VERSION);
            if res
                .get("updateAvailable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let _ = p.send_event(UserEvent::StartupUpdateAvailable(res));
            }
        });
    }

    let mut state = AppState {
        config,
        user_data,
        drop_zone,
        antigravity,
        media,
        calls,
        notifications,
        clipboard_history,
        last_clip_text,
        battery,
        game_mode_enabled,
        is_fullscreen,
        game_mode_ipc_hidden,
        ignore_mouse,
        overlay_hwnd,
        overlay_scale,
        stop_all,
        last_media_sig: Mutex::new(String::new()),
        last_media_vol_sig: Mutex::new(String::new()),
        media_vol_tick: AtomicU64::new(0),
        hooks: Some(hooks_handle),
        tray,
        tray_game_mode_item: Some(item_game_mode),
    };

    let island_win_id: WindowId = island_window.id();
    let mut settings_pair: Option<(Window, WebView)> = None;

    event_loop.run(move |event, elwt, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if window_id == island_win_id {
                    // Prevent accidental Alt+F4 / Ctrl+W closing overlay
                } else if settings_pair
                    .as_ref()
                    .map(|(w, _)| w.id() == window_id)
                    .unwrap_or(false)
                {
                    settings_pair = None;
                    let _ = island_webview.set_memory_usage_level(MemoryUsageLevel::Low);
                    spawn_lean("dw-trim", 128, || {
                        thread::sleep(Duration::from_millis(800));
                        sys_win::trim_process_tree_memory();
                    });
                }
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::ScaleFactorChanged { scale_factor, .. },
                ..
            } => {
                if window_id == island_win_id {
                    *state.overlay_scale.lock().unwrap() = scale_factor;
                }
            }
            Event::UserEvent(ue) => match ue {
                UserEvent::IpcFromIsland(raw) => {
                    handle_ipc_message(&raw, WindowTarget::Island, &mut state, &proxy);
                }
                UserEvent::IpcFromSettings(raw) => {
                    handle_ipc_message(&raw, WindowTarget::Settings, &mut state, &proxy);
                }
                UserEvent::DispatchJs {
                    target,
                    channel,
                    payload,
                } => {
                    if target == WindowTarget::Island || target == WindowTarget::All {
                        dispatch_to_webview(&island_webview, &channel, &payload);
                    }
                    if target == WindowTarget::Settings || target == WindowTarget::All {
                        if let Some((_, ref swv)) = settings_pair {
                            dispatch_to_webview(swv, &channel, &payload);
                        }
                    }
                }
                UserEvent::ResolveInvoke {
                    target,
                    id,
                    ok,
                    payload,
                } => match target {
                    WindowTarget::Island => resolve_in_webview(&island_webview, id, ok, &payload),
                    WindowTarget::Settings => {
                        if let Some((_, ref swv)) = settings_pair {
                            resolve_in_webview(swv, id, ok, &payload);
                        }
                    }
                    WindowTarget::All => {
                        resolve_in_webview(&island_webview, id, ok, &payload);
                    }
                },
                UserEvent::EvalIsland(script) => {
                    let _ = island_webview.evaluate_script(&script);
                }
                UserEvent::SetIgnoreCursor(ignore) => {
                    let _ = island_window.set_ignore_cursor_events(ignore);
                }
                UserEvent::SetOverlayVisible(visible) => {
                    island_window.set_visible(visible);
                    if visible {
                        island_window.set_always_on_top(true);
                    }
                }
                UserEvent::SetOnboardingFullscreen(full) => {
                    if full {
                        if let Some(mon) = island_window.primary_monitor().or_else(|| island_window.current_monitor()) {
                            let sz = mon.size();
                            let pos = mon.position();
                            island_window.set_outer_position(pos);
                            island_window.set_inner_size(sz);
                        }
                        state.ignore_mouse.store(false, Ordering::SeqCst);
                        let _ = island_window.set_ignore_cursor_events(false);
                        island_window.set_visible(true);
                        island_window.set_always_on_top(true);
                        island_window.set_focus();
                    } else {
                        if let Some(mon) = island_window.primary_monitor().or_else(|| island_window.current_monitor()) {
                            let sz = mon.size();
                            let pos = mon.position();
                            let scale = mon.scale_factor();
                            let phys_w = (ISLAND_W * scale).round() as i32;
                            let cx = pos.x + (sz.width as i32 - phys_w) / 2;
                            island_window.set_inner_size(LogicalSize::new(ISLAND_W, ISLAND_H));
                            island_window.set_outer_position(PhysicalPosition::new(cx, pos.y));
                        }
                    }
                }
                UserEvent::TriggerOnboarding => {
                    if let Some((ref sw, _)) = settings_pair {
                        sw.set_visible(false);
                    }
                    dispatch_to_webview(&island_webview, "start-onboarding", &json!({ "replay": true }));
                }
                UserEvent::Hook(evt) => match evt {
                    HookEvent::McpNotify(data) => {
                        let ag_state = {
                            let mut ag = state.antigravity.lock().unwrap();
                            ag.update_from_mcp(&data);
                            ag.get_state()
                        };
                        dispatch_to_webview(&island_webview, "antigravity-state", &ag_state);
                    }
                    HookEvent::McpShelfFile(data) => {
                        if let Some(p) = data.get("path").and_then(|v| v.as_str()) {
                            state.drop_zone.add_file(p);
                            let files = state.enriched_dropzone_files();
                            dispatch_to_webview(&island_webview, "dropzone-files", &files);
                        }
                    }
                    HookEvent::McpSetMode(data) => {
                        if let Some(m) = data.get("mode").and_then(|v| v.as_str()) {
                            if m == "island" || m == "notch" {
                                let speed = {
                                    let mut cfg = state.config.lock().unwrap();
                                    cfg.set_key("displayMode", json!(m));
                                    cfg.get_f64("animationSpeed", 1.0)
                                };
                                dispatch_to_webview(&island_webview, "display-mode", &json!(m));
                                dispatch_to_webview(
                                    &island_webview,
                                    "animation-speed",
                                    &json!(speed),
                                );
                            }
                        }
                    }
                    HookEvent::PermissionRequested(prompt) => {
                        dispatch_to_webview(&island_webview, "permission-prompt", &prompt);
                    }
                },
                UserEvent::FullscreenChanged(is_full) => {
                    state.is_fullscreen.store(is_full, Ordering::SeqCst);
                    apply_game_mode_visibility(&state, &proxy);
                    let payload = json!({
                        "fullscreen": is_full,
                        "enabled": state.game_mode_enabled.load(Ordering::SeqCst)
                    });
                    dispatch_to_webview(&island_webview, "game-mode-changed", &payload);
                    if let Some((_, ref swv)) = settings_pair {
                        dispatch_to_webview(swv, "game-mode-changed", &payload);
                    }
                }
                UserEvent::MediaChanged => {
                    send_media_state(&state, &proxy, true);
                }
                UserEvent::MediaTick => {
                    send_media_state(&state, &proxy, false);
                }
                UserEvent::AntigravityChanged => {
                    let st = state.antigravity.lock().unwrap().get_state();
                    dispatch_to_webview(&island_webview, "antigravity-state", &st);
                }
                UserEvent::CallChanged => {
                    let st = state.calls.lock().unwrap().get_state();
                    dispatch_to_webview(&island_webview, "call-state", &st);
                }
                UserEvent::NotificationsPollResult(alerts, updated) => {
                    for notif in alerts {
                        dispatch_to_webview(&island_webview, "notification-received", &notif);
                    }
                    if updated {
                        let list = state.notifications.lock().unwrap().get_notifications();
                        dispatch_to_webview(&island_webview, "notifications-updated", &list);
                    }
                }
                UserEvent::BatteryChanged(batt) => {
                    let payload = batt.to_json();
                    dispatch_to_webview(&island_webview, "battery-status-changed", &payload);
                    if let Some((_, ref swv)) = settings_pair {
                        dispatch_to_webview(swv, "battery-status-changed", &payload);
                    }
                }
                UserEvent::ClipboardChanged(list) => {
                    dispatch_to_webview(&island_webview, "clipboard-update", &list);
                }
                UserEvent::DragOver(lx, ly) => {
                    let _ = island_webview.evaluate_script(&format!(
                        "window.__dwDragOver && window.__dwDragOver({:.1}, {:.1});",
                        lx, ly
                    ));
                }
                UserEvent::DragLeave => {
                    let _ = island_webview.evaluate_script(
                        "window.__dwDragLeave && window.__dwDragLeave();",
                    );
                }
                UserEvent::DropFiles(paths, is_one_time) => {
                    for fp in paths {
                        if let Some(dest) = state.drop_zone.add_file(&fp) {
                            state
                                .user_data
                                .lock()
                                .unwrap()
                                .set_file_shelf_metadata(&dest.to_string_lossy(), is_one_time);
                        }
                    }
                    let _ = island_webview.evaluate_script(
                        "window.__dwDropDone && window.__dwDropDone();",
                    );
                    let files = state.enriched_dropzone_files();
                    dispatch_to_webview(&island_webview, "dropzone-files", &files);
                }
                UserEvent::ShelfAutoClear(fp) => {
                    let md = {
                        let mut ud = state.user_data.lock().unwrap();
                        ud.remove_file_shelf_metadata(&fp);
                        ud.get_shelf_metadata()
                    };
                    let base = Path::new(&fp)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or(fp);
                    state.drop_zone.delete_file(&base);
                    dispatch_to_webview(&island_webview, "shelf-metadata-updated", &md);
                    let files = state.enriched_dropzone_files();
                    dispatch_to_webview(&island_webview, "dropzone-files", &files);
                }
                UserEvent::TrayMenu(id) => match id.as_str() {
                    "tray_game_mode" => {
                        let cur = state.game_mode_enabled.load(Ordering::SeqCst);
                        set_game_mode(&state, &proxy, !cur, "tray");
                    }
                    "tray_dropzone" => {
                        state.drop_zone.reveal_in_explorer(None);
                    }
                    "tray_settings" => {
                        let _ = proxy.send_event(UserEvent::OpenSettings);
                    }
                    "tray_antigravity" => {
                        thread::spawn(|| {
                            sys_win::focus_process("Antigravity");
                        });
                    }
                    "tray_exit" => {
                        let _ = proxy.send_event(UserEvent::ExitApp);
                    }
                    _ => {}
                },
                UserEvent::Hotkey(id) => {
                    if id == hk_gamemode_id {
                        let cur = state.game_mode_enabled.load(Ordering::SeqCst);
                        set_game_mode(&state, &proxy, !cur, "shortcut");
                    } else if id == hk_untuck_id {
                        island_window.set_visible(true);
                        island_window.set_always_on_top(true);
                        dispatch_to_webview(&island_webview, "untuck-island", &Value::Null);
                    } else if id == hk_tuck_id {
                        dispatch_to_webview(&island_webview, "toggle-tuck", &Value::Null);
                    }
                }
                UserEvent::StartupUpdateAvailable(info) => {
                    dispatch_to_webview(&island_webview, "app-update-available", &info);
                }
                UserEvent::OpenSettings => {
                    if let Some((ref w, _)) = settings_pair {
                        w.set_minimized(false);
                        w.set_focus();
                    } else {
                        let gm = state.game_mode_enabled.load(Ordering::SeqCst);
                        let is_js = format!(
                            "window.__DW_INIT_STATE__ = {{ gameMode: {{ enabled: {}, isFullscreen: false }} }};",
                            if gm { "true" } else { "false" }
                        );
                        settings_pair =
                            build_settings_window(elwt, &mut web_ctx, proxy.clone(), &is_js);
                    }
                }
                UserEvent::ExitApp => {
                    state.stop_all.store(true, Ordering::SeqCst);
                    if let Some(ref h) = state.hooks {
                        h.stop();
                    }
                    state.notifications.lock().unwrap().shutdown();
                    sys_win::restore_work_area();
                    state.tray = None;
                    settings_pair = None;
                    *control_flow = ControlFlow::Exit;
                }
            },
            _ => {}
        }
    });
}
