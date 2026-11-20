'use strict';

/**
 * Battery Indicator Module
 * Provides dynamic laptop battery detection, iPhone-style horizontal battery cell icon,
 * and precise color thresholds:
 *   - > 40%: Green (#22c55e)
 *   - 20% - 40%: Yellow (#eab308)
 *   - 0% - 20%: Red (#ef4444)
 */

function getBatteryColor(percent) {
  const p = Math.round(Number(percent) || 0);
  if (p > 40) return '#22c55e'; // Green
  if (p > 20) return '#eab308'; // Yellow (20-40)
  return '#ef4444';             // Red (20-0)
}

function getBatteryDisplay(batteryState) {
  if (!batteryState || !batteryState.hasBattery) {
    return null;
  }
  const percent = Math.max(0, Math.min(100, Math.round(Number(batteryState.percent) || 0)));
  const isCharging = Boolean(batteryState.isCharging);
  const color = getBatteryColor(percent);
  const text = `${percent}%`;
  const label = isCharging ? `${percent}% ⚡` : text;

  return {
    hasBattery: true,
    percent,
    isCharging,
    color,
    text,
    label
  };
}

function drawBatteryIcon(ctx, x, cy, bodyW, bodyH, percent, isCharging, alpha = 1.0) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const color = getBatteryColor(percent);
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const bx = x;
  const by = cy - bodyH / 2;
  const cornerR = Math.min(3, bodyH * 0.28);

  // 1. Outer iPhone battery casing (quiet translucent hairline)
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bx, by, bodyW, bodyH, cornerR);
  } else if (typeof ctx.rect === 'function') {
    ctx.rect(bx, by, bodyW, bodyH);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.48)';
  ctx.lineWidth = 1.15;
  if (typeof ctx.stroke === 'function') ctx.stroke();

  // 2. Positive terminal nub on right
  const nubW = 1.6;
  const nubH = Math.max(3, bodyH * 0.42);
  const nubX = bx + bodyW + 1.1;
  const nubY = cy - nubH / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(nubX, nubY, nubW, nubH, [0, 1.2, 1.2, 0]);
  } else if (typeof ctx.rect === 'function') {
    ctx.rect(nubX, nubY, nubW, nubH);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  if (typeof ctx.fill === 'function') ctx.fill();

  // 3. Inner proportional battery charge fill bar
  const inset = 1.6;
  const maxFillW = Math.max(2, bodyW - inset * 2);
  const fillW = Math.max(2, Math.round((maxFillW * pct) / 100));
  const fillH = Math.max(2, bodyH - inset * 2);
  const fillR = Math.max(1, cornerR - 1);

  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bx + inset, by + inset, fillW, fillH, fillR);
  } else if (typeof ctx.rect === 'function') {
    ctx.rect(bx + inset, by + inset, fillW, fillH);
  }
  ctx.fillStyle = color;
  if (typeof ctx.fill === 'function') ctx.fill();

  // 4. Clean centered charging bolt inside battery cell when charging
  if (isCharging) {
    const cx = bx + bodyW / 2;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.max(8, Math.round(bodyH * 0.85))}px "Segoe UI Symbol", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (typeof ctx.fillText === 'function') {
      ctx.fillText('⚡', cx, cy + 0.3);
    }
  }

  ctx.restore();
}

// Keep drawBatteryCircle exported as backwards-compatible wrapper around drawBatteryIcon
function drawBatteryCircle(ctx, cx, cy, radius, percent, isCharging, alpha = 1.0) {
  const bodyW = Math.max(16, Math.round((radius || 4.2) * 4.4));
  const bodyH = Math.max(9, Math.round((radius || 4.2) * 2.2));
  drawBatteryIcon(ctx, cx - bodyW / 2, cy, bodyW, bodyH, percent, isCharging, alpha);
}

function drawBatteryIndicator(ctx, startX, cy, batteryState, options = {}) {
  const display = getBatteryDisplay(batteryState);
  if (!display) return { width: 0, height: 0 };

  const {
    radius = 4.2,
    showText = true,
    font = '600 11px "Segoe UI Variable Text", Inter, sans-serif',
    textColor = '#f4f4f5',
    alpha = 1.0,
    isHovered = false
  } = options;

  ctx.save();
  ctx.globalAlpha = alpha;

  const bodyW = Math.max(18, Math.round(radius * 4.5));
  const bodyH = Math.max(9.5, Math.round(radius * 2.3));
  const iconTotalW = bodyW + 2.8;

  drawBatteryIcon(ctx, startX, cy, bodyW, bodyH, display.percent, display.isCharging, alpha);

  let totalW = iconTotalW;

  if (showText) {
    const textStartX = startX + iconTotalW + 5;
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? '#ffffff' : textColor;

    const labelToRender = `${display.percent}%`;
    if (typeof ctx.fillText === 'function') {
      ctx.fillText(labelToRender, textStartX, cy);
    }
    const textW = (typeof ctx.measureText === 'function' && ctx.measureText(labelToRender))
      ? ctx.measureText(labelToRender).width
      : 26;
    totalW = (textStartX + textW) - startX;
  }

  ctx.restore();
  return { width: totalW, height: bodyH + 2 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getBatteryColor,
    getBatteryDisplay,
    drawBatteryIcon,
    drawBatteryCircle,
    drawBatteryIndicator
  };
}
