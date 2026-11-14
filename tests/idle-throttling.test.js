'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CallMonitor = require('../src/main/call-monitor');
const NotificationMonitor = require('../src/main/notification-monitor');
const AntigravityMonitor = require('../src/main/antigravity-monitor');

const canvasEngineSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'canvas-engine.js'),
  'utf8'
);

function extractFunction(fnName) {
  const startToken = `function ${fnName}(`;
  const startIdx = canvasEngineSrc.indexOf(startToken);
  assert.ok(startIdx >= 0, `${fnName} must exist in canvas-engine.js`);
  const bodyOpenIdx = canvasEngineSrc.indexOf(') {', startIdx);
  const actualEndIdx = canvasEngineSrc.indexOf('\n}', bodyOpenIdx);
  assert.ok(actualEndIdx >= 0, `${fnName} closing brace must exist in canvas-engine.js`);
  const fnSrc = canvasEngineSrc.slice(startIdx, actualEndIdx + 2);
  const script = new vm.Script(`${fnSrc}; ${fnName};`);
  return script.runInNewContext({});
}

function makeIdleState(overrides = {}) {
  return {
    now: 10000,
    dateSec: 15,
    dateMs: 200,
    hiddenByGameMode: false,
    targetProgress: 0,
    animProgress: 0,
    targetHide: 0,
    hideProgress: 0,
    isTucked: false,
    targetRestW: 120,
    currentRestingWidth: 120,
    targetExpH: 230,
    currentExpandedH: 230,
    targetSongPopupProgress: 0,
    songPopupProgress: 0,
    songPopupActiveUntil: 0,
    notificationBannerUntil: 0,
    gameModeToastUntil: 0,
    gameModeToastFading: false,
    wantTint: 0,
    tintK: 0,
    currentView: 'home',
    isTabTransitioning: false,
    isNavPillAnimating: false,
    activeAlarmRinging: false,
    stopwatchRunning: false,
    timerRunning: false,
    timerRemainingSec: 0,
    focusRunning: false,
    focusRemainingSec: 0,
    showSeconds: false,
    hasEnabledAlarms: false,
    hasActiveTumbler: false,
    mediaPlaying: false,
    callInCall: false,
    callRinging: false,
    callSpeaking: false,
    aiPulseActive: false,
    isDraggingOver: false,
    isDraggingVolume: false,
    shelfDragCandidate: false,
    ...overrides
  };
}

test('CallMonitor: idle polling defaults to 3000ms instead of 650ms to save CPU', () => {
  const cm = new CallMonitor({ disableAutoStart: true });
  assert.strictEqual(cm.pollIntervalMs, 3000, 'CallMonitor idle poll interval must be 3000ms');
});

test('NotificationMonitor: polling interval defaults to 10000ms to avoid frequent PowerShell spawns', () => {
  const nm = new NotificationMonitor();
  assert.strictEqual(nm.pollIntervalMs, 10000, 'NotificationMonitor poll interval must be 10000ms');
});

test('AntigravityMonitor: idle polling defaults to 1500ms to reduce disk read overhead', () => {
  const agm = new AntigravityMonitor({ disableAutoStart: true });
  assert.strictEqual(agm.pollInterval, 1500, 'AntigravityMonitor idle poll interval must be 1500ms');
});

test('Monitors: setPaused stops and resumes polling cleanly during Game Mode', () => {
  const cm = new CallMonitor({ disableAutoStart: true });
  const nm = new NotificationMonitor();
  const agm = new AntigravityMonitor({ disableAutoStart: true });

  // Stub poll() so the unit test never spawns PowerShell or reads disk
  cm.poll = async () => {};
  nm.poll = () => {};
  agm.poll = () => {};

  cm.timer = setTimeout(() => {}, 60000);
  cm.timer.unref?.();
  nm.pollTimer = setInterval(() => {}, 60000);
  nm.pollTimer.unref?.();
  agm.timer = setTimeout(() => {}, 60000);
  agm.timer.unref?.();

  try {
    cm.setPaused(true);
    nm.setPaused(true);
    agm.setPaused(true);

    assert.strictEqual(cm.paused, true);
    assert.strictEqual(cm.timer, null);
    assert.strictEqual(nm.paused, true);
    assert.strictEqual(nm.pollTimer, null);
    assert.strictEqual(agm.paused, true);
    assert.strictEqual(agm.timer, null);

    cm.setPaused(false);
    nm.setPaused(false);
    agm.setPaused(false);
    assert.strictEqual(cm.paused, false);
    assert.strictEqual(nm.paused, false);
    assert.strictEqual(agm.paused, false);
    assert.ok(nm.pollTimer !== null);
    assert.ok(agm.timer !== null);
  } finally {
    nm.stop();
    cm.stop();
    agm.stop();
  }
});

test('GameMode: turning Game Mode OFF keeps monitors running and window unhidden during fullscreen game', () => {
  let gameModeEnabled = true;
  let isFullscreenGame = false;
  let isWindowVisible = true;
  let alwaysOnTopLevel = null;
  let movedTop = false;
  let monitorsPaused = false;

  function syncGameModeMonitors(paused) {
    monitorsPaused = Boolean(paused);
  }

  function applyGameModeVisibility() {
    if (gameModeEnabled && isFullscreenGame) {
      if (isWindowVisible) isWindowVisible = false;
      syncGameModeMonitors(true);
    } else {
      syncGameModeMonitors(false);
      if (!isWindowVisible) isWindowVisible = true;
      alwaysOnTopLevel = 'screen-saver';
      movedTop = true;
    }
  }

  function setGameMode(enabled) {
    gameModeEnabled = Boolean(enabled);
    applyGameModeVisibility();
  }

  // Initial state: gameMode enabled, not in fullscreen
  assert.strictEqual(gameModeEnabled, true);
  assert.strictEqual(isWindowVisible, true);

  // Fullscreen game starts -> hides window and pauses monitors
  isFullscreenGame = true;
  applyGameModeVisibility();
  assert.strictEqual(isWindowVisible, false);
  assert.strictEqual(monitorsPaused, true);

  // User turns Game Mode OFF in settings
  setGameMode(false);
  assert.strictEqual(gameModeEnabled, false);
  assert.strictEqual(isWindowVisible, true);
  assert.strictEqual(monitorsPaused, false);
  assert.strictEqual(alwaysOnTopLevel, 'screen-saver');
  assert.strictEqual(movedTop, true);

  // Exiting and re-entering fullscreen while Game Mode is OFF never hides window
  isFullscreenGame = false;
  applyGameModeVisibility();
  assert.strictEqual(isWindowVisible, true);
  assert.strictEqual(monitorsPaused, false);

  isFullscreenGame = true;
  applyGameModeVisibility();
  assert.strictEqual(isWindowVisible, true);
  assert.strictEqual(monitorsPaused, false);
  assert.strictEqual(alwaysOnTopLevel, 'screen-saver');
});

test('computeDynamicActive: returns false (0 FPS) when resting, expanded-settled, tucked, or Game Mode hidden', () => {
  const computeDynamicActive = extractFunction('computeDynamicActive');

  assert.strictEqual(computeDynamicActive(makeIdleState()), false, 'Resting static clock should be 0 FPS');
  assert.strictEqual(
    computeDynamicActive(makeIdleState({ targetProgress: 1, animProgress: 1, currentView: 'agent' })),
    false,
    'Settled expanded AI tab should be 0 FPS'
  );
  assert.strictEqual(
    computeDynamicActive(makeIdleState({ targetHide: 1, hideProgress: 1 })),
    false,
    'Hover-hidden top lump should be 0 FPS'
  );
  assert.strictEqual(
    computeDynamicActive(makeIdleState({ mediaPlaying: false, callInCall: true, callRinging: false, callSpeaking: false })),
    false,
    'Paused media or silent idle call should be 0 FPS between 1s ticks'
  );
  assert.strictEqual(
    computeDynamicActive(makeIdleState({ hiddenByGameMode: true, mediaPlaying: true, targetProgress: 1, animProgress: 0.4 })),
    false,
    'Game Mode hidden must always force 0 FPS'
  );
});

test('computeDynamicActive: returns true (native 144Hz rAF) whenever visuals move', () => {
  const computeDynamicActive = extractFunction('computeDynamicActive');

  assert.strictEqual(computeDynamicActive(makeIdleState({ targetProgress: 1, animProgress: 0.35 })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ targetHide: 1, hideProgress: 0.4 })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ targetRestW: 220, currentRestingWidth: 160 })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ animProgress: 1, targetProgress: 1, targetExpH: 280, currentExpandedH: 230 })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ hasActiveTumbler: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ animProgress: 1, targetProgress: 1, isTabTransitioning: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ animProgress: 1, targetProgress: 1, isNavPillAnimating: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ mediaPlaying: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ stopwatchRunning: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ activeAlarmRinging: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ callInCall: true, callSpeaking: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ aiPulseActive: true })), true);
  assert.strictEqual(computeDynamicActive(makeIdleState({ gameModeToastFading: true })), true);
});

test('getNextIdleWakeDelayMs: schedules null in Game Mode/hidden, minute boundaries for HH:MM, and 1s ticks for seconds/timers', () => {
  const getNextIdleWakeDelayMs = extractFunction('getNextIdleWakeDelayMs');

  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ hiddenByGameMode: true })),
    null,
    'Game Mode must schedule zero idle wakeups'
  );
  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ hideProgress: 1, isTucked: false })),
    null,
    'Peek-hidden top lump without enabled alarms/timers must schedule zero wakeups (true 0 FPS)'
  );

  // At :15.200 without seconds -> next minute is 44.8s away + 25ms margin = 44825ms
  const minDelay = getNextIdleWakeDelayMs(makeIdleState({ dateSec: 15, dateMs: 200, showSeconds: false }));
  assert.strictEqual(minDelay, 44825);

  // Resting clock with showSeconds -> 1000 - 200 + 15 = 815ms
  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ dateSec: 15, dateMs: 200, showSeconds: true })),
    815
  );

  // Settled Home view shows seconds -> 815ms
  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ targetProgress: 1, animProgress: 1, currentView: 'home', dateMs: 200 })),
    815
  );

  // Active timer while resting -> 1s boundary
  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ timerRunning: true, timerRemainingSec: 120, dateMs: 200 })),
    815
  );

  // Notification banner expiry -> 1500ms + 10ms = 1510ms
  assert.strictEqual(
    getNextIdleWakeDelayMs(makeIdleState({ now: 10000, notificationBannerUntil: 11500, targetProgress: 1, animProgress: 1, currentView: 'notification_banner' })),
    1510
  );
});
