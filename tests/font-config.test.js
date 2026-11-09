'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const configManager = require('../src/main/config-manager');

test('FontConfig: default font family is Theater', () => {
  assert.strictEqual(configManager.DEFAULT_CONFIG.fontFamily, 'Theater');
  const font = configManager.get('fontFamily');
  assert.ok(typeof font === 'string' && font.length > 0);
});

test('FontConfig: can update and persist custom font family', () => {
  const initial = configManager.get('fontFamily');
  try {
    configManager.set('fontFamily', 'Inter');
    assert.strictEqual(configManager.get('fontFamily'), 'Inter');

    configManager.set('fontFamily', 'Consolas');
    assert.strictEqual(configManager.get('fontFamily'), 'Consolas');
  } finally {
    configManager.set('fontFamily', initial);
  }
});

test('FontConfig: Theater font asset exists in repository bundle', () => {
  const fontPath = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts', 'Theaterv04_Bold.ttf');
  assert.strictEqual(fs.existsSync(fontPath), true, 'Theaterv04_Bold.ttf must be bundled in assets/fonts');
  const stat = fs.statSync(fontPath);
  assert.ok(stat.size > 10000, 'Font file size must be valid');
});
