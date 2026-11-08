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
function getAppVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    if (pkg && pkg.version) return pkg.version;
  } catch (e) {}
  const v = app.getVersion();
  if (v && v !== '0.0.0' && !v.startsWith('33.') && !v.startsWith('32.')) return v;
  return configManager.get('version') || '1.4.9';
}

function checkForGitHubUpdate() {
  return new Promise((resolve) => {
    const cfg = configManager.get();
    const owner = cfg.repoOwner || 'voiceline-diskrep';
    const repo = cfg.repoName || 'dynamic-windows';
    const curVer = getAppVersion();

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
        if (res.statusCode === 200) {
          try {
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

            return resolve({
              updateAvailable: isNewer,
              latestVersion: tag || data.tag_name,
              currentVersion: curVer,
              releaseName: data.name || data.tag_name,
              releaseNotes: data.body || 'No release notes provided.',
              downloadUrl: downloadUrl
            });
          } catch (e) {
            fallbackRedirect();
          }
        } else {
          fallbackRedirect();
        }
      });
    });

    req.on('error', () => fallbackRedirect());

    req.setTimeout(6000, () => {
      req.destroy();
      fallbackRedirect();
    });

    function fallbackRedirect() {
      https.get(`https://github.com/${owner}/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'DynamicWindows-Desktop-App' }
      }, (res) => {
        const loc = res.headers.location || '';
        const match = loc.match(/\/tag\/v?([0-9.]+)/i);
        if (match && match[1]) {
          const tag = match[1];
          const isNewer = compareVersions(tag, curVer) > 0;
          return resolve({
            updateAvailable: isNewer,
            latestVersion: tag,
            currentVersion: curVer,
            releaseName: `Dynamic Windows v${tag}`,
            releaseNotes: `Visit GitHub for release details: ${loc}`,
            downloadUrl: `https://github.com/${owner}/${repo}/releases/download/v${tag}/DynamicWindows-Setup-v${tag}.exe`
          });
        }
        resolve({ error: 'Could not determine latest release version.' });
      }).on('error', (e) => {
        resolve({ error: 'Update check failed: ' + e.message });
      });
    }
  });
}

function registerSettingsIPC(dropZoneInstance) {
  ipcMain.handle('get-app-settings', async () => {
    return {
      config: configManager.get(),
      version: getAppVersion(),
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
    if (newSettings && 'albumColorGradient' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('album-color-gradient-toggled', { enabled: Boolean(newSettings.albumColorGradient) });
        }
      });
    }
    if (newSettings && 'islandOpacity' in newSettings) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('island-opacity-changed', { opacity: Number(newSettings.islandOpacity) });
        }
      });
    }
    if (newSettings && ('soundEffects' in newSettings || 'soundVolume' in newSettings || 'soundPreset' in newSettings)) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('sound-effects-config', {
            enabled: configManager.get('soundEffects') !== false,
            volume: typeof configManager.get('soundVolume') === 'number' ? configManager.get('soundVolume') : 0.7,
            preset: configManager.get('soundPreset') || 'modern'
          });
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
    return checkForGitHubUpdate();
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
  registerSettingsIPC,
  checkForGitHubUpdate
};
