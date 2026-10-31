'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const AgentHooksServer = require('../src/main/agent-hooks-server');

const TEST_PORT = 47899;

test('AgentHooksServer: handle status report', async () => {
  const server = new AgentHooksServer({ port: TEST_PORT });
  server.start();

  await new Promise(resolve => setTimeout(resolve, 100));

  let eventPayload = null;
  server.on('usage-updated', (usage) => {
    eventPayload = usage;
  });

  const body = JSON.stringify({
    five_hour: { used: 42 },
    seven_day: { used: 15 },
    context: 30,
    model: 'claude-3-7-sonnet'
  });

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: '/twocode-status',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      assert.strictEqual(res.statusCode, 200);
      resolve();
    });
    req.on('error', reject);
    req.end(body);
  });

  assert.ok(eventPayload);
  assert.strictEqual(eventPayload.fiveHour.used, 42);
  assert.strictEqual(eventPayload.model, 'claude-3-7-sonnet');

  server.stop();
});

test('AgentHooksServer: permission request and response', async () => {
  const server = new AgentHooksServer({ port: TEST_PORT + 1 });
  server.start();

  await new Promise(resolve => setTimeout(resolve, 100));

  let permEvent = null;
  server.on('permission-requested', (p) => {
    permEvent = p;
    // Approve permission
    server.respondPermission(p.id, true);
  });

  const body = JSON.stringify({
    type: 'PermissionRequest',
    command: 'npm install',
    message: 'Allow npm install?'
  });

  let responseBody = '';
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT + 1,
      path: '/twocode-hook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        const json = JSON.parse(responseBody);
        assert.strictEqual(json.decision, 'allow');
        resolve();
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  assert.ok(permEvent);
  assert.strictEqual(permEvent.command, 'npm install');

  server.stop();
});
