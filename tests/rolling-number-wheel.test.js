'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  RollingNumberWheel,
  getTumblerCycleSequence,
  getCycleStepAtProgress,
  easeOutCubic,
  easeOutBack
} = require('../src/renderer/rolling-number-wheel');

test('RollingNumberWheel: tumbler cycle sequence generates sequential numbers ending on target', () => {
  // Target '8' with 3 steps should produce ['5', '6', '7', '8']
  const seq8 = getTumblerCycleSequence('8', 3);
  assert.deepStrictEqual(seq8, ['5', '6', '7', '8']);

  // Target '0' wrapping across 9 should produce ['7', '8', '9', '0']
  const seq0 = getTumblerCycleSequence('0', 3);
  assert.deepStrictEqual(seq0, ['7', '8', '9', '0']);

  // Non-digit returns self
  const seqColon = getTumblerCycleSequence(':', 3);
  assert.deepStrictEqual(seqColon, [':']);
});

test('RollingNumberWheel: cycle step transitions properly across progress range', () => {
  const sequence = ['5', '6', '7', '8'];

  // Start (0.0): active step is 5 -> 6
  const atStart = getCycleStepAtProgress(sequence, 0.0);
  assert.strictEqual(atStart.outgoing, '5');
  assert.strictEqual(atStart.incoming, '6');
  assert.strictEqual(atStart.isSettled, false);

  // Completion (1.0): settled on target '8'
  const atEnd = getCycleStepAtProgress(sequence, 1.0);
  assert.strictEqual(atEnd.outgoing, '8');
  assert.strictEqual(atEnd.incoming, '8');
  assert.strictEqual(atEnd.isSettled, true);

  // Monotonic step progression
  const mid1 = getCycleStepAtProgress(sequence, 0.35);
  const mid2 = getCycleStepAtProgress(sequence, 0.75);
  assert.ok(mid1.outgoing <= mid2.outgoing);
});

test('RollingNumberWheel: easeOutBack provides subtle mechanical detent overshoot', () => {
  assert.strictEqual(easeOutBack(0.0), 0.0);
  // Near end (e.g. 0.9), easeOutBack overshoots slightly above 1.0 for the mechanical click
  const overshoot = easeOutBack(0.9, 1.15);
  assert.ok(overshoot > 1.0, `Expected overshoot > 1.0, got ${overshoot}`);
  // Settles strictly at 1.0
  const finalVal = Math.round(easeOutBack(1.0) * 1000) / 1000;
  assert.strictEqual(finalVal, 1.0);
});

test('RollingNumberWheel: mock context rendering tracks rolling offsets and clipping', () => {
  const wheel = new RollingNumberWheel('test_clock');
  const drawOps = [];

  const mockCtx = {
    save: () => drawOps.push({ op: 'save' }),
    restore: () => drawOps.push({ op: 'restore' }),
    beginPath: () => drawOps.push({ op: 'beginPath' }),
    rect: (x, y, w, h) => drawOps.push({ op: 'rect', x, y, w, h }),
    roundRect: (x, y, w, h, r) => drawOps.push({ op: 'roundRect', x, y, w, h, r }),
    clip: () => drawOps.push({ op: 'clip' }),
    fill: () => drawOps.push({ op: 'fill' }),
    stroke: () => drawOps.push({ op: 'stroke' }),
    fillRect: (x, y, w, h) => drawOps.push({ op: 'fillRect', x, y, w, h }),
    fillText: (text, x, y) => drawOps.push({ op: 'fillText', text, x, y }),
    measureText: (str) => {
      let w = 0;
      for (const ch of str) w += (ch === ':' ? 6 : 10);
      return { width: w };
    },
    createLinearGradient: () => ({ addColorStop: () => {} })
  };

  // Frame 1: initial render
  wheel.render(mockCtx, '12:00', 100, 100, { font: '700 20px Segoe UI', align: 'center' });
  const filledTexts1 = drawOps.filter(o => o.op === 'fillText').map(o => o.text);
  assert.deepStrictEqual(filledTexts1, ['1', '2', ':', '0', '0']);

  // Frame 2: second minute changes from '12:00' to '12:01'
  drawOps.length = 0;
  wheel.render(mockCtx, '12:01', 100, 100, { font: '700 20px Segoe UI', align: 'center' });

  // Verify that clipping occurred for the transitioning digit
  const hasClip = drawOps.some(o => o.op === 'clip');
  assert.strictEqual(hasClip, true, 'Transitioning digit must be clipped to slot');

  // Verify that both the outgoing '0' and incoming '1' were rendered during roll
  const textEvents = drawOps.filter(o => o.op === 'fillText').map(o => o.text);
  assert.ok(textEvents.includes('0'), 'Outgoing 0 rendered');
  assert.ok(textEvents.includes('1'), 'Incoming 1 rendered');
  assert.ok(textEvents.includes(':'), 'Colon rendered');
});
