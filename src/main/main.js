'use strict';
/**
 * Dynamic Windows + One-Shot
 * Main Process (Electron + Node.js)
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu } = require('electron');
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
const DropZone = require('./drop-zone');
const configManager = require('./config-manager');
const { createSettingsWindow, registerSettingsIPC } = require('./settings-window');

let mainWindow = null;
let tray = null;
let antigravityMonitor = null;
let agentHooksServer = null;
let mediaController = null;
let dropZone = null;
let isQuitting = false;

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();
try {
  const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, 'startup.log'), `[${new Date().toISOString()}] PID ${process.pid}: gotTheLock=${gotTheLock}\n`);
} catch (e) {}

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
  const initialHeight = 360; // Expanded height container for spacious shelf and multi-project stack

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
  });

  mainWindow.on('closed', () => {
    try {
      const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
      fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] mainWindow closed\n`);
    } catch (err) {}
    mainWindow = null;
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
    }
  });

  // Settings Window
  ipcMain.on('open-settings', () => {
    createSettingsWindow(dropZone);
  });

  // Send initial data once loaded
  mainWindow.webContents.once('did-finish-load', () => {
    sendAntigravityState();
    sendMediaState();
    sendDropZoneFiles();
    sendDisplayMode();
  });
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

function sendDisplayMode() {
  const mode = configManager.get('displayMode') || 'island';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display-mode', mode);
  }
}

function setupTray() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'app_icon.ico');
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

    tray.setToolTip('Dynamic Windows (v1.1.4)');
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
}

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------
app.whenReady().then(() => {
  // 1. Initialize Subsystems
  mediaController = new MediaController();
  dropZone = new DropZone();
  registerSettingsIPC(dropZone);

  // 2. Google Antigravity Real-Time Monitor
  antigravityMonitor = new AntigravityMonitor();
  antigravityMonitor.on('change', () => sendAntigravityState());
  antigravityMonitor.on('task-completed', () => {
    // Audio chime or notification
  });
  antigravityMonitor.start();

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
  setupTray();
  setupGlobalShortcuts();

  // Periodically stream media & lyrics updates to Island
  setInterval(() => {
    sendMediaState();
  }, 1500);

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
  try {
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    fs.appendFileSync(path.join(logDir, 'server.log'), `[${new Date().toISOString()}] app.will-quit fired\n`);
  } catch (err) {}
  globalShortcut.unregisterAll();
  if (antigravityMonitor) antigravityMonitor.stop();
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
