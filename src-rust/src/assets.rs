//! Embedded renderer assets served via custom WebView2 protocol `dw://localhost/...`

pub struct Asset {
    pub bytes: &'static [u8],
    pub mime: &'static str,
}

pub const APP_ICON_PNG: &[u8] = include_bytes!("../../app_icon.png");
pub const APP_ICON_ICO: &[u8] = include_bytes!("../../app_icon.ico");

pub fn get_asset(raw_path: &str) -> Option<Asset> {
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let trimmed = path.trim_start_matches('/');
    match trimmed {
        "" | "index.html" | "island.html" | "src/renderer/island.html" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/island.html"),
            mime: "text/html; charset=utf-8",
        }),
        "settings.html" | "src/renderer/settings.html" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/settings.html"),
            mime: "text/html; charset=utf-8",
        }),
        "rust-bridge.js" | "src/renderer/rust-bridge.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/rust-bridge.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "canvas-engine.js" | "src/renderer/canvas-engine.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/canvas-engine.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "sound-fx.js" | "src/renderer/sound-fx.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/sound-fx.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "tab-animation-engine.js" | "src/renderer/tab-animation-engine.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/tab-animation-engine.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "rolling-number-wheel.js" | "src/renderer/rolling-number-wheel.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/rolling-number-wheel.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "battery-indicator.js" | "src/renderer/battery-indicator.js" => Some(Asset {
            bytes: include_bytes!("../../src/renderer/battery-indicator.js"),
            mime: "application/javascript; charset=utf-8",
        }),
        "assets/fonts/Theaterv04_Bold.ttf" | "src/renderer/assets/fonts/Theaterv04_Bold.ttf" => {
            Some(Asset {
                bytes: include_bytes!("../../src/renderer/assets/fonts/Theaterv04_Bold.ttf"),
                mime: "font/ttf",
            })
        }
        "antigravity_logo.png" => Some(Asset {
            bytes: include_bytes!("../../antigravity_logo.png"),
            mime: "image/png",
        }),
        "app_icon.png" => Some(Asset {
            bytes: APP_ICON_PNG,
            mime: "image/png",
        }),
        "app_icon.ico" => Some(Asset {
            bytes: APP_ICON_ICO,
            mime: "image/x-icon",
        }),
        _ => None,
    }
}
