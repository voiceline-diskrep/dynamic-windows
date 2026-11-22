// Global unhandled error logging
window.addEventListener('error', (e) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'renderer_error.log'), `[${new Date().toISOString()}] ${e.message} at ${e.filename}:${e.lineno}:\n${e.error ? e.error.stack : ''}\n`);
  } catch (err) {}
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logDir = path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'renderer_error.log'), `[${new Date().toISOString()}] unhandled rejection: ${e.reason}\n`);
  } catch (err) {}
});

'use strict';

const { ipcRenderer, webUtils } = require('electron');
const { soundFX } = require('./sound-fx');
const {
  TAB_ORDER,
  getTabSwitchDirection,
  getTabTransitionOffsets,
  computeSlidingPillStep,
  computeLiquidHeightStep,
  getTargetExpandedHeight
} = require('./tab-animation-engine');
const { setRollingReducedMotion, drawRollingTime, triggerRollingWheelSpin, hasActiveTumblerRoll } = require('./rolling-number-wheel');
const {
  getBatteryColor,
  getBatteryDisplay,
  drawBatteryCircle,
  drawBatteryIndicator
} = require('./battery-indicator');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// -------------------------------------------------------------
// Typography & Custom Font Management (Theater default)
// -------------------------------------------------------------
let appFontFamily = 'Theater';
try {
  const savedFont = localStorage.getItem('app_font_family');
  if (savedFont) appFontFamily = savedFont;
} catch (e) {}

function applyFontFamily(font) {
  if (!font || typeof font !== 'string') return;
  appFontFamily = font.trim();
  fontReplaceCache.clear();
  try { localStorage.setItem('app_font_family', appFontFamily); } catch (e) {}
  document.documentElement.style.setProperty('--app-font-family', `"${appFontFamily}", 'Segoe UI Variable Text', -apple-system, sans-serif`);
  if (typeof requestFrame === 'function') requestFrame();
}

// Global Canvas font setter interception for dynamic typography (memoized)
const fontReplaceCache = new Map();
let fontReplaceCacheFamily = '';
const proto = CanvasRenderingContext2D.prototype;
const origFontDesc = Object.getOwnPropertyDescriptor(proto, 'font');
if (origFontDesc && origFontDesc.set) {
  Object.defineProperty(proto, 'font', {
    get() {
      return origFontDesc.get.call(this);
    },
    set(val) {
      if (typeof val === 'string' && appFontFamily && appFontFamily !== 'Default') {
        if (fontReplaceCacheFamily !== appFontFamily) {
          fontReplaceCache.clear();
          fontReplaceCacheFamily = appFontFamily;
        }
        let cached = fontReplaceCache.get(val);
        if (cached === undefined) {
          if (!val.includes(`"${appFontFamily}"`) && !val.includes(`'${appFontFamily}'`)) {
            cached = val.replace(/"Segoe UI Variable (?:Text|Display)"|'Segoe UI Variable (?:Text|Display)'|Inter/g, `"${appFontFamily}", "Segoe UI Variable Text"`);
          } else {
            cached = val;
          }
          if (fontReplaceCache.size >= 64) {
            fontReplaceCache.clear();
          }
          fontReplaceCache.set(val, cached);
        }
        origFontDesc.set.call(this, cached);
        return;
      }
      origFontDesc.set.call(this, val);
    },
    configurable: true,
    enumerable: true
  });
}

ipcRenderer.on('font-family-changed', (event, data) => {
  if (data && data.fontFamily) {
    applyFontFamily(data.fontFamily);
  }
});
ipcRenderer.invoke('get-font-family').then(font => {
  if (font) applyFontFamily(font);
}).catch(() => {});


// -------------------------------------------------------------
// Interactive Inline Modal Support (Calendar Notes, To-Do Tasks, Categories)
// -------------------------------------------------------------
let isInlineModalOpen = false;
let inlineModalCallback = null;
let inlineModalSelectedChip = null;

function showInlineModal(title, placeholder, extraChips, callback, options = {}) {
  const modal = document.getElementById('inline-modal');
  const backdrop = document.getElementById('inline-modal-backdrop');
  const modalTitle = document.getElementById('inline-modal-title');
  const modalInput = document.getElementById('inline-modal-input');
  const modalDesc = document.getElementById('inline-modal-desc');
  const modalExtra = document.getElementById('inline-modal-extra');
  const modalCatLabel = document.getElementById('inline-modal-cat-label');
  const modalCats = document.getElementById('inline-modal-categories');
  const modalColorLabel = document.getElementById('inline-modal-color-label');
  const modalColors = document.getElementById('inline-modal-colors');
  const btnCancel = document.getElementById('inline-modal-cancel');
  const btnSubmit = document.getElementById('inline-modal-submit');

  if (!modal || !modalInput) return;

  isInlineModalOpen = true;
  isHovered = true;
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }

  modalTitle.textContent = title || 'Input';
  modalInput.placeholder = placeholder || 'Enter value...';
  modalInput.value = options.initialValue || '';
  inlineModalCallback = callback;
  inlineModalSelectedChip = (extraChips && extraChips[0]) ? extraChips[0].id : null;

  let selectedCategory = (Array.isArray(options.categories) && options.categories[0]) ? options.categories[0] : 'General';
  let selectedColor = options.defaultColor || '#3b82f6';

  if (modalDesc) {
    if (options.descriptionPlaceholder) {
      modalDesc.style.display = 'block';
      modalDesc.placeholder = options.descriptionPlaceholder;
      modalDesc.value = '';
    } else {
      modalDesc.style.display = 'none';
      modalDesc.value = '';
    }
  }

  if (Array.isArray(extraChips) && extraChips.length > 0 && modalExtra) {
    modalExtra.innerHTML = '';
    modalExtra.style.display = 'flex';
    extraChips.forEach((ch, idx) => {
      const chipEl = document.createElement('div');
      chipEl.className = 'modal-chip' + (idx === 0 ? ' active' : '');
      if (ch.iconSvg) {
        chipEl.innerHTML = `${ch.iconSvg}<span>${ch.label}</span>`;
      } else {
        chipEl.textContent = ch.label;
      }
      chipEl.onclick = (e) => {
        e.stopPropagation();
        modalExtra.querySelectorAll('.modal-chip').forEach(el => el.classList.remove('active'));
        chipEl.classList.add('active');
        inlineModalSelectedChip = ch.id;
      };
      modalExtra.appendChild(chipEl);
    });
  } else if (modalExtra) {
    modalExtra.style.display = 'none';
  }

  if (modalCats && modalCatLabel) {
    if (Array.isArray(options.categories) && options.categories.length > 0) {
      modalCatLabel.style.display = 'block';
      modalCats.style.display = 'flex';
      const renderCatChips = (catList) => {
        modalCats.innerHTML = '';
        catList.forEach((cat) => {
          const el = document.createElement('div');
          el.className = 'modal-chip' + (cat === selectedCategory ? ' active' : '');
          el.textContent = cat;
          el.onclick = (e) => {
            e.stopPropagation();
            selectedCategory = cat;
            renderCatChips(catList);
          };
          modalCats.appendChild(el);
        });
        const addBtn = document.createElement('div');
        addBtn.className = 'modal-chip';
        addBtn.textContent = '+ New';
        addBtn.onclick = (e) => {
          e.stopPropagation();
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'modal-cat-add-input';
          inp.placeholder = 'Category...';
          addBtn.replaceWith(inp);
          inp.focus();
          const commitCat = () => {
            const name = inp.value.trim();
            if (name) {
              if (!catList.some(c => c.toLowerCase() === name.toLowerCase())) {
                catList.push(name);
                if (typeof options.onAddCategory === 'function') options.onAddCategory(name);
              }
              selectedCategory = name;
            }
            renderCatChips(catList);
          };
          inp.onkeydown = (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') { ev.preventDefault(); commitCat(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); renderCatChips(catList); }
          };
          inp.onblur = commitCat;
        };
        modalCats.appendChild(addBtn);
      };
      renderCatChips([...options.categories]);
    } else {
      modalCatLabel.style.display = 'none';
      modalCats.style.display = 'none';
    }
  }

  if (modalColors && modalColorLabel) {
    if (Array.isArray(options.colors) && options.colors.length > 0) {
      modalColorLabel.style.display = 'block';
      modalColors.style.display = 'flex';
      modalColors.innerHTML = '';
      options.colors.forEach((hex, idx) => {
        const sw = document.createElement('div');
        sw.className = 'modal-swatch' + (idx === 0 ? ' active' : '');
        sw.style.backgroundColor = hex;
        sw.onclick = (e) => {
          e.stopPropagation();
          modalColors.querySelectorAll('.modal-swatch').forEach(s => s.classList.remove('active'));
          sw.classList.add('active');
          selectedColor = hex;
        };
        modalColors.appendChild(sw);
      });
      const customColor = document.createElement('input');
      customColor.type = 'color';
      customColor.className = 'modal-color-custom';
      customColor.value = selectedColor;
      customColor.title = 'Custom color';
      customColor.oninput = (e) => {
        e.stopPropagation();
        selectedColor = customColor.value;
        modalColors.querySelectorAll('.modal-swatch').forEach(s => s.classList.remove('active'));
      };
      modalColors.appendChild(customColor);
    } else {
      modalColorLabel.style.display = 'none';
      modalColors.style.display = 'none';
    }
  }

  if (backdrop) backdrop.style.display = 'block';
  modal.style.display = 'block';
  setIgnoreMouseEventsCached(false);

  setTimeout(() => {
    modalInput.focus();
    setIgnoreMouseEventsCached(false);
  }, 40);

  const onSubmit = () => {
    const val = modalInput.value.trim();
    const desc = modalDesc ? modalDesc.value.trim() : '';
    if (val && inlineModalCallback) {
      inlineModalCallback(val, inlineModalSelectedChip, {
        description: desc,
        category: selectedCategory,
        color: selectedColor
      });
    }
    hideInlineModal();
  };

  btnSubmit.onclick = (e) => {
    e.stopPropagation();
    onSubmit();
  };
  btnCancel.onclick = (e) => {
    e.stopPropagation();
    hideInlineModal();
  };

  modalInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      onSubmit();
    } else if (e.key === 'Escape') {
      hideInlineModal();
    }
  };
}

function hideInlineModal() {
  isInlineModalOpen = false;
  const modal = document.getElementById('inline-modal');
  const backdrop = document.getElementById('inline-modal-backdrop');
  if (modal) modal.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
  inlineModalCallback = null;
  inlineModalSelectedChip = null;
  setTimeout(() => {
    if (!isHovered && !isInlineModalOpen) {
      setIgnoreMouseEventsCached(true, { forward: true });
    }
  }, 100);
}

// -------------------------------------------------------------
// Personalization Engine: First-Time Onboarding & 9-Greeting Cycler
// -------------------------------------------------------------
let currentUserName = '';
let activeGreeting = '';
let greetingCycleIndex = 0;
let hasPromptedForUserName = false;

function getEligibleGreetingsList(userName, date = new Date()) {
  const safeName = (userName && userName.trim()) ? userName.trim() : 'User';
  const hour = date.getHours();

  const isMorning = hour >= 5 && hour < 12;
  const isAfternoon = hour >= 12 && hour < 18;
  const isStayingUp = hour >= 1 && hour < 4;
  const isNight = hour >= 18 || hour === 0 || hour === 4;

  const list = [];
  // 1. Welcome Back <name>
  list.push(`Welcome Back ${safeName}`);
  // 2. Good morning <name> (if morning)
  if (isMorning) list.push(`Good morning ${safeName}`);
  // 3. Good Afternoon <name> (if afternoon)
  if (isAfternoon) list.push(`Good Afternoon ${safeName}`);
  // 4. Good night <name> (if night)
  if (isNight) list.push(`Good night ${safeName}`);
  // 5. staying up? (if the user opens this on 1am-3am)
  if (isStayingUp) list.push('staying up?');
  // 6. What to do?
  list.push('What to do?');
  // 7. Lets go!
  list.push('Lets go!');
  // 8. Hello <name>
  list.push(`Hello ${safeName}`);
  // 9. im always here
  list.push('im always here');

  return list;
}

function getNextPersonalizedGreeting(userName, date = new Date()) {
  const eligible = getEligibleGreetingsList(userName, date);
  if (!eligible || eligible.length === 0) return `Hello ${userName || 'User'}`;
  const greeting = eligible[greetingCycleIndex % eligible.length];
  greetingCycleIndex = (greetingCycleIndex + 1) % eligible.length;
  return greeting;
}

function promptForUserName(isFirstTime = false) {
  showInlineModal(
    isFirstTime ? 'Welcome to Dynamic Windows! What is your name?' : 'Personalize Your Name',
    'Enter your name...',
    null,
    (name) => {
      const clean = (name || '').trim();
      if (!clean) return;
      currentUserName = clean;
      ipcRenderer.send('set-user-name', clean);
      if (isFirstTime) {
        activeGreeting = `hello ${clean}!`;
        showPersonalizedBanner(`hello ${clean}!`, 'Personalized Dynamic Island');
      } else {
        activeGreeting = `Welcome Back ${clean}`;
        showPersonalizedBanner(activeGreeting, 'Name updated');
      }
    }
  );
}

function showPersonalizedBanner(title, body = 'Dynamic Windows', icon = '👋') {
  activeNotification = {
    app: 'Dynamic Windows',
    title: title,
    body: body,
    icon: icon
  };
  notificationBannerUntil = performance.now() + 4500;
  if (soundFX && typeof soundFX.play === 'function') {
    soundFX.play('notification');
  }
  currentView = 'notification_banner';
  targetProgress = 1.0;
  setIgnoreMouseEventsCached(false);
  if (typeof requestFrame === 'function') requestFrame();
}

// Modal and Backdrop Interactive Event Wiring
const inlineModalEl = document.getElementById('inline-modal');
const inlineModalBackdropEl = document.getElementById('inline-modal-backdrop');

if (inlineModalEl) {
  inlineModalEl.addEventListener('mouseenter', (e) => {
    e.stopPropagation();
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    isHovered = true;
    setIgnoreMouseEventsCached(false);
  });
  inlineModalEl.addEventListener('mousemove', (e) => {
    e.stopPropagation();
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    isHovered = true;
  });
  inlineModalEl.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    setIgnoreMouseEventsCached(false);
  });
}

if (inlineModalBackdropEl) {
  inlineModalBackdropEl.addEventListener('mouseenter', (e) => {
    e.stopPropagation();
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    isHovered = true;
    setIgnoreMouseEventsCached(false);
  });
  inlineModalBackdropEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideInlineModal();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isInlineModalOpen) {
    hideInlineModal();
  }
});

let calendarCategories = ['General', 'Personal', 'Work'];
let calSelAnimX = null;
let calSelAnimY = null;
let isCalDateAnimating = false;
let calNotesAnimStart = 0;
let calNotesAnimDir = 1;

// User Data IPC Initialization
try {
  ipcRenderer.invoke('calendar-get-categories').then(cats => {
    if (Array.isArray(cats) && cats.length > 0) {
      calendarCategories = cats;
    }
  }).catch(() => {});

  ipcRenderer.on('calendar-categories-updated', (event, cats) => {
    if (Array.isArray(cats) && cats.length > 0) {
      calendarCategories = cats;
      requestFrame();
    }
  });

  ipcRenderer.invoke('calendar-get-notes').then(notes => {
    if (Array.isArray(notes)) {
      calendarNotes = notes;
      requestFrame();
    }
  }).catch(() => {});

  ipcRenderer.on('calendar-notes-updated', (event, notes) => {
    if (Array.isArray(notes)) {
      calendarNotes = notes;
      requestFrame();
    }
  });

  ipcRenderer.invoke('todo-get-data').then(data => {
    if (data && Array.isArray(data.categories)) {
      todoData = data;
      requestFrame();
    }
  }).catch(() => {});

  ipcRenderer.on('todo-data-updated', (event, data) => {
    if (data && Array.isArray(data.categories)) {
      todoData = data;
      requestFrame();
    }
  });

  ipcRenderer.invoke('notes-get-all').then(list => {
    if (Array.isArray(list)) {
      notesList = list;
      requestFrame();
    }
  }).catch(() => {});

  ipcRenderer.on('notes-updated', (event, list) => {
    if (Array.isArray(list)) {
      notesList = list;
      requestFrame();
    }
  });

  ipcRenderer.invoke('clock-get-state').then(st => {
    if (st && st.timer) {
      timerDurationSec = st.timer.durationSec || 300;
      timerRemainingSec = st.timer.remainingSec || 300;
      requestFrame();
    }
  }).catch(() => {});
} catch (e) {}

function matchesCalendarDate(note, targetDateStr) {
  if (!note || !note.date || !targetDateStr) return false;
  const nDate = String(note.date).slice(0, 10);
  const tDate = String(targetDateStr).slice(0, 10);
  if (!note.repeat || note.repeat === 'none') return nDate === tDate;
  if (note.repeat === 'yearly') return nDate.slice(5) === tDate.slice(5);
  if (note.repeat === 'monthly') return nDate.slice(8) === tDate.slice(8);
  if (note.repeat === 'weekly') {
    const d1 = new Date(nDate + 'T00:00:00');
    const d2 = new Date(tDate + 'T00:00:00');
    return d1.getDay() === d2.getDay();
  }
  if (note.repeat === 'daily') return tDate >= nDate;
  return nDate === tDate;
}

function formatTimerSeconds(totalSec) {
  const m = Math.floor(Math.max(0, totalSec) / 60);
  const s = Math.floor(Math.max(0, totalSec) % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatStopwatchMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const centis = Math.floor((ms % 1000) / 10);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${centis < 10 ? '0' : ''}${centis}`;
}

function formatRelativeTime(ts) {
  if (!ts) return 'Just now';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

// Dynamic Windows Island Dimensions & Constants
const UI = {
  REST_W: 80,
  BAR_H: 32,
  ACTIVE_REST_W: 226,
  ACTIVE_BAR_H: 36,

  EXPANDED_W: 616,
  HOME_H: 164,
  CALENDAR_H: 330,
  CLOCK_H: 260,
  TODO_H: 320,
  NOTIF_H: 260,
  AGENT_H: 196,
  CALL_H: 206,
  MEDIA_H: 220,
  DROPZONE_H: 260,
  CLIPBOARD_H: 290,
  PROMPT_H: 150,

  COMPACT_RADIUS: 16,
  EXPANDED_RADIUS: 28,

  LEAVE_DELAY: 260
};

// State
let displayMode = 'island'; // 'island' | 'notch'
let animProgress = 0.0; // 0.0 = resting, 1.0 = expanded
let animSpeedMultiplier = 1.0; // User-controlled opening/closing speed multiplier
let targetProgress = 0.0;
let lastAnimState = 'resting';
let isHovered = false;
let currentView = 'home'; // 'home' | 'agent' | 'media' | 'dropzone' | 'clipboard' | 'prompt'
let previousView = 'home';
let tabTransitionStartTime = 0;
let tabTransitionDirection = 1;
let navIndicatorX = null;
let navIndicatorW = null;
let isNavPillAnimating = false;
let currentExpandedH = UI.HOME_H;
let currentDt = 0.016;
let clock24h = false;
let showSeconds = false;
let showAmPm = true;

function formatClockTime(date, { clock24h: use24h = false, showSeconds: includeSeconds = false, showAmPm: includeAmPm = true } = {}) {
  const d = (date && typeof date.getHours === 'function' && !isNaN(date.getTime())) ? date : new Date();
  const h24 = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (use24h) {
    const hh = String(h24).padStart(2, '0');
    return includeSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
  }
  const h12 = h24 % 12 || 12;
  const base = includeSeconds ? `${h12}:${mm}:${ss}` : `${h12}:${mm}`;
  if (!includeAmPm) return base;
  return `${base} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function getTopLumpHitbox(windowWidth) {
  const w = 88;
  const h = 10;
  return {
    x: Math.round((windowWidth - w) / 2),
    y: 0,
    w,
    h
  };
}

function computeCapsuleHideTransform({
  hideProgress = 0,
  normalW = 80,
  normalH = 32,
  normalY = 0,
  normalRadius = 16,
  normalTopFillet = 10,
  isNotch = false,
  isHiding
} = {}) {
  const k = Math.max(0, Math.min(1, Number(hideProgress) || 0));
  if (k <= 0.001) {
    return {
      w: normalW,
      h: normalH,
      y: normalY,
      topRadius: normalRadius,
      bottomRadius: normalRadius,
      topFillet: normalTopFillet,
      contentAlpha: 1,
      contentOffsetY: 0,
      sideAlpha: 1,
      sideOffsetY: 0
    };
  }
  const lumpW = 54;
  const lumpH = 6;
  const lumpBottomRadius = 3;
  const lumpTopFillet = 8;

  let kGeo = k;
  if (typeof isHiding === 'boolean' && k > 0.001 && k < 0.999) {
    const c1 = 0.75;
    const c3 = c1 + 1;
    if (isHiding) {
      kGeo = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    } else {
      const inv = 1 - k;
      kGeo = 1 - (1 + c3 * Math.pow(inv - 1, 3) + c1 * Math.pow(inv - 1, 2));
    }
  }

  const w = Math.max(40, normalW + (lumpW - normalW) * kGeo);
  const h = Math.max(4, normalH + (lumpH - normalH) * kGeo);
  const y = Math.max(0, normalY * (1 - kGeo));
  const bottomRadius = normalRadius + (lumpBottomRadius - normalRadius) * k;
  const topRadius = isNotch ? 0 : Math.max(0, normalRadius * (1 - k * 1.35));
  const topFillet = normalTopFillet + (lumpTopFillet - normalTopFillet) * k;
  const contentAlpha = Math.max(0, 1 - k * 2.4);
  const contentOffsetY = -Math.round(k * 6);
  const sideAlpha = Math.max(0, 1 - k * 2.0);
  const sideOffsetY = -Math.round(k * 10);

  return {
    w,
    h,
    y,
    topRadius,
    bottomRadius,
    topFillet,
    contentAlpha,
    contentOffsetY,
    sideAlpha,
    sideOffsetY
  };
}

function switchTab(newView) {
  if (!newView || newView === currentView) return;
  tabTransitionDirection = getTabSwitchDirection(currentView, newView);
  previousView = currentView;
  currentView = newView;
  tabTransitionStartTime = performance.now();
  isNavPillAnimating = true;
  if (typeof requestFrame === 'function') requestFrame();
}
let leaveTimer = null;
let dropZoneFiles = [];
let isDraggingOver = false;
let dropZoneHoverZone = 'onetime'; // 'onetime' | 'keep'
let lastDraggedShelfCandidate = null;

// Calendar State
let calendarNotes = [];
let calendarSelectedDate = new Date().toISOString().slice(0, 10);
let calendarViewYear = new Date().getFullYear();
let calendarViewMonth = new Date().getMonth(); // 0-11

// Clock & Timer State
let clockSubMode = 'timer'; // 'timer' | 'stopwatch' | 'focus' | 'alarm'
let timerDurationSec = 300;
let timerRemainingSec = 300;
let timerRunning = false;
let timerLastTick = null;

let stopwatchElapsedMs = 0;
let stopwatchRunning = false;
let stopwatchStartTs = null;
let stopwatchLaps = [];

let focusMode = 'work'; // 'work' | 'short_break' | 'long_break'
let focusWorkDurationMin = 25;
let focusBreakDurationMin = 5;
let focusGoalTag = 'Deep Work';
let focusRemainingSec = 25 * 60;
let focusRunning = false;
let focusLastTick = null;
let focusSessionsCompleted = 0;

// Alarm State
let alarmsList = [];
try {
  const saved = localStorage.getItem('saved_alarms');
  if (saved) alarmsList = JSON.parse(saved);
} catch (e) { alarmsList = []; }

function saveAlarms() {
  try { localStorage.setItem('saved_alarms', JSON.stringify(alarmsList)); } catch (e) {}
}

let alarmPickerHour = 7;
let alarmPickerMinute = 0;
let alarmPickerAmPm = 'AM';
let activeAlarmRinging = null;
let alarmChimeInterval = null;

function triggerAlarm(alarm) {
  const timeStr = `${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')} ${alarm.ampm}`;
  activeAlarmRinging = {
    alarmId: alarm.id,
    timeStr: timeStr,
    label: alarm.label || 'Alarm',
    triggeredAt: Date.now()
  };
  currentView = 'clock';
  clockSubMode = 'alarm';
  targetProgress = 1.0;
  soundFX.play('alarm', true);
  if (alarmChimeInterval) clearInterval(alarmChimeInterval);
  alarmChimeInterval = setInterval(() => {
    if (activeAlarmRinging) {
      soundFX.play('alarm', true);
    } else {
      clearInterval(alarmChimeInterval);
      alarmChimeInterval = null;
    }
  }, 2400);
}

function dismissActiveAlarm() {
  activeAlarmRinging = null;
  if (alarmChimeInterval) {
    clearInterval(alarmChimeInterval);
    alarmChimeInterval = null;
  }
}

function snoozeActiveAlarm() {
  if (!activeAlarmRinging) return;
  const now = new Date();
  const snoozeTime = new Date(now.getTime() + 5 * 60 * 1000);
  let sh = snoozeTime.getHours();
  const sm = snoozeTime.getMinutes();
  const sampm = sh >= 12 ? 'PM' : 'AM';
  sh = sh % 12 || 12;

  const snoozeAlarm = {
    id: 'snooze_' + Date.now(),
    hour: sh,
    minute: sm,
    ampm: sampm,
    label: 'Snoozed (+5m)',
    enabled: true,
    lastTriggeredDate: null
  };
  alarmsList.push(snoozeAlarm);
  saveAlarms();
  dismissActiveAlarm();
}
let islandOpacity = 0.95;
let liquidGlassEnabled = false;
let liteModeEnabled = false;
let reducedMotionEnabled = false;

function isReducedMotionActive() {
  return Boolean(reducedMotionEnabled || liteModeEnabled);
}

function syncReducedMotionState() {
  if (typeof setRollingReducedMotion === 'function') {
    setRollingReducedMotion(isReducedMotionActive());
  }
}

try {
  const savedWork = localStorage.getItem('focus_work_min');
  if (savedWork) {
    const w = parseInt(savedWork, 10);
    if (!isNaN(w) && w > 0) {
      focusWorkDurationMin = w;
      focusRemainingSec = w * 60;
    }
  }
  const savedBreak = localStorage.getItem('focus_break_min');
  if (savedBreak) {
    const b = parseInt(savedBreak, 10);
    if (!isNaN(b) && b > 0) focusBreakDurationMin = b;
  }
  const savedGoal = localStorage.getItem('focus_goal_tag');
  if (savedGoal) focusGoalTag = savedGoal;
} catch (e) {}

// Notes & To-Do State
let notesSubMode = 'notes'; // 'notes' | 'todo'
let notesList = [];
let todoData = {
  categories: ['Personal', 'Work', 'Island'],
  tasks: []
};
let todoSelectedCategory = 'All';

// Custom Vector Symbol Renderer (zero emojis — pure Canvas 2D geometry)
function drawVectorSymbol(c, type, cx, cy, size = 12, color = '#e4e4e7') {
  const s = size / 2;
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = Math.max(1.2, size * 0.11);
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (type === 'bolt') {
    c.beginPath();
    c.moveTo(cx + s * 0.15, cy - s * 0.95);
    c.lineTo(cx - s * 0.65, cy + s * 0.1);
    c.lineTo(cx - s * 0.05, cy + s * 0.1);
    c.lineTo(cx - s * 0.2, cy + s * 0.95);
    c.lineTo(cx + s * 0.65, cy - s * 0.1);
    c.lineTo(cx + s * 0.05, cy - s * 0.1);
    c.closePath();
    c.fill();
  } else if (type === 'pin') {
    c.beginPath();
    c.moveTo(cx - s * 0.45, cy - s * 0.75);
    c.lineTo(cx + s * 0.45, cy - s * 0.75);
    c.lineTo(cx + s * 0.35, cy - s * 0.1);
    c.lineTo(cx + s * 0.65, cy + s * 0.2);
    c.lineTo(cx - s * 0.65, cy + s * 0.2);
    c.lineTo(cx - s * 0.35, cy - s * 0.1);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(cx, cy + s * 0.2);
    c.lineTo(cx, cy + s * 0.9);
    c.stroke();
  } else if (type === 'folder') {
    c.beginPath();
    c.moveTo(cx - s * 0.85, cy - s * 0.6);
    c.lineTo(cx - s * 0.25, cy - s * 0.6);
    c.lineTo(cx - s * 0.05, cy - s * 0.35);
    c.lineTo(cx + s * 0.85, cy - s * 0.35);
    c.lineTo(cx + s * 0.85, cy + s * 0.65);
    c.lineTo(cx - s * 0.85, cy + s * 0.65);
    c.closePath();
    c.stroke();
  } else if (type === 'file') {
    c.beginPath();
    c.moveTo(cx - s * 0.65, cy - s * 0.85);
    c.lineTo(cx + s * 0.2, cy - s * 0.85);
    c.lineTo(cx + s * 0.65, cy - s * 0.4);
    c.lineTo(cx + s * 0.65, cy + s * 0.85);
    c.lineTo(cx - s * 0.65, cy + s * 0.85);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(cx + s * 0.2, cy - s * 0.85);
    c.lineTo(cx + s * 0.2, cy - s * 0.4);
    c.lineTo(cx + s * 0.65, cy - s * 0.4);
    c.stroke();
  } else if (type === 'inbox') {
    c.beginPath();
    c.moveTo(cx - s * 0.8, cy + s * 0.1);
    c.lineTo(cx - s * 0.8, cy + s * 0.7);
    c.lineTo(cx + s * 0.8, cy + s * 0.7);
    c.lineTo(cx + s * 0.8, cy + s * 0.1);
    c.stroke();
    c.beginPath();
    c.moveTo(cx, cy - s * 0.8);
    c.lineTo(cx, cy + s * 0.25);
    c.moveTo(cx - s * 0.4, cy - s * 0.1);
    c.lineTo(cx, cy + s * 0.3);
    c.lineTo(cx + s * 0.4, cy - s * 0.1);
    c.stroke();
  } else if (type === 'note') {
    c.beginPath();
    c.roundRect(cx - s * 0.7, cy - s * 0.8, s * 1.4, s * 1.6, 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - s * 0.4, cy - s * 0.3);
    c.lineTo(cx + s * 0.4, cy - s * 0.3);
    c.moveTo(cx - s * 0.4, cy + s * 0.05);
    c.lineTo(cx + s * 0.4, cy + s * 0.05);
    c.moveTo(cx - s * 0.4, cy + s * 0.4);
    c.lineTo(cx + s * 0.15, cy + s * 0.4);
    c.stroke();
  } else if (type === 'check') {
    c.beginPath();
    c.arc(cx, cy, s * 0.82, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - s * 0.38, cy + s * 0.02);
    c.lineTo(cx - s * 0.1, cy + s * 0.32);
    c.lineTo(cx + s * 0.42, cy - s * 0.28);
    c.stroke();
  } else if (type === 'bell') {
    c.beginPath();
    c.arc(cx, cy - s * 0.15, s * 0.55, Math.PI, 0, false);
    c.lineTo(cx + s * 0.7, cy + s * 0.45);
    c.lineTo(cx - s * 0.7, cy + s * 0.45);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.arc(cx, cy + s * 0.68, s * 0.16, 0, Math.PI * 2);
    c.fill();
  } else if (type === 'alarm' || type === 'clock') {
    c.beginPath();
    c.arc(cx, cy, s * 0.78, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx, cy - s * 0.45);
    c.lineTo(cx, cy);
    c.lineTo(cx + s * 0.35, cy + s * 0.2);
    c.stroke();
  }
  c.restore();
}

let clipboardHistory = [];
let clipboardFilter = '';
let notificationList = [];
let activeNotification = null;
let notificationBannerUntil = 0;
let copiedFeedbackId = null;
let copiedFeedbackTimer = null;
let shelfDragCandidate = null;
let currentRestingWidth = UI.REST_W;
let dynamicLyricsEnabled = true;
let liveLyricsEnabled = true;
let lyricModeToggleAnim = 1.0; // 0.0 = Line, 1.0 = Word
let lyricModeStageAnimStart = 0;
let lyricModeStageTarget = 'word';
let albumColorGradientEnabled = true;
let wasShelfDragging = false;
let currentVolume = 0.66;
let isVolumeMuted = false;
let isDraggingVolume = false;
let wasVolumeDragging = false;
let volumeSliderBounds = null;

let antigravityState = {
  status: 'idle', // 'idle' | 'running' | 'thinking' | 'waiting' | 'done' | 'error'
  provider: 'Google Antigravity',
  phase: 'Ready',
  task: '',
  tool: '',
  file: '',
  command: '',
  progress: 0
};

let mediaState = {
  isPlaying: false,
  progress_ms: 0,
  duration_ms: 0,
  track: {
    id: '',
    title: 'No media playing',
    artist: 'Open Liner, Spotify, or Media Player',
    source: 'none',
    album: '',
    image_url: '',
    lyrics: [],
    timedLyrics: [],
    currentLyric: ''
  }
};
let mediaSyncAt = performance.now();
let pendingPrompt = null; // { id, agent, command, file, message }

let callState = {
  inCall: false,
  status: 'idle', // 'idle' | 'ringing' | 'connected'
  appId: 'none',
  appName: '',
  callType: 'dm',
  channelName: '',
  participantCount: 0,
  startedAt: 0,
  selfMuted: false,
  selfDeafened: false,
  selfSpeaking: false,
  participants: []
};
const callAvatarCache = new Map();

function getCallAvatarImage(url) {
  if (!url) return null;
  if (callAvatarCache.has(url)) return callAvatarCache.get(url);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  callAvatarCache.set(url, img);
  return img;
}

function hasActiveCall() {
  return false; // User requested removing the resting call overlay capsule
}

function getCallCapsuleLabel() {
  if (!hasActiveCall()) return '';
  if (callState.status === 'ringing') {
    return callState.channelName ? `${callState.channelName}` : 'Incoming';
  }
  if (callState.callType === 'group') {
    const cnt = Math.max(2, Number(callState.participantCount) || 2);
    return `${cnt} Joined`;
  }
  return callState.channelName || callState.appName || 'In Call';
}

function getCallCapsuleWidth() {
  if (!hasActiveCall()) return 0;
  const label = getCallCapsuleLabel();
  ctx.save();
  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  const labelW = Math.min(82, ctx.measureText(label).width);
  ctx.restore();

  const showMiniAvatars =
    (callState.callType === 'dm' || (callState.participantCount || 0) <= 4) &&
    Array.isArray(callState.participants) &&
    callState.participants.length > 0;
  const avatarCount = showMiniAvatars ? Math.min(4, callState.participants.length) : 0;
  const avatarsW = avatarCount > 0 ? (avatarCount * 20 + 6) : 0;
  const statusBadgeW = (callState.selfDeafened || callState.selfMuted) ? 16 : 0;

  return Math.max(106, Math.min(242, Math.round(52 + labelW + avatarsW + statusBadgeW)));
}

// -------------------------------------------------------------
// TwoCode Album Cover & Dominant Color Extraction
// -------------------------------------------------------------
const albumImage = new Image();
albumImage.crossOrigin = 'anonymous';
let albumImageForUrl = '';
let albumAccentColor = '#22c55e';
let albumPalette = ['#e4e4e7', '#a1a1aa'];
let tintK = 0;

function computeAlbumPaletteFromPixels(d) {
  // 12 hue buckets (30 deg each) + 1 neutral bucket
  const buckets = Array.from({ length: 13 }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const pr = d[i], pg = d[i + 1], pb = d[i + 2];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const sat = max - min;
    const weight = (sat > 15 ? (sat / 10) : 0.15) * (max > 22 && max < 245 ? 1.5 : 0.4);

    let idx = 12;
    if (sat >= 20 && max >= 25) {
      let h = 0;
      if (max === pr) h = ((pg - pb) / sat) % 6;
      else if (max === pg) h = (pb - pr) / sat + 2;
      else h = (pr - pg) / sat + 4;
      h = ((h * 60) + 360) % 360;
      idx = Math.min(11, Math.floor(h / 30));
    }
    buckets[idx].r += pr * weight;
    buckets[idx].g += pg * weight;
    buckets[idx].b += pb * weight;
    buckets[idx].w += weight;
  }

  const ranked = buckets
    .filter(b => b.w > 0)
    .sort((a, b) => b.w - a.w)
    .map(b => {
      const r = b.r / b.w;
      const g = b.g / b.w;
      const bl = b.b / b.w;
      const actualMax = Math.max(r, g, bl);
      const minVal = Math.min(r, g, bl);
      if (actualMax < 35 || (actualMax - minVal < 22)) {
        return { rgb: [212, 212, 216], str: '#d4d4d8', neutral: true };
      }
      const boost = 215 / Math.max(actualMax, 40);
      const rgb = [r, g, bl].map(v => Math.min(255, Math.max(0, Math.round(v * boost))));
      return { rgb, str: `rgb(${rgb.join(',')})`, neutral: false };
    });

  const picked = [];
  for (const cand of ranked) {
    if (picked.length === 0) {
      picked.push(cand);
    } else {
      const distinct = picked.every(p => {
        const dr = p.rgb[0] - cand.rgb[0];
        const dg = p.rgb[1] - cand.rgb[1];
        const db = p.rgb[2] - cand.rgb[2];
        return (dr * dr + dg * dg + db * db) > 3200;
      });
      if (distinct) picked.push(cand);
    }
    if (picked.length >= 3) break;
  }

  if (picked.length === 0) return ['#e4e4e7', '#a1a1aa'];
  if (picked.length === 1) return [picked[0].str, picked[0].str];
  return picked.map(p => p.str);
}

function computeAccentColorFromPixels(d) {
  let r = 0, g = 0, b = 0, totalW = 0;
  for (let i = 0; i < d.length; i += 4) {
    const pr = d[i], pg = d[i + 1], pb = d[i + 2];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const sat = max - min;
    const weight = (sat > 15 ? (sat / 10) : 0.2) * (max > 25 && max < 245 ? 1.5 : 0.4);
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
    totalW += weight;
  }
  if (totalW > 0) {
    r /= totalW; g /= totalW; b /= totalW;
  } else {
    return '#e4e4e7';
  }
  const actualMax = Math.max(r, g, b);
  const minVal = Math.min(r, g, b);
  // Monochrome/grayscale or near-black artwork (e.g. Arctic Monkeys AM, White Album): sleek silver/white neutral accent
  if (actualMax < 35 || (actualMax - minVal < 26)) {
    return '#e4e4e7';
  }
  const boost = 220 / Math.max(actualMax, 40);
  return `rgb(${[r, g, b].map(v => Math.min(255, Math.max(0, Math.round(v * boost)))).join(',')})`;
}

function updateAlbumArt(url) {
  if (!url) {
    albumImageForUrl = '';
    albumAccentColor = '#e4e4e7';
    albumPalette = ['#e4e4e7', '#a1a1aa'];
    return;
  }
  if (url === albumImageForUrl) return;
  albumImageForUrl = url;
  albumImage.crossOrigin = 'anonymous';
  albumImage.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const x = c.getContext('2d');
      x.drawImage(albumImage, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data;
      albumAccentColor = computeAccentColorFromPixels(d);
      albumPalette = computeAlbumPaletteFromPixels(d);
    } catch (e) {
      albumAccentColor = '#e4e4e7';
      albumPalette = ['#e4e4e7', '#a1a1aa'];
    }
    requestFrame();
  };
  albumImage.onerror = () => {
    albumAccentColor = '#e4e4e7';
    albumPalette = ['#e4e4e7', '#a1a1aa'];
    requestFrame();
  };
  albumImage.src = url;
}

function colorWithAlpha(c, a) {
  const safeA = (typeof a === 'number' && !isNaN(a)) ? Math.max(0, Math.min(1, a)) : 1.0;
  if (!c) return `rgba(34,197,94,${safeA})`;
  const rgbMatch = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgbMatch) return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${safeA})`;
  const hslMatch = /hsla?\((\d+),\s*([\d.]+)%?,\s*([\d.]+)%?/.exec(c);
  if (hslMatch) return `hsla(${hslMatch[1]},${hslMatch[2]}%,${hslMatch[3]}%,${safeA})`;
  const hex = String(c).replace('#', '').trim();
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16) || 0;
    const g = parseInt(hex[1] + hex[1], 16) || 0;
    const b = parseInt(hex[2] + hex[2], 16) || 0;
    return `rgba(${r},${g},${b},${safeA})`;
  }
  const n = parseInt(hex.slice(0, 6), 16) || 0x22c55e;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${safeA})`;
}

// -------------------------------------------------------------
// TwoCode Synced Lyrics Engine (250ms lead, 420ms roll, 2500ms hold)
// -------------------------------------------------------------
const LYRIC_LEAD_MS = 220;
const WORD_LEAD_MS = 45;
const LYRIC_SWAP_MS = 420;
const LYRIC_HOLD_MS = 2500;
const LYRIC_PILL_FONT = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
let lyricSongKey = '';
let lyricIndex = -1;
let lyricGap = false;
let lyricChangedAt = 0;
let lyricPreviousText = null;
let lyricWidestPx = 0;
let lyricHoldUntil = 0;

function getLiveMediaPositionMs() {
  const dur = mediaState.duration_ms || 0;
  const base = mediaState.progress_ms || 0;
  const rate = (typeof mediaState.playback_rate === 'number' && mediaState.playback_rate > 0) ? mediaState.playback_rate : 1.0;
  const offset = mediaState.lyric_offset_ms || 0;
  const elapsed = mediaState.isPlaying ? Math.max(0, performance.now() - mediaSyncAt) * rate : 0;
  const current = base + elapsed + offset;
  return dur > 0 ? Math.min(dur, Math.max(0, current)) : Math.max(0, current);
}

function formatTimeMs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function easeOutQuad(x) {
  return 1 - (1 - x) * (1 - x);
}

const FAST_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'of', 'at', 'is', 'it', "it's", "i'm",
  'for', 'and', 'or', 'as', 'by', 'be', 'my', 'so', 'if', 'we', 'me', 'you'
]);

function estimateWordVocalWeight(rawWord) {
  const clean = String(rawWord || '').replace(/[^a-zA-Z']/g, '').toLowerCase();
  let syllables = 1;
  if (clean.length > 2) {
    const stripped = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const matches = stripped.match(/[aeiouy]{1,2}/g);
    syllables = matches ? Math.max(1, matches.length) : 1;
  }
  const isFast = FAST_FUNCTION_WORDS.has(clean);
  const singWeight = isFast ? Math.max(0.65, syllables * 0.72) : syllables * 1.0 + (/[aeiou]{2}|[wry]$/i.test(clean) ? 0.2 : 0);

  let pauseWeight = 0;
  if (/[,;:]$/.test(rawWord)) pauseWeight = 0.95;
  else if (/(?:\.\.\.|…|[.?!—–-])$/.test(rawWord)) pauseWeight = 1.25;

  return { singWeight, pauseWeight, totalWeight: singWeight + pauseWeight };
}

function getProgressiveLyricState(timed, index) {
  if (lyricGap || index < 0 || !timed || !timed[index]) return null;
  const lineObj = timed[index];
  const fullText = (lineObj.text || '').trim();
  if (!fullText) return null;

  if (!dynamicLyricsEnabled || liteModeEnabled) {
    return {
      revealed: fullText,
      remaining: '',
      fullText,
      isComplete: true,
      activeWordIndex: 0,
      subWordProgress: 1.0,
      words: [{ text: fullText, isSung: true, isActive: true, isUpcoming: false, progress: 1.0 }]
    };
  }

  // Tight 45ms lead for word-level tracking so words light up right as they are sung
  const pos = getLiveMediaPositionMs() + WORD_LEAD_MS;
  const startMs = lineObj.t;
  const elapsed = Math.max(0, pos - startMs);
  const nextLineMs = timed[index + 1]?.t;

  // 1. Explicit per-word / per-syllable timestamps (from RichSync, Polaris TTML, or Enhanced LRC)
  if (Array.isArray(lineObj.words) && lineObj.words.length > 0) {
    const wordsList = lineObj.words;
    let activeIdx = 0;
    for (let i = 0; i < wordsList.length; i++) {
      if (wordsList[i].t <= pos || i === 0) {
        activeIdx = i;
      } else {
        break;
      }
    }

    const curWord = wordsList[activeIdx];
    const fallbackEnd = wordsList[activeIdx + 1]?.t || lineObj.end || nextLineMs || (curWord.t + 650);
    const wordEnd = (typeof curWord.end === 'number' && curWord.end > curWord.t) ? curWord.end : fallbackEnd;
    const wordDur = Math.max(60, wordEnd - curWord.t);

    let subProgress = 0;
    if (pos >= wordEnd) {
      subProgress = 1.0;
    } else if (Array.isArray(curWord.syllables) && curWord.syllables.length > 1) {
      // Multi-syllable exact interpolation
      const syls = curWord.syllables;
      let sylIdx = 0;
      for (let s = 0; s < syls.length; s++) {
        if (syls[s].t <= pos || s === 0) sylIdx = s;
        else break;
      }
      const curSyl = syls[sylIdx];
      const sylEnd = (typeof curSyl.end === 'number' && curSyl.end > curSyl.t)
        ? curSyl.end
        : (syls[sylIdx + 1]?.t || wordEnd);
      const sylProg = Math.min(1.0, Math.max(0, (pos - curSyl.t) / Math.max(40, sylEnd - curSyl.t)));
      subProgress = Math.min(1.0, (sylIdx + sylProg) / syls.length);
    } else {
      subProgress = Math.min(1.0, Math.max(0, (pos - curWord.t) / wordDur));
    }

    const revealedWords = wordsList.slice(0, activeIdx + 1).map(w => w.text);
    const remainingWords = wordsList.slice(activeIdx + 1).map(w => w.text);

    return {
      revealed: revealedWords.join(' '),
      remaining: remainingWords.length > 0 ? (' ' + remainingWords.join(' ')) : '',
      fullText,
      isComplete: remainingWords.length === 0 && subProgress >= 0.99,
      activeWordIndex: activeIdx,
      subWordProgress: subProgress,
      words: wordsList.map((w, idx) => {
        const wEnd = (typeof w.end === 'number' && w.end > w.t) ? w.end : (wordsList[idx + 1]?.t || wordEnd);
        const alreadyFinished = idx < activeIdx || (idx === activeIdx && pos >= wEnd);
        return {
          text: w.text,
          isSung: alreadyFinished,
          isActive: idx === activeIdx && !alreadyFinished,
          isUpcoming: idx > activeIdx,
          progress: alreadyFinished ? 1.0 : (idx === activeIdx ? subProgress : 0.0)
        };
      })
    };
  }

  // 2. Vocal Syllable & Punctuation Cadence Estimator (when only line-level LRC timestamps exist)
  const rawWords = fullText.split(/\s+/).filter(Boolean);
  if (rawWords.length <= 1) {
    return {
      revealed: fullText,
      remaining: '',
      fullText,
      isComplete: true,
      activeWordIndex: 0,
      subWordProgress: 1.0,
      words: [{ text: fullText, isSung: true, isActive: true, isUpcoming: false, progress: 1.0 }]
    };
  }

  const weights = rawWords.map(estimateWordVocalWeight);
  const totalWeight = weights.reduce((acc, w) => acc + w.totalWeight, 0) || 1;

  // Natural vocal cadence (~275ms per weighted syllable unit) prevents slow-motion dragging across long instrumental gaps
  const naturalVocalMs = Math.max(650, Math.min(4800, totalWeight * 275));
  const availableMs = (typeof lineObj.end === 'number' && lineObj.end > startMs)
    ? (lineObj.end - startMs)
    : (nextLineMs ? Math.max(400, nextLineMs - startMs - 160) : naturalVocalMs);
  const lineDur = (typeof lineObj.end === 'number' && lineObj.end > startMs)
    ? availableMs
    : Math.min(availableMs, naturalVocalMs);
  const ratio = Math.min(1.0, elapsed / Math.max(350, lineDur));

  let accW = 0;
  let activeIdx = 0;
  let wordStartRatio = 0;
  let wordSingEndRatio = 1.0;

  const wordRanges = [];
  for (let i = 0; i < rawWords.length; i++) {
    const { singWeight, totalWeight: wTot } = weights[i];
    const startR = accW / totalWeight;
    const singEndR = (accW + singWeight) / totalWeight;
    const endR = (accW + wTot) / totalWeight;
    wordRanges.push({ startR, singEndR, endR });
    accW += wTot;
  }

  for (let i = 0; i < wordRanges.length; i++) {
    if (ratio >= wordRanges[i].startR || i === 0) {
      activeIdx = i;
      wordStartRatio = wordRanges[i].startR;
      wordSingEndRatio = wordRanges[i].singEndR;
    } else {
      break;
    }
  }

  const wordSingDurRatio = Math.max(0.001, wordSingEndRatio - wordStartRatio);
  const subProgress = Math.min(1.0, Math.max(0, (ratio - wordStartRatio) / wordSingDurRatio));

  const revealedWords = rawWords.slice(0, activeIdx + 1);
  const remainingWords = rawWords.slice(activeIdx + 1);

  return {
    revealed: revealedWords.join(' '),
    remaining: remainingWords.length > 0 ? (' ' + remainingWords.join(' ')) : '',
    fullText,
    isComplete: remainingWords.length === 0 && subProgress >= 0.99,
    activeWordIndex: activeIdx,
    subWordProgress: subProgress,
    words: rawWords.map((text, idx) => {
      const alreadyFinished = idx < activeIdx || (idx === activeIdx && subProgress >= 1.0);
      return {
        text,
        isSung: alreadyFinished,
        isActive: idx === activeIdx && !alreadyFinished,
        isUpcoming: idx > activeIdx,
        progress: alreadyFinished ? 1.0 : (idx === activeIdx ? subProgress : 0.0)
      };
    })
  };
}

function getCurrentActiveLyricText(timed) {
  const state = getProgressiveLyricState(timed, lyricIndex);
  return state ? state.revealed : null;
}

function getCurrentFullLyricText(timed) {
  if (lyricGap || lyricIndex < 0 || !timed || !timed[lyricIndex]) return null;
  return timed[lyricIndex].text || null;
}

function tickLyrics() {
  const track = mediaState.track;
  const timed = (track && Array.isArray(track.timedLyrics)) ? track.timedLyrics : [];
  const key = (track && track.title && track.title !== 'No media playing') ? `${track.title}|${track.artist}|${timed.length}` : '';

  if (key !== lyricSongKey) {
    if (lyricWidestPx > 0) {
      lyricHoldUntil = performance.now() + LYRIC_HOLD_MS;
    }
    lyricSongKey = key;
    lyricIndex = -1;
    lyricGap = false;
    lyricChangedAt = performance.now();

    if (timed.length > 0) {
      ctx.save();
      ctx.font = LYRIC_PILL_FONT;
      lyricWidestPx = timed.reduce((m, l) => Math.max(m, l.text ? ctx.measureText(l.text).width : 0), 0);
      ctx.restore();
    } else if (performance.now() >= lyricHoldUntil) {
      lyricWidestPx = 0;
    }
  }

  if (!timed.length) return;

  const pos = getLiveMediaPositionMs() + LYRIC_LEAD_MS;
  let idx = -1;
  for (let k = 0; k < timed.length; k++) {
    if (timed[k].t <= pos) idx = k;
    else break;
  }

  let g = false;
  if (idx >= 0) {
    const since = pos - timed[idx].t;
    const next = timed[idx + 1];
    g = next ? (next.t - timed[idx].t > 14000 && since > 9000) : (since > 8000);
  }

  if (idx !== lyricIndex || g !== lyricGap) {
    lyricPreviousText = getCurrentFullLyricText(timed);
    lyricIndex = idx;
    lyricGap = g;
    lyricChangedAt = performance.now();
  }
}

function getPillRollingLyric() {
  if (!liveLyricsEnabled) return null;
  const timed = (mediaState.track && Array.isArray(mediaState.track.timedLyrics)) ? mediaState.track.timedLyrics : [];
  const rawK = Math.min(1, Math.max(0, (performance.now() - lyricChangedAt) / LYRIC_SWAP_MS));
  const k = 1 - Math.pow(1 - rawK, 4);
  if (!timed.length) {
    if (mediaState.track && mediaState.track.currentLyric) {
      return { text: mediaState.track.currentLyric, fullText: mediaState.track.currentLyric, previous: null, k: 1, progressive: null };
    }
    return null;
  }
  const curState = getProgressiveLyricState(timed, lyricIndex);
  if (!curState) return null;
  return {
    text: curState.revealed,
    fullText: curState.fullText,
    previous: k < 1 ? lyricPreviousText : null,
    k,
    progressive: curState
  };
}

function getExpandedAroundLyrics() {
  if (!liveLyricsEnabled) return null;
  const timed = (mediaState.track && Array.isArray(mediaState.track.timedLyrics)) ? mediaState.track.timedLyrics : [];
  if (!timed.length) return null;
  const rawK = Math.min(1, Math.max(0, (performance.now() - lyricChangedAt) / LYRIC_SWAP_MS));
  const k = 1 - Math.pow(1 - rawK, 4);
  const textAt = (i) => (timed[i] && timed[i].text) || '';
  if (lyricIndex < 0) {
    const first = timed.find(l => l.text)?.text || '';
    return { before: '', now: '♪', next: first, k: 1, progressive: null };
  }
  const state = getProgressiveLyricState(timed, lyricIndex);
  const cur = state ? state.revealed : (getCurrentFullLyricText(timed) || '♪');
  return {
    before: textAt(lyricIndex - 1),
    now: cur,
    next: textAt(lyricIndex + 1),
    k,
    progressive: state
  };
}
// TwoCode 6-Bar Equalizer & Vector Media Icons
// -------------------------------------------------------------
const vizState = {};
function drawEqualizer(key, x, cy, w, h, colour, n = 6) {
  const t = performance.now() / 1000;
  const playing = Boolean(mediaState.isPlaying);
  const bars = vizState[key] && vizState[key].length === n ? vizState[key] : (vizState[key] = new Array(n).fill(0.15));
  const gap = Math.max(1.8, (w / n) * 0.38);
  const bw = Math.max(1.5, (w - gap * (n - 1)) / n);

  ctx.save();
  for (let i = 0; i < n; i++) {
    const raw = !playing
      ? 0.08
      : 0.2 + 0.65 * Math.abs(Math.sin(t * (2.2 + i * 0.43) + i * 1.7)) * (0.65 + 0.35 * Math.sin(t * 1.3 + i * 0.9));
    const want = !playing ? 0.12 : Math.min(1, 0.14 + 1.1 * Math.pow(raw, 0.65));
    bars[i] += (want - bars[i]) * (want > bars[i] ? 0.5 : 0.16);
    const bh = Math.max(bw, h * Math.min(1, bars[i]));
    ctx.beginPath();
    ctx.roundRect(x + i * (bw + gap), cy - bh / 2, bw, bh, bw / 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.restore();
}

function drawVectorSpeakerIcon(x, y, s, color, isMuted, vol) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Speaker body (small rectangle + trapezoid)
  ctx.beginPath();
  const bodyW = s * 0.28;
  const bodyH = s * 0.42;
  ctx.rect(x - s * 0.45, y - bodyH / 2, bodyW, bodyH);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x - s * 0.45 + bodyW, y - bodyH / 2);
  ctx.lineTo(x + s * 0.05, y - s * 0.45);
  ctx.lineTo(x + s * 0.05, y + s * 0.45);
  ctx.lineTo(x - s * 0.45 + bodyW, y + bodyH / 2);
  ctx.closePath();
  ctx.fill();

  if (isMuted || vol <= 0.01) {
    ctx.beginPath();
    ctx.moveTo(x + s * 0.2, y - s * 0.25);
    ctx.lineTo(x + s * 0.55, y + s * 0.25);
    ctx.moveTo(x + s * 0.55, y - s * 0.25);
    ctx.lineTo(x + s * 0.2, y + s * 0.25);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x - s * 0.05, y, s * 0.28, -Math.PI / 3.5, Math.PI / 3.5);
    ctx.stroke();
    if (vol >= 0.4) {
      ctx.beginPath();
      ctx.arc(x - s * 0.05, y, s * 0.5, -Math.PI / 3.5, Math.PI / 3.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function getMediaAppHint() {
  if (mediaState && mediaState.track) {
    if (mediaState.track.rawApp) return mediaState.track.rawApp;
    if (mediaState.track.source && mediaState.track.source !== 'Windows Media' && mediaState.track.source !== 'none') {
      return mediaState.track.source;
    }
  }
  return '';
}

function updateVolumeFromMouseY(clientY, bounds) {
  if (!bounds || !bounds.trackH) return;
  const ratio = Math.max(0, Math.min(1, (bounds.trackY + bounds.trackH - clientY) / bounds.trackH));
  currentVolume = ratio;
  isVolumeMuted = false;
  ipcRenderer.send('set-media-volume', { val: currentVolume, app: getMediaAppHint() });
}

function drawVectorMediaIcon(kind, x, y, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  ctx.beginPath();
  const tri = (x0, dir) => {
    ctx.moveTo(x0, y - s / 2);
    ctx.lineTo(x0 + dir * s * 0.75, y);
    ctx.lineTo(x0, y + s / 2);
    ctx.closePath();
  };
  if (kind === 'play') {
    tri(x - s * 0.3, 1);
  } else if (kind === 'pause') {
    ctx.roundRect(x - s * 0.4, y - s / 2, s * 0.28, s, 2);
    ctx.roundRect(x + s * 0.12, y - s / 2, s * 0.28, s, 2);
  } else {
    const d = kind === 'next' ? 1 : -1;
    tri(x - d * s * 0.6, d);
    tri(x - d * s * 0.05, d);
    ctx.roundRect(x + d * s * 0.7 - (d > 0 ? 0 : s * 0.16), y - s / 2, s * 0.16, s, 1);
  }
  ctx.fill();
  ctx.restore();
}

// -------------------------------------------------------------
// TwoCode Tuck Away Mode & Game Mode
// -------------------------------------------------------------
let isTucked = false;
let isPeekHidden = false;
let hideProgress = 0.0; // 0.0 = shown, 1.0 = smoothly retracted into top bezel lump
let isLumpHovered = false;
let tuckHoverAt = 0;
let tuckChangedAt = 0;
let isGameModeFullscreen = false;
let gameModeOpenedAnyway = false;
let gameModeEnabled = true;
let gameModeToastText = '';
let gameModeToastUntil = 0;

// -------------------------------------------------------------
// TwoCode Connected Downward Song Change Extension Popup
// -------------------------------------------------------------
let lastSongAnnouncementKey = '';
let songPopupActiveUntil = 0;
let songPopupProgress = 0.0; // 0.0 (compact) -> 1.0 (fully extended downward)
let hoveredDuringSongPopup = false;
const SONG_POPUP_DURATION_MS = 6000; // 6 seconds display duration approved by user
const SONG_POPUP_HEIGHT = 124;
const SONG_POPUP_WIDTH = 480;

function triggerSongAnnouncement() {
  if (isTucked) return;
  songPopupActiveUntil = performance.now() + SONG_POPUP_DURATION_MS;
  hoveredDuringSongPopup = false;
}

function dismissSongAnnouncement() {
  songPopupActiveUntil = 0;
  hoveredDuringSongPopup = false;
}

try {
  const initGm = ipcRenderer.sendSync('get-game-mode');
  if (initGm && typeof initGm.enabled === 'boolean') {
    gameModeEnabled = initGm.enabled;
    isGameModeFullscreen = Boolean(initGm.isFullscreen);
  }
} catch (e) {}

function isShouldBeHidden() {
  if (pendingPrompt !== null) return false;
  if (targetProgress >= 0.5 || animProgress >= 0.35) return false;
  if (songPopupProgress > 0.05 || songPopupActiveUntil > performance.now()) return false;
  if (currentView === 'notification_banner' && notificationBannerUntil > performance.now()) return false;
  if (isDraggingOver || isInlineModalOpen) return false;
  return Boolean(isTucked || isPeekHidden);
}

function setTucked(on) {
  const next = Boolean(on);
  if (next === isTucked) return;
  isTucked = next;
  tuckHoverAt = 0;
  tuckChangedAt = performance.now();
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  if (isTucked) {
    isHovered = false;
    isPeekHidden = false;
    targetProgress = 0.0;
    currentView = 'home';
    ipcRenderer.send('island-hover-end');
    setIgnoreMouseEventsCached(true, { forward: true });
  } else {
    isPeekHidden = false;
  }
  requestFrame();
}

function getAntigravityProgress(state) {
  const status = (state.status || 'idle').toLowerCase();
  const tool = (state.tool || '').toLowerCase();
  const phase = (state.phase || '').toLowerCase();
  const cmd = (state.command || '').toLowerCase();

  const labels = ['Analyze', 'Execute', 'Verify', 'Complete'];

  if (status === 'done' || phase.includes('completed') || phase.includes('finished')) {
    return {
      completedCount: 4,
      segments: [true, true, true, true],
      activeSegment: -1,
      labels
    };
  }

  if (status === 'error') {
    return {
      completedCount: 1,
      segments: [true, false, false, false],
      activeSegment: 1,
      hasError: true,
      labels
    };
  }

  if (status === 'thinking' || phase.includes('analyzing') || phase.includes('thinking') || phase.includes('plan')) {
    return {
      completedCount: 0,
      segments: [false, false, false, false],
      activeSegment: 0,
      labels
    };
  }

  // Verification / Build / Test stage
  if (tool.includes('test') || cmd.includes('test') || cmd.includes('setup') || cmd.includes('compile') ||
      phase.includes('test') || phase.includes('compil') || phase.includes('build') || phase.includes('release') || phase.includes('verif')) {
    return {
      completedCount: 2,
      segments: [true, true, false, false],
      activeSegment: 2,
      labels
    };
  }

  // Tool execution stage (read, write, edit, run, MCP)
  if (tool || status === 'running') {
    return {
      completedCount: 1,
      segments: [true, false, false, false],
      activeSegment: 1,
      labels
    };
  }

  return {
    completedCount: 0,
    segments: [false, false, false, false],
    activeSegment: -1,
    labels
  };
}

// Preload Antigravity Logo
const antigravityLogo = new Image();
antigravityLogo.src = '../../antigravity_logo.png';

// High-DPI Canvas Resizing
let dpr = 1;
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Helper: Quartic Ease Out
function easeOutQuart(x) {
  return 1 - Math.pow(1 - x, 3.6);
}

// Helper: Subtle Ease-Out Back (overshoot on both open and close)
function easeOutBack(x, s = 0.85) {
  const t = Math.max(0, Math.min(1, x));
  const c1 = s;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeOpenCloseBack(p, isOpening = true, s = 0.85) {
  const t = Math.max(0, Math.min(1, p));
  if (t <= 0.0001) return 0;
  if (t >= 0.9999) return 1;
  return isOpening ? easeOutBack(t, s) : (1 - easeOutBack(1 - t, s));
}

let isCapsuleOpening = true;
let isSongPopupOpening = true;
let isPeekHidingDir = false;

// Helper: Point in Rounded Rect
function pointInRect(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

// Active button hitboxes
let interactiveButtons = [];

// Hover tracking
let mouseX = -1000;
let mouseY = -1000;
let hoveredButtonId = null;

let lastIgnoreMouseEvents = null;
let lastForwardMouseEvents = null;
function setIgnoreMouseEventsCached(ignore, options) {
  const nextIgnore = Boolean(ignore);
  const nextForward = Boolean(options && options.forward);
  if (nextIgnore === lastIgnoreMouseEvents && nextForward === lastForwardMouseEvents) return;
  lastIgnoreMouseEvents = nextIgnore;
  lastForwardMouseEvents = nextForward;
  if (nextIgnore && options) {
    ipcRenderer.send('set-ignore-mouse-events', true, options);
  } else {
    ipcRenderer.send('set-ignore-mouse-events', nextIgnore);
  }
}

// Initial transparent click-through state
setIgnoreMouseEventsCached(true, { forward: true });

// Prevent accidental window close or reload via shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && ['w', 'r'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Drag & Drop Shelf Support inside Island / Notch (Dual-Zone: One-Time vs Keep)
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const splitX = window.innerWidth / 2;
  const nextZone = e.clientX < splitX ? 'onetime' : 'keep';
  const zoneChanged = nextZone !== dropZoneHoverZone;
  dropZoneHoverZone = nextZone;
  if (!isDraggingOver) {
    isDraggingOver = true;
    isPeekHidden = false;
    isTucked = false;
    targetProgress = 1.0;
    currentView = 'dropzone';
    setIgnoreMouseEventsCached(false);
    requestFrame();
  } else if (zoneChanged) {
    requestFrame();
  }
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;
  requestFrame();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  isDraggingOver = false;
  soundFX.play('drop');
  const isOneTime = e.clientX < (window.innerWidth / 2);
  if (e.dataTransfer) {
    const fileList = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (fileList.length === 0 && e.dataTransfer.items) {
      for (const item of e.dataTransfer.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) fileList.push(f);
        }
      }
    }
    for (const file of fileList) {
      let filePath = null;
      try {
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
          filePath = webUtils.getPathForFile(file);
        }
      } catch (err) {}
      if (!filePath && file && file.path) {
        filePath = file.path;
      }
      if (filePath) {
        ipcRenderer.send('dropzone-add-file', { filePath, isOneTime });
      }
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

  if (isInlineModalOpen) {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    isHovered = true;
    setIgnoreMouseEventsCached(false);
    return;
  }

  const prevLumpHovered = isLumpHovered;
  const lumpHit = getTopLumpHitbox(window.innerWidth);
  const isOverTopLump = pointInRect(mouseX, mouseY, lumpHit.x, lumpHit.y, lumpHit.w, lumpHit.h);
  isLumpHovered = isOverTopLump;

  if (isTucked) {
    isPeekHidden = false;
    hoveredButtonId = null;
    if (isOverTopLump) {
      setIgnoreMouseEventsCached(false);
      canvas.style.cursor = 'pointer';
    } else {
      setIgnoreMouseEventsCached(true, { forward: true });
      canvas.style.cursor = 'default';
    }
    if (isLumpHovered !== prevLumpHovered) requestFrame();
    return;
  }

  // Island pill hit detection
  const curP = Math.max(0, Math.min(1, animProgress));
  const curW = getTargetWidth(curP);
  const curH = getTargetHeight(curP);
  const curX = (window.innerWidth - curW) / 2;
  const isNotch = displayMode === 'notch';
  const curY = isNotch ? 0 : 8;

  const activeProjsForPill = getActiveProjects().filter(p => ['running', 'thinking', 'waiting'].includes(p.status));
  const hasAIPill = (curP < 0.28 && (activeProjsForPill.length > 0 || pendingPrompt !== null));
  const aiPillSpan = hasAIPill ? 168 : 0;

  const hasTimerPill = (curP < 0.28 && (timerRunning || focusRunning || stopwatchRunning));
  const timerPillSpan = hasTimerPill ? 116 : 0;

  const hasCallPill = (curP < 0.28 && hasActiveCall());
  const callPillSpan = hasCallPill ? (getCallCapsuleWidth() + 12) : 0;

  const leftSpan = aiPillSpan;
  const rightSpan = timerPillSpan + callPillSpan;
  const notchEarMargin = isNotch ? 18 : 8;
  const isPopupShowing = (songPopupProgress > 0.05 || songPopupActiveUntil > performance.now()) && curP < 0.35;
  const isExpandedState = (targetProgress >= 0.5 || curP >= 0.35);

  const isOverIsland = pointInRect(
    mouseX,
    mouseY,
    curX - notchEarMargin - leftSpan,
    0,
    curW + notchEarMargin * 2 + leftSpan + rightSpan,
    curY + curH + 14
  );

  if (isExpandedState || isPopupShowing) {
    isPeekHidden = false;
    if (isOverIsland) {
      if (isPopupShowing) {
        hoveredDuringSongPopup = true;
      }
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      isHovered = true;
      setIgnoreMouseEventsCached(false);
      if (liquidGlassEnabled) requestFrame();
    } else {
      if (hoveredDuringSongPopup) {
        dismissSongAnnouncement();
        requestFrame();
      }
      if (isHovered && !leaveTimer && !isInlineModalOpen) {
        leaveTimer = setTimeout(() => {
          if (isInlineModalOpen) return;
          isHovered = false;
          targetProgress = 0.0;
          currentView = 'home';
          previousView = 'home';
          tabTransitionStartTime = 0;
          navIndicatorX = null;
          navIndicatorW = null;
          isNavPillAnimating = false;
          ipcRenderer.send('island-hover-end');
          leaveTimer = null;
          requestFrame();
          setTimeout(() => {
            if (!isHovered && !isInlineModalOpen) {
              setIgnoreMouseEventsCached(true, { forward: true });
            }
          }, 260);
        }, UI.LEAVE_DELAY);
      }
    }
  } else {
    // Collapsed resting notch/island: hovering retracts upward into the visible top lump
    if (isOverIsland) {
      if (!isPeekHidden) {
        isPeekHidden = true;
        requestFrame();
      }
      isHovered = false;
      hoveredButtonId = null;
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    } else {
      if (isPeekHidden) {
        isPeekHidden = false;
        requestFrame();
      }
      hoveredButtonId = null;
    }

    if (isOverTopLump) {
      setIgnoreMouseEventsCached(false);
      canvas.style.cursor = 'pointer';
    } else {
      setIgnoreMouseEventsCached(true, { forward: true });
      canvas.style.cursor = 'default';
    }
    if (isLumpHovered !== prevLumpHovered) requestFrame();
    return;
  }

  let needsFrame = false;
  if (isDraggingVolume && volumeSliderBounds) {
    wasVolumeDragging = true;
    updateVolumeFromMouseY(mouseY, volumeSliderBounds);
    needsFrame = true;
  }

  // Shelf drag-out trigger
  if (shelfDragCandidate && Math.hypot(mouseX - shelfDragCandidate.x, mouseY - shelfDragCandidate.y) > 6) {
    const candidate = { ...shelfDragCandidate };
    wasShelfDragging = true;
    lastDraggedShelfCandidate = candidate;
    shelfDragCandidate = null;
    canvas.draggable = false;
    ipcRenderer.send('shelf-drag-start', { filePath: candidate.path, oneTime: Boolean(candidate.oneTime) });
    needsFrame = true;
  }

  // Button hover inspection
  let found = null;
  for (const btn of interactiveButtons) {
    if (pointInRect(mouseX, mouseY, btn.x, btn.y, btn.w, btn.h)) {
      found = btn.id;
      break;
    }
  }

  if (found !== hoveredButtonId) {
    hoveredButtonId = found;
    canvas.style.cursor = found ? 'pointer' : 'default';
    needsFrame = true;
  }
  if (needsFrame) requestFrame();
});

canvas.addEventListener('mouseleave', () => {
  if (isInlineModalOpen) return;
  const prevLump = isLumpHovered;
  isLumpHovered = false;
  if (isPeekHidden) {
    isPeekHidden = false;
    requestFrame();
  } else if (prevLump) {
    requestFrame();
  }
  if (hoveredDuringSongPopup || songPopupActiveUntil > performance.now()) {
    dismissSongAnnouncement();
    requestFrame();
  }
  if (!isHovered && targetProgress < 0.5) {
    hoveredButtonId = null;
    setIgnoreMouseEventsCached(true, { forward: true });
    return;
  }
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    if (isInlineModalOpen) return;
    isHovered = false;
    targetProgress = 0.0;
    currentView = 'home';
    previousView = 'home';
    tabTransitionStartTime = 0;
    navIndicatorX = null;
    navIndicatorW = null;
    isNavPillAnimating = false;
    ipcRenderer.send('island-hover-end');
    leaveTimer = null;
    setIgnoreMouseEventsCached(true, { forward: true });
    requestFrame();
  }, UI.LEAVE_DELAY);
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  setTucked(!isTucked);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const cx = e.clientX;
  const cy = e.clientY;
  wasShelfDragging = false;
  wasVolumeDragging = false;
  if (currentView === 'media') {
    for (const btn of interactiveButtons) {
      if (btn.id === 'media_volume_slider' && pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
        isDraggingVolume = true;
        volumeSliderBounds = btn.data || volumeSliderBounds;
        updateVolumeFromMouseY(cy, volumeSliderBounds);
        break;
      }
    }
  }
  if (currentView === 'dropzone') {
    for (const btn of interactiveButtons) {
      if (btn.id && (btn.id.startsWith('dropzone_row_') || btn.id.startsWith('dropzone_open_file_')) && pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
        shelfDragCandidate = { x: cx, y: cy, path: btn.data, oneTime: Boolean(btn.oneTime) };
        canvas.draggable = true;
        break;
      }
    }
  }
});

canvas.addEventListener('dragstart', (e) => {
  if (shelfDragCandidate && shelfDragCandidate.path) {
    wasShelfDragging = true;
    lastDraggedShelfCandidate = { ...shelfDragCandidate };
    e.preventDefault();
    ipcRenderer.send('shelf-drag-start', {
      filePath: shelfDragCandidate.path,
      oneTime: Boolean(shelfDragCandidate.oneTime)
    });
    shelfDragCandidate = null;
    canvas.draggable = false;
  }
});

canvas.addEventListener('dragend', () => {
  canvas.draggable = false;
  if (lastDraggedShelfCandidate && lastDraggedShelfCandidate.path && lastDraggedShelfCandidate.oneTime) {
    ipcRenderer.send('shelf-drag-completed', lastDraggedShelfCandidate.path);
  }
  lastDraggedShelfCandidate = null;
  shelfDragCandidate = null;
});

canvas.addEventListener('mouseup', () => {
  canvas.draggable = false;
  shelfDragCandidate = null;
  isDraggingVolume = false;
});

window.addEventListener('keydown', (e) => {
  if (currentView === 'clipboard') {
    if (e.key === 'Backspace') {
      clipboardFilter = clipboardFilter.slice(0, -1);
    } else if (e.key === 'Escape') {
      clipboardFilter = '';
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      clipboardFilter += e.key;
    }
  }
});

canvas.addEventListener('click', (e) => {
  if (wasShelfDragging) {
    wasShelfDragging = false;
    return;
  }
  if (wasVolumeDragging) {
    wasVolumeDragging = false;
    return;
  }
  const cx = e.clientX;
  const cy = e.clientY;

  const lumpHit = getTopLumpHitbox(window.innerWidth);
  const clickedTopLump = pointInRect(cx, cy, lumpHit.x, lumpHit.y, lumpHit.w, lumpHit.h);

  if (animProgress < 0.35 && targetProgress < 0.5 && (clickedTopLump || isTucked)) {
    isTucked = false;
    isPeekHidden = false;
    songPopupActiveUntil = 0;
    const nextV = (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing')
      ? 'media'
      : 'home';
    currentView = nextV;
    previousView = nextV;
    tabTransitionStartTime = 0;
    navIndicatorX = null;
    navIndicatorW = null;
    currentExpandedH = getTargetExpandedHeightForView(nextV);
    isHovered = true;
    targetProgress = 1.0;
    setIgnoreMouseEventsCached(false);
    ipcRenderer.send('island-hover-start');
    requestFrame();
    return;
  }

  for (const btn of interactiveButtons) {
    if (pointInRect(cx, cy, btn.x, btn.y, btn.w, btn.h)) {
      soundFX.play('tap');
      handleButtonClick(btn.id, btn.data);
      requestFrame();
      return;
    }
  }

  // Dismiss song announcement if clicking banner surface
  if (songPopupProgress > 0.05 && animProgress < 0.25) {
    const popW = SONG_POPUP_WIDTH;
    const popH = SONG_POPUP_HEIGHT;
    const popX = (window.innerWidth - popW) / 2;
    const popY = displayMode === 'notch' ? 0 : 8;
    if (pointInRect(cx, cy, popX, popY, popW, popH)) {
      dismissSongAnnouncement();
      requestFrame();
      return;
    }
  }

  // Click on resting badge or main body
  if (animProgress < 0.3) {
    const curW = getTargetWidth(animProgress);
    const curX = (window.innerWidth - curW) / 2;
    const activeProjsForPill = getActiveProjects().filter(p => ['running', 'thinking', 'waiting'].includes(p.status));
    const hasAIPill = (activeProjsForPill.length > 0 || pendingPrompt !== null);
    const hasTimerPill = (timerRunning || focusRunning || stopwatchRunning);

    let nextV = 'home';
    if (hasAIPill && cx < curX) {
      nextV = 'agent';
    } else if (hasTimerPill && cx >= curX + curW && (!hasActiveCall() || cx < curX + curW + 124)) {
      nextV = 'clock';
      if (focusRunning) clockSubMode = 'focus';
      else if (stopwatchRunning) clockSubMode = 'stopwatch';
      else if (timerRunning) clockSubMode = 'timer';
    } else if (hasActiveCall() && cx >= curX + curW) {
      nextV = 'call';
    } else if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
      nextV = 'media';
    }
    currentView = nextV;
    previousView = nextV;
    tabTransitionStartTime = 0;
    navIndicatorX = null;
    navIndicatorW = null;
    isNavPillAnimating = false;
    currentExpandedH = getTargetExpandedHeightForView(nextV);
    targetProgress = 1.0;
    requestFrame();
  }
});

function handleButtonClick(id, data) {
  if (id === 'nav_home') {
    switchTab('home');
  } else if (id === 'nav_notif' || id === 'nav_notif_card') {
    switchTab('notifications');
    ipcRenderer.send('mark-notifications-read');
  } else if (id === 'notif_clear_all') {
    ipcRenderer.send('clear-all-notifications');
    notificationList = [];
  } else if (id && id.startsWith('notif_dismiss_')) {
    const notifId = id.replace('notif_dismiss_', '');
    ipcRenderer.send('dismiss-notification', notifId);
    notificationList = notificationList.filter(n => n.id !== notifId);
  } else if (id && id.startsWith('notif_item_')) {
    const notifId = id.replace('notif_item_', '');
    const found = notificationList.find(n => n.id === notifId);
    if (found) {
      found.read = true;
      ipcRenderer.send('mark-notifications-read');
      if (found.app) {
        ipcRenderer.send('focus-app', found.app);
      }
    }
  } else if (id === 'notif_banner_dismiss') {
    notificationBannerUntil = 0;
    targetProgress = 0.0;
    switchTab('home');
  } else if (id === 'notif_banner_click') {
    if (activeNotification && activeNotification.app === 'Dynamic Windows' && activeNotification.icon === '👋') {
      switchTab('home');
      activeNotification = null;
      notificationBannerUntil = 0;
    } else {
      switchTab('notifications');
      ipcRenderer.send('mark-notifications-read');
    }
  } else if (id === 'btn_edit_user_name') {
    promptForUserName(false);
  } else if (id === 'btn_cycle_greeting') {
    activeGreeting = getNextPersonalizedGreeting(currentUserName);
  } else if (id === 'home_clock_display') {
    switchTab('clock');
    triggerRollingWheelSpin('home_digital_clock', 3);
  } else if (id === 'nav_calendar') {
    switchTab('calendar');
  } else if (id === 'cal_prev_month') {
    calendarViewMonth--;
    if (calendarViewMonth < 0) {
      calendarViewMonth = 11;
      calendarViewYear--;
    }
  } else if (id === 'cal_next_month') {
    calendarViewMonth++;
    if (calendarViewMonth > 11) {
      calendarViewMonth = 0;
      calendarViewYear++;
    }
  } else if (id === 'cal_today') {
    const td = new Date();
    const nextDate = td.toISOString().slice(0, 10);
    calNotesAnimDir = nextDate >= calendarSelectedDate ? 1 : -1;
    calNotesAnimStart = performance.now();
    calendarViewYear = td.getFullYear();
    calendarViewMonth = td.getMonth();
    calendarSelectedDate = nextDate;
  } else if (id && id.startsWith('cal_day_')) {
    if (data && data !== calendarSelectedDate) {
      calNotesAnimDir = data >= calendarSelectedDate ? 1 : -1;
      calNotesAnimStart = performance.now();
      calendarSelectedDate = data;
    }
  } else if (id === 'cal_add_note_btn') {
    const chips = [
      { id: 'none', label: 'Once', iconSvg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>' },
      { id: 'daily', label: 'Daily', iconSvg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14"/></svg>' },
      { id: 'weekly', label: 'Weekly', iconSvg: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v2.5M10.5 2v2.5"/></svg>' },
      { id: 'monthly', label: 'Monthly', iconSvg: '<svg viewBox="0 0 16 16"><path d="M12.5 5.5A5 5 0 1 0 13 9"/><polyline points="12.5 2.5 12.5 5.5 9.5 5.5"/></svg>' },
      { id: 'yearly', label: 'Yearly', iconSvg: '<svg viewBox="0 0 16 16"><path d="M8 2.5l1.6 3.4 3.7.5-2.7 2.6.6 3.7L8 11l-3.2 1.7.6-3.7-2.7-2.6 3.7-.5z"/></svg>' }
    ];
    const colorSwatches = ['#3b82f6', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#94a3b8'];
    showInlineModal(
      `Add Event (${calendarSelectedDate})`,
      'Event title',
      chips,
      (text, repeat, extra) => {
        ipcRenderer.invoke('calendar-add-note', {
          date: calendarSelectedDate,
          text,
          description: (extra && extra.description) || '',
          category: (extra && extra.category) || 'General',
          color: (extra && extra.color) || '#3b82f6',
          repeat: repeat || 'none'
        });
      },
      {
        descriptionPlaceholder: 'Description (optional)',
        categories: calendarCategories,
        onAddCategory: (catName) => {
          ipcRenderer.invoke('calendar-add-category', catName);
        },
        colors: colorSwatches,
        defaultColor: '#3b82f6'
      }
    );
  } else if (id && id.startsWith('cal_del_')) {
    ipcRenderer.invoke('calendar-delete-note', data);
  } else if (id === 'nav_clock') {
    switchTab('clock');
    if (focusRunning) clockSubMode = 'focus';
    else if (stopwatchRunning) clockSubMode = 'stopwatch';
    else if (timerRunning) clockSubMode = 'timer';
    targetProgress = 1.0;
  } else if (id && id.startsWith('clock_submode_')) {
    clockSubMode = id.replace('clock_submode_', '');
  } else if (id && id.startsWith('timer_preset_')) {
    const sec = Number(data) || 300;
    timerDurationSec = sec;
    timerRemainingSec = sec;
    timerRunning = false;
  } else if (id === 'timer_start_pause') {
    timerRunning = !timerRunning;
    timerLastTick = performance.now();
  } else if (id === 'timer_reset') {
    timerRemainingSec = timerDurationSec;
    timerRunning = false;
  } else if (id === 'timer_clear') {
    timerDurationSec = 0;
    timerRemainingSec = 0;
    timerRunning = false;
  } else if (id && id.startsWith('timer_inc_')) {
    const unit = id.replace('timer_inc_', '');
    if (unit === 'h') adjustTimerHours(1);
    else if (unit === 'm') adjustTimerMins(1);
    else if (unit === 's') adjustTimerSecs(1);
  } else if (id && id.startsWith('timer_dec_')) {
    const unit = id.replace('timer_dec_', '');
    if (unit === 'h') adjustTimerHours(-1);
    else if (unit === 'm') adjustTimerMins(-1);
    else if (unit === 's') adjustTimerSecs(-1);
  } else if (id === 'timer_minus') {
    adjustTimerMins(-1);
  } else if (id === 'timer_plus') {
    adjustTimerMins(1);
  } else if (id === 'sw_start_pause') {
    stopwatchRunning = !stopwatchRunning;
    stopwatchStartTs = performance.now();
  } else if (id === 'sw_lap') {
    if (stopwatchRunning || stopwatchElapsedMs > 0) {
      stopwatchLaps.push({ time: stopwatchElapsedMs, timestamp: Date.now() });
    }
  } else if (id === 'sw_reset') {
    stopwatchRunning = false;
    stopwatchElapsedMs = 0;
    stopwatchLaps = [];
  } else if (id === 'focus_start_pause') {
    focusRunning = !focusRunning;
    focusLastTick = performance.now();
  } else if (id && id.startsWith('focus_goal_')) {
    focusGoalTag = String(data);
    try { localStorage.setItem('focus_goal_tag', focusGoalTag); } catch (e) {}
  } else if (id && id.startsWith('focus_work_dur_')) {
    const min = Number(data);
    focusWorkDurationMin = min;
    try { localStorage.setItem('focus_work_min', min); } catch (e) {}
    if (focusMode === 'work' && !focusRunning) {
      focusRemainingSec = min * 60;
    }
  } else if (id && id.startsWith('focus_break_dur_')) {
    const min = Number(data);
    focusBreakDurationMin = min;
    try { localStorage.setItem('focus_break_min', min); } catch (e) {}
    if (focusMode !== 'work' && !focusRunning) {
      focusRemainingSec = min * 60;
    }
  } else if (id === 'focus_skip') {
    if (focusMode === 'work') {
      focusSessionsCompleted++;
      focusMode = (focusSessionsCompleted % 4 === 0) ? 'long_break' : 'short_break';
      focusRemainingSec = (focusMode === 'long_break') ? 15 * 60 : focusBreakDurationMin * 60;
    } else {
      focusMode = 'work';
      focusRemainingSec = focusWorkDurationMin * 60;
    }
  } else if (id === 'focus_reset') {
    focusRunning = false;
    focusMode = 'work';
    focusRemainingSec = focusWorkDurationMin * 60;
  } else if (id === 'alarm_hour_inc') {
    alarmPickerHour = (alarmPickerHour % 12) + 1;
  } else if (id === 'alarm_hour_dec') {
    alarmPickerHour = ((alarmPickerHour - 2 + 12) % 12) + 1;
  } else if (id === 'alarm_min_inc') {
    alarmPickerMinute = (alarmPickerMinute + 1) % 60;
  } else if (id === 'alarm_min_dec') {
    alarmPickerMinute = (alarmPickerMinute - 1 + 60) % 60;
  } else if (id === 'alarm_toggle_ampm') {
    alarmPickerAmPm = alarmPickerAmPm === 'AM' ? 'PM' : 'AM';
  } else if (id === 'alarm_add_btn') {
    const newAlarm = {
      id: 'alarm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      hour: alarmPickerHour,
      minute: alarmPickerMinute,
      ampm: alarmPickerAmPm,
      label: 'Alarm',
      enabled: true,
      lastTriggeredDate: null
    };
    alarmsList.push(newAlarm);
    saveAlarms();
    soundFX.play('switch');
  } else if (id && id.startsWith('alarm_toggle_')) {
    const alId = id.replace('alarm_toggle_', '');
    const found = alarmsList.find(a => a.id === alId);
    if (found) {
      found.enabled = !found.enabled;
      saveAlarms();
      soundFX.play('switch');
    }
  } else if (id && id.startsWith('alarm_del_')) {
    const alId = id.replace('alarm_del_', '');
    alarmsList = alarmsList.filter(a => a.id !== alId);
    saveAlarms();
    soundFX.play('tap');
  } else if (id === 'alarm_snooze') {
    snoozeActiveAlarm();
    soundFX.play('switch');
  } else if (id === 'alarm_dismiss') {
    dismissActiveAlarm();
    soundFX.play('tap');
  } else if (id === 'nav_todo') {
    switchTab('todo');
  } else if (id === 'notes_submode_notes') {
    notesSubMode = 'notes';
    soundFX.play('tap');
  } else if (id === 'notes_submode_todo') {
    notesSubMode = 'todo';
    soundFX.play('tap');
  } else if (id === 'notes_add_btn') {
    showInlineModal('New Note', 'Write your note...', null, (noteText) => {
      if (noteText && noteText.trim()) {
        ipcRenderer.invoke('notes-add', { title: noteText.trim().slice(0, 40), body: noteText.trim() });
      }
    });
  } else if (id && id.startsWith('notes_open_')) {
    const targetNote = (notesList || []).find(n => n.id === data);
    if (targetNote) {
      showInlineModal('Edit Note', 'Update your note...', null, (noteText) => {
        if (noteText && noteText.trim()) {
          ipcRenderer.invoke('notes-update', { id: targetNote.id, title: noteText.trim().slice(0, 40), body: noteText.trim() });
        }
      });
      if (inlineModalInputEl) {
        inlineModalInputEl.value = targetNote.body || targetNote.title || '';
      }
    }
  } else if (id && id.startsWith('notes_del_')) {
    ipcRenderer.invoke('notes-delete', data);
  } else if (id && id.startsWith('todo_cat_')) {
    todoSelectedCategory = data;
  } else if (id === 'todo_add_category_btn') {
    showInlineModal('New Category', 'Category name (e.g. Projects, Fitness)', null, (catName) => {
      ipcRenderer.invoke('todo-add-category', catName).then(() => {
        todoSelectedCategory = catName;
      });
    });
  } else if (id === 'todo_delete_category_btn') {
    if (todoSelectedCategory !== 'All') {
      ipcRenderer.invoke('todo-delete-category', todoSelectedCategory).then(() => {
        todoSelectedCategory = 'All';
      });
    }
  } else if (id === 'todo_add_task_btn') {
    const cats = (todoData.categories || []).map(c => ({ id: c, label: c }));
    const defaultCat = (todoSelectedCategory !== 'All' && cats.some(c => c.id === todoSelectedCategory))
      ? todoSelectedCategory
      : (cats[0] ? cats[0].id : 'General');
    const sortedChips = [
      { id: defaultCat, label: defaultCat },
      ...cats.filter(c => c.id !== defaultCat)
    ];
    showInlineModal('Add To-Do Task', 'Task description...', sortedChips, (taskText, chosenCat) => {
      ipcRenderer.invoke('todo-add-task', {
        text: taskText,
        category: chosenCat || defaultCat
      });
    });
  } else if (id && id.startsWith('todo_check_')) {
    ipcRenderer.invoke('todo-toggle-task', data);
  } else if (id && id.startsWith('todo_del_')) {
    ipcRenderer.invoke('todo-delete-task', data);
  } else if (id === 'nav_agent') {
    switchTab('agent');
    targetProgress = 1.0;
  } else if (id === 'nav_call') {
    switchTab('call');
  } else if (id === 'nav_media') {
    switchTab('media');
  } else if (id === 'call_toggle_mute') {
    ipcRenderer.send('call-action', 'toggle-mute');
  } else if (id === 'call_toggle_deafen') {
    ipcRenderer.send('call-action', 'toggle-deafen');
  } else if (id === 'call_leave') {
    ipcRenderer.send('call-action', 'leave-call');
    switchTab('home');
  } else if (id === 'call_answer') {
    ipcRenderer.send('call-action', 'answer-call');
    callState.status = 'connected';
    lastCallRinging = false;
    targetProgress = 0.0;
    switchTab('home');
  } else if (id === 'call_decline') {
    ipcRenderer.send('call-action', 'decline-call');
    callState = { inCall: false, status: 'idle', participants: [] };
    lastCallRinging = false;
    targetProgress = 0.0;
    switchTab('home');
  } else if (id === 'call_focus_app') {
    ipcRenderer.send('call-action', 'focus-app');
  } else if (id === 'nav_dropzone') {
    switchTab('dropzone');
  } else if (id === 'nav_clipboard') {
    switchTab('clipboard');
    ipcRenderer.send('clipboard-get');
  } else if (id === 'nav_settings') {
    ipcRenderer.send('open-settings');
  } else if (id === 'toggle_dynamic_lyrics') {
    dynamicLyricsEnabled = !dynamicLyricsEnabled;
    lyricModeStageTarget = dynamicLyricsEnabled ? 'word' : 'line';
    lyricModeStageAnimStart = (reducedMotionEnabled || liteModeEnabled) ? 0 : performance.now();
    if (reducedMotionEnabled || liteModeEnabled) {
      lyricModeToggleAnim = dynamicLyricsEnabled ? 1.0 : 0.0;
    }
    ipcRenderer.send('set-dynamic-lyrics', dynamicLyricsEnabled);
  } else if (id === 'toggle_display_mode') {
    displayMode = displayMode === 'island' ? 'notch' : 'island';
    ipcRenderer.send('set-display-mode', displayMode);
  } else if (id === 'btn_top_exit') {
    soundFX.play('click');
    ipcRenderer.send('exit-app');
  } else if (id === 'song_popup_open_media') {
    songPopupActiveUntil = 0;
    switchTab('media');
    targetProgress = 1.0;
  } else if (id === 'song_popup_dismiss') {
    dismissSongAnnouncement();
  } else if (id === 'tuck_island') {
    setTucked(true);
  } else if (id && id.startsWith('media_speed_')) {
    const val = data === 'auto' ? null : Number(data);
    ipcRenderer.send('media-set-speed', val);
  } else if (id === 'media_offset_minus') {
    const cur = mediaState.lyric_offset_ms || 0;
    ipcRenderer.send('media-set-offset', cur - 500);
  } else if (id === 'media_offset_plus') {
    const cur = mediaState.lyric_offset_ms || 0;
    ipcRenderer.send('media-set-offset', cur + 500);
  } else if (id === 'media_offset_reset') {
    ipcRenderer.send('media-set-offset', 0);
  } else if (id && id.startsWith('clip_copy_')) {
    const clipId = data;
    ipcRenderer.send('clipboard-copy', clipId);
    copiedFeedbackId = clipId;
    if (copiedFeedbackTimer) clearTimeout(copiedFeedbackTimer);
    copiedFeedbackTimer = setTimeout(() => {
      copiedFeedbackId = null;
      requestFrame();
    }, 1800);
    requestFrame();
  } else if (id && id.startsWith('clip_pin_')) {
    ipcRenderer.send('clipboard-pin', data);
  } else if (id === 'clipboard_clear') {
    ipcRenderer.send('clipboard-clear');
  } else if (id === 'dropzone_reveal') {
    ipcRenderer.send('open-dropzone');
  } else if (id === 'dropzone_clear') {
    ipcRenderer.send('dropzone-clear-all');
  } else if (id === 'dropzone_browse') {
    ipcRenderer.send('dropzone-browse-file');
  } else if (id && (id === 'dropzone_open_file' || id.startsWith('dropzone_open_file_') || id.startsWith('dropzone_row_'))) {
    ipcRenderer.send('dropzone-open-file', data);
  } else if (id && (id === 'dropzone_delete_file' || id.startsWith('dropzone_delete_file_'))) {
    ipcRenderer.send('dropzone-delete-file', data);
  } else if (id === 'jump_antigravity' || (id && id.startsWith('focus_proj_'))) {
    ipcRenderer.send('focus-antigravity');
  } else if (id === 'media_volume_mute') {
    ipcRenderer.send('toggle-media-mute', getMediaAppHint());
  } else if (id === 'media_play_pause') {
    ipcRenderer.send('media-play-pause');
  } else if (id === 'media_next') {
    ipcRenderer.send('media-next');
  } else if (id === 'media_prev') {
    ipcRenderer.send('media-prev');
  } else if (id === 'media_seek' && data) {
    const ratio = Math.max(0, Math.min(1, (mouseX - data.x) / data.w));
    const dur = mediaState.duration_ms || 0;
    if (dur > 0) {
      const targetMs = Math.round(ratio * dur);
      mediaState.progress_ms = targetMs;
      mediaSyncAt = performance.now();
      ipcRenderer.send('media-seek', targetMs);
    }
  } else if (id === 'prompt_allow') {
    ipcRenderer.send('permission-response', { id: data, allow: true });
    pendingPrompt = null;
    currentView = 'home';
    requestFrame();
  } else if (id === 'prompt_deny') {
    ipcRenderer.send('permission-response', { id: data, allow: false });
    pendingPrompt = null;
    currentView = 'home';
    requestFrame();
  }
}

// -------------------------------------------------------------
// IPC Listeners
// -------------------------------------------------------------
let lastAntigravitySig = '';
let aiPulseUntil = 0;
ipcRenderer.on('antigravity-state', (event, state) => {
  antigravityState = state;
  const projs = state && Array.isArray(state.projects) ? state.projects : [];
  const activeStatuses = ['running', 'thinking'];
  const isBusy = Boolean(
    (state && activeStatuses.includes(String(state.status || '').toLowerCase())) ||
    projs.some(p => activeStatuses.includes(String(p.status || '').toLowerCase()))
  );
  const sig = JSON.stringify({
    s: state && state.status,
    p: state && state.phase,
    t: state && state.task,
    k: projs.map(p => `${p.id || p.project}:${p.status}:${p.phase}:${p.task || ''}`).join(',')
  });
  if (sig !== lastAntigravitySig) {
    lastAntigravitySig = sig;
    if (isBusy) {
      aiPulseUntil = performance.now() + 900;
    }
    requestFrame();
  }
});

let lastCallRinging = false;
let lastCallSig = '';
ipcRenderer.on('call-state', (event, state) => {
  callState = state || { inCall: false, status: 'idle', participants: [] };

  const isRinging = Boolean(callState && callState.inCall && callState.status === 'ringing');
  if (isRinging && !lastCallRinging) {
    // ENLARGE Dynamic Island automatically when an incoming call arrives!
    currentView = 'call';
    targetProgress = 1.0;
    if (isTucked) setTucked(false);
    if (isGameModeFullscreen) {
      gameModeOpenedAnyway = true;
      ipcRenderer.send('game-mode-hide', false);
    }
  } else if (!isRinging && lastCallRinging) {
    if (currentView === 'call') {
      currentView = 'home';
      targetProgress = 0.0;
    }
  }
  lastCallRinging = isRinging;

  const parts = Array.isArray(callState.participants) ? callState.participants : [];
  const sig = JSON.stringify({
    i: Boolean(callState.inCall),
    s: callState.status,
    a: callState.app,
    m: Boolean(callState.isMuted),
    d: Boolean(callState.isDeafened),
    p: parts.map(pt => `${pt.name || ''}:${pt.isSpeaking ? 1 : 0}:${pt.isMuted ? 1 : 0}:${pt.isDeafened ? 1 : 0}`)
  });
  if (sig !== lastCallSig) {
    lastCallSig = sig;
    requestFrame();
  }
});

let lastMediaSig = '';
ipcRenderer.on('media-state', (event, state) => {
  mediaState = state || { isPlaying: false, track: null, progress_ms: 0, duration_ms: 0 };
  mediaSyncAt = performance.now();
  updateAlbumArt(mediaState.track ? mediaState.track.image_url : null);
  tickLyrics();

  // Song Change Downward Extension Trigger
  if (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing') {
    const curKey = `${mediaState.track.title}|${mediaState.track.artist || ''}`;
    if (lastSongAnnouncementKey !== '' && curKey !== lastSongAnnouncementKey) {
      triggerSongAnnouncement();
    }
    lastSongAnnouncementKey = curKey;
  }

  const tr = mediaState.track;
  const sig = JSON.stringify({
    pl: Boolean(mediaState.isPlaying),
    t: tr ? tr.title : '',
    a: tr ? tr.artist : '',
    im: tr ? tr.image_url : '',
    pm: mediaState.progress_ms || 0,
    dm: mediaState.duration_ms || 0
  });
  if (sig !== lastMediaSig || mediaState.isPlaying) {
    lastMediaSig = sig;
    requestFrame();
  }
});

ipcRenderer.on('toggle-tuck', () => {
  setTucked(!isTucked);
});

ipcRenderer.on('untuck-island', () => {
  setTucked(false);
  gameModeOpenedAnyway = true;
  ipcRenderer.send('game-mode-hide', false);
  targetProgress = 1.0;
  requestFrame();
});

ipcRenderer.on('game-mode-changed', (event, data) => {
  const isFull = (data && typeof data === 'object') ? Boolean(data.fullscreen) : Boolean(data);
  if (data && typeof data === 'object' && typeof data.enabled === 'boolean') {
    gameModeEnabled = data.enabled;
  }
  isGameModeFullscreen = isFull;
  if (!isGameModeFullscreen) {
    gameModeOpenedAnyway = false;
    ipcRenderer.send('game-mode-hide', false);
  } else if (gameModeEnabled && !gameModeOpenedAnyway && !pendingPrompt) {
    ipcRenderer.send('game-mode-hide', true);
  } else {
    ipcRenderer.send('game-mode-hide', false);
  }
  requestFrame();
});

ipcRenderer.on('game-mode-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    gameModeEnabled = data.enabled;
    if (typeof data.isFullscreen === 'boolean') {
      isGameModeFullscreen = data.isFullscreen;
    }
  }
  gameModeToastText = gameModeEnabled ? '🎮 Game Mode: ON (Auto-Hide in games)' : '🎮 Game Mode: OFF (Visible in games)';
  gameModeToastUntil = performance.now() + 2500;

  if (gameModeEnabled && isGameModeFullscreen && !gameModeOpenedAnyway && !pendingPrompt) {
    ipcRenderer.send('game-mode-hide', true);
  } else {
    ipcRenderer.send('game-mode-hide', false);
  }
  requestFrame();
});

ipcRenderer.on('dropzone-files', (event, files) => {
  dropZoneFiles = files || [];
  requestFrame();
});

ipcRenderer.on('clipboard-update', (event, list) => {
  clipboardHistory = list || [];
  requestFrame();
});

ipcRenderer.on('display-mode', (event, mode) => {
  displayMode = mode || 'island';
  requestFrame();
});
ipcRenderer.on('animation-speed', (event, speed) => {
  const val = parseFloat(speed);
  if (!isNaN(val) && val >= 0.2 && val <= 5.0) {
    animSpeedMultiplier = val;
    requestFrame();
  }
});
ipcRenderer.on('media-volume-update', (event, data) => {
  if (isDraggingVolume) return;
  let changed = false;
  if (data && typeof data.volume === 'number') {
    const nextV = Math.max(0, Math.min(1, data.volume));
    if (Math.abs(nextV - currentVolume) > 0.001) {
      currentVolume = nextV;
      changed = true;
    }
  }
  if (data && typeof data.muted === 'boolean' && data.muted !== isVolumeMuted) {
    isVolumeMuted = data.muted;
    changed = true;
  }
  if (changed && (animProgress > 0.1 || currentView === 'media')) requestFrame();
});
ipcRenderer.on('volume-update', (event, data) => {
  if (isDraggingVolume) return;
  let changed = false;
  if (data && typeof data.volume === 'number') {
    const nextV = Math.max(0, Math.min(1, data.volume));
    if (Math.abs(nextV - currentVolume) > 0.001) {
      currentVolume = nextV;
      changed = true;
    }
  }
  if (data && typeof data.muted === 'boolean' && data.muted !== isVolumeMuted) {
    isVolumeMuted = data.muted;
    changed = true;
  }
  if (changed && (animProgress > 0.1 || currentView === 'media')) requestFrame();
});
try {
  ipcRenderer.invoke('get-media-volume', '').then(res => {
    if (res && typeof res.volume === 'number') currentVolume = Math.max(0, Math.min(1, res.volume));
    if (res && typeof res.muted === 'boolean') isVolumeMuted = res.muted;
    requestFrame();
  }).catch(() => {});
} catch (e) {}
ipcRenderer.on('dynamic-lyrics-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    if (dynamicLyricsEnabled !== data.enabled) {
      lyricModeStageTarget = data.enabled ? 'word' : 'line';
      lyricModeStageAnimStart = (reducedMotionEnabled || liteModeEnabled) ? 0 : performance.now();
    }
    dynamicLyricsEnabled = data.enabled;
    if (reducedMotionEnabled || liteModeEnabled) {
      lyricModeToggleAnim = dynamicLyricsEnabled ? 1.0 : 0.0;
    }
    requestFrame();
  }
});

ipcRenderer.on('live-lyrics-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    liveLyricsEnabled = data.enabled;
    requestFrame();
  }
});
ipcRenderer.on('album-color-gradient-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    albumColorGradientEnabled = data.enabled;
    requestFrame();
  }
});
ipcRenderer.on('island-opacity-changed', (event, data) => {
  if (data && typeof data.opacity === 'number') {
    islandOpacity = Math.max(0.4, Math.min(1.0, data.opacity));
    requestFrame();
  }
});
ipcRenderer.on('liquid-glass-toggled', (event, data) => {
  if (data && typeof data.enabled === 'boolean') {
    liquidGlassEnabled = data.enabled;
    requestFrame();
  }
});
ipcRenderer.on('performance-settings-changed', (event, data) => {
  if (data && typeof data === 'object') {
    if (typeof data.liteMode === 'boolean') liteModeEnabled = data.liteMode;
    if (typeof data.reducedMotion === 'boolean') reducedMotionEnabled = data.reducedMotion;
    syncReducedMotionState();
    requestFrame();
  }
});
ipcRenderer.on('sound-effects-config', (event, data) => {
  if (data) {
    if (typeof data.enabled === 'boolean') {
      soundFX.setEnabled(data.enabled);
    }
    if (typeof data.volume === 'number') {
      soundFX.setVolume(data.volume);
    }
    if (typeof data.preset === 'string') {
      soundFX.setPreset(data.preset);
    }
  }
});
ipcRenderer.on('user-name-changed', (event, data) => {
  if (data && typeof data.userName === 'string') {
    currentUserName = data.userName.trim();
    if (currentUserName && !activeGreeting) {
      activeGreeting = getNextPersonalizedGreeting(currentUserName);
    }
    requestFrame();
  }
});
ipcRenderer.on('clock-settings-changed', (event, data) => {
  if (data && typeof data === 'object') {
    if (typeof data.clock24h === 'boolean') clock24h = data.clock24h;
    if (typeof data.showSeconds === 'boolean') showSeconds = data.showSeconds;
    if (typeof data.showAmPm === 'boolean') showAmPm = data.showAmPm;
    requestFrame();
  }
});

let batteryState = { hasBattery: false, percent: 100, isCharging: false };

ipcRenderer.on('battery-status-changed', (event, data) => {
  if (data && typeof data.hasBattery === 'boolean') {
    const nextPct = typeof data.percent === 'number' ? data.percent : 100;
    const nextChg = Boolean(data.isCharging);
    const changed = data.hasBattery !== batteryState.hasBattery || nextPct !== batteryState.percent || nextChg !== batteryState.isCharging;
    batteryState = {
      hasBattery: data.hasBattery,
      percent: nextPct,
      isCharging: nextChg
    };
    if (changed) requestFrame();
  }
});

try {
  ipcRenderer.invoke('get-battery-status').then(res => {
    if (res && typeof res.hasBattery === 'boolean') {
      batteryState = res;
      requestFrame();
    }
  }).catch(() => {});
} catch (e) {}

if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
  navigator.getBattery().then(batt => {
    function syncNativeBattery() {
      if (batteryState.hasBattery || !batt.charging || batt.level < 1.0) {
        const nextPct = Math.round(batt.level * 100);
        const nextChg = batt.charging;
        const nextHas = (!batt.charging || batt.level < 1.0) ? true : batteryState.hasBattery;
        if (nextPct !== batteryState.percent || nextChg !== batteryState.isCharging || nextHas !== batteryState.hasBattery) {
          batteryState.percent = nextPct;
          batteryState.isCharging = nextChg;
          batteryState.hasBattery = nextHas;
          requestFrame();
        }
      }
    }
    batt.addEventListener('levelchange', syncNativeBattery);
    batt.addEventListener('chargingchange', syncNativeBattery);
    syncNativeBattery();
  }).catch(() => {});
}
try {
  ipcRenderer.invoke('get-app-settings').then(res => {
    if (res && res.config) {
      if (typeof res.config.dynamicLyrics === 'boolean') {
        dynamicLyricsEnabled = res.config.dynamicLyrics;
        lyricModeToggleAnim = dynamicLyricsEnabled ? 1.0 : 0.0;
      }
      if (typeof res.config.liveLyrics === 'boolean') {
        liveLyricsEnabled = res.config.liveLyrics;
      }
      if (typeof res.config.albumColorGradient === 'boolean') {
        albumColorGradientEnabled = res.config.albumColorGradient;
      }
      if (typeof res.config.islandOpacity === 'number') {
        islandOpacity = Math.max(0.4, Math.min(1.0, res.config.islandOpacity));
      }
      if (typeof res.config.liquidGlass === 'boolean') {
        liquidGlassEnabled = res.config.liquidGlass;
      }
      if (typeof res.config.liteMode === 'boolean') {
        liteModeEnabled = res.config.liteMode;
      }
      if (typeof res.config.reducedMotion === 'boolean') {
        reducedMotionEnabled = res.config.reducedMotion;
      }
      syncReducedMotionState();
      if (typeof res.config.soundEffects === 'boolean') {
        soundFX.setEnabled(res.config.soundEffects);
      }
      if (typeof res.config.soundVolume === 'number') {
        soundFX.setVolume(res.config.soundVolume);
      }
      if (typeof res.config.soundPreset === 'string') {
        soundFX.setPreset(res.config.soundPreset);
      }
      if (typeof res.config.userName === 'string') {
        currentUserName = res.config.userName.trim();
      }
      if (!currentUserName && !hasPromptedForUserName) {
        hasPromptedForUserName = true;
        setTimeout(() => {
          promptForUserName(true);
        }, 650);
      } else if (currentUserName) {
        activeGreeting = getNextPersonalizedGreeting(currentUserName);
        setTimeout(() => {
          showPersonalizedBanner(activeGreeting, 'Personalized Dynamic Island');
        }, 500);
      }
      if (res.config.animationSpeed) {
        const val = parseFloat(res.config.animationSpeed);
        if (!isNaN(val) && val >= 0.2 && val <= 5.0) animSpeedMultiplier = val;
      }
      requestFrame();
    }
  }).catch(() => {});
} catch (e) {}

ipcRenderer.on('notifications-updated', (event, list) => {
  if (Array.isArray(list)) {
    notificationList = list.filter(n => !String(n.app || '').toLowerCase().includes('antigravity'));
    requestFrame();
  }
});
ipcRenderer.on('notification-received', (event, notif) => {
  if (notif && !String(notif.app || '').toLowerCase().includes('antigravity')) {
    activeNotification = notif;
    notificationBannerUntil = performance.now() + 4000;
    soundFX.play('notification');
    if (animProgress < 0.25) {
      currentView = 'notification_banner';
      targetProgress = 1.0;
    }
    requestFrame();
  }
});
try {
  ipcRenderer.invoke('get-notifications').then(list => {
    if (Array.isArray(list)) {
      notificationList = list.filter(n => !String(n.app || '').toLowerCase().includes('antigravity'));
      requestFrame();
    }
  }).catch(() => {});
} catch (e) {}

ipcRenderer.on('permission-prompt', (event, prompt) => {
  pendingPrompt = prompt;
  isPeekHidden = false;
  if (isTucked) setTucked(false);
  if (isGameModeFullscreen) {
    gameModeOpenedAnyway = true;
    ipcRenderer.send('game-mode-hide', false);
  }
  currentView = 'prompt';
  targetProgress = 1.0;
  requestFrame();
});

// -------------------------------------------------------------
// Render Loop (Adaptive Smooth Animation & Power Throttling)
// -------------------------------------------------------------
let lastTime = performance.now();
let animFrameRequested = false;
let idleFrameTimeout = null;
let lastSentW = -1;
let lastSentH = -1;

function computeDynamicActive(s) {
  if (!s || s.hiddenByGameMode) return false;

  if (Math.abs((s.targetProgress || 0) - (s.animProgress || 0)) > 0.001) return true;
  if (Math.abs((s.targetHide || 0) - (s.hideProgress || 0)) > 0.002) return true;
  if (Math.abs((s.targetRestW || 0) - (s.currentRestingWidth || 0)) > 0.5) return true;
  if ((s.animProgress || 0) > 0.05 && Math.abs((s.targetExpH || 0) - (s.currentExpandedH || 0)) > 0.5) return true;
  if (Math.abs((s.targetSongPopupProgress || 0) - (s.songPopupProgress || 0)) > 0.002) return true;
  if (Math.abs((s.wantTint || 0) - (s.tintK || 0)) > 0.004) return true;

  if ((s.animProgress || 0) > 0.15 && (s.isTabTransitioning || s.isNavPillAnimating)) return true;
  if (s.gameModeToastFading) return true;

  if (s.activeAlarmRinging || s.stopwatchRunning) return true;
  if (s.hasActiveTumbler) return true;
  if (s.mediaPlaying) return true;
  if (s.callInCall && (s.callRinging || s.callSpeaking)) return true;
  if (s.aiPulseActive) return true;

  if (s.isDraggingOver || s.isDraggingVolume || s.shelfDragCandidate) return true;

  return false;
}

function getNextIdleWakeDelayMs(s) {
  if (!s || s.hiddenByGameMode) return null;

  const now = typeof s.now === 'number' ? s.now : 0;
  const delays = [];

  if ((s.notificationBannerUntil || 0) > now) {
    delays.push(Math.max(16, s.notificationBannerUntil - now + 10));
  }
  if ((s.songPopupActiveUntil || 0) > now && (s.animProgress || 0) < 0.2) {
    delays.push(Math.max(16, s.songPopupActiveUntil - now + 10));
  }
  if ((s.gameModeToastUntil || 0) > now) {
    const fadeStartAt = s.gameModeToastUntil - 320;
    delays.push(fadeStartAt > now ? Math.max(16, fadeStartAt - now) : 16);
  }

  const hideFully = Boolean(s.isTucked || (s.hideProgress || 0) >= 0.98);
  const expanded = (s.animProgress || 0) >= 0.15;

  if (!hideFully && (s.timerRunning || s.focusRunning || s.callInCall)) {
    const dateMs = typeof s.dateMs === 'number' ? s.dateMs : 0;
    delays.push(1000 - (dateMs % 1000) + 15);
  } else if (hideFully && (s.timerRunning || s.focusRunning)) {
    const remSec = s.timerRunning ? (s.timerRemainingSec || 0) : (s.focusRemainingSec || 0);
    if (remSec > 0) delays.push(Math.max(50, Math.ceil(remSec * 1000) + 20));
  }

  if (!hideFully && ((expanded && s.currentView === 'home') || (s.showSeconds && !s.mediaPlaying))) {
    const dateMs = typeof s.dateMs === 'number' ? s.dateMs : 0;
    delays.push(1000 - (dateMs % 1000) + 15);
  } else if (!hideFully || s.hasEnabledAlarms) {
    const curSec = typeof s.dateSec === 'number' ? s.dateSec : 0;
    const curMs = typeof s.dateMs === 'number' ? s.dateMs : 0;
    const msToNextMin = (60 - curSec) * 1000 - curMs + 25;
    delays.push(Math.max(25, msToNextMin));
  }

  if (delays.length === 0) return null;
  return Math.max(16, Math.min(...delays));
}

function isHiddenByGameMode() {
  return Boolean(gameModeEnabled && isGameModeFullscreen && !gameModeOpenedAnyway && !pendingPrompt);
}

function getDynamicStateSnapshot(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : performance.now();
  const d = new Date();
  const hasMediaTrack = Boolean(mediaState && mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing');
  const wantTint = (albumColorGradientEnabled && !liteModeEnabled && hasMediaTrack && hideProgress < 0.5) ? 1.0 : 0.0;
  const tabDuration = Math.max(120, 220 / (animSpeedMultiplier || 1.0));
  const isTabTransitioning = Boolean(tabTransitionStartTime > 0 && (now - tabTransitionStartTime) < tabDuration && previousView && previousView !== currentView);
  const parts = callState && Array.isArray(callState.participants) ? callState.participants : [];
  const callSpeaking = Boolean(callState && callState.inCall && parts.some(p => p && p.isSpeaking));
  const toastRemain = gameModeToastUntil > now ? (gameModeToastUntil - now) : 0;
  const gameModeToastFading = Boolean(toastRemain > 0 && toastRemain <= 340);
  const activeProjs = typeof getActiveProjects === 'function' ? getActiveProjects() : [];
  const hasBusyAi = Boolean(
    (antigravityState && ['running', 'thinking'].includes(String(antigravityState.status || '').toLowerCase())) ||
    activeProjs.some(pr => ['running', 'thinking'].includes(String(pr.status || '').toLowerCase()))
  );

  return {
    now,
    dateSec: d.getSeconds(),
    dateMs: d.getMilliseconds(),
    hiddenByGameMode: isHiddenByGameMode(),
    targetProgress,
    animProgress,
    targetHide: isShouldBeHidden() ? 1.0 : 0.0,
    hideProgress,
    isTucked,
    targetRestW: getTargetRestingWidth(),
    currentRestingWidth,
    targetExpH: getTargetExpandedHeightForView(currentView),
    currentExpandedH,
    targetSongPopupProgress: (songPopupActiveUntil > now && animProgress < 0.2) ? 1.0 : 0.0,
    songPopupProgress,
    songPopupActiveUntil,
    notificationBannerUntil,
    gameModeToastUntil,
    gameModeToastFading,
    wantTint,
    tintK,
    currentView,
    isTabTransitioning,
    isNavPillAnimating: Boolean(
      isNavPillAnimating ||
      isCalDateAnimating ||
      (calNotesAnimStart > 0 && (nowMs - calNotesAnimStart) < 280) ||
      (lyricModeStageAnimStart > 0 && (nowMs - lyricModeStageAnimStart) < 460)
    ),
    activeAlarmRinging: Boolean(activeAlarmRinging),
    stopwatchRunning: Boolean(stopwatchRunning),
    timerRunning: Boolean(timerRunning),
    timerRemainingSec,
    focusRunning: Boolean(focusRunning),
    focusRemainingSec,
    showSeconds: Boolean(showSeconds),
    hasEnabledAlarms: Boolean(alarmsList && alarmsList.some(a => a && a.enabled)),
    hasActiveTumbler: Boolean(typeof hasActiveTumblerRoll === 'function' && hasActiveTumblerRoll()),
    mediaPlaying: Boolean(mediaState && mediaState.isPlaying),
    callInCall: Boolean(callState && callState.inCall),
    callRinging: Boolean(callState && callState.inCall && callState.status === 'ringing'),
    callSpeaking,
    aiPulseActive: Boolean(hasBusyAi && aiPulseUntil > now),
    isDraggingOver: Boolean(isDraggingOver),
    isDraggingVolume: Boolean(isDraggingVolume),
    shelfDragCandidate: Boolean(shelfDragCandidate)
  };
}

function isDynamicActive() {
  return computeDynamicActive(getDynamicStateSnapshot(performance.now()));
}

function requestFrame() {
  if (idleFrameTimeout) {
    clearTimeout(idleFrameTimeout);
    idleFrameTimeout = null;
  }
  if (isHiddenByGameMode()) {
    return;
  }
  if (!animFrameRequested) {
    animFrameRequested = true;
    requestAnimationFrame(animate);
  }
}

function animate(now) {
  animFrameRequested = false;
  if (idleFrameTimeout) {
    clearTimeout(idleFrameTimeout);
    idleFrameTimeout = null;
  }
  const rawDt = Math.max(0, (now - lastTime) / 1000);
  // Prevent first waking frame after 0 FPS idle sleep from jumping 50ms in one step
  const dt = rawDt > 0.06 ? (1 / 120) : Math.min(rawDt, 0.05);
  lastTime = now;
  currentDt = dt;

  // Clock / Timer / Stopwatch / Focus Real-Time Ticking (uncapped elapsed time)
  if (timerRunning) {
    timerRemainingSec = Math.max(0, timerRemainingSec - rawDt);
    if (timerRemainingSec <= 0) {
      timerRemainingSec = 0;
      timerRunning = false;
      soundFX.play('timer_done');
    }
  }
  if (stopwatchRunning) {
    stopwatchElapsedMs += rawDt * 1000;
  }
  if (focusRunning) {
    focusRemainingSec = Math.max(0, focusRemainingSec - rawDt);
    if (focusRemainingSec <= 0) {
      if (focusMode === 'work') {
        focusSessionsCompleted++;
        focusMode = (focusSessionsCompleted % 4 === 0) ? 'long_break' : 'short_break';
        focusRemainingSec = (focusMode === 'long_break') ? 15 * 60 : focusBreakDurationMin * 60;
      } else {
        focusMode = 'work';
        focusRemainingSec = focusWorkDurationMin * 60;
      }
    }
  }

  // Real-time Alarm Check
  const currentDate = new Date();
  const curHours = currentDate.getHours();
  const curMins = currentDate.getMinutes();
  const curSecs = currentDate.getSeconds();
  const todayKey = currentDate.toISOString().slice(0, 10);

  if (curSecs <= 2 && alarmsList && alarmsList.length > 0 && !activeAlarmRinging) {
    for (let i = 0; i < alarmsList.length; i++) {
      const al = alarmsList[i];
      if (!al.enabled) continue;
      let alHour24 = al.hour % 12;
      if (al.ampm === 'PM') alHour24 += 12;
      if (curHours === alHour24 && curMins === al.minute && al.lastTriggeredDate !== todayKey) {
        al.lastTriggeredDate = todayKey;
        saveAlarms();
        triggerAlarm(al);
        break;
      }
    }
  }

  if (isHiddenByGameMode()) {
    try { render(); } catch (err) {}
    return;
  }

  // Normalized linear progress step fed into easeOpenCloseBack (~340ms open, ~280ms close at 1.0x)
  const reducedMotion = isReducedMotionActive();
  if (Math.abs(targetProgress - animProgress) > 0.001) {
    isCapsuleOpening = targetProgress >= animProgress;
  }
  const openCloseDuration = targetProgress > animProgress ? 0.34 : 0.28;
  const progressStep = (dt / openCloseDuration) * animSpeedMultiplier;
  if (reducedMotion || Math.abs(targetProgress - animProgress) <= progressStep) {
    animProgress = targetProgress;
  } else {
    animProgress += Math.sign(targetProgress - animProgress) * progressStep;
  }

  // Peek-hide / reveal animation (~220ms hide into lump, ~260ms reveal at 1.0x)
  const wantHiddenNow = isShouldBeHidden();
  const targetHide = wantHiddenNow ? 1.0 : 0.0;
  if (Math.abs(targetHide - hideProgress) > 0.002) {
    isPeekHidingDir = targetHide >= hideProgress;
  }
  const hideDuration = targetHide > hideProgress ? 0.22 : 0.26;
  const hideStep = (dt / hideDuration) * animSpeedMultiplier;
  if (reducedMotion || Math.abs(targetHide - hideProgress) <= hideStep) {
    hideProgress = targetHide;
  } else {
    hideProgress += Math.sign(targetHide - hideProgress) * hideStep;
  }

  // Sound FX expansion state tracking
  if (lastAnimState === 'resting' && targetProgress > 0.4 && animProgress > 0.06) {
    lastAnimState = 'expanded';
    soundFX.play('expand');
  } else if (lastAnimState === 'expanded' && targetProgress < 0.2 && animProgress < 0.28) {
    lastAnimState = 'resting';
    soundFX.play('collapse');
  }

  // Smooth Dynamic Spring transition for resting pill width
  const targetRestW = getTargetRestingWidth();
  const restSpeed = (targetRestW > currentRestingWidth ? 8.5 : 7.0) * animSpeedMultiplier;
  if (reducedMotion || Math.abs(targetRestW - currentRestingWidth) <= 0.5) {
    currentRestingWidth = targetRestW;
  } else {
    currentRestingWidth += (targetRestW - currentRestingWidth) * (1 - Math.exp(-restSpeed * dt));
  }

  // Song Announcement Downward Popup Spring & Hover Tracking
  const isHoveredOverPopup = (songPopupProgress > 0.05 || songPopupActiveUntil > now) && mouseX >= 0 && mouseY >= 0 && pointInRect(mouseX, mouseY, (window.innerWidth - getTargetWidth(animProgress)) / 2 - 8, (displayMode === 'notch' ? 0 : 8) - 4, getTargetWidth(animProgress) + 16, getTargetHeight(animProgress) + 16);
  if (isHoveredOverPopup) {
    hoveredDuringSongPopup = true;
  }
  const isSongPopupActive = songPopupActiveUntil > now && animProgress < 0.2;
  const targetSongPopupProgress = isSongPopupActive ? 1.0 : 0.0;
  if (Math.abs(targetSongPopupProgress - songPopupProgress) > 0.002) {
    isSongPopupOpening = targetSongPopupProgress >= songPopupProgress;
  }
  const songDuration = targetSongPopupProgress > songPopupProgress ? 0.30 : 0.26;
  const songStep = (dt / songDuration) * animSpeedMultiplier;
  if (reducedMotion || Math.abs(targetSongPopupProgress - songPopupProgress) <= songStep) {
    songPopupProgress = targetSongPopupProgress;
  } else {
    songPopupProgress += Math.sign(targetSongPopupProgress - songPopupProgress) * songStep;
  }

  // Auto-collapse notification banner after 4s unless hovered
  if (currentView === 'notification_banner' && notificationBannerUntil > 0 && now > notificationBannerUntil) {
    const curW = getTargetWidth(animProgress);
    const curH = getTargetHeight(animProgress);
    const curX = (window.innerWidth - curW) / 2;
    const curY = displayMode === 'notch' ? 0 : 8;
    const isBannerHovered = mouseX >= 0 && mouseY >= 0 && pointInRect(mouseX, mouseY, curX - 4, curY - 4, curW + 8, curH + 8);
    if (!isBannerHovered) {
      notificationBannerUntil = 0;
      targetProgress = 0.0;
      currentView = 'home';
      activeNotification = null;
    } else {
      // Check again shortly if user stops hovering notification banner
      notificationBannerUntil = now + 600;
    }
  }

  // Liquid spring transition for expanded view height
  const targetExpH = getTargetExpandedHeightForView(currentView);
  if (reducedMotion || animProgress < 0.05) {
    currentExpandedH = targetExpH;
  } else {
    currentExpandedH = computeLiquidHeightStep(currentExpandedH, targetExpH, dt, animSpeedMultiplier);
  }

  // Send window size updates to Electron Main (only on bounds change)
  const currentHeight = getTargetHeight(animProgress);
  const currentWidth = getTargetWidth(animProgress);
  const roundedW = Math.round(currentWidth);
  const roundedH = Math.round(currentHeight);
  if (roundedW !== lastSentW || roundedH !== lastSentH) {
    lastSentW = roundedW;
    lastSentH = roundedH;
    ipcRenderer.send('window-bounds-update', {
      width: roundedW,
      height: roundedH
    });
  }

  try {
    render();
  } catch (err) {
    console.error('Render error:', err);
  }

  const snap = getDynamicStateSnapshot(now);
  if (computeDynamicActive(snap)) {
    requestFrame();
  } else {
    const wakeDelay = getNextIdleWakeDelayMs(snap);
    if (wakeDelay !== null) {
      idleFrameTimeout = setTimeout(requestFrame, wakeDelay);
    }
  }
}

window.addEventListener('wheel', (e) => {
  if (currentView === 'media') {
    if (hoveredButtonId === 'media_volume_slider' || hoveredButtonId === 'media_volume_mute') {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.03 : -0.03;
      currentVolume = Math.max(0, Math.min(1, currentVolume + delta));
      isVolumeMuted = false;
      ipcRenderer.send('set-media-volume', { val: currentVolume, app: getMediaAppHint() });
    }
  } else if (currentView === 'clock' && clockSubMode === 'timer') {
    const delta = e.deltaY < 0 ? 1 : -1;
    if (hoveredButtonId === 'timer_col_h' || hoveredButtonId === 'timer_inc_h' || hoveredButtonId === 'timer_dec_h') {
      e.preventDefault();
      adjustTimerHours(delta);
    } else if (hoveredButtonId === 'timer_col_m' || hoveredButtonId === 'timer_inc_m' || hoveredButtonId === 'timer_dec_m') {
      e.preventDefault();
      adjustTimerMins(delta);
    } else if (hoveredButtonId === 'timer_col_s' || hoveredButtonId === 'timer_inc_s' || hoveredButtonId === 'timer_dec_s') {
      e.preventDefault();
      adjustTimerSecs(delta);
    } else if (hoveredButtonId && hoveredButtonId.startsWith('timer_')) {
      e.preventDefault();
      adjustTimerMins(delta);
    }
  } else if (currentView === 'clock' && clockSubMode === 'alarm') {
    const delta = e.deltaY < 0 ? 1 : -1;
    if (hoveredButtonId === 'alarm_col_h' || hoveredButtonId === 'alarm_inc_h' || hoveredButtonId === 'alarm_dec_h') {
      e.preventDefault();
      alarmPickerHour = ((alarmPickerHour - 1 + delta + 12) % 12) + 1;
      soundFX.play('tap');
    } else if (hoveredButtonId === 'alarm_col_m' || hoveredButtonId === 'alarm_inc_m' || hoveredButtonId === 'alarm_dec_m') {
      e.preventDefault();
      alarmPickerMinute = (alarmPickerMinute + delta + 60) % 60;
      soundFX.play('tap');
    }
  }
}, { passive: false });

requestFrame();

['mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'focus', 'wheel'].forEach(evt => {
  window.addEventListener(evt, requestFrame, { passive: true });
});

function sanitizeProjectName(raw) {
  if (!raw) return 'Island';
  let str = String(raw).replace(/[\r\n\t\\]+/g, ' ').trim();
  if (/^(are\s+you|can\s+you|could\s+you|please|fix|make|add|what|how|i\s+want|why|do\s+you)\b/i.test(str) || str.endsWith('…') || str.endsWith('...') || str.length > 22) {
    return 'Island';
  }
  return str || 'Island';
}

function getAiCapsuleLabel(activeProjects) {
  const projs = activeProjects || getActiveProjects();
  const activeProjs = projs.filter(p => ['running', 'thinking', 'waiting'].includes(p.status));
  if (activeProjs.length > 1) {
    return `${activeProjs.length} running`;
  }
  const active = activeProjs[0] || projs[0];
  const raw = (active && active.project && active.project !== 'Antigravity') ? String(active.project) : ((active && active.task) ? String(active.task) : 'Island');
  return sanitizeProjectName(raw);
}

function getActiveProjects() {
  if (antigravityState && antigravityState.projects && Array.isArray(antigravityState.projects) && antigravityState.projects.length > 0) {
    return antigravityState.projects;
  }
  return [antigravityState || { status: 'idle', phase: 'Ready', project: 'Antigravity' }];
}

function hasActiveAgent() {
  const projs = getActiveProjects();
  return projs.some(p => ['running', 'thinking', 'waiting'].includes(p.status)) || pendingPrompt !== null;
}

function truncateToWidth(text, maxW, font) {
  if (!text) return '';
  ctx.save();
  if (font) ctx.font = font;
  if (ctx.measureText(text).width <= maxW) {
    ctx.restore();
    return text;
  }
  let str = text;
  while (str.length > 0 && ctx.measureText(str + '...').width > maxW) {
    str = str.slice(0, -1);
  }
  ctx.restore();
  return str.trim() ? str.trim() + '...' : '...';
}

function getTargetRestingWidth() {
  tickLyrics();

  const hasMedia = mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing';
  let mainPillW = UI.REST_W;
  const MAX_LYRIC_PILL_W = 760;
  const mediaChromeW = (batteryState && batteryState.hasBattery) ? 178 : 148;

  // Active timer renders in a detached right island, so the main clock pill stays compact
  if (hasMedia) {
    const roll = getPillRollingLyric();
    let textToMeasure = '';
    if (roll && roll.text) {
      if (dynamicLyricsEnabled && !liteModeEnabled && roll.progressive && roll.progressive.words && roll.progressive.words.length > 1) {
        const prog = roll.progressive;
        const words = prog.words;
        const activeIdx = prog.activeWordIndex;
        const prevWords = words.slice(0, activeIdx).map(w => w.text).join(' ');
        const curWords = words.slice(0, activeIdx + 1).map(w => w.text).join(' ');
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        const wPrev = prevWords ? ctx.measureText(prevWords).width : 0;
        const wCur = ctx.measureText(curWords).width;
        ctx.restore();
        const interpW = wPrev + (wCur - wPrev) * easeOutQuad(prog.subWordProgress);
        mainPillW = Math.max(220, Math.min(MAX_LYRIC_PILL_W, Math.round(mediaChromeW + interpW)));
      } else if (roll.previous && roll.k < 1) {
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        const w1 = ctx.measureText(roll.text).width;
        const w2 = ctx.measureText(roll.previous).width;
        ctx.restore();
        const maxW = Math.max(w1, w2);
        mainPillW = Math.max(220, Math.min(MAX_LYRIC_PILL_W, Math.round(mediaChromeW + maxW)));
      } else {
        textToMeasure = roll.text;
        ctx.save();
        ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
        const textW = ctx.measureText(textToMeasure).width;
        ctx.restore();
        mainPillW = Math.max(220, Math.min(MAX_LYRIC_PILL_W, Math.round(mediaChromeW + textW)));
      }
    } else {
      textToMeasure = (mediaState.track.title || '').trim();
      ctx.save();
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      const textW = ctx.measureText(textToMeasure).width;
      ctx.restore();
      mainPillW = Math.max(220, Math.min(MAX_LYRIC_PILL_W, Math.round(mediaChromeW + textW)));
    }
  } else {
    const timeStr = formatClockTime(new Date(), { clock24h, showSeconds, showAmPm });
    ctx.save();
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    const timeW = ctx.measureText(timeStr).width;
    ctx.restore();
    if (batteryState && batteryState.hasBattery) {
      mainPillW = Math.max(134, Math.round(timeW + 84));
    } else {
      mainPillW = Math.max(66, Math.round(timeW + 26));
    }
  }

  // Main resting pill stays strictly centered without displacement
  return Math.max(66, Math.min(860, mainPillW));
}

function getRestingWidth() {
  return currentRestingWidth;
}

function getNotificationBannerWidth() {
  if (!activeNotification) return 360;
  const appText = String(activeNotification.app || 'Notification');
  const titleText = String(activeNotification.title || activeNotification.body || 'New Notification');
  const bodyText = (activeNotification.title && activeNotification.body) ? String(activeNotification.body) : '';
  let maxTextW = 180;
  try {
    ctx.save();
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    const appW = ctx.measureText(appText).width;
    ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
    const titleW = ctx.measureText(titleText).width;
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    const bodyW = bodyText ? ctx.measureText(bodyText).width : 0;
    ctx.restore();
    maxTextW = Math.max(appW, titleW, bodyW);
  } catch (e) {}
  return Math.max(320, Math.min(440, Math.round(maxTextW + 108)));
}

function getTargetWidth(p) {
  const restW = getRestingWidth();
  const e = easeOpenCloseBack(p, isCapsuleOpening, 0.85);
  const expandedTargetW = (currentView === 'notification_banner') ? getNotificationBannerWidth() : UI.EXPANDED_W;
  const normalW = Math.max(44, restW + (expandedTargetW - restW) * e);
  if (songPopupProgress > 0.001 && p < 0.2) {
    const popK = easeOpenCloseBack(songPopupProgress, isSongPopupOpening, 0.85);
    const targetW = displayMode === 'notch' ? UI.EXPANDED_W : SONG_POPUP_WIDTH;
    return Math.max(44, normalW + (targetW - normalW) * popK);
  }
  return normalW;
}

function getTargetExpandedHeightForView(view) {
  return getTargetExpandedHeight(view, {
    activeAlarmRinging,
    clockSubMode,
    alarmsCount: (alarmsList && alarmsList.length) || 0,
    projectCount: getActiveProjects().length,
    liveLyricsEnabled
  });
}

function getTargetHeight(p) {
  let restH = UI.BAR_H;
  if (hasActiveAgent() || hasActiveCall() || (mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing')) {
    restH = UI.ACTIVE_BAR_H;
  }

  const expH = currentExpandedH;
  const e = easeOpenCloseBack(p, isCapsuleOpening, 0.85);
  const normalH = Math.max(20, restH + (expH - restH) * e);
  if (songPopupProgress > 0.001 && p < 0.2) {
    const popK = easeOpenCloseBack(songPopupProgress, isSongPopupOpening, 0.85);
    return Math.max(20, normalH + (SONG_POPUP_HEIGHT - normalH) * popK);
  }
  return normalH;
}

// -------------------------------------------------------------
// Organic Apple Notch & Floating Island Capsule Geometry
// Supports authentic MacBook-style concave top fillets ("ears")
// seamlessly merging with the physical top bezel
// -------------------------------------------------------------
function buildCapsulePath(c, x, y, w, h, radius, isNotch = false, topFillet = 12) {
  c.beginPath();
  if (isNotch && y <= 0.1) {
    const tr = Math.min(topFillet, h * 0.45);
    const br = Math.min(radius, Math.max(2, h - tr));
    // 1. Start on the top edge at the outer end of the left ear
    c.moveTo(x - tr, 0);
    // 2. Concave arc curving smoothly into the left vertical edge:
    //    Center at (x - tr, tr), angle -PI/2 (top) to 0 (right), clockwise
    c.arc(x - tr, tr, tr, -Math.PI / 2, 0, false);
    // 3. Left vertical edge
    c.lineTo(x, h - br);
    // 4. Bottom-left convex rounded corner
    c.arcTo(x, h, x + br, h, br);
    // 5. Bottom horizontal edge
    c.lineTo(x + w - br, h);
    // 6. Bottom-right convex rounded corner
    c.arcTo(x + w, h, x + w, h - br, br);
    // 7. Right vertical edge
    c.lineTo(x + w, tr);
    // 8. Concave arc curving smoothly out into the right ear:
    //    Center at (x + w + tr, tr), angle PI (left) to 1.5*PI (top), clockwise
    c.arc(x + w + tr, tr, tr, Math.PI, 1.5 * Math.PI, false);
    // 9. Across the top bezel back to (x - tr, 0)
    c.closePath();
  } else {
    c.roundRect(x, y, w, h, radius);
  }
}

function drawCapsuleRim(c, x, y, w, h, radius, isNotch = false, topFillet = 12) {
  c.beginPath();
  if (isNotch && y <= 0.1) {
    const tr = Math.min(topFillet, h * 0.45);
    const br = Math.min(radius, Math.max(2, h - tr));
    // Start at top-left ear
    c.moveTo(x - tr, 0);
    // Concave arc to left edge
    c.arc(x - tr, tr, tr, -Math.PI / 2, 0, false);
    // Left edge
    c.lineTo(x, h - br);
    // Bottom-left corner
    c.arcTo(x, h, x + br, h, br);
    // Bottom edge
    c.lineTo(x + w - br, h);
    // Bottom-right corner
    c.arcTo(x + w, h, x + w, h - br, br);
    // Right edge
    c.lineTo(x + w, tr);
    // Concave arc to top-right ear
    c.arc(x + w + tr, tr, tr, Math.PI, 1.5 * Math.PI, false);
    // Note: Do NOT stroke across y=0 so it remains completely flush with the physical screen bezel!
  } else {
    c.roundRect(x, y, w, h, radius);
  }
}

const shadowSpriteCache = new Map();

function traceShadowShapePath(c, sx, sy, sw, sh, radius, topRadius, bottomRadius, useBezelLump, topFillet) {
  if (useBezelLump) {
    buildCapsulePath(c, sx, sy, sw, sh, bottomRadius !== undefined ? bottomRadius : radius, true, topFillet);
  } else if (Array.isArray(radius)) {
    c.beginPath();
    c.roundRect(sx, sy, sw, sh, radius);
  } else if (topRadius !== undefined && bottomRadius !== undefined) {
    c.beginPath();
    c.roundRect(sx, sy, sw, sh, [topRadius, topRadius, bottomRadius, bottomRadius]);
  } else {
    c.beginPath();
    c.roundRect(sx, sy, sw, sh, radius);
  }
}

let morphShadowScratch = null;

function drawBlurredCapsuleShadow(targetCtx, opts) {
  const {
    x,
    y,
    w,
    h,
    radius = 16,
    topRadius,
    bottomRadius,
    topFillet = 12,
    useBezelLump = false,
    blur = 14,
    offsetY = 4,
    color = 'rgba(0, 0, 0, 0.5)',
    preferSprite = true
  } = opts;
  if (liteModeEnabled || w <= 0 || h <= 0) return;

  if (typeof document === 'undefined' || !document.createElement) return;

  const rw = Math.round(w);
  const rh = Math.round(h);
  const blurPad = Math.ceil(blur * 2 + 6);
  const earPad = useBezelLump ? Math.ceil(topFillet + 2) : 0;
  const padX = blurPad + earPad;
  const padTop = useBezelLump ? 0 : blurPad;
  const padBottom = blurPad + Math.ceil(Math.max(0, offsetY));
  const cw = Math.max(1, rw + padX * 2);
  const ch = Math.max(1, rh + padTop + padBottom);

  const renderShadowToCanvas = (oc) => {
    const octx = oc.getContext('2d');
    if (!octx) return;
    octx.clearRect(0, 0, oc.width, oc.height);
    octx.save();
    octx.shadowColor = color;
    octx.shadowBlur = blur;
    octx.shadowOffsetY = offsetY;
    traceShadowShapePath(octx, padX, padTop, rw, rh, radius, topRadius, bottomRadius, useBezelLump, topFillet);
    octx.fillStyle = '#000000';
    octx.fill();
    octx.restore();

    // Cut out exact inner shape so semi-transparent glass never shows dark shadow underfill
    octx.save();
    octx.globalCompositeOperation = 'destination-out';
    traceShadowShapePath(octx, padX, padTop, rw, rh, radius, topRadius, bottomRadius, useBezelLump, topFillet);
    octx.fillStyle = '#000000';
    octx.fill();
    octx.restore();
  };

  if (!preferSprite) {
    if (!morphShadowScratch) {
      morphShadowScratch = document.createElement('canvas');
    }
    if (morphShadowScratch.width < cw || morphShadowScratch.height < ch) {
      morphShadowScratch.width = Math.max(morphShadowScratch.width, cw);
      morphShadowScratch.height = Math.max(morphShadowScratch.height, ch);
    }
    renderShadowToCanvas(morphShadowScratch);
    targetCtx.drawImage(morphShadowScratch, 0, 0, cw, ch, x - padX, useBezelLump ? 0 : (y - padTop), cw, ch);
    return;
  }

  const rKey = Array.isArray(radius) ? radius.map(v => Math.round(v)).join(',') : Math.round(radius);
  const key = `${useBezelLump ? 1 : 0}:${rw}:${rh}:${rKey}:${Math.round(topRadius || 0)}:${Math.round(bottomRadius || 0)}:${Math.round(topFillet)}:${Math.round(blur)}:${Math.round(offsetY)}:${color}`;

  let entry = shadowSpriteCache.get(key);
  if (!entry) {
    const oc = document.createElement('canvas');
    oc.width = cw;
    oc.height = ch;
    renderShadowToCanvas(oc);
    if (shadowSpriteCache.size >= 24) {
      const oldestKey = shadowSpriteCache.keys().next().value;
      shadowSpriteCache.delete(oldestKey);
    }
    entry = { canvas: oc, padX, padTop };
    shadowSpriteCache.set(key, entry);
  }

  targetCtx.drawImage(entry.canvas, x - entry.padX, useBezelLump ? 0 : (y - entry.padTop));
}

function getLiquidGlassTokens(enabled = liquidGlassEnabled) {
  if (!enabled) {
    return {
      enabled: false,
      cardBg: 'rgba(255, 255, 255, 0.055)',
      cardBgHover: 'rgba(255, 255, 255, 0.11)',
      cardBorder: 'rgba(255, 255, 255, 0.09)',
      navPillBg: 'rgba(255, 255, 255, 0.14)',
      navPillBorder: 'rgba(255, 255, 255, 0.16)'
    };
  }
  return {
    enabled: true,
    cardBg: 'rgba(255, 255, 255, 0.12)',
    cardBgHover: 'rgba(255, 255, 255, 0.20)',
    cardBorder: 'rgba(255, 255, 255, 0.28)',
    navPillBg: 'rgba(255, 255, 255, 0.22)',
    navPillBorder: 'rgba(255, 255, 255, 0.36)'
  };
}

function paintCapsuleSurface(c, {
  x, y, w, h,
  radius,
  topRadius,
  bottomRadius,
  topFillet = 12,
  useBezelLump = false,
  rimColor = 'rgba(255, 255, 255, 0.14)',
  forceSemanticRim = false,
  forcePureBlack = false,
  accentTintColor = null,
  accentTintPalette = null,
  accentTintStrength = 0,
  p = 0
}) {
  const tracePath = () => {
    if (useBezelLump) {
      buildCapsulePath(c, x, y, w, h, radius, true, topFillet);
    } else if (topRadius !== undefined && bottomRadius !== undefined) {
      c.beginPath();
      c.roundRect(x, y, w, h, [topRadius, topRadius, bottomRadius, bottomRadius]);
    } else {
      c.beginPath();
      c.roundRect(x, y, w, h, radius);
    }
  };

  const traceRim = () => {
    if (useBezelLump) {
      drawCapsuleRim(c, x, y, w, h, radius, true, topFillet);
    } else if (topRadius !== undefined && bottomRadius !== undefined) {
      c.beginPath();
      c.roundRect(x, y, w, h, [topRadius, topRadius, bottomRadius, bottomRadius]);
    } else {
      c.beginPath();
      c.roundRect(x, y, w, h, radius);
    }
  };

  if (forcePureBlack || liteModeEnabled) {
    tracePath();
    c.fillStyle = '#000000';
    c.fill();
    traceRim();
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    c.stroke();
    return;
  }

  const palette = (Array.isArray(accentTintPalette) && accentTintPalette.length > 0)
    ? accentTintPalette
    : (accentTintColor ? [accentTintColor] : null);

  if (!liquidGlassEnabled) {
    const grad = c.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0.0, `rgba(16, 16, 20, ${islandOpacity})`);
    grad.addColorStop(0.5, `rgba(8, 8, 10, ${islandOpacity})`);
    grad.addColorStop(1.0, `rgba(2, 2, 4, ${islandOpacity})`);

    c.save();
    tracePath();
    c.fillStyle = grad;
    c.fill();
    if (accentTintStrength > 0.05 && palette) {
      c.clip();
      const c0 = palette[0];
      const c1 = palette[1] || c0;
      const c2 = palette[2] || c1;
      const artGrad = c.createLinearGradient(x, y, x + w, y + h);
      artGrad.addColorStop(0.0, colorWithAlpha(c0, 0.38 * accentTintStrength));
      artGrad.addColorStop(0.5, colorWithAlpha(c1, 0.28 * accentTintStrength));
      artGrad.addColorStop(1.0, colorWithAlpha(c2, 0.24 * accentTintStrength));
      c.fillStyle = artGrad;
      c.fillRect(x - 24, y, w + 48, h);
    }
    c.restore();

    traceRim();
    c.lineWidth = 1;
    c.strokeStyle = rimColor;
    c.stroke();
    return;
  }

  // Apple-inspired Liquid Glass Mode: deeply frosted translucent glass, micro-grain diffusion, album palette gradient, internal sheen, cursor bloom, and luminous rim
  const glassFactor = 0.72 + 0.16 * Math.max(0, Math.min(1, p));
  const baseGlassAlpha = Math.max(0.62, Math.min(0.90, islandOpacity * glassFactor));
  const bodyGrad = c.createLinearGradient(x, y, x, y + h);
  bodyGrad.addColorStop(0.0, `rgba(42, 48, 64, ${Math.min(0.92, baseGlassAlpha * 0.96)})`);
  bodyGrad.addColorStop(0.42, `rgba(18, 22, 32, ${baseGlassAlpha})`);
  bodyGrad.addColorStop(1.0, `rgba(11, 14, 22, ${Math.min(0.94, baseGlassAlpha * 1.04)})`);

  c.save();
  tracePath();
  c.fillStyle = bodyGrad;
  c.fill();
  c.clip();

  // Frosted milky diffusion veil so underlying icons/text stay soft and readable
  c.fillStyle = 'rgba(220, 232, 248, 0.075)';
  c.fillRect(x - 24, y, w + 48, h);

  // Cached 64x64 frosted micro-grain texture (zero per-frame alloc)
  if (!paintCapsuleSurface._frostPattern && typeof document !== 'undefined' && document.createElement) {
    try {
      const fc = document.createElement('canvas');
      fc.width = 64;
      fc.height = 64;
      const fctx = fc.getContext('2d');
      if (fctx) {
        const img = fctx.createImageData(64, 64);
        let seed = 1337;
        for (let i = 0; i < img.data.length; i += 4) {
          seed = (seed * 16807) % 2147483647;
          const v = 180 + (seed % 75);
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = 14 + (seed % 12);
        }
        fctx.putImageData(img, 0, 0);
        paintCapsuleSurface._frostPattern = c.createPattern(fc, 'repeat');
      }
    } catch (e) {}
  }
  if (paintCapsuleSurface._frostPattern) {
    c.fillStyle = paintCapsuleSurface._frostPattern;
    c.fillRect(x - 24, y, w + 48, h);
  }

  if (accentTintStrength > 0.05 && palette) {
    const c0 = palette[0];
    const c1 = palette[1] || c0;
    const c2 = palette[2] || c1;
    const tintGrad = c.createLinearGradient(x, y, x + w, y + h);
    tintGrad.addColorStop(0.0, colorWithAlpha(c0, 0.42 * accentTintStrength));
    tintGrad.addColorStop(0.5, colorWithAlpha(c1, 0.30 * accentTintStrength));
    tintGrad.addColorStop(1.0, colorWithAlpha(c2, 0.26 * accentTintStrength));
    c.fillStyle = tintGrad;
    c.fillRect(x - 24, y, w + 48, h);
  }

  // Top specular lip reflection
  const topSheenH = Math.min(34, Math.max(12, h * 0.42));
  const topSheen = c.createLinearGradient(x, y, x, y + topSheenH);
  topSheen.addColorStop(0.0, 'rgba(255, 255, 255, 0.26)');
  topSheen.addColorStop(0.55, 'rgba(255, 255, 255, 0.06)');
  topSheen.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  c.fillStyle = topSheen;
  c.fillRect(x - 24, y, w + 48, topSheenH);

  // Bottom bounce reflection
  const botSheenH = Math.min(24, Math.max(8, h * 0.28));
  const botSheen = c.createLinearGradient(x, y + h - botSheenH, x, y + h);
  botSheen.addColorStop(0.0, 'rgba(255, 255, 255, 0.0)');
  botSheen.addColorStop(1.0, 'rgba(255, 255, 255, 0.10)');
  c.fillStyle = botSheen;
  c.fillRect(x - 24, y + h - botSheenH, w + 48, botSheenH);

  // Light-reactive cursor bloom
  if (mouseX >= x - 60 && mouseX <= x + w + 60 && mouseY >= y - 20 && mouseY <= y + h + 40) {
    const bloomR = Math.max(75, Math.min(180, w * 0.42));
    const bloom = c.createRadialGradient(mouseX, mouseY, 2, mouseX, mouseY, bloomR);
    bloom.addColorStop(0.0, 'rgba(255, 255, 255, 0.18)');
    bloom.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
    bloom.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    c.fillStyle = bloom;
    c.fillRect(x - 24, y, w + 48, h);
  }
  c.restore();

  // Luminous diagonal specular glass rim (subtly tinted by album palette when active)
  c.save();
  traceRim();
  const rimGrad = c.createLinearGradient(x, y, x + w * 0.45, y + h);
  if (accentTintStrength > 0.05 && palette) {
    const c0 = palette[0];
    const c1 = palette[1] || c0;
    rimGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.68)');
    rimGrad.addColorStop(0.4, colorWithAlpha(c0, 0.55 * accentTintStrength));
    rimGrad.addColorStop(0.8, colorWithAlpha(c1, 0.40 * accentTintStrength));
    rimGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.45)');
  } else {
    rimGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.72)');
    rimGrad.addColorStop(0.35, 'rgba(255, 255, 255, 0.28)');
    rimGrad.addColorStop(0.7, 'rgba(255, 255, 255, 0.16)');
    rimGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.45)');
  }
  c.lineWidth = 1.25;
  c.strokeStyle = forceSemanticRim ? rimColor : rimGrad;
  c.stroke();
  c.restore();
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  interactiveButtons = [];

  if (gameModeEnabled && isGameModeFullscreen && !gameModeOpenedAnyway && !pendingPrompt) {
    return;
  }

  if (pendingPrompt && isTucked) {
    setTucked(false);
  }

  const p = Math.max(0, Math.min(1, animProgress));
  const normalW = getTargetWidth(p);
  const normalH = getTargetHeight(p);
  const isNotch = displayMode === 'notch';
  const normalY = isNotch ? 0 : 8; // Flush with top for notch, floating for island
  const normalRadius = UI.COMPACT_RADIUS + (UI.EXPANDED_RADIUS - UI.COMPACT_RADIUS) * p;
  const normalTopFillet = Math.round(10 + 4 * p);

  const hideT = computeCapsuleHideTransform({
    hideProgress,
    normalW,
    normalH,
    normalY,
    normalRadius,
    normalTopFillet,
    isNotch,
    isHiding: isPeekHidingDir
  });

  const w = hideT.w;
  const h = hideT.h;
  const x = (window.innerWidth - w) / 2;
  const y = hideT.y;
  const radius = hideT.bottomRadius;
  const topFillet = hideT.topFillet;
  const useBezelLump = isNotch || y <= 0.15;

  const traceCapsulePath = () => {
    if (useBezelLump) {
      buildCapsulePath(ctx, x, y, w, h, radius, true, topFillet);
    } else {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [hideT.topRadius, hideT.topRadius, hideT.bottomRadius, hideT.bottomRadius]);
    }
  };

  const traceCapsuleRim = () => {
    if (useBezelLump) {
      drawCapsuleRim(ctx, x, y, w, h, radius, true, topFillet);
    } else {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [hideT.topRadius, hideT.topRadius, hideT.bottomRadius, hideT.bottomRadius]);
    }
  };

  const unifiedAlpha = 1.0;

  if (unifiedAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = unifiedAlpha;

    // 1. Ambient Drop Shadow (cached offscreen blur when settled, zero-blur silhouette when morphing)
    const hasMediaTrack = mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing';
    const wantTint = (albumColorGradientEnabled && !liteModeEnabled && hasMediaTrack && hideProgress < 0.5) ? 1.0 : 0.0;
    const tintStep = 1 - Math.exp(-10.0 * currentDt);
    if (Math.abs(wantTint - tintK) <= 0.004) {
      tintK = wantTint;
    } else {
      tintK += (wantTint - tintK) * tintStep;
    }

    let shadowCol = 'rgba(0, 0, 0, 0.55)';
    let shadowBlurVal = 18 + 14 * p;
    let shadowOffY = 6 + 6 * p;
    if (hideProgress > 0.55) {
      shadowCol = 'rgba(0, 0, 0, 0.45)';
      shadowBlurVal = 8;
      shadowOffY = 2;
    } else if (tintK > 0.05 && albumAccentColor) {
      shadowCol = colorWithAlpha(albumAccentColor, 0.45 * tintK);
      shadowBlurVal = (18 + 14 * p) + (tintK * 12);
      shadowOffY = 6 + 6 * p;
    }

    const wantSongPop = (songPopupActiveUntil > performance.now() && animProgress < 0.2) ? 1.0 : 0.0;
    const isCapsuleMorphing =
      Math.abs(targetProgress - animProgress) > 0.005 ||
      Math.abs((isShouldBeHidden() ? 1.0 : 0.0) - hideProgress) > 0.005 ||
      Math.abs(getTargetRestingWidth() - currentRestingWidth) > 1.0 ||
      (animProgress > 0.05 && Math.abs(getTargetExpandedHeightForView(currentView) - currentExpandedH) > 1.0) ||
      Math.abs(wantSongPop - songPopupProgress) > 0.005 ||
      Math.abs(wantTint - tintK) > 0.01;

    drawBlurredCapsuleShadow(ctx, {
      x,
      y,
      w,
      h,
      radius,
      topRadius: hideT.topRadius,
      bottomRadius: hideT.bottomRadius,
      topFillet,
      useBezelLump,
      blur: shadowBlurVal,
      offsetY: shadowOffY,
      color: shadowCol,
      preferSprite: !isCapsuleMorphing
    });

    // 2. Capsule Surface & Specular Rim (OLED Black or Liquid Glass)
    let rimCol = `rgba(255, 255, 255, ${0.12 + 0.12 * p})`;
    let forceSemanticRim = false;
    if (isDraggingOver) {
      rimCol = 'rgba(59, 130, 246, 0.85)';
      forceSemanticRim = true;
    } else if (hideProgress > 0.45) {
      if (isLumpHovered) {
        rimCol = 'rgba(255, 255, 255, 0.40)';
      } else if (hasActiveCall()) {
        rimCol = 'rgba(249, 115, 22, 0.55)';
        forceSemanticRim = true;
      } else if (hasActiveAgent()) {
        const projs = getActiveProjects();
        rimCol = projs.some(pr => pr.status === 'waiting') ? 'rgba(245, 158, 11, 0.50)' : 'rgba(56, 189, 248, 0.45)';
        forceSemanticRim = true;
      } else {
        rimCol = 'rgba(255, 255, 255, 0.22)';
      }
    } else if (tintK > 0.05 && albumAccentColor) {
      rimCol = colorWithAlpha(albumAccentColor, 0.55 * tintK + 0.15);
    }

    paintCapsuleSurface(ctx, {
      x,
      y,
      w,
      h,
      radius,
      topRadius: hideT.topRadius,
      bottomRadius: hideT.bottomRadius,
      topFillet,
      useBezelLump,
      rimColor: rimCol,
      forceSemanticRim,
      forcePureBlack: currentView === 'notification_banner' && p > 0.15,
      accentTintColor: albumAccentColor,
      accentTintPalette: albumPalette,
      accentTintStrength: tintK,
      p
    });

    ctx.restore();
  }

  // 4. Render Views (with individual clipping for expanded view & song announcement)
  if (p < 0.32) {
    const restAlpha = Math.max(0, (0.32 - p) / 0.32);
    if (songPopupProgress > 0.05) {
      ctx.save();
      traceCapsulePath();
      ctx.clip();
      renderSongAnnouncementPopup(x, y, w, h, restAlpha);
      ctx.restore();
    } else {
      if (hideT.contentAlpha > 0.02) {
        ctx.save();
        traceCapsulePath();
        ctx.clip();
        renderRestingPill(x, y + hideT.contentOffsetY, w, h, restAlpha * hideT.contentAlpha);
        ctx.restore();
      }

      if (hideT.sideAlpha > 0.02) {
        renderDetachedSideIslands(x, y + hideT.sideOffsetY, w, h, restAlpha * hideT.sideAlpha);
      }
    }
  }
  if (p > 0.15) {
    ctx.save();
    traceCapsulePath();
    ctx.clip();
    const alpha = Math.max(0, Math.min(1.0, (p - 0.15) / 0.85));
    renderExpandedView(x, y, w, h, alpha);

    // Inner Capsule Modal Dimmer (isolated strictly to the Island capsule)
    if (isInlineModalOpen) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
      ctx.fillRect(x - topFillet, y, w + topFillet * 2, h);
    }
    ctx.restore();
  }

  // 5. Game Mode Toast / Status Notification
  if (gameModeToastUntil > performance.now() && gameModeToastText) {
    const remainMs = gameModeToastUntil - performance.now();
    const toastAlpha = Math.min(1, remainMs / 300);
    const toastW = 240;
    const toastH = 28;
    const toastX = (window.innerWidth - toastW) / 2;
    const toastY = y + h + 10;

    ctx.save();
    ctx.globalAlpha = toastAlpha;
    drawBlurredCapsuleShadow(ctx, {
      x: toastX,
      y: toastY,
      w: toastW,
      h: toastH,
      radius: 14,
      useBezelLump: false,
      blur: 10,
      offsetY: 3,
      color: 'rgba(0, 0, 0, 0.45)',
      preferSprite: toastAlpha >= 0.99
    });

    ctx.beginPath();
    ctx.roundRect(toastX, toastY, toastW, toastH, 14);
    ctx.fillStyle = '#141418';
    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = gameModeEnabled ? 'rgba(34, 197, 94, 0.5)' : 'rgba(245, 158, 11, 0.5)';
    ctx.stroke();

    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = gameModeEnabled ? '#4ade80' : '#fbbf24';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gameModeToastText, toastX + toastW / 2, toastY + toastH / 2);
    ctx.restore();
  }
}

// -------------------------------------------------------------
// Connected Downward Song Change Announcement Popup
// -------------------------------------------------------------
function renderSongAnnouncementPopup(x, y, w, h, popAlpha) {
  ctx.save();
  ctx.globalAlpha = popAlpha;

  const isNotch = displayMode === 'notch';
  const cornerR = UI.COMPACT_RADIUS + 8;

  // 1. Subtle Ambient Radial Halo around Album Art
  if (albumAccentColor && albumAccentColor !== '#e4e4e7') {
    ctx.save();
    buildCapsulePath(ctx, x, y, w, h, cornerR, isNotch, 12);
    ctx.clip();
    const glowGrad = ctx.createRadialGradient(x + 55, y + 68, 5, x + 55, y + 68, 90);
    glowGrad.addColorStop(0.0, colorWithAlpha(albumAccentColor, 0.12 * popAlpha));
    glowGrad.addColorStop(0.6, colorWithAlpha(albumAccentColor, 0.02 * popAlpha));
    glowGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  // 2. Connected Top Bar (0 to 34px)
  const topH = 34;
  const now = new Date();
  const timeStr = formatClockTime(now, { clock24h, showSeconds, showAmPm });

  // Digital Clock on Left
  ctx.font = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#e4e4e7';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(timeStr, x + 16, y + topH / 2);
  const clockW = ctx.measureText(timeStr).width;

  // Close / Dismiss button on Top Right
  const closeBtnSize = 16;
  const closeBtnX = x + w - closeBtnSize - 14;
  const closeBtnY = y + (topH - closeBtnSize) / 2;
  const isCloseHov = pointInRect(mouseX, mouseY, closeBtnX - 4, closeBtnY - 4, closeBtnSize + 8, closeBtnSize + 8);
  interactiveButtons.push({
    id: 'song_popup_dismiss',
    x: closeBtnX - 4,
    y: closeBtnY - 4,
    w: closeBtnSize + 8,
    h: closeBtnSize + 8
  });

  ctx.save();
  ctx.beginPath();
  ctx.arc(closeBtnX + closeBtnSize / 2, closeBtnY + closeBtnSize / 2, closeBtnSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = isCloseHov ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
  ctx.fill();
  ctx.fillStyle = isCloseHov ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✕', closeBtnX + closeBtnSize / 2, closeBtnY + closeBtnSize / 2);
  ctx.restore();

  // Animated 5-Bar Audio Equalizer to the left of close button
  const eqW = 22;
  const eqX = closeBtnX - eqW - 10;
  drawEqualizer('popup_top', eqX, y + topH / 2, eqW, 11, albumAccentColor, 5);

  // Center Rolling Lyric or Title Snippet
  const roll = getPillRollingLyric();
  const lyricStartX = x + 16 + clockW + 12;
  const lyricMaxW = Math.max(30, eqX - 12 - lyricStartX);

  ctx.save();
  ctx.beginPath();
  ctx.rect(lyricStartX, y + 2, lyricMaxW, topH - 4);
  ctx.clip();
  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const lyricText = (roll && roll.text) ? roll.text : (mediaState.track ? mediaState.track.title : 'Now Playing');
  ctx.fillStyle = albumAccentColor;
  ctx.fillText('🎵', lyricStartX, y + topH / 2);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(truncateToWidth(lyricText, lyricMaxW - 18, ctx.font), lyricStartX + 18, y + topH / 2);
  ctx.restore();

  // 1px Subtle Seam between Top Bar and Announcement Body
  ctx.beginPath();
  ctx.moveTo(x + 14, y + topH);
  ctx.lineTo(x + w - 14, y + topH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 3. Lower Body Metadata & Profile Art
  const track = mediaState.track || {};
  const songTitle = (track.title || 'Unknown Title').trim();
  const songArtist = (track.artist || 'Unknown Artist').trim();
  const songAlbum = (track.album || '').trim();

  // Square Album Profile Art (68x68 rounded 10px)
  const artSize = 68;
  const artX = x + 16;
  const artY = y + 42;
  const artR = 10;

  drawBlurredCapsuleShadow(ctx, {
    x: artX,
    y: artY,
    w: artSize,
    h: artSize,
    radius: artR,
    useBezelLump: false,
    blur: 14,
    offsetY: 4,
    color: colorWithAlpha(albumAccentColor, 0.45 * popAlpha),
    preferSprite: popAlpha >= 0.99
  });

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, artR);
  ctx.clip();

  if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
    ctx.drawImage(albumImage, artX, artY, artSize, artSize);
  } else {
    const artGrad = ctx.createLinearGradient(artX, artY, artX + artSize, artY + artSize);
    artGrad.addColorStop(0.0, '#312e81');
    artGrad.addColorStop(0.5, '#4f46e5');
    artGrad.addColorStop(1.0, '#7c3aed');
    ctx.fillStyle = artGrad;
    ctx.fillRect(artX, artY, artSize, artSize);
    ctx.font = '24px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('🎵', artX + artSize / 2, artY + artSize / 2);
  }
  ctx.restore();

  // 1px Glass Rim around Album Art
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, artR);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.stroke();
  ctx.restore();

  // Right Column Stacked Metadata
  const metaX = artX + artSize + 16;
  const metaW = Math.max(40, x + w - 18 - metaX);

  // Row 1: Song Title (Bold White)
  const titleY = artY + 2;
  ctx.font = '700 13.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncateToWidth(songTitle, metaW, ctx.font), metaX, titleY);

  // Row 2: Artist (Reduced Opacity White ~70%)
  const artistY = titleY + 18;
  ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
  ctx.fillText(truncateToWidth(songArtist, metaW, ctx.font), metaX, artistY);

  // Row 3: Album (Subtle Opacity White ~45%)
  const albumY = artistY + 16;
  ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  const displayAlbum = songAlbum || 'Single';
  ctx.fillText(truncateToWidth(displayAlbum, metaW, ctx.font), metaX, albumY);

  // Row 4: Total Song Time & Live Progress Bar
  const durY = albumY + 16;
  const posMs = getLiveMediaPositionMs();
  const durMs = track.duration || mediaState.duration_ms || 0;
  const posText = formatTimeMs(posMs);
  const durText = formatTimeMs(durMs);

  ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fillText(posText, metaX, durY);
  const posW = ctx.measureText(posText).width;

  const durW = ctx.measureText(durText).width;
  ctx.fillText(durText, metaX + metaW - durW, durY);

  // Progress Bar Track
  const barX = metaX + posW + 8;
  const barW = Math.max(10, (metaX + metaW - durW - 8) - barX);
  const barH = 4;
  const barY = durY + 3.5;

  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fill();

  // Progress Bar Fill
  if (durMs > 0) {
    const k = Math.min(1.0, Math.max(0.0, posMs / durMs));
    const fillW = Math.max(barH, barW * k);
    const progGrad = ctx.createLinearGradient(barX, barY, barX + fillW, barY);
    progGrad.addColorStop(0.0, '#ec4899');
    progGrad.addColorStop(1.0, albumAccentColor || '#c084fc');

    ctx.beginPath();
    ctx.roundRect(barX, barY, fillW, barH, 2);
    ctx.fillStyle = progGrad;
    ctx.fill();
  }

  // Interactive Target to Open Media Tab
  interactiveButtons.push({ id: 'song_popup_open_media', x, y, w, h });

  ctx.restore();
}

// -------------------------------------------------------------
// Animated Word-by-Word Reveal Helper for Resting Pill Lyrics
// -------------------------------------------------------------
function drawAnimatedRestingLyric(textStartX, cy, maxTextW, roll, alpha) {
  const dist = 13;
  const prevText = roll.previous || roll.prev;
  if (prevText && roll.k < 1) {
    ctx.save();
    ctx.globalAlpha = alpha * (1 - roll.k);
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText(truncateToWidth(prevText, maxTextW, ctx.font), textStartX, cy - roll.k * dist);
    ctx.restore();
  }

  const lineY = cy + (1 - roll.k) * dist;
  const lineAlpha = alpha * roll.k;
  const prog = roll.progressive;

  if (dynamicLyricsEnabled && !liteModeEnabled && prog && Array.isArray(prog.words) && prog.words.length > 0) {
    const words = prog.words;
    let activeIdx = words.findIndex(w => w.isActive);
    if (activeIdx === -1) {
      let lastSung = -1;
      for (let i = 0; i < words.length; i++) {
        if (words[i].isSung) lastSung = i;
      }
      activeIdx = lastSung >= 0 ? lastSung : 0;
    }

    const prefixWords = words.slice(0, activeIdx).map(w => w.text);
    const prefixStr = prefixWords.length > 0 ? (prefixWords.join(' ') + ' ') : '';
    const activeWordObj = words[activeIdx] || { text: roll.text || '', progress: 1, isSung: true };
    const activeWordStr = activeWordObj.text || '';
    const fullVisibleStr = prefixStr + activeWordStr;

    const totalW = ctx.measureText(fullVisibleStr).width;
    if (totalW <= maxTextW) {
      // 1. Draw already-sung prefix words in crisp solid white
      if (prefixStr) {
        ctx.save();
        ctx.globalAlpha = lineAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(prefixStr, textStartX, lineY);
        ctx.restore();
      }

      // 2. Draw active word with horizontal gradient wipe + upward float + leading glow
      const prefixW = prefixStr ? ctx.measureText(prefixStr).width : 0;
      const activeX = textStartX + prefixW;
      const wordW = Math.max(1, ctx.measureText(activeWordStr).width);
      const subP = activeWordObj.isSung
        ? 1.0
        : Math.max(0.08, Math.min(1.0, typeof activeWordObj.progress === 'number' ? activeWordObj.progress : 1.0));
      const easeK = 1 - Math.pow(1 - subP, 3);
      const floatY = (1 - easeK) * 4.2;

      ctx.save();
      ctx.globalAlpha = lineAlpha * (0.35 + 0.65 * easeK);
      if (subP < 0.99) {
        const wipeGrad = ctx.createLinearGradient(activeX, lineY, activeX + wordW, lineY);
        const leadEdge = Math.min(1.0, Math.max(0.05, subP));
        const softEdge = Math.min(1.0, leadEdge + 0.28);
        wipeGrad.addColorStop(0.0, '#ffffff');
        wipeGrad.addColorStop(leadEdge, '#ffffff');
        wipeGrad.addColorStop(softEdge, 'rgba(255, 255, 255, 0.25)');
        wipeGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.08)');
        ctx.fillStyle = wipeGrad;
      } else {
        ctx.fillStyle = '#ffffff';
      }
      ctx.fillText(activeWordStr, activeX, lineY + floatY);
      ctx.restore();
      return;
    }
  }

  ctx.save();
  ctx.globalAlpha = lineAlpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncateToWidth(roll.text, maxTextW, ctx.font), textStartX, lineY);
  ctx.restore();
}

// -------------------------------------------------------------
// Call App Vector Icon & Participant Avatar Helpers
// -------------------------------------------------------------
function drawCallAppIcon(appId, ix, iy, size) {
  ctx.save();
  const r = Math.max(4, size * 0.26);
  ctx.beginPath();
  ctx.roundRect(ix, iy, size, size, r);

  const id = (appId || '').toLowerCase();
  if (id === 'discord') {
    ctx.fillStyle = '#5865F2';
    ctx.fill();
    // Crisp vector Discord Clyde / Controller silhouette
    const cx = ix + size / 2;
    const cy = iy + size / 2;
    const s = size / 18;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(cx - 5.2 * s, cy - 3.6 * s, 10.4 * s, 7.2 * s, 3.2 * s);
    ctx.fill();
    // Eyes
    ctx.fillStyle = '#5865F2';
    ctx.beginPath();
    ctx.arc(cx - 2.1 * s, cy - 0.2 * s, 1.25 * s, 0, Math.PI * 2);
    ctx.arc(cx + 2.1 * s, cy - 0.2 * s, 1.25 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 'whatsapp') {
    ctx.fillStyle = '#25D366';
    ctx.fill();
    const cx = ix + size / 2;
    const cy = iy + size / 2;
    const s = size / 18;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.arc(cx, cy - 0.3 * s, 4.6 * s, 0.2, Math.PI * 1.85);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx - 1.5 * s, cy - 1.3 * s, 1.1 * s, 0, Math.PI * 2);
    ctx.arc(cx + 1.5 * s, cy + 1.3 * s, 1.1 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.8 * s;
    ctx.beginPath();
    ctx.moveTo(cx - 1.5 * s, cy - 1.3 * s);
    ctx.quadraticCurveTo(cx - 0.5 * s, cy + 0.8 * s, cx + 1.5 * s, cy + 1.3 * s);
    ctx.stroke();
  } else if (id === 'zoom') {
    ctx.fillStyle = '#2D8CFF';
    ctx.fill();
    const cx = ix + size / 2;
    const cy = iy + size / 2;
    const s = size / 18;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(cx - 4.8 * s, cy - 2.8 * s, 6.4 * s, 5.6 * s, 1.4 * s);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 2.0 * s, cy - 1.2 * s);
    ctx.lineTo(cx + 4.8 * s, cy - 2.6 * s);
    ctx.lineTo(cx + 4.8 * s, cy + 2.6 * s);
    ctx.lineTo(cx + 2.0 * s, cy + 1.2 * s);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = id === 'teams' ? '#6264A7' : (id === 'telegram' ? '#26A5E4' : '#ea580c');
    ctx.fill();
    const cx = ix + size / 2;
    const cy = iy + size / 2;
    const s = size / 18;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 3.2 * s, cy - 2.8 * s);
    ctx.quadraticCurveTo(cx - 2.5 * s, cy + 2.5 * s, cx + 3.2 * s, cy + 2.8 * s);
    ctx.stroke();
  }
  ctx.restore();
}

function drawParticipantAvatarWithBadges(part, idx, ax, ay, size) {
  const palette = [
    ['#6366f1', '#4f46e5'],
    ['#ec4899', '#db2777'],
    ['#14b8a6', '#0d9488'],
    ['#f59e0b', '#d97706']
  ];
  const pair = palette[idx % palette.length];
  const radius = size / 2;
  const cx = ax + radius;
  const cy = ay + radius;

  // 1. Circular Profile Picture or Vibrant Initials
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const img = part && part.avatarUrl ? getCallAvatarImage(part.avatarUrl) : null;
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, ax, ay, size, size);
  } else {
    const grad = ctx.createLinearGradient(ax, ay, ax + size, ay + size);
    grad.addColorStop(0.0, pair[0]);
    grad.addColorStop(1.0, pair[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(ax, ay, size, size);

    const initial = ((part && part.name) ? String(part.name).trim().charAt(0) : 'U').toUpperCase();
    ctx.font = `700 ${Math.max(8, Math.round(size * 0.46))}px "Segoe UI Variable Display", Inter, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy + 0.5);
  }
  ctx.restore();

  // Subtle rim around profile circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = part && part.isSpeaking ? 1.5 : 1;
  ctx.strokeStyle = part && part.isSpeaking ? '#22c55e' : 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.restore();

  // 2. Glowing Green Line Below Profile Picture when Speaking
  if (part && part.isSpeaking) {
    const lineW = Math.max(11, Math.round(size * 0.76));
    const lineH = size >= 30 ? 3 : 2.2;
    const lineX = cx - lineW / 2;
    const lineY = ay + size + (size >= 30 ? 3 : 1.5);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(lineX - 1.5, lineY - 1, lineW + 3, lineH + 2, (lineH + 2) / 2);
    ctx.fillStyle = 'rgba(34, 197, 94, 0.28)';
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(lineX, lineY, lineW, lineH, lineH / 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.restore();
  }

  // 3. Small Mute / Deafen Circle on Bottom-Right of Profile Picture
  if (part && (part.isMuted || part.isDeafened)) {
    const badgeR = Math.max(3.6, size * 0.21);
    const bx = ax + size - badgeR * 0.65;
    const by = ay + size - badgeR * 0.65;

    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, badgeR + 1, 0, Math.PI * 2);
    ctx.fillStyle = '#08080a';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
    ctx.fillStyle = part.isDeafened ? '#f59e0b' : '#ef4444';
    ctx.fill();

    // Crisp diagonal slash inside mute/deafen circle
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.1, badgeR * 0.34);
    ctx.lineCap = 'round';
    const d = badgeR * 0.52;
    ctx.beginPath();
    ctx.moveTo(bx - d, by - d);
    ctx.lineTo(bx + d, by + d);
    ctx.stroke();
    ctx.restore();
  }
}

function renderOrangeCallDot(dx, dy, isRinging, isSpeaking) {
  const color = '#f97316'; // Vibrant orange glowing indicator
  const pulseSpeed = isRinging ? 110 : 180;
  const pulseFactor = 0.5 + 0.5 * Math.sin(Date.now() / pulseSpeed);

  ctx.save();
  ctx.beginPath();
  ctx.arc(dx, dy, 5 + pulseFactor * (isSpeaking || isRinging ? 3.2 : 2.4), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(249, 115, 22, ${0.38 * pulseFactor})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(dx, dy, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function renderRightCallCapsule(cx, cy, cw, ch) {
  const pillRadius = UI.COMPACT_RADIUS;
  const rim = callState.status === 'ringing'
    ? 'rgba(249, 115, 22, 0.45)'
    : 'rgba(255, 255, 255, 0.14)';
  drawDetachedPillSurface(cx, cy, cw, ch, pillRadius, rim);

  // 2. App Logo on Left
  const logoSize = 18;
  const logoX = cx + 8;
  const logoY = cy + (ch - logoSize) / 2;
  drawCallAppIcon(callState.appId, logoX, logoY, logoSize);

  // 3. Call Context Label (DM Name or "N Joined")
  let curX = logoX + logoSize + 6;
  const label = getCallCapsuleLabel();
  ctx.save();
  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const dispLabel = truncateToWidth(label, 78, ctx.font);
  ctx.fillText(dispLabel, curX, cy + ch / 2);
  curX += ctx.measureText(dispLabel).width + 6;
  ctx.restore();

  // 4. Mini Participant Avatars (for DM or Group VC <= 4 people) with Green Speaking Line & Mute/Deafen Circle
  const showAvatars = (callState.callType === 'dm' || (callState.participantCount || 0) <= 4)
    && Array.isArray(callState.participants)
    && callState.participants.length > 0;
  if (showAvatars) {
    const count = Math.min(4, callState.participants.length);
    const avaSize = 17;
    const avaStep = 15;
    const avaY = cy + (ch - avaSize) / 2 - 1;
    for (let i = 0; i < count; i++) {
      const part = callState.participants[i];
      drawParticipantAvatarWithBadges(part, i, curX + i * avaStep, avaY, avaSize);
    }
    curX += count * avaStep + 5;
  }

  // 5. User's Own Status Tag (Muted / Deafened)
  if (callState.selfDeafened || callState.selfMuted) {
    const statusText = callState.selfDeafened ? 'Deaf' : 'Muted';
    ctx.save();
    ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = callState.selfDeafened ? '#fbbf24' : '#f87171';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const maxStatW = Math.max(0, (cx + cw - 20) - curX);
    if (maxStatW >= 24) {
      ctx.fillText(truncateToWidth(statusText, maxStatW, ctx.font), curX, cy + ch / 2);
    }
    ctx.restore();
  }

  // 6. Orange Glowing Indicator Circle on Far Right
  const dotX = cx + cw - 11;
  const dotY = cy + ch / 2;
  renderOrangeCallDot(dotX, dotY, callState.status === 'ringing', callState.selfSpeaking);

  // Interactive button target for Right Call Capsule
  interactiveButtons.push({ id: 'nav_call', x: cx, y: cy, w: cw, h: ch });
}

// -------------------------------------------------------------
// Resting Pill View (Minimalist & Clean)
// -------------------------------------------------------------
function renderRestingPill(x, y, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const now = new Date();
  const timeStr = formatClockTime(now, { clock24h, showSeconds, showAmPm });

  // -------------------------------------------------------------
  // 1. Center Main Island Capsule [ Clock or Media ]
  // -------------------------------------------------------------
  const hasMedia = mediaState.isPlaying && mediaState.track && mediaState.track.title && mediaState.track.title !== 'No media playing';

  if (hasMedia) {
    // Single Media Pill Layout: (Optional Laptop Battery Dot) + Clock + Rounded Album Art + Animated Lyric + 6-Bar Equalizer
    const isRestingMediaHov = hoveredButtonId === 'nav_media' || isHovered;
    let clockStartX = x + 12;

    if (batteryState && batteryState.hasBattery) {
      drawBatteryCircle(ctx, x + 16, y + h / 2, 6.2, batteryState.percent, batteryState.isCharging, alpha);
      clockStartX = x + 29;
    }

    drawRollingTime(ctx, 'resting_media_clock', timeStr, clockStartX, y + h / 2, {
      font: '600 11px "Segoe UI Variable Display", Inter, sans-serif',
      fillStyle: '#e4e4e7',
      align: 'left',
      baseline: 'middle',
      isHovered: isRestingMediaHov,
      alpha
    });
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    const clockW = ctx.measureText(timeStr).width;

    // Album Cover Thumbnail (20x20 rounded) or Music Note
    const artSize = 20;
    const artX = clockStartX + clockW + 8;
    const artY = y + (h - artSize) / 2;
    if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(artX, artY, artSize, artSize, 4.5);
      ctx.clip();
      ctx.drawImage(albumImage, artX, artY, artSize, artSize);
      ctx.restore();
    } else {
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = albumAccentColor || '#38bdf8';
      ctx.fillText('♪', artX + 4, y + h / 2);
    }

    // 6-Bar Animated Equalizer on far right
    const eqW = 24;
    const eqX = x + w - eqW - 12;
    drawEqualizer('pill', eqX, y + h / 2, eqW, 13, albumAccentColor || '#ec4899', 6);

    // Center Rolling Lyric or Song Title
    const textStartX = artX + artSize + 8;
    const maxTextW = Math.max(30, eqX - 10 - textStartX);
    const roll = getPillRollingLyric();

    ctx.save();
    ctx.beginPath();
    ctx.rect(textStartX, y + 2, maxTextW, h - 4);
    ctx.clip();
    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    if (roll) {
      drawAnimatedRestingLyric(textStartX, y + h / 2, maxTextW, roll, alpha);
    } else {
      const fallbackText = (mediaState.track.title || '').trim();
      ctx.fillStyle = '#f4f4f5';
      ctx.fillText(truncateToWidth(fallbackText, maxTextW, ctx.font), textStartX, y + h / 2);
    }
    ctx.restore();

    interactiveButtons.push({ id: 'nav_media', x, y, w, h });
  } else {
    const isRestingHomeHov = hoveredButtonId === 'nav_home' || isHovered;
    if (batteryState && batteryState.hasBattery) {
      // Laptop: Left side = Circular Battery Indicator (Green >40, Yellow 20-40, Red 0-20), Right side = Tumbler Rolling Clock
      const battPadding = 12;
      const battDim = drawBatteryIndicator(ctx, x + battPadding, y + h / 2, batteryState, {
        radius: 4.2,
        showText: true,
        font: '600 11px "Segoe UI Variable Text", Inter, sans-serif',
        textColor: '#e4e4e7',
        alpha,
        isHovered: isRestingHomeHov
      });

      const remainingW = w - (battPadding + battDim.width);
      const clockTargetX = x + battPadding + battDim.width + remainingW / 2;
      drawRollingTime(ctx, 'resting_pill_clock', timeStr, clockTargetX, y + h / 2, {
        font: '600 12px "Segoe UI Variable Display", Inter, sans-serif',
        fillStyle: '#f4f4f5',
        align: 'center',
        baseline: 'middle',
        isHovered: isRestingHomeHov,
        alpha
      });
    } else {
      // Desktop: Pure minimalist centered clock with mechanical rolling tumbler lock animation
      drawRollingTime(ctx, 'resting_pill_clock', timeStr, x + w / 2, y + h / 2, {
        font: '600 12px "Segoe UI Variable Display", Inter, sans-serif',
        fillStyle: '#f4f4f5',
        align: 'center',
        baseline: 'middle',
        isHovered: isRestingHomeHov,
        alpha
      });
    }
    interactiveButtons.push({ id: 'nav_home', x, y, w, h });
  }

  ctx.restore();
}

function computeSideIslandsLayout({ centerX, centerW, hasTimer, timerW, hasAI, aiW, hasCall, callW, gap = 8 }) {
  const safeGap = Math.max(4, Number(gap) || 8);
  const leftAiX = hasAI ? Math.round(centerX - aiW - safeGap) : null;
  const rightTimerX = hasTimer ? Math.round(centerX + centerW + safeGap) : null;
  const rightCallX = hasCall
    ? Math.round(centerX + centerW + (hasTimer ? (timerW + safeGap * 2) : safeGap))
    : null;
  return { leftAiX, rightTimerX, rightCallX };
}

function drawDetachedPillSurface(px, py, pw, ph, radius, borderColor) {
  ctx.save();
  const isNotch = (displayMode === 'notch' && py <= 0.1);
  const rNum = Array.isArray(radius) ? (radius[2] || UI.COMPACT_RADIUS) : radius;
  const topFillet = isNotch ? Math.min(10, Math.round(ph * 0.32)) : 0;

  drawBlurredCapsuleShadow(ctx, {
    x: px,
    y: py,
    w: pw,
    h: ph,
    radius: rNum,
    useBezelLump: isNotch,
    topFillet,
    blur: 14,
    offsetY: 4,
    color: 'rgba(0, 0, 0, 0.55)',
    preferSprite: true
  });

  paintCapsuleSurface(ctx, {
    x: px,
    y: py,
    w: pw,
    h: ph,
    radius: rNum,
    topFillet,
    useBezelLump: isNotch,
    rimColor: borderColor
  });
  ctx.restore();
}

function renderAppleClockGlyph(cx, cy, mode, progress, accentCol) {
  const r = 6;
  ctx.save();
  if (mode === 'timer') {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 159, 10, 0.25)';
    ctx.stroke();

    const clamped = Math.max(0, Math.min(1, progress));
    if (clamped > 0.005) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamped);
      ctx.lineWidth = 2.1;
      ctx.lineCap = 'round';
      ctx.strokeStyle = accentCol;
      ctx.stroke();
    }
  } else if (mode === 'focus') {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = accentCol;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx + 2.6, cy - 1.8, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = '#08080a';
    ctx.fill();
  } else {
    // Stopwatch circular dial + crown tick + sweep hand
    ctx.beginPath();
    ctx.arc(cx, cy + 0.5, r - 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = accentCol;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 1.5);
    ctx.lineTo(cx, cy - r + 0.5);
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = accentCol;
    ctx.stroke();

    const angle = -Math.PI / 2 + progress * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 0.5);
    ctx.lineTo(cx + Math.cos(angle) * (r - 2.2), cy + 0.5 + Math.sin(angle) * (r - 2.2));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}

function renderDetachedSideIslands(x, y, w, h, alpha) {
  if (alpha <= 0.02) return;

  const activeProjs = getActiveProjects().filter(p => ['running', 'thinking', 'waiting'].includes(p.status));
  const activeCount = activeProjs.length;
  const hasAI = (activeCount > 0 || pendingPrompt !== null);
  const hasTimer = Boolean(timerRunning || focusRunning || stopwatchRunning);
  const hasCall = hasActiveCall();

  if (!hasAI && !hasTimer && !hasCall) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  const isNotch = displayMode === 'notch';
  const pillRadius = isNotch ? [0, 0, UI.COMPACT_RADIUS, UI.COMPACT_RADIUS] : Math.round(h / 2);
  const gap = isNotch ? 22 : 8;

  // Prepare Left Pill metrics (Timer / Focus / Stopwatch)
  let timerText = '';
  let timerMode = 'timer';
  let timerCol = '#ff9f0a';
  let timerProgress = 0;
  let timerW = 0;
  const clockFont = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';

  if (hasTimer) {
    if (timerRunning) {
      timerMode = 'timer';
      timerText = formatTimerSeconds(timerRemainingSec);
      timerCol = '#ff9f0a';
      timerProgress = timerDurationSec > 0 ? (timerRemainingSec / timerDurationSec) : 0;
    } else if (focusRunning) {
      timerMode = 'focus';
      timerText = formatTimerSeconds(focusRemainingSec);
      timerCol = focusMode === 'break' ? '#30d158' : '#a855f7';
      timerProgress = 1;
    } else {
      timerMode = 'stopwatch';
      timerText = formatStopwatchMs(stopwatchElapsedMs);
      timerCol = '#30d158';
      timerProgress = ((stopwatchElapsedMs / 1000) % 60) / 60;
    }
    ctx.font = clockFont;
    const textW = ctx.measureText(timerText).width;
    timerW = Math.max(82, Math.round(11 + 14 + 6 + textW + 12));
  }

  // Prepare Right Pill metrics (Antigravity)
  let aiLabel = '';
  let aiStatus = 'running';
  let aiW = 0;
  const aiFont = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';

  if (hasAI) {
    if (pendingPrompt) {
      aiLabel = 'Needs input';
      aiStatus = 'waiting';
    } else if (activeCount > 1) {
      aiLabel = `${activeCount} running`;
      aiStatus = activeProjs.some(p => p.status === 'running') ? 'running' : (activeProjs.some(p => p.status === 'thinking') ? 'thinking' : 'waiting');
    } else if (activeCount === 1) {
      const p0 = activeProjs[0];
      aiStatus = p0.status || 'running';
      const raw = (p0.project && p0.project !== 'Antigravity') ? p0.project : (p0.task || p0.project || 'Island');
      aiLabel = sanitizeProjectName(raw);
    }
    ctx.font = aiFont;
    const labelW = ctx.measureText(aiLabel).width;
    aiW = Math.max(92, Math.min(164, Math.round(54 + labelW)));
  }

  const callW = hasCall ? getCallCapsuleWidth() : 0;
  const layout = computeSideIslandsLayout({
    centerX: x,
    centerW: w,
    hasTimer,
    timerW,
    hasAI,
    aiW,
    hasCall,
    callW,
    gap
  });

  // 1. Left Detached Island: Antigravity progress
  if (hasAI && layout.leftAiX !== null) {
    const ax = layout.leftAiX;
    const isAiHov = hoveredButtonId === 'nav_agent';
    const rim = (aiStatus === 'waiting')
      ? 'rgba(245, 158, 11, 0.45)'
      : (isAiHov ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.14)');
    drawDetachedPillSurface(ax, y, aiW, h, pillRadius, rim);

    // Antigravity Logo (18x18 rounded)
    const logoSize = 18;
    const logoX = ax + 9;
    const logoY = y + (h - logoSize) / 2;
    if (antigravityLogo.complete && antigravityLogo.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(logoX, logoY, logoSize, logoSize, 4.5);
      ctx.clip();
      ctx.drawImage(antigravityLogo, logoX, logoY, logoSize, logoSize);
      ctx.restore();
    }

    // Label Text
    const textStartX = logoX + logoSize + 6;
    const dotReserve = 18;
    const maxLabelW = Math.max(20, (ax + aiW - dotReserve) - textStartX);
    ctx.font = aiFont;
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateToWidth(aiLabel, maxLabelW, ctx.font), textStartX, y + h / 2);

    // Traffic Light Status Dot
    renderTrafficLightDot(ax + aiW - 12, y + h / 2, aiStatus);

    interactiveButtons.push({ id: 'nav_agent', x: ax, y, w: aiW, h });
  }

  // 2. Right Detached Island: Timer / Focus / Stopwatch (Apple Live Activity style)
  if (hasTimer && layout.rightTimerX !== null) {
    const tx = layout.rightTimerX;
    const isTimerHov = hoveredButtonId === 'nav_clock';
    const rim = isTimerHov ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.14)';
    drawDetachedPillSurface(tx, y, timerW, h, pillRadius, rim);

    const glyphCx = tx + 11 + 6;
    const midY = y + h / 2;
    renderAppleClockGlyph(glyphCx, midY, timerMode, timerProgress, timerCol);

    ctx.font = clockFont;
    ctx.fillStyle = timerMode === 'focus' && focusMode !== 'break' ? '#d8b4fe' : timerCol;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timerText, tx + 11 + 14 + 6, midY);

    interactiveButtons.push({ id: 'nav_clock', x: tx, y, w: timerW, h });
  }

  // 3. Right Detached Call Capsule (stacked beside Timer if active)
  if (hasCall && layout.rightCallX !== null) {
    renderRightCallCapsule(layout.rightCallX, y, callW, h);
  }

  ctx.restore();
}

function renderTrafficLightDot(dx, dy, status) {
  let color = '#22c55e'; // Green (done / idle)
  let pulse = false;

  if (status === 'running') {
    color = '#22c55e'; // Vibrant green
    pulse = true;
  } else if (status === 'thinking') {
    color = '#38bdf8'; // Blue pulse
    pulse = true;
  } else if (status === 'waiting') {
    color = '#f59e0b'; // Amber solid
  } else if (status === 'error') {
    color = '#ef4444'; // Red
  } else if (status === 'not_running') {
    color = '#64748b'; // Muted Gray
  }

  ctx.save();
  if (pulse && aiPulseUntil > performance.now()) {
    const pulseFactor = 0.5 + 0.5 * Math.sin(performance.now() / 140);
    ctx.beginPath();
    ctx.arc(dx, dy, 5 + pulseFactor * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color === '#22c55e'
      ? `rgba(34, 197, 94, ${0.35 * pulseFactor})`
      : `rgba(56, 189, 248, ${0.35 * pulseFactor})`;
    ctx.fill();
  } else if (pulse) {
    ctx.beginPath();
    ctx.arc(dx, dy, 6.2, 0, Math.PI * 2);
    ctx.fillStyle = color === '#22c55e'
      ? 'rgba(34, 197, 94, 0.22)'
      : 'rgba(56, 189, 248, 0.22)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(dx, dy, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// -------------------------------------------------------------
// Expanded Island View
// -------------------------------------------------------------
function renderViewContent(view, x, y, w, h) {
  if (view === 'home') {
    renderHomeView(x, y, w, h);
  } else if (view === 'notifications') {
    renderNotificationCenterView(x, y, w, h);
  } else if (view === 'calendar') {
    renderCalendarTabView(x, y, w, h);
  } else if (view === 'clock') {
    renderClockTabView(x, y, w, h);
  } else if (view === 'todo') {
    renderTodoTabView(x, y, w, h);
  } else if (view === 'agent') {
    renderAgentView(x, y, w, h);
  } else if (view === 'call') {
    renderCallView(x, y, w, h);
  } else if (view === 'media') {
    renderMediaView(x, y, w, h);
  } else if (view === 'dropzone') {
    renderDropZoneView(x, y, w, h);
  } else if (view === 'clipboard') {
    renderClipboardView(x, y, w, h);
  } else if (view === 'prompt') {
    renderPromptView(x, y, w, h);
  }
}

function renderExpandedView(x, y, w, h, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Auto-expanding notification banner alert
  if (currentView === 'notification_banner') {
    renderNotificationBannerView(x, y, w, h);
    ctx.restore();
    return;
  }

  // Navigation Pills at Top
  renderTopNav(x, y, w);

  // View Body with Directional Slide & Cross-fade Transition
  const now = performance.now();
  const tabDuration = Math.max(120, 220 / (animSpeedMultiplier || 1.0));
  const elapsed = now - tabTransitionStartTime;
  const progress = tabTransitionStartTime > 0 ? Math.min(1.0, elapsed / tabDuration) : 1.0;
  if (tabTransitionStartTime > 0 && progress >= 1.0) {
    tabTransitionStartTime = 0;
  }
  const isTransitioning = progress < 1.0 && previousView && previousView !== currentView;

  if (isTransitioning) {
    const offsets = getTabTransitionOffsets(tabTransitionDirection, progress, 26);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 20, y + 38, w + 40, Math.max(0, h - 38));
    ctx.clip();

    // 1. Outgoing View
    const outAlpha = offsets.outgoingAlpha * alpha;
    if (outAlpha > 0.01) {
      const savedLen = interactiveButtons.length;
      ctx.save();
      ctx.globalAlpha = outAlpha;
      ctx.translate(offsets.outgoingOffset, 0);
      renderViewContent(previousView, x, y, w, h);
      ctx.restore();
      interactiveButtons.length = savedLen;
    }

    // 2. Incoming View
    const inAlpha = offsets.incomingAlpha * alpha;
    const inOffset = offsets.incomingOffset;
    const incomingStartIndex = interactiveButtons.length;
    ctx.save();
    ctx.globalAlpha = inAlpha;
    ctx.translate(inOffset, 0);
    renderViewContent(currentView, x, y, w, h);
    ctx.restore();
    for (let i = incomingStartIndex; i < interactiveButtons.length; i++) {
      interactiveButtons[i].x += inOffset;
    }

    ctx.restore();
  } else {
    renderViewContent(currentView, x, y, w, h);
  }

  ctx.restore();
}

function renderCallView(x, y, w, h) {
  // Dedicated Enlarged Incoming Call Alert View
  if (callState.status === 'ringing') {
    const midX = x + w / 2;

    // 1. Ringing Pulse Halo & Calling App Icon
    const ringRadius = 24;
    const ringCenterY = y + 54;
    const now = performance.now();
    const pulse1 = (now % 1600) / 1600;
    const pulse2 = ((now + 800) % 1600) / 1600;

    ctx.save();
    // Concentric pulsating waves
    ctx.beginPath();
    ctx.arc(midX, ringCenterY, ringRadius + pulse1 * 28, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(34, 197, 94, ${Math.max(0, 0.45 * (1 - pulse1))})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(midX, ringCenterY, ringRadius + pulse2 * 28, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(34, 197, 94, ${Math.max(0, 0.45 * (1 - pulse2))})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center circular badge with calling app icon
    ctx.beginPath();
    ctx.arc(midX, ringCenterY, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#18181b';
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    drawCallAppIcon(callState.appId, midX - 12, ringCenterY - 12, 24);
    ctx.restore();

    // 2. Main Caller Title & Ringing Subtitle
    const callerTitle = callState.channelName || callState.appName || 'Incoming Call';
    ctx.font = '700 17px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateToWidth(callerTitle, w - 80, ctx.font), midX, y + 96);

    ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${callState.appName || 'Voice'} Call • Ringing...`, midX, y + 116);

    // 3. Action Buttons:
    // Left side: Decline (Red)
    // Right side: Pick Up (Green button with phone logo)
    const btnY = y + 138;
    const btnH = 40;
    const btnW = 140;
    const btnRadius = 20;

    // Left Button: Decline
    const isDecHov = hoveredButtonId === 'call_decline';
    const decX = x + 44;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(decX, btnY, btnW, btnH, btnRadius);
    ctx.fillStyle = isDecHov ? '#ef4444' : '#dc2626';
    ctx.fill();
    ctx.strokeStyle = isDecHov ? 'rgba(255, 255, 255, 0.45)' : 'rgba(239, 68, 68, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✖ Decline', decX + btnW / 2, btnY + btnH / 2);
    interactiveButtons.push({ id: 'call_decline', x: decX, y: btnY, w: btnW, h: btnH });
    ctx.restore();

    // Right Button: Pick Up (Green button with phone logo)
    const isAnsHov = hoveredButtonId === 'call_answer';
    const ansX = x + w - btnW - 44;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ansX, btnY, btnW, btnH, btnRadius);
    ctx.fillStyle = isAnsHov ? '#22c55e' : '#16a34a';
    ctx.fill();
    ctx.strokeStyle = isAnsHov ? 'rgba(255, 255, 255, 0.45)' : 'rgba(34, 197, 94, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📞 Pick Up', ansX + btnW / 2, btnY + btnH / 2);
    interactiveButtons.push({ id: 'call_answer', x: ansX, y: btnY, w: btnW, h: btnH });
    ctx.restore();

    return;
  }

  const topY = y + 42;
  const contentX = x + 20;
  const contentW = w - 40;

  // 1. Top Call Header Card: App Icon + Caller / Group Info + Elapsed Duration + Orange Status Badge
  const headerH = 44;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(contentX, topY, contentW, headerH, 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.22)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  const iconSize = 28;
  const iconX = contentX + 10;
  const iconY = topY + (headerH - iconSize) / 2;
  drawCallAppIcon(callState.appId, iconX, iconY, iconSize);

  const titleX = iconX + iconSize + 10;
  const isGroup = callState.callType === 'group';
  const count = Math.max(1, callState.participantCount || (callState.participants ? callState.participants.length : 1));
  const mainTitle = callState.channelName || (isGroup ? `${callState.appName || 'Voice'} Group Call` : `${callState.appName || 'Voice'} Call`);
  const elapsedMs = callState.startedAt ? Math.max(0, Date.now() - callState.startedAt) : 0;
  const subTitle = callState.status === 'ringing'
    ? `Incoming ${callState.appName || 'Voice'} Call...`
    : `${callState.appName || 'Voice'} • ${isGroup ? `${count} Joined` : 'DM Voice Call'} • ${formatTimeMs(elapsedMs)}`;

  ctx.font = '700 12.5px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncateToWidth(mainTitle, contentW - 165, ctx.font), titleX, topY + 7);

  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.fillText(truncateToWidth(subTitle, contentW - 165, ctx.font), titleX, topY + 24);

  // Right Status Badge with Orange Glowing Circle
  const selfStatus = callState.status === 'ringing'
    ? 'Ringing'
    : (callState.selfDeafened ? 'Deafened' : (callState.selfMuted ? 'Muted' : (callState.selfSpeaking ? 'Speaking' : 'Connected')));
  ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
  const statW = ctx.measureText(selfStatus).width + 28;
  const statH = 22;
  const statX = contentX + contentW - statW - 10;
  const statY = topY + (headerH - statH) / 2;

  ctx.beginPath();
  ctx.roundRect(statX, statY, statW, statH, 11);
  ctx.fillStyle = 'rgba(249, 115, 22, 0.14)';
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.35)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  renderOrangeCallDot(statX + 11, statY + statH / 2, callState.status === 'ringing', callState.selfSpeaking);
  ctx.fillStyle = '#fed7aa';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(selfStatus, statX + 20, statY + statH / 2);
  ctx.restore();

  // 2. Center Participant Stage (Profile Pictures for DM or Group <= 4 people, with Green Speaking Bar & Mute/Deafen Circle)
  const stageY = topY + headerH + 8;
  const stageH = 66;
  const parts = Array.isArray(callState.participants) && callState.participants.length > 0
    ? callState.participants.slice(0, 4)
    : [{
      id: 'self',
      name: callState.channelName || 'You',
      isSpeaking: Boolean(callState.selfSpeaking),
      isMuted: Boolean(callState.selfMuted),
      isDeafened: Boolean(callState.selfDeafened)
    }];

  const showIndividual = callState.callType === 'dm' || (callState.participantCount || parts.length) <= 4;
  if (showIndividual) {
    const pCount = Math.min(4, parts.length);
    const cardW = Math.min(118, Math.floor((contentW - (pCount - 1) * 10) / pCount));
    const totalRowW = pCount * cardW + (pCount - 1) * 10;
    let startPX = contentX + (contentW - totalRowW) / 2;

    for (let i = 0; i < pCount; i++) {
      const part = parts[i];
      const px = startPX + i * (cardW + 10);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(px, stageY, cardW, stageH, 9);
      ctx.fillStyle = part.isSpeaking ? 'rgba(34, 197, 94, 0.08)' : 'rgba(255, 255, 255, 0.03)';
      ctx.strokeStyle = part.isSpeaking ? 'rgba(34, 197, 94, 0.38)' : 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      const avaSize = 34;
      const avaX = px + (cardW - avaSize) / 2;
      const avaY = stageY + 6;
      drawParticipantAvatarWithBadges(part, i, avaX, avaY, avaSize);

      ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = part.isSpeaking ? '#4ade80' : '#e4e4e7';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(truncateToWidth(part.name || 'User', cardW - 10, ctx.font), px + cardW / 2, stageY + stageH - 4);
      ctx.restore();
    }
  } else {
    // Group Call with > 4 participants summary banner
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(contentX, stageY, contentW, stageH, 9);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${count} Participants Joined in ${callState.channelName || 'Voice Channel'}`, contentX + contentW / 2, stageY + stageH / 2 - 8);

    ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText(callState.selfDeafened ? 'You are Deafened' : (callState.selfMuted ? 'You are Muted' : 'Voice Activity Active'), contentX + contentW / 2, stageY + stageH / 2 + 10);
    ctx.restore();
  }

  // 3. Bottom Call Action Bar (Hover Options: Mute, Deafen, Focus App, Leave Call / Answer / Decline)
  const btnY = stageY + stageH + 10;
  const btnH = 28;

  const actions = callState.status === 'ringing'
    ? [
      { id: 'call_answer', label: '📞 Pick Up', bg: 'rgba(22, 163, 74, 0.28)', hoverBg: '#16a34a', border: '#22c55e', color: '#ffffff' },
      { id: 'call_decline', label: '✖ Decline', bg: 'rgba(220, 38, 38, 0.28)', hoverBg: '#dc2626', border: '#ef4444', color: '#ffffff' },
      { id: 'call_focus_app', label: `↗ Open ${callState.appName || 'App'}`, bg: 'rgba(255, 255, 255, 0.06)', hoverBg: 'rgba(255, 255, 255, 0.15)', border: 'rgba(255, 255, 255, 0.14)', color: '#e4e4e7' }
    ]
    : [
      {
        id: 'call_toggle_mute',
        label: callState.selfMuted ? '🎤 Unmute' : '🎤 Mute',
        bg: callState.selfMuted ? 'rgba(239, 68, 68, 0.24)' : 'rgba(255, 255, 255, 0.06)',
        hoverBg: callState.selfMuted ? '#dc2626' : 'rgba(255, 255, 255, 0.15)',
        border: callState.selfMuted ? '#ef4444' : 'rgba(255, 255, 255, 0.14)',
        color: '#ffffff'
      },
      {
        id: 'call_toggle_deafen',
        label: callState.selfDeafened ? '🎧 Undeafen' : '🎧 Deafen',
        bg: callState.selfDeafened ? 'rgba(245, 158, 11, 0.24)' : 'rgba(255, 255, 255, 0.06)',
        hoverBg: callState.selfDeafened ? '#d97706' : 'rgba(255, 255, 255, 0.15)',
        border: callState.selfDeafened ? '#f59e0b' : 'rgba(255, 255, 255, 0.14)',
        color: '#ffffff'
      },
      {
        id: 'call_focus_app',
        label: `↗ ${callState.appName || 'App'}`,
        bg: 'rgba(255, 255, 255, 0.06)',
        hoverBg: 'rgba(255, 255, 255, 0.15)',
        border: 'rgba(255, 255, 255, 0.14)',
        color: '#e4e4e7'
      },
      {
        id: 'call_leave',
        label: '📞 Leave Call',
        bg: 'rgba(220, 38, 38, 0.26)',
        hoverBg: '#dc2626',
        border: '#ef4444',
        color: '#ffffff'
      }
    ];

  const gap = 8;
  const btnW = Math.floor((contentW - (actions.length - 1) * gap) / actions.length);

  actions.forEach((act, idx) => {
    const bx = contentX + idx * (btnW + gap);
    const isHov = hoveredButtonId === act.id;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(bx, btnY, btnW, btnH, 8);
    ctx.fillStyle = isHov ? act.hoverBg : act.bg;
    ctx.strokeStyle = act.border;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = act.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(act.label, bx + btnW / 2, btnY + btnH / 2);
    ctx.restore();

    interactiveButtons.push({ id: act.id, x: bx, y: btnY, w: btnW, h: btnH });
  });
}

function renderTopNav(x, y, w) {
  const hasUnreadNotifs = notificationList.some(n => !n.read && !String(`${n.app || ''} ${n.title || ''}`).toLowerCase().includes('antigravity'));
  const navItems = [
    { id: 'nav_home', label: 'Home', w: 42 },
    { id: 'nav_notif', label: hasUnreadNotifs ? 'Notif •' : 'Notif', w: 46 },
    { id: 'nav_calendar', label: 'Calendar', w: 48 },
    { id: 'nav_clock', label: 'Clock', w: 40 },
    { id: 'nav_todo', label: 'Notes', w: 42 },
    { id: 'nav_media', label: 'Media', w: 44 }
  ];
  if (hasActiveCall() || currentView === 'call') {
    navItems.push({ id: 'nav_call', label: 'Call', w: 38 });
  }
  navItems.push(
    { id: 'nav_dropzone', label: 'Shelf', w: 42 },
    { id: 'nav_clipboard', label: 'Clip', w: 38 },
    { id: 'nav_settings', label: '⚙', w: 26 }
  );

  const pillH = 22;
  const spacing = 5;
  let curX = x + 16;
  const topY = y + 12;

  let activePillX = null;
  let activePillW = null;
  const itemLayouts = [];

  navItems.forEach((item) => {
    const px = curX;
    const pillW = item.w;
    curX += pillW + spacing;
    const isCur = currentView === item.id.replace('nav_', '') || (currentView === 'notifications' && item.id === 'nav_notif');
    if (isCur) {
      activePillX = px;
      activePillW = pillW;
    }
    itemLayouts.push({ item, px, pillW, isCur });
  });

  // Smooth sliding pill interpolation
  if (activePillX !== null) {
    const step = computeSlidingPillStep(navIndicatorX, navIndicatorW, activePillX, activePillW, currentDt, animSpeedMultiplier);
    navIndicatorX = step.x;
    navIndicatorW = step.w;
    isNavPillAnimating = !step.isSettled;
  } else {
    isNavPillAnimating = false;
  }

  // 1. Inactive pill base backgrounds
  itemLayouts.forEach(({ item, px, pillW }) => {
    const isHov = hoveredButtonId === item.id;
    ctx.beginPath();
    ctx.roundRect(px, topY, pillW, pillH, 11);
    ctx.fillStyle = isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
  });

  // 2. Smooth gliding active indicator pill
  if (navIndicatorX !== null && navIndicatorW !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(navIndicatorX - 1.5, topY - 1, navIndicatorW + 3, pillH + 2, 12);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.24)';
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(navIndicatorX, topY, navIndicatorW, pillH, 11);
    const blueGrad = ctx.createLinearGradient(navIndicatorX, topY, navIndicatorX, topY + pillH);
    blueGrad.addColorStop(0, '#3b82f6');
    blueGrad.addColorStop(1, '#1d4ed8');
    ctx.fillStyle = blueGrad;
    ctx.fill();
    ctx.restore();
  }

  // 3. Tab text labels & button registration
  itemLayouts.forEach(({ item, px, pillW, isCur }) => {
    const isHov = hoveredButtonId === item.id;
    ctx.font = isCur ? '700 10px "Segoe UI Variable Text", Inter, sans-serif' : '600 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#f4f4f5' : '#a1a1aa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, px + pillW / 2, topY + pillH / 2);

    interactiveButtons.push({ id: item.id, x: px, y: topY, w: pillW, h: pillH });
  });

  // Dedicated Exit Application Button (✕) on the far right
  const exitW = 22;
  const exitH = 22;
  const exitX = x + w - exitW - 16;
  const isExitHov = hoveredButtonId === 'btn_top_exit';

  // Display Mode Quick Switcher immediately to the left of the Exit Button
  const modeW = 78;
  const modeH = 22;
  const modeX = exitX - modeW - 6;
  const isModeHov = hoveredButtonId === 'toggle_display_mode';

  ctx.beginPath();
  ctx.roundRect(modeX, topY, modeW, modeH, 11);
  ctx.fillStyle = isModeHov ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();

  // Monochrome black & white vector island / notch emblem
  const iconCx = modeX + 13;
  const iconCy = topY + modeH / 2;
  ctx.save();
  if (displayMode === 'island') {
    ctx.beginPath();
    ctx.roundRect(iconCx - 7, iconCy - 3.5, 14, 7, 3.5);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(iconCx - 2.5, iconCy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.roundRect(iconCx - 7, iconCy - 4, 14, 8, [0, 0, 3, 3]);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(iconCx, iconCy - 1, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  }
  ctx.restore();

  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayMode === 'island' ? 'Notch' : 'Island', iconCx + 11, topY + modeH / 2);
  interactiveButtons.push({ id: 'toggle_display_mode', x: modeX, y: topY, w: modeW, h: modeH });

  // Draw Exit Application Button (✕)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(exitX, topY, exitW, exitH, 11);
  ctx.fillStyle = isExitHov ? 'rgba(239, 68, 68, 0.88)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  if (!isExitHov) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isExitHov ? '#ffffff' : '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✕', exitX + exitW / 2, topY + exitH / 2);
  ctx.restore();

  interactiveButtons.push({ id: 'btn_top_exit', x: exitX, y: topY, w: exitW, h: exitH });
}

function renderCalendarWidget(calX, calY, calW, calH) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();
  const todayDate = now.getDate();
  const monthName = now.toLocaleDateString([], { month: 'short' }).toUpperCase();

  // 1. Card Container & Subtle Glass Rim
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(calX, calY, calW, calH, 12);
  ctx.fillStyle = 'rgba(24, 24, 32, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // 2. Month Header (e.g. "NOV")
  ctx.font = '700 12px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(monthName, calX + 13, calY + 11);

  // 3. Days Grid Calculation
  const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
  const firstDayIndex = new Date(curYear, curMonth, 1).getDay(); // 0 = Sunday

  const gridStartX = calX + 13;
  const gridStartY = calY + 31;
  const colStep = (calW - 26) / 7;
  const rowStep = (calH - 35) / 5.2;

  ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let d = 1; d <= daysInMonth; d++) {
    const cellIdx = (d - 1) + firstDayIndex;
    const col = cellIdx % 7;
    const row = Math.floor(cellIdx / 7);

    const cx = gridStartX + col * colStep + colStep / 2;
    const cy = gridStartY + row * rowStep + rowStep / 2;
    const dateKey = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayNotes = calendarNotes.filter(n => matchesCalendarDate(n, dateKey));
    const eventColor = dayNotes.length > 0 ? (dayNotes[0].color || '#3b82f6') : null;

    if (d === todayDate) {
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fillStyle = eventColor || '#2563eb';
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(d), cx, cy);
    } else if (eventColor) {
      ctx.beginPath();
      ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = colorWithAlpha(eventColor, 0.28);
      ctx.fill();
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(String(d), cx, cy);
    } else {
      ctx.fillStyle = d < todayDate ? '#94a3b8' : '#e2e8f0';
      ctx.fillText(String(d), cx, cy);
    }
  }

  ctx.restore();
  interactiveButtons.push({ id: 'nav_calendar', x: calX, y: calY, w: calW, h: calH });
}

function drawRecurrenceIcon(c, repeat, cx, cy, color) {
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 1.25;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const r = 3.4;
  if (repeat === 'yearly') {
    c.beginPath();
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const inAng = ang + Math.PI / 5;
      const ox = cx + Math.cos(ang) * (r + 0.6);
      const oy = cy + Math.sin(ang) * (r + 0.6);
      const ix = cx + Math.cos(inAng) * (r * 0.45);
      const iy = cy + Math.sin(inAng) * (r * 0.45);
      if (i === 0) c.moveTo(ox, oy); else c.lineTo(ox, oy);
      c.lineTo(ix, iy);
    }
    c.closePath();
    c.stroke();
  } else if (repeat === 'monthly') {
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI * 0.75, Math.PI * 0.85);
    c.stroke();
    c.beginPath();
    c.moveTo(cx + r * 0.55, cy - r * 0.85);
    c.lineTo(cx + r * 0.95, cy - r * 0.25);
    c.lineTo(cx + r * 0.25, cy - r * 0.2);
    c.stroke();
  } else if (repeat === 'weekly') {
    c.beginPath();
    c.roundRect(cx - r, cy - r + 0.6, r * 2, r * 2 - 0.8, 1.2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx - r, cy - 0.6);
    c.lineTo(cx + r, cy - 0.6);
    c.stroke();
  } else if (repeat === 'daily') {
    c.beginPath();
    c.arc(cx, cy, 1.8, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(cx, cy - r); c.lineTo(cx, cy - r + 1.1);
    c.moveTo(cx, cy + r); c.lineTo(cx, cy + r - 1.1);
    c.moveTo(cx - r, cy); c.lineTo(cx - r + 1.1, cy);
    c.moveTo(cx + r, cy); c.lineTo(cx + r - 1.1, cy);
    c.stroke();
  } else {
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, 1.1, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// =============================================================
// 1. DEDICATED CALENDAR TAB VIEW (Interactive Month Grid + Date Notes + Recurrence)
// =============================================================
function renderCalendarTabView(x, y, w, h) {
  const topY = y + 42;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const curDateObj = new Date(calendarViewYear, calendarViewMonth, 1);
  const monthName = curDateObj.toLocaleDateString([], { month: 'long' });

  // --- Left Column: Interactive Month Grid & Navigation ---
  const leftW = 310;
  const leftX = contentX;

  // Month navigation bar
  const navH = 22;
  const navY = topY;

  // Prev Month Button
  const prevBtnW = 22;
  const isPrevHov = hoveredButtonId === 'cal_prev_month';
  ctx.beginPath();
  ctx.roundRect(leftX, navY, prevBtnW, navH, 6);
  ctx.fillStyle = isPrevHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.05)';
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = isPrevHov ? '#ffffff' : '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(leftX + prevBtnW / 2 + 2, navY + navH / 2 - 3.5);
  ctx.lineTo(leftX + prevBtnW / 2 - 2, navY + navH / 2);
  ctx.lineTo(leftX + prevBtnW / 2 + 2, navY + navH / 2 + 3.5);
  ctx.stroke();
  ctx.restore();
  interactiveButtons.push({ id: 'cal_prev_month', x: leftX, y: navY, w: prevBtnW, h: navH });

  // Month Title
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${monthName} ${calendarViewYear}`, leftX + 30, navY + navH / 2);

  // Next Month Button
  const nextBtnX = leftX + 168;
  const isNextHov = hoveredButtonId === 'cal_next_month';
  ctx.beginPath();
  ctx.roundRect(nextBtnX, navY, prevBtnW, navH, 6);
  ctx.fillStyle = isNextHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.05)';
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = isNextHov ? '#ffffff' : '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(nextBtnX + prevBtnW / 2 - 2, navY + navH / 2 - 3.5);
  ctx.lineTo(nextBtnX + prevBtnW / 2 + 2, navY + navH / 2);
  ctx.lineTo(nextBtnX + prevBtnW / 2 - 2, navY + navH / 2 + 3.5);
  ctx.stroke();
  ctx.restore();
  interactiveButtons.push({ id: 'cal_next_month', x: nextBtnX, y: navY, w: prevBtnW, h: navH });

  // Compact Today Jump Pill
  const todayBtnW = 38;
  const todayBtnH = 18;
  const todayBtnX = leftX + leftW - todayBtnW;
  const todayBtnY = navY + (navH - todayBtnH) / 2;
  const isTodayHov = hoveredButtonId === 'cal_today';
  ctx.beginPath();
  ctx.roundRect(todayBtnX, todayBtnY, todayBtnW, todayBtnH, 5);
  ctx.fillStyle = isTodayHov ? '#2563eb' : 'rgba(37, 99, 235, 0.16)';
  ctx.strokeStyle = isTodayHov ? '#3b82f6' : 'rgba(59, 130, 246, 0.35)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isTodayHov ? '#ffffff' : '#93c5fd';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Today', todayBtnX + todayBtnW / 2, todayBtnY + todayBtnH / 2);
  interactiveButtons.push({ id: 'cal_today', x: todayBtnX, y: todayBtnY, w: todayBtnW, h: todayBtnH });

  // Weekdays Row
  const daysHeaderY = navY + 30;
  const daysShort = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const colW = leftW / 7;

  ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  daysShort.forEach((d, i) => {
    ctx.fillText(d, leftX + i * colW + colW / 2, daysHeaderY);
  });

  // Month Date Grid calculation
  const gridStartY = daysHeaderY + 12;
  const rowH = 34;
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
  const rawFirstDay = new Date(calendarViewYear, calendarViewMonth, 1).getDay();
  const firstCol = (rawFirstDay + 6) % 7;
  const pillSize = 24;

  // Locate target selected cell for smooth gliding pill interpolation
  let targetSelX = null;
  let targetSelY = null;
  let selectedEventColor = '#2563eb';
  for (let day = 1; day <= daysInMonth; day++) {
    const curCellDateStr = `${calendarViewYear}-${String(calendarViewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (curCellDateStr === calendarSelectedDate) {
      const idx = (day - 1) + firstCol;
      const col = idx % 7;
      const row = Math.floor(idx / 7);
      targetSelX = leftX + col * colW + (colW - pillSize) / 2;
      targetSelY = gridStartY + row * rowH + 2;
      const selNotes = calendarNotes.filter(n => matchesCalendarDate(n, curCellDateStr));
      if (selNotes.length > 0 && selNotes[0].color) {
        selectedEventColor = selNotes[0].color;
      }
      break;
    }
  }

  if (targetSelX !== null && targetSelY !== null) {
    if (calSelAnimX === null || calSelAnimY === null || reducedMotionEnabled || liteModeEnabled) {
      calSelAnimX = targetSelX;
      calSelAnimY = targetSelY;
      isCalDateAnimating = false;
    } else {
      const k = Math.min(1.0, (currentDt || 0.016) * 18.0 * (animSpeedMultiplier || 1.0));
      calSelAnimX += (targetSelX - calSelAnimX) * k;
      calSelAnimY += (targetSelY - calSelAnimY) * k;
      if (Math.hypot(targetSelX - calSelAnimX, targetSelY - calSelAnimY) < 0.25) {
        calSelAnimX = targetSelX;
        calSelAnimY = targetSelY;
        isCalDateAnimating = false;
      } else {
        isCalDateAnimating = true;
      }
    }
  } else {
    isCalDateAnimating = false;
  }

  // Pass 1: Event cell tints, hover highlights, and Today ring
  for (let day = 1; day <= daysInMonth; day++) {
    const idx = (day - 1) + firstCol;
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    const cx = leftX + col * colW;
    const cy = gridStartY + row * rowH;
    const curCellDateStr = `${calendarViewYear}-${String(calendarViewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isSelected = curCellDateStr === calendarSelectedDate;
    const isToday = curCellDateStr === todayStr;
    const cellBtnId = `cal_day_${curCellDateStr}`;
    const isCellHov = hoveredButtonId === cellBtnId;
    const px = cx + (colW - pillSize) / 2;
    const py = cy + 2;

    const cellNotes = calendarNotes.filter(n => matchesCalendarDate(n, curCellDateStr));
    const eventColor = cellNotes.length > 0 ? (cellNotes[0].color || '#3b82f6') : null;

    if (!isSelected && eventColor) {
      ctx.beginPath();
      ctx.roundRect(px, py, pillSize, pillSize, 7);
      ctx.fillStyle = colorWithAlpha(eventColor, isCellHov ? 0.34 : 0.22);
      ctx.fill();
      ctx.strokeStyle = colorWithAlpha(eventColor, 0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (!isSelected && isCellHov) {
      ctx.beginPath();
      ctx.roundRect(px, py, pillSize, pillSize, 7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.fill();
    }

    if (isToday && !isSelected) {
      ctx.beginPath();
      ctx.roundRect(px, py, pillSize, pillSize, 7);
      ctx.strokeStyle = eventColor || '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Pass 2: Smooth gliding active selection pill
  if (targetSelX !== null && targetSelY !== null && calSelAnimX !== null && calSelAnimY !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(calSelAnimX, calSelAnimY, pillSize, pillSize, 7);
    ctx.fillStyle = selectedEventColor;
    ctx.fill();
    ctx.restore();
  }

  // Pass 3: Day numbers, event color dots, and hitboxes
  for (let day = 1; day <= daysInMonth; day++) {
    const idx = (day - 1) + firstCol;
    const col = idx % 7;
    const row = Math.floor(idx / 7);
    const cx = leftX + col * colW;
    const cy = gridStartY + row * rowH;
    const curCellDateStr = `${calendarViewYear}-${String(calendarViewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isSelected = curCellDateStr === calendarSelectedDate;
    const isToday = curCellDateStr === todayStr;
    const cellBtnId = `cal_day_${curCellDateStr}`;
    const px = cx + (colW - pillSize) / 2;
    const py = cy + 2;

    const cellNotes = calendarNotes.filter(n => matchesCalendarDate(n, curCellDateStr));
    const eventColor = cellNotes.length > 0 ? (cellNotes[0].color || '#3b82f6') : null;

    ctx.font = isSelected || isToday ? '700 11px "Segoe UI Variable Display", Inter, sans-serif' : '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isSelected ? '#ffffff' : (isToday ? '#38bdf8' : (eventColor ? '#f8fafc' : '#e2e8f0'));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(day), px + pillSize / 2, py + pillSize / 2);

    if (eventColor) {
      ctx.beginPath();
      ctx.arc(px + pillSize / 2, py + pillSize + 3.5, 2, 0, Math.PI * 2);
      ctx.fillStyle = eventColor;
      ctx.fill();
    }

    interactiveButtons.push({ id: cellBtnId, data: curCellDateStr, x: cx, y: cy, w: colW, h: rowH });
  }

  // --- Right Column: Date Details & Note List (with smooth date-switch slide/fade) ---
  const rightX = leftX + leftW + 16;
  const rightW = contentW - (leftW + 16);

  const selObj = new Date(calendarSelectedDate + 'T00:00:00');
  const selTitle = isNaN(selObj.getTime()) ? calendarSelectedDate : selObj.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(selTitle, rightX, navY + navH / 2);

  // + Note Button
  const addNoteW = 58;
  const addNoteH = 20;
  const addNoteX = rightX + rightW - addNoteW;
  const addNoteY = navY + (navH - addNoteH) / 2;
  const isAddNoteHov = hoveredButtonId === 'cal_add_note_btn';
  ctx.beginPath();
  ctx.roundRect(addNoteX, addNoteY, addNoteW, addNoteH, 6);
  ctx.fillStyle = isAddNoteHov ? '#2563eb' : 'rgba(255, 255, 255, 0.08)';
  ctx.strokeStyle = isAddNoteHov ? '#3b82f6' : 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isAddNoteHov ? '#ffffff' : '#f4f4f5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+ Event', addNoteX + addNoteW / 2, addNoteY + addNoteH / 2);
  interactiveButtons.push({ id: 'cal_add_note_btn', x: addNoteX, y: addNoteY, w: addNoteW, h: addNoteH });

  // Notes List transition progress
  const notesElapsed = (reducedMotionEnabled || liteModeEnabled || calNotesAnimStart === 0)
    ? 1.0
    : Math.min(1.0, (performance.now() - calNotesAnimStart) / 220);
  const notesEase = 1 - Math.pow(1 - notesElapsed, 3);
  const notesSlideY = (1 - notesEase) * 8 * calNotesAnimDir;

  const notesListY = navY + 30;
  const activeNotes = calendarNotes.filter(n => matchesCalendarDate(n, calendarSelectedDate));

  ctx.save();
  ctx.globalAlpha = notesEase;
  ctx.translate(0, notesSlideY);

  if (activeNotes.length === 0) {
    ctx.beginPath();
    ctx.roundRect(rightX, notesListY, rightW, 210, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Clean vector calendar glyph (zero emoji)
    const gx = rightX + rightW / 2;
    const gy = notesListY + 84;
    ctx.save();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.roundRect(gx - 10, gy - 8, 20, 18, 4);
    ctx.moveTo(gx - 10, gy - 2);
    ctx.lineTo(gx + 10, gy - 2);
    ctx.moveTo(gx - 5, gy - 11);
    ctx.lineTo(gx - 5, gy - 6);
    ctx.moveTo(gx + 5, gy - 11);
    ctx.lineTo(gx + 5, gy - 6);
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('No events for this date', gx, notesListY + 116);
  } else {
    const cardGap = 8;
    const maxVisible = Math.min(activeNotes.length, 4);
    let curNY = notesListY;

    for (let i = 0; i < maxVisible; i++) {
      const note = activeNotes[i];
      const hasDesc = Boolean(note.description && String(note.description).trim());
      const cardH = hasDesc ? 56 : 44;
      const ny = curNY;
      curNY += cardH + cardGap;

      const noteColor = note.color || '#3b82f6';
      const isCardHov = hoveredButtonId === `cal_note_${note.id}`;

      ctx.beginPath();
      ctx.roundRect(rightX, ny, rightW, cardH, 8);
      ctx.fillStyle = isCardHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
      ctx.strokeStyle = isCardHov ? colorWithAlpha(noteColor, 0.5) : 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Left color accent bar
      ctx.beginPath();
      ctx.roundRect(rightX + 3, ny + 6, 3, cardH - 12, 1.5);
      ctx.fillStyle = noteColor;
      ctx.fill();

      // Meta row: custom vector recurrence icon + repeat label + category dot/label
      const rep = note.repeat || 'none';
      const repLabel = rep === 'yearly' ? 'Yearly' : (rep === 'monthly' ? 'Monthly' : (rep === 'weekly' ? 'Weekly' : (rep === 'daily' ? 'Daily' : 'Once')));
      const catLabel = note.category || 'General';

      drawRecurrenceIcon(ctx, rep, rightX + 16, ny + 12, noteColor);
      ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = noteColor;
      ctx.fillText(repLabel, rightX + 24, ny + 12);
      const repW = ctx.measureText(repLabel).width;

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`• ${catLabel}`, rightX + 28 + repW, ny + 12);

      // Event Title
      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#f4f4f5';
      ctx.textBaseline = 'top';
      const maxTextW = rightW - 44;
      ctx.fillText(truncateToWidth(note.text, maxTextW, ctx.font), rightX + 12, ny + 22);

      // Optional Description
      if (hasDesc) {
        ctx.font = '400 9.5px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(truncateToWidth(String(note.description), maxTextW, ctx.font), rightX + 12, ny + 38);
      }

      // Delete button
      const delW = 18;
      const delH = 18;
      const delX = rightX + rightW - delW - 8;
      const delY = ny + (cardH - delH) / 2;
      const isDelHov = hoveredButtonId === `cal_del_${note.id}`;

      ctx.beginPath();
      ctx.roundRect(delX, delY, delW, delH, 4);
      ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.25)' : 'transparent';
      ctx.fill();

      ctx.font = '600 10px sans-serif';
      ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', delX + delW / 2, delY + delH / 2);
      interactiveButtons.push({ id: `cal_del_${note.id}`, data: note.id, x: delX, y: delY, w: delW, h: delH });
    }
  }
  ctx.restore();
}

// =============================================================
// 2. DEDICATED CLOCK TAB VIEW (Timer Presets + Stopwatch + Focus Mode)
// =============================================================
function adjustTimerHours(delta) {
  let total = Math.max(0, Math.round(timerRemainingSec));
  let h = Math.floor(total / 3600);
  let m = Math.floor((total % 3600) / 60);
  let s = total % 60;
  h = Math.max(0, Math.min(23, h + delta));
  const newSec = h * 3600 + m * 60 + s;
  timerDurationSec = newSec;
  timerRemainingSec = newSec;
}

function adjustTimerMins(delta) {
  let total = Math.max(0, Math.round(timerRemainingSec));
  let h = Math.floor(total / 3600);
  let m = Math.floor((total % 3600) / 60);
  let s = total % 60;
  m = m + delta;
  if (m < 0) {
    if (h > 0) { h--; m += 60; } else { m = 0; }
  } else if (m >= 60) {
    if (h < 23) { h++; m -= 60; } else { m = 59; }
  }
  const newSec = h * 3600 + m * 60 + s;
  timerDurationSec = newSec;
  timerRemainingSec = newSec;
}

function adjustTimerSecs(delta) {
  let total = Math.max(0, Math.round(timerRemainingSec));
  let h = Math.floor(total / 3600);
  let m = Math.floor((total % 3600) / 60);
  let s = total % 60;
  s = s + delta;
  if (s < 0) {
    if (m > 0 || h > 0) {
      if (m > 0) m--; else { h--; m = 59; }
      s += 60;
    } else { s = 0; }
  } else if (s >= 60) {
    if (m < 59 || h < 23) {
      if (m < 59) m++; else { h++; m = 0; }
      s -= 60;
    } else { s = 59; }
  }
  const newSec = h * 3600 + m * 60 + s;
  timerDurationSec = newSec;
  timerRemainingSec = newSec;
}

function renderClockTabView(x, y, w, h) {
  const topY = y + 42;
  const padding = 20;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // Sub-mode switcher pills at top: [ Timer ] [ Stopwatch ] [ Focus Mode ] [ Alarm ] (zero emojis)
  const modes = [
    { id: 'timer', label: 'Timer', w: 72 },
    { id: 'stopwatch', label: 'Stopwatch', w: 86 },
    { id: 'focus', label: 'Focus Mode', w: 92 },
    { id: 'alarm', label: 'Alarm', w: 72 }
  ];
  const modeH = 22;
  let curX = contentX;

  modes.forEach(m => {
    const isCur = clockSubMode === m.id;
    const isHov = hoveredButtonId === `clock_submode_${m.id}`;
    ctx.beginPath();
    ctx.roundRect(curX, topY, m.w, modeH, 6);
    ctx.fillStyle = isCur ? '#2563eb' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
    ctx.fill();

    ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#f4f4f5' : '#a1a1aa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.label, curX + m.w / 2, topY + modeH / 2);

    interactiveButtons.push({ id: `clock_submode_${m.id}`, x: curX, y: topY, w: m.w, h: modeH });
    curX += m.w + 8;
  });

  const stageY = topY + 34;

  if (clockSubMode === 'timer') {
    const totalSec = Math.max(0, Math.round(timerRemainingSec));
    const curH = Math.floor(totalSec / 3600);
    const curM = Math.floor((totalSec % 3600) / 60);
    const curS = totalSec % 60;

    // Interactive Digit Dial Columns
    const midX = contentX + contentW / 2;
    const colW = 58;
    const colH = 64;
    const sepW = 16;
    const totalColsW = colW * 3 + sepW * 2;
    const startColX = midX - totalColsW / 2;

    const cols = [
      { id: 'h', val: String(curH).padStart(2, '0'), label: 'HOURS', x: startColX },
      { id: 'm', val: String(curM).padStart(2, '0'), label: 'MINUTES', x: startColX + colW + sepW },
      { id: 's', val: String(curS).padStart(2, '0'), label: 'SECONDS', x: startColX + (colW + sepW) * 2 }
    ];

    cols.forEach((col, idx) => {
      const isColHov = hoveredButtonId === `timer_col_${col.id}` || hoveredButtonId === `timer_inc_${col.id}` || hoveredButtonId === `timer_dec_${col.id}`;

      // Column background card
      ctx.beginPath();
      ctx.roundRect(col.x, stageY, colW, colH, 8);
      ctx.fillStyle = isColHov ? 'rgba(56, 189, 248, 0.12)' : 'rgba(255, 255, 255, 0.05)';
      ctx.strokeStyle = isColHov ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Top Stepper [ ▲ ]
      const isIncHov = hoveredButtonId === `timer_inc_${col.id}`;
      ctx.beginPath();
      ctx.roundRect(col.x + 4, stageY + 3, colW - 8, 14, 3);
      ctx.fillStyle = isIncHov ? 'rgba(255, 255, 255, 0.18)' : 'transparent';
      ctx.fill();
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = isIncHov ? '#ffffff' : '#94a3b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲', col.x + colW / 2, stageY + 10);
      interactiveButtons.push({ id: `timer_inc_${col.id}`, data: col.id, x: col.x + 4, y: stageY + 3, w: colW - 8, h: 14 });

      // Digit Value with Rolling Tumbler Lock Wheel Animation
      drawRollingTime(ctx, `timer_col_${col.id}`, col.val, col.x + colW / 2, stageY + 32, {
        font: '700 26px "Segoe UI Variable Display", Inter, sans-serif',
        fillStyle: timerRunning ? '#38bdf8' : (isColHov ? '#ffffff' : '#f1f5f9'),
        align: 'center',
        baseline: 'middle',
        isHovered: isColHov
      });

      // Bottom Stepper [ ▼ ]
      const isDecHov = hoveredButtonId === `timer_dec_${col.id}`;
      ctx.beginPath();
      ctx.roundRect(col.x + 4, stageY + colH - 17, colW - 8, 14, 3);
      ctx.fillStyle = isDecHov ? 'rgba(255, 255, 255, 0.18)' : 'transparent';
      ctx.fill();
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = isDecHov ? '#ffffff' : '#94a3b8';
      ctx.fillText('▼', col.x + colW / 2, stageY + colH - 10);
      interactiveButtons.push({ id: `timer_dec_${col.id}`, data: col.id, x: col.x + 4, y: stageY + colH - 17, w: colW - 8, h: 14 });

      // Interactive hit area for mouse wheel scrolling
      interactiveButtons.push({ id: `timer_col_${col.id}`, data: col.id, x: col.x, y: stageY, w: colW, h: colH });

      // Column Sub-Label
      ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText(col.label, col.x + colW / 2, stageY + colH + 9);

      // Separator colon ':'
      if (idx < 2) {
        ctx.font = '700 22px "Segoe UI Variable Display", sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText(':', col.x + colW + sepW / 2, stageY + 31);
      }
    });

    // Helper hint text
    ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#71717a';
    ctx.fillText('Scroll mouse wheel on digits or click ▲ / ▼ to dial duration', midX, stageY + colH + 24);

    // Preset chips row: 1m, 5m, 15m, 25m, 45m, 60m
    const presets = [
      { sec: 60, label: '1m' },
      { sec: 300, label: '5m' },
      { sec: 900, label: '15m' },
      { sec: 1500, label: '25m' },
      { sec: 2700, label: '45m' },
      { sec: 3600, label: '60m' }
    ];
    const pW = 44;
    const pH = 20;
    const pSpacing = 8;
    const totalPW = presets.length * pW + (presets.length - 1) * pSpacing;
    const startPX = contentX + (contentW - totalPW) / 2;
    const pY = stageY + colH + 37;

    presets.forEach((pr, i) => {
      const bx = startPX + i * (pW + pSpacing);
      const isHov = hoveredButtonId === `timer_preset_${pr.sec}`;
      const isMatch = timerDurationSec === pr.sec && !timerRunning;
      ctx.beginPath();
      ctx.roundRect(bx, pY, pW, pH, 5);
      ctx.fillStyle = isMatch ? 'rgba(56, 189, 248, 0.25)' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
      ctx.strokeStyle = isMatch ? '#38bdf8' : 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isMatch ? '#38bdf8' : (isHov ? '#ffffff' : '#cbd5e1');
      ctx.textAlign = 'center';
      ctx.fillText(pr.label, bx + pW / 2, pY + pH / 2);
      interactiveButtons.push({ id: `timer_preset_${pr.sec}`, data: pr.sec, x: bx, y: pY, w: pW, h: pH });
    });

    // Control buttons: [ Start / Pause ] [ Reset ] [ Clear ]
    const btnRowY = pY + 28;
    const ctlH = 28;

    const startW = 100;
    const rstW = 64;
    const clrW = 64;
    const gap = 10;
    const totalCtlW = startW + rstW + clrW + gap * 2;
    const startX = contentX + (contentW - totalCtlW) / 2;

    const isStartHov = hoveredButtonId === 'timer_start_pause';
    ctx.beginPath();
    ctx.roundRect(startX, btnRowY, startW, ctlH, 7);
    ctx.fillStyle = timerRunning ? '#ef4444' : '#2563eb';
    ctx.fill();
    ctx.font = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(timerRunning ? '❚❚ Pause' : '▶ Start', startX + startW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'timer_start_pause', x: startX, y: btnRowY, w: startW, h: ctlH });

    const rstX = startX + startW + gap;
    const isRstHov = hoveredButtonId === 'timer_reset';
    ctx.beginPath();
    ctx.roundRect(rstX, btnRowY, rstW, ctlH, 7);
    ctx.fillStyle = isRstHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isRstHov ? '#ffffff' : '#cbd5e1';
    ctx.fillText('Reset', rstX + rstW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'timer_reset', x: rstX, y: btnRowY, w: rstW, h: ctlH });

    const clrX = rstX + rstW + gap;
    const isClrHov = hoveredButtonId === 'timer_clear';
    ctx.beginPath();
    ctx.roundRect(clrX, btnRowY, clrW, ctlH, 7);
    ctx.fillStyle = isClrHov ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isClrHov ? '#fca5a5' : '#cbd5e1';
    ctx.fillText('Clear', clrX + clrW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'timer_clear', x: clrX, y: btnRowY, w: clrW, h: ctlH });

  } else if (clockSubMode === 'stopwatch') {
    // Millisecond Stopwatch
    const swTimeStr = formatStopwatchMs(stopwatchElapsedMs);
    ctx.font = '700 44px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = stopwatchRunning ? '#22c55e' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(swTimeStr, contentX + contentW / 2, stageY + 36);

    // Controls: [ Start / Stop ] [ Lap ] [ Reset ]
    const btnRowY = stageY + 82;
    const ctlH = 30;

    const startW = 100;
    const startX = contentX + (contentW - (startW + 80 + 80 + 16)) / 2;
    const isStartHov = hoveredButtonId === 'sw_start_pause';
    ctx.beginPath();
    ctx.roundRect(startX, btnRowY, startW, ctlH, 8);
    ctx.fillStyle = stopwatchRunning ? '#ef4444' : '#22c55e';
    ctx.fill();
    ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(stopwatchRunning ? '❚❚ Stop' : '▶ Start', startX + startW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'sw_start_pause', x: startX, y: btnRowY, w: startW, h: ctlH });

    // Lap button
    const lapW = 74;
    const lapX = startX + startW + 8;
    const isLapHov = hoveredButtonId === 'sw_lap';
    ctx.beginPath();
    ctx.roundRect(lapX, btnRowY, lapW, ctlH, 8);
    ctx.fillStyle = isLapHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isLapHov ? '#ffffff' : '#cbd5e1';
    ctx.fillText('Lap', lapX + lapW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'sw_lap', x: lapX, y: btnRowY, w: lapW, h: ctlH });

    // Reset button
    const rstW = 74;
    const rstX = lapX + lapW + 8;
    const isRstHov = hoveredButtonId === 'sw_reset';
    ctx.beginPath();
    ctx.roundRect(rstX, btnRowY, rstW, ctlH, 8);
    ctx.fillStyle = isRstHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isRstHov ? '#ffffff' : '#cbd5e1';
    ctx.fillText('Reset', rstX + rstW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'sw_reset', x: rstX, y: btnRowY, w: rstW, h: ctlH });

    // Laps preview summary below controls
    if (stopwatchLaps.length > 0) {
      const lastLap = stopwatchLaps[stopwatchLaps.length - 1];
      ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Lap ${stopwatchLaps.length}: ${formatStopwatchMs(lastLap.time)} • Total Laps: ${stopwatchLaps.length}`, contentX + contentW / 2, btnRowY + ctlH + 18);
    }

  } else if (clockSubMode === 'focus') {
    const isBreak = focusMode !== 'work';
    const focusStr = formatTimerSeconds(focusRemainingSec);
    const midX = contentX + contentW / 2;

    // 1. Goal Tags Row (Deep Work, Coding, Study, Writing, Reading)
    const goalTags = ['Deep Work', 'Coding', 'Study', 'Writing', 'Reading'];
    const tagH = 20;
    const tagW = 68;
    const tagSpacing = 6;
    const totalTagsW = goalTags.length * tagW + (goalTags.length - 1) * tagSpacing;
    let tagCurX = contentX + (contentW - totalTagsW) / 2;

    goalTags.forEach(gt => {
      const isSel = focusGoalTag === gt;
      const isHov = hoveredButtonId === `focus_goal_${gt}`;
      ctx.beginPath();
      ctx.roundRect(tagCurX, stageY, tagW, tagH, 5);
      ctx.fillStyle = isSel ? 'rgba(56, 189, 248, 0.25)' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
      ctx.strokeStyle = isSel ? '#38bdf8' : 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isSel ? '#38bdf8' : (isHov ? '#ffffff' : '#94a3b8');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(gt, tagCurX + tagW / 2, stageY + tagH / 2);
      interactiveButtons.push({ id: `focus_goal_${gt}`, data: gt, x: tagCurX, y: stageY, w: tagW, h: tagH });
      tagCurX += tagW + tagSpacing;
    });

    // 2. Mode Title & Countdown Readout
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isBreak ? '#10b981' : '#f59e0b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isBreak ? `Break (${focusBreakDurationMin}m)` : `${focusGoalTag} (${focusWorkDurationMin}m)`, midX, stageY + 31);

    ctx.font = '700 42px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = focusRunning ? (isBreak ? '#34d399' : '#38bdf8') : '#ffffff';
    ctx.fillText(focusStr, midX, stageY + 62);

    // 3. Customizable Duration Selector Rows (Work & Break Pills)
    const workPills = [15, 20, 25, 30, 45, 60];
    const breakPills = [3, 5, 10];
    const rowY = stageY + 89;
    const pillH = 18;

    // Label: Focus Duration
    ctx.font = '500 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText('Focus:', midX - 90, rowY + pillH / 2);

    let wCurX = midX - 82;
    workPills.forEach(wp => {
      const isCur = focusWorkDurationMin === wp;
      const isHov = hoveredButtonId === `focus_work_dur_${wp}`;
      ctx.beginPath();
      ctx.roundRect(wCurX, rowY, 30, pillH, 4);
      ctx.fillStyle = isCur ? '#2563eb' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
      ctx.fill();
      ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#ffffff' : '#cbd5e1');
      ctx.textAlign = 'center';
      ctx.fillText(`${wp}m`, wCurX + 15, rowY + pillH / 2);
      interactiveButtons.push({ id: `focus_work_dur_${wp}`, data: wp, x: wCurX, y: rowY, w: 30, h: pillH });
      wCurX += 30 + 4;
    });

    // Label: Break Duration
    ctx.font = '500 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText('Break:', midX + 140, rowY + pillH / 2);

    let bCurX = midX + 148;
    breakPills.forEach(bp => {
      const isCur = focusBreakDurationMin === bp;
      const isHov = hoveredButtonId === `focus_break_dur_${bp}`;
      ctx.beginPath();
      ctx.roundRect(bCurX, rowY, 28, pillH, 4);
      ctx.fillStyle = isCur ? '#10b981' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
      ctx.fill();
      ctx.font = '600 9px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#ffffff' : '#cbd5e1');
      ctx.textAlign = 'center';
      ctx.fillText(`${bp}m`, bCurX + 14, rowY + pillH / 2);
      interactiveButtons.push({ id: `focus_break_dur_${bp}`, data: bp, x: bCurX, y: rowY, w: 28, h: pillH });
      bCurX += 28 + 4;
    });

    // 4. Session count & Controls row
    const btnRowY = stageY + 115;
    const ctlH = 26;
    const startW = 110;
    const skpW = 68;
    const rstW = 64;
    const gap = 8;
    const totalCtlW = startW + skpW + rstW + gap * 2;
    const startX = contentX + (contentW - totalCtlW) / 2;

    const isStartHov = hoveredButtonId === 'focus_start_pause';
    ctx.beginPath();
    ctx.roundRect(startX, btnRowY, startW, ctlH, 6);
    ctx.fillStyle = focusRunning ? '#ef4444' : '#2563eb';
    ctx.fill();
    ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(focusRunning ? '❚❚ Pause' : '▶ Start Focus', startX + startW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'focus_start_pause', x: startX, y: btnRowY, w: startW, h: ctlH });

    const skpX = startX + startW + gap;
    const isSkpHov = hoveredButtonId === 'focus_skip';
    ctx.beginPath();
    ctx.roundRect(skpX, btnRowY, skpW, ctlH, 6);
    ctx.fillStyle = isSkpHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isSkpHov ? '#ffffff' : '#cbd5e1';
    ctx.fillText('Skip ➔', skpX + skpW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'focus_skip', x: skpX, y: btnRowY, w: skpW, h: ctlH });

    const rstX = skpX + skpW + gap;
    const isRstHov = hoveredButtonId === 'focus_reset';
    ctx.beginPath();
    ctx.roundRect(rstX, btnRowY, rstW, ctlH, 6);
    ctx.fillStyle = isRstHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isRstHov ? '#ffffff' : '#cbd5e1';
    ctx.fillText('Reset', rstX + rstW / 2, btnRowY + ctlH / 2);
    interactiveButtons.push({ id: 'focus_reset', x: rstX, y: btnRowY, w: rstW, h: ctlH });
  } else if (clockSubMode === 'alarm') {
    // ---------------------------------------------------------
    // 4. CLOCK SUB-MODE: ALARM
    // ---------------------------------------------------------
    if (activeAlarmRinging) {
      // Ringing Alert Banner (pulsing red/amber glow)
      const bannerW = contentW;
      const bannerH = 140;
      const bannerX = contentX;
      const bannerY = stageY + 6;

      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 150);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(bannerX - 3, bannerY - 3, bannerW + 6, bannerH + 6, 15);
      ctx.fillStyle = `rgba(239, 68, 68, ${(0.12 + 0.14 * pulse).toFixed(3)})`;
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(bannerX, bannerY, bannerW, bannerH, 12);
      const ringGrad = ctx.createLinearGradient(bannerX, bannerY, bannerX, bannerY + bannerH);
      ringGrad.addColorStop(0.0, 'rgba(185, 28, 28, 0.45)');
      ringGrad.addColorStop(0.5, 'rgba(153, 27, 27, 0.35)');
      ringGrad.addColorStop(1.0, 'rgba(69, 10, 10, 0.45)');
      ctx.fillStyle = ringGrad;
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(248, 113, 113, ${0.6 + 0.3 * pulse})`;
      ctx.stroke();
      ctx.restore();

      // Pulsing Alarm Title (no emoji)
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#fca5a5';
      ctx.fillText('ALARM RINGING', bannerX + bannerW / 2, bannerY + 28);

      ctx.font = '700 36px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(activeAlarmRinging.timeStr, bannerX + bannerW / 2, bannerY + 65);
      ctx.restore();

      // Action Buttons: Snooze (+5m) & Dismiss
      const btnH = 32;
      const snzW = 130;
      const dsmW = 110;
      const btnGap = 12;
      const totalBtnW = snzW + dsmW + btnGap;
      const snzX = bannerX + (bannerW - totalBtnW) / 2;
      const dsmX = snzX + snzW + btnGap;
      const btnY = bannerY + 98;

      const isSnzHov = hoveredButtonId === 'alarm_snooze';
      ctx.beginPath();
      ctx.roundRect(snzX, btnY, snzW, btnH, 8);
      ctx.fillStyle = isSnzHov ? '#d97706' : '#f59e0b';
      ctx.fill();
      ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Snooze (+5m)', snzX + snzW / 2, btnY + btnH / 2);
      interactiveButtons.push({ id: 'alarm_snooze', x: snzX, y: btnY, w: snzW, h: btnH });

      const isDsmHov = hoveredButtonId === 'alarm_dismiss';
      ctx.beginPath();
      ctx.roundRect(dsmX, btnY, dsmW, btnH, 8);
      ctx.fillStyle = isDsmHov ? '#dc2626' : '#ef4444';
      ctx.fill();
      ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕ Dismiss', dsmX + dsmW / 2, btnY + btnH / 2);
      interactiveButtons.push({ id: 'alarm_dismiss', x: dsmX, y: btnY, w: dsmW, h: btnH });

    } else {
      // Normal Alarm View: [ Left Dial Picker ] + [ Right Saved Alarms List ]
      const dialCardW = 210;
      const dialCardH = 154;
      const dialCardX = contentX;
      const dialCardY = stageY + 2;

      // --- Left Card: Digital Dial Picker ---
      ctx.beginPath();
      ctx.roundRect(dialCardX, dialCardY, dialCardW, dialCardH, 10);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('Set Alarm Time', dialCardX + 14, dialCardY + 18);
      ctx.restore();

      // Hour Column
      const colW = 46;
      const colH = 58;
      const colY = dialCardY + 34;
      const hColX = dialCardX + 16;

      const isHColHov = hoveredButtonId === 'alarm_col_h' || hoveredButtonId === 'alarm_inc_h' || hoveredButtonId === 'alarm_dec_h';
      ctx.beginPath();
      ctx.roundRect(hColX, colY, colW, colH, 8);
      ctx.fillStyle = isHColHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.04)';
      ctx.strokeStyle = isHColHov ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Up arrow
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = hoveredButtonId === 'alarm_inc_h' ? '#38bdf8' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲', hColX + colW / 2, colY + 9);
      interactiveButtons.push({ id: 'alarm_inc_h', x: hColX, y: colY, w: colW, h: 16 });

      // Hour digit with rolling tumbler animation
      drawRollingTime(ctx, 'alarm_picker_h', String(alarmPickerHour).padStart(2, '0'), hColX + colW / 2, colY + colH / 2 + 1, {
        font: '700 22px "Segoe UI Variable Display", Inter, sans-serif',
        fillStyle: '#ffffff',
        align: 'center',
        baseline: 'middle',
        isHovered: isHColHov
      });

      // Down arrow
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = hoveredButtonId === 'alarm_dec_h' ? '#38bdf8' : '#71717a';
      ctx.fillText('▼', hColX + colW / 2, colY + colH - 9);
      interactiveButtons.push({ id: 'alarm_dec_h', x: hColX, y: colY + colH - 16, w: colW, h: 16 });
      interactiveButtons.push({ id: 'alarm_col_h', x: hColX, y: colY + 16, w: colW, h: colH - 32 });

      // Colon ':'
      ctx.font = '700 20px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(':', hColX + colW + 5, colY + colH / 2);

      // Minute Column
      const mColX = hColX + colW + 11;
      const isMColHov = hoveredButtonId === 'alarm_col_m' || hoveredButtonId === 'alarm_inc_m' || hoveredButtonId === 'alarm_dec_m';
      ctx.beginPath();
      ctx.roundRect(mColX, colY, colW, colH, 8);
      ctx.fillStyle = isMColHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.04)';
      ctx.strokeStyle = isMColHov ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Minute Up arrow
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = hoveredButtonId === 'alarm_inc_m' ? '#38bdf8' : '#71717a';
      ctx.fillText('▲', mColX + colW / 2, colY + 9);
      interactiveButtons.push({ id: 'alarm_inc_m', x: mColX, y: colY, w: colW, h: 16 });

      // Minute digit with rolling tumbler animation
      drawRollingTime(ctx, 'alarm_picker_m', String(alarmPickerMinute).padStart(2, '0'), mColX + colW / 2, colY + colH / 2 + 1, {
        font: '700 22px "Segoe UI Variable Display", Inter, sans-serif',
        fillStyle: '#ffffff',
        align: 'center',
        baseline: 'middle',
        isHovered: isMColHov
      });

      // Minute Down arrow
      ctx.font = '600 9px sans-serif';
      ctx.fillStyle = hoveredButtonId === 'alarm_dec_m' ? '#38bdf8' : '#71717a';
      ctx.fillText('▼', mColX + colW / 2, colY + colH - 9);
      interactiveButtons.push({ id: 'alarm_dec_m', x: mColX, y: colY + colH - 16, w: colW, h: 16 });
      interactiveButtons.push({ id: 'alarm_col_m', x: mColX, y: colY + 16, w: colW, h: colH - 32 });

      // AM / PM Toggle Capsule
      const ampmX = mColX + colW + 10;
      const ampmW = 48;
      const ampmH = 42;
      const ampmY = colY + (colH - ampmH) / 2;
      const isAmpmHov = hoveredButtonId === 'alarm_toggle_ampm';

      ctx.beginPath();
      ctx.roundRect(ampmX, ampmY, ampmW, ampmH, 8);
      ctx.fillStyle = isAmpmHov ? '#1d4ed8' : '#2563eb';
      ctx.strokeStyle = isAmpmHov ? '#60a5fa' : '#3b82f6';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.font = '700 13.5px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(alarmPickerAmPm, ampmX + ampmW / 2, ampmY + ampmH / 2);
      interactiveButtons.push({ id: 'alarm_toggle_ampm', x: ampmX, y: ampmY, w: ampmW, h: ampmH });

      // [ + Set Alarm ] Button
      const addBtnW = dialCardW - 32;
      const addBtnH = 28;
      const addBtnX = dialCardX + 16;
      const addBtnY = dialCardY + dialCardH - addBtnH - 14;
      const isAddHov = hoveredButtonId === 'alarm_add_btn';

      ctx.beginPath();
      ctx.roundRect(addBtnX, addBtnY, addBtnW, addBtnH, 6);
      ctx.fillStyle = isAddHov ? '#16a34a' : '#22c55e';
      ctx.fill();

      ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+ Set Alarm', addBtnX + addBtnW / 2, addBtnY + addBtnH / 2);
      interactiveButtons.push({ id: 'alarm_add_btn', x: addBtnX, y: addBtnY, w: addBtnW, h: addBtnH });

      // --- Right Card: Saved Alarms List ---
      const listCardX = dialCardX + dialCardW + 12;
      const listCardW = contentW - dialCardW - 12;
      const listCardH = dialCardH;
      const listCardY = dialCardY;

      ctx.beginPath();
      ctx.roundRect(listCardX, listCardY, listCardW, listCardH, 10);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.font = '600 11px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Scheduled Alarms (${alarmsList.length})`, listCardX + 14, listCardY + 18);
      ctx.restore();

      if (alarmsList.length === 0) {
        ctx.save();
        drawVectorSymbol(ctx, 'alarm', listCardX + listCardW / 2, listCardY + 62, 22, '#64748b');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('No alarms scheduled', listCardX + listCardW / 2, listCardY + 92);

        ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText('Use the dial on the left to set one', listCardX + listCardW / 2, listCardY + 112);
        ctx.restore();
      } else {
        const rowH = 32;
        const rowGap = 6;
        const maxRows = Math.min(alarmsList.length, 3);
        const startRowY = listCardY + 34;

        for (let i = 0; i < maxRows; i++) {
          const al = alarmsList[i];
          const ry = startRowY + i * (rowH + rowGap);
          const isRowHov = hoveredButtonId === `alarm_row_${al.id}`;

          ctx.beginPath();
          ctx.roundRect(listCardX + 10, ry, listCardW - 20, rowH, 7);
          ctx.fillStyle = isRowHov ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.03)';
          ctx.strokeStyle = isRowHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();

          // Alarm Icon & Time Text
          ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
          ctx.fillStyle = al.enabled ? '#ffffff' : '#71717a';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const timeText = `${String(al.hour).padStart(2, '0')}:${String(al.minute).padStart(2, '0')} ${al.ampm}`;
          ctx.fillText(`⏰ ${timeText}`, listCardX + 20, ry + rowH / 2);

          // Status label
          ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
          ctx.fillStyle = al.enabled ? '#38bdf8' : '#52525b';
          ctx.fillText(al.enabled ? 'Active' : 'Off', listCardX + 115, ry + rowH / 2);

          // Toggle Switch Capsule
          const swW = 34;
          const swH = 18;
          const swX = listCardX + listCardW - 20 - swW - 28;
          const swY = ry + (rowH - swH) / 2;

          ctx.beginPath();
          ctx.roundRect(swX, swY, swW, swH, 9);
          ctx.fillStyle = al.enabled ? '#22c55e' : 'rgba(255, 255, 255, 0.12)';
          ctx.fill();

          // Toggle Knob
          const knobR = 6.5;
          const knobX = al.enabled ? (swX + swW - knobR - 2.5) : (swX + knobR + 2.5);
          ctx.beginPath();
          ctx.arc(knobX, swY + swH / 2, knobR, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          interactiveButtons.push({ id: `alarm_toggle_${al.id}`, x: swX, y: swY, w: swW, h: swH });

          // Delete Button ✕
          const delW = 20;
          const delH = 20;
          const delX = listCardX + listCardW - 20 - delW;
          const delY = ry + (rowH - delH) / 2;
          const isDelHov = hoveredButtonId === `alarm_del_${al.id}`;

          ctx.beginPath();
          ctx.roundRect(delX, delY, delW, delH, 4);
          ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.25)' : 'transparent';
          ctx.fill();

          ctx.font = '600 10.5px sans-serif';
          ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✕', delX + delW / 2, delY + delH / 2);
          interactiveButtons.push({ id: `alarm_del_${al.id}`, x: delX, y: delY, w: delW, h: delH });
        }
      }
    }
  }
}

// =============================================================
// 3. DEDICATED TO-DO LIST TAB VIEW (Categories + Checklist + Strike-through)
// =============================================================
function renderTodoTabView(x, y, w, h) {
  const topY = y + 42;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // 0. 2-Tab Sub-Switcher: [ Notes ] [ To-Do ]
  const subTabs = [
    { id: 'notes', label: 'Notes', w: 58 },
    { id: 'todo', label: 'To-Do', w: 58 }
  ];
  const subH = 22;
  let subX = contentX;
  subTabs.forEach(st => {
    const isCur = notesSubMode === st.id;
    const isHov = hoveredButtonId === `notes_submode_${st.id}`;
    ctx.beginPath();
    ctx.roundRect(subX, topY, st.w, subH, 6);
    ctx.fillStyle = isCur ? '#2563eb' : (isHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
    ctx.fill();

    ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#f4f4f5' : '#a1a1aa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.label, subX + st.w / 2, topY + subH / 2);

    interactiveButtons.push({ id: `notes_submode_${st.id}`, x: subX, y: topY, w: st.w, h: subH });
    subX += st.w + 6;
  });

  if (notesSubMode === 'notes') {
    // + Add Note Button on top right
    const addNoteW = 68;
    const addNoteX = contentX + contentW - addNoteW;
    const isAddNoteHov = hoveredButtonId === 'notes_add_btn';
    ctx.beginPath();
    ctx.roundRect(addNoteX, topY, addNoteW, subH, 6);
    ctx.fillStyle = isAddNoteHov ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
    ctx.strokeStyle = isAddNoteHov ? '#3b82f6' : 'rgba(59, 130, 246, 0.4)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isAddNoteHov ? '#ffffff' : '#93c5fd';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+ Note', addNoteX + addNoteW / 2, topY + subH / 2);
    interactiveButtons.push({ id: 'notes_add_btn', x: addNoteX, y: topY, w: addNoteW, h: subH });

    const listY = topY + 32;
    const items = Array.isArray(notesList) ? notesList : [];

    if (items.length === 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(contentX, listY, contentW, 200, 10);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      drawVectorSymbol(ctx, 'note', contentX + contentW / 2, listY + 72, 24, '#64748b');

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 12.5px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('No notes yet', contentX + contentW / 2, listY + 108);

      ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('Click + Note to jot down quick ideas', contentX + contentW / 2, listY + 128);
      ctx.restore();
      return;
    }

    const rowH = 38;
    const rowGap = 6;
    const maxRows = Math.min(items.length, 5);
    for (let i = 0; i < maxRows; i++) {
      const note = items[i];
      const ry = listY + i * (rowH + rowGap);
      const isRowHov = hoveredButtonId === `notes_open_${note.id}`;
      const delSize = 20;
      const delX = contentX + contentW - delSize - 10;
      const delY = ry + (rowH - delSize) / 2;
      const isDelHov = hoveredButtonId === `notes_del_${note.id}`;

      ctx.beginPath();
      ctx.roundRect(contentX, ry, contentW, rowH, 8);
      ctx.fillStyle = isRowHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
      ctx.strokeStyle = isRowHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      drawVectorSymbol(ctx, 'note', contentX + 18, ry + rowH / 2, 13, '#94a3b8');

      ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#f4f4f5';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const maxTextW = contentW - 76;
      ctx.fillText(truncateToWidth(note.title || note.body || 'Untitled', maxTextW, ctx.font), contentX + 34, ry + rowH / 2 - 6);

      ctx.font = '400 10px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#71717a';
      ctx.fillText(truncateToWidth(note.body || '', maxTextW, ctx.font), contentX + 34, ry + rowH / 2 + 8);

      interactiveButtons.push({
        id: `notes_open_${note.id}`,
        data: note.id,
        x: contentX,
        y: ry,
        w: contentW - delSize - 18,
        h: rowH
      });

      ctx.beginPath();
      ctx.arc(delX + delSize / 2, delY + delSize / 2, delSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.05)';
      ctx.fill();
      ctx.font = '600 10px sans-serif';
      ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', delX + delSize / 2, delY + delSize / 2);

      interactiveButtons.push({ id: `notes_del_${note.id}`, data: note.id, x: delX, y: delY, w: delSize, h: delSize });
    }
    return;
  }

  // --- Sub-tab 2: To-Do ---
  // 1. Category Filter Chips Row (placed to the right of the Notes/To-Do switcher)
  const allCategories = ['All', ...(todoData.categories || [])];
  const chipH = 22;
  let curX = subX + 8;

  allCategories.forEach(cat => {
    ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    const textW = ctx.measureText(cat).width;
    const chipW = Math.max(36, textW + 14);
    if (curX + chipW > contentX + contentW - 122) return;
    const isCur = todoSelectedCategory === cat;
    const isHov = hoveredButtonId === `todo_cat_${cat}`;

    ctx.beginPath();
    ctx.roundRect(curX, topY, chipW, chipH, 6);
    ctx.fillStyle = isCur ? 'rgba(255, 255, 255, 0.16)' : (isHov ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.04)');
    ctx.fill();

    ctx.fillStyle = isCur ? '#ffffff' : (isHov ? '#f4f4f5' : '#a1a1aa');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cat, curX + chipW / 2, topY + chipH / 2);

    interactiveButtons.push({ id: `todo_cat_${cat}`, data: cat, x: curX, y: topY, w: chipW, h: chipH });
    curX += chipW + 5;
  });

  // + New Category button
  const addCatW = 44;
  const isAddCatHov = hoveredButtonId === 'todo_add_category_btn';
  if (curX + addCatW <= contentX + contentW - 74) {
    ctx.beginPath();
    ctx.roundRect(curX, topY, addCatW, chipH, 6);
    ctx.fillStyle = isAddCatHov ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
    ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isAddCatHov ? '#ffffff' : '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText('+ Cat', curX + addCatW / 2, topY + chipH / 2);
    interactiveButtons.push({ id: 'todo_add_category_btn', x: curX, y: topY, w: addCatW, h: chipH });
    curX += addCatW + 5;
  }

  // Delete Category button (if custom category selected)
  if (todoSelectedCategory !== 'All' && !['Personal', 'Work', 'Island'].includes(todoSelectedCategory) && curX + 22 <= contentX + contentW - 72) {
    const delCatW = 22;
    const isDelCatHov = hoveredButtonId === 'todo_delete_category_btn';
    ctx.beginPath();
    ctx.roundRect(curX, topY, delCatW, chipH, 6);
    ctx.fillStyle = isDelCatHov ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.05)';
    ctx.fill();
    ctx.font = '600 10px sans-serif';
    ctx.fillStyle = isDelCatHov ? '#ef4444' : '#94a3b8';
    ctx.fillText('✕', curX + delCatW / 2, topY + chipH / 2);
    interactiveButtons.push({ id: 'todo_delete_category_btn', x: curX, y: topY, w: delCatW, h: chipH });
  }

  // + Add Task Button on top right
  const addTaskW = 64;
  const addTaskH = 22;
  const addTaskX = contentX + contentW - addTaskW;
  const isAddTaskHov = hoveredButtonId === 'todo_add_task_btn';
  ctx.beginPath();
  ctx.roundRect(addTaskX, topY, addTaskW, addTaskH, 6);
  ctx.fillStyle = isAddTaskHov ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
  ctx.strokeStyle = isAddTaskHov ? '#3b82f6' : 'rgba(59, 130, 246, 0.4)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isAddTaskHov ? '#ffffff' : '#93c5fd';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+ Task', addTaskX + addTaskW / 2, topY + addTaskH / 2);
  interactiveButtons.push({ id: 'todo_add_task_btn', x: addTaskX, y: topY, w: addTaskW, h: addTaskH });

  // 2. Filtered Tasks List
  const listY = topY + 32;
  const allTasks = todoData.tasks || [];
  const filteredTasks = todoSelectedCategory === 'All'
    ? allTasks
    : allTasks.filter(t => t.category === todoSelectedCategory);

  if (filteredTasks.length === 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(contentX, listY, contentW, 200, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    drawVectorSymbol(ctx, 'check', contentX + contentW / 2, listY + 72, 24, '#22c55e');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 12.5px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('All caught up', contentX + contentW / 2, listY + 108);

    ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Click + Task to add something to your list', contentX + contentW / 2, listY + 128);
    ctx.restore();
  } else {
    const rowH = 34;
    const rowGap = 6;
    const maxRows = Math.min(filteredTasks.length, 5);

    for (let i = 0; i < maxRows; i++) {
      const task = filteredTasks[i];
      const ry = listY + i * (rowH + rowGap);
      const isRowHov = hoveredButtonId === `todo_row_${task.id}`;

      ctx.beginPath();
      ctx.roundRect(contentX, ry, contentW, rowH, 8);
      ctx.fillStyle = isRowHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
      ctx.strokeStyle = isRowHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Circular Checkbox [ ] / [✓]
      const checkSize = 18;
      const checkX = contentX + 12;
      const checkY = ry + (rowH - checkSize) / 2;
      const isCheckHov = hoveredButtonId === `todo_check_${task.id}`;

      ctx.beginPath();
      ctx.arc(checkX + checkSize / 2, checkY + checkSize / 2, checkSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = task.completed ? '#22c55e' : (isCheckHov ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)');
      ctx.strokeStyle = task.completed ? '#16a34a' : 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();

      if (task.completed) {
        ctx.font = '700 11px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', checkX + checkSize / 2, checkY + checkSize / 2);
      }
      interactiveButtons.push({ id: `todo_check_${task.id}`, data: task.id, x: checkX, y: checkY, w: checkSize, h: checkSize });

      // Category Pill
      const catBadge = task.category || 'General';
      ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
      const catBadgeW = ctx.measureText(catBadge).width + 10;
      const catBadgeH = 16;
      const catBadgeX = checkX + checkSize + 10;
      const catBadgeY = ry + (rowH - catBadgeH) / 2;

      ctx.beginPath();
      ctx.roundRect(catBadgeX, catBadgeY, catBadgeW, catBadgeH, 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(catBadge, catBadgeX + catBadgeW / 2, catBadgeY + catBadgeH / 2);

      // Task Description Text (with strike-through if completed)
      const textX = catBadgeX + catBadgeW + 10;
      const maxTextW = contentW - (textX - contentX) - 36;
      ctx.font = task.completed ? '500 11.5px "Segoe UI Variable Text", Inter, sans-serif' : '600 12px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = task.completed ? '#64748b' : '#f4f4f5';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const renderedText = truncateToWidth(task.text, maxTextW, ctx.font);
      ctx.fillText(renderedText, textX, ry + rowH / 2);

      if (task.completed) {
        const textW = ctx.measureText(renderedText).width;
        ctx.beginPath();
        ctx.moveTo(textX, ry + rowH / 2);
        ctx.lineTo(textX + textW, ry + rowH / 2);
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Delete ✖ button
      const delW = 18;
      const delH = 18;
      const delX = contentX + contentW - delW - 10;
      const delY = ry + (rowH - delH) / 2;
      const isDelHov = hoveredButtonId === `todo_del_${task.id}`;

      ctx.beginPath();
      ctx.roundRect(delX, delY, delW, delH, 4);
      ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.25)' : 'transparent';
      ctx.fill();

      ctx.font = '600 10px sans-serif';
      ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', delX + delW / 2, delY + delH / 2);
      interactiveButtons.push({ id: `todo_del_${task.id}`, data: task.id, x: delX, y: delY, w: delW, h: delH });
    }
  }
}

function renderHomeView(x, y, w, h) {
  const now = new Date();
  const timeStr = formatClockTime(now, { clock24h, showSeconds: true, showAmPm });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  const clockX = x + 20;

  // 1. Digital Clock on Left with Mechanical Rolling Tumbler Lock Wheel Animation (clean spacing, no greeting clutter)
  const isHomeClockHov = hoveredButtonId === 'home_clock_display';
  const homeClockFontSize = (!clock24h && showAmPm) ? 23 : 27;
  const homeClockY = (!clock24h && showAmPm) ? (y + 44) : (y + 42);
  drawRollingTime(ctx, 'home_digital_clock', timeStr, clockX, homeClockY, {
    font: `700 ${homeClockFontSize}px "Segoe UI Variable Display", Inter, sans-serif`,
    fillStyle: isHomeClockHov ? '#38bdf8' : '#ffffff',
    align: 'left',
    baseline: 'top',
    isHovered: isHomeClockHov,
    showPlates: isHomeClockHov
  });

  interactiveButtons.push({
    id: 'home_clock_display',
    x: clockX - 4,
    y: y + 40,
    w: 136,
    h: 34
  });

  // 1a. Date + Laptop Battery Row (generous vertical gap below clock — zero overlap)
  ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (batteryState && batteryState.hasBattery) {
    const shortDateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
    ctx.fillText(shortDateStr, clockX, y + 83);

    const homeBattW = 60;
    const homeBattH = 18;
    const homeBattX = clockX + 132 - homeBattW;
    const homeBattY = y + 80;
    const isHomeBattHov = hoveredButtonId === 'home_battery_badge';

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(homeBattX, homeBattY, homeBattW, homeBattH, 5);
    ctx.fillStyle = isHomeBattHov ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.07)';
    ctx.fill();

    drawBatteryIndicator(ctx, homeBattX + 5, homeBattY + homeBattH / 2, batteryState, {
      radius: 3.6,
      showText: true,
      font: '600 9.5px "Segoe UI Variable Text", Inter, sans-serif',
      textColor: isHomeBattHov ? '#ffffff' : '#e4e4e7',
      isHovered: isHomeBattHov
    });
    ctx.restore();

    interactiveButtons.push({
      id: 'home_battery_badge',
      x: homeBattX,
      y: homeBattY,
      w: homeBattW,
      h: homeBattH
    });
  } else {
    ctx.fillText(dateStr, clockX, y + 82);
  }

  // 1b. Latest Notification Card below Date/Battery
  const notifCardX = clockX;
  const notifCardY = y + 106;
  const notifCardW = 132;
  const notifCardH = 44;
  const isNotifHov = hoveredButtonId === 'nav_notif_card';

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(notifCardX, notifCardY, notifCardW, notifCardH, 8);
  ctx.fillStyle = isNotifHov ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = isNotifHov ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  const validHomeNotifs = (notificationList || []).filter(n => {
    if (!n) return false;
    const txt = `${n.app || ''} ${n.title || ''} ${n.body || ''}`.toLowerCase();
    return !txt.includes('antigravity');
  });

  if (validHomeNotifs.length > 0) {
    const latestNotif = validHomeNotifs[0];
    const appName = latestNotif.app || 'Notification';
    const bodySnippet = latestNotif.title || latestNotif.body || 'New alert';

    drawVectorSymbol(ctx, 'bell', notifCardX + 13, notifCardY + 14, 10, '#38bdf8');
    ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateToWidth(appName, notifCardW - 28, ctx.font), notifCardX + 23, notifCardY + 14);

    // Body text snippet
    ctx.font = '400 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(truncateToWidth(bodySnippet, notifCardW - 16, ctx.font), notifCardX + 8, notifCardY + 32);
  } else {
    drawVectorSymbol(ctx, 'bell', notifCardX + 14, notifCardY + notifCardH / 2, 10, '#64748b');
    ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('No notifications', notifCardX + 25, notifCardY + notifCardH / 2);
  }
  ctx.restore();

  interactiveButtons.push({ id: 'nav_notif_card', x: notifCardX, y: notifCardY, w: notifCardW, h: notifCardH });

  // 2. Expanded Right Calendar Widget Card (minimal Home layout without Antigravity card)
  const calX = clockX + 168;
  const calY = y + 40;
  const calW = (x + w - 20) - calX;
  const calH = 110;
  renderCalendarWidget(calX, calY, calW, calH);
}

// -------------------------------------------------------------
// Antigravity Real-Time Monitor View with 4-Segment Progress Bar
// -------------------------------------------------------------
function renderAgentView(x, y, w, h) {
  const topY = y + 40;
  const contentW = w - 48;
  const contentX = x + 24;

  const projs = getActiveProjects();

  // If only 1 project, render the classic spacious card
  if (projs.length <= 1) {
    const proj = projs[0] || antigravityState;

    // Header Title
    ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const cleanProj = (proj.project ? String(proj.project).replace(/[\r\n\t\\]+/g, ' ').trim() : 'Island') || 'Island';
    const projTitle = (cleanProj !== 'Antigravity' && cleanProj !== 'Island') ? `✦ AI Monitor: ${cleanProj}` : '✦ AI Real-Time Monitor';
    ctx.fillText(projTitle, contentX, topY);

    // Jump to IDE window button
    const jW = 110;
    const jH = 24;
    const jX = contentX + contentW - jW;
    const jY = topY - 2;

    ctx.beginPath();
    ctx.roundRect(jX, jY, jW, jH, 6);
    ctx.fillStyle = hoveredButtonId === 'jump_antigravity' ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 10px "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Focus Window ↗', jX + jW / 2, jY + jH / 2);
    interactiveButtons.push({ id: 'jump_antigravity', x: jX, y: jY, w: jW, h: jH });

    // 4-Segment Progress Bar (Green fill when a part finishes)
    const prog = getAntigravityProgress(proj);
    const barY = topY + 30;
    const barH = 6;
    const gap = 6;
    const segW = (contentW - 3 * gap) / 4;

    for (let i = 0; i < 4; i++) {
      const sx = contentX + i * (segW + gap);
      ctx.beginPath();
      ctx.roundRect(sx, barY, segW, barH, 3);

      if (prog.segments[i]) {
        ctx.fillStyle = '#22c55e'; // Green
      } else if (prog.activeSegment === i) {
        ctx.fillStyle = '#38bdf8'; // Cyan
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      }
      ctx.fill();
    }

    // Segment Labels under the 4 lines
    const labelY = barY + 12;
    for (let i = 0; i < 4; i++) {
      const sx = contentX + i * (segW + gap);
      const isDone = prog.segments[i];
      const isActive = prog.activeSegment === i;

      ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      if (isDone) {
        ctx.fillStyle = '#22c55e';
        ctx.fillText(`✓ ${i + 1}. ${prog.labels[i]}`, sx, labelY);
      } else if (isActive) {
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(`● ${i + 1}. ${prog.labels[i]}`, sx, labelY);
      } else {
        ctx.fillStyle = '#71717a';
        ctx.fillText(`${i + 1}. ${prog.labels[i]}`, sx, labelY);
      }
    }

    // Detailed State Card below Progress Bar
    const infoY = labelY + 24;
    const infoH = 58;

    ctx.beginPath();
    ctx.roundRect(contentX, infoY, contentW, infoH, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Active Phase & Tool Details
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Phase: ${proj.phase || 'Ready'}`, contentX + 12, infoY + 10);

    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    if (proj.command) {
      const cmdStr = `Command: ${proj.command}`;
      ctx.fillText(cmdStr.length > 56 ? cmdStr.slice(0, 56) + '...' : cmdStr, contentX + 12, infoY + 30);
    } else if (proj.tool) {
      ctx.fillText(`Active Tool: ${proj.tool}`, contentX + 12, infoY + 30);
    } else {
      ctx.fillText(`Status: ${proj.status.toUpperCase()} • All progress synced with IDE`, contentX + 12, infoY + 30);
    }
    return;
  }

  // -----------------------------------------------------------
  // MULTI-PROJECT VIEW (2 or more concurrent Antigravity projects -> Rounded Squares)
  // -----------------------------------------------------------
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`✦ Active Antigravity Projects (${projs.length})`, contentX, topY);

  const cardSize = 134;
  const cardGap = 10;
  const maxProjects = Math.min(4, projs.length);
  const rowW = maxProjects * cardSize + (maxProjects - 1) * cardGap;
  const startX = contentX + Math.max(0, Math.round((contentW - rowW) / 2));
  const startY = topY + 24;
  const cardRadius = 16;

  for (let idx = 0; idx < maxProjects; idx++) {
    const proj = projs[idx];
    const cx = startX + idx * (cardSize + cardGap);
    const cy = startY;
    const isProjActive = ['running', 'thinking', 'waiting'].includes(String(proj.status || '').toLowerCase());

    // Rounded square card background
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardSize, cardSize, cardRadius);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.strokeStyle = proj.status === 'waiting'
      ? 'rgba(245, 158, 11, 0.45)'
      : (isProjActive ? 'rgba(56, 189, 248, 0.35)' : 'rgba(255, 255, 255, 0.08)');
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // 1. Project Title + Traffic Light Dot
    ctx.font = '600 11.5px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const rawName = (proj.project && proj.project !== 'Antigravity') ? proj.project : (`Chat ${idx + 1}`);
    ctx.fillText(truncateToWidth(`✦ ${sanitizeProjectName(rawName)}`, cardSize - 34, ctx.font), cx + 10, cy + 10);
    renderTrafficLightDot(cx + cardSize - 14, cy + 16, proj.status);

    // 2. Phase text wrapped up to 2 lines
    ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#e4e4e7';
    const phaseStr = String(proj.phase || (proj.tool ? `⚙ ${proj.tool}` : 'Ready'));
    const maxLineW = cardSize - 20;
    const words = phaseStr.split(/\s+/);
    let line1 = '';
    let line2 = '';
    let splitIdx = 0;
    while (splitIdx < words.length) {
      const candidate = line1 ? `${line1} ${words[splitIdx]}` : words[splitIdx];
      if (ctx.measureText(candidate).width <= maxLineW) {
        line1 = candidate;
        splitIdx++;
      } else {
        if (!line1) {
          line1 = truncateToWidth(words[splitIdx], maxLineW, ctx.font);
          splitIdx++;
        }
        break;
      }
    }
    if (splitIdx < words.length) {
      line2 = truncateToWidth(words.slice(splitIdx).join(' '), maxLineW, ctx.font);
    }
    ctx.fillText(line1, cx + 10, cy + 32);
    if (line2) {
      ctx.fillStyle = '#a1a1aa';
      ctx.fillText(line2, cx + 10, cy + 47);
    }

    // 3. Compact Focus button inside square card
    const btnW = cardSize - 20;
    const btnH = 20;
    const btnX = cx + 10;
    const btnY = cy + cardSize - 42;
    const isHov = hoveredButtonId === `focus_proj_${idx}`;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 6);
    ctx.fillStyle = isHov ? '#2563eb' : 'rgba(37, 99, 235, 0.22)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Focus ↗', btnX + btnW / 2, btnY + btnH / 2);
    interactiveButtons.push({ id: `focus_proj_${idx}`, data: proj.conversationId, x: btnX, y: btnY, w: btnW, h: btnH });

    // 4. 4-Segment Progress Bar at bottom of square card
    const prog = getAntigravityProgress(proj);
    const pBarY = cy + cardSize - 13;
    const pBarH = 4;
    const pGap = 3;
    const pSegW = (cardSize - 20 - 3 * pGap) / 4;

    for (let s = 0; s < 4; s++) {
      const sx = cx + 10 + s * (pSegW + pGap);
      ctx.beginPath();
      ctx.roundRect(sx, pBarY, pSegW, pBarH, 2);
      if (prog.segments[s]) {
        ctx.fillStyle = '#22c55e';
      } else if (prog.activeSegment === s) {
        ctx.fillStyle = '#38bdf8';
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      }
      ctx.fill();
    }
  }
}

// -------------------------------------------------------------
// Dynamic Windows Media View: Album Art, Equalizer, 3-Line Lyrics, Scrubber & Vector Transport
// -------------------------------------------------------------
function renderMediaView(x, y, w, h) {
  const topY = y + 40;
  const contentX = x + 22;
  const contentW = w - 68;

  const track = mediaState.track || { title: 'No media playing', artist: 'Open Liner, Spotify, or Media Player', source: 'none', lyrics: [], syncedLyrics: [] };
  const hasTrack = track.title && track.title !== 'No media playing';

  // 1. Top Row: 54x54 Album Art + Track/Artist/Source Badge + 6-Bar Equalizer
  const artSize = 54;
  const artX = contentX;
  const artY = topY;

  drawBlurredCapsuleShadow(ctx, {
    x: artX,
    y: artY,
    w: artSize,
    h: artSize,
    radius: 10,
    useBezelLump: false,
    blur: 12,
    offsetY: 4,
    color: 'rgba(0, 0, 0, 0.5)',
    preferSprite: true
  });

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(artX, artY, artSize, artSize, 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.restore();

  if (albumImage && albumImage.complete && albumImage.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(artX, artY, artSize, artSize, 10);
    ctx.clip();
    ctx.drawImage(albumImage, artX, artY, artSize, artSize);
    ctx.restore();
  } else {
    const mx = artX + artSize / 2;
    const my = artY + artSize / 2;
    ctx.save();
    ctx.strokeStyle = albumAccentColor || '#94a3b8';
    ctx.fillStyle = albumAccentColor || '#94a3b8';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mx - 3, my + 5);
    ctx.lineTo(mx - 3, my - 6);
    ctx.lineTo(mx + 6, my - 8);
    ctx.lineTo(mx + 6, my + 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx - 5.5, my + 5.5, 2.5, 0, Math.PI * 2);
    ctx.arc(mx + 3.5, my + 3.5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 6-Bar Equalizer on top right
  const eqW = 32;
  const eqH = 18;
  const eqX = contentX + contentW - eqW - 4;
  const eqY = artY + 18;
  drawEqualizer('page', eqX, eqY, eqW, eqH, albumAccentColor, 6);

  // Track Title, Artist & Source Pill
  const metaX = artX + artSize + 14;
  const maxMetaW = Math.max(80, eqX - 14 - metaX);

  ctx.font = '700 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncateToWidth(track.title || 'No media playing', maxMetaW, ctx.font), metaX, artY + 3);

  ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  const cleanArtist = String(track.artist || 'No active player').replace(/Open Liner,\s*/i, '');
  ctx.fillText(truncateToWidth(cleanArtist, maxMetaW, ctx.font), metaX, artY + 23);

  // Source label (never display 'Liner' visibly)
  const rawSrc = track.source && track.source !== 'none' ? track.source : 'Media';
  const srcName = /liner/i.test(rawSrc) ? 'Media' : rawSrc;
  const lyrStatus = liveLyricsEnabled
    ? (track.lyricStatus === 'word_synced'
      ? ' • Word'
      : (track.lyricStatus === 'synced' ? ' • Synced' : ''))
    : '';
  ctx.font = '600 9.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = albumAccentColor;
  ctx.fillText(`${srcName}${lyrStatus}`, metaX, artY + 41);
  const badgeTextW = ctx.measureText(`${srcName}${lyrStatus}`).width;

  // Sliding 2-State Segmented Pill: [ Line | Word ]
  if (liveLyricsEnabled) {
    const toggleW = 86;
    const toggleH = 18;
    const toggleX = metaX + badgeTextW + 10;
    const toggleY = artY + 38;
    const isDyn = Boolean(dynamicLyricsEnabled && !liteModeEnabled);
    const isHovToggle = hoveredButtonId === 'toggle_dynamic_lyrics';

    const targetThumb = isDyn ? 1.0 : 0.0;
    if (reducedMotionEnabled || liteModeEnabled) {
      lyricModeToggleAnim = targetThumb;
    } else {
      const tk = Math.min(1.0, (currentDt || 0.016) * 16.0 * (animSpeedMultiplier || 1.0));
      lyricModeToggleAnim += (targetThumb - lyricModeToggleAnim) * tk;
      if (Math.abs(targetThumb - lyricModeToggleAnim) < 0.005) lyricModeToggleAnim = targetThumb;
    }

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(toggleX, toggleY, toggleW, toggleH, 9);
    ctx.fillStyle = isHovToggle ? 'rgba(255, 255, 255, 0.11)' : 'rgba(255, 255, 255, 0.06)';
    ctx.strokeStyle = isDyn ? colorWithAlpha(albumAccentColor || '#3b82f6', 0.45) : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    const thumbPad = 2;
    const thumbW = (toggleW - thumbPad * 2) / 2;
    const thumbH = toggleH - thumbPad * 2;
    const thumbX = toggleX + thumbPad + lyricModeToggleAnim * thumbW;
    ctx.beginPath();
    ctx.roundRect(thumbX, toggleY + thumbPad, thumbW, thumbH, 7);
    ctx.fillStyle = isDyn ? (albumAccentColor || '#2563eb') : 'rgba(255, 255, 255, 0.18)';
    ctx.fill();

    ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = lyricModeToggleAnim < 0.5 ? '#ffffff' : '#94a3b8';
    ctx.fillText('Line', toggleX + thumbPad + thumbW / 2, toggleY + toggleH / 2);
    ctx.fillStyle = lyricModeToggleAnim >= 0.5 ? '#ffffff' : '#94a3b8';
    ctx.fillText('Word', toggleX + thumbPad + thumbW * 1.5, toggleY + toggleH / 2);
    ctx.restore();

    interactiveButtons.push({ id: 'toggle_dynamic_lyrics', x: toggleX, y: toggleY, w: toggleW, h: toggleH });
  }

  // 2. Middle Row: Rolling Lyrics Stage (hidden when Live Lyrics Output is disabled)
  const lyricsY = topY + 62;
  const lyricsH = liveLyricsEnabled ? 54 : 0;

  if (liveLyricsEnabled) {
    const around = getExpandedAroundLyrics();
    const stageElapsed = (lyricModeStageAnimStart > 0 && !reducedMotionEnabled && !liteModeEnabled)
      ? Math.min(1.0, (performance.now() - lyricModeStageAnimStart) / 420)
      : 1.0;
    const stageActive = stageElapsed < 1.0;
    const stageEase = 1 - Math.pow(1 - stageElapsed, 3);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(contentX, lyricsY, contentW, lyricsH, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    const stageBorderAlpha = stageActive ? (0.07 + 0.42 * Math.sin(stageElapsed * Math.PI)) : 0.07;
    ctx.strokeStyle = stageActive && lyricModeStageTarget === 'word'
      ? colorWithAlpha(albumAccentColor || '#3b82f6', stageBorderAlpha)
      : `rgba(255, 255, 255, ${stageBorderAlpha.toFixed(3)})`;
    ctx.lineWidth = stageActive ? 1.4 : 1;
    ctx.fill();
    ctx.stroke();
    ctx.clip();

    if (stageActive) {
      if (lyricModeStageTarget === 'word') {
        const sweepX = contentX - 80 + (contentW + 160) * stageEase;
        const sweepGrad = ctx.createLinearGradient(sweepX - 70, lyricsY, sweepX + 70, lyricsY);
        sweepGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        sweepGrad.addColorStop(0.5, colorWithAlpha(albumAccentColor || '#38bdf8', 0.24 * (1 - stageElapsed * 0.5)));
        sweepGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = sweepGrad;
        ctx.fillRect(contentX, lyricsY, contentW, lyricsH);
      } else {
        const pulseA = 0.14 * (1 - stageEase);
        ctx.fillStyle = `rgba(255, 255, 255, ${pulseA.toFixed(3)})`;
        ctx.fillRect(contentX, lyricsY, contentW, lyricsH);
      }
    }

    if (around) {
      const push = (1 - around.k) * 16;
      const centerX = contentX + contentW / 2;
      const midY = lyricsY + lyricsH / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (around.before) {
        ctx.globalAlpha = 0.34 * around.k;
        ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(truncateToWidth(around.before, contentW - 24, ctx.font), centerX, midY - 16 + push);
      }

      ctx.globalAlpha = 0.4 + 0.6 * around.k;
      ctx.font = '700 12.5px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      if (around.progressive && around.progressive.words && around.progressive.words.length > 0 && dynamicLyricsEnabled && !liteModeEnabled) {
        const words = around.progressive.words;
        const fullText = around.progressive.fullText;
        const fullW = ctx.measureText(fullText).width;

        if (fullW <= contentW - 24) {
          let curX = centerX - fullW / 2;
          ctx.textAlign = 'left';
          const spaceW = ctx.measureText(' ').width;

          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const wWidth = ctx.measureText(w.text).width;
            let wordLiftY = 0;
            if (stageActive && lyricModeStageTarget === 'word') {
              const frac = words.length > 1 ? i / (words.length - 1) : 0;
              const localP = Math.max(0, Math.min(1, (stageElapsed - frac * 0.35) / 0.65));
              wordLiftY = -Math.sin(localP * Math.PI) * 5.0;
            }

            if (w.isSung) {
              ctx.fillStyle = '#ffffff';
              ctx.fillText(w.text, curX, midY + push + wordLiftY);
            } else if (w.isActive) {
              const alpha = 0.38 + 0.62 * w.progress;
              ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
              ctx.fillText(w.text, curX, midY + push + wordLiftY);
            } else {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
              ctx.fillText(w.text, curX, midY + push + wordLiftY);
            }

            curX += wWidth + spaceW;
          }
          ctx.textAlign = 'center';
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillText(truncateToWidth(around.now, contentW - 24, ctx.font), centerX, midY + push);
        }
      } else {
        const lineScaleDrop = (stageActive && lyricModeStageTarget === 'line') ? (1 - stageEase) * 4 : 0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(truncateToWidth(around.now, contentW - 24, ctx.font), centerX, midY + push + lineScaleDrop);
      }

      if (around.next) {
        ctx.globalAlpha = 0.38 * around.k;
        ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(truncateToWidth(around.next, contentW - 24, ctx.font), centerX, midY + 16 + push);
      }
    } else if (track.lyrics && track.lyrics.length > 0) {
      const curLine = track.currentLyric || track.lyrics[0];
      ctx.font = '600 12px "Segoe UI Variable Display", Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateToWidth(curLine, contentW - 24, ctx.font), contentX + contentW / 2, lyricsY + lyricsH / 2);
    } else if (hasTrack && track.lyricStatus === 'instrumental') {
      ctx.font = '500 11px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Instrumental', contentX + contentW / 2, lyricsY + lyricsH / 2);
    }
    ctx.restore();
  }

  // 3. Interactive Timeline Scrubber Bar with Elapsed & Remaining Time
  const posMs = getLiveMediaPositionMs();
  const durMs = Math.max(0, mediaState.duration_ms || 0);
  const ratio = durMs > 0 ? Math.max(0, Math.min(1, posMs / durMs)) : 0;

  const timeY = liveLyricsEnabled ? (lyricsY + lyricsH + 13) : (topY + 66);
  ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'left';
  ctx.fillText(formatTimeMs(posMs), contentX, timeY);

  ctx.textAlign = 'right';
  ctx.fillText(durMs > 0 ? `-${formatTimeMs(Math.max(0, durMs - posMs))}` : '0:00', contentX + contentW, timeY);

  const barX = contentX + 38;
  const barW = contentW - 78;
  const isBarHov = hoveredButtonId === 'media_seek';
  const barH = isBarHov ? 6 : 3.5;
  const barY = timeY - barH / 2;

  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fill();

  const fillW = Math.max(barH, barW * ratio);
  if (ratio > 0) {
    ctx.beginPath();
    ctx.roundRect(barX, barY, fillW, barH, barH / 2);
    ctx.fillStyle = isBarHov ? albumAccentColor : '#ffffff';
    ctx.fill();
  }

  if (isBarHov && durMs > 0) {
    ctx.beginPath();
    ctx.arc(barX + fillW, timeY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  interactiveButtons.push({
    id: 'media_seek',
    data: { x: barX, w: barW },
    x: barX,
    y: timeY - 8,
    w: barW,
    h: 16
  });

  // 4. Centered Vector Transport Controls (Prev, Play/Pause, Next)
  const controls = [
    { id: 'media_prev', kind: 'prev' },
    { id: 'media_play_pause', kind: mediaState.isPlaying ? 'pause' : 'play' },
    { id: 'media_next', kind: 'next' }
  ];

  const cW = 36;
  const cH = 26;
  const cSpacing = 14;
  const startCX = contentX + (contentW - (3 * cW + 2 * cSpacing)) / 2;
  const cY = timeY + 12;

  controls.forEach((c, idx) => {
    const cx = startCX + idx * (cW + cSpacing);
    const isHov = hoveredButtonId === c.id;
    const isMain = c.id === 'media_play_pause';

    ctx.beginPath();
    ctx.roundRect(cx, cY, cW, cH, 13);
    ctx.fillStyle = isHov
      ? 'rgba(255, 255, 255, 0.22)'
      : (isMain ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)');
    ctx.fill();

    drawVectorMediaIcon(c.kind, cx + cW / 2, cY + cH / 2, isMain ? 12 : 11, '#ffffff');
    interactiveButtons.push({ id: c.id, x: cx, y: cY, w: cW, h: cH });
  });

  // 4b. Vertical Music Player Volume Slider on the Right Side of the Media Island
  const volPillW = 24;
  const volPillH = liveLyricsEnabled ? 154 : 98;
  const volCenterX = x + w - 24;
  const volPillX = volCenterX - volPillW / 2;
  const volPillY = topY + 2;
  const isVolHovered = hoveredButtonId === 'media_volume_slider' || isDraggingVolume;
  const isMuteHovered = hoveredButtonId === 'media_volume_mute';
  const effectiveVol = isVolumeMuted ? 0 : currentVolume;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(volPillX, volPillY, volPillW, volPillH, volPillW / 2);
  ctx.fillStyle = isVolHovered ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.045)';
  ctx.strokeStyle = isVolHovered ? (albumAccentColor ? colorWithAlpha(albumAccentColor, 0.45) : 'rgba(255, 255, 255, 0.22)') : 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 8px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isVolHovered ? (albumAccentColor || '#38bdf8') : 'rgba(255, 255, 255, 0.65)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(effectiveVol * 100)}%`, volCenterX, volPillY + 13);

  const trackW = isVolHovered ? 6 : 4;
  const trackX = volCenterX - trackW / 2;
  const trackY = volPillY + 25;
  const trackH = volPillH - 52;

  ctx.beginPath();
  ctx.roundRect(trackX, trackY, trackW, trackH, trackW / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fill();

  const volFillH = Math.max(0, Math.min(trackH, trackH * effectiveVol));
  const volFillY = trackY + trackH - volFillH;
  if (volFillH > 0) {
    ctx.beginPath();
    ctx.roundRect(trackX, volFillY, trackW, volFillH, trackW / 2);
    ctx.fillStyle = isVolHovered ? (albumAccentColor || '#38bdf8') : '#ffffff';
    ctx.fill();
  }

  if (isVolHovered) {
    ctx.beginPath();
    ctx.arc(volCenterX, volFillY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.stroke();
  }
  ctx.restore();

  const speakerY = volPillY + volPillH - 13;
  drawVectorSpeakerIcon(
    volCenterX,
    speakerY,
    12,
    isVolumeMuted ? '#f87171' : (isMuteHovered ? (albumAccentColor || '#ffffff') : 'rgba(255, 255, 255, 0.75)'),
    isVolumeMuted,
    currentVolume
  );
  interactiveButtons.push({
    id: 'media_volume_mute',
    x: volPillX,
    y: volPillY + volPillH - 25,
    w: volPillW,
    h: 25
  });

  volumeSliderBounds = { trackY, trackH };
  interactiveButtons.push({
    id: 'media_volume_slider',
    data: { trackY, trackH },
    x: volPillX - 3,
    y: trackY - 6,
    w: volPillW + 6,
    h: trackH + 12
  });
}

// -------------------------------------------------------------
// Clipboard History View (Extended 25-item memory + Search + Pin)
// -------------------------------------------------------------
function renderClipboardView(x, y, w, h) {
  const topY = y + 40;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // Header Title & Count
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`📋 Clipboard History (${clipboardHistory.length})`, contentX, topY + 4);

  // Clear Unpinned Button on top right
  const clrW = 50;
  const clrH = 22;
  const clrX = contentX + contentW - clrW;
  const isClrHov = hoveredButtonId === 'clipboard_clear';
  interactiveButtons.push({ id: 'clipboard_clear', x: clrX, y: topY, w: clrW, h: clrH });
  ctx.beginPath();
  ctx.roundRect(clrX, topY, clrW, clrH, 6);
  ctx.fillStyle = isClrHov ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.fillStyle = isClrHov ? '#f87171' : '#a1a1aa';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Clear', clrX + clrW / 2, topY + clrH / 2);

  // Search Filter Box
  const searchY = topY + 28;
  const searchH = 24;
  ctx.beginPath();
  ctx.roundRect(contentX, searchY, contentW, searchH, 6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = clipboardFilter ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (clipboardFilter) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`🔍 ${clipboardFilter}`, contentX + 8, searchY + searchH / 2);
  } else {
    ctx.fillStyle = '#71717a';
    ctx.fillText('🔍 Type anywhere to search clipboard...', contentX + 8, searchY + searchH / 2);
  }

  // Filtered List
  const filtered = clipboardHistory.filter(c =>
    !clipboardFilter || c.text.toLowerCase().includes(clipboardFilter.toLowerCase())
  );

  const listY = searchY + searchH + 8;
  if (filtered.length === 0) {
    ctx.fillStyle = '#71717a';
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const emptyMsg = clipboardHistory.length === 0
      ? 'No copied text yet. Copy anything with Ctrl+C to store it here!'
      : 'No matching clips found.';
    ctx.fillText(emptyMsg, contentX + contentW / 2, listY + 50);
    return;
  }

  // Render cards (up to 4 visible rows)
  const cardH = 40;
  const cardGap = 6;
  const maxVisible = Math.min(filtered.length, 4);

  for (let i = 0; i < maxVisible; i++) {
    const item = filtered[i];
    const cy = listY + i * (cardH + cardGap);
    const isCardHov = hoveredButtonId === `clip_copy_${item.id}`;
    const isPinHov = hoveredButtonId === `clip_pin_${item.id}`;
    const isCopied = copiedFeedbackId === item.id;

    // Card background
    ctx.beginPath();
    ctx.roundRect(contentX, cy, contentW, cardH, 7);
    ctx.fillStyle = isCopied
      ? 'rgba(34, 197, 94, 0.15)'
      : (isCardHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)');
    ctx.strokeStyle = isCopied
      ? 'rgba(34, 197, 94, 0.5)'
      : (item.pinned ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.06)');
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Pin toggle button on left
    const pinBtnW = 24;
    const pinBtnX = contentX + 6;
    interactiveButtons.push({ id: `clip_pin_${item.id}`, data: item.id, x: pinBtnX, y: cy + 8, w: pinBtnW, h: 24 });
    ctx.font = '11px "Segoe UI Symbol", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = item.pinned ? '#38bdf8' : (isPinHov ? '#ffffff' : '#52525b');
    ctx.fillText(item.pinned ? '📌' : '📍', pinBtnX + pinBtnW / 2, cy + cardH / 2);

    // Text snippet
    const textX = pinBtnX + pinBtnW + 8;
    const maxTextW = contentW - pinBtnW - 88;
    ctx.font = '500 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const singleLine = item.text.replace(/[\r\n\t]+/g, ' ').trim();
    ctx.fillText(truncateToWidth(singleLine, maxTextW, ctx.font), textX, cy + cardH / 2);

    // Right Action: "✓ Copied" or time ago + copy icon
    const rightX = contentX + contentW - 12;
    if (isCopied) {
      ctx.font = '600 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#22c55e';
      ctx.textAlign = 'right';
      ctx.fillText('✓ Copied', rightX, cy + cardH / 2);
    } else {
      const ageSec = Math.floor((Date.now() - (item.time || 0)) / 1000);
      const timeStr = ageSec < 60 ? 'just now' : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m` : `${Math.floor(ageSec / 3600)}h`;
      ctx.font = '400 9.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = '#71717a';
      ctx.textAlign = 'right';
      ctx.fillText(timeStr, rightX, cy + cardH / 2);
    }

    // Click card to re-copy
    interactiveButtons.push({ id: `clip_copy_${item.id}`, data: item.id, x: textX, y: cy, w: contentW - pinBtnW - 14, h: cardH });
  }
}

function renderPromptView(x, y, w, h) {
  if (!pendingPrompt) return;

  ctx.font = '600 14px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#f59e0b';
  ctx.textAlign = 'left';
  ctx.fillText('⚠️ Agent Permission Request', x + 24, y + 46);

  ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.fillText(pendingPrompt.message || 'Permission needed to execute action', x + 24, y + 70);

  if (pendingPrompt.command) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Command: ${pendingPrompt.command}`, x + 24, y + 90);
  }

  // Allow & Deny Buttons
  const btnW = 90;
  const btnH = 26;
  const btnAllowX = x + w - (2 * btnW + 16) - 24;
  const btnDenyX = btnAllowX + btnW + 16;
  const btnY = y + h - btnH - 16;

  // Allow
  ctx.beginPath();
  ctx.roundRect(btnAllowX, btnY, btnW, btnH, 8);
  ctx.fillStyle = hoveredButtonId === 'prompt_allow' ? '#16a34a' : 'rgba(34, 197, 94, 0.2)';
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('Allow ✓', btnAllowX + btnW / 2, btnY + btnH / 2);
  interactiveButtons.push({ id: 'prompt_allow', data: pendingPrompt.id, x: btnAllowX, y: btnY, w: btnW, h: btnH });

  // Deny
  ctx.beginPath();
  ctx.roundRect(btnDenyX, btnY, btnW, btnH, 8);
  ctx.fillStyle = hoveredButtonId === 'prompt_deny' ? '#dc2626' : 'rgba(239, 68, 68, 0.2)';
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.fillText('Deny ✕', btnDenyX + btnW / 2, btnY + btnH / 2);
  interactiveButtons.push({ id: 'prompt_deny', data: pendingPrompt.id, x: btnDenyX, y: btnY, w: btnW, h: btnH });
}

// -------------------------------------------------------------
// Drop Zone Shelf View (Inside Island / Notch)
// -------------------------------------------------------------
function renderDropZoneView(x, y, w, h) {
  const topY = y + 40;
  const padding = 18;
  const contentW = w - padding * 2;
  const contentX = x + padding;

  // Header Title (custom vector folder symbol, no emoji)
  drawVectorSymbol(ctx, 'folder', contentX + 7, topY + 11, 13, '#e4e4e7');
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Drop Shelf (${dropZoneFiles.length})`, contentX + 20, topY + 4);

  // Header Actions
  const btnY = topY;
  const btnH = 22;

  // + Add button
  const addW = 54;
  const addX = contentX + contentW - 176;
  interactiveButtons.push({ id: 'dropzone_browse', x: addX, y: btnY, w: addW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(addX, btnY, addW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_browse' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = '#f4f4f5';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+ Add', addX + addW / 2, btnY + btnH / 2);

  // Open Folder button
  const fldW = 58;
  const fldX = contentX + contentW - 116;
  interactiveButtons.push({ id: 'dropzone_reveal', x: fldX, y: btnY, w: fldW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(fldX, btnY, fldW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_reveal' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = '#f4f4f5';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Folder', fldX + fldW / 2, btnY + btnH / 2);

  // Clear All button
  const clrW = 50;
  const clrX = contentX + contentW - 52;
  interactiveButtons.push({ id: 'dropzone_clear', x: clrX, y: btnY, w: clrW, h: btnH });
  ctx.beginPath();
  ctx.roundRect(clrX, btnY, clrW, btnH, 6);
  ctx.fillStyle = hoveredButtonId === 'dropzone_clear' ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.fillStyle = hoveredButtonId === 'dropzone_clear' ? '#f87171' : '#a1a1aa';
  ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Clear', clrX + clrW / 2, btnY + btnH / 2);

  // Files Area
  const listY = topY + 30;

  // --- DUAL-ZONE DRAG-IN OVERLAY (One-Time Use on Left vs Keep on Right) ---
  if (isDraggingOver) {
    const zoneH = 170;
    const gap = 12;
    const zoneW = (contentW - gap) / 2;
    const leftX = contentX;
    const rightX = contentX + zoneW + gap;

    // Left Zone: One-Time Use (custom vector bolt)
    const isOneTimeHover = dropZoneHoverZone === 'onetime';
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = isOneTimeHover ? '#f59e0b' : 'rgba(245, 158, 11, 0.45)';
    ctx.lineWidth = isOneTimeHover ? 2 : 1.5;
    ctx.beginPath();
    ctx.roundRect(leftX, listY, zoneW, zoneH, 12);
    ctx.fillStyle = isOneTimeHover ? 'rgba(245, 158, 11, 0.16)' : 'rgba(245, 158, 11, 0.05)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    drawVectorSymbol(ctx, 'bolt', leftX + zoneW / 2, listY + zoneH / 2 - 26, 24, isOneTimeHover ? '#fbbf24' : '#f59e0b');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = isOneTimeHover ? '#fbbf24' : '#f59e0b';
    ctx.fillText('One-Time Use', leftX + zoneW / 2, listY + zoneH / 2 + 6);
    ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Auto-removes once dragged out', leftX + zoneW / 2, listY + zoneH / 2 + 24);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('(WhatsApp, Discord, Browser, etc.)', leftX + zoneW / 2, listY + zoneH / 2 + 38);

    // Right Zone: Keep (custom vector pin)
    const isKeepHover = dropZoneHoverZone === 'keep';
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = isKeepHover ? '#10b981' : 'rgba(16, 185, 129, 0.45)';
    ctx.lineWidth = isKeepHover ? 2 : 1.5;
    ctx.beginPath();
    ctx.roundRect(rightX, listY, zoneW, zoneH, 12);
    ctx.fillStyle = isKeepHover ? 'rgba(16, 185, 129, 0.16)' : 'rgba(16, 185, 129, 0.05)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    drawVectorSymbol(ctx, 'pin', rightX + zoneW / 2, listY + zoneH / 2 - 26, 22, isKeepHover ? '#34d399' : '#10b981');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = isKeepHover ? '#34d399' : '#10b981';
    ctx.fillText('Keep on Shelf', rightX + zoneW / 2, listY + zoneH / 2 + 6);
    ctx.font = '500 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Stays permanently on shelf', rightX + zoneW / 2, listY + zoneH / 2 + 24);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('Until you remove it', rightX + zoneW / 2, listY + zoneH / 2 + 38);
    return;
  }

  if (dropZoneFiles.length === 0) {
    // Empty Drop Target state
    const emptyH = 160;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(contentX, listY, contentW, emptyH, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    drawVectorSymbol(ctx, 'inbox', contentX + contentW / 2, listY + emptyH / 2 - 20, 24, '#71717a');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e4e4e7';
    ctx.font = '600 13px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillText('Drop files here to store on shelf', contentX + contentW / 2, listY + emptyH / 2 + 8);

    ctx.fillStyle = '#71717a';
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillText('Split into One-Time Use or Keep when dragging in', contentX + contentW / 2, listY + emptyH / 2 + 28);
  } else {
    // Full-width vertical rows
    const rowH = 38;
    const rowGap = 6;
    const maxRows = Math.min(dropZoneFiles.length, 3);

    for (let i = 0; i < maxRows; i++) {
      const file = dropZoneFiles[i];
      const ry = listY + i * (rowH + rowGap);
      const isRowHov = hoveredButtonId === `dropzone_row_${i}`;

      // Row clickable target (opens file when row is clicked)
      interactiveButtons.push({
        id: `dropzone_row_${i}`,
        data: file.path || file.name,
        oneTime: Boolean(file.oneTime),
        x: contentX,
        y: ry,
        w: contentW - 95,
        h: rowH
      });

      // Row background
      ctx.beginPath();
      ctx.roundRect(contentX, ry, contentW, rowH, 8);
      ctx.fillStyle = isRowHov ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isRowHov ? 'rgba(59, 130, 246, 0.4)' : 'rgba(255, 255, 255, 0.06)';
      ctx.stroke();

      // Custom Vector File/Folder Symbol (no emoji)
      drawVectorSymbol(ctx, file.isDirectory ? 'folder' : 'file', contentX + 20, ry + rowH / 2, 14, '#cbd5e1');

      // File Name
      ctx.fillStyle = '#f4f4f5';
      ctx.font = '600 12px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const truncName = truncateText(file.name, 30);
      ctx.fillText(truncName, contentX + 38, ry + rowH / 2 - 6);

      // File Size
      ctx.fillStyle = '#71717a';
      ctx.font = '400 10.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillText(formatBytes(file.size), contentX + 38, ry + rowH / 2 + 8);

      // Badge for One-Time vs Keep (custom vector symbol + clean text)
      const badgeText = file.oneTime ? '1-Time' : 'Keep';
      const badgeBg = file.oneTime ? 'rgba(245, 158, 11, 0.18)' : 'rgba(16, 185, 129, 0.18)';
      const badgeBorder = file.oneTime ? 'rgba(245, 158, 11, 0.45)' : 'rgba(16, 185, 129, 0.45)';
      const badgeColor = file.oneTime ? '#fbbf24' : '#34d399';
      const badgeW = 54;
      const badgeH = 16;
      const badgeX = contentX + contentW - 152;
      const badgeY = ry + (rowH - badgeH) / 2;

      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
      ctx.fillStyle = badgeBg;
      ctx.strokeStyle = badgeBorder;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      drawVectorSymbol(ctx, file.oneTime ? 'bolt' : 'pin', badgeX + 9, badgeY + badgeH / 2, 8, badgeColor);
      ctx.font = '600 8.5px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = badgeColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, badgeX + 16, badgeY + badgeH / 2);

      // Dedicated Open ↗ Button
      const openBtnW = 50;
      const openBtnH = 22;
      const openBtnX = contentX + contentW - 90;
      const openBtnY = ry + (rowH - openBtnH) / 2;
      const isOpenHov = hoveredButtonId === `dropzone_open_file_${i}`;
      interactiveButtons.push({
        id: `dropzone_open_file_${i}`,
        data: file.path || file.name,
        oneTime: Boolean(file.oneTime),
        x: openBtnX,
        y: openBtnY,
        w: openBtnW,
        h: openBtnH
      });

      ctx.beginPath();
      ctx.roundRect(openBtnX, openBtnY, openBtnW, openBtnH, 6);
      ctx.fillStyle = isOpenHov ? '#2563eb' : 'rgba(37, 99, 235, 0.2)';
      ctx.strokeStyle = isOpenHov ? '#3b82f6' : 'rgba(59, 130, 246, 0.4)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
      ctx.fillStyle = isOpenHov ? '#ffffff' : '#93c5fd';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Open ↗', openBtnX + openBtnW / 2, openBtnY + openBtnH / 2);

      // Delete ✕ Button
      const delX = contentX + contentW - 28;
      const delY = ry + (rowH - 20) / 2;
      const delSize = 20;
      const isDelHov = hoveredButtonId === `dropzone_delete_file_${i}`;
      interactiveButtons.push({ id: `dropzone_delete_file_${i}`, data: file.name, x: delX, y: delY, w: delSize, h: delSize });

      ctx.beginPath();
      ctx.roundRect(delX, delY, delSize, delSize, 4);
      ctx.fillStyle = isDelHov ? 'rgba(239, 68, 68, 0.25)' : 'transparent';
      ctx.fill();

      ctx.font = '600 11px sans-serif';
      ctx.fillStyle = isDelHov ? '#ef4444' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', delX + delSize / 2, delY + delSize / 2);
    }
  }
}

// -------------------------------------------------------------
// Clipboard History View

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '🎵';
  if (['mp4', 'mkv', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return '⚙️';
  if (['js', 'ts', 'py', 'json', 'html', 'css', 'cpp', 'c', 'cs'].includes(ext)) return '📝';
  if (['pdf'].includes(ext)) return '📕';
  return '📄';
}

function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// -------------------------------------------------------------
// Notification Center View (History, Badges & Quick Dismiss)
// -------------------------------------------------------------
function renderNotificationCenterView(x, y, w, h) {
  const contentX = x + 20;
  const contentY = y + 42;
  const contentW = w - 40;
  const contentH = h - 54;

  // Header row: "Notification Center" on left, "Clear All" on right
  ctx.font = '700 16px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const unreadCount = notificationList.filter(n => !n.read).length;
  const headerText = unreadCount > 0 ? `Notification Center (${unreadCount} new)` : 'Notification Center';
  ctx.fillText(headerText, contentX, contentY + 12);

  // Clear All button
  if (notificationList.length > 0) {
    const clrW = 74;
    const clrH = 24;
    const clrX = contentX + contentW - clrW;
    const clrY = contentY;
    const isClrHov = hoveredButtonId === 'notif_clear_all';

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(clrX, clrY, clrW, clrH, 6);
    ctx.fillStyle = isClrHov ? 'rgba(239, 68, 68, 0.28)' : 'rgba(255, 255, 255, 0.08)';
    ctx.strokeStyle = isClrHov ? '#ef4444' : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isClrHov ? '#fca5a5' : '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Clear All', clrX + clrW / 2, clrY + clrH / 2);
    ctx.restore();

    interactiveButtons.push({ id: 'notif_clear_all', x: clrX, y: clrY, w: clrW, h: clrH });
  }

  // Notification items list
  const listY = contentY + 32;
  const itemH = 52;
  const gap = 8;
  const maxVisible = 3;
  const itemsToShow = notificationList.slice(0, maxVisible);

  if (itemsToShow.length === 0) {
    ctx.save();
    ctx.font = '28px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔔', x + w / 2, listY + 50);

    ctx.font = '600 13px "Segoe UI Variable Display", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('All caught up', x + w / 2, listY + 90);

    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('New notifications from Windows apps & agents will appear here.', x + w / 2, listY + 112);
    ctx.restore();
    return;
  }

  itemsToShow.forEach((notif, idx) => {
    const iy = listY + idx * (itemH + gap);
    const isHov = hoveredButtonId === `notif_item_${notif.id}`;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(contentX, iy, contentW, itemH, 10);
    ctx.fillStyle = isHov ? 'rgba(255, 255, 255, 0.09)' : 'rgba(24, 24, 32, 0.75)';
    ctx.strokeStyle = notif.read ? 'rgba(255, 255, 255, 0.08)' : 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Unread indicator dot
    if (!notif.read) {
      ctx.beginPath();
      ctx.arc(contentX + 10, iy + itemH / 2, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
    }

    // App Icon & Name
    const textLeft = contentX + (notif.read ? 14 : 22);
    ctx.font = '600 11.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${notif.icon || '🔔'} ${notif.app}`, textLeft, iy + 8);

    // Timestamp
    const timeAgoStr = formatRelativeTime(notif.timestamp);
    ctx.font = '500 10.5px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(timeAgoStr, contentX + contentW - 34, iy + 9);

    // Title & Body
    const titleText = notif.title || notif.body || '';
    const bodyText = notif.title && notif.body ? notif.body : '';
    const fullSnippet = bodyText ? `${titleText} — ${bodyText}` : titleText;

    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'left';
    ctx.fillText(truncateToWidth(fullSnippet, contentW - 68, ctx.font), textLeft, iy + 27);

    // Dismiss X button
    const dsmBtnSize = 20;
    const dsmX = contentX + contentW - dsmBtnSize - 8;
    const dsmY = iy + (itemH - dsmBtnSize) / 2;
    const isDsmHov = hoveredButtonId === `notif_dismiss_${notif.id}`;

    ctx.beginPath();
    ctx.arc(dsmX + dsmBtnSize / 2, dsmY + dsmBtnSize / 2, dsmBtnSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = isDsmHov ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fill();

    ctx.font = '600 10px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = isDsmHov ? '#ef4444' : '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', dsmX + dsmBtnSize / 2, dsmY + dsmBtnSize / 2);
    ctx.restore();

    interactiveButtons.push({ id: `notif_dismiss_${notif.id}`, x: dsmX, y: dsmY, w: dsmBtnSize, h: dsmBtnSize });
    interactiveButtons.push({ id: `notif_item_${notif.id}`, x: contentX, y: iy, w: contentW - dsmBtnSize - 12, h: itemH });
  });
}

// -------------------------------------------------------------
// Auto-Expanding 4-Second Incoming Notification Banner View
// -------------------------------------------------------------
function renderNotificationBannerView(x, y, w, h) {
  if (!activeNotification) return;

  const notif = activeNotification;
  const isNotch = displayMode === 'notch';
  const cornerR = UI.COMPACT_RADIUS + 8;

  // Solid Pure Black background (no blue gradient wash)
  ctx.save();
  buildCapsulePath(ctx, x, y, w, h, cornerR, isNotch, 12);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();

  // App Icon circle on left (quiet dark neutral)
  const iconSize = 34;
  const iconX = x + 16;
  const iconY = y + (h - iconSize) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.font = '18px "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(notif.icon || '🔔', iconX + iconSize / 2, iconY + iconSize / 2);
  ctx.restore();

  // Content Column
  const textX = iconX + iconSize + 12;
  const maxW = Math.max(80, w - (textX - x) - 44);

  // Line 1: App Name (quiet neutral)
  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = '#a1a1aa';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(notif.app || 'Notification', textX, y + 14);

  // Line 2: Title (Bold white)
  const title = notif.title || notif.body || 'New Notification';
  ctx.font = '700 13px "Segoe UI Variable Display", Inter, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncateToWidth(title, maxW, ctx.font), textX, y + 29);

  // Line 3: Body snippet
  if (notif.title && notif.body) {
    ctx.font = '400 11px "Segoe UI Variable Text", Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(truncateToWidth(notif.body, maxW, ctx.font), textX, y + 47);
  }

  // Dismiss button on right
  const dsmSize = 22;
  const dsmX = x + w - dsmSize - 16;
  const dsmY = y + (h - dsmSize) / 2;
  const isDsmHov = hoveredButtonId === 'notif_banner_dismiss';

  ctx.save();
  ctx.beginPath();
  ctx.arc(dsmX + dsmSize / 2, dsmY + dsmSize / 2, dsmSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = isDsmHov ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)';
  ctx.fill();

  ctx.font = '600 11px "Segoe UI Variable Text", Inter, sans-serif';
  ctx.fillStyle = isDsmHov ? '#ffffff' : '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✕', dsmX + dsmSize / 2, dsmY + dsmSize / 2);
  ctx.restore();

  interactiveButtons.push({ id: 'notif_banner_dismiss', x: dsmX, y: dsmY, w: dsmSize, h: dsmSize });
  interactiveButtons.push({ id: 'notif_banner_click', x: x, y: y, w: w - dsmSize - 20, h: h });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeAccentColorFromPixels,
    getEligibleGreetingsList,
    getNextPersonalizedGreeting,
    buildCapsulePath,
    drawCapsuleRim,
    computeDynamicActive,
    getNextIdleWakeDelayMs,
    isDynamicActive,
    computeSideIslandsLayout,
    formatClockTime,
    getTopLumpHitbox,
    computeCapsuleHideTransform,
    getLiquidGlassTokens,
    easeOpenCloseBack
  };
}
