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
  getWorkArea: () => runHelper(['get-workarea']),
  setWorkAreaTop: (px) => runHelper(['set-workarea-top', String(px)]),
  restoreWorkArea: () => runHelper(['restore-workarea'])
};
