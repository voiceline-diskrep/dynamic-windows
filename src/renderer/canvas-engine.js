// Global unhandled error logging
window.addEventListener('error', (e) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'renderer_error.log'), `[${new Date().toISOString()}] ${e.message} at ${e.filename}:${e.lineno}:\n${e.error ? e.error.stack : ''}\n`);
  } catch (err) {}
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'renderer_error.log'), `[${new Date().toISOString()}] unhandled rejection: ${e.reason}\n`);
  } catch (err) {}
});

'use strict';

const { ipcRenderer, webUtils } = require('electron');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// TwoCode-inspired Island Dimensions & Constants
const UI = {
  REST_W: 124,
  BAR_H: 32,
  ACTIVE_REST_W: 226,
  ACTIVE_BAR_H: 36,

  EXPANDED_W: 550,
  HOME_H: 154,
  AGENT_H: 196,
  MEDIA_H: 220,
  DROPZONE_H: 260,
  CLIPBOARD_H: 290,
  PROMPT_H: 150,

  COMPACT_RADIUS: 16,
  EXPANDED_RADIUS: 28,

  LEAVE_DELAY: 260
};

// State
let displayMode = 'island'; // 'island' | 'notch'
let animProgress = 0.0; // 0.0 = resting, 1.0 = expanded
let animSpeedMultiplier = 1.0; // User-controlled opening/closing speed multiplier
let targetProgress = 0.0;
let isHovered = false;
let currentView = 'home'; // 'home' | 'agent' | 'media' | 'dropzone' | 'clipboard' | 'prompt'
let leaveTimer = null;
let dropZoneFiles = [];
let isDraggingOver = false;

let clipboardHistory = [];
let clipboardFilter = '';
let copiedFeedbackId = null;
let copiedFeedbackTimer = null;
let shelfDragCandidate = null;
let currentRestingWidth = UI.REST_W;

let antigravityState = {
  status: 'idle', // 'idle' | 'running' | 'thinking' | 'waiting' | 'done' | 'error'
  provider: 'Google Antigravity',
  phase: 'Ready',
  task: '',
  tool: '',
  file: '',
  command: '',
  progress: 0
};

let mediaState = {
  isPlaying: false,
  progress_ms: 0,
  duration_ms: 0,
  track: {
    id: '',
    title: 'No media playing',
    artist: 'Open Liner, Spotify, or Media Player',
    source: 'none',
    album: '',
    image_url: '',
    lyrics: [],
    timedLyrics: [],
    currentLyric: ''
  }
};
let mediaSyncAt = performance.now();
let pendingPrompt = null; // { id, agent, command, file, message }

// -------------------------------------------------------------
// TwoCode Album Cover & Dominant Color Extraction
// -------------------------------------------------------------
const albumImage = new Image();
let albumImageForUrl = '';
let albumAccentColor = '#22c55e';
let tintK = 0;

function updateAlbumArt(url) {
  if (!url) {
    albumImageForUrl = '';
    albumAccentColor = '#22c55e';
    return;
  }
  if (url === albumImageForUrl) return;
  albumImageForUrl = url;
  albumImage.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      const x = c.getContext('2d');
      x.drawImage(albumImage, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        const w = 1 + sat / 16;
        r += d[i] * w;
        g += d[i + 1] * w;
        b += d[i + 2] * w;
        n += w;
      }
      r /= n; g /= n; b /= n;
      const boost = 210 / Math.max(60, Math.max(r, g, b));
      albumAccentColor = `rgb(${[r, g, b].map(v => Math.min(255, Math.round(v * boost))).join(',')})`;
    } catch {
      albumAccentColor = '#22c55e';
    }
  };
  albumImage.src = url;
}

function colorWithAlpha(c, a) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  const hex = String(c || '#22c55e').replace('#', '').slice(0, 6);
  const n = parseInt(hex, 16) || 0x22c55e;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// -------------------------------------------------------------
// TwoCode Synced Lyrics Engine (250ms lead, 420ms roll, 2500ms hold)
// -------------------------------------------------------------
const LYRIC_LEAD_MS = 250;
const LYRIC_SWAP_MS = 420;
const LYRIC_HOLD_MS = 2500;
const LYRIC_PILL_FONT = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
let lyricSongKey = '';
let lyricIndex = -1;
let lyricGap = false;
let lyricChangedAt = 0;
let lyricPreviousText = null;
let lyricWidestPx = 0;
let lyricHoldUntil = 0;

function getLiveMediaPositionMs() {
  const dur = mediaState.duration_ms || 0;
  const base = mediaState.progress_ms || 0;
  const rate = (typeof mediaState.playback_rate === 'number' && mediaState.playback_rate > 0) ? mediaState.playback_rate : 1.0;
  const offset = mediaState.lyric_offset_ms || 0;
  const elapsed = mediaState.isPlaying ? Math.max(0, performance.now() - mediaSyncAt) * rate : 0;
  const current = base + elapsed + offset;
  return dur > 0 ? Math.min(dur, Math.max(0, current)) : Math.max(0, current);
}

function formatTimeMs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function getCurrentActiveLyricText(timed) {
  if (lyricGap || lyricIndex < 0 || !timed || !timed[lyricIndex]) return null;
  return timed[lyricIndex].text || null;
}

function tickLyrics() {
  const track = mediaState.track;
  const timed = (track && Array.isArray(track.timedLyrics)) ? track.timedLyrics : [];
  const key = (track && track.title && track.title !== 'No media playing') ? `${track.title}|${track.artist}|${timed.length}` : '';

  if (key !== lyricSongKey) {
    if (lyricWidestPx > 0) {
      lyricHoldUntil = performance.now() + LYRIC_HOLD_MS;
    }
    lyricSongKey = key;
    lyricIndex = -1;
    lyricGap = false;
    lyricChangedAt = performance.now();

    if (timed.length > 0) {
      ctx.save();
      ctx.font = LYRIC_PILL_FONT;
      lyricWidestPx = timed.reduce((m, l) => Math.max(m, l.text ? ctx.measureText(l.text).width : 0), 0);
      ctx.restore();
    } else if (performance.now() >= lyricHoldUntil) {
      lyricWidestPx = 0;
    }
  }

  if (!timed.length) return;

  const pos = getLiveMediaPositionMs() + LYRIC_LEAD_MS;
  let idx = -1;
  for (let k = 0; k < timed.length; k++) {
    if (timed[k].t <= pos) idx = k;
    else break;
  }

  let g = false;
  if (idx >= 0) {
    const since = pos - timed[idx].t;
    const next = timed[idx + 1];
    g = next ? (next.t - timed[idx].t > 14000 && since > 9000) : (since > 8000);
  }

  if (idx !== lyricIndex || g !== lyricGap) {
    lyricPreviousText = getCurrentActiveLyricText(timed);
    lyricIndex = idx;
    lyricGap = g;
    lyricChangedAt = performance.now();
  }
}

function getPillRollingLyric() {
  const timed = (mediaState.track && Array.isArray(mediaState.track.timedLyrics)) ? mediaState.track.timedLyrics : [];
  const rawK = Math.min(1, Math.max(0, (performance.now() - lyricChangedAt) / LYRIC_SWAP_MS));
  const k = 1 - Math.pow(1 - rawK, 4);
  if (!timed.length) {
    if (mediaState.track && mediaState.track.currentLyric) {
      return { text: mediaState.track.currentLyric, previous: null, k: 1 };
    }
    return null;
  }
  const cur = getCurrentActiveLyricText(timed);
  return {
    text: cur,
    previous: k < 1 ? lyricPreviousText : null,
    k
  };
}

function getExpandedAroundLyrics() {
  const timed = (mediaState.track && Array.isArray(mediaState.track.timedLyrics)) ? mediaState.track.timedLyrics : [];
  if (!timed.length) return null;
  const rawK = Math.min(1, Math.max(0, (performance.now() - lyricChangedAt) / LYRIC_SWAP_MS));
  const k = 1 - Math.pow(1 - rawK, 4);
  const textAt = (i) => (timed[i] && timed[i].text) || '';
  if (lyricIndex < 0) {
    const first = timed.find(l => l.text)?.text || '';
    return { before: '', now: '♪', next: first, k: 1 };
  }
  const cur = getCurrentActiveLyricText(timed) || '♪';
  return {
    before: textAt(lyricIndex - 1),
    now: cur,
    next: textAt(lyricIndex + 1),
    k
  };
}

// -------------------------------------------------------------
// TwoCode 6-Bar Equalizer & Vector Media Icons
// -------------------------------------------------------------
const vizState = {};
function drawEqualizer(key, x, cy, w, h, colour, n = 6) {
  const t = performance.now() / 1000;
  const playing = Boolean(mediaState.isPlaying);
  const bars = vizState[key] && vizState[key].length === n ? vizState[key] : (vizState[key] = new Array(n).fill(0.15));
  const gap = Math.max(1.8, (w / n) * 0.38);
  const bw = Math.max(1.5, (w - gap * (n - 1)) / n);

  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = h * 0.35;
  for (let i = 0; i < n; i++) {
    const raw = !playing
      ? 0.08
      : 0.2 + 0.65 * Math.abs(Math.sin(t * (2.2 + i * 0.43) + i * 1.7)) * (0.65 + 0.35 * Math.sin(t * 1.3 + i * 0.9));
    const want = !playing ? 0.12 : Math.min(1, 0.14 + 1.1 * Math.pow(raw, 0.65));
    bars[i] += (want - bars[i]) * (want > bars[i] ? 0.5 : 0.16);
    const bh = Math.max(bw, h * Math.min(1, bars[i]));
    ctx.beginPath();
    ctx.roundRect(x + i * (bw + gap), cy - bh / 2, bw, bh, bw / 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.restore();
}

function drawVectorMediaIcon(kind, x, y, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  ctx.beginPath();
  const tri = (x0, dir) => {
    ctx.moveTo(x0, y - s / 2);
    ctx.lineTo(x0 + dir * s * 0.75, y);
    ctx.lineTo(x0, y + s / 2);
    ctx.closePath();
  };
  if (kind === 'play') {
    tri(x - s * 0.3, 1);
  } else if (kind === 'pause') {
    ctx.roundRect(x - s * 0.4, y - s / 2, s * 0.28, s, 2);
    ctx.roundRect(x + s * 0.12, y - s / 2, s * 0.28, s, 2);
  } else {
    const d = kind === 'next' ? 1 : -1;
    tri(x - d * s * 0.6, d);
    tri(x - d * s * 0.05, d);
    ctx.roundRect(x + d * s * 0.7 - (d > 0 ? 0 : s * 0.16), y - s / 2, s * 0.16, s, 1);
  }
  ctx.fill();
  ctx.restore();
}

// -------------------------------------------------------------
// TwoCode Tuck Away Mode & Game Mode
// -------------------------------------------------------------
let isTucked = false;
let tuckHoverAt = 0;
let tuckChangedAt = 0;
let isGameModeFullscreen = false;
let gameModeOpenedAnyway = false;
let gameModeEnabled = true;
let gameModeToastText = '';
let gameModeToastUntil = 0;

// -------------------------------------------------------------
// TwoCode Connected Downward Song Change Extension Popup
// -------------------------------------------------------------
let lastSongAnnouncementKey = '';
let songPopupActiveUntil = 0;
let songPopupProgress = 0.0; // 0.0 (compact) -> 1.0 (fully extended downward)
const SONG_POPUP_DURATION_MS = 6000; // 6 seconds display duration approved by user
const SONG_POPUP_HEIGHT = 124;
const SONG_POPUP_WIDTH = 480;

function triggerSongAnnouncement() {
  if (isTucked) setTucked(false);
  songPopupActiveUntil = performance.now() + SONG_POPUP_DURATION_MS;
}

try {
  const initGm = ipcRenderer.sendSync('get-game-mode');
  if (initGm && typeof initGm.enabled === 'boolean') {
    gameModeEnabled = initGm.enabled;
    isGameModeFullscreen = Boolean(initGm.isFullscreen);
  }
} catch (e) {}

function setTucked(on) {
  const next = Boolean(on);
  if (next === isTucked) return;
  isTucked = next;
  tuckHoverAt = 0;
  tuckChangedAt = performance.now();
  if (isTucked) {
    isHovered = false;
    targetProgress = 0.0;
    currentView = 'home';
    ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
  }
}

function getAntigravityProgress(state) {
  const status = (state.status || 'idle').toLowerCase();
  const tool = (state.tool || '').toLowerCase();
  const phase = (state.phase || '').toLowerCase();
  const cmd = (state.command || '').toLowerCase();

  const labels = ['Analyze', 'Execute', 'Verify', 'Complete'];

  if (status === 'done' || phase.includes('completed') || phase.includes('finished')) {
    return {
      completedCount: 4,
      segments: [true, true, true, true],
      activeSegment: -1,
      labels
    };
  }

  if (status === 'error') {
    return {
      completedCount: 1,
      segments: [true, false, false, false],
      activeSegment: 1,
      hasError: true,
      labels
    };
  }

  if (status === 'thinking' || phase.includes('analyzing') || phase.includes('thinking') || phase.includes('plan')) {
    return {
      completedCount: 0,
      segments: [false, false, false, false],
      activeSegment: 0,
      labels
    };
  }

  // Verification / Build / Test stage
  if (tool.includes('test') || cmd.includes('test') || cmd.includes('setup') || cmd.includes('compile') ||
      phase.includes('test') || phase.includes('compil') || phase.includes('build') || phase.includes('release') || phase.includes('verif')) {
    return {
      completedCount: 2,
      segments: [true, true, false, false],
      activeSegment: 2,
      labels
    };
  }

  // Tool execution stage (read, write, edit, run, MCP)
  if (tool || status === 'running') {
    return {
      completedCount: 1,
      segments: [true, false, false, false],
      activeSegment: 1,
      labels
    };
  }

  return {
    completedCount: 0,
    segments: [false, false, false, false],
    activeSegment: -1,
    labels
  };
}

// Preload Antigravity Logo
const antigravityLogo = new Image();
antigravityLogo.src = '../../antigravity_logo.png';

// High-DPI Canvas Resizing
let dpr = 1;
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Helper: Quartic Ease Out
function easeOutQuart(x) {
  return 1 - Math.pow(1 - x, 3.6);
}

// Helper: Point in Rounded Rect
function pointInRect(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

// Active button hitboxes
let interactiveButtons = [];

// Hover tracking
let mouseX = -1000;
let mouseY = -1000;
let hoveredButtonId = null;

// Initial transparent click-through state
ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });

// Prevent accidental window close or reload via shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && ['w', 'r'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Drag & Drop Shelf Support inside Island / Notch
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!isDraggingOver) {
    isDraggingOver = true;
    targetProgress = 1.0;
    currentView = 'dropzone';
    ipcRenderer.send('set-ignore-mouse-events', false);
  }
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;
  if (e.dataTransfer) {
    const fileList = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (fileList.length === 0 && e.dataTransfer.items) {
      for (const item of e.dataTransfer.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) fileList.push(f);
        }
      }
    }
    for (const file of fileList) {
      let filePath = null;
      try {
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
          filePath = webUtils.getPathForFile(file);
        }
      } catch (err) {}
      if (!filePath && file && file.path) {
        filePath = file.path;
      }
      if (filePath) {
        ipcRenderer.send('dropzone-add-file', filePath);
      }
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

  // Island pill hit detection
  const curP = Math.max(0, Math.min(1, animProgress));
  const curW = getTargetWidth(curP);
  const curH = getTargetHeight(curP);
  const curX = (window.innerWidth - curW) / 2;
  const isNotch = displayMode === 'notch';
  const curY = isNotch ? 0 : 8;

  const isOverIsland = pointInRect(mouseX, mouseY, curX - 8, Math.max(0, curY - 4), curW + 16, curH + 16);

  if (isOverIsland) {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    if (!isHovered) {
      isHovered = true;
      if (curP < 0.25 && hasActiveAgent()) {
        const projs = getActiveProjects();
        const active = projs.find(pr => ['running', 'thinking', 'waiting'].includes(pr.status)) || projs[0];
        const cleanLabel = ((active && active.project) ? String(active.project) : 'Island').replace(/[\r\n\t\\]+/g, ' ').trim() || 'Island';
        ctx.save();
        ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
        const labelW = ctx.measureText(cleanLabel).width;
        ctx.restore();
        const aiW = Math.max(88, Math.min(130, Math.round(58 + labelW)));
        if (mouseX <= curX + aiW + 8) {
          currentView = 'agent';
        } else if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
          currentView = 'media';
        } else {
          currentView = 'home';
        }
      } else if (curP < 0.25) {
        if (mediaState.isPlaying) currentView = 'media';
        else currentView = 'home';
      }
      targetProgress = 1.0;
      ipcRenderer.send('set-ignore-mouse-events', false);
      ipcRenderer.send('island-hover-start');
    }
  } else {
    if (isHovered && !leaveTimer) {
      leaveTimer = setTimeout(() => {
        isHovered = false;
        targetProgress = 0.0;
        currentView = 'home';
        ipcRenderer.send('island-hover-end');
        leaveTimer = null;
        setTimeout(() => {
          if (!isHovered) {
            ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
          }
        }, 320);
      }, UI.LEAVE_DELAY);
    }
  }

  // Shelf drag-out trigger
  if (shelfDragCandidate && Math.hypot(mouseX - shelfDragCandidate.x, mouseY - shelfDragCandidate.y) > 6) {
    const p = shelfDragCandidate.path;
    shelfDragCandidate = null;
    ipcRenderer.send('shelf-drag-start', p);
  }

  // Button hover inspection
  let found = null;
  for (const btn of interactiveButtons) {
    if (pointInRect(mouseX, mouseY, btn.x, btn.y, btn.w, btn.h)) {
      found = btn.id;
      break;
    }
  }

  if (found !== hoveredButtonId) {
    hoveredButtonId = found;
    canvas.style.cursor = found ? 'pointer' : 'default';
  }
});

canvas.addEventListener('mouseleave', () => {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    isHovered = false;
    targetProgress = 0.0;
    currentView = 'home';
    ipcRenderer.send('island-hover-end');
    leaveTimer = null;
    ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
  }, UI.LEAVE_DELAY);
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (animProgress < 0.3 && !isTucked) {
    setTucked(true);
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const cx = e.clientX;
  const cy = e.clientY;
  if (currentView === 'dropzone') {
    for (const btn of interactiveButtons) {
      if (btn.id && (btn.id.startsWith('dropzone_row_') || btn.id.startsWith('dropzone_open_file_')) && pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
        shelfDragCandidate = { x: cx, y: cy, path: btn.data };
        break;
      }
    }
  }
});

canvas.addEventListener('mouseup', () => {
  shelfDragCandidate = null;
});

window.addEventListener('keydown', (e) => {
  if (currentView === 'clipboard') {
    if (e.key === 'Backspace') {
      clipboardFilter = clipboardFilter.slice(0, -1);
    } else if (e.key === 'Escape') {
      clipboardFilter = '';
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      clipboardFilter += e.key;
    }
  }
});

canvas.addEventListener('click', (e) => {
  const cx = e.clientX;
  const cy = e.clientY;

  if (isTucked) {
    setTucked(false);
    return;
  }

  for (const btn of interactiveButtons) {
    if (pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
      handleButtonClick(btn.id, btn.data);
      return;
    }
  }

  // Click on resting badge or main body
  if (animProgress < 0.3) {
    if (hasActiveAgent()) {
      const projs = getActiveProjects();
      const active = projs.find(pr => ['running', 'thinking', 'waiting'].includes(pr.status)) || projs[0];
      const cleanLabel = ((active && active.project) ? String(active.project) : 'Island').replace(/[\r\n\t\\]+/g, ' ').trim() || 'Island';
      ctx.save();
      ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
      const labelW = ctx.measureText(cleanLabel).width;
      ctx.restore();
      const aiW = Math.max(88, Math.min(130, Math.round(58 + labelW)));
      const curX = (window.innerWidth - getTargetWidth(animProgress)) / 2;
      if (cx <= curX + aiW + 8) {
        currentView = 'agent';
      } else if (mediaState.isPlaying) {
        currentView = 'media';
      } else {
        currentView = 'home';
      }
    } else if (mediaState.isPlaying) {
      currentView = 'media';
    } else {
      currentView = 'home';
    }
    targetProgress = 1.0;
  }
});

function handleButtonClick(id, data) {
  if (id === 'nav_home') {
    currentView = 'home';
  } else if (id === 'nav_agent') {
    currentView = 'agent';
  } else if (id === 'nav_media') {
    currentView = 'media';
  } else if (id === 'nav_dropzone') {
    currentView = 'dropzone';
  } else if (id === 'nav_clipboard') {
    currentView = 'clipboard';
    ipcRenderer.send('clipboard-get');
  } else if (id === 'nav_settings') {
    ipcRenderer.send('open-settings');
  } else if (id === 'toggle_display_mode') {
    displayMode = displayMode === 'island' ? 'notch' : 'island';
    ipcRenderer.send('set-display-mode', displayMode);
  } else if (id === 'song_popup_open_media') {
    songPopupActiveUntil = 0;
    currentView = 'media';
    targetProgress = 1.0;
  } else if (id === 'tuck_island') {
    setTucked(true);
  } else if (id && id.startsWith('media_speed_')) {
    const val = data === 'auto' ? null : Number(data);
    ipcRenderer.send('media-set-speed', val);
  } else if (id === 'media_offset_minus') {
    const cur = mediaState.lyric_offset_ms || 0;
    ipcRenderer.send('media-set-offset', cur - 500);
  } else if (id === 'media_offset_plus') {
    const cur = mediaState.lyric_offset_ms || 0;
    ipcRenderer.send('media-set-offset', cur + 500);
  } else if (id === 'media_offset_reset') {
    ipcRenderer.send('media-set-offset', 0);
  } else if (id && id.startsWith('clip_copy_')) {
    const clipId = data;
    ipcRenderer.send('clipboard-copy', clipId);
    copiedFeedbackId = clipId;
    if (copiedFeedbackTimer) clearTimeout(copiedFeedbackTimer);
    copiedFeedbackTimer = setTimeout(() => { copiedFeedbackId = null; }, 1800);
  } else if (id && id.startsWith('clip_pin_')) {
    ipcRenderer.send('clipboard-pin', data);
  } else if (id === 'clipboard_clear') {
    ipcRenderer.send('clipboard-clear');
  } else if (id === 'dropzone_reveal') {
    ipcRenderer.send('open-dropzone');
  } else if (id === 'dropzone_clear') {
    ipcRenderer.send('dropzone-clear-all');
  } else if (id === 'dropzone_browse') {
    ipcRenderer.send('dropzone-browse-file');
  } else if (id && (id === 'dropzone_open_file' || id.startsWith('dropzone_open_file_') || id.startsWith('dropzone_row_'))) {
    ipcRenderer.send('dropzone-open-file', data);
  } else if (id && (id === 'dropzone_delete_file' || id.startsWith('dropzone_delete_file_'))) {
    ipcRenderer.send('dropzone-delete-file', data);
  } else if (id === 'jump_antigravity' || (id && id.startsWith('focus_proj_'))) {
    ipcRenderer.send('focus-antigravity');
  } else if (id === 'media_play_pause') {
    ipcRenderer.send('media-play-pause');
  } else if (id === 'media_next') {
    ipcRenderer.send('media-next');
  } else if (id === 'media_prev') {
    ipcRenderer.send('media-prev');
  } else if (id === 'media_seek' && data) {
    const ratio = Math.max(0, Math.min(1, (mouseX - data.x) / data.w));
    const dur = mediaState.duration_ms || 0;
    if (dur > 0) {
      const targetMs = Math.round(ratio * dur);
      mediaState.progress_ms = targetMs;
      mediaSyncAt = performance.now();
      ipcRenderer.send('media-seek', targetMs);
    }
  } else if (id === 'prompt_allow') {
    ipcRenderer.send('permission-response', { id: data, allow: true });
    pendingPrompt = null;
    currentView = 'home';
  } else if (id === 'prompt_deny') {
    ipcRenderer.send('permission-response', { id: data, allow: false });
    pendingPrompt = null;
    currentView = 'home';
  }
}

// -------------------------------------------------------------
// IPC Listeners
// -------------------------------------------------------------
ipcRenderer.on('antigravity-state', (event, state) => {
  antigravityState = state;
});

ipcRenderer.on('media-state', (event, state) => {
  mediaState = state || { isPlaying: false, track: null, progress_ms: 0, duration_ms: 0 };
  mediaSyncAt = performance.now();
  updateAlbumArt(mediaState.track ? mediaState.track.image_url : null);
  tickLyrics();

  // Song Change Downward Extension Trigger
  if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    const curKey = `${mediaState.track.title}|${mediaState.track.artist || ''}`;
    if (lastSongAnnouncementKey !== '' && curKey !== lastSongAnnouncementKey) {
      triggerSongAnnouncement();
    }
    lastSongAnnouncementKey = curKey;
  }
});

ipcRenderer.on('toggle-tuck', () => {
  setTucked(!isTucked);
});

ipcRenderer.on('untuck-island', () => {
  setTucked(false);
  gameModeOpenedAnyway = true;
  ipcRenderer.send('game-mode-hide', false);
  targetProgress = 1.0;
});

ipcRenderer.on('game-mode-changed', (event, data) => {
  const isFull = (data && typeof data === 'object') ? Boolean(data.fullscreen) : Boolean(data);
  if (data && typeof data === 'object' && typeof data.enabled === 'boolean') {
    gameModeEnabled = data.enabled;
  }
  isGameModeFullscreen = isFull;
  if (!isGameModeFullscreen) {
    gameModeOpenedAnyway = false;
    ipcRenderer.send('game-mode-hide', false);
  } else if (gameModeEnabled && !gameModeOpenedAnyway && !pendingPrompt) {
    ipcRenderer.send('game-mode-hide', true);
  } else {
    ipcRenderer.send('game-mode-hide', false);
  }
});

ipcRenderer.on('game-mode-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    gameModeEnabled = data.enabled;
    if (typeof data.isFullscreen === 'boolean') {
      isGameModeFullscreen = data.isFullscreen;
    }
  }
  gameModeToastText = gameModeEnabled ? '🎮 Game Mode: ON (Auto-Hide in games)' : '🎮 Game Mode: OFF (Visible in games)';
  gameModeToastUntil = performance.now() + 2500;

  if (gameModeEnabled && isGameModeFullscreen && !gameModeOpenedAnyway && !pendingPrompt) {
    ipcRenderer.send('game-mode-hide', true);
  } else {
    ipcRenderer.send('game-mode-hide', false);
  }
});

ipcRenderer.on('dropzone-files', (event, files) => {
  dropZoneFiles = files || [];
});

ipcRenderer.on('clipboard-update', (event, list) => {
  clipboardHistory = list || [];
});

ipcRenderer.on('display-mode', (event, mode) => {
  displayMode = mode || 'island';
});
ipcRenderer.on('animation-speed', (event, speed) => {
  const val = parseFloat(speed);
  if (!isNaN(val) && val >= 0.2 && val <= 5.0) {
    animSpeedMultiplier = val;
  }
});
try {
  ipcRenderer.invoke('get-app-settings').then(res => {
    if (res && res.config && res.config.animationSpeed) {
      const val = parseFloat(res.config.animationSpeed);
      if (!isNaN(val) && val >= 0.2 && val <= 5.0) animSpeedMultiplier = val;
    }
  }).catch(() => {});
} catch (e) {}

ipcRenderer.on('permission-prompt', (event, prompt) => {
  pendingPrompt = prompt;
  if (isTucked) setTucked(false);
  if (isGameModeFullscreen) {
    gameModeOpenedAnyway = true;
    ipcRenderer.send('game-mode-hide', false);
  }
  currentView = 'prompt';
  targetProgress = 1.0;
});

// -------------------------------------------------------------
// Render Loop (144Hz Smooth Animation)
// -------------------------------------------------------------
let lastTime = performance.now();

function animate(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  // Fluid Spring / Lerp towards targetProgress
  const speed = (targetProgress > animProgress ? 8.5 : 9.5) * animSpeedMultiplier;
  animProgress += (targetProgress - animProgress) * Math.min(1.0, dt * speed);

  // Smooth Dynamic Spring transition for resting pill width
  const targetRestW = getTargetRestingWidth();
  const restSpeed = (targetRestW > currentRestingWidth ? 8.5 : 7.0) * animSpeedMultiplier;
  currentRestingWidth += (targetRestW - currentRestingWidth) * Math.min(1.0, dt * restSpeed);

  // Song Announcement Downward Popup Spring & Hover Pause
  const isHoveredOverPopup = songPopupProgress > 0.05 && mouseX >= 0 && mouseY >= 0 && pointInRect(mouseX, mouseY, (window.innerWidth - getTargetWidth(animProgress)) / 2, (displayMode === 'notch' ? 0 : 8), getTargetWidth(animProgress), getTargetHeight(animProgress));
  if (isHoveredOverPopup && songPopupActiveUntil > now) {
    songPopupActiveUntil = Math.max(songPopupActiveUntil, now + 1500);
  }
  const isSongPopupActive = songPopupActiveUntil > now && animProgress < 0.2;
  const targetSongPopupProgress = isSongPopupActive ? 1.0 : 0.0;
  const songSpringSpeed = (targetSongPopupProgress > songPopupProgress ? 9.5 : 7.0) * animSpeedMultiplier;
  songPopupProgress += (targetSongPopupProgress - songPopupProgress) * Math.min(1.0, dt * songSpringSpeed);

  // Send window size updates to Electron Main
  const currentHeight = getTargetHeight(animProgress);
  const currentWidth = getTargetWidth(animProgress);
  ipcRenderer.send('window-bounds-update', {
    width: Math.round(currentWidth),
    height: Math.round(currentHeight)
  });

  try {
    render();
  } catch (err) {
    console.error('Render error:', err);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function getActiveProjects() {
  if (antigravityState && antigravityState.projects && Array.isArray(antigravityState.projects) && antigravityState.projects.length > 0) {
    return antigravityState.projects;
  }
  return [antigravityState || { status: 'idle', phase: 'Ready', project: 'Antigravity' }];
}

function hasActiveAgent() {
  const projs = getActiveProjects();
  return projs.some(p => ['running', 'thinking', 'waiting'].includes(p.status)) || pendingPrompt !== null;
}

function truncateToWidth(text, maxW, font) {
  if (!text) return '';
  ctx.save();
  if (font) ctx.font = font;
  if (ctx.measureText(text).width <= maxW) {
    ctx.restore();
    return text;
  }
  let str = text;
  while (str.length > 0 && ctx.measureText(str + '...').width > maxW) {
    str = str.slice(0, -1);
  }
  ctx.restore();
  return str.trim() ? str.trim() + '...' : '...';
}

function getTargetRestingWidth() {
  tickLyrics();

  if (isTucked) {
    return 180;
  }

  const hasMedia = mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing';
  let mainPillW = UI.REST_W;

  if (hasMedia) {
    const roll = getPillRollingLyric();
    let textToMeasure = '';
    if (roll && roll.text) {
      textToMeasure = roll.text;
      if (roll.previous && roll.k < 1) {
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        const w1 = ctx.measureText(roll.text).width;
        const w2 = ctx.measureText(roll.previous).width;
        ctx.restore();
        const maxW = Math.max(w1, w2);
        mainPillW = Math.max(220, Math.min(420, Math.round(144 + maxW)));
      } else {
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        const textW = ctx.measureText(textToMeasure).width;
        ctx.restore();
        mainPillW = Math.max(220, Math.min(420, Math.round(144 + textW)));
      }
    } else {
      textToMeasure = (mediaState.track.title || '').trim();
      ctx.save();
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      const textW = ctx.measureText(textToMeasure).width;
      ctx.restore();
      mainPillW = Math.max(220, Math.min(420, Math.round(144 + textW)));
    }
  } else {
    mainPillW = UI.REST_W;
  }

  if (hasActiveAgent()) {
    const projs = getActiveProjects();
    const active = projs.find(p => ['running', 'thinking', 'waiting'].includes(p.status)) || projs[0];
    const rawLabel = (active && active.project) ? String(active.project) : 'Island';
    const cleanLabel = rawLabel.replace(/[\r\n\t\\]+/g, ' ').trim() || 'Island';

    ctx.save();
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    const labelW = ctx.measureText(cleanLabel).width;
    ctx.restore();

    const aiPillW = Math.max(88, Math.min(130, Math.round(58 + labelW)));
    const gap = 8;
    const totalW = aiPillW + gap + mainPillW;
    return Math.max(280, Math.min(580, totalW));
  }

  return mainPillW;
}

function getRestingWidth() {
  return currentRestingWidth;
}

function getTargetWidth(p) {
  const restW = getRestingWidth();
  const normalW = restW + (UI.EXPANDED_W - restW) * easeOutQuart(p);
  if (songPopupProgress > 0.001 && p < 0.2) {
    const popK = easeOutQuart(songPopupProgress);
    const targetW = displayMode === 'notch' ? UI.EXPANDED_W : SONG_POPUP_WIDTH;
    return normalW + (targetW - normalW) * popK;
  }
  return normalW;
}

function getTargetHeight(p) {
  if (isTucked) {
    return 14;
  }

  const projs = getActiveProjects();
  const activeProjs = projs.filter(pr => ['running', 'thinking', 'waiting'].includes(pr.status));
  const stackCount = Math.max(1, Math.min(4, activeProjs.length));

  let restH = UI.BAR_H;
  if (hasActiveAgent()) {
    restH = UI.ACTIVE_BAR_H + (stackCount - 1) * 37;
  } else if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    restH = UI.ACTIVE_BAR_H;
  }

  let expH = UI.HOME_H;
  if (currentView === 'agent') {
    const cardCount = Math.max(1, Math.min(3, projs.length));
    expH = cardCount === 1 ? UI.AGENT_H : Math.min(340, 160 + (cardCount - 1) * 82);
  } else if (currentView === 'media') {
    expH = UI.MEDIA_H + 34;
  } else if (currentView === 'dropzone') {
    expH = UI.DROPZONE_H;
  } else if (currentView === 'clipboard') {
    expH = UI.CLIPBOARD_H;
  } else if (currentView === 'prompt') {
    expH = UI.PROMPT_H;
  }

  const normalH = restH + (expH - restH) * easeOutQuart(p);
  if (songPopupProgress > 0.001 && p < 0.2) {
    const popK = easeOutQuart(songPopupProgress);
    return normalH + (SONG_POPUP_HEIGHT - normalH) * popK;
  }
  return normalH;
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  interactiveButtons = [];

  if (gameModeEnabled && isGameModeFullscreen && !gameModeOpenedAnyway && !pendingPrompt) {
    return;
  }

  if (isTucked) {
    if (pendingPrompt) {
      setTucked(false);
    } else {
      const lineW = 56;
      const lineH = 4;
      const lineX = (window.innerWidth - lineW) / 2;
      const lineY = 1;

      let lineCol = 'rgba(255, 255, 255, 0.55)';
      if (hasActiveAgent()) {
        const projs = getActiveProjects();
        if (projs.some(pr => pr.status === 'waiting')) lineCol = '#f59e0b';
        else lineCol = '#38bdf8';
      } else if (mediaState.isPlaying) {
        lineCol = albumAccentColor || '#22c55e';
      }

      ctx.save();
      ctx.shadowColor = lineCol;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.roundRect(lineX, lineY, lineW, lineH, 2);
      ctx.fillStyle = lineCol;
      ctx.fill();
      ctx.restore();

      const overZone = pointInRect(mouseX, mouseY, (window.innerWidth - 160) / 2, 0, 160, 12);
      if (overZone) {
        if (!tuckHoverStart) tuckHoverStart = performance.now();
        else if (performance.now() - tuckHoverStart > TUCK_HOVER_MS) {
          setTucked(false);
        }
      } else {
        tuckHoverStart = 0;
      }
      return;
    }
  }

  const p = Math.max(0, Math.min(1, animProgress));
  const w = getTargetWidth(p);
  const h = getTargetHeight(p);
  const x = (window.innerWidth - w) / 2;
  const isNotch = displayMode === 'notch';
  const y = isNotch ? 0 : 8; // Flush with top for notch, floating for island

  const radius = UI.COMPACT_RADIUS + (UI.EXPANDED_RADIUS - UI.COMPACT_RADIUS) * p;
  const radii = isNotch ? [0, 0, radius, radius] : radius;

  // Split resting pill check: when AI is active at rest, draw separate left/right capsules
  const isSplitResting = (p < 0.28 && hasActiveAgent() && songPopupProgress <= 0.05);
  const unifiedAlpha = isSplitResting ? (p / 0.28) : 1.0;

  if (unifiedAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = unifiedAlpha;

    // 1. Ambient Drop Shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 18 + 14 * p;
    ctx.shadowOffsetY = 6 + 6 * p;

    // 2. Liquid Glass OLED Black Surface
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0.0, '#101014');
    grad.addColorStop(0.5, '#08080a');
    grad.addColorStop(1.0, '#020204');

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radii);
    ctx.fillStyle = grad;
    ctx.fill();

    // 2b. Album Cover Ambient Tint Glow when on Media page
    const wantTint = (p > 0.35 && currentView === 'media' && mediaState.track && mediaState.track.title !== 'No media playing') ? 1 : 0;
    tintK += (wantTint - tintK) * 0.14;
    if (tintK > 0.01) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radii);
      ctx.clip();
      const tintGrad = ctx.createLinearGradient(x, y + h, x, y);
      tintGrad.addColorStop(0.0, colorWithAlpha(albumAccentColor, 0.42 * tintK));
      tintGrad.addColorStop(0.55, colorWithAlpha(albumAccentColor, 0.15 * tintK));
      tintGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = tintGrad;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // 3. Specular Border Rim (1px Glass Edge)
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radii);
    ctx.lineWidth = 1;
    ctx.strokeStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.85)' : `rgba(255, 255, 255, ${0.12 + 0.12 * p})`;
    ctx.stroke();

    ctx.restore();
  }

  // 4. Render Views
  if (p < 0.28) {
    if (songPopupProgress > 0.05) {
      const popAlpha = (0.28 - p) / 0.28;
      renderSongAnnouncementPopup(x, y, w, h, popAlpha);
    } else {
      renderRestingPill(x, y, w, h, (0.28 - p) / 0.28);
    }
  } else if (p > 0.35) {
    const alpha = (p - 0.35) / 0.65;
    renderExpandedView(x, y, w, h, alpha);
  }

  // 5. Game Mode Toast / Status Notification
  if (gameModeToastUntil > performance.now() && gameModeToastText) {
    const remainMs = gameModeToastUntil - performance.now();
    const toastAlpha = Math.min(1, remainMs / 300);
    const toastW = 240;
    const toastH = 28;
    const toastX = (window.innerWidth - toastW) / 2;
    const toastY = y + h + 10;

    ctx.save();
    ctx.globalAlpha = toastAlpha;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;

    ctx.beginPath();
    ctx.roundRect(toastX, toastY, toastW, toastH, 14);
    ctx.fillStyle = '#141418';
    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = gameModeEnabled ? 'rgba(34, 197, 94, 0.5)' : 'rgba(245, 158, 11, 0.5)';
    ctx.stroke();

    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = gameModeEnabled ? '#4ade80' : '#fbbf24';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gameModeToastText, toastX + toastW / 2, toastY + toastH / 2);
    ctx.restore();
  }
}

// -------------------------------------------------------------
// TwoCode Connected Downward Song Change Announcement Popup
// -------------------------------------------------------------
function renderSongAnnouncementPopup(x, y, w, h, popAlpha) {
  ctx.save();
  ctx.globalAlpha = popAlpha;

  const isNotch = displayMode === 'notch';
  const cornerR = UI.COMPACT_RADIUS + 8;
  const radii = isNotch ? [0, 0, cornerR, cornerR] : cornerR;

  // 1. Ambient Backlight Radial Glow bleeding from Album Accent Colors
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
  ctx.clip();
  const glowGrad = ctx.createRadialGradient(x + 55, y + 68, 5, x + 55, y + 68, 140);
  glowGrad.addColorStop(0.0, colorWithAlpha(albumAccentColor, 0.35 * popAlpha));
  glowGrad.addColorStop(0.45, colorWithAlpha(albumAccentColor, 0.12 * popAlpha));
  glowGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  // 2. Connected Top Bar (0 to 34px)
  const topH = 34;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Digital Clock on Left
  ctx.font = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#e4e4e7';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(timeStr, x + 16, y + topH / 2);
  const clockW = ctx.measureText(timeStr).width;

  // Animated 5-Bar Audio Equalizer on Top Right
  const eqW = 22;
  const eqX = x + w - eqW - 16;
  drawEqualizer('popup_top', eqX, y + topH / 2, eqW, 11, albumAccentColor, 5);

  // Center Rolling Lyric or Title Snippet
  const roll = getPillRollingLyric();
  const lyricStartX = x + 16 + clockW + 12;
  const lyricMaxW = Math.max(30, eqX - 12 - lyricStartX);

  ctx.save();
  ctx.beginPath();
  ctx.rect(lyricStartX, y + 2, lyricMaxW, topH - 4);
  ctx.clip();
  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const lyricText = (roll && roll.text) ? roll.text : (mediaState.track ? mediaState.track.title : 'Now Playing');
  ctx.fillStyle = albumAccentColor;
  ctx.fillText('🎵', lyricStartX, y + topH / 2);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(truncateToWidth(lyricText, lyricMaxW - 18, ctx.font), lyricStartX + 18, y + topH / 2);
  ctx.restore();

  // 1px Subtle Seam between Top Bar and Announcement Body
  ctx.beginPath();
  ctx.moveTo(x + 14, y + topH);
  ctx.lineTo(x + w - 14, y + topH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 3. Lower Body Metadata & Profile Art
  const track = mediaState.track || {};
  const songTitle = (track.title || 'Unknown Title').trim();
  const songArtist = (track.artist || 'Unknown Artist').trim();
  const songAlbum = (track.album || '').trim();

  // Square Album Profile Art (68x68 rounded 10px)
  const artSize = 68;
  const artX = x + 16;
  const artY = y + 42;
  const artR = 10;

  ctx.save();
  ctx.shadowColor = colorWithAlpha(albumAccentColor, 0.45 * popAlpha);
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;

  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, artR);
  ctx.clip();

  if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
    ctx.drawImage(albumImage, artX, artY, artSize, artSize);
  } else {
    const artGrad = ctx.createLinearGradient(artX, artY, artX + artSize, artY + artSize);
    artGrad.addColorStop(0.0, '#312e81');
    artGrad.addColorStop(0.5, '#4f46e5');
    artGrad.addColorStop(1.0, '#7c3aed');
    ctx.fillStyle = artGrad;
    ctx.fillRect(artX, artY, artSize, artSize);
    ctx.font = '24px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('🎵', artX + artSize / 2, artY + artSize / 2);
  }
  ctx.restore();

  // 1px Glass Rim around Album Art
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, artR);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.stroke();
  ctx.restore();

  // Right Column Stacked Metadata
  const metaX = artX + artSize + 16;
  const metaW = Math.max(40, x + w - 18 - metaX);

  // Row 1: Song Title (Bold White)
  const titleY = artY + 2;
  ctx.font = '700 13.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncateToWidth(songTitle, metaW, ctx.font), metaX, titleY);

  // Row 2: Artist (Reduced Opacity White ~70%)
  const artistY = titleY + 18;
  ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
  ctx.fillText(truncateToWidth(songArtist, metaW, ctx.font), metaX, artistY);

  // Row 3: Album (Subtle Opacity White ~45%)
  const albumY = artistY + 16;
  ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  const displayAlbum = songAlbum || 'Single';
  ctx.fillText(truncateToWidth(displayAlbum, metaW, ctx.font), metaX, albumY);

  // Row 4: Total Song Time & Live Progress Bar
  const durY = albumY + 16;
  const posMs = getLiveMediaPositionMs();
  const durMs = track.duration || mediaState.duration_ms || 0;
  const posText = formatTimeMs(posMs);
  const durText = formatTimeMs(durMs);

  ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fillText(posText, metaX, durY);
  const posW = ctx.measureText(posText).width;

  const durW = ctx.measureText(durText).width;
  ctx.fillText(durText, metaX + metaW - durW, durY);

  // Progress Bar Track
  const barX = metaX + posW + 8;
  const barW = Math.max(10, (metaX + metaW - durW - 8) - barX);
  const barH = 4;
  const barY = durY + 3.5;

  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fill();

  // Progress Bar Fill
  if (durMs > 0) {
    const k = Math.min(1.0, Math.max(0.0, posMs / durMs));
    const fillW = Math.max(barH, barW * k);
    const progGrad = ctx.createLinearGradient(barX, barY, barX + fillW, barY);
    progGrad.addColorStop(0.0, '#ec4899');
    progGrad.addColorStop(1.0, albumAccentColor || '#c084fc');

    ctx.beginPath();
    ctx.roundRect(barX, barY, fillW, barH, 2);
    ctx.fillStyle = progGrad;
    ctx.fill();
  }

  // Interactive Target to Open Media Tab
  interactiveButtons.push({ id: 'song_popup_open_media', x, y, w, h });

  ctx.restore();
}

// -------------------------------------------------------------
// Resting Pill View (Minimalist & Clean)
// -------------------------------------------------------------
function renderRestingPill(x, y, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (hasActiveAgent()) {
    // Dual Split Resting Pill (Apple-style AI Activity Capsule + Main Activity Pill)
    const projs = getActiveProjects();
    const active = projs.find(p => ['running', 'thinking', 'waiting'].includes(p.status)) || projs[0];
    const rawLabel = (active && active.project) ? String(active.project) : 'Island';
    const cleanLabel = rawLabel.replace(/[\r\n\t\\]+/g, ' ').trim() || 'Island';

    ctx.save();
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    const labelW = ctx.measureText(cleanLabel).width;
    ctx.restore();

    const aiPillW = Math.max(88, Math.min(130, Math.round(58 + labelW)));
    const gap = 8;
    const mainPillW = Math.max(120, w - (aiPillW + gap));

    const leftPillX = x;
    const mainPillX = x + aiPillW + gap;
    const pillH = h;
    const pillRadius = UI.COMPACT_RADIUS;

    // --- 1. LEFT AI CAPSULE [ (A) Island 🟢 ] ---
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(leftPillX, y, aiPillW, pillH, pillRadius);
    const aiGrad = ctx.createLinearGradient(leftPillX, y, leftPillX, y + pillH);
    aiGrad.addColorStop(0.0, '#101014');
    aiGrad.addColorStop(0.5, '#08080a');
    aiGrad.addColorStop(1.0, '#020204');
    ctx.fillStyle = aiGrad;
    ctx.fill();
    ctx.restore();

    // Specular glass rim
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(leftPillX, y, aiPillW, pillH, pillRadius);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();
    ctx.restore();

    // Antigravity Logo with rounded icon style
    const logoSize = 18;
    const logoX = leftPillX + 8;
    const logoY = y + (pillH - logoSize) / 2;
    if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(logoX, logoY, logoSize, logoSize, 4.5);
      ctx.clip();
      ctx.drawImage(antigravityLogo, logoX, logoY, logoSize, logoSize);
      ctx.restore();
    }

    // Project Name Label
    const textX = logoX + logoSize + 6;
    ctx.save();
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const maxLabelW = (leftPillX + aiPillW - 22) - textX;
    ctx.fillText(truncateToWidth(cleanLabel, Math.max(20, maxLabelW), ctx.font), textX, y + pillH / 2);
    ctx.restore();

    // Traffic light indicator dot
    const dotX = leftPillX + aiPillW - 12;
    const dotY = y + pillH / 2;
    renderTrafficLightDot(dotX, dotY, active ? active.status : 'running');

    // Interactive button target for AI capsule
    interactiveButtons.push({ id: 'nav_agent', x: leftPillX, y: y, w: aiPillW, h: pillH });

    // --- 2. RIGHT MAIN CAPSULE [ Clock | Media or Status ] ---
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(mainPillX, y, mainPillW, pillH, pillRadius);
    const mainGrad = ctx.createLinearGradient(mainPillX, y, mainPillX, y + pillH);
    mainGrad.addColorStop(0.0, '#101014');
    mainGrad.addColorStop(0.5, '#08080a');
    mainGrad.addColorStop(1.0, '#020204');
    ctx.fillStyle = mainGrad;
    ctx.fill();
    ctx.restore();

    // Specular glass rim
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(mainPillX, y, mainPillW, pillH, pillRadius);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();
    ctx.restore();

    // Digital clock on the left of main pill
    ctx.save();
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, mainPillX + 12, y + pillH / 2);
    const clockW = ctx.measureText(timeStr).width;
    ctx.restore();

    const hasMedia = mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing';
    if (hasMedia) {
      // Album Art thumbnail
      const artSize = 20;
      const artX = mainPillX + 12 + clockW + 8;
      const artY = y + (pillH - artSize) / 2;
      if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(artX, artY, artSize, artSize, 4.5);
        ctx.clip();
        ctx.drawImage(albumImage, artX, artY, artSize, artSize);
        ctx.restore();
      } else {
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = albumAccentColor || '#38bdf8';
        ctx.fillText('♪', artX + 4, y + pillH / 2);
        ctx.restore();
      }

      // 6-Bar Animated Equalizer on far right
      const eqW = 22;
      const eqX = mainPillX + mainPillW - eqW - 12;
      drawEqualizer('pill', eqX, y + pillH / 2, eqW, 13, albumAccentColor || '#ec4899', 6);

      // Rolling Lyric or Song Title
      const textStartX = artX + artSize + 8;
      const maxTextW = Math.max(30, eqX - 10 - textStartX);
      const roll = getPillRollingLyric();

      ctx.save();
      ctx.beginPath();
      ctx.rect(textStartX, y + 2, maxTextW, pillH - 4);
      ctx.clip();
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      if (roll) {
        const cy = y + pillH / 2;
        const dist = 13;
        const prevText = roll.previous || roll.prev;
        if (prevText && roll.k < 1) {
          ctx.globalAlpha = alpha * (1 - roll.k);
          ctx.fillStyle = '#a1a1aa';
          ctx.fillText(truncateToWidth(prevText, maxTextW, ctx.font), textStartX, cy - roll.k * dist);
        }
        ctx.globalAlpha = alpha * roll.k;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(truncateToWidth(roll.text, maxTextW, ctx.font), textStartX, cy + (1 - roll.k) * dist);
      } else {
        const fallbackText = (mediaState.track.title || '').trim();
        ctx.fillStyle = '#f4f4f5';
        ctx.fillText(truncateToWidth(fallbackText, maxTextW, ctx.font), textStartX, y + pillH / 2);
      }
      ctx.restore();

      interactiveButtons.push({ id: 'nav_media', x: mainPillX, y: y, w: mainPillW, h: pillH });
    } else {
      if (mainPillW >= 150) {
        const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        ctx.save();
        ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = '#a1a1aa';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(dateStr, mainPillX + mainPillW - 12, y + pillH / 2);
        ctx.restore();
      }
      interactiveButtons.push({ id: 'nav_home', x: mainPillX, y: y, w: mainPillW, h: pillH });
    }
  } else if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    // Single Media Pill Layout: Clock + Rounded Album Art + Rolling Lyric / Song Title + 6-Bar Equalizer
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, x + 12, y + h / 2);
    const clockW = ctx.measureText(timeStr).width;

    // Album Cover Thumbnail (20x20 rounded) or Music Note
    const artSize = 20;
    const artX = x + 12 + clockW + 8;
    const artY = y + (h - artSize) / 2;
    if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(artX, artY, artSize, artSize, 4.5);
      ctx.clip();
      ctx.drawImage(albumImage, artX, artY, artSize, artSize);
      ctx.restore();
    } else {
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = albumAccentColor || '#38bdf8';
      ctx.fillText('♪', artX + 4, y + h / 2);
    }

    // 6-Bar Animated Equalizer on far right
    const eqW = 24;
    const eqX = x + w - eqW - 12;
    drawEqualizer('pill', eqX, y + h / 2, eqW, 13, albumAccentColor || '#ec4899', 6);

    // Center Rolling Lyric or Song Title
    const textStartX = artX + artSize + 8;
    const maxTextW = Math.max(30, eqX - 10 - textStartX);
    const roll = getPillRollingLyric();

    ctx.save();
    ctx.beginPath();
    ctx.rect(textStartX, y + 2, maxTextW, h - 4);
    ctx.clip();
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    if (roll) {
      const cy = y + h / 2;
      const dist = 13;
      const prevText = roll.previous || roll.prev;
      if (prevText && roll.k < 1) {
        ctx.globalAlpha = alpha * (1 - roll.k);
        ctx.fillStyle = '#a1a1aa';
        ctx.fillText(truncateToWidth(prevText, maxTextW, ctx.font), textStartX, cy - roll.k * dist);
      }
      ctx.globalAlpha = alpha * roll.k;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(truncateToWidth(roll.text, maxTextW, ctx.font), textStartX, cy + (1 - roll.k) * dist);
    } else {
      const fallbackText = (mediaState.track.title || '').trim();
      ctx.fillStyle = '#f4f4f5';
      ctx.fillText(truncateToWidth(fallbackText, maxTextW, ctx.font), textStartX, y + h / 2);
    }
    ctx.restore();
  } else {
    // Pure minimalist clock
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, x + w / 2, y + h / 2);
  }

  ctx.restore();
}

function renderTrafficLightDot(dx, dy, status) {
  let color = '#22c55e'; // Green (done / idle)
  let pulse = false;

  if (status === 'running') {
    color = '#22c55e'; // Vibrant green
    pulse = true;
  } else if (status === 'thinking') {
    color = '#38bdf8'; // Blue pulse
    pulse = true;
  } else if (status === 'waiting') {
    color = '#f59e0b'; // Amber solid
  } else if (status === 'error') {
    color = '#ef4444'; // Red
  } else if (status === 'not_running') {
    color = '#64748b'; // Muted Gray
  }

  ctx.save();
  if (pulse) {
    const pulseFactor = 0.5 + 0.5 * Math.sin(Date.now() / 180);
    ctx.beginPath();
    ctx.arc(dx, dy, 5 + pulseFactor * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color === '#22c55e'
      ? `rgba(34, 197, 94, ${0.35 * pulseFactor})`
      : `rgba(56, 189, 248, ${0.35 * pulseFactor})`;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(dx, dy, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// -------------------------------------------------------------
// Expanded Island View
// -------------------------------------------------------------
function renderExpandedView(x, y, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Navigation Pills at Top
  renderTopNav(x, y, w);

  // View Body
  if (currentView === 'home') {
    renderHomeView(x, y, w, h);
  } else if (currentView === 'agent') {
    renderAgentView(x, y, w, h);
  } else if (currentView === 'media') {
    renderMediaView(x, y, w, h);
  } else if (currentView === 'dropzone') {
    renderDropZoneView(x, y, w, h);
  } else if (currentView === 'clipboard') {
    renderClipboardView(x, y, w, h);
  } else if (currentView === 'prompt') {
    renderPromptView(x, y, w, h);
  }

  ctx.restore();
}

function renderTopNav(x, y, w) {
  const navItems = [
    { id: 'nav_home', label: 'Home', w: 48 },
    { id: 'nav_agent', label: 'Ai', w: 38 },
    { id: 'nav_media', label: 'Media', w: 52 },
    { id: 'nav_dropzone', label: 'Drop Shelf', w: 68 },
    { id: 'nav_clipboard', label: 'Clipboard', w: 68 },
    { id: 'nav_settings', label: 'Settings', w: 58 }
  ];

  const pillH = 22;
  const spacing = 5;
  let curX = x + 16;
  const topY = y + 12;

  navItems.forEach((item) => {
    const px = curX;
    const pillW = item.w;
    curX += pillW + spacing;
    const isCur = currentView === item.id.replace('nav_', '');
    const isHov = hoveredButtonId === item.id;

    ctx.beginPath();
    ctx.roundRect(px, topY, pillW, pillH, 11);
    ctx.fillStyle = isCur ? '#2563eb' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
    ctx.fill();

    ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#f4f4f5' : '#a1a1aa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, px + pillW / 2, topY + pillH / 2);

    interactiveButtons.push({ id: item.id, x: px, y: topY, w: pillW, h: pillH });
  });

  // Display Mode Quick Switcher with Crisp Black & White Logo
  const modeW = 82;
  const modeH = 22;
  const modeX = x + w - modeW - 16;
  const isModeHov = hoveredButtonId === 'toggle_display_mode';

  ctx.beginPath();
  ctx.roundRect(modeX, topY, modeW, modeH, 11);
  ctx.fillStyle = isModeHov ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();

  // Monochrome black & white vector island / notch emblem
  const iconCx = modeX + 13;
  const iconCy = topY + modeH / 2;
  ctx.save();
  if (displayMode === 'island') {
    ctx.beginPath();
    ctx.roundRect(iconCx - 7, iconCy - 3.5, 14, 7, 3.5);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(iconCx - 2.5, iconCy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.roundRect(iconCx - 7, iconCy - 4, 14, 8, [0, 0, 3, 3]);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(iconCx, iconCy - 1, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  }
  ctx.restore();

  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayMode === 'island' ? 'Notch' : 'Island', iconCx + 11, topY + modeH / 2);
  interactiveButtons.push({ id: 'toggle_display_mode', x: modeX, y: topY, w: modeW, h: modeH });
}

function renderCalendarWidget(calX, calY, calW, calH) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();
  const todayDate = now.getDate();
  const monthName = now.toLocaleDateString([], { month: 'short' }).toUpperCase();

  // 1. Card Container & Subtle Glass Rim
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(calX, calY, calW, calH, 12);
  ctx.fillStyle = 'rgba(24, 24, 32, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // 2. Month Header (e.g. "NOV")
  ctx.font = '700 12px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(monthName, calX + 13, calY + 11);

  // 3. Days Grid Calculation
  const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
  const firstDayIndex = new Date(curYear, curMonth, 1).getDay(); // 0 = Sunday

  const gridStartX = calX + 13;
  const gridStartY = calY + 31;
  const colStep = (calW - 26) / 7;
  const rowStep = (calH - 35) / 5.2;

  ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let d = 1; d <= daysInMonth; d++) {
    const cellIdx = (d - 1) + firstDayIndex;
    const col = cellIdx % 7;
    const row = Math.floor(cellIdx / 7);

    const cx = gridStartX + col * colStep + colStep / 2;
    const cy = gridStartY + row * rowStep + rowStep / 2;

    if (d <= todayDate) {
      // Blue circle highlight for elapsed days and today (matching reference image)
      ctx.beginPath();
      ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = (d === todayDate) ? '#2563eb' : '#1d4ed8';
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(d), cx, cy);
    } else {
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(String(d), cx, cy);
    }
  }

  ctx.restore();
}

function renderHomeView(x, y, w, h) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  // 1. Digital Clock on Left (Clean typography, aligned horizontally with cards)
  const clockX = x + 20;
  ctx.font = '700 29px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(timeStr, clockX, y + 46);

  ctx.font = '500 12px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(dateStr, clockX, y + 84);

  // 2. Middle Mini Calendar Widget Card
  const calX = x + 162;
  const calY = y + 40;
  const calW = 146;
  const calH = 98;
  renderCalendarWidget(calX, calY, calW, calH);

  // 3. Antigravity Live Activity Card on Right
  const cardX = calX + calW + 12;
  const cardY = y + 40;
  const cardW = (x + w - 20) - cardX;
  const cardH = 98;

  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 12);
  ctx.fillStyle = 'rgba(24, 24, 32, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // Logo + Status
  if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
    ctx.drawImage(antigravityLogo, cardX + 10, cardY + 11, 18, 18);
  }

  ctx.font = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText('Google Antigravity', cardX + 32, cardY + 20);

  renderTrafficLightDot(cardX + cardW - 14, cardY + 20, antigravityState.status);

  // 4-Segment Progress Bar inside Home Card
  const prog = getAntigravityProgress(antigravityState);
  const barW = cardW - 20;
  const segW = (barW - 3 * 4) / 4;
  const segH = 3.5;
  const segY = cardY + 36;

  for (let i = 0; i < 4; i++) {
    const sx = cardX + 10 + i * (segW + 4);
    ctx.beginPath();
    ctx.roundRect(sx, segY, segW, segH, 1.75);
    if (prog.segments[i]) {
      ctx.fillStyle = '#22c55e'; // Finished segment filled with green
    } else if (prog.activeSegment === i) {
      ctx.fillStyle = '#38bdf8'; // Active segment pulsing cyan
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    }
    ctx.fill();
  }

  // Phase text
  ctx.font = '400 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#e2e8f0';
  const phaseText = antigravityState.phase || 'Agent Ready';
  ctx.fillText(phaseText.length > 24 ? phaseText.slice(0, 24) + '...' : phaseText, cardX + 10, cardY + 54);

  // Active tool badge
  if (antigravityState.tool) {
    ctx.font = '500 9px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    const toolText = `⚙ ${antigravityState.tool}`;
    ctx.fillText(toolText.length > 18 ? toolText.slice(0, 18) + '...' : toolText, cardX + 10, cardY + 70);
  }

  // Jump Button (Open Antigravity)
  const isRunning = antigravityState.status !== 'not_running';
  const btnJumpW = 62;
  const btnJumpH = 20;
  const btnJumpX = cardX + cardW - btnJumpW - 10;
  const btnJumpY = cardY + cardH - btnJumpH - 9;

  ctx.beginPath();
  ctx.roundRect(btnJumpX, btnJumpY, btnJumpW, btnJumpH, 6);
  ctx.fillStyle = isRunning ? (hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.25)') : 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = isRunning ? '#3b82f6' : 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isRunning ? '#ffffff' : '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isRunning ? 'Open ➔' : 'Ready', btnJumpX + btnJumpW / 2, btnJumpY + btnJumpH / 2);

  if (isRunning) {
    interactiveButtons.push({ id: 'jump_antigravity', x: btnJumpX, y: btnJumpY, w: btnJumpW, h: btnJumpH });
  }
}

// -------------------------------------------------------------
// Antigravity Real-Time Monitor View with 4-Segment Progress Bar
// -------------------------------------------------------------
function renderAgentView(x, y, w, h) {
  const topY = y + 40;
  const contentW = w - 48;
  const contentX = x + 24;

  const projs = getActiveProjects();

  // If only 1 project, render the classic spacious card
  if (projs.length <= 1) {
    const proj = projs[0] || antigravityState;

    // Header Title
    ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const cleanProj = (proj.project ? String(proj.project).replace(/[\r\n\t\\]+/g, ' ').trim() : 'Island') || 'Island';
    const projTitle = (cleanProj !== 'Antigravity' && cleanProj !== 'Island') ? `✦ AI Monitor: ${cleanProj}` : '✦ AI Real-Time Monitor';
    ctx.fillText(projTitle, contentX, topY);

    // Jump to IDE window button
    const jW = 110;
    const jH = 24;
    const jX = contentX + contentW - jW;
    const jY = topY - 2;

    ctx.beginPath();
    ctx.roundRect(jX, jY, jW, jH, 6);
    ctx.fillStyle = hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 10px "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Focus Window ↗', jX + jW / 2, jY + jH / 2);
    interactiveButtons.push({ id: 'jump_antigravity', x: jX, y: jY, w: jW, h: jH });

    // 4-Segment Progress Bar (Green fill when a part finishes)
    const prog = getAntigravityProgress(proj);
    const barY = topY + 30;
    const barH = 6;
    const gap = 6;
    const segW = (contentW - 3 * gap) / 4;

    for (let i = 0; i < 4; i++) {
      const sx = contentX + i * (segW + gap);
      ctx.beginPath();
      ctx.roundRect(sx, barY, segW, barH, 3);

      if (prog.segments[i]) {
        ctx.fillStyle = '#22c55e'; // Green
      } else if (prog.activeSegment === i) {
        ctx.fillStyle = '#38bdf8'; // Cyan
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      }
      ctx.fill();

      if (prog.segments[i]) {
        ctx.shadowColor = 'rgba(34, 197, 94, 0.4)';
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // Segment Labels under the 4 lines
    const labelY = barY + 12;
    for (let i = 0; i < 4; i++) {
      const sx = contentX + i * (segW + gap);
      const isDone = prog.segments[i];
      const isActive = prog.activeSegment === i;

      ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      if (isDone) {
        ctx.fillStyle = '#22c55e';
        ctx.fillText(`✓ ${i + 1}. ${prog.labels[i]}`, sx, labelY);
      } else if (isActive) {
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(`● ${i + 1}. ${prog.labels[i]}`, sx, labelY);
      } else {
        ctx.fillStyle = '#71717a';
        ctx.fillText(`${i + 1}. ${prog.labels[i]}`, sx, labelY);
      }
    }

    // Detailed State Card below Progress Bar
    const infoY = labelY + 24;
    const infoH = 58;

    ctx.beginPath();
    ctx.roundRect(contentX, infoY, contentW, infoH, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Active Phase & Tool Details
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Phase: ${proj.phase || 'Ready'}`, contentX + 12, infoY + 10);

    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    if (proj.command) {
      const cmdStr = `Command: ${proj.command}`;
      ctx.fillText(cmdStr.length > 56 ? cmdStr.slice(0, 56) + '...' : cmdStr, contentX + 12, infoY + 30);
    } else if (proj.tool) {
      ctx.fillText(`Active Tool: ${proj.tool}`, contentX + 12, infoY + 30);
    } else {
      ctx.fillText(`Status: ${proj.status.toUpperCase()} • All progress synced with IDE`, contentX + 12, infoY + 30);
    }
    return;
  }

  // -----------------------------------------------------------
  // MULTI-PROJECT VIEW (2 or more concurrent Antigravity projects)
  // -----------------------------------------------------------
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`✦ Active Antigravity Projects (${projs.length})`, contentX, topY);

  const cardGap = 8;
  const maxProjects = Math.min(3, projs.length);
  const cardH = maxProjects === 2 ? 78 : 66;
  const startY = topY + 22;

  for (let idx = 0; idx < maxProjects; idx++) {
    const proj = projs[idx];
    const cy = startY + idx * (cardH + cardGap);

    // Card background
    ctx.beginPath();
    ctx.roundRect(contentX, cy, contentW, cardH, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.strokeStyle = ['running', 'thinking'].includes(proj.status) ? 'rgba(56, 189, 248, 0.28)' : 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // 1. Project Title & Status badge
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const titleText = `✦ ${proj.project || ('Project ' + (idx + 1))}`;
    ctx.fillText(titleText, contentX + 10, cy + 8);

    // Phase text
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    const phaseStr = proj.phase || (proj.tool ? `⚙ ${proj.tool}` : 'Active');
    ctx.fillText(truncateToWidth(phaseStr, contentW - 170, ctx.font), contentX + 10, cy + 26);

    // Focus button
    const btnW = 90;
    const btnH = 20;
    const btnX = contentX + contentW - btnW - 10;
    const btnY = cy + 8;
    const isHov = hoveredButtonId === `focus_proj_${idx}`;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 5);
    ctx.fillStyle = isHov ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Focus ➔', btnX + btnW / 2, btnY + btnH / 2);
    interactiveButtons.push({ id: `focus_proj_${idx}`, data: proj.conversationId, x: btnX, y: btnY, w: btnW, h: btnH });

    // 2. 4-Segment Progress Bar for this project
    const prog = getAntigravityProgress(proj);
    const pBarY = cy + cardH - 18;
    const pBarH = 5;
    const pGap = 4;
    const pSegW = (contentW - 20 - 3 * pGap) / 4;

    for (let s = 0; s < 4; s++) {
      const sx = contentX + 10 + s * (pSegW + pGap);
      ctx.beginPath();
      ctx.roundRect(sx, pBarY, pSegW, pBarH, 2.5);
      if (prog.segments[s]) {
        ctx.fillStyle = '#22c55e'; // Finished segment filled with vibrant green
      } else if (prog.activeSegment === s) {
        ctx.fillStyle = '#38bdf8'; // Active segment cyan
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      }
      ctx.fill();
    }
  }
}

// -------------------------------------------------------------
// TwoCode Media View: Album Art, Equalizer, 3-Line Lyrics, Scrubber & Vector Transport
// -------------------------------------------------------------
function renderMediaView(x, y, w, h) {
  const topY = y + 40;
  const contentW = w - 48;
  const contentX = x + 24;

  const track = mediaState.track || { title: 'No media playing', artist: 'Open Liner, Spotify, or Media Player', source: 'none', lyrics: [], syncedLyrics: [] };
  const hasTrack = track.title && track.title !== 'No media playing';

  // 1. Top Row: 54x54 Album Art + Track/Artist/Source Badge + 6-Bar Equalizer
  const artSize = 54;
  const artX = contentX;
  const artY = topY;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.restore();

  if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(artX, artY, artSize, artSize, 10);
    ctx.clip();
    ctx.drawImage(albumImage, artX, artY, artSize, artSize);
    ctx.restore();
  } else {
    ctx.font = '22px "Segoe UI Symbol", sans-serif';
    ctx.fillStyle = albumAccentColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎵', artX + artSize / 2, artY + artSize / 2);
  }

  // 6-Bar Equalizer on top right
  const eqW = 32;
  const eqH = 18;
  const eqX = contentX + contentW - eqW - 4;
  const eqY = artY + 18;
  drawEqualizer('page', eqX, eqY, eqW, eqH, albumAccentColor, 6);

  // Track Title, Artist & Source Pill
  const metaX = artX + artSize + 14;
  const maxMetaW = Math.max(80, eqX - 14 - metaX);

  ctx.font = '700 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncateToWidth(track.title || 'No media playing', maxMetaW, ctx.font), metaX, artY + 3);

  ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.fillText(truncateToWidth(track.artist || 'Open Liner, Spotify, or Browser', maxMetaW, ctx.font), metaX, artY + 23);

  // Source + Lyric Status Badge
  const srcName = track.source && track.source !== 'none' ? track.source : 'Windows GSMTC';
  const lyrStatus = track.lyricStatus === 'synced' ? ' • LRCLIB Synced' : (track.lyricStatus === 'plain' ? ' • Lyrics' : '');
  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = albumAccentColor;
  ctx.fillText(`${srcName}${lyrStatus}`, metaX, artY + 41);

  // 2. Middle Row: Apple Music 3-Line Rolling Lyrics (before, now, next)
  const lyricsY = topY + 62;
  const lyricsH = 54;
  const around = getExpandedAroundLyrics();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(contentX, lyricsY, contentW, lyricsH, 8);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.clip();

  if (around) {
    const push = (1 - around.k) * 16;
    const centerX = contentX + contentW / 2;
    const midY = lyricsY + lyricsH / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (around.before) {
      ctx.globalAlpha = 0.34 * around.k;
      ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(truncateToWidth(around.before, contentW - 24, ctx.font), centerX, midY - 16 + push);
    }

    ctx.globalAlpha = 0.4 + 0.6 * around.k;
    ctx.font = '700 12.5px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(truncateToWidth(around.now, contentW - 24, ctx.font), centerX, midY + push);

    if (around.next) {
      ctx.globalAlpha = 0.38 * around.k;
      ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(truncateToWidth(around.next, contentW - 24, ctx.font), centerX, midY + 16 + push);
    }
  } else if (track.lyrics && track.lyrics.length > 0) {
    const curLine = track.currentLyric || track.lyrics[0];
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateToWidth(`♪ ${curLine}`, contentW - 24, ctx.font), contentX + contentW / 2, lyricsY + lyricsH / 2);
  } else {
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = !hasTrack
      ? 'Play any song in Liner, Spotify, or browser to sync live lyrics'
      : (track.lyricStatus === 'instrumental' ? '♪ Instrumental Track' : '♪ Syncing live lyrics via LRCLIB...');
    ctx.fillText(msg, contentX + contentW / 2, lyricsY + lyricsH / 2);
  }
  ctx.restore();

  // 3. Interactive Timeline Scrubber Bar with Elapsed & Remaining Time
  const posMs = getLiveMediaPositionMs();
  const durMs = Math.max(0, mediaState.duration_ms || 0);
  const ratio = durMs > 0 ? Math.max(0, Math.min(1, posMs / durMs)) : 0;

  const timeY = lyricsY + lyricsH + 13;
  ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'left';
  ctx.fillText(formatTimeMs(posMs), contentX, timeY);

  ctx.textAlign = 'right';
  ctx.fillText(durMs > 0 ? `-${formatTimeMs(Math.max(0, durMs - posMs))}` : '0:00', contentX + contentW, timeY);

  const barX = contentX + 38;
  const barW = contentW - 78;
  const isBarHov = hoveredButtonId === 'media_seek';
  const barH = isBarHov ? 6 : 3.5;
  const barY = timeY - barH / 2;

  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fill();

  const fillW = Math.max(barH, barW * ratio);
  if (ratio > 0) {
    ctx.beginPath();
    ctx.roundRect(barX, barY, fillW, barH, barH / 2);
    ctx.fillStyle = isBarHov ? albumAccentColor : '#ffffff';
    ctx.fill();
  }

  if (isBarHov && durMs > 0) {
    ctx.beginPath();
    ctx.arc(barX + fillW, timeY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  interactiveButtons.push({
    id: 'media_seek',
    data: { x: barX, w: barW },
    x: barX,
    y: timeY - 8,
    w: barW,
    h: 16
  });

  // 4. Centered Vector Transport Controls (Prev, Play/Pause, Next)
  const controls = [
    { id: 'media_prev', kind: 'prev' },
    { id: 'media_play_pause', kind: mediaState.isPlaying ? 'pause' : 'play' },
    { id: 'media_next', kind: 'next' }
  ];

  const cW = 36;
  const cH = 26;
  const cSpacing = 14;
  const startCX = contentX + (contentW - (3 * cW + 2 * cSpacing)) / 2;
  const cY = timeY + 11;

  controls.forEach((c, idx) => {
    const cx = startCX + idx * (cW + cSpacing);
    const isHov = hoveredButtonId === c.id;
    const isMain = c.id === 'media_play_pause';

    ctx.beginPath();
    ctx.roundRect(cx, cY, cW, cH, 13);
    ctx.fillStyle = isHov
      ? 'rgba(255, 255, 255, 0.22)'
      : (isMain ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
    ctx.fill();

    drawVectorMediaIcon(c.kind, cx + cW / 2, cY + cH / 2, isMain ? 12 : 11, '#ffffff');
    interactiveButtons.push({ id: c.id, x: cx, y: cY, w: cW, h: cH });
  });

  // 5. Slowed + Reverb Playback Speed Chips & Lyric Sync Offset Row
  const tuningY = cY + cH + 8;
  const chipH = 19;
  const curSpeed = mediaState.user_speed; // null = auto, or number
  const curRate = mediaState.playback_rate || 1.0;
  const curOffset = mediaState.lyric_offset_ms || 0;

  // Speed chips on left: Auto, 0.8x, 0.85x, 0.9x, 1.0x
  const speedChips = [
    { label: 'Auto', val: 'auto', active: curSpeed === null },
    { label: '0.8x', val: 0.8, active: curSpeed === 0.8 },
    { label: '0.85x', val: 0.85, active: curSpeed === 0.85 },
    { label: '0.9x', val: 0.9, active: curSpeed === 0.9 },
    { label: '1.0x', val: 1.0, active: curSpeed === 1.0 }
  ];

  ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillText('Speed:', contentX, tuningY + chipH / 2);
  let chipX = contentX + 38;

  speedChips.forEach((sc) => {
    ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
    const sW = ctx.measureText(sc.label).width + 12;
    const isHov = hoveredButtonId === `media_speed_${sc.val}`;

    ctx.beginPath();
    ctx.roundRect(chipX, tuningY, sW, chipH, 9);
    ctx.fillStyle = sc.active
      ? (albumAccentColor || '#22c55e')
      : (isHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)');
    ctx.fill();

    ctx.fillStyle = sc.active ? '#000000' : '#e4e4e7';
    ctx.textAlign = 'center';
    ctx.fillText(sc.label, chipX + sW / 2, tuningY + chipH / 2);

    interactiveButtons.push({ id: `media_speed_${sc.val}`, data: sc.val, x: chipX, y: tuningY, w: sW, h: chipH });
    chipX += sW + 5;
  });

  // Sync offset controls on right: [-0.5s], offset display, [+0.5s]
  const offRightX = contentX + contentW;
  const offBtnW = 38;
  const plusX = offRightX - offBtnW;
  const minusX = plusX - offBtnW - 4;

  const isPlusHov = hoveredButtonId === 'media_offset_plus';
  const isMinusHov = hoveredButtonId === 'media_offset_minus';

  // [-0.5s]
  ctx.beginPath();
  ctx.roundRect(minusX, tuningY, offBtnW, chipH, 9);
  ctx.fillStyle = isMinusHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.fillText('-0.5s', minusX + offBtnW / 2, tuningY + chipH / 2);
  interactiveButtons.push({ id: 'media_offset_minus', x: minusX, y: tuningY, w: offBtnW, h: chipH });

  // [+0.5s]
  ctx.beginPath();
  ctx.roundRect(plusX, tuningY, offBtnW, chipH, 9);
  ctx.fillStyle = isPlusHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.fillText('+0.5s', plusX + offBtnW / 2, tuningY + chipH / 2);
  interactiveButtons.push({ id: 'media_offset_plus', x: plusX, y: tuningY, w: offBtnW, h: chipH });

  // Offset status label or reset
  if (curOffset !== 0) {
    const rstW = 18;
    const rstX = minusX - rstW - 4;
    const isRstHov = hoveredButtonId === 'media_offset_reset';
    ctx.beginPath();
    ctx.roundRect(rstX, tuningY, rstW, chipH, 9);
    ctx.fillStyle = isRstHov ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '9px "Segoe UI Symbol", sans-serif';
    ctx.fillStyle = '#ef4444';
    ctx.textAlign = 'center';
    ctx.fillText('↺', rstX + rstW / 2, tuningY + chipH / 2);
    interactiveButtons.push({ id: 'media_offset_reset', x: rstX, y: tuningY, w: rstW, h: chipH });

    const offText = `${curOffset > 0 ? '+' : ''}${(curOffset / 1000).toFixed(1)}s`;
    ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = albumAccentColor || '#22c55e';
    ctx.textAlign = 'right';
    ctx.fillText(offText, rstX - 6, tuningY + chipH / 2);
  }
}

// -------------------------------------------------------------
// Clipboard History View (Extended 25-item memory + Search + Pin)
// -------------------------------------------------------------
function renderClipboardView(x, y, w, h) {
  const topY = y + 40;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // Header Title & Count
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`📋 Clipboard History (${clipboardHistory.length})`, contentX, topY + 4);

  // Clear Unpinned Button on top right
  const clrW = 50;
  const clrH = 22;
  const clrX = contentX + contentW - clrW;
  const isClrHov = hoveredButtonId === 'clipboard_clear';
  interactiveButtons.push({ id: 'clipboard_clear', x: clrX, y: topY, w: clrW, h: clrH });
  ctx.beginPath();
  ctx.roundRect(clrX, topY, clrW, clrH, 6);
  ctx.fillStyle = isClrHov ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.fillStyle = isClrHov ? '#f87171' : '#a1a1aa';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Clear', clrX + clrW / 2, topY + clrH / 2);

  // Search Filter Box
  const searchY = topY + 28;
  const searchH = 24;
  ctx.beginPath();
  ctx.roundRect(contentX, searchY, contentW, searchH, 6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = clipboardFilter ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (clipboardFilter) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`🔍 ${clipboardFilter}`, contentX + 8, searchY + searchH / 2);
  } else {
    ctx.fillStyle = '#71717a';
    ctx.fillText('🔍 Type anywhere to search clipboard...', contentX + 8, searchY + searchH / 2);
  }

  // Filtered List
  const filtered = clipboardHistory.filter(c =>
    !clipboardFilter || c.text.toLowerCase().includes(clipboardFilter.toLowerCase())
  );

  const listY = searchY + searchH + 8;
  if (filtered.length === 0) {
    ctx.fillStyle = '#71717a';
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const emptyMsg = clipboardHistory.length === 0
      ? 'No copied text yet. Copy anything with Ctrl+C to store it here!'
      : 'No matching clips found.';
    ctx.fillText(emptyMsg, contentX + contentW / 2, listY + 50);
    return;
  }

  // Render cards (up to 4 visible rows)
  const cardH = 40;
  const cardGap = 6;
  const maxVisible = Math.min(filtered.length, 4);

  for (let i = 0; i < maxVisible; i++) {
    const item = filtered[i];
    const cy = listY + i * (cardH + cardGap);
    const isCardHov = hoveredButtonId === `clip_copy_${item.id}`;
    const isPinHov = hoveredButtonId === `clip_pin_${item.id}`;
    const isCopied = copiedFeedbackId === item.id;

    // Card background
    ctx.beginPath();
    ctx.roundRect(contentX, cy, contentW, cardH, 7);
    ctx.fillStyle = isCopied
      ? 'rgba(34, 197, 94, 0.15)'
      : (isCardHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)');
    ctx.strokeStyle = isCopied
      ? 'rgba(34, 197, 94, 0.5)'
      : (item.pinned ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.06)');
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Pin toggle button on left
    const pinBtnW = 24;
    const pinBtnX = contentX + 6;
    interactiveButtons.push({ id: `clip_pin_${item.id}`, data: item.id, x: pinBtnX, y: cy + 8, w: pinBtnW, h: 24 });
    ctx.font = '11px "Segoe UI Symbol", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = item.pinned ? '#38bdf8' : (isPinHov ? '#ffffff' : '#52525b');
    ctx.fillText(item.pinned ? '📌' : '📍', pinBtnX + pinBtnW / 2, cy + cardH / 2);

    // Text snippet
    const textX = pinBtnX + pinBtnW + 8;
    const maxTextW = contentW - pinBtnW - 88;
    ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const singleLine = item.text.replace(/[\r\n\t]+/g, ' ').trim();
    ctx.fillText(truncateToWidth(singleLine, maxTextW, ctx.font), textX, cy + cardH / 2);

    // Right Action: "✓ Copied" or time ago + copy icon
    const rightX = contentX + contentW - 12;
    if (isCopied) {
      ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#22c55e';
      ctx.textAlign = 'right';
      ctx.fillText('✓ Copied', rightX, cy + cardH / 2);
    } else {
      const ageSec = Math.floor((Date.now() - (item.time || 0)) / 1000);
      const timeStr = ageSec < 60 ? 'just now' : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m` : `${Math.floor(ageSec / 3600)}h`;
      ctx.font = '400 9.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#71717a';
      ctx.textAlign = 'right';
      ctx.fillText(timeStr, rightX, cy + cardH / 2);
    }

    // Click card to re-copy
    interactiveButtons.push({ id: `clip_copy_${item.id}`, data: item.id, x: textX, y: cy, w: contentW - pinBtnW - 14, h: cardH });
  }
}

function renderPromptView(x, y, w, h) {
  if (!pendingPrompt) return;

  ctx.font = '600 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#f59e0b';
  ctx.textAlign = 'left';
  ctx.fillText('⚠️ Agent Permission Request', x + 24, y + 46);

  ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.fillText(pendingPrompt.message || 'Permission needed to execute action', x + 24, y + 70);

  if (pendingPrompt.command) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Command: ${pendingPrompt.command}`, x + 24, y + 90);
  }

  // Allow & Deny Buttons
  const btnW = 90;
  const btnH = 26;
  const btnAllowX = x + w - (2 * btnW + 16) - 24;
  const btnDenyX = btnAllowX + btnW + 16;
  const btnY = y + h - btnH - 16;

  // Allow
  ctx.beginPath();
  ctx.roundRect(btnAllowX, btnY, btnW, btnH, 8);
  ctx.fillStyle = hoveredButtonId === 'prompt_allow' ? '#16a34a' : 'rgba(34, 197, 94, 0.2)';
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('Allow ✓', btnAllowX + btnW / 2, btnY + btnH / 2);
  interactiveButtons.push({ id: 'prompt_allow', data: pendingPrompt.id, x: btnAllowX, y: btnY, w: btnW, h: btnH });

  // Deny
  ctx.beginPath();
  ctx.roundRect(btnDenyX, btnY, btnW, btnH, 8);
  ctx.fillStyle = hoveredButtonId === 'prompt_deny' ? '#dc2626' : 'rgba(239, 68, 68, 0.2)';
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.fillText('Deny ✕', btnDenyX + btnW / 2, btnY + btnH / 2);
  interactiveButtons.push({ id: 'prompt_deny', data: pendingPrompt.id, x: btnDenyX, y: btnY, w: btnW, h: btnH });
}

// -------------------------------------------------------------
// Drop Zone Shelf View (Inside Island / Notch)
// -------------------------------------------------------------
function renderDropZoneView(x, y, w, h) {
  const topY = y + 40;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // Header Title
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`📁 Drop Shelf (${dropZoneFiles.length})`, contentX, topY + 4);

  // Header Actions
  const btnY = topY;
  const btnH = 22;

  // + Add button
  const addW = 54;
  const addX = contentX + contentW - 176;
  interactiveButtons.push({ id: 'dropzone_browse', x: addX, y: btnY, w: addW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(addX, btnY, addW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_browse' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = '#f4f4f5';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+ Add', addX + addW / 2, btnY + btnH / 2);

  // Open Folder button
  const fldW = 58;
  const fldX = contentX + contentW - 116;
  interactiveButtons.push({ id: 'dropzone_reveal', x: fldX, y: btnY, w: fldW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(fldX, btnY, fldW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_reveal' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = '#f4f4f5';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('📂 Folder', fldX + fldW / 2, btnY + btnH / 2);

  // Clear All button
  const clrW = 50;
  const clrX = contentX + contentW - 52;
  interactiveButtons.push({ id: 'dropzone_clear', x: clrX, y: btnY, w: clrW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(clrX, btnY, clrW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_clear' ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = hoveredButtonId === 'dropzone_clear' ? '#f87171' : '#a1a1aa';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Clear', clrX + clrW / 2, btnY + btnH / 2);

  // Files Area
  const listY = topY + 30;

  if (dropZoneFiles.length === 0) {
    // Empty Drop Target state
    const emptyH = 160;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.85)' : 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(contentX, listY, contentW, emptyH, 10);
    ctx.fillStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.02)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '24px "Segoe UI Emoji", sans-serif';
    ctx.fillText('📥', contentX + contentW / 2, listY + emptyH / 2 - 20);

    ctx.fillStyle = isDraggingOver ? '#93c5fd' : '#e4e4e7';
    ctx.font = '600 13px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillText(isDraggingOver ? 'Release to shelf files!' : 'Drop files here to store on shelf', contentX + contentW / 2, listY + emptyH / 2 + 8);

    ctx.fillStyle = '#71717a';
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillText('Drag files from desktop, apps, or click + Add', contentX + contentW / 2, listY + emptyH / 2 + 28);
  } else {
    // Full-width vertical rows
    const rowH = 38;
    const rowGap = 6;
    const maxRows = Math.min(dropZoneFiles.length, 3);

    for (let i = 0; i < maxRows; i++) {
      const file = dropZoneFiles[i];
      const ry = listY + i * (rowH + rowGap);
      const isRowHov = hoveredButtonId === `dropzone_row_${i}`;

      // Row clickable target (opens file when row is clicked)
      interactiveButtons.push({ id: `dropzone_row_${i}`, data: file.path || file.name, x: contentX, y: ry, w: contentW - 95, h: rowH });

      // Row background
      ctx.beginPath();
      ctx.roundRect(contentX, ry, contentW, rowH, 8);
      ctx.fillStyle = isRowHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isRowHov ? 'rgba(59, 130, 246, 0.4)' : 'rgba(255, 255, 255, 0.06)';
      ctx.stroke();

      // File Icon Glyph
      const icon = getFileIcon(file.name);
      ctx.font = '16px "Segoe UI Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, contentX + 20, ry + rowH / 2);

      // File Name
      ctx.fillStyle = '#f4f4f5';
      ctx.font = '600 12px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const truncName = truncateText(file.name, 34);
      ctx.fillText(truncName, contentX + 38, ry + rowH / 2 - 6);

      // File Size
      ctx.fillStyle = '#71717a';
      ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillText(formatBytes(file.size), contentX + 38, ry + rowH / 2 + 8);

      // Dedicated Open ↗ Button
      const openBtnW = 54;
      const openBtnH = 22;
      const openBtnX = contentX + contentW - 90;
      const openBtnY = ry + (rowH - openBtnH) / 2;
      const isOpenHov = hoveredButtonId === `dropzone_open_file_${i}`;
      interactiveButtons.push({ id: `dropzone_open_file_${i}`, data: file.path || file.name, x: openBtnX, y: openBtnY, w: openBtnW, h: openBtnH });

      ctx.beginPath();
      ctx.roundRect(openBtnX, openBtnY, openBtnW, openBtnH, 6);
      ctx.fillStyle = isOpenHov ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
      ctx.strokeStyle = isOpenHov ? '#3b82f6' : 'rgba(59, 130, 246, 0.4)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isOpenHov ? '#ffffff' : '#93c5fd';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Open ↗', openBtnX + openBtnW / 2, openBtnY + openBtnH / 2);

      // Delete ✕ Button
      const delX = contentX + contentW - 28;
      const delY = ry + (rowH - 20) / 2;
      const delSize = 20;
      const isDelHov = hoveredButtonId === `dropzone_delete_file_${i}`;
      interactiveButtons.push({ id: `dropzone_delete_file_${i}`, data: file.name, x: delX, y: delY, w: delSize, h: delSize });

      ctx.beginPath();
      ctx.roundRect(delX, delY, delSize, delSize, 5);
      ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.2)' : 'transparent';
      ctx.fill();

      ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
      ctx.font = '700 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', delX + delSize / 2, delY + delSize / 2);
    }

    // Mini Drop Bar at bottom to drop more files
    const barY = listY + maxRows * (rowH + rowGap) + 4;
    const barH = 34;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.85)' : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(contentX, barY, contentW, barH, 6);
    ctx.fillStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.02)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isDraggingOver ? '#93c5fd' : '#71717a';
    ctx.fillText(isDraggingOver ? 'Release to add to shelf!' : '+ Drag more files here to shelf', contentX + contentW / 2, barY + barH / 2);
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return '⚙️';
  if (['js', 'ts', 'py', 'json', 'html', 'css', 'cpp', 'c', 'cs'].includes(ext)) return '📝';
  if (['pdf'].includes(ext)) return '📕';
  return '📄';
}

function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}
