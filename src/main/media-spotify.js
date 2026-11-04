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

/** "[01:02.50] words" -> [{ t: ms, end?: ms, text, words?: [{ t, end, text }] }], sorted ascending by timestamp in ms. */
function parseLrc(lrc) {
  const lines = [];
  let globalOffsetMs = 0;
  for (const raw of String(lrc || '').replace(/\\n/g, '\n').split(/\r?\n/)) {
    const offsetMatch = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      globalOffsetMs = Number(offsetMatch[1]) || 0;
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const bodyAfterLineStamps = raw.replace(/^\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/, '').trim();
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (/^(length|re|ti|ar|al|by|offset):/i.test(text)) continue;

    // Parse Enhanced LRC inline word timestamps if present: <mm:ss.xx>word
    let inlineWords = null;
    const wordTagRegex = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)/g;
    let wm;
    const rawWordTokens = [];
    while ((wm = wordTagRegex.exec(bodyAfterLineStamps)) !== null) {
      const wt = Math.max(0, Math.round((Number(wm[1]) * 60 + Number(wm[2].replace(':', '.'))) * 1000) - globalOffsetMs);
      const seg = wm[3] || '';
      const trimmed = seg.trim();
      if (trimmed) {
        rawWordTokens.push({
          t: wt,
          text: trimmed,
          hasLeadingSpace: /^\s/.test(seg),
          hasTrailingSpace: /\s$/.test(seg)
        });
      }
    }
    if (rawWordTokens.length > 0) {
      const merged = [];
      for (let i = 0; i < rawWordTokens.length; i++) {
        const cur = rawWordTokens[i];
        const next = rawWordTokens[i + 1];
        const endMs = next ? next.t : cur.t + 600;
        if (merged.length > 0 && !merged[merged.length - 1].hasTrailingSpace && !cur.hasLeadingSpace) {
          const prev = merged[merged.length - 1];
          prev.text += cur.text;
          prev.end = endMs;
          prev.hasTrailingSpace = cur.hasTrailingSpace;
        } else {
          merged.push({ t: cur.t, end: endMs, text: cur.text, hasTrailingSpace: cur.hasTrailingSpace });
        }
      }
      inlineWords = merged.map(({ t, end, text: wText }) => ({ t, end, text: wText }));
    }

    for (const m of stamps) {
      const t = Math.max(0, Math.round((Number(m[1]) * 60 + Number(m[2].replace(':', '.'))) * 1000) - globalOffsetMs);
      const lineObj = { t, text };
      if (inlineWords && inlineWords.length > 0) {
        lineObj.words = inlineWords;
      }
      lines.push(lineObj);
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
   * Strict lookup in Liner's local cache: ONLY accepts a cache entry if its
   * `"type":"metadata"` JSON explicitly matches BOTH the active track title and artist.
   * Prioritizes entries that include word-level timestamps (TTML spans / RichSync).
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
        .filter((f) => f.startsWith('f_'))
        .map((f) => {
          try {
            const st = fs.statSync(path.join(this.linerCacheDir, f));
            if (st.size < 250 || st.size > 400000) return null;
            return { f, mtime: st.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 450);

      let bestLineMatch = null;

      const checkStreamChunk = (data) => {
        if (!data || !data.includes('"type":"metadata"')) return null;
        const metaMatches = [...data.matchAll(/data:\s*(\{"type":"metadata"[^\n\r]+)/g)];
        for (const metaMatch of metaMatches) {
          try {
            const meta = JSON.parse(metaMatch[1]);
            const metaTitle = String(meta?.track?.title || meta?.track?.name || '').toLowerCase();
            const metaArtists = Array.isArray(meta?.track?.artists)
              ? meta.track.artists.map((a) => String(a.name || a).toLowerCase()).join(' ')
              : String(meta?.track?.artist || '').toLowerCase();

            const titleMatches =
              metaTitle === String(rawTitle || '').toLowerCase() ||
              metaTitle.includes(cleanTitle) ||
              cleanTitle.includes(metaTitle);
            const artistMatches = metaArtists.includes(cleanArtist);
            if (!titleMatches || !artistMatches || !metaTitle) continue;

            // Slice from this metadata event up to the next metadata event (important for data_1/data_2/data_3)
            const startIdx = metaMatch.index || 0;
            const nextMetaIdx = data.indexOf('event: metadata', startIdx + 20);
            const streamSlice = nextMetaIdx > startIdx ? data.slice(startIdx, nextMetaIdx) : data.slice(startIdx, startIdx + 120000);

            const parsed = this.parseLinerCacheLyrics(streamSlice);
            if (parsed && parsed.length > 0) {
              const hasWordSync = parsed.some((l) => Array.isArray(l.words) && l.words.length > 0);
              if (hasWordSync) {
                return { lines: parsed, hasWordSync: true };
              }
              if (!bestLineMatch) {
                bestLineMatch = { lines: parsed, hasWordSync: false };
              }
            }
          } catch {}
        }
        return null;
      };

      for (const item of candidates) {
        const fullPath = path.join(this.linerCacheDir, item.f);
        try {
          const data = fs.readFileSync(fullPath, 'utf8');
          const hit = checkStreamChunk(data);
          if (hit && hit.hasWordSync) return { lines: hit.lines };
        } catch {}
      }

      // Also scan Chromium SimpleCache block files (data_1, data_2, data_3) where <16KB SSE streams reside
      for (const blockFile of ['data_2', 'data_3', 'data_1']) {
        const blockPath = path.join(this.linerCacheDir, blockFile);
        if (!fs.existsSync(blockPath)) continue;
        try {
          const data = fs.readFileSync(blockPath, 'utf8');
          const hit = checkStreamChunk(data);
          if (hit && hit.hasWordSync) return { lines: hit.lines };
        } catch {}
      }

      if (bestLineMatch) return { lines: bestLineMatch.lines };
    } catch {}
    return null;
  }

  parseLyricsFromCache(cacheContent) {
    const timed = this.parseLinerCacheLyrics(cacheContent) || [];
    const plain = timed.map(l => l.text);
    plain.timed = timed.map(l => ({
      time: l.t / 1000,
      text: l.text,
      words: l.words
    }));
    return plain;
  }

  parseLinerCacheLyrics(cacheContent) {
    const rawMatches = String(cacheContent || '').split(/\r?\nevent:\s*/);
    const providers = [];
    for (const chunk of rawMatches) {
      const idx = chunk.indexOf('data:');
      if (idx === -1) continue;
      const jsonStr = chunk.slice(idx + 5).trim();
      try {
        const p = JSON.parse(jsonStr);
        if (p?.type === 'provider') providers.push(p);
      } catch {
        const lineMatch = jsonStr.match(/(\{"type":"provider"[^\n\r]+)/);
        if (lineMatch) {
          try {
            const p = JSON.parse(lineMatch[1]);
            if (p?.type === 'provider') providers.push(p);
          } catch {}
        }
      }
    }

    let fallbackLineCandidate = null;

    for (const p of providers) {
      try {
        if (p?.candidate?.lyrics?.content) {
          const content = p.candidate.lyrics.content;
          const format = String(p.candidate.lyrics.format || '').toLowerCase();

          // 1. Richsync JSON format
          if (format === 'richsync' || (format !== 'lrc' && format !== 'qrc' && typeof content === 'string' && content.trim().startsWith('[{'))) {
            const items = typeof content === 'string' ? JSON.parse(content) : content;
            if (Array.isArray(items)) {
              const timed = items
                .map((it, lineIdx) => {
                  let text = (it.x || (it.l ? it.l.map((w) => w.c || '').join('') : '')).trim();
                  text = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                  const tMs = typeof it.ts === 'number' ? Math.round(it.ts * 1000) : 0;
                  const nextLineStartMs = typeof items[lineIdx + 1]?.ts === 'number' ? Math.round(items[lineIdx + 1].ts * 1000) : null;
                  const lineEndMs = typeof it.te === 'number' ? Math.round(it.te * 1000) : (nextLineStartMs || tMs + 3000);
                  const lineObj = { t: tMs, end: lineEndMs, text };
                  if (Array.isArray(it.l) && it.l.length > 0) {
                    const rawTokens = it.l
                      .map((w) => {
                        const rawStr = String(w.c || '');
                        const wordText = rawStr.trim();
                        const offsetSec = typeof w.o === 'number' ? w.o : 0;
                        const startT = Math.round(tMs + offsetSec * 1000);
                        const durMs = typeof w.d === 'number' ? Math.round(w.d * 1000) : null;
                        return {
                          t: startT,
                          durMs,
                          text: wordText,
                          hasLeadingSpace: /^\s/.test(rawStr),
                          hasTrailingSpace: /\s$/.test(rawStr)
                        };
                      })
                      .filter((w) => Boolean(w.text));

                    // Check if tokens represent space-delimited syllables or separate words
                    const anyExplicitSpaces = rawTokens.some((w) => w.hasLeadingSpace || w.hasTrailingSpace);
                    const words = [];
                    for (let i = 0; i < rawTokens.length; i++) {
                      const cur = rawTokens[i];
                      const next = rawTokens[i + 1];
                      const endT = cur.durMs ? (cur.t + cur.durMs) : (next ? next.t : lineEndMs);
                      if (
                        anyExplicitSpaces &&
                        words.length > 0 &&
                        !words[words.length - 1].hasTrailingSpace &&
                        !cur.hasLeadingSpace
                      ) {
                        const prev = words[words.length - 1];
                        prev.text += cur.text;
                        prev.end = Math.max(prev.end, endT);
                        prev.hasTrailingSpace = cur.hasTrailingSpace;
                      } else {
                        words.push({
                          t: cur.t,
                          end: Math.max(cur.t + 80, endT),
                          text: cur.text,
                          hasTrailingSpace: cur.hasTrailingSpace
                        });
                      }
                    }
                    if (words.length > 0) {
                      lineObj.words = words.map(({ t, end, text: wText }) => ({ t, end, text: wText }));
                    }
                  }
                  return lineObj;
                })
                .filter((l) => l.text);
              if (timed.length > 0) {
                const sorted = timed.sort((a, b) => a.t - b.t);
                if (sorted.some((l) => l.words && l.words.length > 0)) return sorted;
                if (!fallbackLineCandidate) fallbackLineCandidate = sorted;
              }
            }
          }

          // 2. TTML format (Polaris / Polaris Mono / Cadence)
          if (format === 'ttml' || (typeof content === 'string' && content.includes('<p'))) {
            const pRegex = /<p\b([^>]*)>(.*?)<\/p>/gi;
            const timed = [];
            let match;
            while ((match = pRegex.exec(content)) !== null) {
              const pAttrs = match[1] || '';
              const beginMatch = pAttrs.match(/\bbegin="([^"]+)"/i);
              if (!beginMatch) continue;
              const endMatch = pAttrs.match(/\bend="([^"]+)"/i);
              const tMs = Math.round(parseTimecode(beginMatch[1]));
              const pEndMs = endMatch ? Math.round(parseTimecode(endMatch[1])) : null;
              const rawPContent = match[2];

              const decodeEntities = (str) =>
                String(str || '')
                  .replace(/&quot;/g, '"')
                  .replace(/&apos;/g, "'")
                  .replace(/&#39;/g, "'")
                  .replace(/&amp;/g, '&');

              const cleaned = decodeEntities(rawPContent.replace(/<[^>]+>/g, ''))
                .replace(/\s+/g, ' ')
                .trim();

              if (cleaned && !cleaned.toLowerCase().includes('source:')) {
                const lineObj = { t: tMs, text: cleaned };
                if (pEndMs && pEndMs > tMs) lineObj.end = pEndMs;

                const spanRegex = /<span\b([^>]*)>(.*?)<\/span>/gi;
                let sMatch;
                const rawSpans = [];
                while ((sMatch = spanRegex.exec(rawPContent)) !== null) {
                  const sAttrs = sMatch[1] || '';
                  const sBegin = sAttrs.match(/\bbegin="([^"]+)"/i);
                  if (!sBegin) continue;
                  const sEnd = sAttrs.match(/\bend="([^"]+)"/i);
                  const wMs = Math.round(parseTimecode(sBegin[1]));
                  const wEndMs = sEnd ? Math.round(parseTimecode(sEnd[1])) : null;
                  const rawInner = decodeEntities(sMatch[2].replace(/<[^>]+>/g, ''));
                  const wText = rawInner.trim();
                  if (wText) {
                    rawSpans.push({
                      t: wMs,
                      end: wEndMs,
                      text: wText,
                      startIndex: sMatch.index,
                      endIndex: sMatch.index + sMatch[0].length,
                      innerLeadingSpace: /^\s/.test(rawInner),
                      innerTrailingSpace: /\s$/.test(rawInner)
                    });
                  }
                }

                if (rawSpans.length > 0) {
                  // Merge syllable spans into complete words when there is no space between </span> and <span...>
                  const mergedWords = [];
                  for (let i = 0; i < rawSpans.length; i++) {
                    const cur = rawSpans[i];
                    const prevSpan = i > 0 ? rawSpans[i - 1] : null;
                    const nextSpan = rawSpans[i + 1] || null;
                    const resolvedEnd = cur.end && cur.end > cur.t
                      ? cur.end
                      : (nextSpan ? nextSpan.t : (pEndMs || cur.t + 450));

                    let separatedFromPrev = true;
                    if (prevSpan) {
                      const between = rawPContent.slice(prevSpan.endIndex, cur.startIndex);
                      const hasBetweenSpace = /\s/.test(between);
                      separatedFromPrev = hasBetweenSpace || prevSpan.innerTrailingSpace || cur.innerLeadingSpace;
                    }

                    if (!separatedFromPrev && mergedWords.length > 0) {
                      const prevWord = mergedWords[mergedWords.length - 1];
                      prevWord.text += cur.text;
                      prevWord.end = Math.max(prevWord.end, resolvedEnd);
                      prevWord.syllables.push({ t: cur.t, end: resolvedEnd, text: cur.text });
                    } else {
                      mergedWords.push({
                        t: cur.t,
                        end: Math.max(cur.t + 60, resolvedEnd),
                        text: cur.text,
                        syllables: [{ t: cur.t, end: resolvedEnd, text: cur.text }]
                      });
                    }
                  }
                  lineObj.words = mergedWords;
                  // Reconstruct clean line text from merged words so spacing matches 100%
                  lineObj.text = mergedWords.map((w) => w.text).join(' ');
                }
                timed.push(lineObj);
              }
            }
            if (timed.length > 0) {
              const sorted = timed.sort((a, b) => a.t - b.t);
              if (sorted.some((l) => l.words && l.words.length > 0)) return sorted;
              if (!fallbackLineCandidate) fallbackLineCandidate = sorted;
            }
          }
          // 3. LRC / QRC format
          if (format === 'lrc' || format === 'qrc' || (typeof content === 'string' && /\[\d{1,2}:\d{2}/.test(content))) {
            const timed = parseLrc(content);
            if (timed.length > 0) {
              if (timed.some((l) => l.words && l.words.length > 0)) return timed;
              if (!fallbackLineCandidate) fallbackLineCandidate = timed;
            }
          }
        }
      } catch {}
    }
    return fallbackLineCandidate || [];
  }

  async resolveLyricsForTrack({ title, artist, album, durationMs, source, songKey }) {
    const q = cleanTrackQuery(title, artist, durationMs);
    q.album = String(album || '').trim().slice(0, 200);
    if (!q.title) return;

    const hasWordLevelSync = (lines) =>
      Array.isArray(lines) && lines.some((l) => Array.isArray(l.words) && l.words.length > 0);

    const hashKey = crypto
      .createHash('sha1')
      .update([q.title, q.artist, Math.round(q.duration || 0)].join('|').toLowerCase())
      .digest('hex')
      .slice(0, 24);
    const cacheFile = path.join(this.getLyricsCacheFolder(), hashKey + '.json');

    const saveResultToCache = (ans) => {
      const saved = { ...ans, at: Date.now() };
      this.lyricsMemory.set(hashKey, saved);
      try {
        fs.mkdirSync(this.getLyricsCacheFolder(), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(saved));
      } catch {}
      return saved;
    };

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

    // If cached result lacks word-level timestamps, check Liner's local cache to upgrade it!
    if (result && !hasWordLevelSync(result.lines)) {
      const linerUpgrade = this.loadStrictLinerCacheFallback(title, artist);
      if (linerUpgrade && hasWordLevelSync(linerUpgrade.lines)) {
        result = saveResultToCache(linerUpgrade);
      }
    }

    if (!result || (!result.lines?.length && source === 'Liner')) {
      if (this.lyricsAsking.has(hashKey)) {
        result = await this.lyricsAsking.get(hashKey);
      } else {
        const job = (async () => {
          // 1. Check strict Liner cache first for studio word-level TTML / RichSync
          const linerAns = this.loadStrictLinerCacheFallback(title, artist);
          if (linerAns && hasWordLevelSync(linerAns.lines)) {
            return saveResultToCache(linerAns);
          }

          // 2. Otherwise query LRCLIB, falling back to line-level Liner cache if needed
          let ans = { lines: [] };
          if (q.artist) {
            ans = await this.lookupLrclib(q).catch(() => ({ lines: [], failed: true }));
          }
          if ((!ans.lines?.length || (!hasWordLevelSync(ans.lines) && linerAns?.lines?.length)) && linerAns?.lines?.length) {
            ans = linerAns;
          }
          if (!ans.failed) {
            return saveResultToCache(ans);
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

      // If word-level sync isn't present yet (e.g., Liner is still streaming SSE to Cache_Data right after track start),
      // re-check Liner's cache at +1.8s and +4.5s to automatically upgrade to exact word-level sync!
      if (!hasWordLevelSync(this.currentLyrics)) {
        for (const delayMs of [1800, 4500]) {
          const timer = setTimeout(() => {
            if (this.currentSongKey !== songKey) return;
            if (hasWordLevelSync(this.currentLyrics)) return;
            const lateLiner = this.loadStrictLinerCacheFallback(title, artist);
            if (lateLiner && hasWordLevelSync(lateLiner.lines)) {
              const upgraded = saveResultToCache(lateLiner);
              this.currentLyrics = upgraded.lines;
              this.plainLyrics = this.currentLyrics.map((l) => l.text);
              this.emit('changed');
            }
          }, delayMs);
          if (timer.unref) timer.unref();
        }
      }
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

    const hasWords = Array.isArray(this.currentLyrics) && this.currentLyrics.some((l) => Array.isArray(l.words) && l.words.length > 0);
    const lyricStatus = this.instrumental
      ? 'instrumental'
      : hasWords
      ? 'word_synced'
      : this.currentLyrics && this.currentLyrics.length > 0
      ? 'synced'
      : this.plainLyrics && this.plainLyrics.length > 0
      ? 'plain'
      : 'none';

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
        rawApp: String(this.now.app || ''),
        image_url: imageUrl,
        lyrics: this.plainLyrics,
        timedLyrics: this.currentLyrics, // [{ t: ms, end?: ms, text, words?: [...] }]
        instrumental: this.instrumental,
        lyricStatus,
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
