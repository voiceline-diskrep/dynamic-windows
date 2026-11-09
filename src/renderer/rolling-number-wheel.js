'use strict';

/**
 * Rolling Number Wheel Engine for Dynamic Windows
 * Implements mechanical combination lock tumbler wheel animations for clocks,
 * timers, and pickers. When numbers update, the old digit rolls downwards and the
 * new digit enters from above with 3D cylindrical drum shading and detent bounce.
 */

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t, s = 1.12) {
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
}

/**
 * Computes a list of N cycling numbers ending at target digit.
 * e.g., target '8' with 3 steps returns ['5', '6', '7', '8'].
 */
function getTumblerCycleSequence(targetChar, steps = 3) {
  if (targetChar < '0' || targetChar > '9') {
    return [targetChar];
  }
  const targetNum = parseInt(targetChar, 10);
  const sequence = [];
  for (let i = steps; i >= 0; i--) {
    const num = (targetNum - i + 100) % 10;
    sequence.push(String(num));
  }
  return sequence;
}

/**
 * Computes the active outgoing and incoming characters and sub-progress
 * during a multi-step tumbler wheel spin.
 */
function getCycleStepAtProgress(sequence, progress) {
  if (!sequence || sequence.length <= 1) {
    return {
      outgoing: sequence ? sequence[0] : '',
      incoming: sequence ? sequence[0] : '',
      subProgress: 1.0,
      isSettled: true
    };
  }

  const totalSteps = sequence.length - 1;
  const p = Math.max(0, Math.min(1.0, progress));
  const easedP = easeOutCubic(p);
  const stepFloat = easedP * totalSteps;
  const stepIdx = Math.min(totalSteps - 1, Math.floor(stepFloat));
  const subP = stepFloat - stepIdx;

  if (p >= 1.0) {
    return {
      outgoing: sequence[totalSteps],
      incoming: sequence[totalSteps],
      subProgress: 1.0,
      isSettled: true
    };
  }

  return {
    outgoing: sequence[stepIdx],
    incoming: sequence[stepIdx + 1],
    subProgress: subP,
    isSettled: false
  };
}

class RollingNumberWheel {
  constructor(slotId) {
    this.slotId = slotId;
    this.columns = []; // Array of column states
    this.lastHover = false;
    this.lastTimeString = '';
  }

  /**
   * Triggers a combination lock spin across all digits
   */
  triggerSpin(now = performance.now(), steps = 3) {
    this.columns.forEach((col, idx) => {
      if (col.current >= '0' && col.current <= '9') {
        col.cycleSequence = getTumblerCycleSequence(col.current, steps);
        col.isSpinning = true;
        col.spinStartTime = now + idx * 35; // subtle ripple stagger
        col.spinDuration = 380;
      }
    });
  }

  /**
   * Renders the rolling text onto the HTML5 Canvas
   */
  render(ctx, text, x, y, options = {}) {
    if (!text) return;
    const now = performance.now();
    const str = String(text);

    // Synchronize columns
    if (this.columns.length !== str.length || this.lastTimeString.length !== str.length) {
      this.columns = str.split('').map(ch => ({
        current: ch,
        previous: ch,
        startTime: 0,
        duration: 250,
        isSpinning: false,
        spinStartTime: 0,
        spinDuration: 380,
        cycleSequence: [ch]
      }));
      this.lastTimeString = str;
    }

    // Check for digit changes
    for (let i = 0; i < str.length; i++) {
      const col = this.columns[i];
      const newChar = str[i];
      if (col.current !== newChar && !col.isSpinning) {
        col.previous = col.current;
        col.current = newChar;
        col.startTime = now;
        col.duration = 240;
        if (typeof options.onDigitChange === 'function') {
          options.onDigitChange(col, i);
        }
      }
    }
    this.lastTimeString = str;

    // Detect hover transition to trigger tumbler wheel spin
    const isHovered = !!options.isHovered;
    if (isHovered && !this.lastHover) {
      this.triggerSpin(now, options.spinSteps || 3);
    }
    this.lastHover = isHovered;

    // Setup typography and dimensions
    ctx.save();
    if (options.font) ctx.font = options.font;
    if (options.fillStyle) ctx.fillStyle = options.fillStyle;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const digitW = Math.ceil(ctx.measureText('0').width);
    const colonW = Math.ceil(ctx.measureText(':').width);
    const spaceW = Math.ceil(ctx.measureText(' ').width);

    // Compute column widths using tabular spacing for numeric stability
    const colWidths = str.split('').map(ch => {
      if (ch >= '0' && ch <= '9') return digitW + 2;
      if (ch === ':') return colonW + 2;
      if (ch === ' ') return spaceW;
      return Math.ceil(ctx.measureText(ch).width) + 2;
    });

    const totalW = colWidths.reduce((a, b) => a + b, 0);

    const fontSizeMatch = (options.font || '').match(/(\d+)px/);
    const fontSize = fontSizeMatch ? parseInt(fontSizeMatch[1], 10) : 14;
    const slotH = options.slotHeight || Math.round(fontSize * 1.35);

    // Alignment handling
    const align = options.align || 'left';
    let curX = x;
    if (align === 'center') {
      curX = x - totalW / 2;
    } else if (align === 'right') {
      curX = x - totalW;
    }

    const baseline = options.baseline || 'middle';
    let centerY = y;
    if (baseline === 'top') {
      centerY = y + slotH / 2;
    } else if (baseline === 'bottom') {
      centerY = y - slotH / 2;
    }

    // Render each tumbler wheel column
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const col = this.columns[i];
      const colW = colWidths[i];
      const colCenterX = curX + colW / 2;
      const isDigit = ch >= '0' && ch <= '9';

      // 1. Draw subtle physical lock cylinder slot backdrop when hovered
      if ((isHovered || options.showPlates) && isDigit) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(curX + 1, centerY - slotH / 2, colW - 2, slotH, 3.5);
        ctx.fillStyle = isHovered ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
        ctx.fill();
        ctx.strokeStyle = isHovered ? 'rgba(56, 189, 248, 0.35)' : 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      // 2. Static punctuation / non-digits
      if (!isDigit) {
        ctx.fillText(ch, colCenterX, centerY);
        curX += colW;
        continue;
      }

      // 3. Evaluate active roll state (multi-step spin vs. 1-step time tick)
      let outgoingChar = col.current;
      let incomingChar = col.current;
      let rollProgress = 1.0;
      let isRolling = false;

      if (col.isSpinning) {
        const spinElapsed = now - col.spinStartTime;
        if (spinElapsed < 0) {
          // Stagger delay waiting to spin
          outgoingChar = col.previous || col.current;
          incomingChar = col.previous || col.current;
          rollProgress = 1.0;
        } else {
          const spinP = Math.min(1.0, spinElapsed / col.spinDuration);
          const stepInfo = getCycleStepAtProgress(col.cycleSequence, spinP);
          outgoingChar = stepInfo.outgoing;
          incomingChar = stepInfo.incoming;
          rollProgress = stepInfo.subProgress;
          isRolling = !stepInfo.isSettled;

          if (spinP >= 1.0) {
            col.isSpinning = false;
            col.previous = col.current;
            col.startTime = 0;
          }
        }
      } else if (col.startTime > 0) {
        const tickElapsed = now - col.startTime;
        const tickP = Math.min(1.0, tickElapsed / col.duration);
        outgoingChar = col.previous;
        incomingChar = col.current;
        rollProgress = tickP;
        isRolling = tickP < 1.0;
        if (tickP >= 1.0) {
          col.previous = col.current;
          col.startTime = 0;
        }
      }

      // If stationary, render directly
      if (!isRolling || outgoingChar === incomingChar) {
        ctx.fillText(col.current, colCenterX, centerY);
        curX += colW;
        continue;
      }

      // 4. Draw rolling tumbler cylinder with slot clipping
      ctx.save();
      ctx.beginPath();
      ctx.rect(curX, centerY - slotH / 2, colW, slotH);
      ctx.clip();

      const ease = easeOutBack(rollProgress, 1.08);

      // Outgoing number rolls down
      const yOut = centerY + ease * slotH;
      const alphaOut = Math.max(0, 1 - rollProgress);
      ctx.save();
      ctx.globalAlpha = (options.alpha || 1.0) * alphaOut;
      ctx.fillText(outgoingChar, colCenterX, yOut);
      ctx.restore();

      // Incoming number enters from top
      const yIn = centerY - (1 - ease) * slotH;
      const alphaIn = Math.min(1.0, rollProgress * 1.25);
      ctx.save();
      ctx.globalAlpha = (options.alpha || 1.0) * alphaIn;
      ctx.fillText(incomingChar, colCenterX, yIn);
      ctx.restore();

      // 5. 3D cylindrical drum top & bottom shadow gradient
      const cylGrad = ctx.createLinearGradient(0, centerY - slotH / 2, 0, centerY + slotH / 2);
      cylGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.42)');
      cylGrad.addColorStop(0.2, 'rgba(0, 0, 0, 0.0)');
      cylGrad.addColorStop(0.8, 'rgba(0, 0, 0, 0.0)');
      cylGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.42)');
      ctx.fillStyle = cylGrad;
      ctx.fillRect(curX, centerY - slotH / 2, colW, slotH);

      ctx.restore(); // Restore clip

      curX += colW;
    }

    ctx.restore();
  }
}

// Global instance registry for seamless slot persistence across frames
const wheelRegistry = new Map();

function getRollingWheel(slotId) {
  if (!wheelRegistry.has(slotId)) {
    wheelRegistry.set(slotId, new RollingNumberWheel(slotId));
  }
  return wheelRegistry.get(slotId);
}

function drawRollingTime(ctx, slotId, text, x, y, options = {}) {
  const wheel = getRollingWheel(slotId);
  wheel.render(ctx, text, x, y, options);
}

function triggerRollingWheelSpin(slotId, steps = 3) {
  const wheel = getRollingWheel(slotId);
  wheel.triggerSpin(performance.now(), steps);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RollingNumberWheel,
    getRollingWheel,
    drawRollingTime,
    triggerRollingWheelSpin,
    getTumblerCycleSequence,
    getCycleStepAtProgress,
    easeOutCubic,
    easeOutBack
  };
}
