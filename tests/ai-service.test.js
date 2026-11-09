'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AiService } = require('../src/main/ai-service');

test('AiService: session management and local persistence', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-ai-test-'));
  const testChatsFile = path.join(tmpDir, 'test_chats.json');

  const ai = new AiService({ dataDir: tmpDir, chatsFile: testChatsFile });

  // 1. Initial state has 1 default session
  const sessions = ai.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'New Chat');

  // 2. Create second session
  const s2 = ai.createSession('Project Ideas');
  assert.equal(ai.getSessions().length, 2);
  assert.equal(ai.activeSessionId, s2.id);

  // 3. Switch active session
  ai.setActiveSession(sessions[0].id);
  assert.equal(ai.activeSessionId, sessions[0].id);

  // 4. Delete session
  ai.deleteSession(s2.id);
  assert.equal(ai.getSessions().length, 1);
  assert.equal(ai.activeSessionId, sessions[0].id);

  // Clean up
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
});

test('AiService: image processing for data URLs and files', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-ai-img-'));
  const ai = new AiService({ dataDir: tmpDir, chatsFile: path.join(tmpDir, 'chats.json') });

  // Data URL parsing
  const testDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const processed = ai.processImageInput(testDataUrl);
  assert.ok(processed);
  assert.equal(processed.mimeType, 'image/png');
  assert.ok(processed.base64.length > 10);

  // File parsing
  const testImgPath = path.join(tmpDir, 'sample.jpg');
  fs.writeFileSync(testImgPath, Buffer.from('fake-jpeg-binary'));
  const fileProcessed = ai.processImageInput(testImgPath);
  assert.ok(fileProcessed);
  assert.equal(fileProcessed.mimeType, 'image/jpeg');
  assert.equal(fileProcessed.base64, Buffer.from('fake-jpeg-binary').toString('base64'));

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
});

test('AiService: Gemini API mock request & response parsing', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-gemini-test-'));
  const ai = new AiService({ dataDir: tmpDir, chatsFile: path.join(tmpDir, 'chats.json') });

  // Mock global.fetch
  const origFetch = global.fetch;
  t.after(() => {
    global.fetch = origFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  let capturedUrl = '';
  let capturedBody = null;

  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Dynamic Windows is running smoothly.' }],
              role: 'model'
            }
          }
        ]
      })
    };
  };

  const reply = await ai.callGemini('fake-gemini-key', 'gemini-1.5-flash', [
    { role: 'user', content: 'What is Dynamic Windows?' }
  ]);

  assert.equal(reply, 'Dynamic Windows is running smoothly.');
  assert.ok(capturedUrl.includes('models/gemini-1.5-flash:generateContent'));
  assert.ok(capturedUrl.includes('key=fake-gemini-key'));
  assert.equal(capturedBody.contents[0].parts[0].text, 'What is Dynamic Windows?');
});

test('AiService: OpenAI-compatible endpoint mock request', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-openai-test-'));
  const ai = new AiService({ dataDir: tmpDir, chatsFile: path.join(tmpDir, 'chats.json') });

  const origFetch = global.fetch;
  t.after(() => {
    global.fetch = origFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  let capturedHeaders = null;
  let capturedBody = null;

  global.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Screen analysis complete.'
            }
          }
        ]
      })
    };
  };

  const reply = await ai.callOpenAI('fake-openai-key', 'gpt-4o', 'https://api.openai.com/v1', [
    { role: 'user', content: 'Analyze screen' }
  ]);

  assert.equal(reply, 'Screen analysis complete.');
  assert.equal(capturedHeaders.Authorization, 'Bearer fake-openai-key');
  assert.equal(capturedBody.model, 'gpt-4o');
  assert.equal(capturedBody.messages[0].content, 'Analyze screen');
});
