'use strict';
/**
 * Dynamic Windows - Universal Media & Synced Lyrics Controller
 * Modeled after TwoCode's exact GSMTC + LRCLIB architecture (media-main.cjs + lyrics-main.cjs)
 * with strict Liner richsync/TTML cache fallback.
 */

const { app, net } = require('electron');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LRCLIB_API = 'https://lrclib.net/api';
const NONE_DAYS = 7;

function parseTimecode(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (s.includes(':')) {
    const p = s.split(':');
    return ((parseFloat(p[0]) || 0) * 60 + (parseFloat(p[1]) || 0)) * 1000;
  }
  return (parseFloat(s) || 0) * 1000;
}

/** "[01:02.50] words" -> [{ t: ms, text }], sorted ascending by timestamp in ms. */
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]+>/g, '').trim();
    if (/^(length|re|ti|ar|al|by|offset):/i.test(text)) continue;
    for (const m of stamps) {
      const t = Math.round((Number(m[1]) * 60 + Number(m[2].replace(':', '.'))) * 1000);
      lines.push({ t, text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** Clean video/remaster tags from track & artist names just like TwoCode's lyrics-ui.js */
function cleanTrackQuery(rawTitle, rawArtist, durationMs) {
  let title = String(rawTitle || '').trim();
  let artist = String(rawArtist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  title = title
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|remaster(ed)?)\b[^)\]]*[)\]]/gi, '')
    .trim();

  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (dash) {
    if (artist && dash[1].toLowerCase() === artist.toLowerCase()) {
      title = dash[2];
    } else if (!artist || !title.toLowerCase().includes(artist.toLowerCase())) {
      artist = dash[1];
      title = dash[2];
    }
  }

  return {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    artist: artist.replace(/\s+/g, ' ').trim().slice(0, 200),
    duration: Math.max(0, Math.min(7200, Math.round((Number(durationMs) || 0) / 1000)))
  };
}

function appNameFromId(id) {
  const s = String(id || '');
  if (/liner/i.test(s)) return 'Liner';
  if (/spotify/i.test(s)) return 'Spotify';
  if (/chrome/i.test(s)) return 'Chrome';
  if (/edge|msedge/i.test(s)) return 'Edge';
  if (/firefox/i.test(s)) return 'Firefox';
  if (/brave/i.test(s)) return 'Brave';
  if (/opera/i.test(s)) return 'Opera';
  if (/zune|music|wmplayer|vlc/i.test(s)) return 'Media Player';
  return s ? 'Windows Media' : 'none';
}

class MediaController extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.startedAt = 0;
    this.now = { active: false };
    this.at = 0;
    this.cover = { key: '', url: '' };
    this.fullscreen = false;

    this.lyricsMemory = new Map();
    this.lyricsAsking = new Map();
    this.currentSongKey = '';
    this.currentLyrics = []; // [{ t: ms, text }]
    this.plainLyrics = [];
    this.instrumental = false;

    // Slowed + Reverb playback speed & sync offset support
    this.userPlaybackRate = null; // null = auto
    this.reportedRate = 1.0;
    this.autoDetectedRate = 1.0;
    this.lyricOffsetMs = 0;
    this.lastProgressSample = { pos: 0, at: 0, key: '' };

    this.linerCacheDir = path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
      '@liner',
      'client',
      'Cache',
      'Cache_Data'
    );

    this.startHelper();
    // Periodic watchdog to ensure helper stays alive and lyrics stay fresh
    this.watchdog = setInterval(() => {
      if (!this.child) this.startHelper();
    }, 5000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  getLyricsCacheFolder() {
    try {
      return path.join(app.getPath('userData'), 'lyrics');
    } catch {
      return path.join(process.env.APPDATA || 'C:\\', 'DynamicWindows', 'lyrics');
    }
  }

  startHelper() {
    if (this.child || process.platform !== 'win32' || Date.now() - this.startedAt < 5000) return;
    this.startedAt = Date.now();
    try {
      const scriptPath = path.join(__dirname, 'media-session.ps1');
      this.child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } catch {
      this.child = null;
      return;
    }

    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.handleHelperLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
      if (buf.length > 8e6) buf = '';
    });

    this.child.stdin.on('error', () => {});
    this.child.on('error', () => {
      this.child = null;
    });
    this.child.on('exit', () => {
      this.child = null;
      this.now = { active: false };
      this.emit('changed');
    });
  }

  handleHelperLine(line) {
    if (!line) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }

    if ('fullscreen' in o) {
      const isFull = Boolean(o.fullscreen);
      if (this.fullscreen !== isFull) {
        this.fullscreen = isFull;
        this.emit('fullscreen', isFull);
      }
      return;
    }

    if (o.art) {
      try {
        const head = Buffer.from(o.art.slice(0, 8), 'base64');
        const type =
          head[0] === 0x89
            ? 'image/png'
            : head[0] === 0xff
            ? 'image/jpeg'
            : head[0] === 0x47
            ? 'image/gif'
            : 'image/png';
        this.cover = { key: String(o.key || ''), url: `data:${type};base64,${o.art}` };
      } catch {}
    }

    delete o.art;
    this.now = o;
    this.at = Date.now();

    if (typeof o.rate === 'number' && o.rate > 0) {
      this.reportedRate = o.rate;
    }

    // Auto-detect speed from player position delta over time
    if (this.lastProgressSample.at > 0 && o.playing && o.key === this.lastProgressSample.key) {
      const dt = this.at - this.lastProgressSample.at;
      const dPos = Number(o.position) - this.lastProgressSample.pos;
      if (dt >= 800 && dt <= 3500 && dPos >= 0 && dPos <= dt * 2.5) {
        const measuredRate = dPos / dt;
        if (measuredRate >= 0.4 && measuredRate <= 2.0) {
          this.autoDetectedRate = this.autoDetectedRate * 0.7 + measuredRate * 0.3;
        }
      }
    }
    this.lastProgressSample = { pos: Number(o.position) || 0, at: this.at, key: String(o.key || '') };

    const songKey = o.active && o.title ? `${o.title}|${o.artist || ''}` : '';
    if (songKey !== this.currentSongKey) {
      this.currentSongKey = songKey;
      this.currentLyrics = [];
      this.plainLyrics = [];
      this.instrumental = false;
      if (songKey) {
        this.resolveLyricsForTrack({
          title: o.title,
          artist: o.artist || '',
          album: o.album || '',
          durationMs: Number(o.duration) || 0,
          source: appNameFromId(o.app),
          songKey
        });
      }
    }

    this.emit('changed');
  }

  async fetchJson(url) {
    const fetchFn = (net && typeof net.fetch === 'function') ? net.fetch.bind(net) : global.fetch;
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'DynamicWindows/1.2.0 (https://github.com/RussellPetra/Dynamic-windows)' }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('lrclib ' + res.status);
    return res.json();
  }

  async lookupLrclib(q) {
    const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
    if (q.album && q.album.toLowerCase() !== 'liner') params.set('album_name', q.album);
    if (q.duration) params.set('duration', String(Math.round(q.duration)));

    let hit = await this.fetchJson(`${LRCLIB_API}/get?${params}`).catch(() => null);
    if (!hit?.syncedLyrics && !hit?.instrumental) {
      const searchParams = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
      const found = await this.fetchJson(`${LRCLIB_API}/search?${searchParams}`).catch(() => null);
      const list = Array.isArray(found) ? found : [];
      const synced = list.filter((x) => x && x.syncedLyrics);
      hit =
        synced.find((x) => !q.duration || Math.abs((x.duration || 0) - q.duration) <= 3) ||
        synced[0] ||
        hit;

      // If still not found and title has "(feat. ...)", retry stripped title
      if (!hit?.syncedLyrics && /\b(feat\.?|ft\.?|with)\b/i.test(q.title)) {
        const strippedTitle = q.title
          .replace(/\s*[([][^)\]]*\b(feat\.?|ft\.?|with)\b[^)\]]*[)\]]/gi, '')
          .replace(/\s+\b(feat\.?|ft\.?)\s+.+$/i, '')
          .trim();
        if (strippedTitle && strippedTitle !== q.title) {
          const found2 = await this.fetchJson(
            `${LRCLIB_API}/search?${new URLSearchParams({ track_name: strippedTitle, artist_name: q.artist })}`
          ).catch(() => null);
          const synced2 = (Array.isArray(found2) ? found2 : []).filter((x) => x && x.syncedLyrics);
          hit =
            synced2.find((x) => !q.duration || Math.abs((x.duration || 0) - q.duration) <= 4) ||
            synced2[0] ||
            hit;
        }
      }
    }

    if (hit?.instrumental) return { lines: [], instrumental: true };
    const lines = parseLrc(hit?.syncedLyrics);
    if (lines.some((l) => l.text)) {
      return { lines };
    }
    if (hit?.plainLyrics) {
      const plain = String(hit.plainLyrics)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { lines: [], plain };
    }
    return { lines: [] };
  }

  /**
   * Optional strict fallback for Liner's local cache: ONLY accepts a cache file if its
   * `"type":"metadata"` JSON explicitly matches BOTH the active track title and artist.
   */
  loadStrictLinerCacheFallback(rawTitle, rawArtist) {
    try {
      if (!fs.existsSync(this.linerCacheDir)) return null;
      const cleanTitle = String(rawTitle || '')
        .replace(/\s*[([][fF]eat\.?[^)\]]+[)\]]/g, '')
        .trim()
        .toLowerCase();
      const cleanArtist = String(rawArtist || '').split(/[,&]/)[0].trim().toLowerCase();
      if (!cleanTitle || !cleanArtist) return null;

      const files = fs.readdirSync(this.linerCacheDir);
      const candidates = files
        .map((f) => {
          try {
            return { f, mtime: fs.statSync(path.join(this.linerCacheDir, f)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 60);

      for (const item of candidates) {
        const fullPath = path.join(this.linerCacheDir, item.f);
        try {
          const data = fs.readFileSync(fullPath, 'utf8');
          if (!data.includes('"type":"metadata"')) continue;
          const metaMatch = data.match(/data:\s*(\{"type":"metadata"[^\n\r]+)/);
          if (!metaMatch) continue;

          const meta = JSON.parse(metaMatch[1]);
          const metaTitle = String(meta?.track?.title || meta?.track?.name || '').toLowerCase();
          const metaArtists = Array.isArray(meta?.track?.artists)
            ? meta.track.artists.map((a) => String(a.name || a).toLowerCase()).join(' ')
            : String(meta?.track?.artist || '').toLowerCase();

          // Strict verification: BOTH title and primary artist must match the metadata object!
          const titleMatches =
            metaTitle === String(rawTitle || '').toLowerCase() ||
            metaTitle.includes(cleanTitle) ||
            cleanTitle.includes(metaTitle);
          const artistMatches = metaArtists.includes(cleanArtist);
          if (!titleMatches || !artistMatches || !metaTitle) continue;

          const parsed = this.parseLinerCacheLyrics(data);
          if (parsed && parsed.length > 0) {
            return { lines: parsed };
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  parseLinerCacheLyrics(cacheContent) {
    const providerMatches = cacheContent.match(/data:\s*(\{"type":"provider"[^\n\r]+)/g);
    if (!providerMatches) return [];

    for (const pm of providerMatches) {
      try {
        const p = JSON.parse(pm.replace(/^data:\s*/, ''));
        if (p?.candidate?.lyrics?.content) {
          const content = p.candidate.lyrics.content;
          const format = String(p.candidate.lyrics.format || '').toLowerCase();

          // 1. Richsync JSON format
          if (format === 'richsync' || (typeof content === 'string' && content.trim().startsWith('['))) {
            const items = typeof content === 'string' ? JSON.parse(content) : content;
            if (Array.isArray(items)) {
              const timed = items
                .map((it) => {
                  let text = (it.x || (it.l ? it.l.map((w) => w.c || '').join('') : '')).trim();
                  text = text.replace(/<[^>]+>/g, '').trim();
                  const tMs = typeof it.ts === 'number' ? Math.round(it.ts * 1000) : 0;
                  return { t: tMs, text };
                })
                .filter((l) => l.text);
              if (timed.length > 0) return timed.sort((a, b) => a.t - b.t);
            }
          }

          // 2. TTML format (Polaris / Polaris Mono / Cadence)
          if (format === 'ttml' || (typeof content === 'string' && content.includes('<p'))) {
            const pRegex = /<p\b[^>]*\bbegin="([^"]+)"(?:\b[^>]*\bend="([^"]+)")?[^>]*>(.*?)<\/p>/gi;
            const timed = [];
            let match;
            while ((match = pRegex.exec(content)) !== null) {
              const tMs = Math.round(parseTimecode(match[1]));
              const cleaned = match[3]
                .replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim();
              if (cleaned && !cleaned.toLowerCase().includes('source:')) {
                timed.push({ t: tMs, text: cleaned });
              }
            }
            if (timed.length > 0) return timed.sort((a, b) => a.t - b.t);
          }

          // 3. LRC / QRC format
          if (format === 'lrc' || format === 'qrc' || (typeof content === 'string' && /\[\d{1,2}:\d{2}/.test(content))) {
            const timed = parseLrc(content);
            if (timed.length > 0) return timed;
          }
        }
      } catch {}
    }
    return [];
  }

  async resolveLyricsForTrack({ title, artist, album, durationMs, source, songKey }) {
    const q = cleanTrackQuery(title, artist, durationMs);
    q.album = String(album || '').trim().slice(0, 200);
    if (!q.title) return;

    const hashKey = crypto
      .createHash('sha1')
      .update([q.title, q.artist, Math.round(q.duration || 0)].join('|').toLowerCase())
      .digest('hex')
      .slice(0, 24);
    const cacheFile = path.join(this.getLyricsCacheFolder(), hashKey + '.json');

    let result = null;
    if (this.lyricsMemory.has(hashKey)) {
      result = this.lyricsMemory.get(hashKey);
    } else {
      try {
        const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (
          saved.lines?.length ||
          saved.instrumental ||
          Date.now() - (saved.at || 0) < NONE_DAYS * 864e5
        ) {
          this.lyricsMemory.set(hashKey, saved);
          result = saved;
        }
      } catch {}
    }

    if (!result || (!result.lines?.length && source === 'Liner')) {
      if (this.lyricsAsking.has(hashKey)) {
        result = await this.lyricsAsking.get(hashKey);
      } else {
        const job = (async () => {
          let ans = { lines: [] };
          if (q.artist) {
            ans = await this.lookupLrclib(q).catch(() => ({ lines: [], failed: true }));
          }
          // Bonus fallback: if LRCLIB had no synced lines and Liner is playing, check strict Liner cache
          if (!ans.lines?.length) {
            const linerAns = this.loadStrictLinerCacheFallback(title, artist);
            if (linerAns && linerAns.lines?.length) {
              ans = linerAns;
            }
          }
          if (!ans.failed) {
            const saved = { ...ans, at: Date.now() };
            this.lyricsMemory.set(hashKey, saved);
            try {
              fs.mkdirSync(this.getLyricsCacheFolder(), { recursive: true });
              fs.writeFileSync(cacheFile, JSON.stringify(saved));
            } catch {}
            return saved;
          }
          return ans;
        })().finally(() => this.lyricsAsking.delete(hashKey));

        this.lyricsAsking.set(hashKey, job);
        result = await job;
      }
    }

    // Apply only if the user hasn't skipped to another song while fetching
    if (this.currentSongKey === songKey && result) {
      this.currentLyrics = Array.isArray(result.lines) ? result.lines : [];
      this.plainLyrics = Array.isArray(result.plain)
        ? result.plain
        : this.currentLyrics.map((l) => l.text);
      this.instrumental = Boolean(result.instrumental);
      this.emit('changed');
    }
  }

  sendCommand(cmd) {
    this.startHelper();
    try {
      this.child?.stdin.write(cmd + '\n');
      return true;
    } catch {
      return false;
    }
  }

  playPause() {
    this.sendCommand('toggle');
  }

  nextTrack() {
    this.sendCommand('next');
  }

  prevTrack() {
    this.sendCommand('previous');
  }

  seek(ms) {
    const targetMs = Math.max(0, Math.round(Number(ms) || 0));
    if (this.now && this.now.active) {
      this.now.position = targetMs;
      this.at = Date.now();
      this.emit('changed');
    }
    this.sendCommand('seek ' + targetMs);
  }

  getEffectiveRate() {
    if (typeof this.userPlaybackRate === 'number' && this.userPlaybackRate > 0) {
      return this.userPlaybackRate;
    }
    if (typeof this.reportedRate === 'number' && Math.abs(this.reportedRate - 1.0) > 0.05) {
      return this.reportedRate;
    }
    if (typeof this.autoDetectedRate === 'number' && Math.abs(this.autoDetectedRate - 1.0) > 0.05) {
      return Math.round(this.autoDetectedRate * 100) / 100;
    }
    return 1.0;
  }

  setPlaybackSpeed(rate) {
    this.userPlaybackRate = (typeof rate === 'number' && rate > 0) ? rate : null;
    this.emit('changed');
  }

  setLyricOffset(offsetMs) {
    this.lyricOffsetMs = Number(offsetMs) || 0;
    this.emit('changed');
  }

  getProgressMs() {
    if (!this.now || !this.now.active) return 0;
    const playing = Boolean(this.now.playing);
    const duration = Number(this.now.duration) || 0;
    let progress = Number(this.now.position) || 0;
    if (playing && this.at > 0) {
      const dt = Date.now() - this.at;
      progress += dt * this.getEffectiveRate();
    }
    if (duration > 0) {
      progress = Math.min(progress, duration);
    }
    return Math.max(0, Math.round(progress));
  }

  getCurrentLyricAt(progressMs) {
    if (!this.currentLyrics || this.currentLyrics.length === 0) return '';
    const pos = progressMs + 250; // 250ms lead just like TwoCode
    let idx = -1;
    for (let k = 0; k < this.currentLyrics.length; k++) {
      if (this.currentLyrics[k].t <= pos) idx = k;
      else break;
    }
    if (idx < 0) return '';
    const since = pos - this.currentLyrics[idx].t;
    const next = this.currentLyrics[idx + 1];
    const isGap = next ? next.t - this.currentLyrics[idx].t > 14000 && since > 9000 : since > 8000;
    if (isGap) return '';
    return this.currentLyrics[idx].text || '';
  }

  getState() {
    if (!this.now || !this.now.active || !this.now.title) {
      return {
        isPlaying: false,
        progress_ms: 0,
        duration_ms: 0,
        track: {
          title: 'No media playing',
          artist: 'Open Liner, Spotify, or Media Player',
          source: 'none',
          album: '',
          image_url: '',
          lyrics: [],
          timedLyrics: [],
          currentLyric: ''
        }
      };
    }

    const playing = Boolean(this.now.playing);
    const duration = Number(this.now.duration) || 0;
    const progress = this.getProgressMs();
    const source = appNameFromId(this.now.app);
    const imageUrl = this.cover.key === this.now.key ? this.cover.url : '';
    const currentLyric = this.getCurrentLyricAt(progress);

    return {
      isPlaying: playing,
      progress_ms: progress,
      duration_ms: duration,
      playback_rate: this.getEffectiveRate(),
      user_speed: this.userPlaybackRate,
      lyric_offset_ms: this.lyricOffsetMs,
      track: {
        id: String(this.now.key || ''),
        title: String(this.now.title),
        artist: String(this.now.artist || this.now.album || source),
        album: String(this.now.album || ''),
        source,
        image_url: imageUrl,
        lyrics: this.plainLyrics,
        timedLyrics: this.currentLyrics, // [{ t: ms, text }]
        instrumental: this.instrumental,
        currentLyric
      }
    };
  }

  destroy() {
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {}
    this.child = null;
  }
}

module.exports = MediaController;
