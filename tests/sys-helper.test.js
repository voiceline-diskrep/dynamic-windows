'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sysHelper = require('../src/main/sys-helper');

test('sysHelper: getVolume returns valid volume structure', async () => {
  const res = await sysHelper.getVolume();
  assert.ok(res, 'Should return an object');
  assert.strictEqual(typeof res.volume, 'number');
  assert.strictEqual(typeof res.muted, 'boolean');
  assert.ok(res.volume >= 0.0 && res.volume <= 1.0, 'Volume scalar should be between 0 and 1');
});

test('sysHelper: getMediaVolume returns valid media player volume structure', async () => {
  const res = await sysHelper.getMediaVolume('liner');
  assert.ok(res, 'Should return an object');
  assert.strictEqual(typeof res.volume, 'number');
  assert.strictEqual(typeof res.muted, 'boolean');
  assert.strictEqual(typeof res.app, 'string');
  assert.ok(res.volume >= 0.0 && res.volume <= 1.0, 'Volume scalar should be between 0 and 1');
});

test('sysHelper: setMediaVolume adjusts media player volume without error', async () => {
  const current = await sysHelper.getMediaVolume('liner');
  const testVol = 0.95;
  const updated = await sysHelper.setMediaVolume(testVol, 'liner');
  assert.ok(updated, 'Should return updated volume');
  assert.strictEqual(typeof updated.volume, 'number');
  assert.strictEqual(typeof updated.muted, 'boolean');
  // Restore original volume
  if (current && typeof current.volume === 'number') {
    await sysHelper.setMediaVolume(current.volume, 'liner');
  }
});

test('sysHelper: getWorkArea returns monitor bounds', async () => {
  const res = await sysHelper.getWorkArea();
  assert.ok(res, 'Should return an object');
  assert.strictEqual(typeof res.left, 'number');
  assert.strictEqual(typeof res.top, 'number');
  assert.strictEqual(typeof res.right, 'number');
  assert.strictEqual(typeof res.bottom, 'number');
  assert.ok(res.right > 0 && res.bottom > 0);
});

test('sysHelper: getBatteryStatus returns valid battery structure', async () => {
  const res = await sysHelper.getBatteryStatus();
  assert.ok(res, 'Should return an object');
  assert.strictEqual(typeof res.hasBattery, 'boolean');
  assert.strictEqual(typeof res.percent, 'number');
  assert.strictEqual(typeof res.isCharging, 'boolean');
});
