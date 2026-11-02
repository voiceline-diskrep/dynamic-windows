# What is playing on this PC, read from Windows itself (the same info as the media controls next to the volume):
# Liner, Spotify, YouTube in a browser, or any other app that plays. No login and no Spotify developer account needed.
# Started hidden by media-spotify.js. Writes one JSON line when something changes, and reads commands from stdin:
# play, pause, toggle, next, previous, seek <ms>, vol <0-100>, mute <0/1>. Stops when Dynamic Windows closes its stdin.
# Also reports the Windows volume and whether something runs full screen (Game Mode).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); if ($t.IsCompleted) { $t.Result } else { $null } }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($Manager::RequestAsync()) $Manager
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

# Whatever really plays wins (Liner first, then Spotify, then the app Windows calls "now playing", then any other: YouTube in a
# browser too). When nothing plays: the app you last listened to (paused), else Liner or Spotify (paused).
$script:keep = ''
function Playing($x) { $x -and [int]$x.GetPlaybackInfo().PlaybackStatus -eq 4 }
function Pick {
  $all = @($mgr.GetSessions())
  $liner = $all | Where-Object { $_.SourceAppUserModelId -match 'liner' } | Select-Object -First 1
  $spotify = $all | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1
  $now = $mgr.GetCurrentSession()
  $live = $(if (Playing $liner) { $liner } elseif (Playing $spotify) { $spotify } elseif (Playing $now) { $now } else { $all | Where-Object { Playing $_ } | Select-Object -First 1 })
  if ($live) { $script:keep = $live.SourceAppUserModelId; return $live }
  if ($script:keep) { $old = $all | Where-Object { $_.SourceAppUserModelId -eq $script:keep } | Select-Object -First 1; if ($old) { return $old } }
  $script:keep = ''
  if ($liner) { return $liner }
  if ($spotify) { return $spotify }
  return $now
}

function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3)); [Console]::Out.Flush() }

# Game mode: does something run full screen? The same answer Windows uses for "do not disturb while gaming":
# 2 = a full-screen app (also borderless games and videos), 3 = a full-screen Direct3D game, 4 = presentation mode, 7 = a full-screen Store app.
try { Add-Type -Namespace DynamicWindows -Name Quns -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);' } catch {}
$fullAt = [DateTime]::MinValue; $wasFull = $null
function CheckFull {
  try { $q = 0; [void][DynamicWindows.Quns]::SHQueryUserNotificationState([ref]$q); $f = @(2, 3, 4, 7) -contains $q } catch { return }
  if ($f -ne $script:wasFull) { $script:wasFull = $f; Say @{ fullscreen = $f } }
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $reader.ReadLineAsync()
$last = ''; $lastArt = ''; $nextLook = [DateTime]::MinValue; $lastPos = 0; $lastAt = [DateTime]::UtcNow; $lastPlaying = $false
while ($true) {
  if ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($null -eq $cmd) { break }
    $parts = $cmd.Trim().Split(' ')
    try {
      $s = Pick
      if ($s) {
        switch ($parts[0]) {
          'play' { [void](Await ($s.TryPlayAsync()) ([bool])) }
          'pause' { [void](Await ($s.TryPauseAsync()) ([bool])) }
          'toggle' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
          'next' { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
          'previous' { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
          'seek' { [void](Await ($s.TryChangePlaybackPositionAsync([long]$parts[1] * 10000)) ([bool])) }
        }
      }
    } catch {}
    $pending = $reader.ReadLineAsync(); $nextLook = [DateTime]::MinValue; $last = ''
  }
  if ([DateTime]::UtcNow -ge $nextLook) {
    $nextLook = [DateTime]::UtcNow.AddMilliseconds(700)
    try {
      $s = Pick
      if (-not $s) { $out = @{ active = $false } }
      else {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $Props
        $info = $s.GetPlaybackInfo()
        $tl = $s.GetTimelineProperties()
        $playing = [int]$info.PlaybackStatus -eq 4
        $rate = 1.0
        if ($info.PlaybackRate) { $rate = [double]$info.PlaybackRate }
        $pos = $tl.Position.TotalMilliseconds
        if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds * $rate }
        $dur = ($tl.EndTime - $tl.StartTime).TotalMilliseconds
        $key = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
        $out = @{ active = [bool]$p.Title; app = [string]$s.SourceAppUserModelId; playing = $playing; rate = [double]$rate; title = [string]$p.Title; artist = [string]$p.Artist
          album = [string]$p.AlbumTitle; duration = [long][Math]::Max(0, $dur); position = [long][Math]::Max(0, [Math]::Min($pos, [Math]::Max($dur, $pos))); key = $key }
        if ($key -ne $lastArt -and $p.Thumbnail) {
          try {
            $ras = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            $net = $asStream.Invoke($null, @($ras))
            $ms = New-Object System.IO.MemoryStream; $net.CopyTo($ms)
            if ($ms.Length -gt 0 -and $ms.Length -lt 3MB) { $out.art = [Convert]::ToBase64String($ms.ToArray()) }
            $lastArt = $key
          } catch { $lastArt = $key }
        }
      }
      $same = ($out.Clone()); $same.Remove('position'); $same.Remove('art')
      $now = ($same | ConvertTo-Json -Compress)
      $expected = $lastPos + $(if ($lastPlaying) { ([DateTime]::UtcNow - $lastAt).TotalMilliseconds } else { 0 })
      $jumped = $out.active -and [Math]::Abs([double]$out.position - $expected) -gt 1500
      if ($now -ne $last -or $out.art -or $jumped) {
        Say $out; $last = $now
        if ($out.active) { $lastPos = [double]$out.position; $lastAt = [DateTime]::UtcNow; $lastPlaying = [bool]$out.playing }
      }
    } catch { Say @{ active = $false; error = $_.Exception.Message } }
  }
  if ([DateTime]::UtcNow -ge $fullAt) { $fullAt = [DateTime]::UtcNow.AddMilliseconds(500); CheckFull }
  Start-Sleep -Milliseconds 100
}
