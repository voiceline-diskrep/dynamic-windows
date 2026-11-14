const EventEmitter = require('events');
const { spawn } = require('child_process');
const path = require('path');

const PS_NOTIFICATION_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $asyncOp = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
  $netTask = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]).Invoke($null, @($asyncOp))
  if ($netTask.Wait(3500)) {
    $notifs = $netTask.Result
    $list = @()
    foreach ($n in $notifs) {
      $app = ''
      try { $app = ($n.AppInfo.DisplayInfo.DisplayName -replace '[\\p{Cc}]+', ' ').Trim() } catch {}
      $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      $texts = @()
      if ($binding) {
        foreach ($t in $binding.GetTextElements()) {
          if ($t.Text) {
            $cleaned = ($t.Text -replace '[\\p{Cc}]+', ' ').Trim()
            if ($cleaned) { $texts += $cleaned }
          }
        }
      }
      $title = if ($texts.Count -gt 0) { $texts[0] } else { '' }
      $body = if ($texts.Count -gt 1) { ($texts[1..($texts.Count-1)]) -join ' ' } else { '' }
      $list += [PSCustomObject]@{
        id = $n.Id
        app = $app
        title = $title
        body = $body
        creationTime = $n.CreationTime.ToString('o')
      }
    }
    $list | ConvertTo-Json -Compress
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
}
`;

const PS_ENCODED = Buffer.from(PS_NOTIFICATION_SCRIPT, 'utf16le').toString('base64');

class NotificationMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || 10000;
    this.notifications = [];
    this.knownIds = new Set();
    this.isPolling = false;
    this.pollTimer = null;
    this.initialized = false;
  }

  start() {
    this.paused = false;
    this.poll();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
    }
  }

  setPaused(paused) {
    const next = Boolean(paused);
    if (this.paused === next) return;
    this.paused = next;
    if (next) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    } else if (!this.pollTimer) {
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
    }
  }

  stop() {
    this.paused = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  poll() {
    if (this.paused || this.isPolling || process.platform !== 'win32') return;
    this.isPolling = true;

    try {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', PS_ENCODED
      ], { windowsHide: true });

      let stdout = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
      }, 5500);

      child.stdout.on('data', (d) => { stdout += d.toString(); });

      child.on('close', () => {
        clearTimeout(timer);
        this.isPolling = false;
        this.processRawOutput(stdout);
      });

      child.on('error', () => {
        clearTimeout(timer);
        this.isPolling = false;
      });
    } catch (err) {
      this.isPolling = false;
    }
  }

  processRawOutput(rawOutput) {
    if (!rawOutput) return;
    try {
      const sanitized = rawOutput.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
      if (!sanitized || sanitized === 'null') return;
      let items = JSON.parse(sanitized);
      if (!Array.isArray(items)) items = [items];

      let anyNew = false;
      for (const item of items) {
        if (!item || !item.id) continue;
        const appName = (item.app || 'Windows').trim();
        const checkText = `${appName} ${item.title || ''} ${item.body || ''}`.toLowerCase();
        if (checkText.includes('antigravity')) continue;

        const idStr = `win_${item.id}`;
        const isNew = !this.knownIds.has(idStr);
        this.knownIds.add(idStr);

        const notif = {
          id: idStr,
          app: appName,
          title: (item.title || '').trim(),
          body: (item.body || '').trim(),
          timestamp: item.creationTime ? new Date(item.creationTime).getTime() : Date.now(),
          icon: this.getIconForApp(appName),
          read: !isNew || !this.initialized
        };

        if (isNew) {
          anyNew = true;
          this.notifications.unshift(notif);
          if (this.notifications.length > 50) this.notifications.pop();

          // Only fire new notification alerts if we have finished the initial baseline scan
          if (this.initialized) {
            this.emit('new-notification', notif);
          }
        }
      }

      if (!this.initialized || anyNew) {
        this.initialized = true;
        this.emit('notifications-updated', this.notifications);
      }
    } catch (e) {}
  }

  addNotification(entry) {
    if (!entry) return null;
    const app = (entry.app || 'Dynamic Windows').trim();
    const checkText = `${app} ${entry.title || ''} ${entry.body || ''}`.toLowerCase();
    if (checkText.includes('antigravity')) return null;

    const notif = {
      id: entry.id || `app_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      app: app,
      title: entry.title || '',
      body: entry.body || '',
      timestamp: entry.timestamp || Date.now(),
      icon: entry.icon || this.getIconForApp(app),
      read: false
    };

    this.knownIds.add(notif.id);
    this.notifications.unshift(notif);
    if (this.notifications.length > 50) this.notifications.pop();

    this.emit('new-notification', notif);
    this.emit('notifications-updated', this.notifications);
    return notif;
  }

  dismiss(id) {
    const idx = this.notifications.findIndex(n => n.id === id);
    if (idx !== -1) {
      this.notifications.splice(idx, 1);
      this.emit('notifications-updated', this.notifications);
      return true;
    }
    return false;
  }

  clearAll() {
    this.notifications = [];
    this.emit('notifications-updated', this.notifications);
  }

  markAllRead() {
    for (const n of this.notifications) {
      n.read = true;
    }
    this.emit('notifications-updated', this.notifications);
  }

  getNotifications() {
    return this.notifications.filter(n => !String(n.app || '').toLowerCase().includes('antigravity'));
  }

  getIconForApp(appName) {
    const name = String(appName || '').toLowerCase();
    if (name.includes('whatsapp')) return '💬';
    if (name.includes('discord')) return '🎮';
    if (name.includes('antigravity')) return '🤖';
    if (name.includes('chrome') || name.includes('edge') || name.includes('browser')) return '🌐';
    if (name.includes('snip') || name.includes('screen')) return '✂️';
    if (name.includes('powertoys')) return '🛠️';
    if (name.includes('spotify') || name.includes('music')) return '🎵';
    if (name.includes('mail') || name.includes('outlook')) return '✉️';
    return '🔔';
  }
}

module.exports = NotificationMonitor;
