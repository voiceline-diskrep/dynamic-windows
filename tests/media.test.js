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

test('MediaController: parseLyricsFromCache parses Liner Atlas richsync JSON', () => {
  const mc = new MediaController();
  const mockCache = `
event: metadata
data: {"type":"metadata","track":{"title":"Richsync Song","artists":[{"name":"Atlas Artist"}]}}

event: provider
data: {"type":"provider","provider":"Liner Atlas","candidate":{"lyrics":{"format":"richsync","content":"[{\\"ts\\":1.2,\\"te\\":3.5,\\"x\\":\\"First rich line\\"},{\\"ts\\":3.8,\\"te\\":6.0,\\"x\\":\\"Second rich line\\"}]"}}}
`;

  const lines = mc.parseLyricsFromCache(mockCache);
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], 'First rich line');
  assert.strictEqual(lines[1], 'Second rich line');
  assert.ok(Array.isArray(lines.timed));
  assert.strictEqual(lines.timed.length, 2);
  assert.strictEqual(lines.timed[0].time, 1.2);
  assert.strictEqual(lines.timed[0].text, 'First rich line');
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

test('MediaController: TTML merges adjacent syllable spans into whole words with exact end timestamps', () => {
  const mc = new MediaController();
  const mockCache = `
event: metadata
data: {"type":"metadata","track":{"title":"Syllable Song","artists":[{"name":"Singer"}]}}

event: provider
data: {"type":"provider","provider":"LRC Provider","candidate":{"lyrics":{"format":"lrc","content":"[00:10.78] Tell me it's okay"}}}

event: provider
data: {"type":"provider","provider":"Polaris Mono","syncLevel":"word_level","candidate":{"lyrics":{"format":"ttml","content":"<tt><body><div><p begin=\\"10.782\\" end=\\"14.803\\"><span begin=\\"10.782\\" end=\\"11.116\\">Tell</span> <span begin=\\"11.116\\" end=\\"11.401\\">me</span> <span begin=\\"13.449\\" end=\\"13.734\\">it's</span> <span begin=\\"13.734\\" end=\\"14.026\\">o</span><span begin=\\"14.026\\" end=\\"14.803\\">kay</span></p></div></body></tt>"}}}
`;

  const parsed = mc.parseLinerCacheLyrics(mockCache);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].text, "Tell me it's okay");
  assert.strictEqual(parsed[0].t, 10782);
  assert.strictEqual(parsed[0].end, 14803);
  assert.ok(Array.isArray(parsed[0].words));
  assert.strictEqual(parsed[0].words.length, 4);
  assert.strictEqual(parsed[0].words[3].text, 'okay');
  assert.strictEqual(parsed[0].words[3].t, 13734);
  assert.strictEqual(parsed[0].words[3].end, 14803);
  assert.strictEqual(parsed[0].words[3].syllables.length, 2);
  mc.destroy();
});
