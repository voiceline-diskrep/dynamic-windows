'use strict';
const path = require('path');
const { execFile } = require('child_process');

const HELPER_EXE = path.join(__dirname, '..', 'bin', 'sys-helper.exe');

function runHelper(args) {
  if (process.platform === 'darwin') {
    const cmd = args[0] || '';
    if (cmd === 'get-volume' || cmd === 'get-media-volume') {
      return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-e', 'output volume of (get volume settings) & "," & output muted of (get volume settings)'], (err, stdout) => {
          if (err) return resolve({ volume: 0.5, muted: false });
          const parts = stdout.trim().split(',');
          resolve({
            volume: (parseInt(parts[0], 10) || 50) / 100,
            muted: parts[1] === 'true'
          });
        });
      });
    }
    if (cmd === 'set-volume' || cmd === 'set-media-volume') {
      const vol = Math.max(0, Math.min(100, Math.round(parseFloat(args[1] || '0.5') * 100)));
      return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-e', `set volume output volume ${vol}`], () => {
          resolve({ ok: true, volume: parseFloat(args[1] || '0.5') });
        });
      });
    }
    if (cmd === 'toggle-mute' || cmd === 'toggle-media-mute') {
      return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-e', 'set volume output muted (not (output muted of (get volume settings)))'], () => {
          resolve({ ok: true });
        });
      });
    }
    if (cmd === 'focus-process') {
      const proc = args[1] || 'Music';
      return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-e', `tell application "${proc}" to activate`], () => {
          resolve({ ok: true });
        });
      });
    }
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    execFile(HELPER_EXE, args, { windowsHide: true }, (err, stdout) => {
      if (err) {
        return resolve({ error: err.message });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        resolve({ error: 'Invalid JSON response', raw: stdout });
      }
    });
  });
}

module.exports = {
  getVolume: () => runHelper(['get-volume']),
  setVolume: (scalar) => runHelper(['set-volume', String(scalar)]),
  toggleMute: () => runHelper(['toggle-mute']),
  getMediaVolume: (target) => runHelper(['get-media-volume', target ? String(target) : '']),
  setMediaVolume: (scalar, target) => runHelper(['set-media-volume', String(scalar), target ? String(target) : '']),
  toggleMediaMute: (target) => runHelper(['toggle-media-mute', target ? String(target) : '']),
  setMediaMute: (muted, target) => runHelper(['set-media-mute', muted ? '1' : '0', target ? String(target) : '']),
  getCallAudio: () => runHelper(['get-call-audio']),
  toggleMicMute: () => runHelper(['toggle-mic-mute']),
  setMicMute: (muted) => runHelper(['set-mic-mute', muted ? '1' : '0']),
  focusProcess: (procName) => runHelper(['focus-process', String(procName)]),
  getWorkArea: () => runHelper(['get-workarea']),
  setWorkAreaTop: (px) => runHelper(['set-workarea-top', String(px)]),
  restoreWorkArea: () => runHelper(['restore-workarea'])
};
