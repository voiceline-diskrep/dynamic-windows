// Universal IPC Adapter for Dynamic Windows (Electron & Tauri 2.0 dual support)
(function() {
  'use strict';

  if (typeof window.require === 'function') {
    try {
      const electron = window.require('electron');
      if (electron && electron.ipcRenderer) {
        window.ipcRenderer = electron.ipcRenderer;
        window.webUtils = electron.webUtils || { getPathForFile: (f) => f?.path || f?.name || '' };
        return;
      }
    } catch (e) {}
  }

  // Tauri 2.0 Native IPC Bridge
  const listeners = new Map();

  const getTauri = () => {
    return window.__TAURI__ || (window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__ : null);
  };

  const shim = {
    send(channel, ...args) {
      const tauri = getTauri();
      if (tauri && tauri.core) {
        tauri.core.invoke('ipc_send', { channel: channel, payload: args }).catch(() => {});
      } else if (tauri && tauri.event) {
        tauri.event.emit(channel, args.length === 1 ? args[0] : args).catch(() => {});
      }
    },
    invoke(channel, ...args) {
      const tauri = getTauri();
      if (tauri && tauri.core) {
        return tauri.core.invoke('ipc_invoke', { channel: channel, payload: args.length === 1 ? args[0] : args });
      }
      return Promise.resolve(null);
    },
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(callback);

      const tauri = getTauri();
      if (tauri && tauri.event) {
        tauri.event.listen(channel, (event) => {
          callback(event, event.payload);
        }).catch(() => {});
      }
    },
    removeListener(channel, callback) {
      const list = listeners.get(channel);
      if (list) {
        const idx = list.indexOf(callback);
        if (idx !== -1) list.splice(idx, 1);
      }
    }
  };

  window.ipcRenderer = shim;
  window.webUtils = { getPathForFile: (f) => f?.path || f?.name || '' };

  // Polyfill require for files that still invoke require('electron')
  if (typeof window.require !== 'function') {
    window.require = function(mod) {
      if (mod === 'electron') {
        return { ipcRenderer: window.ipcRenderer, webUtils: window.webUtils };
      }
      if (mod === 'fs' || mod === 'path') {
        return {
          existsSync: () => false,
          mkdirSync: () => {},
          appendFileSync: () => {},
          join: (...args) => args.join('/')
        };
      }
      throw new Error(`Module '${mod}' not available in Tauri webview`);
    };
  }
})();
