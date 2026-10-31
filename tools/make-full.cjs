'use strict';
/**
 * Dynamic Windows - Full App Staging & Zip Packager
 * Copies Electron binary, renames to DynamicWindows.exe, bundles app in resources/app,
 * and creates dist/DynamicWindows-<version>.zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const dist = path.join(repo, 'dist');
const stage = path.join(dist, 'full-stage');
const top = path.join(stage, 'DynamicWindows');

console.log(`--- Staging Full Electron Distribution (v${version}) ---`);

if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(top, { recursive: true });

// 1. Copy Electron Runtime
const electronDist = path.join(repo, 'node_modules', 'electron', 'dist');
console.log(`Copying Electron runtime from ${electronDist}...`);
fs.cpSync(electronDist, top, { recursive: true });

// 2. Rename electron.exe -> DynamicWindows.exe
console.log('Renaming electron.exe -> DynamicWindows.exe...');
const electronExe = path.join(top, 'electron.exe');
const targetExe = path.join(top, 'DynamicWindows.exe');
if (fs.existsSync(electronExe)) {
  fs.renameSync(electronExe, targetExe);
}

// 3. Remove default demo app
const defaultApp = path.join(top, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) {
  fs.rmSync(defaultApp, { force: true });
}

// 4. Copy app files into resources/app
console.log('Bundling application files into resources/app...');
const appDir = path.join(top, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

// Copy package.json, icons, logos
['package.json', 'app_icon.png', 'app_icon.ico', 'antigravity_logo.png'].forEach(f => {
  const src = path.join(repo, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(appDir, f));
  }
});

// Copy src directory recursively
fs.cpSync(path.join(repo, 'src'), path.join(appDir, 'src'), { recursive: true });

// 5. Create Zip Archive via Windows native tar.exe
const zipPath = path.join(dist, `DynamicWindows-${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

console.log(`Creating payload archive ${zipPath}...`);
const tarExe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tarExe, ['-a', '-c', '-f', zipPath, '-C', stage, 'DynamicWindows'], { stdio: 'inherit' });

const stat = fs.statSync(zipPath);
console.log(`✓ Full distribution zip ready: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
