// ============================================================================
// SoundWave — Extra FREE & LEGAL music sources (js/sources.js)
// ----------------------------------------------------------------------------
//  • Jamendo          Creative Commons music (needs a free client id, see below)
//  • Internet Archive Netlabel / open-audio collections (no key)
// Audius (search + trending) lives in search.js.
//
// Every source returns tracks in the same shape the player already understands:
//   { id, title, artist, album, duration, src, coverUrl, coverSeed, isOnline, source }
// Adding a source = add one object to EXTRA_SOURCES at the bottom.
// ============================================================================

import { fetchWithRetry } from './network.js?v=pro35';

const CACHE_TTL = 60 * 1000;

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function makeCache() {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < CACHE_TTL ? hit.value : null;
    },
    set(key, value) {
      map.set(key, { at: Date.now(), value });
      return value;
    }
  };
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => (t && t.id && t.src && !seen.has(t.id) ? seen.add(t.id) : false));
}

// "263.4" or "4:23" or "1:02:03" -> seconds
function parseLength(value) {
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  if (text.includes(':')) {
    return text.split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
  }
  return Math.round(Number(text)) || 0;
}

async function getJson(url, { signal, timeout = 10000, retries = 1 } = {}) {
  const res = await fetchWithRetry(url, { signal, timeout, retries });
  if (!res.ok) throw new Error(`The music service returned ${res.status}.`);
  return res.json();
}

// ----------------------------------------------------------------------------
// Jamendo  (https://developer.jamendo.com — free client id, 30 seconds to get)
//   Key: localStorage 'soundwave_jamendo_client_id'
//        or window.SOUNDWAVE_CONFIG.jamendoClientId (index.html)
// ----------------------------------------------------------------------------

const JAMENDO_API = 'https://api.jamendo.com/v3.0';
const JAMENDO_KEY_STORAGE = 'soundwave_jamendo_client_id';
const jamendoCache = makeCache();

export function getJamendoClientId() {
  try {
    return (localStorage.getItem(JAMENDO_KEY_STORAGE) || window.SOUNDWAVE_CONFIG?.jamendoClientId || '').trim();
  } catch {
    return String(window.SOUNDWAVE_CONFIG?.jamendoClientId || '').trim();
  }
}

export function setJamendoClientId(key) {
  try {
    const clean = String(key || '').trim();
    if (clean) localStorage.setItem(JAMENDO_KEY_STORAGE, clean);
    else localStorage.removeItem(JAMENDO_KEY_STORAGE);
  } catch { /* storage blocked */ }
}

function mapJamendo(t) {
  if (!t || !t.id || !t.audio) return null; // no stream link = not playable
  return {
    id: `jamendo-${t.id}`,
    title: t.name || 'Untitled',
    artist: t.artist_name || 'Jamendo Artist',
    album: t.album_name || 'Jamendo',
    duration: Number(t.duration) || 0,
    src: t.audio,
    coverUrl: t.image || t.album_image || null,
    coverSeed: t.name || String(t.id),
    license: t.license_ccurl || '',
    isOnline: true,
    isImported: false,
    source: 'jamendo'
  };
}

async function jamendoTracks(params, signal) {
  const clientId = getJamendoClientId();
  if (!clientId) {
    const err = new Error('Add a free Jamendo client id to turn this source on.');
    err.code = 'NO_KEY';
    throw err;
  }
  const url = new URL(`${JAMENDO_API}/tracks/`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('format', 'json');
  url.searchParams.set('audioformat', 'mp32');
  url.searchParams.set('imagesize', '300');
  url.searchParams.set('limit', '20');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const cached = jamendoCache.get(url.href);
  if (cached) return cached;

  const json = await getJson(url.href, { signal });
  if (json?.headers?.status && json.headers.status !== 'success') {
    const err = new Error(json.headers.error_message || 'Jamendo rejected the request. Check your client id.');
    err.code = 'BAD_KEY';
    throw err;
  }
  return jamendoCache.set(url.href, dedupe((json?.results || []).map(mapJamendo)));
}

const jamendo = {
  id: 'jamendo',
  label: 'Jamendo',
  blurb: 'Creative Commons music',
  needsKey: true,
  hasKey: () => !!getJamendoClientId(),
  search: (query, { signal } = {}) => jamendoTracks({ search: query, order: 'relevance' }, signal),
  trending: ({ signal } = {}) => jamendoTracks({ order: 'popularity_week', limit: 15 }, signal),
  trendingTitle: 'Popular on Jamendo'
};

// ----------------------------------------------------------------------------
// Internet Archive  (no key)
//   advancedsearch finds items; /metadata/<id> lists the playable files.
//   Limited to the "netlabels" and "opensource_audio" collections.
// ----------------------------------------------------------------------------

const ARCHIVE = 'https://archive.org';
const ARCHIVE_COLLECTIONS = 'collection:(netlabels OR opensource_audio)';
const archiveCache = makeCache();
const MAX_TRACKS_PER_ITEM = 3;

const encodePath = (name) => String(name).split('/').map(encodeURIComponent).join('/');

function cleanTerms(query) {
  return String(query || '')
    .replace(/["():[\]{}^~*?\\/!&|+-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

function isPlayableAudio(file) {
  const name = String(file?.name || '');
  if (/_spectrogram|\.(sha1|md5|torrent)$/i.test(name)) return false;
  return /\.(mp3|ogg|oga|m4a)$/i.test(name) && !/^(sample|preview)/i.test(name);
}

async function archiveItemTracks(doc, signal) {
  try {
    const meta = await getJson(`${ARCHIVE}/metadata/${encodeURIComponent(doc.identifier)}`, { signal, retries: 0 });
    const files = (meta?.files || []).filter(isPlayableAudio);
    // Prefer MP3 over other formats, original uploads before derivatives.
    const mp3 = files.filter((f) => /\.mp3$/i.test(f.name));
    const chosen = (mp3.length ? mp3 : files).slice(0, MAX_TRACKS_PER_ITEM);
    const itemTitle = meta?.metadata?.title || doc.title || doc.identifier;
    const itemArtist = meta?.metadata?.creator || doc.creator || 'Internet Archive';
    const artist = Array.isArray(itemArtist) ? itemArtist.join(', ') : itemArtist;
    const title = Array.isArray(itemTitle) ? itemTitle[0] : itemTitle;

    return chosen.map((f, i) => ({
      id: `ia-${doc.identifier}-${i}`,
      title: f.title || (chosen.length > 1 ? `${title} — ${String(f.name).replace(/\.[^.]+$/, '')}` : title),
      artist: f.creator || artist,
      album: title,
      duration: parseLength(f.length),
      src: `${ARCHIVE}/download/${encodeURIComponent(doc.identifier)}/${encodePath(f.name)}`,
      coverUrl: `${ARCHIVE}/services/img/${encodeURIComponent(doc.identifier)}`,
      coverSeed: title,
      isOnline: true,
      isImported: false,
      source: 'archive'
    }));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return []; // one broken item must not break the whole list
  }
}

async function archiveSearch({ terms, sort, rows = 10 }, signal) {
  const text = terms.length ? `(${terms.join(' AND ')}) AND ` : '';
  const q = `${text}mediatype:audio AND ${ARCHIVE_COLLECTIONS}`;
  const url = new URL(`${ARCHIVE}/advancedsearch.php`);
  url.searchParams.set('q', q);
  url.searchParams.append('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.append('fl[]', 'creator');
  url.searchParams.set('sort[]', sort);
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('page', '1');
  url.searchParams.set('output', 'json');

  const cached = archiveCache.get(url.href);
  if (cached) return cached;

  const json = await getJson(url.href, { signal });
  const docs = json?.response?.docs || [];
  const groups = await Promise.all(docs.map((d) => archiveItemTracks(d, signal)));
  return archiveCache.set(url.href, dedupe(groups.flat()).slice(0, 24));
}

const archive = {
  id: 'archive',
  label: 'Internet Archive',
  blurb: 'Netlabels & open audio',
  needsKey: false,
  hasKey: () => true,
  search: (query, { signal } = {}) => {
    const terms = cleanTerms(query);
    if (!terms.length) return Promise.resolve([]);
    return archiveSearch({ terms, sort: 'downloads desc' }, signal);
  },
  trending: ({ signal } = {}) => archiveSearch({ terms: [], sort: 'downloads desc', rows: 8 }, signal),
  trendingTitle: 'Most downloaded on the Internet Archive'
};

// ----------------------------------------------------------------------------
// Registry + a tiny UI helper for sources that need a key
// ----------------------------------------------------------------------------

export const EXTRA_SOURCES = [jamendo, archive];

export function keyPromptHtml(source) {
  return `
    <form class="key-prompt" data-key-for="${source.id}">
      <p class="online-note">${source.label} is free but needs a client id (takes a minute at developer.jamendo.com). Paste it once and it stays on this device.</p>
      <div class="key-prompt-row">
        <input type="text" class="text-input" name="key" placeholder="Jamendo client id" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button type="submit" class="btn btn-secondary">Save</button>
      </div>
    </form>`;
}

export function bindKeyPrompt(rootEl, source, onSaved) {
  rootEl.querySelector(`form[data-key-for="${source.id}"]`)?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('key') || '').trim();
    if (!value) return;
    if (source.id === 'jamendo') setJamendoClientId(value);
    onSaved?.();
  });
}
