'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const DropZone = require('../src/main/drop-zone');
const configManager = require('../src/main/config-manager');

test('DropZone: safe calls with undefined arguments', () => {
  const dz = new DropZone();
  
  // None of these should throw TypeError [ERR_INVALID_ARG_TYPE]
  assert.doesNotThrow(() => {
    dz.revealInExplorer();
  });

  assert.doesNotThrow(() => {
    dz.revealInExplorer(undefined);
  });

  assert.doesNotThrow(() => {
    dz.revealInExplorer(null);
  });

  assert.doesNotThrow(() => {
    dz.openFile(undefined);
  });

  assert.doesNotThrow(() => {
    const res = dz.deleteFile(undefined);
    assert.strictEqual(res, false);
  });
});

test('ConfigManager: get and set settings', () => {
  const cur = configManager.get();
  assert.ok(cur);
  assert.strictEqual(typeof cur.startup, 'boolean');
  assert.strictEqual(typeof cur.hooksPort, 'number');

  // Test set
  configManager.set('showSeconds', true);
  assert.strictEqual(configManager.get('showSeconds'), true);

  // Restore
  configManager.set('showSeconds', false);
  assert.strictEqual(configManager.get('showSeconds'), false);
});
