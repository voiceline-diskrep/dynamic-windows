# 🏝️ Windows Dynamic Notch (Always On Top)

An Apple Dynamic Island / MacBook Notch overlay for Windows built with PyQt6. It stays pinned on top of all windows at the top-center of your screen.

---

## ✨ Features

- **Always On Top**: Stays above all open windows, browsers, and applications using Windows `HWND_TOPMOST` and frameless transparent flags.
- **Doesn't Steal Focus**: Designed with `WA_ShowWithoutActivating` and `WindowDoesNotAcceptFocus` so clicking or hovering over it never interrupts your active work or typing.
- **Dynamic Spring Hover Animation**:
  - **Resting state**: Sleek, clean minimal matte black notch.
  - **Hover state**: Expands organically with spring physics to reveal digital time (12h/24h) and full date.
- **Adjustable Animation Speed**:
  - Quick presets: **⚡ Very Fast (120ms)**, **🚀 Fast (180ms)**, **✨ Normal (280ms)**, **🐢 Slow (550ms)**, **🎬 Cinematic (900ms)**.
  - Interactive **🎛️ Custom Speed Slider**: Tune the exact millisecond duration with a live test preview!
- **Persistent Settings**: Saves all preferences automatically to `config.json`.
- **Right-Click Context Menu**:
  - Change animation speed (presets or custom slider).
  - Toggle 12-Hour (`AM/PM`) vs 24-Hour format.
  - Toggle seconds display.
  - Toggle showing compact time in the resting notch.
  - Switch style: **Floating Island** (floats 6px below top edge) vs **Flush Notch** (anchored to bezel).
  - Pin the notch to keep it expanded.
  - Recenter the notch.
  - Exit.
- **Draggable**: Hold `Shift` or `Ctrl` and drag with the left mouse button to adjust horizontal alignment. Middle-click resets it to center.
- **System Tray Icon**: Quick access to recenter, adjust speed, or exit.

---

## 🚀 How to Run

Double-click `run.bat` or run in terminal:

```bash
pythonw dynamic_notch.py
```
*(Using `pythonw` runs it without any terminal window opening)*
