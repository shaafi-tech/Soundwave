// ============================================================================
// SoundWave — Lyrics via the free LRCLIB API (js/lyrics.js)
//   https://lrclib.net/api/get?artist_name=...&track_name=...   (no API key)
//
// getLyrics(track) resolves to:
//   { status: 'synced',       lines: [{ time, text }], plain }
//   { status: 'plain',        lines: [],               plain }
//   { status: 'instrumental', lines: [],               plain: '' }
//   { status: 'none',         lines: [],               plain: '' }
//   { status: 'error',        ... }   (network problem — not cached, retried next time)
// ============================================================================

const API = 'https://lrclib.net/api';
const TIMEOUT_MS = 9000;
const cache = new Map(); // key -> Promise<result>

// ----------------------------------------------------------------------------
// .lrc parser  —  "[01:23.45] some words"  ->  { time: 83.45, text: 'some words' }
// ----------------------------------------------------------------------------

export function parseLrc(text = '') {
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const out = [];

  String(text)
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const times = [];
      let match;
      stamp.lastIndex = 0;
      while ((match = stamp.exec(rawLine)) !== null) {
        const mins = Number(match[1]);
        const secs = Number(match[2]);
        const frac = match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0;
        times.push(mins * 60 + secs + frac);
      }
      if (!times.length) return; // metadata tags like [ar:Artist] or blank lines
      const words = rawLine.replace(stamp, '').trim();
      times.forEach((time) => out.push({ time, text: words }));
    });

  out.sort((a, b) => a.time - b.time);
  return out;
}

// ----------------------------------------------------------------------------
// Query cleaning
// ----------------------------------------------------------------------------

function cleanTitle(title = '') {
  return String(title)
    .replace(/\s*[([][^)\]]*(official|video|audio|lyrics?|lyrical|visuali[sz]er|remaster(ed)?|hd|4k)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[-–|]\s*(official.*|lyrics?.*|audio.*|video.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(artist = '') {
  return String(artist)
    .split(/\s*(?:,|&|;| feat\.? | ft\.? | featuring | x | and )\s*/i)[0]
    .trim();
}

function isUnknownArtist(artist = '') {
  const a = String(artist).trim().toLowerCase();
  return !a || a === 'unknown artist' || a === 'unknown';
}

// ----------------------------------------------------------------------------
// Network
// ----------------------------------------------------------------------------

async function request(path, params) {
  const url = `${API}/${path}?${new URLSearchParams(params).toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return null; // "no lyrics for that song" is a normal answer
    if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTitle(s = '') {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Picks the best hit from /api/search: prefer synced lyrics, matching title, close duration.
function pickBest(results, wantedTitle, wantedDuration) {
  if (!Array.isArray(results) || !results.length) return null;
  const wanted = normalizeTitle(wantedTitle);

  const score = (r) => {
    let s = 0;
    if (r.syncedLyrics) s += 100;
    else if (r.plainLyrics) s += 40;
    else if (r.instrumental) s += 10;
    if (normalizeTitle(r.trackName) === wanted) s += 50;
    if (wantedDuration > 0 && r.duration > 0) {
      const diff = Math.abs(r.duration - wantedDuration);
      s += diff <= 3 ? 30 : diff <= 8 ? 10 : -20;
    }
    return s;
  };

  return [...results].sort((a, b) => score(b) - score(a))[0];
}

function toResult(record, fallbackPlain = '') {
  if (!record) return null;
  if (record.syncedLyrics && String(record.syncedLyrics).trim()) {
    const lines = parseLrc(record.syncedLyrics);
    if (lines.length) {
      return { status: 'synced', lines, plain: String(record.plainLyrics || '') };
    }
  }
  if (record.plainLyrics && String(record.plainLyrics).trim()) {
    return { status: 'plain', lines: [], plain: String(record.plainLyrics) };
  }
  if (record.instrumental) return { status: 'instrumental', lines: [], plain: '' };
  return fallbackPlain ? { status: 'plain', lines: [], plain: fallbackPlain } : null;
}

// Builds every sensible (artist, title) guess for a track. Uploaded files often have messy tags,
// e.g. title "My Ordinary Life-The Living Tombstone" with artist "Mehmet".
function candidatesFor(track) {
  const rawTitle = String(track.title || '').replace(/_+/g, ' ').trim();
  const rawArtist = String(track.artist || '').trim();
  const known = !isUnknownArtist(rawArtist) && !/^soundwave cloud$/i.test(rawArtist);
  const out = [];
  const seen = new Set();
  const add = (artist, title) => {
    const t = cleanTitle(title);
    const a = String(artist || '').trim();
    if (!t) return;
    const key = `${a.toLowerCase()}|${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ artist: a, title: t });
  };

  // "Title - Artist" / "Artist - Title" / "Title-Artist" inside the title itself
  const m = rawTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  const parts = m ? [m[1].trim(), m[2].trim()] : null;

  if (known) add(rawArtist, rawTitle);
  if (parts) {
    add(parts[1], parts[0]); // Title-Artist
    add(parts[0], parts[1]); // Artist-Title
    if (known) {
      add(rawArtist, parts[0]);
      add(rawArtist, parts[1]);
    }
  }
  if (known) add(primaryArtist(rawArtist), rawTitle);
  add('', rawTitle); // title only
  if (parts) {
    add('', parts[0]);
    add('', parts[1]);
  }
  return out;
}

async function lookupCandidate({ artist, title }, duration) {
  const params = artist ? { track_name: title, artist_name: artist } : { track_name: title };

  // exact lookup (needs an artist)
  if (artist) {
    const exact = toResult(await request('get', params));
    if (exact) return exact;
  }
  // fuzzy search by name (+ artist)
  let hit = pickBest(await request('search', params), title, duration);
  if (!hit) hit = pickBest(await request('search', { q: `${artist} ${title}`.trim() }), title, duration);
  return toResult(hit);
}

async function lookup(track, manualQuery = '') {
  const duration = Number(track.duration) || 0;

  // A search typed by the person: free text, best match wins.
  if (manualQuery) {
    const hit = pickBest(await request('search', { q: manualQuery }), manualQuery, duration);
    return toResult(hit);
  }

  const candidates = candidatesFor(track).slice(0, 6);
  for (const c of candidates) {
    const found = await lookupCandidate(c, duration);
    if (found) return found;
  }

  // Last resort: everything we know as one free-text query.
  const everything = `${track.title || ''} ${track.artist || ''}`.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (everything) {
    const hit = pickBest(await request('search', { q: everything }), cleanTitle(track.title), duration);
    const found = toResult(hit);
    if (found) return found;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export function lyricsKey(track) {
  return track ? `${track.id}` : '';
}

export function getLyrics(track, { query = '' } = {}) {
  if (!track) return Promise.resolve({ status: 'none', lines: [], plain: '' });

  const key = lyricsKey(track);
  if (!query && cache.has(key)) return cache.get(key);

  // Lyrics bundled in music/tracks.json (array of lines) are used when LRCLIB has nothing.
  const bundled = Array.isArray(track.lyrics) ? track.lyrics.join('\n').trim() : '';

  const promise = lookup(track, String(query || '').trim())
    .then((result) => {
      if (result) return result;
      if (bundled) return { status: 'plain', lines: [], plain: bundled };
      return { status: 'none', lines: [], plain: '' };
    })
    .catch((err) => {
      console.warn('Lyrics lookup failed:', err);
      cache.delete(key); // allow a retry next time
      if (bundled) return { status: 'plain', lines: [], plain: bundled };
      return { status: 'error', lines: [], plain: '' };
    });

  cache.set(key, promise);
  return promise;
}
