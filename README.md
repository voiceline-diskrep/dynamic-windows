# 🏝️ Dynamic Windows (Always On Top)

An Apple Dynamic Island / MacBook Notch overlay for Windows. It stays pinned on top of all windows at the top-center of your screen.

[![Download Dynamic Windows](https://img.shields.io/badge/Download-Windows%20Installer%20(.exe)-blue?style=for-the-badge&logo=windows)](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.1.exe)

---

## 📥 Download & Install (Easiest Method)

**No Python or dependencies required!**

1. Download the installer:
   👉 **[Download DynamicWindows-Setup-v1.0.1.exe](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.1.exe)**
2. Run the downloaded installer.
3. Done! It will install the app, create a Desktop & Start Menu shortcut, and optionally start with Windows.

---

## ✨ Features

- **Always On Top**: Stays above all open windows, browsers, and applications using Windows `HWND_TOPMOST` and frameless transparent flags.
- **Zero Focus Stealing**: Designed with `WA_ShowWithoutActivating` and `WindowDoesNotAcceptFocus` so clicking or hovering never interrupts your active work or typing.
- **Standby Mode**: Compact, minimal pill showing only the time (hides seconds).
- **Smooth Spring Hover Animation**:
  - The single continuous clock smoothly glides up and scales up in size.
  - Seconds (`:SS`) smoothly extend horizontally between minutes and AM/PM.
  - The full date and GitHub update pill reveal underneath.
- **Adjustable Animation Speed**:
  - One-click presets: **⚡ Very Fast (120ms)**, **🚀 Fast (180ms)**, **✨ Normal (280ms)**, **🐢 Slow (550ms)**, **🎬 Cinematic (900ms)**.
  - Interactive **🎛️ Custom Speed Slider**: Live preview testing.
- **Automatic GitHub Updates**:
  - Checks GitHub for new updates on launch and whenever opened.
  - One-click button to pull updates directly.
- **Right-Click Context Menu**:
  - Change animation speed.
  - Toggle 12-Hour (`AM/PM`) vs 24-Hour format.
  - Toggle seconds display on open.
  - Switch style: **Floating Island** (6px from top) vs **Flush Notch** (anchored to bezel).
  - Pin the notch to keep it expanded.
  - Recenter notch.
- **Draggable**: Hold `Shift` or `Ctrl` and drag with the left mouse button to adjust position. Middle-click to recenter.
- **System Tray Icon**: Quick access to recenter, adjust speed, or exit.

---

## 🛠️ Developer Setup (Running from source)

If you prefer to run or build from Python source:

```bash
git clone https://github.com/voiceline-diskrep/dynamic-windows.git
cd dynamic-windows
pip install -r requirements.txt
run.bat
```
