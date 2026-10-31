'use strict';

const test = require('node:test');
const assert = require('node:assert');
const AntigravityMonitor = require('../src/main/antigravity-monitor');

test('AntigravityMonitor: initial state', () => {
  const mon = new AntigravityMonitor();
  const state = mon.getState();
  assert.strictEqual(state.provider, 'Google Antigravity');
  assert.strictEqual(state.status, 'idle');
});

test('AntigravityMonitor: processStep with run_command', () => {
  const mon = new AntigravityMonitor();
  mon.processStep({
    tool_calls: [
      {
        ToolName: 'run_command',
        Arguments: {
          CommandLine: 'git status',
          toolSummary: 'Check repository status'
        }
      }
    ]
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.tool, 'run_command');
  assert.strictEqual(state.command, 'Check repository status');
});

test('AntigravityMonitor: processStep with write_file', () => {
  const mon = new AntigravityMonitor();
  mon.processStep({
    tool_calls: [
      {
        ToolName: 'write_file',
        Arguments: {
          Path: 'C:\\Users\\russell\\Documents\\test.js'
        }
      }
    ]
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.file, 'test.js');
  assert.strictEqual(state.phase, 'Editing test.js');
});

test('AntigravityMonitor: processStep with thinking', () => {
  const mon = new AntigravityMonitor();
  mon.processStep({
    thinking: 'Analyzing codebase and planning solution'
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'thinking');
});

test('AntigravityMonitor: processStep with task completion', () => {
  const mon = new AntigravityMonitor();
  let completedFired = false;
  mon.on('task-completed', () => {
    completedFired = true;
  });

  mon.processStep({
    status: 'DONE'
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'done');
  assert.strictEqual(completedFired, true);
});
