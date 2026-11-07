use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpNotifyRequest {
    pub status: Option<String>,
    pub phase: Option<String>,
    pub tool: Option<String>,
    pub command: Option<String>,
    pub progress: Option<f32>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpState {
    pub status: String,
    pub phase: String,
    pub tool: Option<String>,
    pub progress: Option<f32>,
    pub updated_at: u64,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            phase: "Ready".into(),
            tool: None,
            progress: None,
            updated_at: 0,
        }
    }
}

pub struct AgentHooksServer {
    state: Arc<Mutex<McpState>>,
}

impl AgentHooksServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(McpState::default())),
        }
    }

    pub fn get_state(&self) -> McpState {
        self.state.lock().unwrap().clone()
    }

    pub fn start<F>(&self, port: u16, on_notify: F)
    where
        F: Fn(McpNotifyRequest) + Send + Sync + 'static,
    {
        let state_clone = Arc::clone(&self.state);
        let on_notify = Arc::new(on_notify);

        thread::spawn(move || {
            let addr = format!("127.0.0.1:{}", port);
            if let Ok(listener) = TcpListener::bind(&addr) {
                for stream in listener.incoming() {
                    if let Ok(mut stream) = stream {
                        let state = Arc::clone(&state_clone);
                        let cb = Arc::clone(&on_notify);
                        thread::spawn(move || {
                            handle_client(&mut stream, state, cb);
                        });
                    }
                }
            }
        });
    }
}

fn handle_client<F>(stream: &mut TcpStream, state: Arc<Mutex<McpState>>, on_notify: Arc<F>)
where
    F: Fn(McpNotifyRequest),
{
    let mut buffer = [0u8; 8192];
    if let Ok(bytes_read) = stream.read(&mut buffer) {
        let req = String::from_utf8_lossy(&buffer[..bytes_read]);
        let mut lines = req.lines();
        let first_line = lines.next().unwrap_or("");
        let parts: Vec<&str> = first_line.split_whitespace().collect();

        if parts.len() >= 2 {
            let method = parts[0];
            let path = parts[1];

            // Extract body if present
            let body = if let Some(pos) = req.find("\r\n\r\n") {
                &req[pos + 4..]
            } else if let Some(pos) = req.find("\n\n") {
                &req[pos + 2..]
            } else {
                ""
            };

            match (method, path) {
                ("POST", "/mcp/notify") => {
                    if let Ok(data) = serde_json::from_str::<McpNotifyRequest>(body) {
                        let mut st = state.lock().unwrap();
                        if let Some(ref s) = data.status { st.status = s.clone(); }
                        if let Some(ref p) = data.phase { st.phase = p.clone(); }
                        if let Some(ref t) = data.tool { st.tool = Some(t.clone()); }
                        if data.progress.is_some() { st.progress = data.progress; }
                        st.updated_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        drop(st);

                        on_notify(data);
                        send_json_response(stream, 200, serde_json::json!({ "ok": true }));
                        return;
                    }
                    send_json_response(stream, 400, serde_json::json!({ "error": "Invalid JSON" }));
                }
                ("GET", "/mcp/state") => {
                    let st = state.lock().unwrap().clone();
                    send_json_response(stream, 200, serde_json::to_value(st).unwrap_or_default());
                }
                _ => {
                    send_json_response(stream, 404, serde_json::json!({ "error": "Not Found" }));
                }
            }
        }
    }
}

fn send_json_response(stream: &mut TcpStream, status_code: u16, data: serde_json::Value) {
    let body = data.to_string();
    let resp = format!(
        "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code,
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
}
