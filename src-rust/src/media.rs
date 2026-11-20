//! Native Windows GSMTC Media Controller & Synced Lyrics Engine (TTML, RichSync, Enhanced LRC, LRCLIB, Liner cache)
//! Zero PowerShell processes — calls WinRT GlobalSystemMediaTransportControls natively in Rust.

use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::DataReader;

const LRCLIB_API: &str = "https://lrclib.net/api";
const NONE_DAYS_MS: u64 = 7 * 86_400_000;
const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
const YEAR_2000_100NS: i64 = 125_911_584_000_000_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha1_hex_24(input: &str) -> String {
    // Minimal pure-Rust SHA-1 (RFC 3174) for lyrics cache filename compatibility
    let mut msg = input.as_bytes().to_vec();
    let bit_len = (msg.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let hex = format!("{:08x}{:08x}{:08x}{:08x}{:08x}", h0, h1, h2, h3, h4);
    hex.chars().take(24).collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LyricSyllable {
    pub t: i64,
    pub end: i64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LyricWord {
    pub t: i64,
    pub end: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syllables: Option<Vec<LyricSyllable>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LyricLine {
    pub t: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<LyricWord>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct LyricsResult {
    #[serde(default)]
    lines: Vec<LyricLine>,
    #[serde(default)]
    plain: Option<Vec<String>>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    at: u64,
}

fn has_word_sync(lines: &[LyricLine]) -> bool {
    lines
        .iter()
        .any(|l| l.words.as_ref().map(|w| !w.is_empty()).unwrap_or(false))
}

fn parse_timecode_ms(s: &str) -> f64 {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if trimmed.contains(':') {
        let parts: Vec<&str> = trimmed.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let sec: f64 = parts[2].replace(':', ".").parse().unwrap_or(0.0);
            return (h * 3600.0 + m * 60.0 + sec) * 1000.0;
        }
        let m: f64 = parts.first().and_then(|x| x.parse().ok()).unwrap_or(0.0);
        let sec: f64 = parts
            .get(1)
            .and_then(|x| x.replace(':', ".").parse().ok())
            .unwrap_or(0.0);
        return (m * 60.0 + sec) * 1000.0;
    }
    trimmed
        .trim_end_matches('s')
        .parse::<f64>()
        .unwrap_or(0.0)
        * 1000.0
}

pub fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    static RE_OFFSET: OnceLock<Regex> = OnceLock::new();
    static RE_STAMP: OnceLock<Regex> = OnceLock::new();
    static RE_LEAD_STAMPS: OnceLock<Regex> = OnceLock::new();
    static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
    static RE_ANGLE: OnceLock<Regex> = OnceLock::new();
    static RE_WORD_TAG: OnceLock<Regex> = OnceLock::new();
    static RE_META_PREFIX: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();

    let re_offset =
        RE_OFFSET.get_or_init(|| Regex::new(r"(?i)^\s*\[offset:\s*([+-]?\d+)\s*\]").unwrap());
    let re_stamp = RE_STAMP
        .get_or_init(|| Regex::new(r"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]").unwrap());
    let re_lead = RE_LEAD_STAMPS.get_or_init(|| {
        Regex::new(r"^\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+").unwrap()
    });
    let re_bracket = RE_BRACKET.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
    let re_angle = RE_ANGLE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let re_word_tag = RE_WORD_TAG
        .get_or_init(|| Regex::new(r"<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>([^<]*)").unwrap());
    let re_meta =
        RE_META_PREFIX.get_or_init(|| Regex::new(r"(?i)^(length|re|ti|ar|al|by|offset):").unwrap());
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut lines: Vec<LyricLine> = Vec::new();
    let mut global_offset_ms: i64 = 0;

    let normalized = lrc.replace("\\n", "\n");
    for raw in normalized.lines() {
        if let Some(cap) = re_offset.captures(raw) {
            global_offset_ms = cap[1].parse::<i64>().unwrap_or(0);
            continue;
        }
        let stamps: Vec<(f64, f64)> = re_stamp
            .captures_iter(raw)
            .map(|c| {
                let m: f64 = c[1].parse().unwrap_or(0.0);
                let s: f64 = c[2].replace(':', ".").parse().unwrap_or(0.0);
                (m, s)
            })
            .collect();
        if stamps.is_empty() {
            continue;
        }

        let body_after = re_lead.replace(raw, "").trim().to_string();
        let no_brackets = re_bracket.replace_all(raw, "");
        let no_angles = re_angle.replace_all(&no_brackets, "");
        let text = re_ws.replace_all(&no_angles, " ").trim().to_string();
        if re_meta.is_match(&text) {
            continue;
        }

        struct RawTok {
            t: i64,
            text: String,
            has_lead: bool,
            has_trail: bool,
        }
        let mut raw_tokens: Vec<RawTok> = Vec::new();
        for wc in re_word_tag.captures_iter(&body_after) {
            let wm: f64 = wc[1].parse().unwrap_or(0.0);
            let ws: f64 = wc[2].replace(':', ".").parse().unwrap_or(0.0);
            let wt = (((wm * 60.0 + ws) * 1000.0).round() as i64 - global_offset_ms).max(0);
            let seg = &wc[3];
            let trimmed = seg.trim();
            if !trimmed.is_empty() {
                raw_tokens.push(RawTok {
                    t: wt,
                    text: trimmed.to_string(),
                    has_lead: seg.chars().next().map(|c| c.is_whitespace()).unwrap_or(false),
                    has_trail: seg.chars().last().map(|c| c.is_whitespace()).unwrap_or(false),
                });
            }
        }

        let inline_words = if !raw_tokens.is_empty() {
            let mut merged: Vec<(LyricWord, bool)> = Vec::new();
            for i in 0..raw_tokens.len() {
                let cur = &raw_tokens[i];
                let end_ms = raw_tokens
                    .get(i + 1)
                    .map(|n| n.t)
                    .unwrap_or(cur.t + 600);
                if let Some((prev, prev_trail)) = merged.last_mut() {
                    if !*prev_trail && !cur.has_lead {
                        prev.text.push_str(&cur.text);
                        prev.end = end_ms;
                        *prev_trail = cur.has_trail;
                        continue;
                    }
                }
                merged.push((
                    LyricWord {
                        t: cur.t,
                        end: end_ms,
                        text: cur.text.clone(),
                        syllables: None,
                    },
                    cur.has_trail,
                ));
            }
            Some(merged.into_iter().map(|(w, _)| w).collect::<Vec<_>>())
        } else {
            None
        };

        for (m, s) in stamps {
            let t = (((m * 60.0 + s) * 1000.0).round() as i64 - global_offset_ms).max(0);
            lines.push(LyricLine {
                t,
                end: None,
                text: text.clone(),
                words: inline_words.clone(),
            });
        }
    }

    lines.sort_by_key(|l| l.t);
    lines
}

struct TrackQuery {
    title: String,
    artist: String,
    album: String,
    duration_sec: i64,
}

fn clean_track_query(raw_title: &str, raw_artist: &str, duration_ms: i64) -> TrackQuery {
    static RE_TOPIC: OnceLock<Regex> = OnceLock::new();
    static RE_VEVO: OnceLock<Regex> = OnceLock::new();
    static RE_NOISE: OnceLock<Regex> = OnceLock::new();
    static RE_DASH: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();

    let re_topic = RE_TOPIC.get_or_init(|| Regex::new(r"(?i)\s*-\s*Topic$").unwrap());
    let re_vevo = RE_VEVO.get_or_init(|| Regex::new(r"(?i)VEVO$").unwrap());
    let re_noise = RE_NOISE.get_or_init(|| {
        Regex::new(r"(?i)\s*[(\[][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|remaster(?:ed)?)\b[^)\]]*[)\]]").unwrap()
    });
    let re_dash = RE_DASH.get_or_init(|| Regex::new(r"^(.+?)\s+[-–—]\s+(.+)$").unwrap());
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut artist = re_topic.replace(raw_artist.trim(), "").to_string();
    artist = re_vevo.replace(&artist, "").trim().to_string();
    let mut title = re_noise.replace_all(raw_title.trim(), "").trim().to_string();

    if let Some(cap) = re_dash.captures(&title.clone()) {
        let lhs = cap[1].trim();
        let rhs = cap[2].trim();
        if !artist.is_empty() && lhs.eq_ignore_ascii_case(&artist) {
            title = rhs.to_string();
        } else if artist.is_empty() || !title.to_lowercase().contains(&artist.to_lowercase()) {
            artist = lhs.to_string();
            title = rhs.to_string();
        }
    }

    TrackQuery {
        title: re_ws
            .replace_all(&title, " ")
            .trim()
            .chars()
            .take(200)
            .collect(),
        artist: re_ws
            .replace_all(&artist, " ")
            .trim()
            .chars()
            .take(200)
            .collect(),
        album: String::new(),
        duration_sec: ((duration_ms as f64) / 1000.0).round().clamp(0.0, 7200.0) as i64,
    }
}

pub fn app_name_from_id(id: &str) -> &'static str {
    let s = id.to_lowercase();
    if s.contains("liner") {
        "Liner"
    } else if s.contains("spotify") {
        "Spotify"
    } else if s.contains("chrome") {
        "Chrome"
    } else if s.contains("edge") || s.contains("msedge") {
        "Edge"
    } else if s.contains("firefox") {
        "Firefox"
    } else if s.contains("brave") {
        "Brave"
    } else if s.contains("opera") {
        "Opera"
    } else if s.contains("zune") || s.contains("music") || s.contains("wmplayer") || s.contains("vlc")
    {
        "Media Player"
    } else if !s.is_empty() {
        "Windows Media"
    } else {
        "none"
    }
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn parse_liner_cache_lyrics(cache_content: &str) -> Vec<LyricLine> {
    static RE_EVENT_SPLIT: OnceLock<Regex> = OnceLock::new();
    static RE_PROV_JSON: OnceLock<Regex> = OnceLock::new();
    static RE_HTML_TAG: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();
    static RE_P: OnceLock<Regex> = OnceLock::new();
    static RE_BEGIN: OnceLock<Regex> = OnceLock::new();
    static RE_END: OnceLock<Regex> = OnceLock::new();
    static RE_SPAN: OnceLock<Regex> = OnceLock::new();
    static RE_LRC_DETECT: OnceLock<Regex> = OnceLock::new();

    let re_event = RE_EVENT_SPLIT.get_or_init(|| Regex::new(r"\r?\nevent:\s*").unwrap());
    let re_prov = RE_PROV_JSON.get_or_init(|| Regex::new(r#"(\{"type":"provider"[^\n\r]+)"#).unwrap());
    let re_tag = RE_HTML_TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").unwrap());
    let re_p = RE_P.get_or_init(|| Regex::new(r"(?is)<p\b([^>]*)>(.*?)</p>").unwrap());
    let re_begin = RE_BEGIN.get_or_init(|| Regex::new(r#"(?i)\bbegin="([^"]+)""#).unwrap());
    let re_end = RE_END.get_or_init(|| Regex::new(r#"(?i)\bend="([^"]+)""#).unwrap());
    let re_span = RE_SPAN.get_or_init(|| Regex::new(r"(?is)<span\b([^>]*)>(.*?)</span>").unwrap());
    let re_lrc = RE_LRC_DETECT.get_or_init(|| Regex::new(r"\[\d{1,2}:\d{2}").unwrap());

    let mut providers: Vec<Value> = Vec::new();
    for chunk in re_event.split(cache_content) {
        let Some(idx) = chunk.find("data:") else {
            continue;
        };
        let json_str = chunk[idx + 5..].trim();
        if let Ok(v) = serde_json::from_str::<Value>(json_str) {
            if v.get("type").and_then(|t| t.as_str()) == Some("provider") {
                providers.push(v);
                continue;
            }
        }
        if let Some(cap) = re_prov.captures(json_str) {
            if let Ok(v) = serde_json::from_str::<Value>(&cap[1]) {
                if v.get("type").and_then(|t| t.as_str()) == Some("provider") {
                    providers.push(v);
                }
            }
        }
    }

    let mut fallback: Option<Vec<LyricLine>> = None;

    for p in providers {
        let Some(lyrics_obj) = p.get("candidate").and_then(|c| c.get("lyrics")) else {
            continue;
        };
        let Some(content_val) = lyrics_obj.get("content") else {
            continue;
        };
        let format = lyrics_obj
            .get("format")
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_lowercase();
        let content_str = content_val.as_str().unwrap_or("");

        // 1. RichSync JSON
        if format == "richsync"
            || (format != "lrc"
                && format != "qrc"
                && (content_val.is_array() || content_str.trim_start().starts_with("[{")))
        {
            let items_opt: Option<Vec<Value>> = if let Some(arr) = content_val.as_array() {
                Some(arr.clone())
            } else {
                serde_json::from_str::<Vec<Value>>(content_str).ok()
            };
            if let Some(items) = items_opt {
                let mut timed: Vec<LyricLine> = Vec::new();
                for (line_idx, it) in items.iter().enumerate() {
                    let raw_text = it
                        .get("x")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            it.get("l")
                                .and_then(|l| l.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|w| w.get("c").and_then(|c| c.as_str()))
                                        .collect::<String>()
                                })
                                .unwrap_or_default()
                        });
                    let clean_text = re_ws
                        .replace_all(&re_tag.replace_all(&raw_text, ""), " ")
                        .trim()
                        .to_string();
                    if clean_text.is_empty() {
                        continue;
                    }
                    let t_ms = it
                        .get("ts")
                        .and_then(|v| v.as_f64())
                        .map(|s| (s * 1000.0).round() as i64)
                        .unwrap_or(0);
                    let next_start = items
                        .get(line_idx + 1)
                        .and_then(|nx| nx.get("ts").and_then(|v| v.as_f64()))
                        .map(|s| (s * 1000.0).round() as i64);
                    let line_end = it
                        .get("te")
                        .and_then(|v| v.as_f64())
                        .map(|s| (s * 1000.0).round() as i64)
                        .or(next_start)
                        .unwrap_or(t_ms + 3000);

                    let mut words_out = None;
                    if let Some(l_arr) = it.get("l").and_then(|v| v.as_array()) {
                        struct Tok {
                            t: i64,
                            dur: Option<i64>,
                            text: String,
                            lead: bool,
                            trail: bool,
                        }
                        let toks: Vec<Tok> = l_arr
                            .iter()
                            .filter_map(|w| {
                                let raw_s = w.get("c").and_then(|v| v.as_str()).unwrap_or("");
                                let wt = raw_s.trim();
                                if wt.is_empty() {
                                    return None;
                                }
                                let o = w.get("o").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                let d = w
                                    .get("d")
                                    .and_then(|v| v.as_f64())
                                    .map(|x| (x * 1000.0).round() as i64);
                                Some(Tok {
                                    t: t_ms + (o * 1000.0).round() as i64,
                                    dur: d,
                                    text: wt.to_string(),
                                    lead: raw_s
                                        .chars()
                                        .next()
                                        .map(|c| c.is_whitespace())
                                        .unwrap_or(false),
                                    trail: raw_s
                                        .chars()
                                        .last()
                                        .map(|c| c.is_whitespace())
                                        .unwrap_or(false),
                                })
                            })
                            .collect();
                        let any_spaces = toks.iter().any(|w| w.lead || w.trail);
                        let mut merged: Vec<(LyricWord, bool)> = Vec::new();
                        for i in 0..toks.len() {
                            let cur = &toks[i];
                            let end_t = cur
                                .dur
                                .map(|d| cur.t + d)
                                .or_else(|| toks.get(i + 1).map(|n| n.t))
                                .unwrap_or(line_end);
                            if any_spaces {
                                if let Some((prev, prev_trail)) = merged.last_mut() {
                                    if !*prev_trail && !cur.lead {
                                        prev.text.push_str(&cur.text);
                                        prev.end = prev.end.max(end_t);
                                        *prev_trail = cur.trail;
                                        continue;
                                    }
                                }
                            }
                            merged.push((
                                LyricWord {
                                    t: cur.t,
                                    end: end_t.max(cur.t + 80),
                                    text: cur.text.clone(),
                                    syllables: None,
                                },
                                cur.trail,
                            ));
                        }
                        if !merged.is_empty() {
                            words_out = Some(merged.into_iter().map(|(w, _)| w).collect());
                        }
                    }

                    timed.push(LyricLine {
                        t: t_ms,
                        end: Some(line_end),
                        text: clean_text,
                        words: words_out,
                    });
                }
                if !timed.is_empty() {
                    timed.sort_by_key(|l| l.t);
                    if has_word_sync(&timed) {
                        return timed;
                    }
                    if fallback.is_none() {
                        fallback = Some(timed);
                    }
                }
            }
        }

        // 2. TTML format
        if format == "ttml" || content_str.contains("<p") {
            let mut timed: Vec<LyricLine> = Vec::new();
            for p_cap in re_p.captures_iter(content_str) {
                let p_attrs = &p_cap[1];
                let Some(b_cap) = re_begin.captures(p_attrs) else {
                    continue;
                };
                let t_ms = parse_timecode_ms(&b_cap[1]).round() as i64;
                let p_end_ms = re_end
                    .captures(p_attrs)
                    .map(|c| parse_timecode_ms(&c[1]).round() as i64);
                let raw_p = &p_cap[2];

                let cleaned = re_ws
                    .replace_all(&decode_xml_entities(&re_tag.replace_all(raw_p, "")), " ")
                    .trim()
                    .to_string();
                if cleaned.is_empty() || cleaned.to_lowercase().contains("source:") {
                    continue;
                }

                struct RawSpan {
                    t: i64,
                    end: Option<i64>,
                    text: String,
                    start_idx: usize,
                    end_idx: usize,
                    lead: bool,
                    trail: bool,
                }
                let mut spans: Vec<RawSpan> = Vec::new();
                for s_cap in re_span.captures_iter(raw_p) {
                    let s_attrs = &s_cap[1];
                    let Some(sb) = re_begin.captures(s_attrs) else {
                        continue;
                    };
                    let w_ms = parse_timecode_ms(&sb[1]).round() as i64;
                    let w_end = re_end
                        .captures(s_attrs)
                        .map(|c| parse_timecode_ms(&c[1]).round() as i64);
                    let raw_inner = decode_xml_entities(&re_tag.replace_all(&s_cap[2], ""));
                    let w_text = raw_inner.trim().to_string();
                    if !w_text.is_empty() {
                        let m0 = s_cap.get(0).unwrap();
                        spans.push(RawSpan {
                            t: w_ms,
                            end: w_end,
                            text: w_text,
                            start_idx: m0.start(),
                            end_idx: m0.end(),
                            lead: raw_inner
                                .chars()
                                .next()
                                .map(|c| c.is_whitespace())
                                .unwrap_or(false),
                            trail: raw_inner
                                .chars()
                                .last()
                                .map(|c| c.is_whitespace())
                                .unwrap_or(false),
                        });
                    }
                }

                let mut line_text = cleaned;
                let mut words_out = None;
                if !spans.is_empty() {
                    let mut merged: Vec<LyricWord> = Vec::new();
                    for i in 0..spans.len() {
                        let cur = &spans[i];
                        let resolved_end = cur
                            .end
                            .filter(|&e| e > cur.t)
                            .or_else(|| spans.get(i + 1).map(|n| n.t))
                            .or(p_end_ms)
                            .unwrap_or(cur.t + 450);

                        let separated = if i == 0 {
                            true
                        } else {
                            let prev = &spans[i - 1];
                            let between = &raw_p[prev.end_idx..cur.start_idx];
                            between.chars().any(|c| c.is_whitespace()) || prev.trail || cur.lead
                        };

                        if !separated {
                            if let Some(prev_w) = merged.last_mut() {
                                prev_w.text.push_str(&cur.text);
                                prev_w.end = prev_w.end.max(resolved_end);
                                if let Some(ref mut syls) = prev_w.syllables {
                                    syls.push(LyricSyllable {
                                        t: cur.t,
                                        end: resolved_end,
                                        text: cur.text.clone(),
                                    });
                                }
                                continue;
                            }
                        }
                        merged.push(LyricWord {
                            t: cur.t,
                            end: resolved_end.max(cur.t + 60),
                            text: cur.text.clone(),
                            syllables: Some(vec![LyricSyllable {
                                t: cur.t,
                                end: resolved_end,
                                text: cur.text.clone(),
                            }]),
                        });
                    }
                    line_text = merged
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    words_out = Some(merged);
                }

                timed.push(LyricLine {
                    t: t_ms,
                    end: p_end_ms.filter(|&e| e > t_ms),
                    text: line_text,
                    words: words_out,
                });
            }
            if !timed.is_empty() {
                timed.sort_by_key(|l| l.t);
                if has_word_sync(&timed) {
                    return timed;
                }
                if fallback.is_none() {
                    fallback = Some(timed);
                }
            }
        }

        // 3. LRC / QRC
        if format == "lrc" || format == "qrc" || re_lrc.is_match(content_str) {
            let timed = parse_lrc(content_str);
            if !timed.is_empty() {
                if has_word_sync(&timed) {
                    return timed;
                }
                if fallback.is_none() {
                    fallback = Some(timed);
                }
            }
        }
    }

    fallback.unwrap_or_default()
}

fn load_strict_liner_cache(liner_dir: &PathBuf, raw_title: &str, raw_artist: &str) -> Option<LyricsResult> {
    if !liner_dir.exists() {
        return None;
    }
    static RE_FEAT: OnceLock<Regex> = OnceLock::new();
    static RE_META: OnceLock<Regex> = OnceLock::new();
    let re_feat = RE_FEAT.get_or_init(|| Regex::new(r"(?i)\s*[(\[]feat\.?[^)\]]+[)\]]").unwrap());
    let re_meta = RE_META.get_or_init(|| Regex::new(r#"data:\s*(\{"type":"metadata"[^\n\r]+)"#).unwrap());

    let clean_title = re_feat.replace_all(raw_title, "").trim().to_lowercase();
    let clean_artist = raw_artist
        .split(|c| c == ',' || c == '&')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if clean_title.is_empty() || clean_artist.is_empty() {
        return None;
    }
    let raw_title_lower = raw_title.to_lowercase();

    let mut best_line: Option<Vec<LyricLine>> = None;

    let mut check_chunk = |data: &str| -> Option<Vec<LyricLine>> {
        if !data.contains(r#""type":"metadata""#) {
            return None;
        }
        for cap in re_meta.captures_iter(data) {
            let Ok(meta) = serde_json::from_str::<Value>(&cap[1]) else {
                continue;
            };
            let track = meta.get("track");
            let meta_title = track
                .and_then(|t| t.get("title").or_else(|| t.get("name")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let meta_artists = if let Some(arr) =
                track.and_then(|t| t.get("artists")).and_then(|a| a.as_array())
            {
                arr.iter()
                    .map(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .or_else(|| a.as_str())
                            .unwrap_or("")
                            .to_lowercase()
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                track
                    .and_then(|t| t.get("artist"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase()
            };

            let title_ok = !meta_title.is_empty()
                && (meta_title == raw_title_lower
                    || meta_title.contains(&clean_title)
                    || clean_title.contains(&meta_title));
            let artist_ok = meta_artists.contains(&clean_artist);
            if !title_ok || !artist_ok {
                continue;
            }

            let start_idx = cap.get(0).unwrap().start();
            let next_meta = data[start_idx.saturating_add(20).min(data.len())..]
                .find("event: metadata")
                .map(|rel| start_idx + 20 + rel);
            let end_idx = next_meta.unwrap_or_else(|| (start_idx + 120_000).min(data.len()));
            // Ensure UTF-8 char boundary
            let mut safe_end = end_idx;
            while safe_end < data.len() && !data.is_char_boundary(safe_end) {
                safe_end -= 1;
            }
            let slice = &data[start_idx..safe_end];
            let parsed = parse_liner_cache_lyrics(slice);
            if !parsed.is_empty() {
                if has_word_sync(&parsed) {
                    return Some(parsed);
                }
                if best_line.is_none() {
                    best_line = Some(parsed);
                }
            }
        }
        None
    };

    if let Ok(rd) = fs::read_dir(liner_dir) {
        let mut cands: Vec<(PathBuf, u64)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.starts_with("f_") {
                    return None;
                }
                let meta = e.metadata().ok()?;
                let len = meta.len();
                if !(250..=400_000).contains(&len) {
                    return None;
                }
                let mt = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some((e.path(), mt))
            })
            .collect();
        cands.sort_by(|a, b| b.1.cmp(&a.1));
        for (p, _) in cands.into_iter().take(450) {
            if let Ok(bytes) = fs::read(&p) {
                let data = String::from_utf8_lossy(&bytes);
                if let Some(hit) = check_chunk(&data) {
                    return Some(LyricsResult {
                        lines: hit,
                        plain: None,
                        instrumental: false,
                        at: now_ms(),
                    });
                }
            }
        }
    }

    for bf in ["data_2", "data_3", "data_1"] {
        let p = liner_dir.join(bf);
        if let Ok(bytes) = fs::read(&p) {
            let data = String::from_utf8_lossy(&bytes);
            if let Some(hit) = check_chunk(&data) {
                return Some(LyricsResult {
                    lines: hit,
                    plain: None,
                    instrumental: false,
                    at: now_ms(),
                });
            }
        }
    }

    best_line.map(|lines| LyricsResult {
        lines,
        plain: None,
        instrumental: false,
        at: now_ms(),
    })
}

fn fetch_json_url(url: &str, params: &[(&str, &str)]) -> Option<Value> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(7))
        .build();
    let mut req = agent
        .get(url)
        .set("User-Agent", "DynamicWindows/2.0.0 (https://github.com/voiceline-diskrep/dynamic-windows)");
    for &(k, v) in params {
        req = req.query(k, v);
    }
    match req.call() {
        Ok(resp) => resp.into_json::<Value>().ok(),
        Err(_) => None,
    }
}

fn lookup_lrclib(q: &TrackQuery) -> LyricsResult {
    let dur_str = q.duration_sec.to_string();
    let mut params: Vec<(&str, &str)> =
        vec![("track_name", &q.title), ("artist_name", &q.artist)];
    if !q.album.is_empty() && !q.album.eq_ignore_ascii_case("liner") {
        params.push(("album_name", &q.album));
    }
    if q.duration_sec > 0 {
        params.push(("duration", &dur_str));
    }

    let mut hit = fetch_json_url(&format!("{}/get", LRCLIB_API), &params);
    let has_synced_or_inst = |h: &Option<Value>| {
        h.as_ref()
            .map(|v| {
                v.get("syncedLyrics")
                    .and_then(|s| s.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                    || v.get("instrumental").and_then(|b| b.as_bool()).unwrap_or(false)
            })
            .unwrap_or(false)
    };

    if !has_synced_or_inst(&hit) {
        if let Some(Value::Array(list)) = fetch_json_url(
            &format!("{}/search", LRCLIB_API),
            &[("track_name", &q.title), ("artist_name", &q.artist)],
        ) {
            let synced: Vec<Value> = list
                .into_iter()
                .filter(|x| {
                    x.get("syncedLyrics")
                        .and_then(|s| s.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                })
                .collect();
            let best = synced
                .iter()
                .find(|x| {
                    q.duration_sec == 0
                        || (x.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0)
                            - q.duration_sec as f64)
                            .abs()
                            <= 3.0
                })
                .or_else(|| synced.first())
                .cloned();
            if best.is_some() {
                hit = best;
            }
        }
    }

    if !has_synced_or_inst(&hit) {
        static RE_FEAT_STRIP1: OnceLock<Regex> = OnceLock::new();
        static RE_FEAT_STRIP2: OnceLock<Regex> = OnceLock::new();
        let r1 = RE_FEAT_STRIP1.get_or_init(|| {
            Regex::new(r"(?i)\s*[(\[][^)\]]*\b(feat\.?|ft\.?|with)\b[^)\]]*[)\]]").unwrap()
        });
        let r2 = RE_FEAT_STRIP2
            .get_or_init(|| Regex::new(r"(?i)\s+\b(feat\.?|ft\.?)\s+.+$").unwrap());
        let stripped = r2.replace(&r1.replace_all(&q.title, ""), "").trim().to_string();
        if !stripped.is_empty() && stripped != q.title {
            if let Some(Value::Array(list)) = fetch_json_url(
                &format!("{}/search", LRCLIB_API),
                &[("track_name", &stripped), ("artist_name", &q.artist)],
            ) {
                let synced: Vec<Value> = list
                    .into_iter()
                    .filter(|x| {
                        x.get("syncedLyrics")
                            .and_then(|s| s.as_str())
                            .map(|s| !s.is_empty())
                            .unwrap_or(false)
                    })
                    .collect();
                let best = synced
                    .iter()
                    .find(|x| {
                        q.duration_sec == 0
                            || (x.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0)
                                - q.duration_sec as f64)
                                .abs()
                                <= 4.0
                    })
                    .or_else(|| synced.first())
                    .cloned();
                if best.is_some() {
                    hit = best;
                }
            }
        }
    }

    if let Some(h) = hit {
        if h.get("instrumental").and_then(|b| b.as_bool()).unwrap_or(false) {
            return LyricsResult {
                lines: Vec::new(),
                plain: None,
                instrumental: true,
                at: now_ms(),
            };
        }
        if let Some(sl) = h.get("syncedLyrics").and_then(|s| s.as_str()) {
            let lines = parse_lrc(sl);
            if lines.iter().any(|l| !l.text.is_empty()) {
                return LyricsResult {
                    lines,
                    plain: None,
                    instrumental: false,
                    at: now_ms(),
                };
            }
        }
        if let Some(pl) = h.get("plainLyrics").and_then(|s| s.as_str()) {
            let plain: Vec<String> = pl
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            return LyricsResult {
                lines: Vec::new(),
                plain: Some(plain),
                instrumental: false,
                at: now_ms(),
            };
        }
    }

    LyricsResult {
        lines: Vec::new(),
        plain: None,
        instrumental: false,
        at: now_ms(),
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, Default)]
struct TrackSnapshot {
    active: bool,
    app: String,
    playing: bool,
    rate: f64,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    position_ms: i64,
    key: String,
}

struct MediaInner {
    now: TrackSnapshot,
    at_ms: u64,
    cover_key: String,
    cover_url: String,
    keep_app_id: String,
    current_song_key: String,
    current_lyrics: Vec<LyricLine>,
    plain_lyrics: Vec<String>,
    instrumental: bool,
    user_playback_rate: Option<f64>,
    reported_rate: f64,
    auto_detected_rate: f64,
    lyric_offset_ms: i64,
    last_sample_pos: i64,
    last_sample_at: u64,
    last_sample_key: String,
    lyrics_memory: HashMap<String, LyricsResult>,
}

pub struct MediaController {
    inner: Arc<Mutex<MediaInner>>,
    lyrics_dir: PathBuf,
    liner_cache_dir: PathBuf,
}

impl MediaController {
    pub fn new() -> Self {
        let appdata = std::env::var("APPDATA")
            .or_else(|_| {
                std::env::var("USERPROFILE").map(|u| format!("{}\\AppData\\Roaming", u))
            })
            .unwrap_or_else(|_| "C:\\".to_string());
        let lyrics_dir = crate::config::data_dir().join("lyrics");
        let liner_cache_dir = PathBuf::from(&appdata)
            .join("@liner")
            .join("client")
            .join("Cache")
            .join("Cache_Data");
        Self {
            inner: Arc::new(Mutex::new(MediaInner {
                now: TrackSnapshot::default(),
                at_ms: 0,
                cover_key: String::new(),
                cover_url: String::new(),
                keep_app_id: String::new(),
                current_song_key: String::new(),
                current_lyrics: Vec::new(),
                plain_lyrics: Vec::new(),
                instrumental: false,
                user_playback_rate: None,
                reported_rate: 1.0,
                auto_detected_rate: 1.0,
                lyric_offset_ms: 0,
                last_sample_pos: 0,
                last_sample_at: 0,
                last_sample_key: String::new(),
                lyrics_memory: HashMap::new(),
            })),
            lyrics_dir,
            liner_cache_dir,
        }
    }

    pub fn active_app_hint(&self) -> String {
        self.inner
            .lock()
            .map(|g| g.now.app.clone())
            .unwrap_or_default()
    }

    fn pick_session(
        mgr: &GlobalSystemMediaTransportControlsSessionManager,
        keep_app_id: &mut String,
    ) -> Option<GlobalSystemMediaTransportControlsSession> {
        let mut all: Vec<GlobalSystemMediaTransportControlsSession> = Vec::new();
        if let Ok(sessions) = mgr.GetSessions() {
            let n = sessions.Size().unwrap_or(0);
            for i in 0..n {
                if let Ok(s) = sessions.GetAt(i) {
                    all.push(s);
                }
            }
        }
        let is_playing = |s: &GlobalSystemMediaTransportControlsSession| {
            s.GetPlaybackInfo()
                .and_then(|pi| pi.PlaybackStatus())
                .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false)
        };
        let app_id = |s: &GlobalSystemMediaTransportControlsSession| {
            s.SourceAppUserModelId()
                .map(|h| h.to_string_lossy())
                .unwrap_or_default()
        };

        let liner = all
            .iter()
            .find(|s| app_id(s).to_lowercase().contains("liner"))
            .cloned();
        let spotify = all
            .iter()
            .find(|s| app_id(s).to_lowercase().contains("spotify"))
            .cloned();
        let current = mgr.GetCurrentSession().ok();

        let live = if liner.as_ref().map(is_playing).unwrap_or(false) {
            liner.clone()
        } else if spotify.as_ref().map(is_playing).unwrap_or(false) {
            spotify.clone()
        } else if current.as_ref().map(is_playing).unwrap_or(false) {
            current.clone()
        } else {
            all.iter().find(|s| is_playing(s)).cloned()
        };

        if let Some(s) = live {
            *keep_app_id = app_id(&s);
            return Some(s);
        }
        if !keep_app_id.is_empty() {
            if let Some(old) = all.iter().find(|s| app_id(s) == *keep_app_id).cloned() {
                return Some(old);
            }
        }
        keep_app_id.clear();
        liner.or(spotify).or(current)
    }

    /// Polls native WinRT GSMTC. Returns `(changed_significant, maybe_spawn_lyrics_trigger)`.
    pub fn poll_gsmtc<F: Fn() + Send + Sync + 'static>(&self, on_lyrics_ready: Arc<F>) -> bool {
        let Ok(mgr_op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() else {
            return false;
        };
        let Ok(mgr) = mgr_op.get() else {
            return false;
        };

        let mut keep = self
            .inner
            .lock()
            .map(|g| g.keep_app_id.clone())
            .unwrap_or_default();
        let session_opt = Self::pick_session(&mgr, &mut keep);

        let Some(session) = session_opt else {
            let mut g = self.inner.lock().unwrap();
            g.keep_app_id = keep;
            let was_active = g.now.active;
            g.now = TrackSnapshot::default();
            return was_active;
        };

        let props = session
            .TryGetMediaPropertiesAsync()
            .ok()
            .and_then(|op| op.get().ok());
        let Some(p) = props else {
            return false;
        };

        let title = p.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
        let artist = p.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
        let album = p.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default();
        let app = session
            .SourceAppUserModelId()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();

        let (playing, rate) = match session.GetPlaybackInfo() {
            Ok(pi) => {
                let pl = pi
                    .PlaybackStatus()
                    .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                    .unwrap_or(false);
                let rt = pi
                    .PlaybackRate()
                    .and_then(|r| r.Value())
                    .unwrap_or(1.0);
                (pl, if rt > 0.0 { rt } else { 1.0 })
            }
            Err(_) => (false, 1.0),
        };

        let mut pos_ms = 0.0f64;
        let mut dur_ms = 0.0f64;
        if let Ok(tl) = session.GetTimelineProperties() {
            if let Ok(pos_ts) = tl.Position() {
                pos_ms = pos_ts.Duration as f64 / 10_000.0;
            }
            if let (Ok(start_ts), Ok(end_ts)) = (tl.StartTime(), tl.EndTime()) {
                dur_ms = (end_ts.Duration - start_ts.Duration) as f64 / 10_000.0;
            }
            if playing {
                if let Ok(lut) = tl.LastUpdatedTime() {
                    if lut.UniversalTime > YEAR_2000_100NS {
                        let lut_unix_ms = (lut.UniversalTime - EPOCH_DIFF_100NS) as f64 / 10_000.0;
                        let elapsed = (now_ms() as f64 - lut_unix_ms).max(0.0);
                        pos_ms += elapsed * rate;
                    }
                }
            }
        }
        let duration_i = dur_ms.max(0.0).round() as i64;
        let position_i = pos_ms
            .max(0.0)
            .min(if dur_ms > 0.0 { dur_ms } else { pos_ms })
            .round() as i64;
        let key = format!("{}|{}|{}", title, artist, album);

        let need_art = {
            let g = self.inner.lock().unwrap();
            g.cover_key != key
        };
        let mut new_cover_url: Option<String> = None;
        if need_art && !title.is_empty() {
            if let Ok(thumb) = p.Thumbnail() {
                if let Ok(op) = thumb.OpenReadAsync() {
                    if let Ok(ras) = op.get() {
                        let size = ras.Size().unwrap_or(0);
                        if size > 0 && size < 3 * 1024 * 1024 {
                            if let Ok(reader) = DataReader::CreateDataReader(&ras) {
                                if let Ok(load_op) = reader.LoadAsync(size as u32) {
                                    if let Ok(loaded) = load_op.get() {
                                        let mut buf = vec![0u8; loaded as usize];
                                        if reader.ReadBytes(&mut buf).is_ok() && !buf.is_empty() {
                                            let mime = if buf[0] == 0x89 {
                                                "image/png"
                                            } else if buf[0] == 0xFF {
                                                "image/jpeg"
                                            } else if buf[0] == 0x47 {
                                                "image/gif"
                                            } else {
                                                "image/png"
                                            };
                                            let b64 = base64::engine::general_purpose::STANDARD
                                                .encode(&buf);
                                            new_cover_url =
                                                Some(format!("data:{};base64,{}", mime, b64));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let now = now_ms();
        let song_key = if !title.is_empty() {
            format!("{}|{}", title, artist)
        } else {
            String::new()
        };

        let mut spawn_lyrics: Option<(String, String, String, i64, String, String)> = None;
        let changed: bool;
        {
            let mut g = self.inner.lock().unwrap();
            g.keep_app_id = keep;

            let prev_playing = g.now.playing;
            let prev_key = g.now.key.clone();
            let prev_pos = g.now.position_ms;
            let prev_at = g.at_ms;

            if need_art {
                g.cover_key = key.clone();
                g.cover_url = new_cover_url.clone().unwrap_or_default();
            }

            if rate > 0.0 {
                g.reported_rate = rate;
            }
            if g.last_sample_at > 0 && playing && key == g.last_sample_key {
                let dt = now.saturating_sub(g.last_sample_at) as f64;
                let d_pos = (position_i - g.last_sample_pos) as f64;
                if (800.0..=3500.0).contains(&dt) && d_pos >= 0.0 && d_pos <= dt * 2.5 {
                    let measured = d_pos / dt;
                    if (0.4..=2.0).contains(&measured) {
                        g.auto_detected_rate = g.auto_detected_rate * 0.7 + measured * 0.3;
                    }
                }
            }
            g.last_sample_pos = position_i;
            g.last_sample_at = now;
            g.last_sample_key = key.clone();

            g.now = TrackSnapshot {
                active: !title.is_empty(),
                app: app.clone(),
                playing,
                rate,
                title: title.clone(),
                artist: artist.clone(),
                album: album.clone(),
                duration_ms: duration_i,
                position_ms: position_i,
                key: key.clone(),
            };
            g.at_ms = now;

            if song_key != g.current_song_key {
                g.current_song_key = song_key.clone();
                g.current_lyrics.clear();
                g.plain_lyrics.clear();
                g.instrumental = false;
                if !song_key.is_empty() {
                    spawn_lyrics = Some((
                        title,
                        artist,
                        album,
                        duration_i,
                        app_name_from_id(&app).to_string(),
                        song_key,
                    ));
                }
            }

            let elapsed = now.saturating_sub(prev_at) as f64;
            let expected = prev_pos as f64 + if prev_playing { elapsed * rate } else { 0.0 };
            let jumped = g.now.active
                && (((position_i as f64) - expected).abs() > 220.0
                    || (playing && elapsed >= 2500.0));
            changed = prev_key != key || prev_playing != playing || new_cover_url.is_some() || jumped;
        }

        if let Some((t, a, alb, dur, src, sk)) = spawn_lyrics {
            self.spawn_lyrics_lookup(t, a, alb, dur, src, sk, on_lyrics_ready);
        }

        changed
    }

    fn spawn_lyrics_lookup<F: Fn() + Send + Sync + 'static>(
        &self,
        title: String,
        artist: String,
        album: String,
        duration_ms: i64,
        source: String,
        song_key: String,
        on_ready: Arc<F>,
    ) {
        let inner = self.inner.clone();
        let lyrics_dir = self.lyrics_dir.clone();
        let liner_dir = self.liner_cache_dir.clone();

        thread::spawn(move || {
            let mut q = clean_track_query(&title, &artist, duration_ms);
            q.album = album.trim().chars().take(200).collect();
            if q.title.is_empty() {
                return;
            }
            let hash_input = format!("{}|{}|{}", q.title, q.artist, q.duration_sec).to_lowercase();
            let hash_key = sha1_hex_24(&hash_input);
            let cache_file = lyrics_dir.join(format!("{}.json", hash_key));

            let save_cache = |res: &LyricsResult| {
                let _ = fs::create_dir_all(&lyrics_dir);
                if let Ok(raw) = serde_json::to_string(res) {
                    let _ = fs::write(&cache_file, raw);
                }
                if let Ok(mut g) = inner.lock() {
                    g.lyrics_memory.insert(hash_key.clone(), res.clone());
                }
            };

            let mut result = inner
                .lock()
                .ok()
                .and_then(|g| g.lyrics_memory.get(&hash_key).cloned());
            if result.is_none() {
                if let Ok(raw) = fs::read_to_string(&cache_file) {
                    if let Ok(saved) = serde_json::from_str::<LyricsResult>(&raw) {
                        if !saved.lines.is_empty()
                            || saved.instrumental
                            || now_ms().saturating_sub(saved.at) < NONE_DAYS_MS
                        {
                            if let Ok(mut g) = inner.lock() {
                                g.lyrics_memory.insert(hash_key.clone(), saved.clone());
                            }
                            result = Some(saved);
                        }
                    }
                }
            }

            if let Some(ref cur) = result {
                if !has_word_sync(&cur.lines) {
                    if let Some(up) = load_strict_liner_cache(&liner_dir, &title, &artist) {
                        if has_word_sync(&up.lines) {
                            save_cache(&up);
                            result = Some(up);
                        }
                    }
                }
            }

            let need_fetch = match &result {
                None => true,
                Some(r) => r.lines.is_empty() && source == "Liner",
            };
            if need_fetch {
                let liner_ans = load_strict_liner_cache(&liner_dir, &title, &artist);
                if let Some(ref la) = liner_ans {
                    if has_word_sync(&la.lines) {
                        save_cache(la);
                        result = Some(la.clone());
                    }
                }
                if result.is_none() || !has_word_sync(&result.as_ref().unwrap().lines) {
                    let mut ans = if !q.artist.is_empty() {
                        lookup_lrclib(&q)
                    } else {
                        LyricsResult::default()
                    };
                    if let Some(la) = liner_ans {
                        if (ans.lines.is_empty() || !has_word_sync(&ans.lines))
                            && !la.lines.is_empty()
                        {
                            ans = la;
                        }
                    }
                    save_cache(&ans);
                    result = Some(ans);
                }
            }

            let mut needs_late_upgrade = false;
            if let Some(res) = result {
                if let Ok(mut g) = inner.lock() {
                    if g.current_song_key == song_key {
                        let word_synced = has_word_sync(&res.lines);
                        g.plain_lyrics = res
                            .plain
                            .unwrap_or_else(|| res.lines.iter().map(|l| l.text.clone()).collect());
                        g.current_lyrics = res.lines;
                        g.instrumental = res.instrumental;
                        needs_late_upgrade = !word_synced;
                    } else {
                        return;
                    }
                }
                on_ready();
            }

            if needs_late_upgrade {
                for delay_ms in [1800u64, 2700u64] {
                    thread::sleep(Duration::from_millis(delay_ms));
                    let still_same = inner
                        .lock()
                        .map(|g| g.current_song_key == song_key && !has_word_sync(&g.current_lyrics))
                        .unwrap_or(false);
                    if !still_same {
                        return;
                    }
                    if let Some(late) = load_strict_liner_cache(&liner_dir, &title, &artist) {
                        if has_word_sync(&late.lines) {
                            save_cache(&late);
                            if let Ok(mut g) = inner.lock() {
                                if g.current_song_key == song_key {
                                    g.plain_lyrics =
                                        late.lines.iter().map(|l| l.text.clone()).collect();
                                    g.current_lyrics = late.lines;
                                }
                            }
                            on_ready();
                            return;
                        }
                    }
                }
            }
        });
    }

    fn run_session_command(&self, cmd: &str, seek_ms: Option<i64>) {
        let Ok(mgr_op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() else {
            return;
        };
        let Ok(mgr) = mgr_op.get() else { return };
        let mut keep = self
            .inner
            .lock()
            .map(|g| g.keep_app_id.clone())
            .unwrap_or_default();
        if let Some(session) = Self::pick_session(&mgr, &mut keep) {
            match cmd {
                "toggle" => {
                    let _ = session.TryTogglePlayPauseAsync().and_then(|o| o.get());
                }
                "next" => {
                    let _ = session.TrySkipNextAsync().and_then(|o| o.get());
                }
                "previous" => {
                    let _ = session.TrySkipPreviousAsync().and_then(|o| o.get());
                }
                "seek" => {
                    if let Some(ms) = seek_ms {
                        let _ = session
                            .TryChangePlaybackPositionAsync(ms * 10_000)
                            .and_then(|o| o.get());
                    }
                }
                _ => {}
            }
        }
    }

    pub fn play_pause(&self) {
        self.run_session_command("toggle", None);
    }

    pub fn next_track(&self) {
        self.run_session_command("next", None);
    }

    pub fn prev_track(&self) {
        self.run_session_command("previous", None);
    }

    pub fn seek(&self, ms: i64) {
        let target = ms.max(0);
        if let Ok(mut g) = self.inner.lock() {
            if g.now.active {
                g.now.position_ms = target;
                g.at_ms = now_ms();
            }
        }
        self.run_session_command("seek", Some(target));
    }

    pub fn set_playback_speed(&self, rate: Option<f64>) {
        if let Ok(mut g) = self.inner.lock() {
            g.user_playback_rate = rate.filter(|&r| r > 0.0);
        }
    }

    pub fn set_lyric_offset(&self, offset_ms: i64) {
        if let Ok(mut g) = self.inner.lock() {
            g.lyric_offset_ms = offset_ms;
        }
    }

    fn effective_rate(g: &MediaInner) -> f64 {
        if let Some(r) = g.user_playback_rate {
            if r > 0.0 {
                return r;
            }
        }
        if (g.reported_rate - 1.0).abs() > 0.05 {
            return g.reported_rate;
        }
        if (g.auto_detected_rate - 1.0).abs() > 0.05 {
            return (g.auto_detected_rate * 100.0).round() / 100.0;
        }
        1.0
    }

    fn progress_ms(g: &MediaInner) -> i64 {
        if !g.now.active {
            return 0;
        }
        let mut prog = g.now.position_ms as f64;
        if g.now.playing && g.at_ms > 0 {
            let dt = now_ms().saturating_sub(g.at_ms) as f64;
            prog += dt * Self::effective_rate(g);
        }
        if g.now.duration_ms > 0 {
            prog = prog.min(g.now.duration_ms as f64);
        }
        prog.max(0.0).round() as i64
    }

    fn current_lyric_at(lines: &[LyricLine], progress_ms: i64) -> String {
        if lines.is_empty() {
            return String::new();
        }
        let pos = progress_ms + 250;
        let mut idx: Option<usize> = None;
        for (k, l) in lines.iter().enumerate() {
            if l.t <= pos {
                idx = Some(k);
            } else {
                break;
            }
        }
        let Some(i) = idx else {
            return String::new();
        };
        let since = pos - lines[i].t;
        let is_gap = if let Some(next) = lines.get(i + 1) {
            next.t - lines[i].t > 14_000 && since > 9_000
        } else {
            since > 8_000
        };
        if is_gap {
            String::new()
        } else {
            lines[i].text.clone()
        }
    }

    pub fn get_state(&self) -> Value {
        let g = self.inner.lock().unwrap();
        if !g.now.active || g.now.title.is_empty() {
            return json!({
                "isPlaying": false,
                "progress_ms": 0,
                "duration_ms": 0,
                "track": {
                    "title": "No media playing",
                    "artist": "Open Liner, Spotify, or Media Player",
                    "source": "none",
                    "album": "",
                    "image_url": "",
                    "lyrics": [],
                    "timedLyrics": [],
                    "currentLyric": ""
                }
            });
        }
        let progress = Self::progress_ms(&g);
        let source = app_name_from_id(&g.now.app);
        let image_url = if g.cover_key == g.now.key {
            g.cover_url.clone()
        } else {
            String::new()
        };
        let current_lyric = Self::current_lyric_at(&g.current_lyrics, progress);
        let lyric_status = if g.instrumental {
            "instrumental"
        } else if has_word_sync(&g.current_lyrics) {
            "word_synced"
        } else if !g.current_lyrics.is_empty() {
            "synced"
        } else if !g.plain_lyrics.is_empty() {
            "plain"
        } else {
            "none"
        };
        let artist_display = if !g.now.artist.is_empty() {
            g.now.artist.clone()
        } else if !g.now.album.is_empty() {
            g.now.album.clone()
        } else {
            source.to_string()
        };

        json!({
            "isPlaying": g.now.playing,
            "progress_ms": progress,
            "duration_ms": g.now.duration_ms,
            "playback_rate": Self::effective_rate(&g),
            "user_speed": g.user_playback_rate,
            "lyric_offset_ms": g.lyric_offset_ms,
            "track": {
                "id": g.now.key,
                "title": g.now.title,
                "artist": artist_display,
                "album": g.now.album,
                "source": source,
                "rawApp": g.now.app,
                "image_url": image_url,
                "lyrics": g.plain_lyrics,
                "timedLyrics": g.current_lyrics,
                "instrumental": g.instrumental,
                "lyricStatus": lyric_status,
                "currentLyric": current_lyric
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_enhanced_lrc_and_offset() {
        let lrc = "[offset:100]\n[00:10.50]<00:10.50>Hello <00:11.00>world\n";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].t, 10400);
        assert_eq!(lines[0].text, "Hello world");
        let words = lines[0].words.as_ref().unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[1].text, "world");
    }

    #[test]
    fn cleans_track_query_properly() {
        let q = clean_track_query("Artist - Song Name (Official Video)", "Artist - Topic", 215_000);
        assert_eq!(q.title, "Song Name");
        assert_eq!(q.artist, "Artist");
        assert_eq!(q.duration_sec, 215);
    }
}
