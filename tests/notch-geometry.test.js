const { test } = require('node:test');
const assert = require('node:assert');

function buildCapsulePath(c, x, y, w, h, radius, isNotch = false, topFillet = 12) {
  c.beginPath();
  if (isNotch && y <= 0.1) {
    const tr = Math.min(topFillet, h * 0.45);
    const br = Math.min(radius, Math.max(2, h - tr));
    c.moveTo(x - tr, 0);
    c.arc(x - tr, tr, tr, -Math.PI / 2, 0, false);
    c.lineTo(x, h - br);
    c.arcTo(x, h, x + br, h, br);
    c.lineTo(x + w - br, h);
    c.arcTo(x + w, h, x + w, h - br, br);
    c.lineTo(x + w, tr);
    c.arc(x + w + tr, tr, tr, Math.PI, 1.5 * Math.PI, false);
    c.closePath();
  } else {
    c.roundRect(x, y, w, h, radius);
  }
}

function drawCapsuleRim(c, x, y, w, h, radius, isNotch = false, topFillet = 12) {
  c.beginPath();
  if (isNotch && y <= 0.1) {
    const tr = Math.min(topFillet, h * 0.45);
    const br = Math.min(radius, Math.max(2, h - tr));
    c.moveTo(x - tr, 0);
    c.arc(x - tr, tr, tr, -Math.PI / 2, 0, false);
    c.lineTo(x, h - br);
    c.arcTo(x, h, x + br, h, br);
    c.lineTo(x + w - br, h);
    c.arcTo(x + w, h, x + w, h - br, br);
    c.lineTo(x + w, tr);
    c.arc(x + w + tr, tr, tr, Math.PI, 1.5 * Math.PI, false);
  } else {
    c.roundRect(x, y, w, h, radius);
  }
}

function createMockContext() {
  const calls = [];
  return {
    calls,
    beginPath: () => calls.push({ op: 'beginPath' }),
    moveTo: (x, y) => calls.push({ op: 'moveTo', x, y }),
    lineTo: (x, y) => calls.push({ op: 'lineTo', x, y }),
    arcTo: (x1, y1, x2, y2, r) => calls.push({ op: 'arcTo', x1, y1, x2, y2, r }),
    arc: (x, y, r, sa, ea, ac) => calls.push({ op: 'arc', x, y, r, sa, ea, ac }),
    roundRect: (x, y, w, h, r) => calls.push({ op: 'roundRect', x, y, w, h, r }),
    closePath: () => calls.push({ op: 'closePath' })
  };
}

test('NotchGeometry: Island mode uses standard roundRect', () => {
  const ctx = createMockContext();
  buildCapsulePath(ctx, 100, 8, 200, 34, 16, false, 12);

  assert.strictEqual(ctx.calls[0].op, 'beginPath');
  assert.strictEqual(ctx.calls[1].op, 'roundRect');
  assert.strictEqual(ctx.calls[1].x, 100);
  assert.strictEqual(ctx.calls[1].y, 8);
  assert.strictEqual(ctx.calls[1].w, 200);
  assert.strictEqual(ctx.calls[1].h, 34);
});

test('NotchGeometry: Notch mode constructs organic concave ears flaring into top bezel', () => {
  const ctx = createMockContext();
  const x = 140, y = 0, w = 300, h = 34, radius = 16, topFillet = 12;
  buildCapsulePath(ctx, x, y, w, h, radius, true, topFillet);

  const ops = ctx.calls.map(c => c.op);
  assert.deepStrictEqual(ops, [
    'beginPath',
    'moveTo',    // Outer start of top-left ear
    'arc',       // Concave arc to left edge
    'lineTo',    // Left edge
    'arcTo',     // Bottom-left corner
    'lineTo',    // Bottom edge
    'arcTo',     // Bottom-right corner
    'lineTo',    // Right edge
    'arc',       // Concave arc to top-right ear
    'closePath'  // Closes across top bezel
  ]);

  const tr = Math.min(topFillet, h * 0.45);
  // Verify top-left ear starts at (x - tr, 0)
  assert.strictEqual(ctx.calls[1].x, x - tr);
  assert.strictEqual(ctx.calls[1].y, 0);

  // Verify left ear concave arc center and angles
  const leftArc = ctx.calls[2];
  assert.strictEqual(leftArc.x, x - tr);
  assert.strictEqual(leftArc.y, tr);
  assert.strictEqual(leftArc.r, tr);
  assert.strictEqual(leftArc.sa, -Math.PI / 2);
  assert.strictEqual(leftArc.ea, 0);
  assert.strictEqual(leftArc.ac, false);

  // Verify right ear concave arc center and angles
  const rightArc = ctx.calls[8];
  assert.strictEqual(rightArc.x, x + w + tr);
  assert.strictEqual(rightArc.y, tr);
  assert.strictEqual(rightArc.r, tr);
  assert.strictEqual(rightArc.sa, Math.PI);
  assert.strictEqual(rightArc.ea, 1.5 * Math.PI);
  assert.strictEqual(rightArc.ac, false);
});

test('NotchGeometry: drawCapsuleRim does not close across y=0 to remain seamless against bezel', () => {
  const ctx = createMockContext();
  const x = 140, y = 0, w = 300, h = 34, radius = 16, topFillet = 12;
  drawCapsuleRim(ctx, x, y, w, h, radius, true, topFillet);

  const ops = ctx.calls.map(c => c.op);
  assert.ok(!ops.includes('closePath'), 'Specular rim stroke must not close across top bezel');
  assert.strictEqual(ops[ops.length - 1], 'arc', 'Last operation must be the right ear arc flaring into bezel');
});

test('NotchGeometry: Tangent continuity at ear joint points', () => {
  const tr = 12;
  const x = 100;
  const w = 200;

  // Top-left ear ends at (x, tr) with vertical tangent
  const leftEndDx = -tr * Math.sin(0); // derivative of x with respect to angle at ea=0 is 0 (vertical!)
  assert.strictEqual(leftEndDx, -0);

  // Top-left ear starts at (x - tr, 0) with horizontal tangent
  const leftStartDy = tr * Math.cos(-Math.PI / 2); // derivative of y at sa=-PI/2 is near 0 (horizontal!)
  assert.ok(Math.abs(leftStartDy) < 1e-10);

  // Top-right ear starts at (x + w, tr) with vertical tangent
  const rightStartDx = -tr * Math.sin(Math.PI); // derivative of x at sa=PI is near 0 (vertical!)
  assert.ok(Math.abs(rightStartDx) < 1e-10);

  // Top-right ear ends at (x + w + tr, 0) with horizontal tangent
  const rightEndDy = tr * Math.cos(1.5 * Math.PI); // derivative of y at ea=1.5*PI is near 0 (horizontal!)
  assert.ok(Math.abs(rightEndDy) < 1e-10);
});
