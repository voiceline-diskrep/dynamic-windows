'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SoundFXManager } = require('../src/renderer/sound-fx');

test('SoundFXManager: initialization and defaults', () => {
  const sfx = new SoundFXManager();
  assert.strictEqual(sfx.enabled, true);
  assert.strictEqual(sfx.volume, 0.7);
});

test('SoundFXManager: volume setting and clamping', () => {
  const sfx = new SoundFXManager();
  sfx.setVolume(0.5);
  assert.strictEqual(sfx.volume, 0.5);

  sfx.setVolume(1.8);
  assert.strictEqual(sfx.volume, 1.0);

  sfx.setVolume(-0.4);
  assert.strictEqual(sfx.volume, 0.0);
});

test('SoundFXManager: toggle enabled state', () => {
  const sfx = new SoundFXManager();
  sfx.setEnabled(false);
  assert.strictEqual(sfx.enabled, false);
  sfx.setEnabled(true);
  assert.strictEqual(sfx.enabled, true);
});

test('SoundFXManager: safe execution in headless environment for all sounds', () => {
  const sfx = new SoundFXManager();
  const sounds = ['expand', 'collapse', 'tap', 'notification', 'timer_done', 'drop', 'switch', 'unknown'];
  sounds.forEach(sound => {
    assert.doesNotThrow(() => {
      sfx.play(sound);
    });
  });
});

test('SoundFXManager: force preview plays even when disabled', () => {
  const sfx = new SoundFXManager();
  sfx.setEnabled(false);
  assert.doesNotThrow(() => {
    sfx.play('notification', true);
  });
});

test('SoundFXManager: preset configuration and safe execution across all presets', () => {
  const sfx = new SoundFXManager();
  assert.strictEqual(sfx.getPreset(), 'modern');

  const presets = ['modern', 'mechanical', 'soft', 'retro'];
  const sounds = ['expand', 'collapse', 'tap', 'notification', 'timer_done', 'drop', 'switch'];

  presets.forEach(preset => {
    sfx.setPreset(preset);
    assert.strictEqual(sfx.getPreset(), preset);

    sounds.forEach(sound => {
      assert.doesNotThrow(() => {
        sfx.play(sound);
      });
    });
  });

  // Invalid preset should be ignored
  sfx.setPreset('invalid_preset');
  assert.strictEqual(sfx.getPreset(), 'retro');
});

