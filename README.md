# 🏝️ Dynamic Windows + One-Shot (v1.0.3)

A polished Windows desktop application combining two connected experiences:
1. **One-Shot:** A smart application launcher with presets, automatic app discovery, startup takeover mode, and one-click launching.
2. **Windows Dynamic Island:** An Apple-inspired desktop interface that provides quick access to system information, notifications, music, AI coding agents, downloads, timers, files, and other activities.

[![Download Dynamic Windows](https://img.shields.io/badge/Download-Windows%20Installer%20(.exe)-blue?style=for-the-badge&logo=windows)](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.3.exe)

---

## 📥 Download & Install (Easiest Method)

**No Python or dependencies required!**

1. Download the installer:
   👉 **[Download DynamicWindows-Setup-v1.0.3.exe](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.3.exe)**
2. Run the downloaded installer.
3. Done! It will install the app, create a Desktop & Start Menu shortcut, and optionally start with Windows.

---

## ✨ Features

### Part A — One-Shot Application Launcher
- **Smart App Discovery**: Automatically scans Windows Start Menu shortcuts, standard program directories, and Windows Registry with native icon extraction and filtering out uninstallers/helpers.
- **Preset Management**: Create, edit, duplicate, rename, and reorder presets (e.g. Gaming, Work & Code, Creative Studio) with custom launch delays and arguments.
- **Asynchronous Launch Engine**: Reliable 1-click launching using non-blocking detached processes without frozen UI or duplicate launches.
- **Startup Takeover Mode**: Optional full-screen workspace selection on Windows sign-in with a prominent **`Just Enter ➔`** bypass button and keyboard shortcuts (`Enter`/`Esc`) for safe recovery.

### Part B — Windows Dynamic Island
- **Always On Top & Zero Focus Stealing**: Apple-inspired borderless black pill pinned at top-center of screen with `HWND_TOPMOST` and `WA_ShowWithoutActivating`.
- **Pure Standby Clock**: Displays ONLY the current time with zero visual clutter when idle.
- **Dynamic Activity Engine**: Coordinates live events and shows sleek badges when activities are active (Focus Timer, Active Downloads, Music Playback, AI Coding Agents, Updates).
- **Navigation Tabs**:
  - **Home**: Integrated dashboard with One-Shot quick workspaces, live AI agent status, music player, and focus timer.
  - **One-Shot**: Workspace preset launcher and preset editor.
  - **Files (Drop Zone)**: Persistent file shelf stored in `%APPDATA%\DynamicWindows\drop_zone\` with drag-and-drop ingestion, file opening, and explorer reveal.
  - **Calendar**: Interactive month calendar with date navigation and persistent reminders.
  - **Notifications**: Windows notification monitor, formatted cards, and history with clear actions.
  - **Sound**: Real Windows system master volume control via `pycaw`, mute toggle, and subtle typing sounds feedback.
  - **Music**: Windows Media session controls (Play/Pause, Next, Previous) and track visualizer.
  - **Activities**: Multi-provider AI Coding Agent tasks (Antigravity, Claude Code, Codex), active downloads, and background jobs.
  - **Timer**: Accurate 25-minute Pomodoro focus timer with custom durations, completion sound, and compact pill indicator.
  - **Task Manager**: Real Windows CPU, RAM, Disk, Network usage, and process list with protected system process safeguards.
  - **Stickers**: Custom image sticker collection with Dynamic Island pill docking.

### Part C — Automatic GitHub Updates
- **GitHub Release Monitoring**: Checks GitHub Releases API in the background using configurable intervals (1h, 3h, 6h, 12h, 24h, or manual).
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
