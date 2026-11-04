'use strict';
/**
 * Dynamic Windows + One-Shot
 * Main Process (Electron + Node.js)
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] UncaughtException: ${err.stack || err}\n`);
  } catch (e) {}
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] UnhandledRejection: ${reason && reason.stack ? reason.stack : reason}\n`);
  } catch (e) {}
  console.error('[UNHANDLED REJECTION]', reason);
});

const AntigravityMonitor = require('./antigravity-monitor');
const AgentHooksServer = require('./agent-hooks-server');
const MediaController = require('./media-spotify');
const CallMonitor = require('./call-monitor');
const DropZone = require('./drop-zone');
const configManager = require('./config-manager');
const sysHelper = require('./sys-helper');
const { createSettingsWindow, registerSettingsIPC } = require('./settings-window');

const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const fileIconsCache = new Map();

let mainWindow = null;
function cleanupTopBezel() {
  try {
    sysHelper.restoreWorkArea();
  } catch (err) {}
}
let tray = null;
let antigravityMonitor = null;
let agentHooksServer = null;
let mediaController = null;
let callMonitor = null;
let dropZone = null;
let isQuitting = false;

let gameModeEnabled = configManager.get('gameMode') !== false;
let isFullscreenGame = false;

function applyGameModeVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (gameModeEnabled && isFullscreenGame) {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    }
  } else {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }
}

function setGameMode(enabled, source = 'ui') {
  gameModeEnabled = Boolean(enabled);
  configManager.set('gameMode', gameModeEnabled);
  applyGameModeVisibility();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game-mode-toggled', {
      enabled: gameModeEnabled,
      isFullscreen: isFullscreenGame,
      source
    });
  }
  setupTray();
}

function toggleGameMode(source = 'shortcut') {
  setGameMode(!gameModeEnabled, source);
}

let clipboardHistory = [];
let lastClipText = '';

function startClipboardMonitor() {
  setInterval(() => {
    try {
      const text = clipboard.readText();
      if (typeof text !== 'string' || !text || text === lastClipText) return;
      lastClipText = text;
      const clean = text.trim();
      if (!clean || clean.length > 50000) return;

      const existingIdx = clipboardHistory.findIndex(c => c.text === clean);
      const isPinned = existingIdx >= 0 ? clipboardHistory[existingIdx].pinned : false;

      const filtered = clipboardHistory.filter(c => c.text !== clean);
      const newItem = {
        id: 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        text: clean,
        time: Date.now(),
        pinned: isPinned
      };

      const pinned = filtered.filter(c => c.pinned);
      const unpinned = filtered.filter(c => !c.pinned);
      if (isPinned) {
        clipboardHistory = [newItem, ...pinned.filter(c => c.id !== newItem.id), ...unpinned].slice(0, 25);
      } else {
        clipboardHistory = [...pinned, newItem, ...unpinned].slice(0, 25);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard-update', clipboardHistory);
      }
    } catch (err) {}
  }, 1000).unref?.();
}

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();
try {
  const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, 'startup.log'), `[${new Date().toISOString()}] PID ${process.pid}: gotTheLock=${gotTheLock}\n`);
} catch (e) {}

if (!gotTheLock) {
  try {
    app.quit();
  } catch (e) {}
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.focus();
      try {
        mainWindow.webContents.send('untuck-island');
      } catch (err) {}
    } else {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      } catch (e) {}
      mainWindow = null;
      createIslandWindow();
    }
  });
}

function createIslandWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenBounds = primaryDisplay.bounds;

  // Initial standby dimensions (880x420 transparent click-through canvas supports Left AI + 520px Lyric Pill + Right Call Capsule without shadow clipping)
  const initialWidth = 880;
  const initialHeight = 420;

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

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    try {
      const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
      fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] did-fail-load: code=${code}, desc=${desc}\n`);
    } catch (err) {}
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    try {
      const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
      fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] render-process-gone: ${JSON.stringify(details)}\n`);
    } catch (err) {}
    if (!isQuitting) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      } catch (err) {}
      mainWindow = null;
      setTimeout(() => {
        if (!isQuitting) createIslandWindow();
      }, 500);
    }
  });

  mainWindow.on('closed', () => {
    try {
      const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
      fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] mainWindow closed\n`);
    } catch (err) {}
    mainWindow = null;
    app.exit(0);
  });

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

  ipcMain.on('media-seek', (event, ms) => {
    if (mediaController) {
      mediaController.seek(ms);
    }
  });

  ipcMain.on('get-game-mode', (event) => {
    event.returnValue = { enabled: gameModeEnabled, isFullscreen: isFullscreenGame };
  });

  ipcMain.on('set-game-mode', (event, enabled) => {
    setGameMode(enabled, 'ui');
  });

  ipcMain.on('toggle-game-mode', (event) => {
    toggleGameMode('ui');
  });

  ipcMain.on('game-mode-hide', (event, hide) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (hide && gameModeEnabled) {
      if (mainWindow.isVisible()) mainWindow.hide();
    } else {
      if (!mainWindow.isVisible()) {
        mainWindow.showInactive();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  });

  // Drop Zone Window & Shelf Actions
  ipcMain.on('open-dropzone', () => {
    if (dropZone) {
      dropZone.revealInExplorer();
    }
  });

  ipcMain.on('dropzone-get-files', (event) => {
    if (dropZone) event.returnValue = dropZone.getFiles();
  });

  ipcMain.on('dropzone-add-file', (event, filePath) => {
    if (dropZone && filePath) {
      dropZone.addFile(filePath);
      sendDropZoneFiles();
    }
  });

  ipcMain.on('dropzone-open-file', (event, fileName) => {
    if (dropZone && fileName) {
      dropZone.openFile(fileName);
    }
  });

  ipcMain.on('dropzone-delete-file', (event, fileName) => {
    if (dropZone && fileName) {
      dropZone.deleteFile(fileName);
      sendDropZoneFiles();
    }
  });

  ipcMain.on('dropzone-clear-all', () => {
    if (dropZone) {
      dropZone.clearAll();
      sendDropZoneFiles();
    }
  });

  ipcMain.on('dropzone-browse-file', async () => {
    const { dialog } = require('electron');
    if (mainWindow && !mainWindow.isDestroyed()) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Files for Drop Zone Shelf',
        properties: ['openFile', 'multiSelections']
      });
      if (!res.canceled && res.filePaths) {
        for (const fp of res.filePaths) {
          dropZone.addFile(fp);
        }
        sendDropZoneFiles();
      }
    }
  });

  // Display Mode (Dynamic Island vs Dynamic Notch)
  ipcMain.on('set-display-mode', (event, mode) => {
    if (['island', 'notch'].includes(mode)) {
      configManager.set('displayMode', mode);
      sendDisplayMode();
    sendAnimationSpeed();
    sendDynamicLyrics();
    }
  });



  // System Volume IPC (coalesced to prevent child process storms while dragging)
  ipcMain.removeHandler('get-system-volume');
  ipcMain.removeAllListeners('set-system-volume');
  ipcMain.removeAllListeners('toggle-system-mute');

  ipcMain.handle('get-system-volume', async () => {
    return await sysHelper.getVolume();
  });

  let isSettingVolume = false;
  let pendingVolumeVal = null;
  ipcMain.on('set-system-volume', async (event, val) => {
    pendingVolumeVal = val;
    if (isSettingVolume) return;
    isSettingVolume = true;
    try {
      while (pendingVolumeVal !== null) {
        const target = pendingVolumeVal;
        pendingVolumeVal = null;
        const res = await sysHelper.setVolume(target);
        if (pendingVolumeVal === null) {
          BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
              w.webContents.send('volume-update', res);
            }
          });
        }
      }
    } finally {
      isSettingVolume = false;
    }
  });

  ipcMain.on('toggle-system-mute', async () => {
    const res = await sysHelper.toggleMute();
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('volume-update', res);
      }
    });
  });

  // Native Drag Out for Drop Shelf files
  ipcMain.on('shelf-drag-start', async (event, filePath) => {
    if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) return;
    try {
      let icon = fileIconsCache.get(filePath);
      if (!icon) {
        try {
          icon = await app.getFileIcon(filePath, { size: 'normal' });
          if (icon && !icon.isEmpty()) {
            fileIconsCache.set(filePath, icon);
          }
        } catch (e) {}
      }
      if (!icon || icon.isEmpty()) {
        icon = nativeImage.createFromDataURL(BLANK_PNG);
      }
      event.sender.startDrag({ file: filePath, icon });
    } catch (err) {
      console.error('[DRAG ERROR]', err);
    }
  });

  // Media Playback Speed & Lyric Sync Offset
  ipcMain.on('media-set-speed', (event, rate) => {
    if (mediaController) {
      mediaController.setPlaybackSpeed(rate);
      sendMediaState();
    }
  });

  ipcMain.on('media-set-offset', (event, offsetMs) => {
    if (mediaController) {
      mediaController.setLyricOffset(offsetMs);
      sendMediaState();
    }
  });

  // Clipboard History Manager (last 25 items in memory)
  ipcMain.on('clipboard-get', (event) => {
    event.reply('clipboard-update', clipboardHistory);
  });

  ipcMain.on('clipboard-copy', (event, clipId) => {
    const item = clipboardHistory.find(c => c.id === clipId);
    if (item && item.text) {
      clipboard.writeText(item.text);
      lastClipText = item.text;
      item.time = Date.now();
      // Re-sort: pinned on top, then newest
      const pinned = clipboardHistory.filter(c => c.pinned);
      const unpinned = clipboardHistory.filter(c => !c.pinned);
      clipboardHistory = [...pinned, ...unpinned];
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard-update', clipboardHistory);
      }
    }
  });

  ipcMain.on('clipboard-pin', (event, clipId) => {
    const item = clipboardHistory.find(c => c.id === clipId);
    if (item) {
      item.pinned = !item.pinned;
      const pinned = clipboardHistory.filter(c => c.pinned);
      const unpinned = clipboardHistory.filter(c => !c.pinned);
      clipboardHistory = [...pinned, ...unpinned];
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard-update', clipboardHistory);
      }
    }
  });

  ipcMain.on('clipboard-clear', () => {
    clipboardHistory = clipboardHistory.filter(c => c.pinned);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-update', clipboardHistory);
    }
  });

  // Settings Window
  ipcMain.on('open-settings', () => {
    createSettingsWindow(dropZone);
  });

  ipcMain.on('set-dynamic-lyrics', (event, enabled) => {
    configManager.set('dynamicLyrics', Boolean(enabled));
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('dynamic-lyrics-toggled', { enabled: Boolean(enabled) });
      }
    });
  });

  // Call Detection & Controls IPC
  ipcMain.removeAllListeners('call-action');
  ipcMain.on('call-action', async (event, action) => {
    if (callMonitor) {
      await callMonitor.handleAction(action);
      sendCallState();
    }
  });

  // Send initial data once loaded
  mainWindow.webContents.once('did-finish-load', () => {
    sendAntigravityState();
    sendMediaState();
    sendCallState();
    sendDropZoneFiles();
    sendDisplayMode();
    sendAnimationSpeed();
    sendDynamicLyrics();
  });
}

function sendCallState() {
  if (mainWindow && !mainWindow.isDestroyed() && callMonitor) {
    mainWindow.webContents.send('call-state', callMonitor.getState());
  }
}

function sendAntigravityState() {
  if (mainWindow && !mainWindow.isDestroyed() && antigravityMonitor) {
    mainWindow.webContents.send('antigravity-state', antigravityMonitor.getState());
  }
}

function sendMediaState() {
  if (mainWindow && !mainWindow.isDestroyed() && mediaController) {
    mainWindow.webContents.send('media-state', mediaController.getState());
  }
}

function sendDropZoneFiles() {
  if (mainWindow && !mainWindow.isDestroyed() && dropZone) {
    mainWindow.webContents.send('dropzone-files', dropZone.getFiles());
  }
}

function sendAnimationSpeed() {
  const speed = configManager.get('animationSpeed') || 1.0;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('animation-speed', speed);
  }
}

function sendDisplayMode() {
  const mode = configManager.get('displayMode') || 'island';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display-mode', mode);
  }
}

function sendDynamicLyrics() {
  const enabled = configManager.get('dynamicLyrics') !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dynamic-lyrics-toggled', { enabled });
  }
}

function setupTray() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'app_icon.ico');
    if (!tray) {
      tray = new Tray(iconPath);
      tray.setToolTip('Dynamic Windows (v1.3.8)');
    }
    const contextMenu = Menu.buildFromTemplate([
      {
        label: `🎮 Game Mode (Auto-hide in games)`,
        type: 'checkbox',
        checked: gameModeEnabled,
        click: () => {
          toggleGameMode('tray');
        }
      },
      { type: 'separator' },
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
          createSettingsWindow(dropZone);
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

    tray.setContextMenu(contextMenu);
  } catch (err) {
    console.error('Tray setup warning:', err);
  }
}

function setupGlobalShortcuts() {
  // Ctrl+Shift+G: Toggle Game Mode on/off
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    toggleGameMode('shortcut');
  });

  // Ctrl+Alt+T: Toggle Island focus & untuck
  globalShortcut.register('CommandOrControl+Alt+T', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) {
        mainWindow.showInactive();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      mainWindow.focus();
      mainWindow.webContents.send('untuck-island');
    }
  });

  // Ctrl+Alt+H: Tuck / Untuck the Island away (TwoCode shortcut)
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-tuck');
    }
  });
}

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------
app.whenReady().then(() => {
  // 1. Initialize Subsystems
  mediaController = new MediaController();
  mediaController.on('changed', () => sendMediaState());
  mediaController.on('fullscreen', (isFull) => {
    isFullscreenGame = Boolean(isFull);
    applyGameModeVisibility();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-mode-changed', {
        fullscreen: isFullscreenGame,
        enabled: gameModeEnabled
      });
    }
  });
  dropZone = new DropZone();
  registerSettingsIPC(dropZone);
  startClipboardMonitor();

  // 2. Google Antigravity Real-Time Monitor
  antigravityMonitor = new AntigravityMonitor();
  antigravityMonitor.on('change', () => sendAntigravityState());
  antigravityMonitor.on('task-completed', () => {
    // Audio chime or notification
  });
  antigravityMonitor.start();

  // 2b. Universal & Discord Call Monitor
  callMonitor = new CallMonitor();
  callMonitor.on('changed', () => sendCallState());

  // 3. Agent Hooks Server & Antigravity MCP Bridge
  agentHooksServer = new AgentHooksServer();
  agentHooksServer.on('permission-requested', (prompt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('permission-prompt', prompt);
    }
  });

  agentHooksServer.on('mcp-notify', (data) => {
    if (antigravityMonitor) {
      antigravityMonitor.updateFromMcp(data);
      sendAntigravityState();
    }
  });

  agentHooksServer.on('mcp-shelf-file', (data) => {
    if (dropZone && data.path) {
      dropZone.addFile(data.path);
      sendDropZoneFiles();
    }
  });

  agentHooksServer.on('mcp-set-mode', (data) => {
    if (data.mode && ['island', 'notch'].includes(data.mode)) {
      configManager.set('displayMode', data.mode);
      sendDisplayMode();
    sendAnimationSpeed();
    }
  });

  agentHooksServer.stateGetter = () => {
    return {
      status: antigravityMonitor ? antigravityMonitor.getState().status : 'idle',
      displayMode: configManager.get('displayMode'),
      shelfFiles: dropZone ? dropZone.getFiles() : []
    };
  };

  agentHooksServer.start();

  createIslandWindow();
  cleanupTopBezel();
  setupTray();
  setupGlobalShortcuts();

  // Periodically stream media & lyrics updates to Island
  setInterval(() => {
    sendMediaState();
  }, 1500).unref?.();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createIslandWindow();
    }
  });
});

app.on('before-quit', (e) => {
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] app.before-quit fired\n`);
  } catch (err) {}
  isQuitting = true;
});

app.on('will-quit', () => {
  try { sysHelper.restoreWorkArea(); } catch (e) {}
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] app.will-quit fired\n`);
  } catch (err) {}
  globalShortcut.unregisterAll();
  if (mediaController) mediaController.destroy();
  if (antigravityMonitor) antigravityMonitor.stop();
  if (callMonitor) callMonitor.stop();
  if (agentHooksServer) agentHooksServer.stop();
});

app.on('window-all-closed', () => {
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] app.window-all-closed fired\n`);
  } catch (err) {}
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
