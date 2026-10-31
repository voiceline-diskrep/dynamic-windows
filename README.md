# 🏝️ Dynamic Windows + One-Shot (v1.0.4)

A polished Windows desktop application combining two connected experiences:
1. **One-Shot:** A smart application launcher with presets, automatic app discovery, startup takeover mode, and one-click launching.
2. **Windows Dynamic Island:** An authentic Apple-inspired desktop interface that provides quick access to system information, notifications, music, AI coding agents, downloads, timers, files, and other activities.

[![Download Dynamic Windows](https://img.shields.io/badge/Download-Windows%20Installer%20(.exe)-blue?style=for-the-badge&logo=windows)](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.4.exe)

---

## 📥 Download & Install (Easiest Method)

**No Python or dependencies required!**

1. Download the installer:
   👉 **[Download DynamicWindows-Setup-v1.0.4.exe](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.4.exe)**
2. Run the downloaded installer.
3. Done! It will install the app, create a Desktop & Start Menu shortcut, and optionally start with Windows.

---

## ✨ Features in v1.0.4

### Part A — 144Hz High-Precision Dynamic Island Engine
- **True 144Hz Butter-Smooth Animation**: Driven by a precise 7ms frame timer (`Qt.TimerType.PreciseTimer` and high-resolution `time.perf_counter()`) with Apple Quartic ease-out dynamics.
- **Pure Apple Liquid Glass Aesthetics**: Spacious, uncluttered, OLED black pill with specular border rim and ambient drop shadow.
- **Official Google Antigravity Logo**: Integrates the official high-DPI Antigravity logo in the pill badge, live activity card, and settings without placeholder emojis.
- **Spacious, Breathable Design**: No cramped tabs or overflowing windows. Quick launch buttons for One-Shot, Drop Zone, Task Manager, and Settings open dedicated floating windows.

### Part B — One-Shot Application Launcher
- **Smart App Discovery**: Automatically scans Windows Start Menu shortcuts, standard program directories, and Windows Registry with native icon extraction and filtering out uninstallers/helpers.
- **Preset Management**: Create, edit, duplicate, rename, and reorder presets (e.g. Gaming, Work & Code, Creative Studio) with custom launch delays and arguments.
- **Asynchronous Launch Engine**: Reliable 1-click launching using non-blocking detached processes without frozen UI or duplicate launches.
- **Startup Takeover Mode**: Optional full-screen workspace selection on Windows sign-in with a prominent **`Just Enter ➔`** bypass button and keyboard shortcuts (`Enter`/`Esc`) for safe recovery.

### Part C — Dynamic Island Live Activities & Tools
- **Live Activity Engine**: Displays active Google Antigravity tasks, music playback, downloads, and focus timers with progress indicators and action buttons.
- **Persistent Drop Zone Shelf**: Drag-and-drop storage in `%APPDATA%\DynamicWindows\drop_zone\`.
- **System Task Manager & Audio**: Real-time CPU, RAM, Disk, Network usage, and process list with protected system process safeguards.
- **Music & Media Controls**: Windows Media session controls (Play/Pause, Next, Previous) and track info.

### Part D — Automatic GitHub Updates
- **GitHub Release Monitoring**: Checks GitHub Releases API in the background using configurable intervals.
- **SemVer 2.0.0 Support**: Detects newer versions automatically, with optional pre-release / beta channel.
- **Verified Downloads & Safe Replacement**: SHA256 integrity verification, Windows PE validation, and non-blocking detached process replacement.

---

## 🛠️ Developer Setup (Running from source)

If you prefer to run or build from Python source:

```bash
git clone https://github.com/voiceline-diskrep/dynamic-windows.git
cd dynamic-windows
pip install -r requirements.txt
python dynamic_notch.py
```

To run in Startup Takeover Mode directly:
```bash
python dynamic_notch.py --startup-mode
```
