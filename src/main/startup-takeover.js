'use strict';
/**
 * Dynamic Windows - Startup Takeover Window
 * Full-screen launcher on Windows sign-in with preset tiles and "Just Enter" desktop bypass.
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let takeoverWindow = null;

function createStartupTakeover(oneShotEngine, onFinished) {
  if (takeoverWindow && !takeoverWindow.isDestroyed()) {
    takeoverWindow.focus();
    return takeoverWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  takeoverWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#0c0c0f',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const presets = oneShotEngine.getPresets();
  const presetsJson = JSON.stringify(presets);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>One-Shot Startup Takeover</title>
  <style>
    * { box-sizing: border-box; user-select: none; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 20%, #1a1a24 0%, #0a0a0e 100%);
      color: #f4f4f5;
      font-family: 'Segoe UI Variable Display', 'Segoe UI', -apple-system, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .top-bar {
      position: absolute;
      top: 32px;
      right: 48px;
    }
    .btn-just-enter {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #ffffff;
      padding: 10px 24px;
      border-radius: 24px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .btn-just-enter:hover {
      background: #2563eb;
      border-color: #3b82f6;
      transform: scale(1.04);
    }
    .header {
      text-align: center;
      margin-bottom: 48px;
    }
    .title {
      font-size: 38px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      background: linear-gradient(180deg, #ffffff 0%, #a1a1aa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 15px;
      color: #71717a;
    }
    .grid {
      display: flex;
      gap: 24px;
      max-width: 1000px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .card {
      background: rgba(24, 24, 30, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 24px;
      width: 240px;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      backdrop-filter: blur(20px);
    }
    .card:hover, .card.selected {
      background: rgba(37, 99, 235, 0.15);
      border-color: #3b82f6;
      transform: translateY(-4px);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
    }
    .card-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }
    .card-title {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .card-desc {
      font-size: 12px;
      color: #a1a1aa;
      line-height: 1.4;
      margin-bottom: 16px;
    }
    .card-apps {
      font-size: 11px;
      color: #38bdf8;
      font-weight: 500;
    }
    .footer-hint {
      position: absolute;
      bottom: 32px;
      color: #52525b;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <button class="btn-just-enter" onclick="exitToDesktop()">Just Enter ➔</button>
  </div>

  <div class="header">
    <div class="title">Choose Your Workspace</div>
    <div class="subtitle">Select a preset to launch your workflow, or press Enter for Windows desktop.</div>
  </div>

  <div class="grid" id="grid"></div>

  <div class="footer-hint">Press <b>Enter</b> or <b>Esc</b> to skip to Windows desktop</div>

  <script>
    const { ipcRenderer } = require('electron');
    const presets = ${presetsJson};
    const grid = document.getElementById('grid');

    presets.forEach((p, idx) => {
      const card = document.createElement('div');
      card.className = 'card' + (idx === 0 ? ' selected' : '');
      card.innerHTML = \`
        <div class="card-icon">\${p.icon || '⚡'}</div>
        <div class="card-title">\${p.name}</div>
        <div class="card-desc">\${p.description || 'One-click workspace launcher'}</div>
        <div class="card-apps">\${p.apps.length} applications</div>
      \`;
      card.onclick = () => launchPreset(p.id);
      grid.appendChild(card);
    });

    function launchPreset(id) {
      ipcRenderer.send('takeover-launch', id);
    }

    function exitToDesktop() {
      ipcRenderer.send('takeover-dismiss');
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        exitToDesktop();
      }
    });
  </script>
</body>
</html>
  `;

  takeoverWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  ipcMain.once('takeover-dismiss', () => {
    if (takeoverWindow && !takeoverWindow.isDestroyed()) {
      takeoverWindow.close();
      takeoverWindow = null;
    }
    if (onFinished) onFinished();
  });

  ipcMain.once('takeover-launch', async (event, presetId) => {
    if (takeoverWindow && !takeoverWindow.isDestroyed()) {
      takeoverWindow.close();
      takeoverWindow = null;
    }
    await oneShotEngine.launchPreset(presetId);
    if (onFinished) onFinished();
  });

  return takeoverWindow;
}

module.exports = { createStartupTakeover };
