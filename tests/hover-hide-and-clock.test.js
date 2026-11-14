'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const configManager = require('../src/main/config-manager');

const canvasEnginePath = path.join(__dirname, '..', 'src', 'renderer', 'canvas-engine.js');
const canvasEngineSrc = fs.readFileSync(canvasEnginePath, 'utf8');
const settingsHtmlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8');

function extractFunction(fnName) {
  const startToken = `function ${fnName}(`;
  const startIdx = canvasEngineSrc.indexOf(startToken);
  assert.ok(startIdx >= 0, `${fnName} must exist in canvas-engine.js`);
  const endIdx = canvasEngineSrc.indexOf('\n}', startIdx);
  assert.ok(endIdx >= 0, `${fnName} closing brace must exist in canvas-engine.js`);
  // Look past destructured parameter closing line `} = {}) {` if present
  const bodyOpenIdx = canvasEngineSrc.indexOf(') {', startIdx);
  const actualEndIdx = canvasEngineSrc.indexOf('\n}', bodyOpenIdx);
  const fnSrc = canvasEngineSrc.slice(startIdx, actualEndIdx + 2);
  const script = new vm.Script(`${fnSrc}; ${fnName};`);
  return script.runInNewContext({});
}

test('ClockFormat: supports AM/PM toggle, 24h mode, and seconds', () => {
  const formatClockTime = extractFunction('formatClockTime');
  const afternoon = new Date(2026, 10, 14, 14, 5, 9);
  const midnight = new Date(2026, 10, 14, 0, 7, 3);
  const noon = new Date(2026, 10, 14, 12, 30, 0);

  assert.strictEqual(formatClockTime(afternoon, { clock24h: false, showSeconds: false, showAmPm: true }), '2:05 PM');
  assert.strictEqual(formatClockTime(afternoon, { clock24h: false, showSeconds: false, showAmPm: false }), '2:05');
  assert.strictEqual(formatClockTime(afternoon, { clock24h: false, showSeconds: true, showAmPm: false }), '2:05:09');
  assert.strictEqual(formatClockTime(afternoon, { clock24h: true, showSeconds: false, showAmPm: true }), '14:05');

  assert.strictEqual(formatClockTime(midnight, { clock24h: false, showSeconds: false, showAmPm: true }), '12:07 AM');
  assert.strictEqual(formatClockTime(midnight, { clock24h: false, showSeconds: false, showAmPm: false }), '12:07');
  assert.strictEqual(formatClockTime(midnight, { clock24h: true, showSeconds: false, showAmPm: true }), '00:07');

  assert.strictEqual(formatClockTime(noon, { clock24h: false, showSeconds: false, showAmPm: true }), '12:30 PM');
  assert.strictEqual(formatClockTime(noon, { clock24h: false, showSeconds: false, showAmPm: false }), '12:30');
});

test('TopLumpHitbox: provides centered top-edge Fitts target >= 44px wide', () => {
  const getTopLumpHitbox = extractFunction('getTopLumpHitbox');
  const box = getTopLumpHitbox(1040);
  assert.strictEqual(box.y, 0);
  assert.ok(box.w >= 44 && box.w <= 120);
  assert.ok(box.h >= 8 && box.h <= 14);
  assert.strictEqual(box.x, Math.round((1040 - box.w) / 2));
});

test('HideTransform: morphs smoothly between resting island/notch and top bezel lump', () => {
  const computeCapsuleHideTransform = extractFunction('computeCapsuleHideTransform');

  const open = computeCapsuleHideTransform({
    hideProgress: 0,
    normalW: 80,
    normalH: 32,
    normalY: 8,
    normalRadius: 16,
    normalTopFillet: 10,
    isNotch: false
  });
  assert.strictEqual(open.w, 80);
  assert.strictEqual(open.h, 32);
  assert.strictEqual(open.y, 8);
  assert.strictEqual(open.contentAlpha, 1);
  assert.strictEqual(open.sideAlpha, 1);

  const mid = computeCapsuleHideTransform({
    hideProgress: 0.5,
    normalW: 80,
    normalH: 32,
    normalY: 8,
    normalRadius: 16,
    normalTopFillet: 10,
    isNotch: false
  });
  assert.ok(mid.w > 54 && mid.w < 80);
  assert.ok(mid.h > 6 && mid.h < 32);
  assert.strictEqual(mid.y, 4);
  assert.ok(mid.contentOffsetY < 0);
  assert.strictEqual(mid.sideAlpha, 0);

  const hidden = computeCapsuleHideTransform({
    hideProgress: 1,
    normalW: 80,
    normalH: 32,
    normalY: 8,
    normalRadius: 16,
    normalTopFillet: 10,
    isNotch: false
  });
  assert.strictEqual(hidden.w, 54);
  assert.strictEqual(hidden.h, 6);
  assert.strictEqual(hidden.y, 0);
  assert.strictEqual(hidden.bottomRadius, 3);
  assert.strictEqual(hidden.contentAlpha, 0);
  assert.strictEqual(hidden.sideAlpha, 0);
});

test('ConfigManager: includes showAmPm default true and persists updates', () => {
  const prev = configManager.get('showAmPm');
  assert.strictEqual(configManager.DEFAULT_CONFIG.showAmPm, true);
  try {
    configManager.set('showAmPm', false);
    assert.strictEqual(configManager.get('showAmPm'), false);
    configManager.set('showAmPm', true);
    assert.strictEqual(configManager.get('showAmPm'), true);
  } finally {
    configManager.set('showAmPm', prev);
  }
});

test('InteractionContract: hovering collapsed bar sets isPeekHidden instead of expanding, click lump expands', () => {
  assert.ok(/isPeekHidden\s*=\s*true;/.test(canvasEngineSrc), 'Hovering resting notch/island triggers peek hide');
  assert.ok(/clickedTopLump[\s\S]*?targetProgress\s*=\s*1\.0;/.test(canvasEngineSrc), 'Clicking top lump expands island');
  assert.ok(settingsHtmlSrc.includes('setting-showAmPm'), 'Settings UI exposes AM/PM toggle');
});
