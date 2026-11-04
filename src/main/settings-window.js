'use strict';
/**
 * Dynamic Windows - Settings Window Controller
 */

const { BrowserWindow, ipcMain, shell, app } = require('electron');
const path = require('path');
const https = require('https');
const configManager = require('./config-manager');

let settingsWindow = null;

function createSettingsWindow(dropZoneInstance) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return settingsWindow;
  }

  const iconPath = path.join(__dirname, '..', '..', 'app_icon.png');

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 580,
    minWidth: 680,
    minHeight: 500,
    title: 'Settings & Preferences — Dynamic Windows',
    backgroundColor: '#0f0f12',
    icon: iconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

// -------------------------------------------------------------
// Settings IPC Handlers
// -------------------------------------------------------------
function registerSettingsIPC(dropZoneInstance) {
  ipcMain.handle('get-app-settings', async () => {
    return {
      config: configManager.get(),
      version: app.getVersion() || '1.1.3',
      dropZonePath: dropZoneInstance ? dropZoneInstance.dir : '',
      dropZoneCount: dropZoneInstance ? dropZoneInstance.getFiles().length : 0
    };
  });

  ipcMain.handle('save-app-settings', async (event, newSettings) => {
    const updated = configManager.set(newSettings);
    if (newSettings && newSettings.displayMode) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('display-mode', newSettings.displayMode);
        }
      });
    }
    if (newSettings && 'animationSpeed' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('animation-speed', newSettings.animationSpeed);
        }
      });
    }
    if (newSettings && 'gameMode' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('game-mode-toggled', { enabled: Boolean(newSettings.gameMode) });
        }
      });
    }
    if (newSettings && 'dynamicLyrics' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('dynamic-lyrics-toggled', { enabled: Boolean(newSettings.dynamicLyrics) });
        }
      });
    }
    if (newSettings && 'reserveTopBezel' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('reserve-top-bezel-toggled', { enabled: Boolean(newSettings.reserveTopBezel) });
        }
      });
    }
    return updated;
  });

  ipcMain.handle('check-github-update', async () => {
    return new Promise((resolve) => {
      const cfg = configManager.get();
      const owner = cfg.repoOwner || 'voiceline-diskrep';
      const repo = cfg.repoName || 'dynamic-windows';
      const curVer = app.getVersion() || '1.0.7';

      const options = {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/releases/latest`,
        headers: {
          'User-Agent': 'DynamicWindows-Desktop-App'
        }
      };

      const req = https.get(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return resolve({ error: `GitHub API returned HTTP ${res.statusCode}` });
            }
            const data = JSON.parse(body);
            const tag = (data.tag_name || '').replace(/^v/, '');
            const isNewer = compareVersions(tag, curVer) > 0;
            
            // Look for windows installer asset
            let downloadUrl = data.html_url;
            if (Array.isArray(data.assets)) {
              const exeAsset = data.assets.find(a => a.name.endsWith('.exe'));
              if (exeAsset && exeAsset.browser_download_url) {
                downloadUrl = exeAsset.browser_download_url;
              }
            }

            resolve({
              updateAvailable: isNewer,
              latestVersion: tag || data.tag_name,
              currentVersion: curVer,
              releaseName: data.name || data.tag_name,
              releaseNotes: data.body || 'No release notes provided.',
              downloadUrl: downloadUrl
            });
          } catch (e) {
            resolve({ error: 'Failed to parse GitHub release data: ' + e.message });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ error: 'Network request error: ' + e.message });
      });

      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ error: 'GitHub update check timed out' });
      });
    });
  });

  ipcMain.on('open-external-url', (event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('settings-open-dropzone', () => {
    if (dropZoneInstance) {
      dropZoneInstance.revealInExplorer();
    }
  });
}

function compareVersions(v1, v2) {
  const p1 = (v1 || '0').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = (v2 || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

module.exports = {
  createSettingsWindow,
  registerSettingsIPC
};
