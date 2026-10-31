'use strict';
/**
 * Dynamic Windows + One-Shot
 * Main Process (Electron + Node.js)
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu } = require('electron');
const path = require('path');

const AntigravityMonitor = require('./antigravity-monitor');
const AgentHooksServer = require('./agent-hooks-server');
const OneShotEngine = require('./oneshot-engine');
const { createStartupTakeover } = require('./startup-takeover');
const MediaController = require('./media-spotify');
const DropZone = require('./drop-zone');
const { createSettingsWindow, registerSettingsIPC } = require('./settings-window');

let mainWindow = null;
let tray = null;
let antigravityMonitor = null;
let agentHooksServer = null;
let oneShotEngine = null;
let mediaController = null;
let dropZone = null;
let isQuitting = false;

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createIslandWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenBounds = primaryDisplay.bounds;

  // Initial standby dimensions
  const initialWidth = 560;  // Generous container width to allow fluid canvas animation
  const initialHeight = 260; // Max expanded height container

  const initialX = Math.round((screenBounds.width - initialWidth) / 2);
  const initialY = 0;

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'island.html'));

  // Prevent accidental close via Ctrl+W / Alt+F4 unless quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      return false;
    }
  });

  // Intercept and prevent default browser accelerators (Ctrl+W, Ctrl+R, Alt+F4)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && ['w', 'r'].includes(input.key.toLowerCase())) {
      event.preventDefault();
    }
    if (input.alt && input.key.toLowerCase() === 'f4') {
      event.preventDefault();
    }
  });

  // Enable click-through on transparent margins while forwarding mouse moves
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Multi-monitor centering helper
  function recenterWindow(targetW, targetH) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const curScreen = screen.getPrimaryDisplay().bounds;
    const x = Math.round((curScreen.width - targetW) / 2);
    mainWindow.setBounds({ x, y: 0, width: targetW, height: targetH });
  }

  // Mouse ignore IPC listener from canvas engine
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, options || { forward: true });
    }
  });

  // Window bounds IPC listener from canvas engine
  ipcMain.on('window-bounds-update', (event, bounds) => {
    // Canvas handles rendering within the transparent window
  });

  // Hover triggers
  ipcMain.on('island-hover-start', () => {
    // If needed, adjust click-through
  });

  ipcMain.on('island-hover-end', () => {});

  // Presets IPC
  ipcMain.on('launch-preset', async (event, presetId) => {
    if (oneShotEngine) {
      await oneShotEngine.launchPreset(presetId);
    }
  });

  // Antigravity Focus
  ipcMain.on('focus-antigravity', () => {
    if (antigravityMonitor) {
      antigravityMonitor.focusAntigravityWindow();
    }
  });

  // Agent Permissions response
  ipcMain.on('permission-response', (event, { id, allow }) => {
    if (agentHooksServer) {
      agentHooksServer.respondPermission(id, allow);
    }
  });

  // Media Controls
  ipcMain.on('media-play-pause', () => {
    if (mediaController) {
      mediaController.playPause();
      sendMediaState();
    }
  });

  ipcMain.on('media-next', () => {
    if (mediaController) {
      mediaController.nextTrack();
    }
  });

  ipcMain.on('media-prev', () => {
    if (mediaController) {
      mediaController.prevTrack();
    }
  });

  // Drop Zone
  ipcMain.on('open-dropzone', () => {
    if (dropZone) {
      dropZone.revealInExplorer();
    }
  });

  // Settings Window
  ipcMain.on('open-settings', () => {
    createSettingsWindow(dropZone, oneShotEngine);
  });

  // Startup Takeover Trigger
  ipcMain.on('trigger-startup-takeover', () => {
    createStartupTakeover(oneShotEngine);
  });

  // Send initial data once loaded
  mainWindow.webContents.once('did-finish-load', () => {
    sendAntigravityState();
    sendPresetsList();
    sendMediaState();
  });
}

function sendAntigravityState() {
  if (mainWindow && !mainWindow.isDestroyed() && antigravityMonitor) {
    mainWindow.webContents.send('antigravity-state', antigravityMonitor.getState());
  }
}

function sendPresetsList() {
  if (mainWindow && !mainWindow.isDestroyed() && oneShotEngine) {
    mainWindow.webContents.send('presets-list', oneShotEngine.getPresets());
  }
}

function sendMediaState() {
  if (mainWindow && !mainWindow.isDestroyed() && mediaController) {
    mainWindow.webContents.send('media-state', mediaController.getState());
  }
}

function setupTray() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'app_icon.png');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '⚡ One-Shot Takeover Screen',
        click: () => {
          createStartupTakeover(oneShotEngine);
        }
      },
      {
        label: '📁 Open Drop Zone Folder',
        click: () => {
          if (dropZone) dropZone.revealInExplorer();
        }
      },
      {
        label: '⚙️ Settings & Preferences...',
        click: () => {
          createSettingsWindow(dropZone, oneShotEngine);
        }
      },
      { type: 'separator' },
      {
        label: 'Focus Google Antigravity',
        click: () => {
          if (antigravityMonitor) antigravityMonitor.focusAntigravityWindow();
        }
      },
      { type: 'separator' },
      {
        label: 'Exit Dynamic Windows',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Dynamic Windows + One-Shot (v1.0.8)');
    tray.setContextMenu(contextMenu);
  } catch (err) {
    console.error('Tray setup warning:', err);
  }
}

function setupGlobalShortcuts() {
  // Ctrl+Alt+T: Toggle Island focus
  globalShortcut.register('CommandOrControl+Alt+T', () => {
    if (mainWindow) {
      mainWindow.focus();
    }
  });

  // Ctrl+Alt+1..3: Launch Preset 1..3
  [1, 2, 3].forEach(num => {
    globalShortcut.register(`CommandOrControl+Alt+${num}`, async () => {
      if (oneShotEngine) {
        const presets = oneShotEngine.getPresets();
        if (presets[num - 1]) {
          await oneShotEngine.launchPreset(presets[num - 1].id);
        }
      }
    });
  });
}

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------
app.whenReady().then(() => {
  // 1. Initialize Subsystems
  oneShotEngine = new OneShotEngine();
  mediaController = new MediaController();
  dropZone = new DropZone();
  registerSettingsIPC(dropZone, oneShotEngine);

  // 2. Google Antigravity Real-Time Monitor
  antigravityMonitor = new AntigravityMonitor();
  antigravityMonitor.on('change', () => sendAntigravityState());
  antigravityMonitor.on('task-completed', () => {
    // Audio chime or notification
  });
  antigravityMonitor.start();

  // 3. Agent Hooks Server (Claude Code / Codex)
  agentHooksServer = new AgentHooksServer();
  agentHooksServer.on('permission-requested', (prompt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('permission-prompt', prompt);
    }
  });
  agentHooksServer.start();

  // 4. Check for startup takeover argument
  const args = process.argv;
  if (args.includes('--startup-mode') || args.includes('--takeover')) {
    createStartupTakeover(oneShotEngine, () => {
      createIslandWindow();
      setupTray();
      setupGlobalShortcuts();
    });
  } else {
    createIslandWindow();
    setupTray();
    setupGlobalShortcuts();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createIslandWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (antigravityMonitor) antigravityMonitor.stop();
  if (agentHooksServer) agentHooksServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
