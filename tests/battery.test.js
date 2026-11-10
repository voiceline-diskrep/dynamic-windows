'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  getBatteryColor,
  getBatteryDisplay,
  drawBatteryCircle,
  drawBatteryIndicator
} = require('../src/renderer/battery-indicator');

test('BatteryIndicator: color threshold > 40% is Green (#22c55e)', () => {
  assert.strictEqual(getBatteryColor(100), '#22c55e');
  assert.strictEqual(getBatteryColor(85), '#22c55e');
  assert.strictEqual(getBatteryColor(60), '#22c55e');
  assert.strictEqual(getBatteryColor(41), '#22c55e');
});

test('BatteryIndicator: color threshold 20% - 40% is Yellow (#eab308)', () => {
  assert.strictEqual(getBatteryColor(40), '#eab308');
  assert.strictEqual(getBatteryColor(35), '#eab308');
  assert.strictEqual(getBatteryColor(25), '#eab308');
  assert.strictEqual(getBatteryColor(21), '#eab308');
});

test('BatteryIndicator: color threshold 0% - 20% is Red (#ef4444)', () => {
  assert.strictEqual(getBatteryColor(20), '#ef4444');
  assert.strictEqual(getBatteryColor(15), '#ef4444');
  assert.strictEqual(getBatteryColor(5), '#ef4444');
  assert.strictEqual(getBatteryColor(0), '#ef4444');
});

test('BatteryIndicator: getBatteryDisplay returns null on desktop / no battery', () => {
  assert.strictEqual(getBatteryDisplay(null), null);
  assert.strictEqual(getBatteryDisplay({ hasBattery: false }), null);
  assert.strictEqual(getBatteryDisplay({ hasBattery: false, percent: 100 }), null);
});

test('BatteryIndicator: getBatteryDisplay returns complete metadata on laptop with battery', () => {
  const displayHigh = getBatteryDisplay({ hasBattery: true, percent: 92, isCharging: false });
  assert.ok(displayHigh);
  assert.strictEqual(displayHigh.hasBattery, true);
  assert.strictEqual(displayHigh.percent, 92);
  assert.strictEqual(displayHigh.isCharging, false);
  assert.strictEqual(displayHigh.color, '#22c55e');
  assert.strictEqual(displayHigh.text, '92%');
  assert.strictEqual(displayHigh.label, '92%');

  const displayMed = getBatteryDisplay({ hasBattery: true, percent: 34, isCharging: true });
  assert.ok(displayMed);
  assert.strictEqual(displayMed.color, '#eab308');
  assert.strictEqual(displayMed.isCharging, true);
  assert.strictEqual(displayMed.label, '34% ⚡');

  const displayLow = getBatteryDisplay({ hasBattery: true, percent: 14, isCharging: false });
  assert.ok(displayLow);
  assert.strictEqual(displayLow.color, '#ef4444');
});

test('BatteryIndicator: drawBatteryIndicator safely renders in headless mock canvas context', () => {
  const mockCalls = [];
  const mockCtx = {
    save: () => mockCalls.push('save'),
    restore: () => mockCalls.push('restore'),
    beginPath: () => mockCalls.push('beginPath'),
    arc: (...args) => mockCalls.push({ call: 'arc', args }),
    fill: () => mockCalls.push('fill'),
    fillText: (...args) => mockCalls.push({ call: 'fillText', args }),
    measureText: (text) => ({ width: text.length * 6 }),
    globalAlpha: 1.0,
    fillStyle: '#000',
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0
  };

  const dim = drawBatteryIndicator(mockCtx, 10, 20, { hasBattery: true, percent: 80, isCharging: false });
  assert.ok(dim.width > 0);
  assert.ok(dim.height > 0);
  assert.ok(mockCalls.includes('save'));
  assert.ok(mockCalls.includes('restore'));
  assert.ok(mockCalls.some(c => c.call === 'arc'));
  assert.ok(mockCalls.some(c => c.call === 'fillText'));
});
