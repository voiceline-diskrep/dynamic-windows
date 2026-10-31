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
      if (!fs.existsSync(srcPath)) return false;
      const baseName = path.basename(srcPath);
      const destPath = path.join(this.dir, baseName);
      fs.copyFileSync(srcPath, destPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  openFile(name) {
    if (!name || typeof name !== 'string' || !electronShell) return;
    const fullPath = path.join(this.dir, name);
    if (fs.existsSync(fullPath)) {
      electronShell.openPath(fullPath);
    }
  }

  revealInExplorer(name) {
    this.ensureDir();
    if (!electronShell) return;
    if (name && typeof name === 'string') {
      const fullPath = path.join(this.dir, name);
      if (fs.existsSync(fullPath)) {
        electronShell.showItemInFolder(fullPath);
        return;
      }
    }
    electronShell.openPath(this.dir);
  }

  deleteFile(name) {
    if (!name || typeof name !== 'string') return false;
    const fullPath = path.join(this.dir, name);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        return true;
      }
    } catch (e) {}
    return false;
  }
}

module.exports = DropZone;
