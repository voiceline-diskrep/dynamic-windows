const EventEmitter = require('events');
const { spawn } = require('child_process');

function buildPsNotificationScript(suppressToasts = false) {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
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
      try { $app = ($n.AppInfo.DisplayInfo.DisplayName -replace '[\\p{Cc}\\p{Cf}]+', '').Trim() } catch {}
      $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      $texts = @()
      if ($binding) {
        foreach ($t in $binding.GetTextElements()) {
          if ($t.Text) {
            $cleaned = ($t.Text -replace '[\\p{Cc}\\p{Cf}]+', '').Trim()
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
      ${suppressToasts ? 'try { $listener.RemoveNotification($n.Id) } catch {}' : ''}
    }
    $list | ConvertTo-Json -Compress
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
}
`;
}

function sanitizeNotificationText(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input
    // Strip Unicode BiDi directional isolates / marks & replacement chars
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/g, '')
    // Strip '?...?' wrapping around sender names produced by OEM codepage fallback for BiDi isolates
    .replace(/(^|[\s~—\-|])\?+([^\s?][^?]*?)\?+(?=\s*:|$)/g, '$1$2')
    // Strip leading/trailing '?' adjacent to '~' sender prefix or before ':' in sender headers
    .replace(/~\?+/g, '~')
    .replace(/\?+:/g, ':')
    // Strip trailing '?' added by OEM fallback after standard WhatsApp/messenger media attachment labels
    .replace(/\b(Photo|Video|Audio|Sticker|GIF|Document|Voice message|Location|Contact card|Poll)\?(?=$|\s)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

class NotificationMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || 10000;
    this.suppressWindowsToasts = Boolean(options.suppressWindowsToasts);
    this.notifications = [];
    this.knownIds = new Set();
    this.isPolling = false;
    this.pollTimer = null;
    this.initialized = false;
  }

  start() {
    this.paused = false;
    if (this.suppressWindowsToasts) {
      this.applyWindowsToastSuppressionRegistry(true);
    }
    this.poll();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
    }
  }

  setSuppressWindowsToasts(enabled) {
    const next = Boolean(enabled);
    if (this.suppressWindowsToasts === next) return;
    this.suppressWindowsToasts = next;
    this.applyWindowsToastSuppressionRegistry(next);
  }

  applyWindowsToastSuppressionRegistry(suppress) {
    if (process.platform !== 'win32') return;
    try {
      const val = suppress ? 0 : 1;
      const psCmd = `
        $path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
        if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
        Set-ItemProperty -Path $path -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -Value ${val} -Type DWord -Force
      `;
      const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded
      ], { windowsHide: true });
      child.on('error', () => {});
    } catch (e) {}
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
    if (this.suppressWindowsToasts) {
      this.applyWindowsToastSuppressionRegistry(false);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  poll() {
    if (this.paused || this.isPolling || process.platform !== 'win32') return;
    this.isPolling = true;

    try {
      const script = buildPsNotificationScript(this.suppressWindowsToasts);
      const psEncoded = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', psEncoded
      ], { windowsHide: true });

      let stdout = '';
      if (child.stdout && typeof child.stdout.setEncoding === 'function') {
        child.stdout.setEncoding('utf8');
      }
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
        const appName = sanitizeNotificationText(item.app || 'Windows') || 'Windows';
        const cleanTitle = sanitizeNotificationText(item.title || '');
        const cleanBody = sanitizeNotificationText(item.body || '');
        const checkText = `${appName} ${cleanTitle} ${cleanBody}`.toLowerCase();
        if (checkText.includes('antigravity')) continue;

        const idStr = `win_${item.id}`;
        const isNew = !this.knownIds.has(idStr);
        this.knownIds.add(idStr);

        const notif = {
          id: idStr,
          app: appName,
          title: cleanTitle,
          body: cleanBody,
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
    const app = sanitizeNotificationText(entry.app || 'Dynamic Windows') || 'Dynamic Windows';
    const cleanTitle = sanitizeNotificationText(entry.title || '');
    const cleanBody = sanitizeNotificationText(entry.body || '');
    const checkText = `${app} ${cleanTitle} ${cleanBody}`.toLowerCase();
    if (checkText.includes('antigravity')) return null;

    const notif = {
      id: entry.id || `app_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      app: app,
      title: cleanTitle,
      body: cleanBody,
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

NotificationMonitor.sanitizeNotificationText = sanitizeNotificationText;
module.exports = NotificationMonitor;
