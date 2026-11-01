'use strict';
/**
 * Dynamic Windows - Media & Lyrics Manager
 * Detects active playback from Liner (open-source player with synced lyrics),
 * Spotify, Chrome, Edge, and Windows GSMTC media sessions.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseTimecode(s) {
  if (!s) return 0;
  s = s.trim();
  if (s.includes(':')) {
    const p = s.split(':');
    return (parseFloat(p[0]) || 0) * 60 + (parseFloat(p[1]) || 0);
  }
  return parseFloat(s) || 0;
}

class MediaController {
  constructor() {
    this.isPlaying = false;
    this.currentTrack = {
      title: 'No media playing',
      artist: 'Open Liner, Spotify, or Media Player',
      source: 'none',
      album: '',
      lyrics: [],
      timedLyrics: [],
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
    this.lyricLineIndex = 0;
    this.cachedTracks = new Map();

    // Playback timing state for millisecond-exact synced lyrics
    this.activeTrackTitle = '';
    this.accumulatedPlayMs = 0;
    this.lastPlayTimestamp = 0;
    this.isLinerAudioPlaying = false;

    // Start background polling: media state every 1.2s, real-time lyric sync every 600ms
    this.pollTimer = setInterval(() => this.pollMediaState(), 1200);
    this.lyricTimer = setInterval(() => this.cycleLyrics(), 600);
    this.pollMediaState();
  }

  getPlaybackSeconds() {
    let ms = this.accumulatedPlayMs;
    if (this.isLinerAudioPlaying && this.lastPlayTimestamp > 0) {
      ms += (Date.now() - this.lastPlayTimestamp);
    }
    return ms / 1000;
  }

  cycleLyrics() {
    if (!this.isPlaying) return;

    // Real-time synced lyric matching via timestamps
    if (this.currentTrack.timedLyrics && this.currentTrack.timedLyrics.length > 0) {
      const pos = this.getPlaybackSeconds();
      const timed = this.currentTrack.timedLyrics;

      // Exact current line
      let active = timed.find(l => pos >= l.time && (!l.endTime || pos <= l.endTime));
      if (!active) {
        // Nearest past line (e.g. during an instrumental break)
        const past = timed.filter(l => pos >= l.time);
        if (past.length > 0) {
          active = past[past.length - 1];
        } else {
          active = timed[0];
        }
      }

      if (active && active.text) {
        this.currentTrack.currentLyric = active.text;
        return;
      }
    }

    // Fallback rotating lyrics for unsynced plain providers
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
      // Read last 32KB of renderer.log for rapid scanning
      const readLen = Math.min(stat.size, 32768);
      const fd = fs.openSync(this.linerLogPath, 'r');
      const buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, Math.max(0, stat.size - readLen));
      fs.closeSync(fd);

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter(Boolean);

      let foundTitle = null;
      let isAudioPlaying = this.isPlaying;

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
          isAudioPlaying = true;
          break;
        } else if (line.includes('audio  paused') || line.includes('audio  pause requested') || line.includes('audio  ended')) {
          isAudioPlaying = false;
          break;
        }
      }

      if (foundTitle) {
        // Track change detection
        if (this.activeTrackTitle !== foundTitle) {
          this.activeTrackTitle = foundTitle;
          this.accumulatedPlayMs = 0;
          this.lastPlayTimestamp = Date.now();
          this.isLinerAudioPlaying = isAudioPlaying;
        } else {
          // Playback state toggle (pause vs resume)
          if (isAudioPlaying && !this.isLinerAudioPlaying) {
            this.lastPlayTimestamp = Date.now();
            this.isLinerAudioPlaying = true;
          } else if (!isAudioPlaying && this.isLinerAudioPlaying) {
            this.accumulatedPlayMs += (Date.now() - this.lastPlayTimestamp);
            this.isLinerAudioPlaying = false;
          }
        }

        this.isPlaying = isAudioPlaying;

        // If title changed OR we have no lyrics yet, fetch metadata/lyrics from cache
        if (this.currentTrack.title !== foundTitle || this.currentTrack.source !== 'Liner' || !this.currentTrack.lyrics || this.currentTrack.lyrics.length === 0) {
          this.loadLinerTrackMetadata(foundTitle);
        } else {
          this.currentTrack.isPlaying = this.isPlaying;
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
      // Only use cached track if lyrics were already found
      if (cached.lyrics && cached.lyrics.length > 0) {
        this.currentTrack = { ...cached, isPlaying: this.isPlaying };
        return;
      }
    }

    let artist = 'Liner Music';
    let lyrics = [];
    let timedLyrics = [];

    try {
      if (fs.existsSync(this.linerCacheDir)) {
        const files = fs.readdirSync(this.linerCacheDir);
        const candidates = files.map(f => {
          try {
            return { f, mtime: fs.statSync(path.join(this.linerCacheDir, f)).mtimeMs };
          } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 80);

        // Normalize title for matching: remove " (feat. ...)" or " [feat. ...]"
        const cleanTitle = title.replace(/\s*[\(\[][fF]eat\.?[^\)\]]+[\)\]]/g, '').trim().toLowerCase();

        for (const item of candidates) {
          const fullPath = path.join(this.linerCacheDir, item.f);
          try {
            const data = fs.readFileSync(fullPath, 'utf8');
            const dataLower = data.toLowerCase();

            if ((dataLower.includes(cleanTitle) || dataLower.includes(title.toLowerCase())) && data.includes('"type":"metadata"')) {
              // Extract artist
              const metaMatch = data.match(/data:\s*(\{"type":"metadata"[^\n\r]+)/);
              if (metaMatch) {
                const meta = JSON.parse(metaMatch[1]);
                if (meta.track && meta.track.artists && Array.isArray(meta.track.artists)) {
                  artist = meta.track.artists.map(a => a.name).join(', ') || artist;
                }
              }

              // Extract lyrics
              const parsed = this.parseLyricsFromCache(data);
              if (parsed.length > 0) {
                lyrics = parsed;
                timedLyrics = parsed.timed || [];
                break;
              }
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
      timedLyrics,
      currentLyric: lyrics.length > 0 ? lyrics[0] : '',
      isPlaying: this.isPlaying
    };

    // Cache permanently only if lyrics have been successfully retrieved
    if (lyrics.length > 0) {
      this.cachedTracks.set(title, trackObj);
    }

    this.currentTrack = trackObj;
    this.lyricLineIndex = 0;
  }

  parseLyricsFromCache(cacheContent) {
    const providerMatches = cacheContent.match(/data:\s*(\{"type":"provider"[^\n\r]+)/g);
    if (!providerMatches) return [];

    for (const pm of providerMatches) {
      try {
        const p = JSON.parse(pm.replace(/^data:\s*/, ''));
        if (p.candidate && p.candidate.lyrics && p.candidate.lyrics.content) {
          const content = p.candidate.lyrics.content;
          const format = (p.candidate.lyrics.format || '').toLowerCase();

          // 1. Richsync format (Liner Atlas / TwoCode JSON)
          if (format === 'richsync' || (typeof content === 'string' && content.trim().startsWith('['))) {
            const items = typeof content === 'string' ? JSON.parse(content) : content;
            if (Array.isArray(items)) {
              const timed = items.map(it => {
                let text = (it.x || (it.l ? it.l.map(w => w.c || '').join('') : '')).trim();
                text = text.replace(/<[^>]+>/g, '').trim();
                return {
                  time: typeof it.ts === 'number' ? it.ts : 0,
                  endTime: typeof it.te === 'number' ? it.te : (it.ts ? it.ts + 3.5 : 0),
                  text
                };
              }).filter(l => l.text);
              if (timed.length > 0) {
                const plain = timed.map(l => l.text);
                plain.timed = timed;
                return plain;
              }
            }
          }

          // 2. TTML format (Polaris / Polaris Mono / Cadence)
          if (format === 'ttml' || (typeof content === 'string' && content.includes('<p'))) {
            const pRegex = /<p\b[^>]*\bbegin="([^"]+)"(?:\b[^>]*\bend="([^"]+)")?[^>]*>(.*?)<\/p>/gi;
            const timed = [];
            let match;
            while ((match = pRegex.exec(content)) !== null) {
              const b = parseTimecode(match[1]);
              const e = match[2] ? parseTimecode(match[2]) : b + 3.5;
              const cleaned = match[3]
                .replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim();
              if (cleaned && !cleaned.toLowerCase().includes('source:')) {
                timed.push({ time: b, endTime: e, text: cleaned });
              }
            }
            if (timed.length === 0) {
              const simple = /<p\b[^>]*>(.*?)<\/p>/gi;
              while ((match = simple.exec(content)) !== null) {
                const cleaned = match[1].replace(/<[^>]+>/g, '').trim();
                if (cleaned && !cleaned.toLowerCase().includes('source:')) {
                  timed.push({ time: 0, endTime: 0, text: cleaned });
                }
              }
            }
            if (timed.length > 0) {
              const plain = timed.map(l => l.text);
              plain.timed = timed;
              return plain;
            }
          }

          // 3. LRC or QRC format
          if (format === 'lrc' || format === 'qrc' || (typeof content === 'string' && /\[\d{1,2}:\d{2}/.test(content))) {
            const timed = [];
            const regex = /\[(\d{1,2}):(\d{2})(?:\.(\d+))?\]\s*([^\[\r\n]+)/g;
            let m;
            while ((m = regex.exec(content)) !== null) {
              const mins = parseInt(m[1], 10) || 0;
              const secs = parseInt(m[2], 10) || 0;
              const msStr = m[3] || '0';
              const ms = parseFloat('0.' + msStr) || 0;
              const t = mins * 60 + secs + ms;
              const txt = m[4].replace(/<[^>]+>/g, '').trim();
              if (txt && !txt.startsWith('length:') && !txt.startsWith('re:') && !txt.startsWith('ti:') && !txt.startsWith('ar:')) {
                timed.push({ time: t, endTime: t + 3.5, text: txt });
              }
            }
            if (timed.length > 0) {
              const plain = timed.map(l => l.text);
              plain.timed = timed;
              return plain;
            }
          }
        }
      } catch (e) {}
    }

    // 4. Plain lyrics (Genius provider fallback)
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
            timedLyrics: [],
            currentLyric: ''
          };
          return;
        }
      }

      // If nothing detected and Liner was never running
      if (this.currentTrack.source !== 'Liner') {
        this.isPlaying = false;
        this.currentTrack = {
          title: 'No media playing',
          artist: 'Open Liner, Spotify, or Media Player',
          source: 'none',
          album: '',
          lyrics: [],
          timedLyrics: [],
          currentLyric: ''
        };
      }
    });
  }

  playPause() {
    const ps = `
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.SendKeys([char]179)
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
    setTimeout(() => this.pollMediaState(), 300);
  }

  nextTrack() {
    const ps = `
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.SendKeys([char]176)
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
    setTimeout(() => this.pollMediaState(), 300);
  }

  prevTrack() {
    const ps = `
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.SendKeys([char]177)
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
    setTimeout(() => this.pollMediaState(), 300);
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
