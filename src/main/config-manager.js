'use strict';
/**
 * Dynamic Windows - Configuration Manager
 * Persists user preferences to %APPDATA%\DynamicWindows\config.json
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
  'DynamicWindows'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  version: '1.4.15',
  animationSpeed: 1.0,
  islandOpacity: 0.95, // 0.40 to 1.00 frosted glass opacity
  displayMode: 'island', // 'island' | 'notch'
  dynamicLyrics: true, // Smooth word-by-word progressive lyric reveal
  albumColorGradient: true, // Dynamic Island ambient fade gradient from album cover
  gameMode: true, // Auto-hide in full-screen games (default on)
  soundEffects: true, // Tactical Web Audio UI sound effects
  soundVolume: 0.7, // 0.05 to 1.00 volume
  startup: false,
  startupTakeover: false,
  clock24h: false,
  showSeconds: false,
  antigravityMonitor: true,
  autoFocusAntigravity: true,
  hooksPort: 47823,
  autoCheckUpdates: true,
  checkIntervalHours: 24,
  repoOwner: 'voiceline-diskrep',
  repoName: 'dynamic-windows'
};

class ConfigManager {
  constructor() {
    this.ensureDir();
    this.config = this.load();
  }

  ensureDir() {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
    } catch (e) {}
  }

  load() {
    this.ensureDir();
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Object.assign({}, DEFAULT_CONFIG, parsed);
      }
    } catch (e) {
      console.warn('Failed to load config, using defaults:', e.message);
    }
    return Object.assign({}, DEFAULT_CONFIG);
  }

  save() {
    this.ensureDir();
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('Failed to save config:', e);
      return false;
    }
  }

  get(key) {
    return key ? this.config[key] : this.config;
  }

  set(key, value) {
    if (typeof key === 'object') {
      Object.assign(this.config, key);
    } else {
      this.config[key] = value;
    }
    this.save();
    this.applySystemSettings();
    return this.config;
  }

  applySystemSettings() {
    try {
      if (app && app.setLoginItemSettings) {
        const args = this.config.startupTakeover ? ['--startup-mode'] : [];
        app.setLoginItemSettings({
          openAtLogin: !!this.config.startup,
          args: args
        });
      }
    } catch (e) {
      console.warn('Could not apply login item settings:', e.message);
    }
  }
}

module.exports = new ConfigManager();
