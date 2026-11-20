use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=app.rc");
    println!("cargo:rerun-if-changed=vendor/WebView2Loader.dll");
    println!("cargo:rerun-if-changed=../app_icon.ico");
    println!("cargo:rerun-if-changed=../src/renderer/island.html");
    println!("cargo:rerun-if-changed=../src/renderer/settings.html");
    println!("cargo:rerun-if-changed=../src/renderer/rust-bridge.js");
    println!("cargo:rerun-if-changed=../src/renderer/canvas-engine.js");
    println!("cargo:rerun-if-changed=../src/renderer/sound-fx.js");
    println!("cargo:rerun-if-changed=../src/renderer/tab-animation-engine.js");
    println!("cargo:rerun-if-changed=../src/renderer/rolling-number-wheel.js");
    println!("cargo:rerun-if-changed=../src/renderer/battery-indicator.js");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let res_obj = out_dir.join("app_icon.o");

    if let Ok(status) = Command::new("windres")
        .args(["app.rc", "-O", "coff", "-o"])
        .arg(&res_obj)
        .status()
    {
        if status.success() {
            println!("cargo:rustc-link-arg={}", res_obj.display());
        }
    }

    // Copy WebView2Loader.dll next to the built binary (target/debug or target/release)
    let vendor_dll = PathBuf::from("vendor/WebView2Loader.dll");
    if vendor_dll.exists() {
        if let Some(target_profile_dir) = out_dir.ancestors().nth(3) {
            let _ = fs::copy(&vendor_dll, target_profile_dir.join("WebView2Loader.dll"));
        }
    }
}
