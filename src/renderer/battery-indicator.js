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

// Apple-style circular battery gauge ring for compact/active media pill
function drawBatteryRing(ctx, cx, cy, radius, percent, isCharging, alpha = 1.0) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const color = getBatteryColor(pct);
  const r = Math.max(5.5, radius || 6.2);
  const lineW = Math.max(1.5, r * 0.26);

  // Open-bottom Apple gauge arc (135 deg -> 405 deg = 270 deg sweep)
  const startAngle = Math.PI * 0.75;
  const totalSweep = Math.PI * 1.5;
  const endAngle = startAngle + totalSweep;

  // 1. Muted track ring
  ctx.beginPath();
  if (typeof ctx.arc === 'function') {
    ctx.arc(cx, cy, r, startAngle, endAngle, false);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  if (typeof ctx.stroke === 'function') ctx.stroke();

  // 2. Colored charge progress arc
  if (pct > 0) {
    const fillEnd = startAngle + totalSweep * (pct / 100);
    ctx.beginPath();
    if (typeof ctx.arc === 'function') {
      ctx.arc(cx, cy, r, startAngle, fillEnd, false);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    if (typeof ctx.stroke === 'function') ctx.stroke();
  }

  // 3. Center indicator: crisp vector bolt when charging, or compact percentage number
  if (isCharging) {
    const s = r * 0.52;
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.15, cy - s);
    ctx.lineTo(cx - s * 0.65, cy + s * 0.1);
    ctx.lineTo(cx - s * 0.05, cy + s * 0.1);
    ctx.lineTo(cx - s * 0.2, cy + s);
    ctx.lineTo(cx + s * 0.65, cy - s * 0.1);
    ctx.lineTo(cx + s * 0.05, cy - s * 0.1);
    ctx.closePath();
    ctx.fillStyle = color;
    if (typeof ctx.fill === 'function') ctx.fill();
  } else {
    ctx.fillStyle = '#f4f4f5';
    ctx.font = `700 ${Math.max(6, Math.round(r * 0.95))}px "Segoe UI Variable Text", Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (typeof ctx.fillText === 'function') {
      ctx.fillText(String(pct), cx, cy + 0.4);
    }
  }

  ctx.restore();
}

// Keep drawBatteryCircle exported as alias to drawBatteryRing for compact active pill
function drawBatteryCircle(ctx, cx, cy, radius, percent, isCharging, alpha = 1.0) {
  drawBatteryRing(ctx, cx, cy, Math.max(6.2, radius || 6.2), percent, isCharging, alpha);
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
    drawBatteryRing,
    drawBatteryCircle,
    drawBatteryIndicator
  };
}
