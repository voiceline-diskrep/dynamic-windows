'use strict';
/**
 * Dynamic Windows - User Data Manager
 * Handles local persistence and IPC for Calendar, To-Do List, Clock/Timer, and Dual-Zone Drop Shelf.
 * Data files stored in %APPDATA%\DynamicWindows\
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'DynamicWindows')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DynamicWindows');

const CALENDAR_FILE = path.join(DATA_DIR, 'calendar_notes.json');
const CALENDAR_CATS_FILE = path.join(DATA_DIR, 'calendar_categories.json');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const CLOCK_FILE = path.join(DATA_DIR, 'clock_state.json');
const SHELF_FILE = path.join(DATA_DIR, 'drop_shelf_metadata.json');

const DEFAULT_TODOS = {
  categories: ['Personal', 'Work', 'Island'],
  tasks: [
    {
      id: 'default_task_1',
      text: 'Welcome to Dynamic Windows To-Do',
      category: 'Personal',
      completed: false,
      createdAt: Date.now()
    }
  ]
};

const DEFAULT_CLOCK = {
  timer: {
    durationSec: 300,
    remainingSec: 300,
    running: false,
    startedAt: null
  },
  stopwatch: {
    elapsedMs: 0,
    running: false,
    startedAt: null,
    laps: []
  },
  focus: {
    mode: 'work', // 'work' | 'short_break' | 'long_break'
    workDurationMin: 25,
    breakDurationMin: 5,
    sessionsCompleted: 0,
    remainingSec: 1500,
    running: false,
    startedAt: null
  }
};

function safeWriteJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempFile = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    console.error(`[UserDataManager] Failed to write ${filePath}:`, err);
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn(`[UserDataManager] Failed to read ${filePath}, using fallback:`, err);
  }
  return fallback;
}

class UserDataManager {
  constructor() {
    this.ensureDir();
    this.calendarNotes = safeReadJson(CALENDAR_FILE, []);
    const loadedCats = safeReadJson(CALENDAR_CATS_FILE, ['General', 'Personal', 'Work']);
    this.calendarCategories = Array.isArray(loadedCats) && loadedCats.length > 0 ? loadedCats : ['General', 'Personal', 'Work'];
    this.todos = safeReadJson(TODOS_FILE, DEFAULT_TODOS);
    this.notes = safeReadJson(NOTES_FILE, []);
    this.clockState = safeReadJson(CLOCK_FILE, DEFAULT_CLOCK);
    this.shelfMetadata = safeReadJson(SHELF_FILE, {});
  }

  ensureDir() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {}
  }

  // --- Calendar Engine ---

  getCalendarNotes() {
    return this.calendarNotes;
  }

  getCalendarCategories() {
    return this.calendarCategories;
  }

  addCalendarCategory(category) {
    const clean = String(category || '').trim();
    if (!clean) return false;
    if (!this.calendarCategories.some(c => c.toLowerCase() === clean.toLowerCase())) {
      this.calendarCategories.push(clean);
      safeWriteJson(CALENDAR_CATS_FILE, this.calendarCategories);
      return true;
    }
    return false;
  }

  addCalendarNote(note) {
    if (!note || !note.text || !note.date) return null;
    const cat = String(note.category || '').trim() || 'General';
    const rawColor = String(note.color || '').trim();
    const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawColor) ? rawColor : '#3b82f6';
    if (!this.calendarCategories.some(c => c.toLowerCase() === cat.toLowerCase())) {
      this.calendarCategories.push(cat);
      safeWriteJson(CALENDAR_CATS_FILE, this.calendarCategories);
    }
    const newNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      date: String(note.date).slice(0, 10), // YYYY-MM-DD
      text: String(note.text).trim(),
      description: String(note.description || '').trim(),
      category: cat,
      color,
      repeat: ['none', 'yearly', 'monthly', 'weekly', 'daily'].includes(note.repeat) ? note.repeat : 'none',
      isBirthday: Boolean(note.isBirthday || note.repeat === 'yearly'),
      createdAt: Date.now()
    };
    this.calendarNotes.push(newNote);
    safeWriteJson(CALENDAR_FILE, this.calendarNotes);
    return newNote;
  }

  deleteCalendarNote(id) {
    const initialLen = this.calendarNotes.length;
    this.calendarNotes = this.calendarNotes.filter(n => n.id !== id);
    if (this.calendarNotes.length !== initialLen) {
      safeWriteJson(CALENDAR_FILE, this.calendarNotes);
      return true;
    }
    return false;
  }

  static matchesDate(note, targetDateStr) {
    if (!note || !note.date || !targetDateStr) return false;
    const noteDate = note.date.slice(0, 10);
    const targetDate = targetDateStr.slice(0, 10);

    if (note.repeat === 'none' || !note.repeat) {
      return noteDate === targetDate;
    }
    if (note.repeat === 'yearly') {
      // Matches same MM-DD for any year on or after creation
      return noteDate.slice(5) === targetDate.slice(5);
    }
    if (note.repeat === 'monthly') {
      // Matches same day-of-month DD
      return noteDate.slice(8) === targetDate.slice(8);
    }
    if (note.repeat === 'weekly') {
      const d1 = new Date(noteDate + 'T00:00:00');
      const d2 = new Date(targetDate + 'T00:00:00');
      return d1.getDay() === d2.getDay();
    }
    if (note.repeat === 'daily') {
      return targetDate >= noteDate;
    }
    return noteDate === targetDate;
  }

  // --- To-Do Engine ---

  getTodos() {
    return this.todos;
  }

  addTodoTask(task) {
    if (!task || !task.text) return null;
    const newTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      text: String(task.text).trim(),
      category: task.category && this.todos.categories.includes(task.category) ? task.category : (this.todos.categories[0] || 'General'),
      completed: false,
      createdAt: Date.now()
    };
    this.todos.tasks.unshift(newTask);
    safeWriteJson(TODOS_FILE, this.todos);
    return newTask;
  }

  toggleTodoTask(id) {
    const task = this.todos.tasks.find(t => t.id === id);
    if (task) {
      task.completed = !task.completed;
      task.completedAt = task.completed ? Date.now() : null;
      safeWriteJson(TODOS_FILE, this.todos);
      return task;
    }
    return null;
  }

  deleteTodoTask(id) {
    const initialLen = this.todos.tasks.length;
    this.todos.tasks = this.todos.tasks.filter(t => t.id !== id);
    if (this.todos.tasks.length !== initialLen) {
      safeWriteJson(TODOS_FILE, this.todos);
      return true;
    }
    return false;
  }

  addTodoCategory(category) {
    const cat = String(category || '').trim();
    if (cat && !this.todos.categories.includes(cat)) {
      this.todos.categories.push(cat);
      safeWriteJson(TODOS_FILE, this.todos);
      return true;
    }
    return false;
  }

  deleteTodoCategory(category) {
    const cat = String(category || '').trim();
    if (this.todos.categories.includes(cat) && this.todos.categories.length > 1) {
      this.todos.categories = this.todos.categories.filter(c => c !== cat);
      const fallbackCat = this.todos.categories[0];
      // Reassign or keep tasks
      this.todos.tasks.forEach(t => {
        if (t.category === cat) t.category = fallbackCat;
      });
      safeWriteJson(TODOS_FILE, this.todos);
      return true;
    }
    return false;
  }

  // --- Clock / Timer Engine ---

  getClockState() {
    return this.clockState;
  }

  saveClockState(partial) {
    if (partial && typeof partial === 'object') {
      this.clockState = { ...this.clockState, ...partial };
      safeWriteJson(CLOCK_FILE, this.clockState);
    }
    return this.clockState;
  }

  // --- Notes Engine ---

  getNotes() {
    return Array.isArray(this.notes) ? this.notes : [];
  }

  addNote({ title, body, html = '', fontFamily = 'Sans', fontSize = 13, allowEmpty = false }) {
    const cleanTitle = String(title || '').trim();
    const cleanBody = String(body || '').trim();
    const cleanHtml = String(html || '');
    if (!allowEmpty && !cleanTitle && !cleanBody && !cleanHtml.trim()) return null;
    const item = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: cleanTitle || cleanBody.slice(0, 36) || 'Untitled Note',
      body: cleanBody,
      html: cleanHtml,
      fontFamily: String(fontFamily || 'Sans'),
      fontSize: Number(fontSize) || 13,
      updatedAt: Date.now()
    };
    this.notes.unshift(item);
    safeWriteJson(NOTES_FILE, this.notes);
    return item;
  }

  updateNote(id, { title, body, html, fontFamily, fontSize }) {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return null;
    const cleanTitle = String(title || '').trim();
    const cleanBody = String(body || '').trim();
    this.notes[idx] = {
      ...this.notes[idx],
      title: cleanTitle || cleanBody.slice(0, 36) || 'Untitled Note',
      body: cleanBody,
      ...(html !== undefined ? { html: String(html) } : {}),
      ...(fontFamily !== undefined ? { fontFamily: String(fontFamily) } : {}),
      ...(fontSize !== undefined ? { fontSize: Number(fontSize) || 13 } : {}),
      updatedAt: Date.now()
    };
    safeWriteJson(NOTES_FILE, this.notes);
    return this.notes[idx];
  }

  deleteNote(id) {
    const before = this.notes.length;
    this.notes = this.notes.filter(n => n.id !== id);
    if (this.notes.length !== before) {
      safeWriteJson(NOTES_FILE, this.notes);
      return true;
    }
    return false;
  }

  // --- Drop Shelf Metadata (Dual-Zone: One-Time vs Keep) ---

  getShelfMetadata() {
    return this.shelfMetadata;
  }

  _findShelfKey(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const norm = path.normalize(filePath);
    if (this.shelfMetadata[norm]) return norm;
    const lowerNorm = norm.toLowerCase();
    const baseLower = path.basename(norm).toLowerCase();
    for (const k of Object.keys(this.shelfMetadata)) {
      if (path.normalize(k).toLowerCase() === lowerNorm) return k;
    }
    for (const k of Object.keys(this.shelfMetadata)) {
      if (path.basename(k).toLowerCase() === baseLower) return k;
    }
    return null;
  }

  setFileShelfMetadata(filePath, isOneTime) {
    if (!filePath || typeof filePath !== 'string') return;
    const existingKey = this._findShelfKey(filePath);
    const key = existingKey || path.normalize(filePath);
    this.shelfMetadata[key] = {
      oneTime: Boolean(isOneTime),
      addedAt: Date.now()
    };
    safeWriteJson(SHELF_FILE, this.shelfMetadata);
  }

  isOneTimeFile(filePath) {
    const key = this._findShelfKey(filePath);
    return Boolean(key && this.shelfMetadata[key] && this.shelfMetadata[key].oneTime);
  }

  removeFileShelfMetadata(filePath) {
    const key = this._findShelfKey(filePath);
    if (key && this.shelfMetadata[key]) {
      delete this.shelfMetadata[key];
      safeWriteJson(SHELF_FILE, this.shelfMetadata);
    }
  }

  // --- IPC Registration ---

  registerIpc(ipcMain, getMainWindow) {
    // Calendar IPC
    ipcMain.handle('calendar-get-notes', () => this.getCalendarNotes());
    ipcMain.handle('calendar-get-categories', () => this.getCalendarCategories());
    ipcMain.handle('calendar-add-category', (event, cat) => {
      const ok = this.addCalendarCategory(cat);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('calendar-categories-updated', this.getCalendarCategories());
      return ok;
    });
    ipcMain.handle('calendar-add-note', (event, note) => {
      const created = this.addCalendarNote(note);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('calendar-notes-updated', this.getCalendarNotes());
        win.webContents.send('calendar-categories-updated', this.getCalendarCategories());
      }
      return created;
    });
    ipcMain.handle('calendar-delete-note', (event, id) => {
      const res = this.deleteCalendarNote(id);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('calendar-notes-updated', this.getCalendarNotes());
      return res;
    });

    // To-Do IPC
    ipcMain.handle('todo-get-data', () => this.getTodos());
    ipcMain.handle('todo-add-task', (event, task) => {
      const created = this.addTodoTask(task);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('todo-data-updated', this.getTodos());
      return created;
    });
    ipcMain.handle('todo-toggle-task', (event, id) => {
      const updated = this.toggleTodoTask(id);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('todo-data-updated', this.getTodos());
      return updated;
    });
    ipcMain.handle('todo-delete-task', (event, id) => {
      const res = this.deleteTodoTask(id);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('todo-data-updated', this.getTodos());
      return res;
    });
    ipcMain.handle('todo-add-category', (event, cat) => {
      const res = this.addTodoCategory(cat);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('todo-data-updated', this.getTodos());
      return res;
    });
    ipcMain.handle('todo-delete-category', (event, cat) => {
      const res = this.deleteTodoCategory(cat);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('todo-data-updated', this.getTodos());
      return res;
    });

    // Notes IPC
    ipcMain.handle('notes-get-all', () => this.getNotes());
    ipcMain.handle('notes-add', (event, note) => {
      const created = this.addNote(note);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('notes-updated', this.getNotes());
      return created;
    });
    ipcMain.handle('notes-update', (event, { id, title, body }) => {
      const updated = this.updateNote(id, { title, body });
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('notes-updated', this.getNotes());
      return updated;
    });
    ipcMain.handle('notes-delete', (event, id) => {
      const res = this.deleteNote(id);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('notes-updated', this.getNotes());
      return res;
    });

    // Clock IPC
    ipcMain.handle('clock-get-state', () => this.getClockState());
    ipcMain.on('clock-save-state', (event, state) => {
      this.saveClockState(state);
    });

    // Drop Shelf Metadata IPC
    ipcMain.handle('shelf-get-metadata', () => this.getShelfMetadata());
    ipcMain.on('shelf-set-metadata', (event, { filePath, isOneTime }) => {
      this.setFileShelfMetadata(filePath, isOneTime);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('shelf-metadata-updated', this.getShelfMetadata());
    });
    ipcMain.on('shelf-remove-metadata', (event, filePath) => {
      this.removeFileShelfMetadata(filePath);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('shelf-metadata-updated', this.getShelfMetadata());
    });
  }
}

module.exports = UserDataManager;
