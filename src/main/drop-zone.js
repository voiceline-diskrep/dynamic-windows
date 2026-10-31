'use strict';
/**
 * Dynamic Windows - Drop Zone File Shelf
 * Persistent file storage in %APPDATA%\DynamicWindows\drop_zone\
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

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
    const fullPath = path.join(this.dir, name);
    if (fs.existsSync(fullPath)) {
      shell.openPath(fullPath);
    }
  }

  revealInExplorer(name) {
    const fullPath = path.join(this.dir, name);
    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
    } else {
      shell.openPath(this.dir);
    }
  }

  deleteFile(name) {
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
