'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CallMonitor = require('../src/main/call-monitor');
const NotificationMonitor = require('../src/main/notification-monitor');
const AntigravityMonitor = require('../src/main/antigravity-monitor');

test('CallMonitor: idle polling defaults to 3000ms instead of 650ms to save CPU', () => {
  const cm = new CallMonitor({ disableAutoStart: true });
  assert.strictEqual(cm.pollIntervalMs, 3000, 'CallMonitor idle poll interval must be 3000ms');
});

test('NotificationMonitor: polling interval defaults to 10000ms to avoid frequent PowerShell spawns', () => {
  const nm = new NotificationMonitor();
  assert.strictEqual(nm.pollIntervalMs, 10000, 'NotificationMonitor poll interval must be 10000ms');
});

test('AntigravityMonitor: idle polling defaults to 1500ms to reduce disk read overhead', () => {
  const agm = new AntigravityMonitor({ disableAutoStart: true });
  assert.strictEqual(agm.pollInterval, 1500, 'AntigravityMonitor idle poll interval must be 1500ms');
});
