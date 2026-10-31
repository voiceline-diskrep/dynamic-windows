'use strict';

const { ipcRenderer, webUtils } = require('electron');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// TwoCode-inspired Island Dimensions & Constants
const UI = {
  REST_W: 124,
  BAR_H: 32,
  ACTIVE_REST_W: 216,
  ACTIVE_BAR_H: 36,

  EXPANDED_W: 520,
  HOME_H: 148,
  APPS_H: 230,
  AGENT_H: 156,
  MEDIA_H: 170,
  DROPZONE_H: 260,
  PROMPT_H: 150,

  COMPACT_RADIUS: 16,
  EXPANDED_RADIUS: 28,

  LEAVE_DELAY: 260
};

// State
let displayMode = 'island'; // 'island' | 'notch'
let animProgress = 0.0; // 0.0 = resting, 1.0 = expanded
let targetProgress = 0.0;
let isHovered = false;
let currentView = 'home'; // 'home' | 'apps' | 'agent' | 'media' | 'dropzone' | 'prompt'
let leaveTimer = null;
let dropZoneFiles = [];
let isDraggingOver = false;

let antigravityState = {
  status: 'idle', // 'idle' | 'running' | 'thinking' | 'waiting' | 'done' | 'error'
  provider: 'Google Antigravity',
  phase: 'Ready',
  task: '',
  tool: '',
  file: '',
  command: ''
};

let presets = [];
let mediaState = { isPlaying: false, track: { title: 'No track playing', artist: 'Windows Media / Spotify' } };
let pendingPrompt = null; // { id, agent, command, file, message }

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
  if (e.dataTransfer && e.dataTransfer.files) {
    for (const file of e.dataTransfer.files) {
      const filePath = (webUtils && typeof webUtils.getPathForFile === 'function')
        ? webUtils.getPathForFile(file)
        : file.path;
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

canvas.addEventListener('click', (e) => {
  const cx = e.clientX;
  const cy = e.clientY;

  for (const btn of interactiveButtons) {
    if (pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
      handleButtonClick(btn.id, btn.data);
      return;
    }
  }

  // Click on resting badge or main body
  if (animProgress < 0.3) {
    targetProgress = 1.0;
  }
});

function handleButtonClick(id, data) {
  if (id === 'nav_home') {
    currentView = 'home';
  } else if (id === 'nav_apps') {
    currentView = 'apps';
  } else if (id === 'nav_agent') {
    currentView = 'agent';
  } else if (id === 'nav_media') {
    currentView = 'media';
  } else if (id === 'nav_dropzone') {
    currentView = 'dropzone';
  } else if (id === 'nav_settings') {
    ipcRenderer.send('open-settings');
  } else if (id === 'toggle_display_mode') {
    displayMode = displayMode === 'island' ? 'notch' : 'island';
    ipcRenderer.send('set-display-mode', displayMode);
  } else if (id === 'dropzone_reveal') {
    ipcRenderer.send('open-dropzone');
  } else if (id === 'dropzone_clear') {
    ipcRenderer.send('dropzone-clear-all');
  } else if (id === 'dropzone_browse') {
    ipcRenderer.send('dropzone-browse-file');
  } else if (id === 'dropzone_open_file') {
    ipcRenderer.send('dropzone-open-file', data);
  } else if (id === 'dropzone_delete_file') {
    ipcRenderer.send('dropzone-delete-file', data);
  } else if (id === 'jump_antigravity') {
    ipcRenderer.send('focus-antigravity');
  } else if (id === 'media_play_pause') {
    ipcRenderer.send('media-play-pause');
  } else if (id === 'media_next') {
    ipcRenderer.send('media-next');
  } else if (id === 'media_prev') {
    ipcRenderer.send('media-prev');
  } else if (id === 'launch_preset') {
    ipcRenderer.send('launch-preset', data);
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

ipcRenderer.on('presets-list', (event, list) => {
  presets = list;
});

ipcRenderer.on('media-state', (event, state) => {
  mediaState = state;
});

ipcRenderer.on('dropzone-files', (event, files) => {
  dropZoneFiles = files || [];
});

ipcRenderer.on('display-mode', (event, mode) => {
  displayMode = mode || 'island';
});

ipcRenderer.on('permission-prompt', (event, prompt) => {
  pendingPrompt = prompt;
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
  const speed = targetProgress > animProgress ? 8.5 : 9.5;
  animProgress += (targetProgress - animProgress) * Math.min(1.0, dt * speed);

  // Send window size updates to Electron Main
  const currentHeight = getTargetHeight(animProgress);
  const currentWidth = getTargetWidth(animProgress);
  ipcRenderer.send('window-bounds-update', {
    width: Math.round(currentWidth),
    height: Math.round(currentHeight)
  });

  render();
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function hasActiveAgent() {
  return antigravityState.status === 'running' ||
         antigravityState.status === 'thinking' ||
         antigravityState.status === 'waiting' ||
         pendingPrompt !== null;
}

function getTargetWidth(p) {
  const restW = hasActiveAgent() ? UI.ACTIVE_REST_W : UI.REST_W;
  return restW + (UI.EXPANDED_W - restW) * easeOutQuart(p);
}

function getTargetHeight(p) {
  const restH = hasActiveAgent() ? UI.ACTIVE_BAR_H : UI.BAR_H;
  let expH = UI.HOME_H;
  if (currentView === 'apps') expH = UI.APPS_H;
  else if (currentView === 'agent') expH = UI.AGENT_H;
  else if (currentView === 'media') expH = UI.MEDIA_H;
  else if (currentView === 'dropzone') expH = UI.DROPZONE_H;
  else if (currentView === 'prompt') expH = UI.PROMPT_H;

  return restH + (expH - restH) * easeOutQuart(p);
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  interactiveButtons = [];

  const p = Math.max(0, Math.min(1, animProgress));
  const w = getTargetWidth(p);
  const h = getTargetHeight(p);
  const x = (window.innerWidth - w) / 2;
  const isNotch = displayMode === 'notch';
  const y = isNotch ? 0 : 8; // Flush with top for notch, floating for island

  const radius = UI.COMPACT_RADIUS + (UI.EXPANDED_RADIUS - UI.COMPACT_RADIUS) * p;
  const radii = isNotch ? [0, 0, radius, radius] : radius;

  // 1. Ambient Drop Shadow
  ctx.save();
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
  ctx.restore();

  // 3. Specular Border Rim (1px Glass Edge)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
  ctx.lineWidth = 1;
  ctx.strokeStyle = isDraggingOver ? 'rgba(59, 130, 246, 0.85)' : `rgba(255, 255, 255, ${0.12 + 0.12 * p})`;
  ctx.stroke();
  ctx.restore();

  // 4. Render Views
  if (p < 0.28) {
    renderRestingPill(x, y, w, h, (0.28 - p) / 0.28);
  } else if (p > 0.35) {
    const alpha = (p - 0.35) / 0.65;
    renderExpandedView(x, y, w, h, alpha);
  }
}

// -------------------------------------------------------------
// Resting Pill View (Minimalist & Clean)
// -------------------------------------------------------------
function renderRestingPill(x, y, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (!hasActiveAgent()) {
    // Pure minimalist clock
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, x + w / 2, y + h / 2);
  } else {
    // Digital clock on left
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, x + 14, y + h / 2);

    // Antigravity official logo
    if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
      ctx.drawImage(antigravityLogo, x + 72, y + (h - 16) / 2, 16, 16);
    }

    // Traffic light indicator dot
    const dotX = x + w - 20;
    const dotY = y + h / 2;
    renderTrafficLightDot(dotX, dotY, antigravityState.status);

    // Active status text
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.fillText('Antigravity', x + 94, y + h / 2);
  }

  ctx.restore();
}

function renderTrafficLightDot(dx, dy, status) {
  let color = '#22c55e'; // Green (done / idle)
  let pulse = false;

  if (status === 'running') {
    color = '#f59e0b'; // Amber / Orange
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
    ctx.fillStyle = color.replace(')', `, ${0.3 * pulseFactor})`).replace('rgb', 'rgba').replace('#f59e0b', 'rgba(245, 158, 11, 0.35)');
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
  } else if (currentView === 'apps') {
    renderAppsView(x, y, w, h);
  } else if (currentView === 'agent') {
    renderAgentView(x, y, w, h);
  } else if (currentView === 'media') {
    renderMediaView(x, y, w, h);
  } else if (currentView === 'dropzone') {
    renderDropZoneView(x, y, w, h);
  } else if (currentView === 'prompt') {
    renderPromptView(x, y, w, h);
  }

  ctx.restore();
}

function renderTopNav(x, y, w) {
  const navItems = [
    { id: 'nav_home', label: 'Home' },
    { id: 'nav_apps', label: 'One-Shot' },
    { id: 'nav_agent', label: 'Antigravity' },
    { id: 'nav_media', label: 'Media' },
    { id: 'nav_dropzone', label: 'Shelf' },
    { id: 'nav_settings', label: 'Settings' }
  ];

  const pillH = 22;
  const pillW = 58;
  const spacing = 5;
  const startX = x + 16;
  const topY = y + 12;

  navItems.forEach((item, idx) => {
    const px = startX + idx * (pillW + spacing);
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

  // Display Mode Quick Switcher (Notch vs Island)
  const modeW = 74;
  const modeH = 22;
  const modeX = x + w - modeW - 16;
  const isModeHov = hoveredButtonId === 'toggle_display_mode';

  ctx.beginPath();
  ctx.roundRect(modeX, topY, modeW, modeH, 11);
  ctx.fillStyle = isModeHov ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#93c5fd';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayMode === 'notch' ? '💻 Notch' : '🏝️ Island', modeX + modeW / 2, topY + modeH / 2);

  interactiveButtons.push({ id: 'toggle_display_mode', x: modeX, y: topY, w: modeW, h: modeH });
}

function renderHomeView(x, y, w, h) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  // Clock
  ctx.font = '600 18px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(timeStr, x + 24, y + 46);

  ctx.font = '400 12px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(dateStr, x + 24, y + 70);

  // Antigravity Live Activity Card on Right
  const cardX = x + w - 270;
  const cardY = y + 42;
  const cardW = 246;
  const cardH = 88;

  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 12);
  ctx.fillStyle = 'rgba(24, 24, 32, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // Logo + Status
  if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
    ctx.drawImage(antigravityLogo, cardX + 12, cardY + 12, 20, 20);
  }

  ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText('Google Antigravity', cardX + 38, cardY + 22);

  renderTrafficLightDot(cardX + cardW - 16, cardY + 22, antigravityState.status);

  // Phase text
  ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#e2e8f0';
  const phaseText = antigravityState.phase || 'Agent Ready';
  ctx.fillText(phaseText.length > 32 ? phaseText.slice(0, 32) + '...' : phaseText, cardX + 12, cardY + 50);

  // Jump Button (Open Antigravity)
  const isRunning = antigravityState.status !== 'not_running';
  const btnJumpW = 74;
  const btnJumpH = 22;
  const btnJumpX = cardX + cardW - btnJumpW - 10;
  const btnJumpY = cardY + cardH - btnJumpH - 10;

  ctx.beginPath();
  ctx.roundRect(btnJumpX, btnJumpY, btnJumpW, btnJumpH, 6);
  if (isRunning) {
    ctx.fillStyle = hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.25)';
    ctx.strokeStyle = '#3b82f6';
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  }
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isRunning ? '#ffffff' : '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isRunning ? 'Open ➔' : 'Not Running', btnJumpX + btnJumpW / 2, btnJumpY + btnJumpH / 2);
  if (isRunning) {
    interactiveButtons.push({ id: 'jump_antigravity', x: btnJumpX, y: btnJumpY, w: btnJumpW, h: btnJumpH });
  }
}

function renderAppsView(x, y, w, h) {
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText('⚡ One-Shot Presets (1-Click Launch)', x + 24, y + 46);

  const startY = y + 68;
  const cardW = 146;
  const cardH = 138;
  const spacing = 14;

  presets.slice(0, 3).forEach((preset, idx) => {
    const px = x + 24 + idx * (cardW + spacing);
    const isHov = hoveredButtonId === `preset_${preset.id}`;

    ctx.beginPath();
    ctx.roundRect(px, startY, cardW, cardH, 12);
    ctx.fillStyle = isHov ? 'rgba(37, 99, 235, 0.25)' : 'rgba(24, 24, 30, 0.8)';
    ctx.strokeStyle = isHov ? '#3b82f6' : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '24px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(preset.icon || '⚡', px + cardW / 2, startY + 36);

    ctx.font = '600 13px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(preset.name, px + cardW / 2, startY + 68);

    ctx.font = '400 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${preset.apps.length} applications`, px + cardW / 2, startY + 86);

    // Launch pill button
    const lW = 86;
    const lH = 22;
    const lX = px + (cardW - lW) / 2;
    const lY = startY + 104;

    ctx.beginPath();
    ctx.roundRect(lX, lY, lW, lH, 11);
    ctx.fillStyle = isHov ? '#2563eb' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    ctx.font = '600 10px "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Launch All ➔', lX + lW / 2, lY + lH / 2);

    interactiveButtons.push({
      id: `preset_${preset.id}`,
      data: preset.id,
      x: px,
      y: startY,
      w: cardW,
      h: cardH
    });
  });
}

function renderAgentView(x, y, w, h) {
  ctx.font = '600 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText('✦ Google Antigravity Real-Time Monitor', x + 24, y + 46);

  ctx.font = '400 12px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(`Active Tool: ${antigravityState.tool || 'None'}`, x + 24, y + 74);
  ctx.fillText(`Current Phase: ${antigravityState.phase || 'Idle'}`, x + 24, y + 96);

  if (antigravityState.command) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Shell: ${antigravityState.command}`, x + 24, y + 118);
  }

  // Jump to IDE window button
  const jW = 120;
  const jH = 28;
  const jX = x + w - jW - 24;
  const jY = y + 74;

  ctx.beginPath();
  ctx.roundRect(jX, jY, jW, jH, 8);
  ctx.fillStyle = hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('Focus Window ↗', jX + jW / 2, jY + jH / 2);
  interactiveButtons.push({ id: 'jump_antigravity', x: jX, y: jY, w: jW, h: jH });
}

function renderMediaView(x, y, w, h) {
  ctx.font = '600 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText('🎵 Spotify & Windows Media', x + 24, y + 46);

  ctx.font = '600 13px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(mediaState.track.title, x + 24, y + 76);

  ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(mediaState.track.artist, x + 24, y + 96);

  // Media Controls Row
  const controls = [
    { id: 'media_prev', label: '⏮' },
    { id: 'media_play_pause', label: mediaState.isPlaying ? '⏸' : '▶' },
    { id: 'media_next', label: '⏭' }
  ];

  const cW = 38;
  const cH = 32;
  const cSpacing = 12;
  const startCX = x + (w - (3 * cW + 2 * cSpacing)) / 2;
  const cY = y + 120;

  controls.forEach((c, idx) => {
    const cx = startCX + idx * (cW + cSpacing);
    const isHov = hoveredButtonId === c.id;

    ctx.beginPath();
    ctx.roundRect(cx, cY, cW, cH, 8);
    ctx.fillStyle = isHov ? '#2563eb' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    ctx.font = '14px "Segoe UI Symbol", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(c.label, cx + cW / 2, cY + cH / 2);

    interactiveButtons.push({ id: c.id, x: cx, y: cY, w: cW, h: cH });
  });
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
      const isRowHov = hoveredButtonId === `row_${i}` || hoveredButtonId === `file_open_${i}`;

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
      interactiveButtons.push({ id: 'dropzone_open_file', data: file.name, x: openBtnX, y: openBtnY, w: openBtnW, h: openBtnH });

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
      interactiveButtons.push({ id: 'dropzone_delete_file', data: file.name, x: delX, y: delY, w: delSize, h: delSize });

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
