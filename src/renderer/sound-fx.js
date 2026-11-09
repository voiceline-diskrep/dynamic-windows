'use strict';
/**
 * Dynamic Windows - Web Audio UI Sound Effects Engine
 * Procedurally synthesizes fluid, Apple-style & tactile UI sound effects with 4 customizable sound presets:
 * - 'modern' (default): Fluid, crystalline glass chimes and bubbly acoustic pops (Apple-style)
 * - 'mechanical': Crisp mechanical keyboard & tactile switch clicks with metallic chimes
 * - 'soft': Warm, subtle wooden/felt marimba taps and gentle velvet swells
 * - 'retro': Nostalgic 8-bit chiptune blips, slides, and arcade power-up chimes
 *
 * Supported sound triggers:
 * - 'expand': Island opening swoosh / ratchet / bloom
 * - 'collapse': Island settling tuck / snap / slide
 * - 'tap': Crisp UI haptic click for tabs, buttons, and switches
 * - 'notification': Dual-tone alert bell chime
 * - 'timer_done': Ascending celebratory alert chimes
 * - 'drop': Drop shelf thud / impact
 * - 'switch': Mode toggle flick / chirp
 */

class SoundFXManager {
  constructor() {
    this.enabled = true;
    this.volume = 0.7; // 0.0 to 1.0
    this.preset = 'modern'; // 'modern' | 'mechanical' | 'soft' | 'retro'
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

  setPreset(name) {
    if (['modern', 'mechanical', 'soft', 'retro'].includes(name)) {
      this.preset = name;
    }
  }

  getPreset() {
    return this.preset || 'modern';
  }

  play(soundType, force = false) {
    if ((!this.enabled && !force) || this.volume <= 0.005) return;

    // Rate limit rapid repetitive sounds (e.g. rapid taps within 45ms)
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const last = this._lastPlayTimes[soundType] || 0;
    if (last > 0 && !force) {
      if (soundType === 'tap' && now - last < 45) return;
      if (soundType === 'expand' && now - last < 250) return;
      if (soundType === 'collapse' && now - last < 250) return;
    }
    this._lastPlayTimes[soundType] = now;

    const ctx = this.ensureReady();
    if (!ctx) return;

    const doPlay = () => {
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
          case 'alarm':
            this._playAlarm(ctx);
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
    };

    if (ctx.state === 'suspended') {
      ctx.resume().then(doPlay).catch(doPlay);
    } else {
      doPlay();
    }
  }

  // =========================================================================
  // 1. Expand
  // =========================================================================
  _playExpand(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // Tactile ratchet release: double crisp mechanical micro-clicks
      const playClick = (offset, freqStart) => {
        const start = t0 + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freqStart, start);
        osc.frequency.exponentialRampToValueAtTime(800, start + 0.016);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.02);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.022);
      };
      playClick(0.0, 2200);
      playClick(0.025, 2600);
      return;
    }

    if (preset === 'soft') {
      // Gentle warm velvet swell
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, t0);
      osc.frequency.exponentialRampToValueAtTime(320, t0 + 0.12);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, t0);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.34, t0 + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(filter);
      filter.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.17);
      return;
    }

    if (preset === 'retro') {
      // 8-bit rapid ascending chiptune arpeggio
      const steps = [
        { freq: 330, delay: 0.0, dur: 0.03 },
        { freq: 494, delay: 0.03, dur: 0.03 },
        { freq: 660, delay: 0.06, dur: 0.05 }
      ];
      steps.forEach(s => {
        const start = t0 + s.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(s.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.2, start + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.001, start + s.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + s.dur + 0.005);
      });
      return;
    }

    // Default 'modern': Fluid Bubbly Pop / Swoosh
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

  // =========================================================================
  // 2. Collapse
  // =========================================================================
  _playCollapse(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // Snappy magnetic latch / tactile switch snap
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1900, t0);
      osc.frequency.exponentialRampToValueAtTime(450, t0 + 0.018);

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(150, t0);
      osc2.frequency.exponentialRampToValueAtTime(60, t0 + 0.05);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.38, t0 + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);

      osc.connect(gain);
      osc2.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc2.start(t0);
      osc.stop(t0 + 0.07);
      osc2.stop(t0 + 0.07);
      return;
    }

    if (preset === 'soft') {
      // Soft rounded velvet tuck
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(240, t0);
      osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.08);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(650, t0);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.28, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
      osc.connect(gain);
      gain.connect(filter);
      filter.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.11);
      return;
    }

    if (preset === 'retro') {
      // 8-bit descending slide
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(587, t0);
      osc.frequency.exponentialRampToValueAtTime(293, t0 + 0.06);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.08);
      return;
    }

    // Default 'modern': Soft Settling Mechanical Snap
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

  // =========================================================================
  // 3. Tap
  // =========================================================================
  _playTap(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // High-precision mechanical key switch click (dual transient pulse)
      const oscSnap = ctx.createOscillator();
      const oscThud = ctx.createOscillator();
      const gain = ctx.createGain();

      oscSnap.type = 'triangle';
      oscSnap.frequency.setValueAtTime(2800, t0);
      oscSnap.frequency.exponentialRampToValueAtTime(1400, t0 + 0.012);

      oscThud.type = 'sine';
      oscThud.frequency.setValueAtTime(340, t0);
      oscThud.frequency.exponentialRampToValueAtTime(110, t0 + 0.018);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.42, t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.024);

      oscSnap.connect(gain);
      oscThud.connect(gain);
      gain.connect(this.masterGain);
      oscSnap.start(t0);
      oscThud.start(t0);
      oscSnap.stop(t0 + 0.026);
      oscThud.stop(t0 + 0.026);
      return;
    }

    if (preset === 'soft') {
      // Warm felt / marimba tap
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(540, t0);
      osc.frequency.exponentialRampToValueAtTime(280, t0 + 0.028);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(750, t0);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.24, t0 + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.035);

      osc.connect(gain);
      gain.connect(filter);
      filter.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.04);
      return;
    }

    if (preset === 'retro') {
      // 8-bit blip
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(920, t0);
      osc.frequency.setValueAtTime(1840, t0 + 0.008);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.022);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.024);
      return;
    }

    // Default 'modern': Crisp Tactile Haptic Click
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

  // =========================================================================
  // 4. Notification
  // =========================================================================
  _playNotification(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // Metallic typewriter bell strike with dual shimmer
      const playBell = (freq, offset, dur, gainVal) => {
        const start = t0 + offset;
        const osc = ctx.createOscillator();
        const oscH = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        oscH.type = 'sine';
        oscH.frequency.setValueAtTime(freq * 1.505, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(gainVal, start + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

        osc.connect(gain);
        oscH.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        oscH.start(start);
        osc.stop(start + dur + 0.01);
        oscH.stop(start + dur + 0.01);
      };
      playBell(2093.0, 0.0, 0.38, 0.35); // C7 metallic strike
      playBell(3136.0, 0.05, 0.45, 0.22); // G7 shimmer
      return;
    }

    if (preset === 'soft') {
      // Warm Rhodes / Celesta chord (F#5 & C#6)
      const playWarm = (freq, offset, dur, gainVal) => {
        const start = t0 + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1400, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(gainVal, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

        osc.connect(gain);
        gain.connect(filter);
        filter.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + dur + 0.01);
      };
      playWarm(740.0, 0.0, 0.5, 0.3); // F#5
      playWarm(1108.7, 0.05, 0.65, 0.25); // C#6
      return;
    }

    if (preset === 'retro') {
      // 8-bit item / coin pickup chime (B5 -> E6 square wave)
      const notes = [
        { freq: 987.8, delay: 0.0, dur: 0.08 },
        { freq: 1318.5, delay: 0.08, dur: 0.28 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.24, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.01);
      });
      return;
    }

    // Default 'modern': Crystalline Dual-Tone Glass Chime
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

  // =========================================================================
  // 5. Timer Done
  // =========================================================================
  _playTimerDone(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      const notes = [
        { freq: 1046.5, delay: 0.0, dur: 0.25 },
        { freq: 1568.0, delay: 0.12, dur: 0.3 },
        { freq: 2093.0, delay: 0.24, dur: 0.6 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.38, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.02);
      });
      return;
    }

    if (preset === 'soft') {
      const notes = [
        { freq: 659.3, delay: 0.0, dur: 0.4 },  // E5
        { freq: 830.6, delay: 0.15, dur: 0.45 }, // G#5
        { freq: 987.8, delay: 0.3, dur: 0.7 }   // B5
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, start);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1200, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(filter);
        filter.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.02);
      });
      return;
    }

    if (preset === 'retro') {
      const notes = [
        { freq: 523.3, delay: 0.0, dur: 0.09 },
        { freq: 659.3, delay: 0.09, dur: 0.09 },
        { freq: 784.0, delay: 0.18, dur: 0.09 },
        { freq: 1046.5, delay: 0.27, dur: 0.4 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.24, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.01);
      });
      return;
    }

    // Default 'modern': Ascending Celebratory Alert Chimes
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

  // =========================================================================
  // 5b. Alarm
  // =========================================================================
  _playAlarm(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      const notes = [
        { freq: 880.0, delay: 0.0, dur: 0.15 },
        { freq: 1174.66, delay: 0.12, dur: 0.15 },
        { freq: 1479.98, delay: 0.24, dur: 0.15 },
        { freq: 1760.0, delay: 0.36, dur: 0.35 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.01);
      });
      return;
    }

    if (preset === 'soft') {
      const notes = [
        { freq: 523.25, delay: 0.0, dur: 0.4 },
        { freq: 659.25, delay: 0.16, dur: 0.4 },
        { freq: 783.99, delay: 0.32, dur: 0.4 },
        { freq: 1046.5, delay: 0.48, dur: 0.6 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.28, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.03);
      });
      return;
    }

    if (preset === 'retro') {
      const notes = [
        { freq: 587.33, delay: 0.0, dur: 0.12 },
        { freq: 880.0, delay: 0.10, dur: 0.12 },
        { freq: 1174.66, delay: 0.20, dur: 0.12 },
        { freq: 1760.0, delay: 0.30, dur: 0.28 }
      ];
      notes.forEach(n => {
        const start = t0 + n.delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(n.freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.22, start + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + n.dur + 0.01);
      });
      return;
    }

    // Default 'modern': Vibrant Harmonic Alarm Arpeggio
    const notes = [
      { freq: 659.25, delay: 0.0, dur: 0.35 },
      { freq: 880.0, delay: 0.14, dur: 0.35 },
      { freq: 1108.73, delay: 0.28, dur: 0.4 },
      { freq: 1318.51, delay: 0.42, dur: 0.7 }
    ];
    notes.forEach(n => {
      const start = t0 + n.delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.42, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    });
  }

  // =========================================================================
  // 6. Drop
  // =========================================================================
  _playDrop(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // Solid bottom-out mechanical clack
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, t0);
      osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.06);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.5, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.1);
      return;
    }

    if (preset === 'soft') {
      // Deep cushioned bass drop
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t0);
      osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.14);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.38, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.18);
      return;
    }

    if (preset === 'retro') {
      // 8-bit impact thud
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(240, t0);
      osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.08);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.28, t0 + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.1);
      return;
    }

    // Default 'modern': Resonant Drop Shelf Thud
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

  // =========================================================================
  // 7. Switch
  // =========================================================================
  _playSwitch(ctx) {
    const t0 = ctx.currentTime;
    const preset = this.getPreset();

    if (preset === 'mechanical') {
      // Tactile toggle switch snap
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1800, t0);
      osc.frequency.exponentialRampToValueAtTime(650, t0 + 0.016);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.4, t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.022);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.025);
      return;
    }

    if (preset === 'soft') {
      // Muted soft switch
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, t0);
      osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.022);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.24, t0 + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.028);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.03);
      return;
    }

    if (preset === 'retro') {
      // 8-bit chirp
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(660, t0);
      osc.frequency.setValueAtTime(1320, t0 + 0.01);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.022);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.025);
      return;
    }

    // Default 'modern': Crisp Toggle Flick
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

if (typeof window !== 'undefined') {
  window.soundFX = soundFX;
  window.SoundFXManager = SoundFXManager;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SoundFXManager, soundFX };
}
