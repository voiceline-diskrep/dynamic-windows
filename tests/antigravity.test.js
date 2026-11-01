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
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    tool_calls: []
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'done');
  assert.strictEqual(completedFired, true);
});

test('AntigravityMonitor: processStep with PLANNER_RESPONSE DONE and thinking marks task as done', () => {
  const mon = new AntigravityMonitor();
  mon.processStep({
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    thinking: 'Final thoughts before user answer',
    tool_calls: []
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'done');
  assert.strictEqual(state.phase, 'Task finished');
});

test('AntigravityMonitor: processStep with Antigravity transcript format (name and args)', () => {
  const mon = new AntigravityMonitor();
  mon.processStep({
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    tool_calls: [
      {
        name: 'read_file',
        args: {
          Path: '"c:\\\\Users\\\\russell\\\\Documents\\\\test.js"',
          StartLine: '1'
        }
      }
    ]
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.tool, 'read_file');
  assert.strictEqual(state.file, 'test.js');
  assert.strictEqual(state.phase, 'Reading test.js');
});

test('AntigravityMonitor: intermediate tool response (type: GENERIC, status: DONE) does not trigger task completion', () => {
  const mon = new AntigravityMonitor();
  let completedFired = false;
  mon.on('task-completed', () => {
    completedFired = true;
  });

  // 1. Initial tool call running
  mon.processStep({
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run tests' } }]
  });
  assert.strictEqual(mon.getState().status, 'running');

  // 2. Tool result returned
  mon.processStep({
    type: 'GENERIC',
    status: 'DONE',
    content: 'All tests passed'
  });

  const state = mon.getState();
  // Status should remain running and NOT fire task-completed!
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(completedFired, false);
});

test('AntigravityMonitor: updateFromMcp sets detailed progress and overrides polling', () => {
  const mon = new AntigravityMonitor();
  mon.updateFromMcp({
    status: 'running',
    phase: 'Compiling executable binary',
    task: 'Build System',
    tool: 'run_command',
    progress: 75
  });

  const state = mon.getState();
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.phase, 'Compiling executable binary');
  assert.strictEqual(state.task, 'Build System');
  assert.strictEqual(state.tool, 'run_command');
  assert.strictEqual(state.progress, 75);
  assert.ok(Date.now() - mon.lastMcpTime < 100);
});

test('AntigravityMonitor: multi-project tracking stores and reports multiple concurrent projects', () => {
  const mon = new AntigravityMonitor();
  mon.updateFromMcp({
    conversationId: 'proj-1',
    project: 'Island',
    status: 'running',
    phase: 'Editing canvas-engine.js'
  });

  mon.updateFromMcp({
    conversationId: 'proj-2',
    project: 'Forma',
    status: 'thinking',
    phase: 'Planning UI architecture'
  });

  const state = mon.getState();
  assert.ok(Array.isArray(state.projects));
  assert.strictEqual(state.projects.length, 2);
  assert.strictEqual(state.projects[0].project, 'Island');
  assert.strictEqual(state.projects[0].status, 'running');
  assert.strictEqual(state.projects[1].project, 'Forma');
  assert.strictEqual(state.projects[1].status, 'thinking');
});
