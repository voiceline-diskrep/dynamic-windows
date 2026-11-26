//! Configuration Manager — persists preferences to %APPDATA%\DynamicWindows\config.json

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| {
            std::env::var("USERPROFILE").map(|u| format!("{}\\AppData\\Roaming", u))
        })
        .unwrap_or_else(|_| "C:\\".to_string());
    PathBuf::from(base).join("DynamicWindows")
}

pub fn log_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "C:\\".to_string());
    let dir = PathBuf::from(base).join("DynamicWindows").join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn append_log(file_name: &str, msg: &str) {
    let path = log_dir().join(file_name);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "{}", msg);
    }
}

pub fn default_config_map() -> Map<String, Value> {
    match json!({
        "version": APP_VERSION,
        "animationSpeed": 1.0,
        "islandOpacity": 0.95,
        "liquidGlass": false,
        "liteMode": false,
        "reducedMotion": false,
        "displayMode": "island",
        "tabBarPosition": "top",
        "tabBarOrder": [
            "home",
            "notifications",
            "calendar",
            "clock",
            "todo",
            "media",
            "agent",
            "dropzone",
            "clipboard",
            "settings"
        ],
        "tabBarHidden": [],
        "dynamicLyrics": true,
        "liveLyrics": true,
        "albumColorGradient": true,
        "gameMode": true,
        "soundEffects": true,
        "soundVolume": 0.7,
        "soundPreset": "modern",
        "fontFamily": "Theater",
        "userName": "",
        "startup": false,
        "startupTakeover": false,
        "clock24h": false,
        "showSeconds": false,
        "showAmPm": true,
        "suppressWindowsToasts": false,
        "antigravityMonitor": true,
        "autoFocusAntigravity": true,
        "hooksPort": 47823,
        "autoCheckUpdates": true,
        "checkIntervalHours": 24,
        "repoOwner": "voiceline-diskrep",
        "repoName": "dynamic-windows"
    }) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub struct ConfigManager {
    config_file: PathBuf,
    config: Map<String, Value>,
}

impl ConfigManager {
    pub fn new() -> Self {
        Self::with_dir(data_dir())
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let config_file = dir.join("config.json");
        let config = Self::load_from(&config_file);
        Self {
            config_file,
            config,
        }
    }

    fn load_from(path: &PathBuf) -> Map<String, Value> {
        let mut merged = default_config_map();
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&raw) {
                for (k, v) in parsed {
                    merged.insert(k, v);
                }
            }
        }
        merged
    }

    pub fn save(&self) -> bool {
        if let Some(parent) = self.config_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&Value::Object(self.config.clone())) {
            Ok(serialized) => fs::write(&self.config_file, serialized).is_ok(),
            Err(_) => false,
        }
    }

    pub fn all_value(&self) -> Value {
        Value::Object(self.config.clone())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.config.get(key)
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        self.config.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    }

    pub fn get_f64(&self, key: &str, default: f64) -> f64 {
        self.config.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
    }

    pub fn get_str(&self, key: &str, default: &str) -> String {
        self.config
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn set_key(&mut self, key: &str, val: Value) -> Value {
        self.config.insert(key.to_string(), val);
        self.save();
        self.apply_system_settings();
        self.all_value()
    }

    pub fn merge(&mut self, patch: &Map<String, Value>) -> Value {
        for (k, v) in patch {
            self.config.insert(k.clone(), v.clone());
        }
        self.save();
        self.apply_system_settings();
        self.all_value()
    }

    pub fn apply_system_settings(&self) {
        let open_at_login = self.get_bool("startup", false);
        let takeover = self.get_bool("startupTakeover", false);
        let _ = crate::sys_win::set_startup_registry(open_at_login, takeover);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip_and_defaults() {
        let tmp = std::env::temp_dir().join(format!(
            "dw_cfg_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut mgr = ConfigManager::with_dir(tmp.clone());
        assert_eq!(mgr.get_str("displayMode", ""), "island");
        assert!(mgr.get_bool("gameMode", false));
        mgr.set_key("liteMode", Value::Bool(true));
        mgr.set_key("reducedMotion", Value::Bool(true));

        let reloaded = ConfigManager::with_dir(tmp.clone());
        assert!(reloaded.get_bool("liteMode", false));
        assert!(reloaded.get_bool("reducedMotion", false));
        let _ = fs::remove_dir_all(&tmp);
    }
}
