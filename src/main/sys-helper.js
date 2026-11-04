'use strict';
const path = require('path');
const { execFile } = require('child_process');

const HELPER_EXE = path.join(__dirname, '..', 'bin', 'sys-helper.exe');

function runHelper(args) {
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
