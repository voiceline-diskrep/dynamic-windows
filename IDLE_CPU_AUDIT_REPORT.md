# Dynamic Windows Idle & Gaming CPU Audit Report

Date: 2026-11-14  
Audited Version: `v1.4.35`  
Test System: 12-core CPU, 1920x1080 display, AMD Radeon RX 6600, Windows

---

## Executive Summary

Task Manager shows `Electron (5)` consuming ~5.7% to 5.9% total system CPU (~68% to 71% of one logical core) during perceived idle, plus intermittent background spikes from short-lived child processes (`sys-helper.exe` and `powershell.exe`) that hurt game frame pacing.

Measured breakdown of live `DynamicWindows.exe` over `402.9s` uptime (`5.86%` lifetime average CPU):

| Process / Component | Uptime / Interval | Total CPU Time | System CPU % (12 cores) | Role |
|---|---|---:|---:|---|
| `DynamicWindows.exe` (`--type=gpu-process`) | 402.7s | 156.09s | 3.23% (3.61% live 4s) | Skia blur shaders + DWM alpha compositing |
| `DynamicWindows.exe` (`--type=renderer`) | 402.5s | 93.52s | 1.94% (3.05% live 4s) | `1040x420` 2D canvas redraws + JS animation loop |
| `DynamicWindows.exe` (`main`) | 402.9s | 31.73s | 0.66% (0.65% live 4s) | IPC dispatch, disk scanning, process spawning |
| `DynamicWindows.exe` (`utility` AudioService) | 401.3s | 1.97s | 0.04% | Chromium audio utility |
| `DynamicWindows.exe` (`utility` NetworkService) | 402.6s | 0.11s | 0.00% | Chromium network utility |
| Persistent `powershell.exe` (`media-session.ps1`) | 402.7s | 1.70s | 0.04% | WinRT GSMTC + fullscreen check |
| Ephemeral `powershell.exe` (`NotificationMonitor`) | Spawned every 10s | 734.38 - 828.13 ms/run (~920 ms wall) | ~0.6% - 0.7% (spike + CLR load) | Cold WinRT toast query spawn |
| Ephemeral `sys-helper.exe` (`get-call-audio`) | Spawned every 3s idle / 0.8s in-call | 81.25 ms/run (133.3 ms wall) | ~0.23% idle / ~0.85% in-call | COM CoreAudio + process/window scan |
| Ephemeral `sys-helper.exe` (`get-media-volume`) | Spawned every 1.5s | 18.75 ms/run (90.4 ms wall) | ~0.10% | COM CoreAudio per-app session volume |

Key finding: 88% of `Electron (5)` CPU comes from the `gpu-process` (3.23%) + `renderer` (1.94%) continuously redrawing a `1040x420` transparent layered Chromium window with Gaussian `ctx.shadowBlur` at 60 FPS whenever background states appear active (Antigravity open/waiting, Discord voice call, playing media, or running timer), rather than staying static.

---

## Controlled Electron Render Benchmarks (Same Hardware)

Isolated Electron `BrowserWindow` (`transparent: true, frame: false, alwaysOnTop: true, hasShadow: false`) measured over 3.5s windows:

| Render Configuration | Total CPU % | `gpu-process` % | `renderer` % | `main` % |
|---|---:|---:|---:|---:|
| `60fps_shadow` (`1040x420`, `shadowBlur: 18`) | 7.14% | 4.04% | 3.07% | 0.03% |
| `60fps_noshadow` (`1040x420`, no `shadowBlur`) | 2.37% | 2.04% | 0.32% | 0.00% |
| `60fps_shadow` (`220x56`, `shadowBlur: 18`) | 5.87% | 3.96% | 1.91% | 0.00% |
| `2fps` (`1040x420`, current true-idle fallback) | 0.26% | 0.23% | 0.03% | 0.00% |
| `0fps` (`1040x420`, event-driven static draw) | 0.16% | 0.13% | 0.00% | 0.00% |

Conclusions from benchmark:
1. Per-frame `ctx.shadowBlur` triggers multi-pass Skia Gaussian blur on the GPU, multiplying renderer CPU by ~9.6x (`0.32% -> 3.07%`) and doubling GPU CPU (`2.04% -> 4.04%`).
2. Even shrinking the window to `220x56` keeps CPU at `5.87%` if running at 60 FPS with `shadowBlur`.
3. Dropping frame rate from 60 FPS to 2 FPS cuts Electron window CPU by ~27x (`7.14% -> 0.26%`), and 0 FPS event-driven drops `renderer` to `0.00%`.

---

## Root Causes & Exact Code Locations

### 1. 60 FPS `requestAnimationFrame` Lock on Semi-Idle / Slow States
- File: `src/renderer/canvas-engine.js` lines `2539-2575` (`isDynamicActive()`) and lines `2727-2732` (`animate()`).
- Mechanism:
  - `isDynamicActive()` returns `true` (forcing continuous 60 FPS redraws) whenever:
    - Any Antigravity project has status `running`, `thinking`, or `waiting` (`lines 2565-2567`). Note: `waiting` draws a static amber dot (`renderTrafficLightDot`, `line 4136-4137`, `pulse = false`), so 60 FPS renders identical pixels 60 times/sec. Additionally, `antigravity-monitor.js:256` waits `120000` ms (2 minutes) before auto-expiring stale active projects.
    - Even when `running`/`thinking`, the only animated resting element is an 8px pulsing dot (`Math.sin(Date.now() / 180)` at `line 4146`), yet the entire `1040x420` transparent canvas clears and redraws at 60 FPS.
    - `callState.inCall` (`line 2563`): Playing any game while in a Discord voice call keeps the overlay pinned at 60 FPS continuously.
    - `timerRunning || stopwatchRunning || focusRunning` (`line 2555`): Timer and Focus update once per integer second, yet run at 60 FPS.
    - `mediaState.isPlaying` (`line 2561`): Keeps 60 FPS active continuously even when desktop is hidden behind a maximized window or game.
- True-idle floor still wastes cycles:
  - `canvas-engine.js:2731` schedules `idleFrameTimeout = setTimeout(requestFrame, 500)` (2 FPS forever) even when `showSeconds` is `false` and the clock only changes once every 60 seconds.

### 2. Expensive Per-Frame Canvas Operations & Large Transparent Surface
- File: `src/renderer/canvas-engine.js` lines `2994-3110` (`render()`), `3895-3917` (`drawDetachedPillSurface()`), `1187-1210` (`drawEqualizer()`); `src/renderer/battery-indicator.js:55-56` (`drawBatteryCircle()`); `src/main/main.js:196-214` (`createIslandWindow()`).
- Mechanism:
  - `createIslandWindow()` allocates a permanent `1040x420` (`436,800` px; up to `1,747,200` px at 2x DPI) transparent layered Electron `BrowserWindow` (`backgroundColor: '#00000000'`).
  - Every frame calls `ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)` (`line 2995`) and applies `ctx.shadowBlur = 18 + 14 * p` (`line 3071`), `ctx.shadowBlur = 14` on each side island (`line 3898`), `ctx.shadowBlur = h * 0.35` on the equalizer (`line 1196`), and `ctx.shadowBlur = 3..6` on battery circle (`battery-indicator.js:56`).
  - Compositing a dirty alpha-transparent swapchain across DWM every frame directly contends with game presentation pipelines.
  - `CanvasRenderingContext2D.prototype.font` setter override (`canvas-engine.js:73-95`) runs regex `.replace(...)` on every font assignment per frame without caching resolved font strings.

### 3. Game Mode Configuration & Incomplete Pause During Gaming
- File: `C:\Users\russell\AppData\Roaming\DynamicWindows\config.json` (`"gameMode": false`), `src/main/main.js:70-90` (`applyGameModeVisibility()`), `1024-1033`, `src/main/media-session.ps1:40-46`.
- Mechanism:
  - Live `config.json` currently has `gameMode: false` (default in `config-manager.js:24` is `true`, so it was turned off). When disabled, the transparent `alwaysOnTop` (`screen-saver` level) overlay stays visible over games.
  - Even when `gameMode: true` and `mainWindow.hide()` runs (`main.js:74`), none of the main-process pollers (`sendMediaState`, `CallMonitor`, `NotificationMonitor`, `AntigravityMonitor`, `clipboard`, `battery`) pause or slow down, and `render()` still gets woken up by IPC messages (`canvas-engine.js:25-35`) executing `ctx.clearRect(...)` before returning at `line 2999`.
  - `media-session.ps1:44` checks `SHQueryUserNotificationState` states `@(2, 3, 4, 7)`, which can miss borderless-windowed games depending on focus/multi-monitor state.

### 4. Continuous Ephemeral Child Process Spawns (CPU + Defender/OS Overhead)
- **`NotificationMonitor`** (`src/main/notification-monitor.js:62,77`):
  - Spawns a fresh `powershell.exe` every `10000ms` to run `Add-Type -AssemblyName System.Runtime.WindowsRuntime` + WinRT `UserNotificationListener`.
  - Measured cost: `901.0-943.4 ms` wall time and `734.38-828.13 ms` CPU time per launch (6 launches/min = 360 CLR + PowerShell cold starts/hour). Causes periodic micro-stutters while gaming.
- **`CallMonitor`** (`src/main/call-monitor.js:127,169,237`, `tools/sys-helper.cs:267-354,470-520`):
  - Spawns `sys-helper.exe get-call-audio` every `3000ms` idle and `800ms` when `inCall`.
  - Measured cost: `81.25 ms` CPU (`133.3 ms` wall) per spawn (enumerates CoreAudio COM capture/render endpoints, active sessions, `Process.GetProcessesByName` across 12 apps, and `EnumWindows`). While gaming on Discord, this spawns a new CLR `.NET` process 1.25x/second.
- **Unconditional `sendMediaState()`** (`src/main/main.js:801-812,1137-1139`):
  - `setInterval(() => sendMediaState(), 1500)` runs unconditionally whether media is playing or unchanged.
  - Spawns `sys-helper.exe get-media-volume` (`18.75 ms` CPU / `90.4 ms` wall per spawn) every `1.5s`.
  - Calls `mediaController.getState()` (`src/main/media-spotify.js:953-1012`), sending `'media-state'` (including full `image_url` base64 art string when media is active) over Electron IPC every `1.5s`, which wakes the renderer frame loop via the `ipcRenderer.on` monkey-patch (`canvas-engine.js:28-31`).

### 5. Synchronous Directory Scanning & Unthrottled IPC Floods in `main` Process (`0.66%` CPU)
- **`AntigravityMonitor.poll()`** (`src/main/antigravity-monitor.js:52,226-356`):
  - Polls every `1500ms` idle / `400ms` active.
  - Calls `fs.readdirSync(this.brainDir)` and checks `fs.existsSync` + `fs.statSync` on every folder inside `C:\Users\russell\.gemini\antigravity\brain`.
  - Current brain directory count on this machine: **233 subdirectories** (~466 synchronous FS syscalls per poll; up to ~1,165 sync syscalls/sec during `400ms` active polling).
- **Clipboard monitor** (`src/main/main.js:113-146`):
  - Calls Chromium `clipboard.readText()` every `1000ms` globally.
- **Battery monitor** (`src/main/main.js:1110`):
  - Calls `sysHelper.getBatteryStatus()` every `15000ms` (`sys-helper.exe get-battery`), even on a desktop PC with no battery and existing `powerMonitor` listeners.
- **`mousemove` IPC flood** (`src/main/main.js:285,296`; `src/renderer/canvas-engine.js:1539-1668,2775-2777`):
  - `mainWindow.setIgnoreMouseEvents(true, { forward: true })` forwards mouse moves across the `1040x420` region. Every `mousemove` calls `requestFrame()` and unconditionally sends `ipcRenderer.send('set-ignore-mouse-events', ...)` without checking if the boolean changed.
- **`media-session.ps1` spin interval** (`src/main/media-session.ps1:51-113`):
  - Uses `Start-Sleep -Milliseconds 100` (10 wakeups/sec), checking GSMTC every `450ms` and fullscreen state every `500ms`. While persistent (`1.70s` over `402.7s`), `250-500ms` sleep when idle/fullscreen reduces unnecessary wakeups.

---

## Solutions & Concrete Optimization Plan

### Phase 1: High-Impact Rendering & Timer Fixes (Target: `< 0.3%` idle/gaming CPU)
1. **Replace live `ctx.shadowBlur` with pre-rendered offscreen shadow/glow sprites**:
   - At startup (or radius change), draw the blur/glow once onto a small offscreen `<canvas>` (or use layered semi-transparent `stroke()` rings without `shadowBlur`) and `ctx.drawImage()` it, or eliminate `shadowBlur` on resting/mini capsules.
   - Expected impact from benchmark: cuts `60fps` renderer CPU ~90% (`3.07% -> 0.32%`) and GPU CPU ~50%.
2. **True event-driven `0 FPS` idle + capped FPS for low-frequency widgets**:
   - Remove `'waiting'` from `isDynamicActive()` (`canvas-engine.js:2565`) since its dot does not pulse.
   - Throttle resting Antigravity dot pulse, active second-counters (`timerRunning`, `focusRunning`), and in-call elapsed clock to **1-15 FPS** (or **1 FPS** for second counters, **15 FPS** for subtle pulse) instead of 60 FPS.
   - Replace `idleFrameTimeout = setTimeout(requestFrame, 500)` (`canvas-engine.js:2731`) with dynamic scheduling to the next clock minute boundary when `showSeconds` is false (or 1000ms when `showSeconds` is true), plus immediate `requestFrame()` on actual state diff or hover/animation start.
   - Remove the unconditional `requestFrame()` wrapper from `ipcRenderer.on` (`canvas-engine.js:25-35`); let handlers call `requestFrame()` only when rendered state actually changes.
3. **Full Game Mode Suspend (Renderer + Main Monitors)**:
   - When `gameModeEnabled && isFullscreenGame`:
     - Guard `requestFrame()` / `animate()` so the renderer does zero work (`return` before scheduling any `requestAnimationFrame` or timeout).
     - Pause `sendMediaState()` interval, `NotificationMonitor`, `CallMonitor` (or suspend `get-call-audio`), `AntigravityMonitor` disk polls, and clipboard polling until fullscreen exits.
   - Expose a manual "Gaming / Low-Power Mode" toggle or foreground process detection (borderless game support) if `SHQueryUserNotificationState` misses borderless fullscreen games.
4. **Stop redundant `sendMediaState()` & deduplicate `mousemove` IPC**:
   - In `main.js:801-812,1137-1139`: Do not broadcast `'media-state'` every `1500ms` when no media is active or nothing changed; push immediately on `mediaController.on('changed')` and only sync timeline/lyrics on a timer while `playing === true` (without re-sending unchanged base64 `image_url`). Only call `sysHelper.getMediaVolume` when media is active/playing or media view is open.
   - In `canvas-engine.js:1539-1668`: Cache `lastIgnoreMouseEvents` and only call `ipcRenderer.send('set-ignore-mouse-events', ...)` when the value flips. Do not bind `requestFrame` directly to raw `mousemove` unless cursor actually hovered/entered an interactive region or state changed.

### Phase 2: Process Consolidation & Disk Optimization (Eliminates periodic game micro-stutters)
5. **Convert `sys-helper.exe` to a persistent stdin/stdout daemon (or lightweight PowerShell/WinRT worker)**:
   - Instead of spawning a fresh CLR process (`sys-helper.exe`) every `1.5s` (`get-media-volume`) and `3s`/`0.8s` (`get-call-audio`), run ONE persistent `sys-helper.exe --daemon` listening on stdin commands (same architecture as `media-session.ps1`, which used only `1.70s` total CPU over 402.7s!).
   - Move `NotificationMonitor` WinRT toast polling into that persistent C# daemon (or increase interval to `30s+` and disable when `gameModeEnabled && isFullscreenGame`), eliminating the `~800 ms` CPU `powershell.exe` launch every 10s.
6. **Optimize `AntigravityMonitor` directory scanning**:
   - Use `fs.watch(this.brainDir, { recursive: false })` or cache active conversation IDs / `mtimeMs` map without re-reading stale dirs, skip dirs older than 25m after initial discovery, and lower the stuck-active auto-expire timeout (`antigravity-monitor.js:256`) from `120000ms` (2m) to e.g. `20000ms` for toolless idle turns (and immediately treat `waiting` as visually static).
   - Reduce `media-session.ps1` `Start-Sleep -Milliseconds 100` to `250-500ms` when no media is playing.
7. **Stop unnecessary desktop battery polling & cache `ctx.font` setter**:
   - If initial `getBatteryStatus()` returns `hasBattery: false`, disable the `15000ms` battery polling interval (`main.js:1110`) and rely only on `powerMonitor` events.
   - Memoize transformed font strings in `CanvasRenderingContext2D.prototype.font` (`canvas-engine.js:76-95`) via a `Map`.

### Phase 3: Architectural Alternatives (Optional / Not Recommended Now)
- Rewriting the overlay UI into Tauri/Rust (`src-tauri/` skeleton in repo) or Win32 DirectComposition.
- High implementation and regression cost; unnecessary once Phase 1 + Phase 2 already reduce idle/gaming Electron CPU to ~`0.1% - 0.3%`.

---

## Recommendation: What To Do & Should We Do It?

### Short Answer
1. **Immediate user step (0 code changes)**: Re-enable `Game Mode` (`Ctrl+Shift+G` or tray menu), since `config.json` currently has `"gameMode": false`. Note: on borderless games or while still in Discord/listening to music, background timers and child spawns will still fire until patched.
2. **Should the agent implement Phase 1 & Phase 2? Yes — strongly recommended, in two clean PRs:**
   - **Do Phase 1 immediately**: Very low risk, touches only `src/renderer/canvas-engine.js`, `src/renderer/battery-indicator.js`, and `src/main/main.js`, preserves 100% of existing features/UI look, and removes ~85% to 95% of idle/background GPU + renderer + main CPU load.
   - **Do Phase 2 right after**: Moderate scope (`tools/sys-helper.cs`, `src/main/sys-helper.js`, `src/main/notification-monitor.js`, `src/main/antigravity-monitor.js`), eliminates `~800 ms` PowerShell and `~81 ms` `.NET` child process spawns during gameplay.
   - **Skip Phase 3**: Not worth rewriting into Tauri/native Win32 when Electron at `0 FPS` idle measures only `0.16%` total CPU on this system.
