const EventEmitter = require('events');
const { exec } = require('child_process');
const path = require('path');

class NotificationMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || 2500;
    this.notifications = [];
    this.knownIds = new Set();
    this.isPolling = false;
    this.pollTimer = null;
    this.initialized = false;
  }

  start() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  poll() {
    if (this.isPolling) return;
    this.isPolling = true;

    const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& {
      try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
        [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
        $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
        $asyncOp = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
        $netTask = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]).Invoke($null, @($asyncOp))
        if ($netTask.Wait(2000)) {
          $notifs = $netTask.Result
          $list = @()
          foreach ($n in $notifs) {
            $app = $n.AppInfo.DisplayInfo.DisplayName
            $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
            $texts = @()
            if ($binding) {
              foreach ($t in $binding.GetTextElements()) { $texts += $t.Text }
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
      } catch {}
    }"`;

    exec(psCommand, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      this.isPolling = false;
      if (err || !stdout) return;

      try {
        const raw = stdout.trim();
        if (!raw || raw === 'null') return;
        let items = JSON.parse(raw);
        if (!Array.isArray(items)) items = [items];

        for (const item of items) {
          if (!item || !item.id) continue;
          const idStr = `win_${item.id}`;
          const isNew = !this.knownIds.has(idStr);
          this.knownIds.add(idStr);

          const notif = {
            id: idStr,
            app: (item.app || 'Windows').trim(),
            title: (item.title || '').trim(),
            body: (item.body || '').trim(),
            timestamp: item.creationTime ? new Date(item.creationTime).getTime() : Date.now(),
            icon: this.getIconForApp(item.app),
            read: !isNew || !this.initialized
          };

          if (isNew) {
            this.notifications.unshift(notif);
            if (this.notifications.length > 50) this.notifications.pop();

            // Only fire new notification alerts if we have finished the initial baseline scan
            if (this.initialized) {
              this.emit('new-notification', notif);
            }
          }
        }

        if (!this.initialized) {
          this.initialized = true;
          this.emit('notifications-updated', this.notifications);
        }
      } catch (e) {}
    });
  }

  addNotification(entry) {
    if (!entry) return null;
    const notif = {
      id: entry.id || `app_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      app: entry.app || 'Dynamic Windows',
      title: entry.title || '',
      body: entry.body || '',
      timestamp: entry.timestamp || Date.now(),
      icon: entry.icon || this.getIconForApp(entry.app),
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
    return [...this.notifications];
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
