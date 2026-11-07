const fs = require('fs');
let code = fs.readFileSync('src/renderer/canvas-engine.js', 'utf8');

// 1. Require soundFX at top
const oldRequire = `const { ipcRenderer, webUtils } = require('electron');`;
const newRequire = `const { ipcRenderer, webUtils } = require('electron');\nconst { soundFX } = require('./sound-fx');`;

if (!code.includes("require('./sound-fx')")) {
  code = code.replace(oldRequire, newRequire);
}

// 2. Add IPC listener for sound-effects-config
const oldIpcAnchor = `ipcRenderer.on('island-opacity-changed', (event, data) => {
  if (data && typeof data.opacity === 'number') {
    islandOpacity = Math.max(0.40, Math.min(1.0, data.opacity));
  }
});`;

const newIpcBlock = `ipcRenderer.on('island-opacity-changed', (event, data) => {
  if (data && typeof data.opacity === 'number') {
    islandOpacity = Math.max(0.40, Math.min(1.0, data.opacity));
  }
});

ipcRenderer.on('sound-effects-config', (event, data) => {
  if (data) {
    soundFX.setEnabled(data.enabled !== false);
    if (typeof data.volume === 'number') soundFX.setVolume(data.volume);
  }
});`;

if (code.includes(oldIpcAnchor) && !code.includes("ipcRenderer.on('sound-effects-config'")) {
  code = code.replace(oldIpcAnchor, newIpcBlock);
}

// 3. Add lastAnimState variable
const oldAnimSpeedVar = `let animSpeedMultiplier = 1.0; // User-controlled opening/closing speed multiplier\nlet targetProgress = 0.0;`;
const newAnimSpeedVar = `let animSpeedMultiplier = 1.0; // User-controlled opening/closing speed multiplier\nlet targetProgress = 0.0;\nlet lastAnimState = 'resting';`;

if (code.includes(oldAnimSpeedVar) && !code.includes("let lastAnimState = 'resting';")) {
  code = code.replace(oldAnimSpeedVar, newAnimSpeedVar);
}

// 4. In animate(): Sound FX expansion state tracking
const oldLerp = `  // Fluid Spring / Lerp towards targetProgress
  const speed = (targetProgress > animProgress ? 8.5 : 9.5) * animSpeedMultiplier;
  animProgress += (targetProgress - animProgress) * Math.min(1.0, dt * speed);`;

const newLerp = `  // Fluid Spring / Lerp towards targetProgress
  const speed = (targetProgress > animProgress ? 8.5 : 9.5) * animSpeedMultiplier;
  animProgress += (targetProgress - animProgress) * Math.min(1.0, dt * speed);

  // Sound FX expansion state tracking
  if (lastAnimState === 'resting' && targetProgress > 0.4 && animProgress > 0.06) {
    lastAnimState = 'expanded';
    soundFX.play('expand');
  } else if (lastAnimState === 'expanded' && targetProgress < 0.2 && animProgress < 0.28) {
    lastAnimState = 'resting';
    soundFX.play('collapse');
  }`;

if (code.includes(oldLerp) && !code.includes("soundFX.play('expand')")) {
  code = code.replace(oldLerp, newLerp);
}

// 5. In interactiveButtons click: soundFX.play('tap')
const oldClickLoop = `  for (const btn of interactiveButtons) {
    if (pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
      handleButtonClick(btn.id, btn.data);
      return;
    }
  }`;

const newClickLoop = `  for (const btn of interactiveButtons) {
    if (pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
      soundFX.play('tap');
      handleButtonClick(btn.id, btn.data);
      return;
    }
  }`;

if (code.includes(oldClickLoop)) {
  code = code.replace(oldClickLoop, newClickLoop);
}

// 6. In notification-received: soundFX.play('notification')
const oldNotifRecv = `ipcRenderer.on('notification-received', (event, notif) => {
  if (notif && !String(notif.app || '').toLowerCase().includes('antigravity')) {
    activeNotification = notif;
    notificationBannerUntil = performance.now() + 4000;
    if (animProgress < 0.25) {
      currentView = 'notification_banner';
      targetProgress = 1.0;
    }
  }
});`;

const newNotifRecv = `ipcRenderer.on('notification-received', (event, notif) => {
  if (notif && !String(notif.app || '').toLowerCase().includes('antigravity')) {
    activeNotification = notif;
    notificationBannerUntil = performance.now() + 4000;
    soundFX.play('notification');
    if (animProgress < 0.25) {
      currentView = 'notification_banner';
      targetProgress = 1.0;
    }
  }
});`;

if (code.includes(oldNotifRecv)) {
  code = code.replace(oldNotifRecv, newNotifRecv);
}

// 7. In timer & focus countdown zero: soundFX.play('timer_done')
const oldTimerZero = `    if (timerRemainingSec <= 0) {
      timerRemainingSec = 0;
      timerRunning = false;
    }`;

const newTimerZero = `    if (timerRemainingSec <= 0) {
      timerRemainingSec = 0;
      timerRunning = false;
      soundFX.play('timer_done');
    }`;

if (code.includes(oldTimerZero)) {
  code = code.replace(oldTimerZero, newTimerZero);
}

// 8. In file drop: soundFX.play('drop')
const oldDrop = `window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;`;

const newDrop = `window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;
  soundFX.play('drop');`;

if (code.includes(oldDrop)) {
  code = code.replace(oldDrop, newDrop);
}

fs.writeFileSync('src/renderer/canvas-engine.js', code, 'utf8');
console.log('Successfully patched canvas-engine.js with sound effects');
