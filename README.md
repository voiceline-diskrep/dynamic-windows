# 🏝️ Dynamic Windows (v1.4.1)

A fluid, Apple-style **Dynamic Island & Dynamic Notch** desktop environment built for Windows, powered by high-performance hardware-accelerated Canvas rendering with deep **Google Antigravity & AI Agent** tracking, a **Dual Split Resting Pill (AI Activity Capsule + Main Activity Pill + Right Call Capsule)**, a **Dedicated Calendar Tab with Recurring Date Notes**, a **Dedicated Clock Tab (Timer, Stopwatch, Focus Mode)**, a **Dedicated To-Do List Tab with Custom Categories**, a **Dual-Zone Drop Shelf (One-Time Use vs Keep with Auto-Clear on Drag-Out)**, real-time **Liner Synced Lyrics**, **Connected Song Change Announcements**, **Customizable Animation Speed**, **Crisp Monochrome Vector Logos**, a **Clipboard History Manager**, **Game Mode**, and a **Settings Exit Button**.

[![Download Dynamic Windows](https://img.shields.io/badge/Download-Windows%20Installer%20(.exe)-blue?style=for-the-badge&logo=windows)](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.4.1.exe)

---

## 📥 Download & Install

👉 **[Download DynamicWindows-Setup-v1.4.1.exe](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.4.1.exe)**

- **Single-File Standalone Setup**: Self-contained installer compiled with native C# (`.NET`).
- **Zero Admin Rights Required**: Installs directly to `%LOCALAPPDATA%\Programs\DynamicWindows` without UAC prompts.
- **Instant Shortcuts**: Creates Desktop and Start Menu shortcuts automatically.

---

## ✨ Features & Highlights

### 📅 Dedicated Calendar Tab
- **Interactive Month Grid & Date Picker**: Full-month calendar navigation with previous/next month buttons, day selection, and a `Today` jump pill.
- **Date Notes & Recurring Events**: Record notes for any date with flexible recurrence:
  - `🎂 Birthday / Yearly`: Recurring annual celebrations and milestones.
  - `🔁 Monthly`: Monthly deadlines and bills.
  - `🔁 Weekly`: Recurring weekly standups and meetings.
  - `🔁 Daily`: Daily routines and habits.
  - `📌 Once`: One-time notes and reminders.
- **Visual Event Indicators**: Days with notes render colored indicator dots (pink for birthdays, cyan for reminders).

### ⏱️ Dedicated Clock Tab
- **3 Sub-Modes in One Tab**:
  - **⏳ Timer**: Countdown timer with presets (`1m`, `5m`, `15m`, `25m`, `45m`, `60m`), `+1m` / `-1m` nudges, and live progress.
  - **⏱️ Stopwatch**: High-precision millisecond stopwatch (`00:00.00`) with split and lap tracking.
  - **🎯 Focus Mode**: Pomodoro session manager with 25m focus sessions, 5m short breaks, and session cycle counters.
- **Resting Pill Live Badges**: When a timer or focus session is running and the Island collapses to rest, the resting pill displays a live countdown badge (e.g. `⏱️ 14:20` or `🎯 Focus 22:05`).

### ✅ Dedicated To-Do List Tab
- **Custom User Categories**: Add custom categories (e.g. `Projects`, `Fitness`, `Ideas`) or delete them anytime.
- **Category Filter Chips**: Easily filter tasks by clicking category chips (`All`, `Personal`, `Work`, `Island`, or custom).
- **Interactive Checklist**: Tasks feature circular checkmarks `[✓]` with smooth green strike-through animations and completion timestamps.

### 📁 Dual-Zone Drop Shelf (One-Time Use vs. Keep)
- **Visual Split on Drag-In**: Dragging any file over the Island or Drop Shelf splits the drop target into two equal zones:
  - **Left Zone (`⚡ One-Time Use`)**: Amber dashed border. Files dropped here automatically remove themselves from the shelf as soon as you drag them out into external apps (e.g. WhatsApp, Discord, Browser, Slack).
  - **Right Zone (`📌 Keep`)**: Emerald dashed border. Files dropped here stay permanently on your shelf across drag-outs until you explicitly click `✖`.
- **Shelf Row Badges**: Each file displays an amber `⚡ 1-Time` badge or an emerald `📌 Keep` badge.

### 🚪 Settings Page Exit Button
- **Clean One-Click Exit**: Dedicated `Exit Dynamic Windows` button in the Settings sidebar and About page to cleanly terminate the app without needing Windows Task Manager.

---

## ✨ Features & Highlights

### 🏝️ Dual Display Modes: Island & Notch
- **Dynamic Island**: A floating, detached liquid glass OLED capsule that glides smoothly across your screen.
- **Dynamic Notch**: A flush-to-top bezel notch inspired by modern MacBooks.
- **1-Click Switching**: Toggle seamlessly between Island and Notch modes anytime using the header switcher button or the system tray.

### 🎵 Real-Time Synced Lyrics & Dynamic Capsule Sizing
- **Universal Media Detection**: Native integration with Liner (`com.hkamori.liner`), Spotify, Apple Music, and Windows GSMTC media sessions.
- **Dynamic Per-Line Lyric Sizing**: The resting pill automatically springs between **200px and 420px** to perfectly hug each line of lyrics in real time—eliminating blank voids and text clipping.
- **Slowed + Reverb Audio Sync Engine**: Automatically detects native `PlaybackRate` from Windows GSMTC playback info. Features manual speed chips (`Auto`, `0.8x`, `0.85x`, `0.9x`, `1.0x`) and sync nudge controls (`[-0.5s]`, `[+0.5s]`, `↺ Reset`) so lyrics stay locked in sync even on modified audio.
- **6-Bar Fluid Equalizer**: Animated real-time audio visualization tinted with your album's accent colors.

### 💿 Connected Downward Song Change Announcement
- Whenever a new track begins playing, the Dynamic Island smoothly extends downward as **one single connected liquid glass container**.
- **Square Profile Art**: Features rounded album artwork with an ambient color backlight radiating into the dark OLED glass.
- **Typographic Hierarchy**:
  - **Song Title** in bold white text.
  - **Artist** in clean, reduced-opacity text.
  - **Album** in subtle opacity text.
  - **Live Duration Track**: Elapsed time, total song length, and a glowing gradient progress bar.
- **Auto-Retract & Hover Pause**: Stays extended for 6 seconds before smoothly springing back up to the resting pill. Hovering pauses the countdown; clicking the banner expands directly to the full Media tab.

### 🤖 Google Antigravity & AI Agent Monitor
- **Multi-Project Stacking**: Real-time monitoring of concurrent agent sessions. Background projects stack neatly beneath each other or display side-by-side in the dedicated **Ai** tab.
- **4-Segment Progress Bar**: Visual step indicator tracking task progress (`Analyze`, `Execute`, `Verify`, `Complete`) with green milestone fills and cyan activity pulses.
- **1-Click Window Focus**: Focus the active AI IDE window directly from the island.

### 📋 In-Memory Clipboard Manager
- **Clipboard Tab**: Tracks your last 25 copied snippets in memory.
- **Live Search Filter**: Rapidly filter clips by typing in the search bar.
- **Pin to Top**: Keep important code snippets and notes pinned at the top.
- **1-Click Copy**: Instant click-to-copy with visual `✓ Copied` feedback.

### 📁 Bi-Directional Drop Shelf
- **Desktop Drop Zone**: Drop files directly into the Island or Notch to keep them shelved on your desktop.
- **Native Drag-Out**: Drag files **out** of the shelf directly into File Explorer, the desktop, code editors, or chat applications.
- **MCP Shelf Integration**: AI agents can shelve deliverables and compiled installers straight into your desktop shelf using the `dynamic_island_shelf_file` tool.

### 🎮 Smart Game Mode
- **Auto-Hide during Games (Default ON)**: Detects full-screen games and Direct3D apps via `SHQueryUserNotificationState` and automatically hides the Island so it never obstructs gameplay.
- **Keep Visible In-Game (Toggle OFF)**: Want to see your lyrics, clock, and agent progress while gaming? Disable Game Mode to keep the Island floating on top of your games.
- **Global Hotkey**: Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> anytime to toggle Game Mode on the fly with an instant visual notification.

### 🔌 Model Context Protocol (MCP) Server
Dynamic Windows includes a built-in MCP server (`src/mcp/dynamic-windows-mcp.js`) exposing tools for AI coding assistants:
- `dynamic_island_notify`: Send live progress, phases, and status to the desktop island.
- `dynamic_island_shelf_file`: Place generated deliverables and installers directly onto the user's shelf.
- `dynamic_island_set_mode`: Switch between `"island"` and `"notch"`.
- `dynamic_island_get_state`: Query live desktop state.

---

## ⌨️ Global Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> | Toggle Game Mode (Auto-hide vs Visible in games) |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> | Focus Dynamic Island & Untuck |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>H</kbd> | Tuck away to minimalist edge indicator |

---

## 🛠️ Developer Setup & Build

```bash
# Clone repository
git clone https://github.com/voiceline-diskrep/dynamic-windows.git
cd dynamic-windows

# Install dependencies
npm install

# Run automated tests
npm test

# Launch desktop app
npm start
```

### Building the Standalone Installer
To stage the full distribution and compile the C# setup executable:
```bash
npm run build:setup
```
The compiled installer will be output to `installer_output/DynamicWindows-Setup-v1.3.5.exe`.

---

## 📄 License
ISC License © 2026 voiceline-diskrep
