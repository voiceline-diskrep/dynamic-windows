# 🏝️ Dynamic Windows + One-Shot (v1.0.5)

A polished Windows desktop application inspired by Apple's Dynamic Island and TwoCode, combining:
1. **Windows Dynamic Island (Electron + HTML5 Canvas):** A 144Hz hardware-accelerated liquid glass desktop interface with deep Google Antigravity integration, live agent statusline, Spotify media controls, and Drop Zone shelf.
2. **One-Shot:** A smart application launcher with presets, Start Menu discovery, and Startup Takeover mode.

[![Download Dynamic Windows](https://img.shields.io/badge/Download-Windows%20Installer%20(.exe)-blue?style=for-the-badge&logo=windows)](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.5.exe)

---

## 📥 Download & Install

👉 **[Download DynamicWindows-Setup-v1.0.5.exe](https://github.com/voiceline-diskrep/dynamic-windows/releases/latest/download/DynamicWindows-Setup-v1.0.5.exe)**

- **TwoCode-Style Single-File Setup**: Embedded installer package compiled with native C# (`.NET`).
- Installs directly to `%LOCALAPPDATA%\Programs\DynamicWindows` with **zero admin rights / UAC prompts required**.
- Automatically creates Desktop and Start Menu shortcuts.

---

## ✨ What's New in v1.0.5

### 🚀 Electron + HTML5 Canvas 2D Engine (TwoCode-Inspired)
- Migrated to an ultra-fluid **Electron + HTML5 `<canvas>` 2D rendering pipeline** syncing with 144Hz monitors for zero-lag, tear-free animations.
- **Pure Minimalist Identity (No Mascot)**: Removed the cartoon companion in favor of clean Inter / Segoe UI typography, the official Google Antigravity logo, and a geometric traffic light status indicator.

### ✦ Real-Time Google Antigravity Integration
- **Live Transcript Watcher**: Automatically monitors active Antigravity conversations at `~/.gemini/antigravity/brain/*/transcript.jsonl`.
- **Live Tool Execution**: Displays running commands (`run_command`), file modifications (`write_file`, `edit_file`), and thinking phases.
- **Traffic Light Status**:
  - 🟢 Green: Ready / Done
  - 🟠 Orange Pulse: Working (Executing tool / shell command)
  - 🟠 Orange Solid: Awaiting user input
  - 🔴 Red: Error
- **1-Click Window Focus**: Focus the Antigravity IDE window directly from the island.

### 🛡️ Agent Hooks Server (`127.0.0.1:47823`)
- Built-in local hook server compatible with Claude Code and Codex hook events.
- **1-Click In-Island Permissions**: Suspends tool requests so users can click `[ Allow ]` or `[ Deny ]` right in the island.
- **Rate Limit Tracking**: Tracks 5-hour and 7-day quota usage directly from Claude Code status line reports.

### ⚡ Integrated One-Shot & Startup Takeover
- **In-Island Presets**: Launch preset application groups directly from the expanded island (`apps` view).
- **Startup Takeover Mode**: Full-screen workspace picker on sign-in with a prominent **`Just Enter ➔`** desktop bypass button (`Ctrl+Alt+T` or `--startup-mode`).

---

## 🛠️ Developer Setup

```bash
git clone https://github.com/voiceline-diskrep/dynamic-windows.git
cd dynamic-windows
npm install
npm test
npm start
```

To compile the single-file installer:
```bash
npm run build:setup
```
