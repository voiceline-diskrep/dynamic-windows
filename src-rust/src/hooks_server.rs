//! Agent Hooks & MCP HTTP Server — listens on 127.0.0.1:47823

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Response, Server};

#[derive(Clone, Debug)]
pub enum HookEvent {
    McpNotify(Value),
    McpShelfFile(Value),
    McpSetMode(Value),
    PermissionRequested(Value),
}

pub struct AgentHooksHandle {
    pending_permissions: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
    stop_flag: Arc<AtomicBool>,
}

impl AgentHooksHandle {
    pub fn respond_permission(&self, id: &str, allow: bool) -> bool {
        if let Ok(mut map) = self.pending_permissions.lock() {
            if let Some(tx) = map.remove(id) {
                let _ = tx.send(allow);
                return true;
            }
        }
        false
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

pub fn start_hooks_server<F, S>(
    port: u16,
    on_event: F,
    state_getter: S,
) -> AgentHooksHandle
where
    F: Fn(HookEvent) + Send + Sync + 'static,
    S: Fn() -> Value + Send + Sync + 'static,
{
    let pending_permissions: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let serial = Arc::new(AtomicU64::new(0));

    let pending_clone = pending_permissions.clone();
    let stop_clone = stop_flag.clone();
    let on_event = Arc::new(on_event);
    let state_getter = Arc::new(state_getter);

    thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", port);
        let mut server_opt = None;
        for _ in 0..6 {
            if stop_clone.load(Ordering::SeqCst) {
                return;
            }
            match Server::http(&addr) {
                Ok(s) => {
                    crate::config::append_log(
                        "server.log",
                        &format!("[AgentHooksServer] Listening on {}", addr),
                    );
                    server_opt = Some(s);
                    break;
                }
                Err(e) => {
                    crate::config::append_log(
                        "server.log",
                        &format!("[AgentHooksServer] Bind retry error on {}: {}", addr, e),
                    );
                    thread::sleep(Duration::from_secs(1));
                }
            }
        }
        let Some(server) = server_opt else { return };

        while !stop_clone.load(Ordering::SeqCst) {
            let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(250)) else {
                continue;
            };
            let url = req.url().split('?').next().unwrap_or("/").to_string();
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let data: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));

            let json_hdr = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();

            match url.as_str() {
                "/mcp/notify" => {
                    on_event(HookEvent::McpNotify(data));
                    let resp = Response::from_string(r#"{"success":true}"#).with_header(json_hdr);
                    let _ = req.respond(resp);
                }
                "/mcp/shelf-file" => {
                    on_event(HookEvent::McpShelfFile(data));
                    let resp = Response::from_string(r#"{"success":true}"#).with_header(json_hdr);
                    let _ = req.respond(resp);
                }
                "/mcp/set-mode" => {
                    on_event(HookEvent::McpSetMode(data));
                    let resp = Response::from_string(r#"{"success":true}"#).with_header(json_hdr);
                    let _ = req.respond(resp);
                }
                "/mcp/state" => {
                    let st = state_getter();
                    let resp = Response::from_string(st.to_string()).with_header(json_hdr);
                    let _ = req.respond(resp);
                }
                "/twocode-status" => {
                    let resp = Response::from_string(r#"{"ok":true}"#).with_header(json_hdr);
                    let _ = req.respond(resp);
                }
                "/twocode-hook" => {
                    let evt_type = data
                        .get("event")
                        .or_else(|| data.get("type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if evt_type == "PermissionRequest" {
                        let perm_id = format!("perm_{}", serial.fetch_add(1, Ordering::SeqCst) + 1);
                        let (tx, rx) = mpsc::channel::<bool>();
                        if let Ok(mut map) = pending_clone.lock() {
                            map.insert(perm_id.clone(), tx);
                        }
                        let prompt = json!({
                            "id": perm_id,
                            "agent": data.get("agent").and_then(|v| v.as_str()).unwrap_or("claude"),
                            "command": data.get("command").and_then(|v| v.as_str()).unwrap_or(""),
                            "file": data.get("file").and_then(|v| v.as_str()).unwrap_or(""),
                            "message": data.get("message").and_then(|v| v.as_str()).unwrap_or("Permission requested to proceed")
                        });
                        on_event(HookEvent::PermissionRequested(prompt));
                        let pending_for_thread = pending_clone.clone();
                        let pid_for_thread = perm_id.clone();
                        thread::spawn(move || {
                            let reply = match rx.recv_timeout(Duration::from_secs(300)) {
                                Ok(true) => r#"{"decision":"allow"}"#,
                                Ok(false) => r#"{"decision":"deny"}"#,
                                Err(_) => {
                                    if let Ok(mut m) = pending_for_thread.lock() {
                                        m.remove(&pid_for_thread);
                                    }
                                    r#"{"decision":"deny","reason":"Timeout"}"#
                                }
                            };
                            let resp = Response::from_string(reply).with_header(json_hdr);
                            let _ = req.respond(resp);
                        });
                    } else {
                        let resp = Response::from_string(r#"{"ok":true}"#).with_header(json_hdr);
                        let _ = req.respond(resp);
                    }
                }
                _ => {
                    let resp = Response::from_string("").with_status_code(404);
                    let _ = req.respond(resp);
                }
            }
        }
    });

    AgentHooksHandle {
        pending_permissions,
        stop_flag,
    }
}
