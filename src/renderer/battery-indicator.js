'use strict';

/**
 * Battery Indicator Module
 * Provides dynamic laptop battery detection, Apple-style circular indicators,
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

function drawBatteryCircle(ctx, cx, cy, radius, percent, isCharging, alpha = 1.0) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const color = getBatteryColor(percent);

  // 1. Subtle dark glass base ring + soft glow halo (zero shadowBlur overhead)
  ctx.beginPath();
  ctx.arc(cx, cy, radius + (isCharging ? 2.8 : 1.8), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * (isCharging ? 0.28 : 0.18);
  ctx.fill();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 1.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fill();

  // 2. Dynamic Solid Battery Circle Dot
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // 3. Crisp inner detail / charging glyph
  if (isCharging) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.round(radius * 1.5)}px "Segoe UI Symbol", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡', cx, cy + 0.5);
  }

  ctx.restore();
}

function drawBatteryIndicator(ctx, startX, cy, batteryState, options = {}) {
  const display = getBatteryDisplay(batteryState);
  if (!display) return { width: 0, height: 0 };

  const {
    radius = 4.5,
    showText = true,
    font = '600 11px "Segoe UI Variable Text", Inter, sans-serif',
    textColor = '#f4f4f5',
    alpha = 1.0,
    isHovered = false
  } = options;

  ctx.save();
  ctx.globalAlpha = alpha;

  const circleX = startX + radius + 1;
  drawBatteryCircle(ctx, circleX, cy, radius, display.percent, display.isCharging, alpha);

  let totalW = (radius + 1) * 2;

  if (showText) {
    const textStartX = circleX + radius + 5;
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? '#ffffff' : textColor;

    const labelToRender = display.isCharging ? `${display.percent}%` : `${display.percent}%`;
    ctx.fillText(labelToRender, textStartX, cy);
    const textW = ctx.measureText(labelToRender).width;
    totalW = (textStartX + textW) - startX;

    if (display.isCharging) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 10px "Segoe UI Symbol", sans-serif';
      ctx.fillText('⚡', textStartX + textW + 3, cy);
      totalW += 12;
    }
  }

  ctx.restore();
  return { width: totalW, height: (radius + 2) * 2 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getBatteryColor,
    getBatteryDisplay,
    drawBatteryCircle,
    drawBatteryIndicator
  };
}
