'use strict';

const test = require('node:test');
const assert = require('node:assert');
const MediaController = require('../src/main/media-spotify');

test('MediaController: parseLyricsFromCache parses TTML <p> lines', () => {
  const mc = new MediaController();
  const mockCache = `
event: metadata
data: {"type":"metadata","track":{"title":"Test Song","artists":[{"name":"Test Artist"}]}}

event: provider
data: {"type":"provider","provider":"Polaris","candidate":{"lyrics":{"format":"ttml","content":"<tt><body><div><p begin=\\"1.0\\"><span>Line</span> <span>one</span></p><p begin=\\"4.0\\"><span>Line</span> <span>two</span></p></div></body></tt>"}}}
`;

  const lines = mc.parseLyricsFromCache(mockCache);
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], 'Line one');
  assert.strictEqual(lines[1], 'Line two');
  mc.destroy();
});

test('MediaController: parseLyricsFromCache parses LRC lines', () => {
  const mc = new MediaController();
  const mockCache = `
event: metadata
data: {"type":"metadata","track":{"title":"Test LRC","artists":[{"name":"Singer"}]}}

event: provider
data: {"type":"provider","provider":"Liner Atlas","candidate":{"lyrics":{"format":"lrc","content":"[00:05.12] First verse line\\n[00:10.50] Second chorus line"}}}
`;

  const lines = mc.parseLyricsFromCache(mockCache);
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], 'First verse line');
  assert.strictEqual(lines[1], 'Second chorus line');
  mc.destroy();
});

test('MediaController: getState returns clean track structure', () => {
  const mc = new MediaController();
  const state = mc.getState();
  assert.ok(state);
  assert.strictEqual(typeof state.isPlaying, 'boolean');
  assert.ok(state.track);
  assert.strictEqual(typeof state.track.title, 'string');
  assert.strictEqual(typeof state.track.artist, 'string');
  assert.ok(Array.isArray(state.track.lyrics));
  mc.destroy();
});
