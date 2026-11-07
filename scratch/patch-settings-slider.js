const fs = require('fs');
let content = fs.readFileSync('src/renderer/settings.html', 'utf8');

// 1. Add "Play Test" button to HTML next to the slider badge
const oldSliderRow = `<input type="range" id="setting-soundVolume" min="5" max="100" step="5" value="70" style="width: 140px; accent-color: #2563eb; cursor: pointer;">
            <span id="sound-volume-badge" style="font-size: 13px; font-weight: 700; color: #ffffff; background: rgba(37,99,235,0.25); border: 1px solid rgba(37,99,235,0.5); padding: 3px 8px; border-radius: 6px; width: 48px; text-align: center;">70%</span>
          </div>`;

const newSliderRow = `<input type="range" id="setting-soundVolume" min="5" max="100" step="5" value="70" style="width: 140px; accent-color: #2563eb; cursor: pointer;">
            <span id="sound-volume-badge" style="font-size: 13px; font-weight: 700; color: #ffffff; background: rgba(37,99,235,0.25); border: 1px solid rgba(37,99,235,0.5); padding: 3px 8px; border-radius: 6px; width: 48px; text-align: center;">70%</span>
            <button class="btn" id="btn-test-sound" type="button" style="padding: 4px 10px; font-size: 12px; font-weight: 600;">Play Test</button>
          </div>`;

if (!content.includes('id="btn-test-sound"')) {
  content = content.replace(oldSliderRow, newSliderRow);
}

// 2. In loadSettings(): correctly load soundEffects and soundVolume from cfg
const loadTarget = `const elLyrics = document.getElementById('setting-dynamicLyrics');
        if (elLyrics) elLyrics.checked = cfg.dynamicLyrics !== false;`;

const loadReplacement = `const elLyrics = document.getElementById('setting-dynamicLyrics');
        if (elLyrics) elLyrics.checked = cfg.dynamicLyrics !== false;

        // Sound Effects & Feedback
        const elSound = document.getElementById('setting-soundEffects');
        const soundEnabled = cfg.soundEffects !== false;
        if (elSound) elSound.checked = soundEnabled;

        const elSoundVol = document.getElementById('setting-soundVolume');
        const elSoundVolBadge = document.getElementById('sound-volume-badge');
        const soundVolPct = typeof cfg.soundVolume === 'number' ? Math.round(cfg.soundVolume * 100) : 70;
        if (elSoundVol) elSoundVol.value = soundVolPct;
        if (elSoundVolBadge) elSoundVolBadge.textContent = soundVolPct + '%';

        if (typeof soundFX !== 'undefined') {
          soundFX.setEnabled(soundEnabled);
          soundFX.setVolume(soundVolPct / 100);
        }`;

if (content.includes(loadTarget) && !content.includes('// Sound Effects & Feedback')) {
  content = content.replace(loadTarget, loadReplacement);
}

// 3. In event bindings: replace the sound settings wiring
const oldBinding = `    bindSettingChange('setting-soundEffects', 'soundEffects');

    const soundToggleEl = document.getElementById('setting-soundEffects');
    soundToggleEl?.addEventListener('change', () => {
      if (typeof soundFX !== 'undefined') {
        soundFX.setEnabled(soundToggleEl.checked);
        if (soundToggleEl.checked) soundFX.play('tap');
      }
    });

    const soundVolEl = document.getElementById('setting-soundVolume');
    const soundVolBadgeEl = document.getElementById('sound-volume-badge');
    soundVolEl?.addEventListener('input', () => {
      const pct = parseInt(soundVolEl.value, 10) || 70;
      if (soundVolBadgeEl) soundVolBadgeEl.textContent = pct + '%';
      if (typeof soundFX !== 'undefined') soundFX.setVolume(pct / 100);
    });
    soundVolEl?.addEventListener('change', async () => {
      const pct = parseInt(soundVolEl.value, 10) || 70;
      await ipcRenderer.invoke('save-app-settings', { soundVolume: pct / 100 });
      if (typeof soundFX !== 'undefined') soundFX.play('notification');
    });`;

const newBinding = `    // Sound Effects & Volume Controls
    const soundToggleEl = document.getElementById('setting-soundEffects');
    const soundVolEl = document.getElementById('setting-soundVolume');
    const soundVolBadgeEl = document.getElementById('sound-volume-badge');
    const btnTestSound = document.getElementById('btn-test-sound');

    soundToggleEl?.addEventListener('change', async () => {
      const isEnabled = soundToggleEl.checked;
      if (typeof soundFX !== 'undefined') {
        soundFX.setEnabled(isEnabled);
        if (isEnabled) soundFX.play('tap', true);
      }
      await ipcRenderer.invoke('save-app-settings', { soundEffects: isEnabled });
    });

    const applySoundVolume = async (playFeedback = false) => {
      if (!soundVolEl) return;
      const pct = parseInt(soundVolEl.value, 10) || 70;
      const vol = pct / 100;
      if (soundVolBadgeEl) soundVolBadgeEl.textContent = pct + '%';
      if (typeof soundFX !== 'undefined') {
        soundFX.setVolume(vol);
      }
      let payload = { soundVolume: vol };
      if (soundToggleEl && !soundToggleEl.checked && pct > 0) {
        soundToggleEl.checked = true;
        payload.soundEffects = true;
        if (typeof soundFX !== 'undefined') soundFX.setEnabled(true);
      }
      await ipcRenderer.invoke('save-app-settings', payload);
      if (playFeedback && typeof soundFX !== 'undefined') {
        soundFX.play('notification', true);
      }
    };

    soundVolEl?.addEventListener('input', () => {
      const pct = parseInt(soundVolEl.value, 10) || 70;
      if (soundVolBadgeEl) soundVolBadgeEl.textContent = pct + '%';
      if (typeof soundFX !== 'undefined') {
        soundFX.setVolume(pct / 100);
      }
    });

    soundVolEl?.addEventListener('change', () => {
      applySoundVolume(true);
    });

    btnTestSound?.addEventListener('click', (e) => {
      e.preventDefault();
      const pct = parseInt(soundVolEl ? soundVolEl.value : 70, 10) || 70;
      if (typeof soundFX !== 'undefined') {
        soundFX.setVolume(pct / 100);
        soundFX.play('notification', true);
      }
    });`;

if (content.includes(oldBinding)) {
  content = content.replace(oldBinding, newBinding);
}

fs.writeFileSync('src/renderer/settings.html', content, 'utf8');
console.log('Successfully patched settings.html slider and loading logic');
