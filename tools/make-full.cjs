'use strict';
/**
 * Dynamic Windows - Native Rust Distribution Staging & Zip Packager
 * Compiles src-rust (release), bundles DynamicWindows.exe + WebView2Loader.dll + icons,
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
const rustDir = path.join(repo, 'src-rust');

console.log(`--- Building Native Rust Distribution (v${version}) ---`);

// Sync Cargo.toml version with package.json
const cargoTomlPath = path.join(rustDir, 'Cargo.toml');
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
cargoToml = cargoToml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
fs.writeFileSync(cargoTomlPath, cargoToml, 'utf8');

// 1. Compile Rust release binary
console.log('Step 1: Compiling Rust release binary (cargo build --release)...');
execFileSync('cargo', ['build', '--release'], { cwd: rustDir, stdio: 'inherit' });

const builtExe = path.join(rustDir, 'target', 'release', 'dynamic-windows.exe');
if (!fs.existsSync(builtExe)) {
  console.error(`Rust release binary not found at ${builtExe}`);
  process.exit(1);
}

// 2. Stage clean distribution directory
if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(top, { recursive: true });

fs.copyFileSync(builtExe, path.join(top, 'DynamicWindows.exe'));

const dllSrc = path.join(rustDir, 'vendor', 'WebView2Loader.dll');
if (!fs.existsSync(dllSrc)) {
  console.error(`WebView2Loader.dll not found at ${dllSrc}`);
  process.exit(1);
}
fs.copyFileSync(dllSrc, path.join(top, 'WebView2Loader.dll'));

['app_icon.ico', 'app_icon.png'].forEach(f => {
  const src = path.join(repo, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(top, f));
  }
});

// 3. Create Zip Archive via Windows native tar.exe
const zipPath = path.join(dist, `DynamicWindows-${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

console.log(`Creating payload archive ${zipPath}...`);
const tarExe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tarExe, ['-a', '-c', '-f', zipPath, '-C', stage, 'DynamicWindows'], { stdio: 'inherit' });

const stat = fs.statSync(zipPath);
console.log(`Native Rust zip ready: ${(stat.size / 1024 / 1024).toFixed(2)} MB (${stat.size} bytes)`);
