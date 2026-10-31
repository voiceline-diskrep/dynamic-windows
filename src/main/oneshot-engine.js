'use strict';
/**
 * Dynamic Windows - One-Shot Engine
 * Manages Start Menu & Registry app discovery, preset configuration, and async launching.
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const APPDATA_DIR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'), 'DynamicWindows');
const PRESETS_FILE = path.join(APPDATA_DIR, 'presets.json');

const DEFAULT_PRESETS = [
  {
    id: 'preset_gaming',
    name: 'Gaming',
    description: 'Launch game launchers and voice chat',
    icon: '🎮',
    apps: [
      { name: 'Discord', path: 'discord.exe', args: '', delay_seconds: 0 },
      { name: 'Steam', path: 'steam.exe', args: '', delay_seconds: 2 }
    ]
  },
  {
    id: 'preset_work',
    name: 'Work & Code',
    description: 'Antigravity, terminal, browser and audio',
    icon: '💻',
    apps: [
      { name: 'Google Antigravity', path: path.join(process.env.LOCALAPPDATA || 'C:\\', 'Programs', 'antigravity', 'Antigravity.exe'), args: '', delay_seconds: 0 },
      { name: 'Google Chrome', path: 'chrome.exe', args: '', delay_seconds: 1 }
    ]
  },
  {
    id: 'preset_focus',
    name: 'Deep Focus',
    description: 'Minimalist study and writing setup',
    icon: '🎯',
    apps: [
      { name: 'Notepad', path: 'notepad.exe', args: '', delay_seconds: 0 }
    ]
  }
];

class OneShotEngine {
  constructor() {
    this.ensureDirs();
    this.presets = this.loadPresets();
    this.discoveredApps = [];
  }

  ensureDirs() {
    try {
      if (!fs.existsSync(APPDATA_DIR)) {
        fs.mkdirSync(APPDATA_DIR, { recursive: true });
      }
    } catch (e) {}
  }

  loadPresets() {
    try {
      if (fs.existsSync(PRESETS_FILE)) {
        const raw = fs.readFileSync(PRESETS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    this.savePresets(DEFAULT_PRESETS);
    return DEFAULT_PRESETS;
  }

  savePresets(presets) {
    try {
      this.ensureDirs();
      fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf-8');
      this.presets = presets;
    } catch (e) {}
  }

  getPresets() {
    return this.presets;
  }

  addPreset(name, description, icon, apps = []) {
    const newPreset = {
      id: `preset_${Date.now()}`,
      name: name || 'New Preset',
      description: description || '',
      icon: icon || '⚡',
      apps
    };
    this.presets.push(newPreset);
    this.savePresets(this.presets);
    return newPreset;
  }

  updatePreset(id, updatedData) {
    const idx = this.presets.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.presets[idx] = { ...this.presets[idx], ...updatedData };
      this.savePresets(this.presets);
      return this.presets[idx];
    }
    return null;
  }

  deletePreset(id) {
    this.presets = this.presets.filter(p => p.id !== id);
    this.savePresets(this.presets);
  }

  async launchPreset(presetOrId) {
    const preset = typeof presetOrId === 'string'
      ? this.presets.find(p => p.id === presetOrId)
      : presetOrId;

    if (!preset || !preset.apps || preset.apps.length === 0) {
      return { success: false, message: 'No applications in preset' };
    }

    const results = [];
    for (const app of preset.apps) {
      if (app.delay_seconds && app.delay_seconds > 0) {
        await new Promise(resolve => setTimeout(resolve, app.delay_seconds * 1000));
      }
      const ok = this.launchApp(app.path, app.args);
      results.push({ name: app.name, path: app.path, success: ok });
    }
    return { success: true, results };
  }

  launchApp(appPath, argsStr = '') {
    if (!appPath) return false;
    try {
      const args = argsStr ? argsStr.split(' ').filter(Boolean) : [];
      const child = spawn(appPath, args, {
        detached: true,
        stdio: 'ignore',
        shell: true
      });
      child.unref();
      return true;
    } catch (err) {
      console.warn(`[OneShotEngine] Failed to launch ${appPath}:`, err.message);
      return false;
    }
  }

  discoverInstalledApps() {
    // Return cached apps if already scanned
    if (this.discoveredApps.length > 0) return this.discoveredApps;

    const results = new Map();
    const roots = [
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ];

    const scanDir = (dir) => {
      try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.name.endsWith('.lnk')) {
            const baseName = entry.name.replace(/\.lnk$/i, '');
            if (!/uninstall|remove|help|documentation/i.test(baseName)) {
              results.set(baseName.toLowerCase(), {
                name: baseName,
                executable_path: fullPath
              });
            }
          }
        }
      } catch (e) {}
    };

    roots.forEach(scanDir);
    this.discoveredApps = Array.from(results.values());
    return this.discoveredApps;
  }
}

module.exports = OneShotEngine;
