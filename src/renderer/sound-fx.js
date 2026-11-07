'use strict';
/**
 * Dynamic Windows - Web Audio UI Sound Effects Engine
 * Procedurally synthesizes fluid, Apple-style tactile UI sound effects:
 * - 'expand': Fluid bubbly upward swoosh / pop
 * - 'collapse': Soft settling tuck / mechanical snap
 * - 'tap': Crisp, subtle haptic click for tabs and buttons
 * - 'notification': Crystalline dual-tone glass bell chime
 * - 'timer_done': Ascending celebratory alert chimes
 * - 'drop': Soft resonant drop shelf thud
 * - 'switch': Crisp toggle switch flick
 */

class SoundFXManager {
  constructor() {
    this.enabled = true;
    this.volume = 0.7; // 0.0 to 1.0
    this.audioCtx = null;
    this.masterGain = null;
    this._lastPlayTimes = {};
  }

  initContext() {
    if (this.audioCtx) return this.audioCtx;
    if (typeof window === 'undefined') return null;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      this.audioCtx = new AudioContextClass();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);
    } catch (e) {
      this.audioCtx = null;
    }
    return this.audioCtx;
  }

  ensureReady() {
    const ctx = this.initContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1.0, typeof vol === 'number' ? vol : 0.7));
    if (this.masterGain && this.audioCtx) {
      try {
        this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      } catch (e) {}
    }
  }

  setEnabled(val) {
    this.enabled = Boolean(val);
  }

  play(soundType) {
    if (!this.enabled || this.volume <= 0.005) return;

    // Rate limit rapid repetitive sounds (e.g. rapid taps within 45ms)
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const last = this._lastPlayTimes[soundType] || 0;
    if (soundType === 'tap' && now - last < 45) return;
    if (soundType === 'expand' && now - last < 250) return;
    if (soundType === 'collapse' && now - last < 250) return;
    this._lastPlayTimes[soundType] = now;

    const ctx = this.ensureReady();
    if (!ctx) return;

    try {
      switch (soundType) {
        case 'expand':
          this._playExpand(ctx);
          break;
        case 'collapse':
          this._playCollapse(ctx);
          break;
        case 'tap':
          this._playTap(ctx);
          break;
        case 'notification':
          this._playNotification(ctx);
          break;
        case 'timer_done':
          this._playTimerDone(ctx);
          break;
        case 'drop':
          this._playDrop(ctx);
          break;
        case 'switch':
          this._playSwitch(ctx);
          break;
        default:
          this._playTap(ctx);
          break;
      }
    } catch (e) {
      // Audio errors are non-critical
    }
  }

  // --- 1. Expand: Fluid Bubbly Pop / Swoosh ---
  _playExpand(ctx) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, t0);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.09);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(360, t0);
    osc2.frequency.exponentialRampToValueAtTime(780, t0 + 0.09);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, t0);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.42, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.13);

    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(filter);
    filter.connect(this.masterGain);

    osc.start(t0);
    osc2.start(t0);
    osc.stop(t0 + 0.14);
    osc2.stop(t0 + 0.14);
  }

  // --- 2. Collapse: Soft Settling Mechanical Snap ---
  _playCollapse(ctx) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(380, t0);
    osc.frequency.exponentialRampToValueAtTime(170, t0 + 0.07);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1100, t0);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.32, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);

    osc.connect(gain);
    gain.connect(filter);
    filter.connect(this.masterGain);

    osc.start(t0);
    osc.stop(t0 + 0.1);
  }

  // --- 3. Tap: Crisp Tactile Haptic Click ---
  _playTap(ctx) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1300, t0);
    osc.frequency.exponentialRampToValueAtTime(420, t0 + 0.025);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1100, t0);
    filter.Q.setValueAtTime(1.2, t0);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.28, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.028);

    osc.connect(gain);
    gain.connect(filter);
    filter.connect(this.masterGain);

    osc.start(t0);
    osc.stop(t0 + 0.032);
  }

  // --- 4. Notification: Crystalline Dual-Tone Glass Chime ---
  _playNotification(ctx) {
    const t0 = ctx.currentTime;

    const playBell = (freq, offset, duration, maxGain) => {
      const start = t0 + offset;
      const osc = ctx.createOscillator();
      const oscHarmonic = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      oscHarmonic.type = 'triangle';
      oscHarmonic.frequency.setValueAtTime(freq * 2.01, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(maxGain, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(gain);
      oscHarmonic.connect(gain);
      gain.connect(this.masterGain);

      osc.start(start);
      oscHarmonic.start(start);
      osc.stop(start + duration + 0.02);
      oscHarmonic.stop(start + duration + 0.02);
    };

    // Note 1: E6 (1318.5 Hz)
    playBell(1318.5, 0.0, 0.42, 0.35);
    // Note 2: B6 (1975.5 Hz)
    playBell(1975.5, 0.07, 0.55, 0.28);
  }

  // --- 5. Timer Done: Ascending Celebratory Alert Chimes ---
  _playTimerDone(ctx) {
    const t0 = ctx.currentTime;
    const notes = [
      { freq: 784.0, delay: 0.0, dur: 0.35 },   // G5
      { freq: 1046.5, delay: 0.14, dur: 0.4 },  // C6
      { freq: 1318.5, delay: 0.28, dur: 0.65 }  // E6
    ];

    notes.forEach(n => {
      const start = t0 + n.delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.4, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    });
  }

  // --- 6. Drop: Resonant Drop Shelf Thud ---
  _playDrop(ctx) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, t0);
    osc.frequency.exponentialRampToValueAtTime(80, t0 + 0.14);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, t0);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.48, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);

    osc.connect(gain);
    gain.connect(filter);
    filter.connect(this.masterGain);

    osc.start(t0);
    osc.stop(t0 + 0.18);
  }

  // --- 7. Switch: Crisp Toggle Flick ---
  _playSwitch(ctx) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(750, t0);
    osc.frequency.exponentialRampToValueAtTime(1250, t0 + 0.018);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.3, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.022);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t0);
    osc.stop(t0 + 0.025);
  }
}

const soundFX = new SoundFXManager();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SoundFXManager, soundFX };
}
