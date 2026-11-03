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

test('sysHelper: getWorkArea returns monitor bounds', async () => {
  const res = await sysHelper.getWorkArea();
  assert.ok(res, 'Should return an object');
  assert.strictEqual(typeof res.left, 'number');
  assert.strictEqual(typeof res.top, 'number');
  assert.strictEqual(typeof res.right, 'number');
  assert.strictEqual(typeof res.bottom, 'number');
  assert.ok(res.right > 0 && res.bottom > 0);
});
