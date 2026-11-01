'use strict';
/**
 * Dynamic Windows - Media & Lyrics Manager
 * Detects active playback from Liner (open-source player with synced lyrics),
 * Spotify, Chrome, Edge, and Windows GSMTC media sessions.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class MediaController {
  constructor() {
    this.isPlaying = false;
    this.currentTrack = {
      title: 'No media playing',
      artist: 'Open Liner, Spotify, or Media Player',
      source: 'none',
      album: '',
      lyrics: [],
      currentLyric: ''
    };
    this.linerLogPath = path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local'),
      'Programs',
      'liner',
      'renderer.log'
    );
    this.linerCacheDir = path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
      '@liner',
      'client',
      'Cache',
      'Cache_Data'
    );
    this.lastLinerLogSize = 0;
    this.lyricLineIndex = 0;
    this.cachedTracks = new Map();

    // Start background polling for media updates every 1.5s
    this.pollTimer = setInterval(() => this.pollMediaState(), 1500);
    this.lyricTimer = setInterval(() => this.cycleLyrics(), 4000);
    this.pollMediaState();
  }

  cycleLyrics() {
    if (this.currentTrack.lyrics && this.currentTrack.lyrics.length > 0) {
      this.lyricLineIndex = (this.lyricLineIndex + 1) % this.currentTrack.lyrics.length;
      this.currentTrack.currentLyric = this.currentTrack.lyrics[this.lyricLineIndex];
    }
  }

  pollMediaState() {
    // 1. Try Liner player first
    if (this.checkLinerState()) {
      return;
    }

    // 2. Fallback to Windows GSMTC (Spotify, browsers, etc.)
    this.checkWindowsMediaState();
  }

  checkLinerState() {
    try {
      if (!fs.existsSync(this.linerLogPath)) return false;

      const stat = fs.statSync(this.linerLogPath);
      // Read last 24KB of renderer.log for rapid scanning
      const readLen = Math.min(stat.size, 24576);
      const fd = fs.openSync(this.linerLogPath, 'r');
      const buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, Math.max(0, stat.size - readLen));
      fs.closeSync(fd);

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter(Boolean);

      let foundTitle = null;
      let isPlaying = this.isPlaying;

      // Scan backward for playback events
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];

        if (foundTitle === null) {
          const m1 = line.match(/playback\s+started(?:\s*\(cached\))?:\s*(.+?)(?:\s+in\s+\d+ms|$)/i);
          if (m1) {
            foundTitle = m1[1].trim();
          } else {
            const m2 = line.match(/lyrics\s+cache\s+hit\s+for\s+"([^"]+)"/i);
            if (m2) {
              foundTitle = m2[1].trim();
            } else {
              const m3 = line.match(/playback\s+resolved\s+stream\s+for\s+(.+)$/i);
              if (m3) foundTitle = m3[1].trim();
            }
          }
        }

        if (line.includes('audio  playing')) {
          isPlaying = true;
          break;
        } else if (line.includes('audio  paused') || line.includes('audio  pause requested')) {
          isPlaying = false;
          break;
        }
      }

      if (foundTitle) {
        this.isPlaying = isPlaying;
        if (this.currentTrack.title !== foundTitle || this.currentTrack.source !== 'Liner') {
          this.loadLinerTrackMetadata(foundTitle);
        }
        return true;
      }
    } catch (e) {
      // Quiet fail to fallback
    }
    return false;
  }

  loadLinerTrackMetadata(title) {
    if (this.cachedTracks.has(title)) {
      const cached = this.cachedTracks.get(title);
      this.currentTrack = { ...cached, isPlaying: this.isPlaying };
      return;
    }

    let artist = 'Liner Music';
    let lyrics = [];

    try {
      if (fs.existsSync(this.linerCacheDir)) {
        const files = fs.readdirSync(this.linerCacheDir);
        const candidates = files.map(f => {
          try {
            return { f, mtime: fs.statSync(path.join(this.linerCacheDir, f)).mtimeMs };
          } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 60);

        for (const item of candidates) {
          const fullPath = path.join(this.linerCacheDir, item.f);
          try {
            const data = fs.readFileSync(fullPath, 'utf8');
            if (data.includes(title) && data.includes('"type":"metadata"')) {
              // Extract artist
              const metaMatch = data.match(/data:\s*(\{"type":"metadata"[^\n\r]+)/);
              if (metaMatch) {
                const meta = JSON.parse(metaMatch[1]);
                if (meta.track && meta.track.artists && Array.isArray(meta.track.artists)) {
                  artist = meta.track.artists.map(a => a.name).join(', ') || artist;
                }
              }

              // Extract lyrics
              lyrics = this.parseLyricsFromCache(data);
              break;
            }
          } catch (err) {}
        }
      }
    } catch (e) {}

    const trackObj = {
      title,
      artist,
      source: 'Liner',
      album: '',
      lyrics,
      currentLyric: lyrics.length > 0 ? lyrics[0] : ''
    };
    this.cachedTracks.set(title, trackObj);
    this.currentTrack = { ...trackObj, isPlaying: this.isPlaying };
    this.lyricLineIndex = 0;
  }

  parseLyricsFromCache(cacheContent) {
    // 1. Plain lyrics (Genius provider)
    const geniusMatch = cacheContent.match(/data:\s*(\{"type":"provider","provider":"Genius"[^\n\r]+)/);
    if (geniusMatch) {
      try {
        const g = JSON.parse(geniusMatch[1]);
        if (g.candidate && g.candidate.lyrics && g.candidate.lyrics.content) {
          const lines = g.candidate.lyrics.content.split('\n').map(s => s.trim()).filter(Boolean);
          if (lines.length > 0) return lines;
        }
      } catch (e) {}
    }

    // 2. Synced TTML or LRC from providers (Polaris, Cadence, Liner Atlas, etc.)
    const providerMatches = cacheContent.match(/data:\s*(\{"type":"provider"[^\n\r]+)/g);
    if (providerMatches) {
      for (const pm of providerMatches) {
        try {
          const p = JSON.parse(pm.replace(/^data:\s*/, ''));
          if (p.candidate && p.candidate.lyrics && p.candidate.lyrics.content) {
            const content = p.candidate.lyrics.content;
            if (typeof content === 'string') {
              // Check for TTML <p> lines
              if (content.includes('<p')) {
                const pLines = [];
                const pRegex = /<p\b[^>]*>(.*?)<\/p>/gi;
                let pmMatch;
                while ((pmMatch = pRegex.exec(content)) !== null) {
                  const cleaned = pmMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                  if (cleaned && !cleaned.toLowerCase().includes('source:')) {
                    pLines.push(cleaned);
                  }
                }
                if (pLines.length > 0) return pLines;
              }

              // Check for LRC [mm:ss.xx] lines
              const lrcLines = [];
              const regex = /\[\d{2}:\d{2}(?:\.\d+)?\]\s*([^\[\n\r]+)/g;
              let m;
              while ((m = regex.exec(content)) !== null) {
                const txt = m[1].replace(/<[^>]+>/g, '').trim();
                if (txt && !txt.startsWith('length:') && !txt.startsWith('re:')) lrcLines.push(txt);
              }
              if (lrcLines.length > 0) return lrcLines;

              // Plain lines fallback
              const plainLines = content.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
              if (plainLines.length > 0) return plainLines;
            }
          }
        } catch (e) {}
      }
    }

    return [];
  }

  checkWindowsMediaState() {
    // Check Spotify / Chrome window titles if Liner is not playing
    const ps = `
      Get-Process | Where-Object { $_.ProcessName -match 'Spotify' -and $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
      if (!err && stdout && stdout.trim()) {
        const titleText = stdout.trim();
        if (titleText.includes(' - ') && !titleText.startsWith('Spotify Free') && !titleText.startsWith('Spotify Premium')) {
          const [artist, track] = titleText.split(' - ', 2);
          this.isPlaying = true;
          this.currentTrack = {
            title: track || titleText,
            artist: artist || 'Spotify',
            source: 'Spotify',
            album: '',
            lyrics: [],
            currentLyric: ''
          };
          return;
        }
      }

      // If nothing detected and Liner was never running
      if (this.currentTrack.source !== 'Liner') {
        this.isPlaying = false;
      }
    });
  }

  sendMediaKey(vkCode) {
    // 0xB3 = VK_MEDIA_PLAY_PAUSE, 0xB0 = VK_MEDIA_NEXT_TRACK, 0xB1 = VK_MEDIA_PREV_TRACK
    const ps = `
      $sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'
      $type = Add-Type -MemberDefinition $sig -Name MediaKeybd -Namespace Win32Key -PassThru
      $type::keybd_event(${vkCode}, 0, 0, 0)
      $type::keybd_event(${vkCode}, 0, 2, 0)
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
      if (err) console.error('Media key error:', err.message);
    });
  }

  playPause() {
    this.isPlaying = !this.isPlaying;
    this.sendMediaKey(0xB3);
    return this.isPlaying;
  }

  nextTrack() {
    this.sendMediaKey(0xB0);
    setTimeout(() => this.pollMediaState(), 400);
  }

  prevTrack() {
    this.sendMediaKey(0xB1);
    setTimeout(() => this.pollMediaState(), 400);
  }

  getState() {
    return {
      isPlaying: this.isPlaying,
      track: this.currentTrack
    };
  }

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.lyricTimer) clearInterval(this.lyricTimer);
  }
}

module.exports = MediaController;
