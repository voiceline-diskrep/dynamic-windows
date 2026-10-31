'use strict';

const test = require('node:test');
const assert = require('node:assert');
const OneShotEngine = require('../src/main/oneshot-engine');

test('OneShotEngine: load and manage presets', () => {
  const engine = new OneShotEngine();
  const initialPresets = engine.getPresets();
  assert.ok(Array.isArray(initialPresets));
  assert.ok(initialPresets.length > 0);

  // Add new preset
  const created = engine.addPreset('Test Dev', 'Testing dev flow', '🚀', [
    { name: 'Node', path: 'node.exe', args: '-v', delay_seconds: 0 }
  ]);
  assert.strictEqual(created.name, 'Test Dev');

  // Update
  const updated = engine.updatePreset(created.id, { name: 'Test Dev 2' });
  assert.strictEqual(updated.name, 'Test Dev 2');

  // Delete
  engine.deletePreset(created.id);
  const remaining = engine.getPresets();
  assert.strictEqual(remaining.some(p => p.id === created.id), false);
});

test('OneShotEngine: app discovery', () => {
  const engine = new OneShotEngine();
  const apps = engine.discoverInstalledApps();
  assert.ok(Array.isArray(apps));
});
