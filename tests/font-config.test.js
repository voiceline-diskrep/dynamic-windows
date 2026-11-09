'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const configManager = require('../src/main/config-manager');

test('FontConfig: default font family is Theater', () => {
  const font = configManager.get('fontFamily');
  assert.strictEqual(font, 'Theater');
});

test('FontConfig: can update and persist custom font family', () => {
  configManager.set('fontFamily', 'Inter');
  assert.strictEqual(configManager.get('fontFamily'), 'Inter');

  configManager.set('fontFamily', 'Consolas');
  assert.strictEqual(configManager.get('fontFamily'), 'Consolas');

  // Reset back to Theater
  configManager.set('fontFamily', 'Theater');
  assert.strictEqual(configManager.get('fontFamily'), 'Theater');
});

test('FontConfig: Theater font asset exists in repository bundle', () => {
  const fontPath = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts', 'Theaterv04_Bold.ttf');
  assert.strictEqual(fs.existsSync(fontPath), true, 'Theaterv04_Bold.ttf must be bundled in assets/fonts');
  const stat = fs.statSync(fontPath);
  assert.ok(stat.size > 10000, 'Font file size must be valid');
});
