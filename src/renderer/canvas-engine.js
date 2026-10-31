'use strict';

const { ipcRenderer } = require('electron');

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
  PROMPT_H: 150,

  COMPACT_RADIUS: 16,
  EXPANDED_RADIUS: 28,

  LEAVE_DELAY: 260
};

// State
let animProgress = 0.0; // 0.0 = resting, 1.0 = expanded
let targetProgress = 0.0;
let isHovered = false;
let currentView = 'home'; // 'home' | 'apps' | 'agent' | 'media' | 'prompt'
let leaveTimer = null;

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

canvas.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

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

canvas.addEventListener('mouseenter', () => {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  isHovered = true;
  targetProgress = 1.0;
  ipcRenderer.send('island-hover-start');
});

canvas.addEventListener('mouseleave', () => {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    isHovered = false;
    targetProgress = 0.0;
    currentView = 'home';
    ipcRenderer.send('island-hover-end');
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
    ipcRenderer.send('open-dropzone');
  } else if (id === 'nav_settings') {
    ipcRenderer.send('open-settings');
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
  const y = 6; // Floating gap from top

  const radius = UI.COMPACT_RADIUS + (UI.EXPANDED_RADIUS - UI.COMPACT_RADIUS) * p;

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
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // 3. Specular Border Rim (1px Glass Edge)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.12 + 0.12 * p})`;
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
    { id: 'nav_dropzone', label: 'Drop Zone' },
    { id: 'nav_settings', label: 'Settings' }
  ];

  const pillH = 22;
  const pillW = 66;
  const spacing = 6;
  const totalW = navItems.length * pillW + (navItems.length - 1) * spacing;
  const startX = x + (w - totalW) / 2;
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

  // Jump Button
  const btnJumpW = 60;
  const btnJumpH = 20;
  const btnJumpX = cardX + cardW - btnJumpW - 10;
  const btnJumpY = cardY + cardH - btnJumpH - 10;

  ctx.beginPath();
  ctx.roundRect(btnJumpX, btnJumpY, btnJumpW, btnJumpH, 6);
  ctx.fillStyle = hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
  ctx.strokeStyle = '#3b82f6';
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 9px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('Open ➔', btnJumpX + btnJumpW / 2, btnJumpY + btnJumpH / 2);
  interactiveButtons.push({ id: 'jump_antigravity', x: btnJumpX, y: btnJumpY, w: btnJumpW, h: btnJumpH });
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
