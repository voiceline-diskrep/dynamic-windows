//! Native Windows Toast Notification Monitor via WinRT UserNotificationListener
//! Zero PowerShell spawning, native UTF-16 -> UTF-8 strings, BiDi & '?' artifact sanitization.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::UI::Notifications::Management::UserNotificationListener;
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn sanitize_notification_text(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    static RE_WRAP: OnceLock<Regex> = OnceLock::new();
    static RE_TILDE_Q: OnceLock<Regex> = OnceLock::new();
    static RE_Q_COLON: OnceLock<Regex> = OnceLock::new();
    static RE_MEDIA_Q: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();

    let stripped: String = input
        .chars()
        .filter(|&c| {
            let u = c as u32;
            let is_ctrl = u < 0x20 || u == 0x7F;
            let is_bidi_or_fmt = (0x200B..=0x200F).contains(&u)
                || (0x202A..=0x202E).contains(&u)
                || (0x2060..=0x206F).contains(&u)
                || u == 0xFEFF
                || u == 0xFFFD;
            !is_ctrl && !is_bidi_or_fmt
        })
        .collect();

    let re_wrap = RE_WRAP.get_or_init(|| {
        Regex::new(r"(^|[\s~—\-|])\?+([^\s?][^?]*?)\?+(\s*:|$)").unwrap()
    });
    let re_tilde_q = RE_TILDE_Q.get_or_init(|| Regex::new(r"~\?+").unwrap());
    let re_q_colon = RE_Q_COLON.get_or_init(|| Regex::new(r"\?+:").unwrap());
    let re_media_q = RE_MEDIA_Q.get_or_init(|| {
        Regex::new(r"(?i)\b(Photo|Video|Audio|Sticker|GIF|Document|Voice message|Location|Contact card|Poll)\?(\s|$)").unwrap()
    });
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").unwrap());

    let s = re_wrap.replace_all(&stripped, "$1$2$3");
    let s = re_tilde_q.replace_all(&s, "~");
    let s = re_q_colon.replace_all(&s, ":");
    let s = re_media_q.replace_all(&s, "$1$2");
    let s = re_ws.replace_all(&s, " ");
    s.trim().to_string()
}

pub fn get_icon_for_app(app_name: &str) -> &'static str {
    let name = app_name.to_lowercase();
    if name.contains("whatsapp") {
        "💬"
    } else if name.contains("discord") {
        "🎮"
    } else if name.contains("antigravity") {
        "🤖"
    } else if name.contains("chrome") || name.contains("edge") || name.contains("browser") {
        "🌐"
    } else if name.contains("snip") || name.contains("screen") {
        "✂️"
    } else if name.contains("powertoys") {
        "🛠️"
    } else if name.contains("spotify") || name.contains("music") {
        "🎵"
    } else if name.contains("mail") || name.contains("outlook") {
        "✉️"
    } else {
        "🔔"
    }
}

pub struct NotificationMonitor {
    pub suppress_windows_toasts: bool,
    pub paused: bool,
    notifications: Vec<Value>,
    known_ids: HashSet<String>,
    initialized: bool,
}

impl NotificationMonitor {
    pub fn new(suppress_windows_toasts: bool) -> Self {
        if suppress_windows_toasts {
            crate::sys_win::set_windows_toast_suppression_registry(true);
        }
        Self {
            suppress_windows_toasts,
            paused: false,
            notifications: Vec::new(),
            known_ids: HashSet::new(),
            initialized: false,
        }
    }

    pub fn set_suppress_windows_toasts(&mut self, enabled: bool) {
        if self.suppress_windows_toasts == enabled {
            return;
        }
        self.suppress_windows_toasts = enabled;
        crate::sys_win::set_windows_toast_suppression_registry(enabled);
    }

    pub fn shutdown(&self) {
        if self.suppress_windows_toasts {
            crate::sys_win::set_windows_toast_suppression_registry(false);
        }
    }

    pub fn get_notifications(&self) -> Value {
        let filtered: Vec<Value> = self
            .notifications
            .iter()
            .filter(|n| {
                !n.get("app")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("antigravity")
            })
            .cloned()
            .collect();
        Value::Array(filtered)
    }

    pub fn dismiss(&mut self, id: &str) -> bool {
        let before = self.notifications.len();
        self.notifications
            .retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id));
        self.notifications.len() != before
    }

    pub fn clear_all(&mut self) {
        self.notifications.clear();
    }

    pub fn mark_all_read(&mut self) {
        for n in self.notifications.iter_mut() {
            if let Some(obj) = n.as_object_mut() {
                obj.insert("read".to_string(), Value::Bool(true));
            }
        }
    }

    /// Polls WinRT UserNotificationListener natively.
    /// Returns `(newly_arrived_notifications, list_updated)`.
    pub fn poll(&mut self) -> (Vec<Value>, bool) {
        if self.paused {
            return (Vec::new(), false);
        }

        if self.suppress_windows_toasts {
            crate::sys_win::ensure_windows_toast_suppression_active();
        }

        let raw_items = fetch_winrt_notifications(self.suppress_windows_toasts);
        let mut new_alerts = Vec::new();
        let mut any_new = false;

        for item in raw_items {
            let app_name = {
                let s = sanitize_notification_text(&item.app);
                if s.is_empty() {
                    "Windows".to_string()
                } else {
                    s
                }
            };
            let clean_title = sanitize_notification_text(&item.title);
            let clean_body = sanitize_notification_text(&item.body);
            let check = format!("{} {} {}", app_name, clean_title, clean_body).to_lowercase();
            if check.contains("antigravity") {
                continue;
            }

            let id_str = format!("win_{}", item.id);
            let is_new = self.known_ids.insert(id_str.clone());
            if is_new {
                any_new = true;
                let notif = json!({
                    "id": id_str,
                    "app": app_name,
                    "title": clean_title,
                    "body": clean_body,
                    "timestamp": item.timestamp_ms,
                    "icon": get_icon_for_app(&app_name),
                    "read": !self.initialized
                });
                self.notifications.insert(0, notif.clone());
                if self.notifications.len() > 50 {
                    self.notifications.pop();
                }
                if self.initialized {
                    new_alerts.push(notif);
                }
            }
        }

        let updated = !self.initialized || any_new;
        self.initialized = true;
        (new_alerts, updated)
    }
}

struct RawToast {
    id: u32,
    app: String,
    title: String,
    body: String,
    timestamp_ms: u64,
}

fn fetch_winrt_notifications(suppress_toasts: bool) -> Vec<RawToast> {
    let mut out = Vec::new();
    let Ok(listener) = UserNotificationListener::Current() else {
        return out;
    };
    let Ok(op) = listener.GetNotificationsAsync(NotificationKinds::Toast) else {
        return out;
    };
    let Ok(list) = op.get() else {
        return out;
    };
    let Ok(binding_key) = KnownNotificationBindings::ToastGeneric() else {
        return out;
    };
    let count = list.Size().unwrap_or(0);
    for i in 0..count {
        let Ok(n) = list.GetAt(i) else { continue };
        let Ok(id) = n.Id() else { continue };
        let app = n
            .AppInfo()
            .and_then(|a| a.DisplayInfo())
            .and_then(|d| d.DisplayName())
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();

        let mut texts: Vec<String> = Vec::new();
        if let Ok(notif) = n.Notification() {
            if let Ok(vis) = notif.Visual() {
                if let Ok(binding) = vis.GetBinding(&binding_key) {
                    if let Ok(elems) = binding.GetTextElements() {
                        let ec = elems.Size().unwrap_or(0);
                        for j in 0..ec {
                            if let Ok(el) = elems.GetAt(j) {
                                if let Ok(txt) = el.Text() {
                                    let s = txt.to_string_lossy().trim().to_string();
                                    if !s.is_empty() {
                                        texts.push(s);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let title = texts.first().cloned().unwrap_or_default();
        let body = if texts.len() > 1 {
            texts[1..].join(" ")
        } else {
            String::new()
        };
        let timestamp_ms = n
            .CreationTime()
            .ok()
            .map(|dt| {
                const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
                let unix_100ns = dt.UniversalTime.saturating_sub(EPOCH_DIFF_100NS);
                if unix_100ns > 0 {
                    (unix_100ns / 10_000) as u64
                } else {
                    now_ms()
                }
            })
            .unwrap_or_else(now_ms);

        out.push(RawToast {
            id,
            app,
            title,
            body,
            timestamp_ms,
        });

        if suppress_toasts {
            let _ = listener.RemoveNotification(id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_whatsapp_bidi_and_question_marks() {
        assert_eq!(
            sanitize_notification_text("CORE TEAM | BJC — ~?Alex?: Photo?"),
            "CORE TEAM | BJC — ~Alex: Photo"
        );
        assert_eq!(
            sanitize_notification_text("\u{2068}Alice\u{2069}: Hello\u{200F}"),
            "Alice: Hello"
        );
        assert_eq!(
            sanitize_notification_text("Are you coming?"),
            "Are you coming?"
        );
    }
}
