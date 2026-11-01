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

  EXPANDED_W: 520,
  HOME_H: 154,
  AGENT_H: 196,
  MEDIA_H: 220,
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
let currentView = 'home'; // 'home' | 'agent' | 'media' | 'dropzone' | 'prompt'
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
  command: '',
  progress: 0
};

let mediaState = {
  isPlaying: false,
  track: {
    title: 'No media playing',
    artist: 'Open Liner, Spotify, or Media Player',
    source: 'none',
    lyrics: [],
    currentLyric: ''
  }
};
let pendingPrompt = null; // { id, agent, command, file, message }

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
    if (mediaState.isPlaying) currentView = 'media';
    else if (hasActiveAgent()) currentView = 'agent';
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

function getRestingWidth() {
  if (hasActiveAgent()) {
    return UI.ACTIVE_REST_W;
  }

  if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    const hasLyric = !!(mediaState.track.currentLyric && mediaState.track.currentLyric.trim());
    const textToShow = hasLyric ? mediaState.track.currentLyric.trim() : mediaState.track.title.trim();

    ctx.save();
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    const textW = ctx.measureText(textToShow).width;
    ctx.restore();

    // 12 (pad) + 48 (clock) + 10 (gap) + 14 (icon) + 18 (gap) + textW + 14 (gap) + 12 (dot) + 16 (pad) = 144 + textW
    const needed = 144 + textW;
    // Allow pill to smoothly extend up to 360px so longer song titles/lyrics fit naturally
    return Math.max(180, Math.min(360, Math.round(needed)));
  }

  return UI.REST_W;
}

function getTargetWidth(p) {
  const restW = getRestingWidth();
  return restW + (UI.EXPANDED_W - restW) * easeOutQuart(p);
}

function getTargetHeight(p) {
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
    expH = UI.MEDIA_H;
  } else if (currentView === 'dropzone') {
    expH = UI.DROPZONE_H;
  } else if (currentView === 'prompt') {
    expH = UI.PROMPT_H;
  }

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

  if (hasActiveAgent()) {
    const projs = getActiveProjects();
    const activeProjs = projs.filter(p => ['running', 'thinking', 'waiting'].includes(p.status));
    const listToRender = activeProjs.length > 0 ? activeProjs : [projs[0]];
    const maxStack = Math.min(4, listToRender.length);

    for (let row = 0; row < maxStack; row++) {
      const proj = listToRender[row];
      const rowH = row === 0 ? UI.ACTIVE_BAR_H : 32;
      const rowGap = 5;
      const rowY = row === 0 ? y : (y + UI.ACTIVE_BAR_H + (row - 1) * (32 + rowGap) + rowGap);
      const rowX = x;
      const rowW = w;
      const rowRadius = UI.COMPACT_RADIUS;

      // Draw secondary stacked pill background and rim if row > 0
      if (row > 0) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;

        const rowGrad = ctx.createLinearGradient(rowX, rowY, rowX, rowY + rowH);
        rowGrad.addColorStop(0.0, '#101014');
        rowGrad.addColorStop(0.5, '#08080a');
        rowGrad.addColorStop(1.0, '#020204');

        ctx.beginPath();
        ctx.roundRect(rowX, rowY, rowW, rowH, rowRadius);
        ctx.fillStyle = rowGrad;
        ctx.fill();
        ctx.restore();

        // 1px Glass edge
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(rowX, rowY, rowW, rowH, rowRadius);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.stroke();
        ctx.restore();
      }

      // 1. Digital clock (only on top row 0)
      if (row === 0) {
        ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
        ctx.fillStyle = '#e4e4e7';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeStr, rowX + 12, rowY + rowH / 2);
      }

      // 2. Antigravity official logo
      const logoX = row === 0 ? (rowX + 64) : (rowX + 16);
      if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
        ctx.drawImage(antigravityLogo, logoX, rowY + (rowH - 16) / 2, 16, 16);
      }

      // 3. Project label
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const projLabel = (proj && proj.project) ? proj.project : 'Antigravity';
      const truncLabel = projLabel.length > 12 ? projLabel.slice(0, 11) + '…' : projLabel;
      ctx.fillText(truncLabel, logoX + 20, rowY + rowH / 2);

      // 4. Mini 4-Segment Progress Bar in this row
      const prog = getAntigravityProgress(proj);
      const miniSegW = 10;
      const miniSegH = 3;
      const miniGap = 3;
      const miniStartX = rowX + rowW - 76;
      const miniY = rowY + (rowH - miniSegH) / 2;

      for (let i = 0; i < 4; i++) {
        const sx = miniStartX + i * (miniSegW + miniGap);
        ctx.beginPath();
        ctx.roundRect(sx, miniY, miniSegW, miniSegH, 1.5);
        if (prog.segments[i]) {
          ctx.fillStyle = '#22c55e'; // Finished segment filled with vibrant green
        } else if (prog.activeSegment === i) {
          ctx.fillStyle = '#38bdf8'; // Active segment pulsing cyan
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        }
        ctx.fill();
      }

      // 5. Traffic light indicator dot for this row
      const dotX = rowX + rowW - 14;
      const dotY = rowY + rowH / 2;
      renderTrafficLightDot(dotX, dotY, proj ? proj.status : 'running');

      // Clickable target to open Antigravity view
      interactiveButtons.push({ id: 'nav_agent', x: rowX, y: rowY, w: rowW, h: rowH });
    }
  } else if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    // Media Playing in Resting Pill (Liner / Spotify)
    // 1. Digital Clock on left
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, x + 12, y + h / 2);
    const clockW = ctx.measureText(timeStr).width;

    // 2. Music Icon
    const iconX = x + 12 + clockW + 10;
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#22c55e';
    ctx.fillText('🎵', iconX, y + h / 2);

    // 3. Audio traffic light dot on far right
    const dotX = x + w - 16;
    const dotY = y + h / 2;
    renderTrafficLightDot(dotX, dotY, 'running');

    // 4. Text (Current Live Lyric or Song Title)
    const textStartX = iconX + 18;
    const maxTextW = Math.max(20, dotX - 14 - textStartX); // STRICT BOUNDARY: stops 14px before dot

    const hasLyric = !!(mediaState.track.currentLyric && mediaState.track.currentLyric.trim());
    const fullText = hasLyric ? mediaState.track.currentLyric.trim() : mediaState.track.title.trim();

    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = hasLyric ? '#22c55e' : '#f4f4f5'; // Vibrant green highlight when showing synced lyric, crisp white for title

    const fittedText = truncateToWidth(fullText, maxTextW, ctx.font);
    ctx.fillText(fittedText, textStartX, y + h / 2);
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
  } else if (currentView === 'prompt') {
    renderPromptView(x, y, w, h);
  }

  ctx.restore();
}

function renderTopNav(x, y, w) {
  const navItems = [
    { id: 'nav_home', label: 'Home' },
    { id: 'nav_agent', label: 'Antigravity' },
    { id: 'nav_media', label: 'Media & Lyrics' },
    { id: 'nav_dropzone', label: 'Drop Shelf' },
    { id: 'nav_settings', label: 'Settings' }
  ];

  const pillH = 22;
  const pillW = 76;
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
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayMode === 'island' ? '⌃ Notch' : '⌄ Island', modeX + modeW / 2, topY + modeH / 2);
  interactiveButtons.push({ id: 'toggle_display_mode', x: modeX, y: topY, w: modeW, h: modeH });
}

function renderHomeView(x, y, w, h) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  // Digital Clock on Left
  ctx.font = '700 28px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(timeStr, x + 24, y + 54);

  ctx.font = '400 12px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(dateStr, x + 24, y + 74);

  // Antigravity Live Activity Card on Right
  const cardX = x + w - 280;
  const cardY = y + 42;
  const cardW = 256;
  const cardH = 96;

  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 12);
  ctx.fillStyle = 'rgba(24, 24, 32, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // Logo + Status
  if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
    ctx.drawImage(antigravityLogo, cardX + 12, cardY + 12, 18, 18);
  }

  ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText('Google Antigravity', cardX + 36, cardY + 22);

  renderTrafficLightDot(cardX + cardW - 16, cardY + 22, antigravityState.status);

  // 4-Segment Progress Bar inside Home Card
  const prog = getAntigravityProgress(antigravityState);
  const barW = cardW - 24;
  const segW = (barW - 3 * 4) / 4;
  const segH = 4;
  const segY = cardY + 38;

  for (let i = 0; i < 4; i++) {
    const sx = cardX + 12 + i * (segW + 4);
    ctx.beginPath();
    ctx.roundRect(sx, segY, segW, segH, 2);
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
  ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#e2e8f0';
  const phaseText = antigravityState.phase || 'Agent Ready';
  ctx.fillText(phaseText.length > 28 ? phaseText.slice(0, 28) + '...' : phaseText, cardX + 12, cardY + 58);

  // Active tool badge
  if (antigravityState.tool) {
    ctx.font = '500 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    const toolText = `⚙ ${antigravityState.tool}`;
    ctx.fillText(toolText.length > 18 ? toolText.slice(0, 18) + '...' : toolText, cardX + 12, cardY + 76);
  }

  // Jump Button (Open Antigravity)
  const isRunning = antigravityState.status !== 'not_running';
  const btnJumpW = 68;
  const btnJumpH = 20;
  const btnJumpX = cardX + cardW - btnJumpW - 10;
  const btnJumpY = cardY + cardH - btnJumpH - 10;

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
    const projTitle = (proj.project && proj.project !== 'Antigravity') ? `✦ Google Antigravity: ${proj.project}` : '✦ Google Antigravity Real-Time Monitor';
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
// Media View with Liner Player & Synced Lyrics Output
// -------------------------------------------------------------
function renderMediaView(x, y, w, h) {
  const topY = y + 40;
  const contentW = w - 48;
  const contentX = x + 24;

  const track = mediaState.track || { title: 'No media playing', artist: 'Open Liner, Spotify, or Media Player', source: 'none', lyrics: [] };
  const isLiner = track.source === 'Liner';

  // Player Source Badge
  ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = isLiner ? '#22c55e' : '#38bdf8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(isLiner ? '🎵 Liner Player (Synced Lyrics)' : '🎵 Spotify & Windows Media', contentX, topY);

  // Track Title & Artist
  ctx.font = '700 14px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  const songTitle = track.title || 'No media playing';
  ctx.fillText(songTitle.length > 36 ? songTitle.slice(0, 36) + '...' : songTitle, contentX, topY + 20);

  ctx.font = '400 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(track.artist || 'Unknown Artist', contentX, topY + 40);

  // -----------------------------------------------------------
  // Live Lyrics Card (Outputs lyrics detected from Liner)
  // -----------------------------------------------------------
  const lyricsY = topY + 62;
  const lyricsH = 58;

  ctx.beginPath();
  ctx.roundRect(contentX, lyricsY, contentW, lyricsH, 8);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.strokeStyle = isLiner && track.lyrics && track.lyrics.length > 0 ? 'rgba(34, 197, 94, 0.25)' : 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  if (track.lyrics && track.lyrics.length > 0) {
    const curLine = track.currentLyric || track.lyrics[0];
    const curIdx = track.lyrics.indexOf(curLine);
    const nextLine = (curIdx >= 0 && curIdx + 1 < track.lyrics.length) ? track.lyrics[curIdx + 1] : '';

    // Active lyric line
    ctx.font = '600 12.5px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#22c55e'; // Vibrant green highlight for current lyric
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const cleanCur = curLine.length > 48 ? curLine.slice(0, 48) + '...' : curLine;
    ctx.fillText(`♪  ${cleanCur}`, contentX + 12, lyricsY + 10);

    // Next upcoming line (subtle muted)
    if (nextLine) {
      ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#71717a';
      const cleanNext = nextLine.length > 54 ? nextLine.slice(0, 54) + '...' : nextLine;
      ctx.fillText(cleanNext, contentX + 26, lyricsY + 32);
    }
  } else {
    // Waiting for lyrics message
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#71717a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('♪ Play any track in Liner to sync lyrics automatically in this space', contentX + 12, lyricsY + 22);
  }

  // -----------------------------------------------------------
  // Media Controls Row
  // -----------------------------------------------------------
  const controls = [
    { id: 'media_prev', label: '⏮' },
    { id: 'media_play_pause', label: mediaState.isPlaying ? '⏸' : '▶' },
    { id: 'media_next', label: '⏭' }
  ];

  const cW = 38;
  const cH = 28;
  const cSpacing = 12;
  const startCX = contentX + (contentW - (3 * cW + 2 * cSpacing)) / 2;
  const cY = lyricsY + lyricsH + 10;

  controls.forEach((c, idx) => {
    const cx = startCX + idx * (cW + cSpacing);
    const isHov = hoveredButtonId === c.id;

    ctx.beginPath();
    ctx.roundRect(cx, cY, cW, cH, 6);
    ctx.fillStyle = isHov ? '#2563eb' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    ctx.font = '13px "Segoe UI Symbol", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
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
