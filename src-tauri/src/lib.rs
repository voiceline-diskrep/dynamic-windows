use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
fn ipc_send(_app: AppHandle, window: WebviewWindow, channel: String, payload: serde_json::Value) {
    if channel == "set-ignore-mouse-events" {
        // payload is an array of args: [ignore: bool, options: { forward: bool }]
        if let Some(args) = payload.as_array() {
            if let Some(ignore) = args.get(0).and_then(|v| v.as_bool()) {
                let _ = window.set_ignore_cursor_events(ignore);
            }
        } else if let Some(ignore) = payload.as_bool() {
            let _ = window.set_ignore_cursor_events(ignore);
        }
    }
}

#[tauri::command]
fn ipc_invoke(_app: AppHandle, channel: String, _payload: serde_json::Value) -> Result<serde_json::Value, String> {
    match channel.as_str() {
        "get-app-settings" => {
            Ok(serde_json::json!({
                "config": {
                    "displayMode": "island",
                    "animationSpeed": 1.0,
                    "islandOpacity": 0.95,
                    "gameMode": false,
                    "dynamicLyrics": true
                },
                "version": "1.4.10",
                "dropZonePath": "",
                "dropZoneCount": 0
            }))
        }
        "save-app-settings" => {
            Ok(serde_json::json!({ "ok": true }))
        }
        "calendar-get-notes" => {
            Ok(serde_json::json!([]))
        }
        "todo-get-data" => {
            Ok(serde_json::json!({ "categories": ["Personal", "Work", "Island"], "tasks": [] }))
        }
        "check-github-update" => {
            Ok(serde_json::json!({
                "updateAvailable": false,
                "currentVersion": "1.4.10"
            }))
        }
        _ => Ok(serde_json::Value::Null)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![ipc_send, ipc_invoke])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Initial click-through transparent setup
                let _ = window.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
