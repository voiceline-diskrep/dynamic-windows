'use strict';
/**
 * Dynamic Windows - User Data Manager
 * Handles local persistence and IPC for Calendar, To-Do List, Clock/Timer, and Dual-Zone Drop Shelf.
 * Data files stored in %APPDATA%\DynamicWindows\
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
  'DynamicWindows'
);

const CALENDAR_FILE = path.join(DATA_DIR, 'calendar_notes.json');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
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
    this.todos = safeReadJson(TODOS_FILE, DEFAULT_TODOS);
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

  addCalendarNote(note) {
    if (!note || !note.text || !note.date) return null;
    const newNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      date: String(note.date).slice(0, 10), // YYYY-MM-DD
      text: String(note.text).trim(),
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

  // --- Drop Shelf Metadata (Dual-Zone: One-Time vs Keep) ---

  getShelfMetadata() {
    return this.shelfMetadata;
  }

  setFileShelfMetadata(filePath, isOneTime) {
    if (!filePath || typeof filePath !== 'string') return;
    const norm = path.normalize(filePath);
    this.shelfMetadata[norm] = {
      oneTime: Boolean(isOneTime),
      addedAt: Date.now()
    };
    safeWriteJson(SHELF_FILE, this.shelfMetadata);
  }

  isOneTimeFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const norm = path.normalize(filePath);
    return Boolean(this.shelfMetadata[norm] && this.shelfMetadata[norm].oneTime);
  }

  removeFileShelfMetadata(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    const norm = path.normalize(filePath);
    if (this.shelfMetadata[norm]) {
      delete this.shelfMetadata[norm];
      safeWriteJson(SHELF_FILE, this.shelfMetadata);
    }
  }

  // --- IPC Registration ---

  registerIpc(ipcMain, getMainWindow) {
    // Calendar IPC
    ipcMain.handle('calendar-get-notes', () => this.getCalendarNotes());
    ipcMain.handle('calendar-add-note', (event, note) => {
      const created = this.addCalendarNote(note);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('calendar-notes-updated', this.getCalendarNotes());
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
