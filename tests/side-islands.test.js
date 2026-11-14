'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const canvasEnginePath = path.join(__dirname, '..', 'src', 'renderer', 'canvas-engine.js');
const canvasEngineSrc = fs.readFileSync(canvasEnginePath, 'utf8');

function loadComputeSideIslandsLayout() {
  const match = canvasEngineSrc.match(/function computeSideIslandsLayout\([\s\S]*?\n\}/);
  assert.ok(match, 'computeSideIslandsLayout function must exist in canvas-engine.js');
  const script = new vm.Script(`${match[0]}; computeSideIslandsLayout;`);
  return script.runInNewContext({});
}

test('SideIslandsLayout: places Antigravity progress pill exclusively on left side of center island', () => {
  const computeSideIslandsLayout = loadComputeSideIslandsLayout();
  const res = computeSideIslandsLayout({
    centerX: 400,
    centerW: 160,
    hasTimer: false,
    timerW: 0,
    hasAI: true,
    aiW: 112,
    hasCall: false,
    callW: 0,
    gap: 8
  });

  assert.strictEqual(res.leftAiX, 400 - 112 - 8);
  assert.strictEqual(res.rightTimerX, null);
  assert.strictEqual(res.rightCallX, null);
});

test('SideIslandsLayout: places Timer/Focus/Stopwatch right beside center island on the right', () => {
  const computeSideIslandsLayout = loadComputeSideIslandsLayout();
  const res = computeSideIslandsLayout({
    centerX: 400,
    centerW: 160,
    hasTimer: true,
    timerW: 88,
    hasAI: false,
    aiW: 0,
    hasCall: false,
    callW: 0,
    gap: 8
  });

  assert.strictEqual(res.leftAiX, null);
  assert.strictEqual(res.rightTimerX, 400 + 160 + 8);
  assert.strictEqual(res.rightCallX, null);
});

test('SideIslandsLayout: stacks Call capsule after Timer without collision when both are active', () => {
  const computeSideIslandsLayout = loadComputeSideIslandsLayout();
  const res = computeSideIslandsLayout({
    centerX: 260,
    centerW: 520,
    hasTimer: true,
    timerW: 92,
    hasAI: true,
    aiW: 118,
    hasCall: true,
    callW: 110,
    gap: 8
  });

  assert.strictEqual(res.leftAiX, 260 - 118 - 8);
  assert.strictEqual(res.rightTimerX, 260 + 520 + 8);
  assert.strictEqual(res.rightCallX, 260 + 520 + 92 + 16);
  assert.strictEqual(res.rightCallX - (res.rightTimerX + 92), 8);
  assert.ok(res.leftAiX >= 0, 'Left Antigravity pill stays inside 1040px wide window even at 520px expanded lyrics width');
  assert.ok(res.rightCallX + 110 <= 1040, 'Stacked right pills fit within 1040px wide window');
});

test('SideIslandsLayout: places Call capsule immediately adjacent when Timer is inactive', () => {
  const computeSideIslandsLayout = loadComputeSideIslandsLayout();
  const res = computeSideIslandsLayout({
    centerX: 400,
    centerW: 160,
    hasTimer: false,
    timerW: 0,
    hasAI: true,
    aiW: 112,
    hasCall: true,
    callW: 100,
    gap: 8
  });

  assert.strictEqual(res.leftAiX, 400 - 112 - 8);
  assert.strictEqual(res.rightTimerX, null);
  assert.strictEqual(res.rightCallX, 400 + 160 + 8);
});

test('CanvasEngine: detached side islands render outside center capsule clip path', () => {
  const renderSection = canvasEngineSrc.match(/renderRestingPill\(x, y, w, h, restAlpha\);\s*ctx\.restore\(\);\s*renderDetachedSideIslands\(x, y, w, h, restAlpha\);/);
  assert.ok(renderSection, 'renderDetachedSideIslands must be invoked after ctx.restore() of center clip');
});
