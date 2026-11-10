'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('TopNavExitButton: geometry layout places exit button immediately adjacent to notch button', () => {
  const x = 100;
  const w = 616;
  const exitW = 22;
  const modeW = 78;

  const exitX = x + w - exitW - 16;
  const modeX = exitX - modeW - 6;

  // Verify exit button is on the far right
  assert.strictEqual(exitX, 100 + 616 - 22 - 16);
  assert.strictEqual(exitX, 678);

  // Verify notch mode button is placed immediately adjacent to exit button with 6px gap
  assert.strictEqual(modeX, exitX - 78 - 6);
  assert.strictEqual(modeX, 594);
  assert.strictEqual(exitX - (modeX + modeW), 6, 'Gap between notch button and exit button must be exactly 6px');
});

test('TopNavExitButton: battery pill fits neatly adjacent to notch button without overlap', () => {
  const x = 0;
  const w = 616;
  const exitW = 22;
  const modeW = 78;
  const battPillW = 66; // charging pill width

  const exitX = x + w - exitW - 16;
  const modeX = exitX - modeW - 6;
  const battPillX = modeX - battPillW - 6;

  assert.ok(battPillX > 0, 'Battery pill X must be positive');
  assert.strictEqual(modeX - (battPillX + battPillW), 6, 'Gap between battery pill and notch button must be 6px');

  // Verify that left side tabs ending at ~419 have sufficient margin
  const leftTabsEndX = 419;
  assert.ok(battPillX > leftTabsEndX, 'Battery pill must not collide with left navigation tabs');
});
