use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default = "default_animation_speed")]
    pub animation_speed: f32,
    #[serde(default = "default_island_opacity")]
    pub island_opacity: f32,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(default = "default_true")]
    pub dynamic_lyrics: bool,
    #[serde(default = "default_true")]
    pub album_color_gradient: bool,
    #[serde(default = "default_true")]
    pub game_mode: bool,
    #[serde(default = "default_port")]
    pub hooks_port: u16,
    #[serde(default = "default_true")]
    pub auto_check_updates: bool,
}

fn default_version() -> String { "1.4.10".into() }
fn default_animation_speed() -> f32 { 1.0 }
fn default_island_opacity() -> f32 { 0.95 }
fn default_display_mode() -> String { "island".into() }
fn default_true() -> bool { true }
fn default_port() -> u16 { 47823 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: default_version(),
            animation_speed: default_animation_speed(),
            island_opacity: default_island_opacity(),
            display_mode: default_display_mode(),
            dynamic_lyrics: true,
            album_color_gradient: true,
            game_mode: true,
            hooks_port: default_port(),
            auto_check_updates: true,
        }
    }
}

impl AppConfig {
    pub fn config_path() -> PathBuf {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:\\AppData".into());
        PathBuf::from(appdata).join("DynamicWindows").join("config.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(cfg) = serde_json::from_str::<AppConfig>(&content) {
                    return cfg;
                }
            }
        }
        let def = Self::default();
        let _ = def.save();
        def
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.version, "1.4.10");
        assert_eq!(cfg.display_mode, "island");
        assert!((cfg.island_opacity - 0.95).abs() < f32::EPSILON);
        assert!(cfg.dynamic_lyrics);
    }

    #[test]
    fn test_config_serialization() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("displayMode"));
        assert!(json.contains("islandOpacity"));
    }
}
