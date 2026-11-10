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

    // Setup typography and natural compact dimensions
    ctx.save();
    if (options.font) ctx.font = options.font;
    if (options.fillStyle) ctx.fillStyle = options.fillStyle;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Measure exact string width for natural compact typographic kerning
    const totalW = ctx.measureText(str).width;

    const fontSizeMatch = (options.font || '').match(/(\d+)px/);
    const fontSize = fontSizeMatch ? parseInt(fontSizeMatch[1], 10) : 14;
    const slotH = options.slotHeight || Math.round(fontSize * 1.35);

    // Alignment handling
    const align = options.align || 'left';
    let startX = x;
    if (align === 'center') {
      startX = x - totalW / 2;
    } else if (align === 'right') {
      startX = x - totalW;
    }

    const baseline = options.baseline || 'middle';
    let centerY = y;
    if (baseline === 'top') {
      centerY = y + slotH / 2;
    } else if (baseline === 'bottom') {
      centerY = y - slotH / 2;
    }

    // Subtle unified frosted capsule backdrop when hovered over clock
    if (isHovered && options.showPlates) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(startX - 4, centerY - slotH / 2 - 2, totalW + 8, slotH + 4, 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // Render each tumbler wheel character at its exact natural position
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const col = this.columns[i];
      const isDigit = ch >= '0' && ch <= '9';

      const prefixW = ctx.measureText(str.slice(0, i)).width;
      const charW = ctx.measureText(ch).width;
      const colLeft = startX + prefixW;
      const colCenterX = colLeft + charW / 2;

      // Static punctuation / non-digits
      if (!isDigit) {
        ctx.fillText(ch, colCenterX, centerY);
        continue;
      }

      // Evaluate active roll state (multi-step spin vs. 1-step time tick)
      let outgoingChar = col.current;
      let incomingChar = col.current;
      let rollProgress = 1.0;
      let isRolling = false;

      if (col.isSpinning) {
        const spinElapsed = now - col.spinStartTime;
        if (spinElapsed < 0) {
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
        continue;
      }

      // Draw rolling tumbler cylinder with slot clipping
      const maxCharW = Math.max(charW, ctx.measureText(outgoingChar).width, ctx.measureText(incomingChar).width);
      const clipLeft = colCenterX - maxCharW / 2 - 0.5;
      const clipW = maxCharW + 1;

      ctx.save();
      ctx.beginPath();
      ctx.rect(clipLeft, centerY - slotH / 2, clipW, slotH);
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
      const alphaIn = Math.min(1.0, rollProgress * 1.35);
      ctx.save();
      ctx.globalAlpha = (options.alpha || 1.0) * alphaIn;
      ctx.fillText(incomingChar, colCenterX, yIn);
      ctx.restore();

      // 3D cylindrical drum subtle gradient
      const cylGrad = ctx.createLinearGradient(0, centerY - slotH / 2, 0, centerY + slotH / 2);
      cylGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.28)');
      cylGrad.addColorStop(0.12, 'rgba(0, 0, 0, 0.0)');
      cylGrad.addColorStop(0.88, 'rgba(0, 0, 0, 0.0)');
      cylGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.28)');
      ctx.fillStyle = cylGrad;
      ctx.fillRect(clipLeft, centerY - slotH / 2, clipW, slotH);

      ctx.restore(); // Restore clip
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

function hasActiveTumblerRoll() {
  const now = performance.now();
  for (const wheel of wheelRegistry.values()) {
    if (!wheel.columns) continue;
    for (const col of wheel.columns) {
      if (col.isSpinning && (now - col.spinStartTime < col.spinDuration + 100)) {
        return true;
      }
      if (col.startTime > 0 && (now - col.startTime < col.duration + 100)) {
        return true;
      }
    }
  }
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RollingNumberWheel,
    getRollingWheel,
    drawRollingTime,
    triggerRollingWheelSpin,
    hasActiveTumblerRoll,
    getTumblerCycleSequence,
    getCycleStepAtProgress,
    easeOutCubic,
    easeOutBack
  };
}
