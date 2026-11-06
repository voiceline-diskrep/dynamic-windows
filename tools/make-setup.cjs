'use strict';
/**
 * Dynamic Windows - TwoCode-style Single-File Setup Builder
 * Stages Electron distribution, compresses to zip, and embeds into C# Setup stub.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

// 1. Build Full Electron Distribution Zip
console.log('Step 1: Staging and creating full payload zip...');
execFileSync('node', [path.join(__dirname, 'make-full.cjs')], { cwd: repo, stdio: 'inherit' });

const zipPath = path.join(repo, 'dist', `DynamicWindows-${version}.zip`);
if (!fs.existsSync(zipPath)) {
  console.error(`Payload zip ${zipPath} was not created!`);
  process.exit(1);
}

// 2. Compile C# Setup Stub with embedded resource
console.log('\nStep 2: Compiling C# Setup stub with embedded payload...');
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const fw = path.dirname(csc);
const outDir = path.join(repo, 'installer_output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const exePath = path.join(outDir, `DynamicWindows-Setup-v${version}.exe`);
const setupCs = path.join(__dirname, 'setup', 'Setup.cs');
const iconIco = path.join(repo, 'app_icon.ico');

// Ensure Setup.cs version matches package.json
let csContent = fs.readFileSync(setupCs, 'utf8');
csContent = csContent.replace(/public const string VERSION = ".*?";/, `public const string VERSION = "${version}";`);
csContent = csContent.replace(/\[assembly: AssemblyVersion\(".*?"\)\]/, `[assembly: AssemblyVersion("${version}.0")]`);
csContent = csContent.replace(/\[assembly: AssemblyFileVersion\(".*?"\)\]/, `[assembly: AssemblyFileVersion("${version}.0")]`);
fs.writeFileSync(setupCs, csContent, 'utf8');

const cscArgs = [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/platform:anycpu',
  `/out:${exePath}`,
  `/win32icon:${iconIco}`,
  `/resource:${zipPath},DynamicWindows.zip`,
  `/r:${path.join(fw, 'System.dll')}`,
  `/r:${path.join(fw, 'System.Drawing.dll')}`,
  `/r:${path.join(fw, 'System.Windows.Forms.dll')}`,
  `/r:${path.join(fw, 'System.IO.Compression.dll')}`,
  `/r:${path.join(fw, 'System.IO.Compression.FileSystem.dll')}`,
  setupCs
];

execFileSync(csc, cscArgs, { stdio: 'inherit' });

const stat = fs.statSync(exePath);
console.log(`\n✓ Single-file standalone installer successfully generated:`);
console.log(`  Path: ${exePath}`);
console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${stat.size} bytes)`);
