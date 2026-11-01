'use strict';
/**
 * Dynamic Windows - Drop Zone File Shelf
 * Persistent file storage in %APPDATA%\DynamicWindows\drop_zone\
 */

const fs = require('fs');
const path = require('path');
let electronShell = null;
try {
  electronShell = require('electron').shell;
} catch (e) {}

const DROP_DIR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'), 'DynamicWindows', 'drop_zone');

class DropZone {
  constructor() {
    this.dir = DROP_DIR;
    this.ensureDir();
  }

  ensureDir() {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
    } catch (e) {}
  }

  getFiles() {
    this.ensureDir();
    try {
      const entries = fs.readdirSync(this.dir);
      return entries.map(name => {
        const fullPath = path.join(this.dir, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          path: fullPath,
          size: stat.size,
          mtime: stat.mtimeMs,
          isDirectory: stat.isDirectory()
        };
      });
    } catch (e) {
      return [];
    }
  }

  addFile(srcPath) {
    this.ensureDir();
    try {
      if (!srcPath || typeof srcPath !== 'string' || !fs.existsSync(srcPath)) return false;
      const baseName = path.basename(srcPath);
      const destPath = path.join(this.dir, baseName);
      if (path.resolve(srcPath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
        return true;
      }
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      return true;
    } catch (e) {
      console.error('DropZone addFile error:', e);
      return false;
    }
  }

  openFile(target) {
    this.ensureDir();
    if (!electronShell) return;
    try {
      if (target && typeof target === 'string') {
        const fullPath = path.isAbsolute(target) ? target : path.join(this.dir, target);
        if (fs.existsSync(fullPath)) {
          electronShell.openPath(fullPath).then(errMsg => {
            if (errMsg) {
              electronShell.showItemInFolder(fullPath);
            }
          }).catch(() => {
            electronShell.showItemInFolder(fullPath);
          });
          return;
        }
      }
      electronShell.openPath(this.dir);
    } catch (e) {
      console.error('DropZone openFile error:', e);
    }
  }

  revealInExplorer(target) {
    this.ensureDir();
    if (!electronShell) return;
    try {
      if (target && typeof target === 'string') {
        const fullPath = path.isAbsolute(target) ? target : path.join(this.dir, target);
        if (fs.existsSync(fullPath)) {
          electronShell.showItemInFolder(fullPath);
          return;
        }
      }
      electronShell.openPath(this.dir);
    } catch (e) {
      console.error('DropZone revealInExplorer error:', e);
    }
  }

  deleteFile(target) {
    if (!target || typeof target !== 'string') return false;
    try {
      const fullPath = path.isAbsolute(target) ? target : path.join(this.dir, target);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
        return true;
      }
    } catch (e) {
      console.error('DropZone deleteFile error:', e);
    }
    return false;
  }

  clearAll() {
    this.ensureDir();
    try {
      const entries = fs.readdirSync(this.dir);
      for (const name of entries) {
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch (e) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = DropZone;
