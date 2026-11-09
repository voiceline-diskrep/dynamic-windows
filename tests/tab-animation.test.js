'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  TAB_ORDER,
  getTabSwitchDirection,
  getTabTransitionOffsets,
  computeSlidingPillStep,
  computeLiquidHeightStep,
  getTargetExpandedHeight
} = require('../src/renderer/tab-animation-engine');

test('TabAnimationEngine: tab order contains all primary views', () => {
  assert.ok(TAB_ORDER.includes('home'));
  assert.ok(TAB_ORDER.includes('notifications'));
  assert.ok(TAB_ORDER.includes('calendar'));
  assert.ok(TAB_ORDER.includes('clock'));
  assert.ok(TAB_ORDER.includes('todo'));
  assert.ok(TAB_ORDER.includes('media'));
  assert.ok(TAB_ORDER.includes('agent'));
  assert.ok(TAB_ORDER.includes('call'));
  assert.ok(TAB_ORDER.includes('dropzone'));
  assert.ok(TAB_ORDER.includes('clipboard'));
});

test('TabAnimationEngine: directional calculation (+1 right, -1 left)', () => {
  // Moving to the right: Home (0) -> Media (5)
  assert.strictEqual(getTabSwitchDirection('home', 'media'), 1);
  // Moving to the right: Calendar (2) -> Clock (3)
  assert.strictEqual(getTabSwitchDirection('calendar', 'clock'), 1);

  // Moving to the left: Media (5) -> Home (0)
  assert.strictEqual(getTabSwitchDirection('media', 'home'), -1);
  // Moving to the left: Clock (3) -> Calendar (2)
  assert.strictEqual(getTabSwitchDirection('clock', 'calendar'), -1);

  // Unknown view fallback defaults to +1
  assert.strictEqual(getTabSwitchDirection('unknown', 'media'), 1);
});

test('TabAnimationEngine: transition offsets and cross-fade progression', () => {
  // Direction +1 (moving right)
  const atStart = getTabTransitionOffsets(1, 0.0, 26);
  assert.strictEqual(atStart.outgoingOffset, 0);
  assert.strictEqual(atStart.outgoingAlpha, 1.0);
  assert.strictEqual(atStart.incomingOffset, 26);
  assert.strictEqual(atStart.incomingAlpha, 0.0);

  const atMid = getTabTransitionOffsets(1, 0.5, 26);
  assert.ok(atMid.outgoingOffset < 0, 'outgoing slides left');
  assert.ok(atMid.incomingOffset > 0, 'incoming enters from right');
  assert.ok(atMid.outgoingAlpha < 1.0 && atMid.outgoingAlpha > 0);
  assert.ok(atMid.incomingAlpha > 0.0 && atMid.incomingAlpha < 1.0);

  const atEnd = getTabTransitionOffsets(1, 1.0, 26);
  assert.strictEqual(atEnd.outgoingOffset, -26);
  assert.strictEqual(atEnd.outgoingAlpha, 0.0);
  assert.strictEqual(atEnd.incomingOffset, 0);
  assert.strictEqual(atEnd.incomingAlpha, 1.0);

  // Direction -1 (moving left)
  const leftStart = getTabTransitionOffsets(-1, 0.0, 26);
  assert.strictEqual(leftStart.outgoingOffset, 0);
  assert.strictEqual(leftStart.incomingOffset, -26);

  const leftEnd = getTabTransitionOffsets(-1, 1.0, 26);
  assert.strictEqual(leftEnd.outgoingOffset, 26); // Outgoing slides to the right
  assert.strictEqual(leftEnd.incomingOffset, 0);  // Incoming arrives at 0
});

test('TabAnimationEngine: sliding pill indicator step and fluid stretch', () => {
  // Initial unplaced indicator snaps instantly
  const initial = computeSlidingPillStep(null, null, 100, 40);
  assert.strictEqual(initial.x, 100);
  assert.strictEqual(initial.w, 40);
  assert.strictEqual(initial.isSettled, true);

  // Far movement exhibits fluid stretch
  const moving = computeSlidingPillStep(100, 40, 250, 44, 0.016, 1.0);
  assert.ok(moving.x > 100 && moving.x < 250, 'x moves toward target');
  assert.ok(moving.w > 44, 'pill width stretches organically while in motion');
  assert.strictEqual(moving.isSettled, false);

  // Settling when near target
  let cur = { x: 100, w: 40 };
  for (let i = 0; i < 40; i++) {
    cur = computeSlidingPillStep(cur.x, cur.w, 150, 48, 0.016, 1.0);
  }
  assert.strictEqual(cur.x, 150);
  assert.strictEqual(cur.w, 48);
  assert.strictEqual(cur.isSettled, true);
});

test('TabAnimationEngine: target expanded heights for distinct views', () => {
  assert.strictEqual(getTargetExpandedHeight('home'), 164);
  assert.strictEqual(getTargetExpandedHeight('calendar'), 330);
  assert.strictEqual(getTargetExpandedHeight('clock'), 260);
  assert.strictEqual(getTargetExpandedHeight('clock', { activeAlarmRinging: true }), 280);
  assert.strictEqual(getTargetExpandedHeight('clock', { clockSubMode: 'alarm', alarmsCount: 2 }), 290);
  assert.strictEqual(getTargetExpandedHeight('todo'), 320);
  assert.strictEqual(getTargetExpandedHeight('notifications'), 260);
  assert.strictEqual(getTargetExpandedHeight('media'), 254);
  assert.strictEqual(getTargetExpandedHeight('agent'), 196);
  assert.strictEqual(getTargetExpandedHeight('call'), 206);
  assert.strictEqual(getTargetExpandedHeight('dropzone'), 260);
  assert.strictEqual(getTargetExpandedHeight('clipboard'), 280);
  assert.strictEqual(getTargetExpandedHeight('notification_banner'), 82);
});

test('TabAnimationEngine: liquid height smooth spring transition', () => {
  const startH = 164; // Home
  const targetH = 330; // Calendar

  let curH = startH;
  const history = [curH];
  for (let i = 0; i < 20; i++) {
    curH = computeLiquidHeightStep(curH, targetH, 0.016, 1.0);
    history.push(curH);
  }

  // Verify monotonic progression towards target
  for (let i = 1; i < history.length; i++) {
    assert.ok(history[i] >= history[i - 1], `Height smoothly increases: ${history[i - 1]} -> ${history[i]}`);
  }
  assert.ok(curH > 310, 'Height approaches target smoothly');
});
