//! Universal & Discord Call Monitor — uses native in-process CoreAudio + EnumWindows + Discord Local IPC

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
struct DetectedApp {
    app_id: String,
    app_name: String,
    process_name: String,
}

fn classify_mic_app(raw: &str) -> Option<DetectedApp> {
    let s = raw.to_lowercase();
    if s.is_empty()
        || s.contains("speechruntime")
        || s.contains("cortana")
        || s.contains("searchhost")
    {
        return None;
    }
    if s.contains("discord") {
        return Some(DetectedApp {
            app_id: "discord".into(),
            app_name: "Discord".into(),
            process_name: "Discord".into(),
        });
    }
    if s.contains("whatsapp") {
        return Some(DetectedApp {
            app_id: "whatsapp".into(),
            app_name: "WhatsApp".into(),
            process_name: "WhatsApp".into(),
        });
    }
    if s.contains("zoom") {
        return Some(DetectedApp {
            app_id: "zoom".into(),
            app_name: "Zoom".into(),
            process_name: "Zoom".into(),
        });
    }
    if s.contains("teams") {
        return Some(DetectedApp {
            app_id: "teams".into(),
            app_name: "Teams".into(),
            process_name: "ms-teams".into(),
        });
    }
    if s.contains("telegram") {
        return Some(DetectedApp {
            app_id: "telegram".into(),
            app_name: "Telegram".into(),
            process_name: "Telegram".into(),
        });
    }
    if s.contains("skype") {
        return Some(DetectedApp {
            app_id: "generic".into(),
            app_name: "Skype".into(),
            process_name: "Skype".into(),
        });
    }
    Some(DetectedApp {
        app_id: "generic".into(),
        app_name: raw.to_string(),
        process_name: raw.to_string(),
    })
}

struct ParsedMeta {
    call_type: String,
    channel_name: String,
    is_incoming: bool,
    group_members: Vec<String>,
}

fn parse_call_metadata(app_id: &str, raw_title: &str) -> ParsedMeta {
    let title = raw_title.trim();
    if title.is_empty() {
        return ParsedMeta {
            call_type: "dm".into(),
            channel_name: if app_id == "discord" {
                "Voice Connected".into()
            } else {
                "Active Call".into()
            },
            is_incoming: false,
            group_members: Vec::new(),
        };
    }
    let tl = title.to_lowercase();
    let is_incoming = tl.contains("incoming call") || tl.contains("calling") || tl.contains("ringing");

    if app_id == "discord" {
        let mut stripped = title.to_string();
        for suffix in [" - Discord", " - DiscordPTB", " - DiscordCanary"] {
            if let Some(s) = stripped.strip_suffix(suffix) {
                stripped = s.trim().to_string();
            }
        }
        if stripped.starts_with('(') {
            if let Some(end) = stripped.find(')') {
                stripped = stripped[end + 1..].trim().to_string();
            }
        }
        if let Some(dm) = stripped.strip_prefix('@') {
            return ParsedMeta {
                call_type: "dm".into(),
                channel_name: if dm.trim().is_empty() {
                    "Direct Call".into()
                } else {
                    dm.trim().into()
                },
                is_incoming,
                group_members: Vec::new(),
            };
        }
        if let Some((chan, srv)) = stripped.split_once('|') {
            let cname = chan.trim().trim_start_matches('#').trim();
            return ParsedMeta {
                call_type: "group".into(),
                channel_name: if !cname.is_empty() {
                    cname.into()
                } else if !srv.trim().is_empty() {
                    srv.trim().into()
                } else {
                    "Voice Channel".into()
                },
                is_incoming,
                group_members: Vec::new(),
            };
        }
        if stripped.contains(',') {
            let members: Vec<String> = stripped
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            return ParsedMeta {
                call_type: "group".into(),
                channel_name: members.join(", "),
                is_incoming,
                group_members: members,
            };
        }
        let sl = stripped.to_lowercase();
        if !stripped.is_empty() && sl != "discord" && sl != "friends" {
            return ParsedMeta {
                call_type: "dm".into(),
                channel_name: stripped.trim_start_matches('#').trim().into(),
                is_incoming,
                group_members: Vec::new(),
            };
        }
        return ParsedMeta {
            call_type: "group".into(),
            channel_name: "Voice Channel".into(),
            is_incoming,
            group_members: Vec::new(),
        };
    }

    if app_id == "whatsapp" {
        let stripped = title.strip_suffix(" - WhatsApp").unwrap_or(title).trim();
        let cname = if !stripped.is_empty() && !stripped.eq_ignore_ascii_case("whatsapp") {
            stripped.to_string()
        } else {
            "WhatsApp Call".to_string()
        };
        return ParsedMeta {
            call_type: "dm".into(),
            channel_name: cname,
            is_incoming,
            group_members: Vec::new(),
        };
    }

    ParsedMeta {
        call_type: "dm".into(),
        channel_name: title.chars().take(32).collect(),
        is_incoming,
        group_members: Vec::new(),
    }
}

pub struct CallMonitor {
    state: Value,
    pre_deafen_mic_mute: bool,
    dismissed_until: u64,
    pub paused: bool,
}

impl CallMonitor {
    pub fn new() -> Self {
        Self {
            state: Self::idle_state(),
            pre_deafen_mic_mute: false,
            dismissed_until: 0,
            paused: false,
        }
    }

    fn idle_state() -> Value {
        json!({
            "inCall": false,
            "status": "idle",
            "appId": "none",
            "appName": "",
            "processName": "",
            "callType": "dm",
            "channelName": "",
            "participantCount": 0,
            "startedAt": 0,
            "selfMuted": false,
            "selfDeafened": false,
            "selfSpeaking": false,
            "participants": []
        })
    }

    pub fn is_in_call(&self) -> bool {
        self.state
            .get("inCall")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    pub fn get_state(&self) -> Value {
        self.state.clone()
    }

    /// Returns true if call state changed.
    pub fn poll(&mut self) -> bool {
        if self.paused || now_ms() < self.dismissed_until {
            return false;
        }
        let audio = crate::sys_win::get_call_audio();
        let mut detected: Option<DetectedApp> = None;
        let mut is_incoming = false;
        let mut matched_title = String::new();

        for (proc_key, title) in &audio.window_titles {
            let tl = title.to_lowercase();
            if tl.contains("incoming call")
                || tl.contains("calling")
                || tl.contains("ringing")
                || tl.contains("whatsapp call")
            {
                detected = classify_mic_app(proc_key);
                is_incoming = true;
                matched_title = title.clone();
                break;
            }
        }

        if detected.is_none() {
            for (proc_key, title) in &audio.window_titles {
                let tl = title.to_lowercase();
                let pl = proc_key.to_lowercase();
                if pl.contains("discord")
                    && (title.starts_with('#')
                        || title.starts_with('@')
                        || tl.contains("voice connected"))
                {
                    detected = classify_mic_app(proc_key);
                    matched_title = title.clone();
                    break;
                } else if pl.contains("whatsapp") && tl.contains("call") {
                    detected = classify_mic_app(proc_key);
                    matched_title = title.clone();
                    break;
                } else if (pl.contains("zoom") || pl.contains("teams") || pl.contains("skype"))
                    && (tl.contains("meeting") || tl.contains("call"))
                {
                    detected = classify_mic_app(proc_key);
                    matched_title = title.clone();
                    break;
                }
            }
        }

        let Some(app) = detected else {
            if self.is_in_call() {
                self.state = Self::idle_state();
                return true;
            }
            return false;
        };

        let self_deafened = audio.out_muted;
        let self_muted = self_deafened || audio.mic_muted;
        let self_speaking = !self_muted && audio.mic_peak > 0.022;
        let remote_speaking = !self_deafened && audio.out_peak > 0.028;

        let win_title = if !matched_title.is_empty() {
            matched_title
        } else {
            audio
                .window_titles
                .get(&app.process_name)
                .or_else(|| audio.window_titles.get("Discord"))
                .or_else(|| audio.window_titles.get("WhatsApp"))
                .cloned()
                .unwrap_or_default()
        };

        let meta = parse_call_metadata(&app.app_id, &win_title);
        let status = if is_incoming || meta.is_incoming {
            "ringing"
        } else {
            "connected"
        };

        let mut call_type = meta.call_type;
        let channel_name = meta.channel_name;
        let participant_count: usize;
        let participants: Vec<Value>;

        if meta.group_members.len() > 1 {
            call_type = "group".into();
            participant_count = meta.group_members.len() + 1;
            let colors = ["#ec4899", "#10b981", "#f59e0b"];
            let mut list = vec![json!({
                "id": "self", "name": "You", "avatarUrl": "", "color": "#5865F2",
                "isSpeaking": self_speaking, "isMuted": self_muted, "isDeafened": self_deafened, "isSelf": true
            })];
            for (idx, m) in meta.group_members.iter().take(3).enumerate() {
                list.push(json!({
                    "id": format!("peer_{}", idx), "name": m, "avatarUrl": "", "color": colors[idx % 3],
                    "isSpeaking": idx == 0 && remote_speaking, "isMuted": false, "isDeafened": false, "isSelf": false
                }));
            }
            participants = list;
        } else if call_type == "group" {
            participant_count = 3;
            participants = vec![
                json!({
                    "id": "self", "name": "You", "avatarUrl": "", "color": "#5865F2",
                    "isSpeaking": self_speaking, "isMuted": self_muted, "isDeafened": self_deafened, "isSelf": true
                }),
                json!({
                    "id": "peer_1", "name": if channel_name.is_empty() { "Channel" } else { &channel_name },
                    "avatarUrl": "", "color": "#10b981",
                    "isSpeaking": remote_speaking, "isMuted": false, "isDeafened": false, "isSelf": false
                }),
            ];
        } else {
            call_type = "dm".into();
            participant_count = 2;
            let partner = if !channel_name.is_empty()
                && !matches!(
                    channel_name.as_str(),
                    "Voice Connected" | "Active Call" | "Direct Call" | "WhatsApp Call"
                ) {
                channel_name.clone()
            } else if app.app_name == "WhatsApp" {
                "Contact".to_string()
            } else {
                "Friend".to_string()
            };
            let peer_color = if app.app_id == "whatsapp" {
                "#25D366"
            } else {
                "#ec4899"
            };
            participants = vec![
                json!({
                    "id": "peer_dm", "name": partner, "avatarUrl": "", "color": peer_color,
                    "isSpeaking": remote_speaking, "isMuted": false, "isDeafened": false, "isSelf": false
                }),
                json!({
                    "id": "self", "name": "You", "avatarUrl": "", "color": "#5865F2",
                    "isSpeaking": self_speaking, "isMuted": self_muted, "isDeafened": self_deafened, "isSelf": true
                }),
            ];
        }

        let prev_started = self
            .state
            .get("startedAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let started_at = if self.is_in_call() && prev_started > 0 {
            prev_started
        } else {
            now_ms()
        };

        let next = json!({
            "inCall": true,
            "status": status,
            "appId": app.app_id,
            "appName": app.app_name,
            "processName": app.process_name,
            "callType": call_type,
            "channelName": channel_name,
            "participantCount": participant_count,
            "startedAt": started_at,
            "selfMuted": self_muted,
            "selfDeafened": self_deafened,
            "selfSpeaking": self_speaking,
            "participants": participants
        });

        let changed = next != self.state;
        self.state = next;
        changed
    }

    pub fn handle_action(&mut self, action: &str) {
        let proc_name = self
            .state
            .get("processName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Discord")
            .to_string();

        match action {
            "toggle-mute" => {
                let res = crate::sys_win::toggle_mic_mute();
                let new_mute = res
                    .get("micMuted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if let Some(obj) = self.state.as_object_mut() {
                    obj.insert("selfMuted".into(), Value::Bool(new_mute));
                }
                self.poll();
            }
            "toggle-deafen" => {
                let cur_deaf = self
                    .state
                    .get("selfDeafened")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let cur_mute = self
                    .state
                    .get("selfMuted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let target = !cur_deaf;
                crate::sys_win::toggle_system_mute();
                if target {
                    self.pre_deafen_mic_mute = cur_mute;
                    crate::sys_win::set_mic_mute(true);
                } else if !self.pre_deafen_mic_mute {
                    crate::sys_win::set_mic_mute(false);
                }
                if let Some(obj) = self.state.as_object_mut() {
                    obj.insert("selfDeafened".into(), Value::Bool(target));
                    obj.insert(
                        "selfMuted".into(),
                        Value::Bool(if target { true } else { self.pre_deafen_mic_mute }),
                    );
                }
                self.poll();
            }
            "focus-app" => {
                crate::sys_win::focus_process(&proc_name);
            }
            "answer-call" => {
                if let Some(obj) = self.state.as_object_mut() {
                    obj.insert("status".into(), Value::String("connected".into()));
                }
                crate::sys_win::focus_process(&proc_name);
            }
            "leave-call" | "decline-call" => {
                crate::sys_win::focus_process(&proc_name);
                let delay = if action == "decline-call" {
                    45_000
                } else {
                    3_500
                };
                self.dismissed_until = now_ms() + delay;
                self.state = Self::idle_state();
            }
            _ => {}
        }
    }
}
