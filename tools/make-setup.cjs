'use strict';
/**
 * Dynamic Windows - TwoCode-style Setup Compiler
 * Compiles Setup.cs with native Windows csc.exe, zips application payload,
 * and concatenates them into a single-file executable.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SETUP_CS = path.join(__dirname, 'setup', 'Setup.cs');
const OUTPUT_DIR = path.join(ROOT_DIR, 'installer_output');
const STUB_EXE = path.join(__dirname, 'setup', 'stub.exe');
const PAYLOAD_ZIP = path.join(__dirname, 'setup', 'payload.zip');
const FINAL_EXE = path.join(OUTPUT_DIR, 'DynamicWindows-Setup-v1.0.5.exe');

const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

console.log('--- Building Dynamic Windows Single-File Installer (TwoCode-style) ---');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 1. Compile Setup.cs
console.log('Compiling C# stub with csc.exe...');
const cscCmd = `"${CSC_PATH}" /target:winexe /optimize+ /platform:anycpu /out:"${STUB_EXE}" /r:System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll "${SETUP_CS}"`;
execSync(cscCmd, { stdio: 'inherit' });

// 2. Create Application Payload Zip
console.log('Creating application payload zip...');
const filesToZip = [
  'package.json',
  'app_icon.png',
  'app_icon.ico',
  'antigravity_logo.png',
  'src'
];

// Use PowerShell Compress-Archive for reliable compression without external dependencies
const psZipCmd = `powershell -NoProfile -NonInteractive -Command "Compress-Archive -Path 'package.json','app_icon.png','app_icon.ico','antigravity_logo.png','src' -DestinationPath '${PAYLOAD_ZIP}' -Force"`;
execSync(psZipCmd, { cwd: ROOT_DIR, stdio: 'inherit' });

// 3. Concatenate stub.exe + payload.zip
console.log('Concatenating stub and payload...');
const stubBuf = fs.readFileSync(STUB_EXE);
const zipBuf = fs.readFileSync(PAYLOAD_ZIP);
const combined = Buffer.concat([stubBuf, zipBuf]);

fs.writeFileSync(FINAL_EXE, combined);
console.log(`✓ Single-file installer generated successfully:`);
console.log(`  Path: ${FINAL_EXE}`);
console.log(`  Size: ${combined.length} bytes (${(combined.length / 1024 / 1024).toFixed(2)} MB)`);

// Cleanup temporary files
try {
  fs.unlinkSync(STUB_EXE);
  fs.unlinkSync(PAYLOAD_ZIP);
} catch (e) {}
