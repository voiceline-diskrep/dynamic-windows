'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const UserDataManager = require('../src/main/user-data-manager');

test('UserDataManager: Recurrence Engine', async (t) => {
  await t.test('matches exact date for recurrence "none"', () => {
    const note = { date: '2026-11-05', repeat: 'none', text: 'Doctor appointment' };
    assert.equal(UserDataManager.matchesDate(note, '2026-11-05'), true);
    assert.equal(UserDataManager.matchesDate(note, '2026-11-06'), false);
    assert.equal(UserDataManager.matchesDate(note, '2027-11-05'), false);
  });

  await t.test('matches yearly / birthday across different years', () => {
    const birthday = { date: '2000-08-15', repeat: 'yearly', text: 'Sarah Birthday' };
    assert.equal(UserDataManager.matchesDate(birthday, '2026-08-15'), true);
    assert.equal(UserDataManager.matchesDate(birthday, '2027-08-15'), true);
    assert.equal(UserDataManager.matchesDate(birthday, '2026-08-16'), false);
  });

  await t.test('matches monthly on the same day of month', () => {
    const rent = { date: '2026-01-01', repeat: 'monthly', text: 'Pay Rent' };
    assert.equal(UserDataManager.matchesDate(rent, '2026-05-01'), true);
    assert.equal(UserDataManager.matchesDate(rent, '2026-11-01'), true);
    assert.equal(UserDataManager.matchesDate(rent, '2026-11-02'), false);
  });

  await t.test('matches weekly on the same day of week', () => {
    // 2026-11-05 is a Thursday (day 4)
    const standup = { date: '2026-11-05', repeat: 'weekly', text: 'Weekly Sync' };
    // 2026-11-12 is the following Thursday
    assert.equal(UserDataManager.matchesDate(standup, '2026-11-12'), true);
    // 2026-11-13 is Friday
    assert.equal(UserDataManager.matchesDate(standup, '2026-11-13'), false);
  });

  await t.test('matches daily on or after start date', () => {
    const habit = { date: '2026-11-01', repeat: 'daily', text: 'Morning Workout' };
    assert.equal(UserDataManager.matchesDate(habit, '2026-11-05'), true);
    assert.equal(UserDataManager.matchesDate(habit, '2026-10-31'), false);
  });
});

test('UserDataManager: To-Do Management', async (t) => {
  const manager = new UserDataManager();

  await t.test('adds, toggles, and deletes tasks', () => {
    const task = manager.addTodoTask({ text: 'Test new feature', category: 'Work' });
    assert.ok(task && task.id);
    assert.equal(task.text, 'Test new feature');
    assert.equal(task.completed, false);

    const toggled = manager.toggleTodoTask(task.id);
    assert.ok(toggled);
    assert.equal(toggled.completed, true);
    assert.ok(toggled.completedAt);

    const deleted = manager.deleteTodoTask(task.id);
    assert.equal(deleted, true);
  });

  await t.test('manages custom categories', () => {
    const catName = 'Projects_' + Date.now();
    const added = manager.addTodoCategory(catName);
    assert.equal(added, true);
    assert.ok(manager.getTodos().categories.includes(catName));

    const deleted = manager.deleteTodoCategory(catName);
    assert.equal(deleted, true);
    assert.equal(manager.getTodos().categories.includes(catName), false);
  });
});

test('UserDataManager: Dual-Zone Drop Shelf Metadata', async (t) => {
  const manager = new UserDataManager();
  const testFile1 = 'C:\\temp\\whatsapp_upload.png';
  const testFile2 = 'C:\\temp\\keep_document.pdf';

  manager.setFileShelfMetadata(testFile1, true); // One-Time Use
  manager.setFileShelfMetadata(testFile2, false); // Keep

  assert.equal(manager.isOneTimeFile(testFile1), true);
  assert.equal(manager.isOneTimeFile(testFile2), false);

  manager.removeFileShelfMetadata(testFile1);
  assert.equal(manager.isOneTimeFile(testFile1), false);
  manager.removeFileShelfMetadata(testFile2);
});
