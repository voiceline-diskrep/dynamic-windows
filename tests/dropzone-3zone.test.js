'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function computeDropZoneHover(clientX, windowWidth) {
  const oneThird = windowWidth / 3;
  if (clientX < oneThird) {
    return 'onetime';
  } else if (clientX < oneThird * 2) {
    return 'keep';
  } else {
    return 'send_to_ai';
  }
}

test('3-Zone Drop Shelf: determines correct zone based on X coordinate', () => {
  const width = 900;

  // Zone 1: 0 to 300 -> onetime
  assert.equal(computeDropZoneHover(50, width), 'onetime');
  assert.equal(computeDropZoneHover(299, width), 'onetime');

  // Zone 2: 300 to 600 -> keep
  assert.equal(computeDropZoneHover(300, width), 'keep');
  assert.equal(computeDropZoneHover(450, width), 'keep');
  assert.equal(computeDropZoneHover(599, width), 'keep');

  // Zone 3: 600 to 900 -> send_to_ai
  assert.equal(computeDropZoneHover(600, width), 'send_to_ai');
  assert.equal(computeDropZoneHover(750, width), 'send_to_ai');
  assert.equal(computeDropZoneHover(899, width), 'send_to_ai');
});
