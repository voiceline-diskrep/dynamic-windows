'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const AgentHooksServer = require('../src/main/agent-hooks-server');

const TEST_PORT = 47910;

test('AgentHooksServer: MCP endpoints (/mcp/notify, /mcp/shelf-file, /mcp/set-mode, /mcp/state)', async () => {
  const server = new AgentHooksServer({ port: TEST_PORT });
  server.stateGetter = () => ({
    status: 'running',
    displayMode: 'notch',
    shelfFiles: [{ name: 'test.txt' }]
  });
  server.start();

  await new Promise(resolve => setTimeout(resolve, 80));

  let notifyData = null;
  server.on('mcp-notify', (data) => {
    notifyData = data;
  });

  let shelfData = null;
  server.on('mcp-shelf-file', (data) => {
    shelfData = data;
  });

  let modeData = null;
  server.on('mcp-set-mode', (data) => {
    modeData = data;
  });

  // 1. Test /mcp/notify
  await postJson('/mcp/notify', { status: 'thinking', phase: 'Building project' });
  assert.ok(notifyData);
  assert.strictEqual(notifyData.status, 'thinking');
  assert.strictEqual(notifyData.phase, 'Building project');

  // 2. Test /mcp/shelf-file
  await postJson('/mcp/shelf-file', { path: 'C:\\test\\document.pdf' });
  assert.ok(shelfData);
  assert.strictEqual(shelfData.path, 'C:\\test\\document.pdf');

  // 3. Test /mcp/set-mode
  await postJson('/mcp/set-mode', { mode: 'notch' });
  assert.ok(modeData);
  assert.strictEqual(modeData.mode, 'notch');

  // 4. Test /mcp/state
  const stateRes = await postJson('/mcp/state', {});
  assert.strictEqual(stateRes.status, 'running');
  assert.strictEqual(stateRes.displayMode, 'notch');
  assert.strictEqual(stateRes.shelfFiles.length, 1);

  server.stop();
});

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
