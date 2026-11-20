'use strict';
/**
 * Dynamic Windows - Native Rust / WebView2 Electron Compatibility Bridge
 * Activates ONLY when running inside the Rust WebView2 shell (where window.require is absent).
 * Zero effect when running inside Electron or Node unit tests.
 */
(function initRustBridge() {
  if (typeof window === 'undefined') return;
  if (typeof window.require === 'function') return;

  window.__DW_RUST__ = true;
  if (typeof window.process === 'undefined') {
    window.process = { env: {}, platform: 'win32' };
  }

  const listeners = new Map(); // channel -> Set<fn>
  const pending = new Map();   // id -> { resolve, reject }
  let nextReqId = 1;

  function postToHost(msg) {
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  const ipcRenderer = {
    on(channel, fn) {
      if (typeof fn !== 'function') return ipcRenderer;
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(fn);
      return ipcRenderer;
    },
    once(channel, fn) {
      if (typeof fn !== 'function') return ipcRenderer;
      const wrapper = (event, ...args) => {
        ipcRenderer.removeListener(channel, wrapper);
        fn(event, ...args);
      };
      return ipcRenderer.on(channel, wrapper);
    },
    removeListener(channel, fn) {
      const set = listeners.get(channel);
      if (set) set.delete(fn);
      return ipcRenderer;
    },
    removeAllListeners(channel) {
      if (channel) listeners.delete(channel);
      else listeners.clear();
      return ipcRenderer;
    },
    send(channel, ...args) {
      postToHost({ kind: 'send', channel, args });
    },
    invoke(channel, ...args) {
      return new Promise((resolve, reject) => {
        const id = nextReqId++;
        pending.set(id, { resolve, reject });
        postToHost({ kind: 'invoke', id, channel, args });
      });
    },
    sendSync(channel) {
      const init = window.__DW_INIT_STATE__ || {};
      if (channel === 'get-game-mode') {
        return init.gameMode || { enabled: true, isFullscreen: false };
      }
      if (channel === 'dropzone-get-files') {
        return Array.isArray(init.dropzoneFiles) ? init.dropzoneFiles : [];
      }
      return null;
    }
  };

  window.__dwDispatch = function dwDispatch(channel, payload) {
    if (!window.__DW_INIT_STATE__) window.__DW_INIT_STATE__ = {};
    if (channel === 'game-mode-toggled' && payload) {
      window.__DW_INIT_STATE__.gameMode = {
        enabled: Boolean(payload.enabled),
        isFullscreen: Boolean(payload.isFullscreen)
      };
    } else if (channel === 'game-mode-changed' && payload) {
      window.__DW_INIT_STATE__.gameMode = {
        enabled: Boolean(payload.enabled),
        isFullscreen: Boolean(payload.fullscreen)
      };
    } else if (channel === 'dropzone-files' && Array.isArray(payload)) {
      window.__DW_INIT_STATE__.dropzoneFiles = payload;
    }

    const set = listeners.get(channel);
    if (!set || set.size === 0) return;
    const fakeEvent = { sender: ipcRenderer };
    for (const fn of Array.from(set)) {
      try {
        fn(fakeEvent, payload);
      } catch (err) {
        try {
          ipcRenderer.send('log-renderer-error', `[IPC ${channel}] ${err && err.stack ? err.stack : err}`);
        } catch (_) {}
      }
    }
  };

  window.__dwResolve = function dwResolve(id, ok, payload) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(new Error(typeof payload === 'string' ? payload : 'IPC invoke failed'));
  };

  // Native Win32 forwarded cursor tracking while click-through (WS_EX_TRANSPARENT) is enabled
  window.__dwForwardMouse = function dwForwardMouse(clientX, clientY) {
    const target = document.getElementById('canvas') || document.body;
    if (!target) return;
    const ev = new MouseEvent('mousemove', {
      clientX: Number(clientX) || 0,
      clientY: Number(clientY) || 0,
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(ev);
  };

  window.__dwForwardMouseLeave = function dwForwardMouseLeave() {
    const target = document.getElementById('canvas');
    if (target) {
      target.dispatchEvent(new MouseEvent('mousemove', {
        clientX: -1000,
        clientY: -1000,
        bubbles: true,
        cancelable: true
      }));
      target.dispatchEvent(new MouseEvent('mouseleave', {
        clientX: -1000,
        clientY: -1000,
        bubbles: false,
        cancelable: false
      }));
    }
  };

  // Native wry drag-drop forwarding for Dual-Zone Drop Shelf
  window.__dwDragOver = function dwDragOver(clientX, clientY) {
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clientX', { value: Number(clientX) || 0 });
    Object.defineProperty(ev, 'clientY', { value: Number(clientY) || 0 });
    window.dispatchEvent(ev);
  };

  window.__dwDragLeave = function dwDragLeave() {
    const ev = new Event('dragleave', { bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
  };

  window.__dwDropDone = function dwDropDone() {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clientX', { value: 0 });
    Object.defineProperty(ev, 'dataTransfer', { value: null });
    window.dispatchEvent(ev);
  };

  // Synchronous CommonJS loader over same-origin custom protocol (dw://localhost)
  const cjsCache = new Map();
  const fsStub = {
    existsSync: () => true,
    mkdirSync: () => {},
    appendFileSync: (_p, msg) => {
      ipcRenderer.send('log-renderer-error', String(msg || ''));
    }
  };
  const pathStub = {
    join: (...parts) => parts.filter(Boolean).join('\\')
  };
  const electronStub = {
    ipcRenderer,
    webUtils: {
      getPathForFile: (f) => (f && typeof f.path === 'string' ? f.path : null)
    }
  };

  window.require = function rustRequire(modName) {
    if (modName === 'electron') return electronStub;
    if (modName === 'fs') return fsStub;
    if (modName === 'path') return pathStub;

    if (typeof modName === 'string' && modName.startsWith('./')) {
      const url = modName.endsWith('.js') ? modName : `${modName}.js`;
      if (cjsCache.has(url)) return cjsCache.get(url);

      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText)) {
        const mod = { exports: {} };
        cjsCache.set(url, mod.exports);
        const factory = new Function('module', 'exports', 'require', xhr.responseText);
        factory(mod, mod.exports, window.require);
        cjsCache.set(url, mod.exports);
        return mod.exports;
      }
      throw new Error(`rust-bridge: failed to load module ${url} (status ${xhr.status})`);
    }
    throw new Error(`rust-bridge: unsupported module ${modName}`);
  };

  window.addEventListener('load', () => {
    ipcRenderer.send('__dw-renderer-ready');
  });
})();
