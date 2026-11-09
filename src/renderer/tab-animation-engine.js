'use strict';

/**
 * Tab Animation Engine for Dynamic Windows
 * Handles sliding navigation pill kinematics, directional content transitions,
 * and liquid vertical height interpolation between island views.
 */

const TAB_ORDER = [
  'home',
  'notifications',
  'calendar',
  'clock',
  'todo',
  'media',
  'agent',
  'call',
  'dropzone',
  'clipboard',
  'prompt'
];

/**
 * Computes transition direction (+1 for moving right, -1 for moving left)
 */
function getTabSwitchDirection(fromView, toView) {
  const prevIdx = TAB_ORDER.indexOf(fromView);
  const nextIdx = TAB_ORDER.indexOf(toView);
  if (prevIdx === -1 || nextIdx === -1) return 1;
  return nextIdx >= prevIdx ? 1 : -1;
}

/**
 * Calculates horizontal offsets and opacity fades for tab content cross-fade.
 * Uses an organic Apple-style quartic ease-out deceleration curve.
 */
function getTabTransitionOffsets(direction, progress, maxSlide = 26) {
  const p = Math.max(0, Math.min(1.0, progress));
  const ease = 1 - Math.pow(1 - p, 4);

  const outgoingOffset = (-direction * (ease * maxSlide)) || 0;
  const incomingOffset = (direction * ((1 - ease) * maxSlide)) || 0;
  const outgoingAlpha = Math.max(0, 1 - ease);
  const incomingAlpha = Math.min(1.0, Math.max(0, ease));

  return {
    outgoingOffset,
    incomingOffset,
    outgoingAlpha,
    incomingAlpha,
    ease
  };
}

/**
 * Computes the next frame kinematics for the active sliding pill indicator.
 * Incorporates dynamic fluid squash-and-stretch during travel.
 */
function computeSlidingPillStep(currentX, currentW, targetX, targetW, dt = 0.016, speedMultiplier = 1.0) {
  if (currentX === null || isNaN(currentX) || currentW === null || isNaN(currentW)) {
    return { x: targetX, w: targetW, isSettled: true };
  }

  const dist = Math.abs(targetX - currentX);
  const stretch = Math.min(12, dist * 0.14);
  const lerpSpeed = Math.min(1.0, 18.0 * dt * (speedMultiplier || 1.0));

  const nextX = currentX + (targetX - currentX) * lerpSpeed;
  const nextW = currentW + (targetW + stretch - currentW) * lerpSpeed;
  const isSettled = Math.abs(targetX - nextX) < 0.15 && Math.abs(targetW - nextW) < 0.15;

  return {
    x: isSettled ? targetX : nextX,
    w: isSettled ? targetW : nextW,
    isSettled
  };
}

/**
 * Computes the next height step using smooth spring/lerp physics.
 */
function computeLiquidHeightStep(currentH, targetH, dt = 0.016, speedMultiplier = 1.0) {
  if (currentH === null || isNaN(currentH)) return targetH;
  const speed = (targetH > currentH ? 10.0 : 8.5) * (speedMultiplier || 1.0);
  const lerp = Math.min(1.0, dt * speed);
  const nextH = currentH + (targetH - currentH) * lerp;
  if (Math.abs(targetH - nextH) < 0.2) return targetH;
  return nextH;
}

/**
 * Returns the target expanded capsule height for any view
 */
function getTargetExpandedHeight(view, options = {}) {
  const UI = {
    HOME_H: 164,
    CALENDAR_H: 330,
    CLOCK_H: 260,
    TODO_H: 320,
    NOTIF_H: 260,
    AGENT_H: 196,
    CALL_H: 206,
    MEDIA_H: 220,
    DROPZONE_H: 260,
    CLIPBOARD_H: 280,
    PROMPT_H: 220
  };

  if (view === 'calendar') return UI.CALENDAR_H;
  if (view === 'clock') {
    if (options.activeAlarmRinging) return 280;
    if (options.clockSubMode === 'alarm' && (options.alarmsCount || 0) > 1) return 290;
    return UI.CLOCK_H;
  }
  if (view === 'todo') return UI.TODO_H;
  if (view === 'agent') {
    if (options.aiSubMode === 'chat' || options.isAiChat) {
      return 480;
    }
    const cardCount = Math.max(1, Math.min(3, options.projectCount || 0));
    return cardCount === 1 ? UI.AGENT_H : Math.min(340, 160 + (cardCount - 1) * 82);
  }
  if (view === 'call') return UI.CALL_H;
  if (view === 'media') return UI.MEDIA_H + 34; // 254px (includes speed pill bar)
  if (view === 'dropzone') return UI.DROPZONE_H;
  if (view === 'clipboard') return UI.CLIPBOARD_H;
  if (view === 'prompt') return UI.PROMPT_H;
  if (view === 'notifications') return UI.NOTIF_H;
  if (view === 'notification_banner') return 82;
  return UI.HOME_H;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TAB_ORDER,
    getTabSwitchDirection,
    getTabTransitionOffsets,
    computeSlidingPillStep,
    computeLiquidHeightStep,
    getTargetExpandedHeight
  };
}
