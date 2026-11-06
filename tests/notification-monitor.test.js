const test = require('node:test');
const assert = require('node:assert');
const NotificationMonitor = require('../src/main/notification-monitor');

test('NotificationMonitor: initializes with empty list', () => {
  const nm = new NotificationMonitor({ pollIntervalMs: 60000 });
  assert.strictEqual(nm.getNotifications().length, 0);
  assert.strictEqual(nm.initialized, false);
});

test('NotificationMonitor: addNotification adds and emits', () => {
  const nm = new NotificationMonitor({ pollIntervalMs: 60000 });
  let emitted = null;
  nm.on('new-notification', (notif) => {
    emitted = notif;
  });

  const added = nm.addNotification({
    app: 'WhatsApp',
    title: 'Evan',
    body: 'Hello there'
  });

  assert.ok(added);
  assert.strictEqual(added.app, 'WhatsApp');
  assert.strictEqual(added.title, 'Evan');
  assert.strictEqual(added.body, 'Hello there');
  assert.strictEqual(added.icon, '💬');
  assert.strictEqual(added.read, false);
  assert.strictEqual(emitted, added);
  assert.strictEqual(nm.getNotifications().length, 1);
});

test('NotificationMonitor: dismiss removes notification by id', () => {
  const nm = new NotificationMonitor({ pollIntervalMs: 60000 });
  const n1 = nm.addNotification({ app: 'Discord', title: 'Call', body: 'Incoming' });
  const n2 = nm.addNotification({ app: 'Chrome', title: 'Download', body: 'Complete' });

  assert.strictEqual(nm.getNotifications().length, 2);
  const dismissed = nm.dismiss(n1.id);
  assert.strictEqual(dismissed, true);
  assert.strictEqual(nm.getNotifications().length, 1);
  assert.strictEqual(nm.getNotifications()[0].id, n2.id);
});

test('NotificationMonitor: clearAll and markAllRead', () => {
  const nm = new NotificationMonitor({ pollIntervalMs: 60000 });
  nm.addNotification({ app: 'Test1', title: 'T1' });
  nm.addNotification({ app: 'Test2', title: 'T2' });

  assert.strictEqual(nm.getNotifications().length, 2);
  assert.strictEqual(nm.getNotifications().some(n => n.read), false);

  nm.markAllRead();
  assert.strictEqual(nm.getNotifications().every(n => n.read), true);

  nm.clearAll();
  assert.strictEqual(nm.getNotifications().length, 0);
});

test('NotificationMonitor: getIconForApp mappings', () => {
  const nm = new NotificationMonitor({ pollIntervalMs: 60000 });
  assert.strictEqual(nm.getIconForApp('WhatsApp'), '💬');
  assert.strictEqual(nm.getIconForApp('Discord'), '🎮');
  assert.strictEqual(nm.getIconForApp('Google Antigravity'), '🤖');
  assert.strictEqual(nm.getIconForApp('Google Chrome'), '🌐');
  assert.strictEqual(nm.getIconForApp('Snipping Tool'), '✂️');
  assert.strictEqual(nm.getIconForApp('Unknown App'), '🔔');
});
