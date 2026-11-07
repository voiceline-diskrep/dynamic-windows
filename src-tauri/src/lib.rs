mod config;
mod user_data;
mod agent_hooks;

use config::AppConfig;
use user_data::UserDataManager;
use agent_hooks::AgentHooksServer;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

struct AppState {
    config: Arc<Mutex<AppConfig>>,
    user_data: Arc<UserDataManager>,
    hooks: Arc<AgentHooksServer>,
}

#[tauri::command]
fn ipc_send(_app: AppHandle, window: WebviewWindow, channel: String, payload: serde_json::Value) {
    if channel == "set-ignore-mouse-events" {
        if let Some(args) = payload.as_array() {
            if let Some(ignore) = args.get(0).and_then(|v| v.as_bool()) {
                let _ = window.set_ignore_cursor_events(ignore);
            }
        } else if let Some(ignore) = payload.as_bool() {
            let _ = window.set_ignore_cursor_events(ignore);
        }
    } else if channel == "exit-app" {
        std::process::exit(0);
    }
}

#[tauri::command]
fn ipc_invoke(
    state: State<'_, AppState>,
    channel: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match channel.as_str() {
        "get-app-settings" => {
            let cfg = state.config.lock().unwrap().clone();
            Ok(serde_json::json!({
                "config": cfg,
                "version": cfg.version,
                "dropZonePath": "",
                "dropZoneCount": 0
            }))
        }
        "save-app-settings" => {
            let mut cfg = state.config.lock().unwrap();
            if let Some(speed) = payload.get("animationSpeed").and_then(|v| v.as_f64()) {
                cfg.animation_speed = speed as f32;
            }
            if let Some(opacity) = payload.get("islandOpacity").and_then(|v| v.as_f64()) {
                cfg.island_opacity = opacity as f32;
            }
            if let Some(mode) = payload.get("displayMode").and_then(|v| v.as_str()) {
                cfg.display_mode = mode.to_string();
            }
            if let Some(gm) = payload.get("gameMode").and_then(|v| v.as_bool()) {
                cfg.game_mode = gm;
            }
            if let Some(dl) = payload.get("dynamicLyrics").and_then(|v| v.as_bool()) {
                cfg.dynamic_lyrics = dl;
            }
            let _ = cfg.save();
            Ok(serde_json::json!({ "ok": true }))
        }
        "calendar-get-notes" => {
            let notes = state.user_data.get_calendar_notes();
            Ok(serde_json::to_value(notes).unwrap_or_default())
        }
        "calendar-add-note" => {
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let date = payload.get("date").and_then(|v| v.as_str()).unwrap_or("");
            let repeat = payload.get("repeat").and_then(|v| v.as_str()).unwrap_or("none");
            let is_birthday = payload.get("isBirthday").and_then(|v| v.as_bool()).unwrap_or(false);
            let note = state.user_data.add_calendar_note(text, date, repeat, is_birthday);
            Ok(serde_json::to_value(note).unwrap_or_default())
        }
        "calendar-delete-note" => {
            let id = payload.get("id").or_else(|| payload.as_str().map(|_| &payload)).and_then(|v| v.as_str()).unwrap_or("");
            let deleted = state.user_data.delete_calendar_note(id);
            Ok(serde_json::json!({ "success": deleted }))
        }
        "todo-get-data" => {
            let todos = state.user_data.get_todos();
            Ok(serde_json::to_value(todos).unwrap_or_default())
        }
        "todo-add-task" => {
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let cat = payload.get("category").and_then(|v| v.as_str());
            let task = state.user_data.add_todo_task(text, cat);
            Ok(serde_json::to_value(task).unwrap_or_default())
        }
        "todo-toggle-task" => {
            let id = payload.get("id").or_else(|| payload.as_str().map(|_| &payload)).and_then(|v| v.as_str()).unwrap_or("");
            let toggled = state.user_data.toggle_todo_task(id);
            Ok(serde_json::to_value(toggled).unwrap_or(serde_json::Value::Null))
        }
        "todo-delete-task" => {
            let id = payload.get("id").or_else(|| payload.as_str().map(|_| &payload)).and_then(|v| v.as_str()).unwrap_or("");
            let deleted = state.user_data.delete_todo_task(id);
            Ok(serde_json::json!({ "success": deleted }))
        }
        "check-github-update" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::json!({
                "updateAvailable": false,
                "currentVersion": cfg.version,
                "latestVersion": cfg.version
            }))
        }
        _ => Ok(serde_json::Value::Null)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = AppConfig::load();
    let hooks_port = cfg.hooks_port;
    let config = Arc::new(Mutex::new(cfg));
    let user_data = Arc::new(UserDataManager::new());
    let hooks = Arc::new(AgentHooksServer::new());

    let state = AppState {
        config,
        user_data,
        hooks: Arc::clone(&hooks),
    };

    tauri::Builder::default()
        .manage(state)
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![ipc_send, ipc_invoke])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Start native MCP / Agent Hooks HTTP Server
            hooks.start(hooks_port, move |req| {
                // Forward Agent / MCP status directly into the webview!
                let _ = handle.emit("agent-status-update", serde_json::json!({
                    "status": req.status.unwrap_or_else(|| "idle".into()),
                    "phase": req.phase.unwrap_or_else(|| "Ready".into()),
                    "tool": req.tool,
                    "command": req.command,
                    "progress": req.progress,
                    "conversationId": req.conversation_id.unwrap_or_default(),
                    "updatedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
                }));
            });

            if let Some(window) = app.get_webview_window("main") {
                // Initial click-through transparent setup
                let _ = window.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
