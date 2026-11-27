// ============================================================================
// SoundWave — Global Search: library + Appwrite + free online sources (js/search.js)
// ============================================================================

import { renderTrackList, bindTrackRows, renderAlbumCards, bindAlbumCards } from './library.js?v=pro35';
import { getFavorites } from './storage.js?v=pro35';
import { refreshPlayingState } from './player.js?v=pro35';
import { escapeHtml, saveCustomCover } from './util.js?v=pro35';
import { fetchWithRetry, isOnline, TimeoutError } from './network.js?v=pro35';
import { EXTRA_SOURCES, keyPromptHtml, bindKeyPrompt } from './sources.js?v=pro35';

// ----------------------------------------------------------------------------
// Local search (IndexedDB + Appwrite + shipped songs)
// ----------------------------------------------------------------------------

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchesAll(haystack, words) {
  return words.every((w) => haystack.includes(w));
}

export function searchCatalog(query, tracks = [], albums = []) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { tracks: [], albums: [] };

  return {
    tracks: tracks.filter((t) => matchesAll(normalize(`${t.title} ${t.artist} ${t.album}`), words)),
    albums: albums.filter((a) => matchesAll(normalize(`${a.title} ${a.artist}`), words))
  };
}

export function runSearch(query, { tracks = [], albums = [], gridEl, countEl } = {}) {
  if (!gridEl) return { tracks: [], albums: [] };

  const results = searchCatalog(query, tracks, albums);
  const total = results.tracks.length + results.albums.length;

  if (countEl) countEl.textContent = `${total} in your library`;

  const favorites = new Set(getFavorites());
  let html = '<div class="search-results-body">';

  if (results.tracks.length) {
    html += `<div><h3 class="section-title search-subtitle">Your library</h3>${renderTrackList(results.tracks, favorites)}</div>`;
  }
  if (results.albums.length) {
    html += `<div><h3 class="section-title search-subtitle">Albums</h3>${renderAlbumCards(results.albums)}</div>`;
  }
  if (!total) {
    html += `
      <div class="search-empty">
        <p class="track-title">No matches in your library for "${escapeHtml(query)}"</p>
        <p class="track-artist">Results from free online music sources appear below.</p>
      </div>`;
  }
  html += '<div id="online-search-slot"></div></div>';

  gridEl.innerHTML = html;

  bindTrackRows(gridEl, tracks, { onChange: () => runSearch(query, { tracks, albums, gridEl, countEl }) });
  bindAlbumCards(gridEl, results.albums, tracks);
  refreshPlayingState();
  return results;
}

// ----------------------------------------------------------------------------
// Audius public API (no key needed; an optional key raises rate limits)
//   Key: localStorage 'soundwave_audius_api_key'  or  window.SOUNDWAVE_CONFIG.audiusApiKey
// ----------------------------------------------------------------------------

const AUDIUS_API = 'https://api.audius.co';
const APP_NAME = 'SoundWave';
const KEY_STORAGE = 'soundwave_audius_api_key';
const CACHE_TTL = 60 * 1000;
const searchCache = new Map();
let onlineController = null;
let extraController = null;
let fallbackHosts = null;

export function getAudiusApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || window.SOUNDWAVE_CONFIG?.audiusApiKey || '';
  } catch {
    return window.SOUNDWAVE_CONFIG?.audiusApiKey || '';
  }
}

export function setAudiusApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, String(key).trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage blocked */ }
}

function withAuth(url) {
  url.searchParams.set('app_name', APP_NAME);
  const key = getAudiusApiKey();
  if (key) url.searchParams.set('api_key', key);
  return url;
}

// Older Audius setups publish a list of discovery hosts at the root URL. Used only as a fallback.
async function discoverFallbackHosts(signal) {
  if (fallbackHosts) return fallbackHosts;
  try {
    const res = await fetchWithRetry(AUDIUS_API, { signal, timeout: 6000, retries: 0 });
    const json = await res.json();
    fallbackHosts = (Array.isArray(json?.data) ? json.data : []).filter((h) => /^https:\/\//i.test(h));
  } catch {
    fallbackHosts = [];
  }
  return fallbackHosts;
}

function mapTrack(t, host) {
  const stream = withAuth(new URL(`/v1/tracks/${encodeURIComponent(t.id)}/stream`, host));
  return {
    id: `audius-${t.id}`,
    title: t.title || 'Untitled',
    artist: t.user?.name || 'Audius Artist',
    album: 'Audius',
    duration: Number(t.duration) || 0,
    src: stream.href,
    coverUrl: t.artwork?.['480x480'] || t.artwork?.['1000x1000'] || t.artwork?.['150x150'] || null,
    coverSeed: t.title || t.id,
    isOnline: true,
    isImported: false
  };
}

async function querySearch(host, query, signal) {
  const url = withAuth(new URL('/v1/tracks/search', host));
  url.searchParams.set('query', query);
  url.searchParams.set('limit', '20');
  const res = await fetchWithRetry(url.href, { signal, timeout: 10000, retries: 2 });
  if (!res.ok) throw new Error(`Audius returned ${res.status}.`);
  const json = await res.json();
  return (json.data || []).filter((t) => t && t.id && t.is_streamable !== false).map((t) => mapTrack(t, host));
}

// Cancels any search still in flight, then searches. Throws AbortError if superseded.
export async function searchOnlineTracks(query, { force = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cached = searchCache.get(q.toLowerCase());
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.tracks;

  if (!isOnline()) throw new Error("You're offline. Online search needs a connection.");

  onlineController?.abort();
  const controller = new AbortController();
  onlineController = controller;

  try {
    let tracks;
    try {
      tracks = await querySearch(AUDIUS_API, q, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      const hosts = await discoverFallbackHosts(controller.signal);
      if (!hosts.length) throw err;
      tracks = await querySearch(hosts[Math.floor(Math.random() * hosts.length)], q, controller.signal);
    }
    const seen = new Set();
    tracks = tracks.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
    searchCache.set(q.toLowerCase(), { at: Date.now(), tracks });
    return tracks;
  } finally {
    if (onlineController === controller) onlineController = null;
  }
}

export function abortOnlineSearch() {
  onlineController?.abort();
  onlineController = null;
  extraController?.abort();
  extraController = null;
}

// Audius "Trending this week" (used by the Home screen).
export async function fetchAudiusTrending({ signal, limit = 15 } = {}) {
  const run = async (host) => {
    const url = withAuth(new URL('/v1/tracks/trending', host));
    url.searchParams.set('time', 'week');
    url.searchParams.set('limit', String(limit));
    const res = await fetchWithRetry(url.href, { signal, timeout: 10000, retries: 1 });
    if (!res.ok) throw new Error(`Audius returned ${res.status}.`);
    const json = await res.json();
    return (json.data || []).filter((t) => t && t.id && t.is_streamable !== false).map((t) => mapTrack(t, host));
  };
  try {
    return await run(AUDIUS_API);
  } catch (err) {
    if (signal?.aborted) throw err;
    const hosts = await discoverFallbackHosts(signal);
    if (!hosts.length) throw err;
    return run(hosts[Math.floor(Math.random() * hosts.length)]);
  }
}

// ----------------------------------------------------------------------------
// "Online tracks" section: one block per free source (Audius, Jamendo, Internet
// Archive). Each block has its own loading / empty / error (Try again) state, so
// one slow or broken source never hides the others.
// ----------------------------------------------------------------------------

function errorMessage(err, label = 'The service') {
  if (err instanceof TimeoutError || err?.name === 'TimeoutError') return `${label} took too long to respond.`;
  if (/failed to fetch|networkerror|load failed/i.test(String(err?.message))) return `Could not reach ${label}. Check your connection.`;
  return String(err?.message || 'Online search failed.');
}

const SPINNER = '<span class="spinner" aria-hidden="true"></span>';

function hydrateCovers(rootEl, tracks) {
  tracks.forEach(async (t) => {
    if (t.coverUrl) return;
    const art = await fetchCoverArtForTrack(t);
    if (!art) return;
    t.coverUrl = art;
    saveCustomCover(t.id, art);
    const eid = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(t.id) : String(t.id).replace(/"/g, '');
    rootEl.querySelectorAll(`.track-row[data-track-id="${eid}"] .track-thumb`).forEach((img) => { img.src = art; });
  });
}

// Fills one provider block. provider: { id, label, source?, run(): Promise<track[]> }
async function renderProviderBlock(blockEl, provider, query, { isCurrent, excludeIds, retry }) {
  const head = `<h3 class="section-title search-subtitle">${escapeHtml(provider.label)} <span class="source-chip">${escapeHtml(provider.blurb || 'Free')}</span></h3>`;
  const show = (inner, cls = '') => {
    if (isCurrent()) blockEl.innerHTML = `<section class="online-search-section ${cls}">${head}${inner}</section>`;
  };

  if (provider.source?.needsKey && !provider.source.hasKey()) {
    show(keyPromptHtml(provider.source), 'is-needs-key');
    bindKeyPrompt(blockEl, provider.source, retry);
    return;
  }

  show(`<p class="online-note">${SPINNER}Searching ${escapeHtml(provider.label)}…</p>`, 'is-loading');

  try {
    const found = await provider.run();
    if (!isCurrent()) return;
    const online = found.filter((t) => !excludeIds.has(t.id));

    if (!online.length) {
      show(`<p class="online-note">Nothing on ${escapeHtml(provider.label)} for "${escapeHtml(query)}".</p>`, 'is-empty');
      return;
    }

    show(renderTrackList(online, new Set(getFavorites())));
    bindTrackRows(blockEl, online);
    hydrateCovers(blockEl, online);
    refreshPlayingState();
  } catch (err) {
    if (err?.name === 'AbortError' || !isCurrent()) return; // superseded by a newer search
    console.warn(`${provider.label} search failed:`, err);
    if (err?.code === 'NO_KEY' || err?.code === 'BAD_KEY') {
      show(`<p class="online-note error">${escapeHtml(errorMessage(err, provider.label))}</p>${keyPromptHtml(provider.source)}`, 'is-needs-key');
      bindKeyPrompt(blockEl, provider.source, retry);
      return;
    }
    show(
      `<p class="online-note error">${escapeHtml(errorMessage(err, provider.label))}</p>
       <button type="button" class="btn btn-secondary online-retry-btn">Try again</button>`,
      'is-error'
    );
    blockEl.querySelector('.online-retry-btn')?.addEventListener('click', retry);
  }
}

// slotEl: element inside the search results. isCurrent(): false once a newer search started.
export async function renderOnlineSection(slotEl, query, { isCurrent = () => true, excludeIds = new Set(), force = false } = {}) {
  if (!slotEl) return;

  if (!isOnline()) {
    slotEl.innerHTML = `<section class="online-search-section is-offline-note"><h3 class="section-title search-subtitle">Online tracks</h3>
      <p class="online-note">You're offline — online search is paused. Songs you saved offline still appear above.</p></section>`;
    return;
  }

  extraController?.abort();
  const controller = new AbortController();
  extraController = controller;

  const providers = [
    { id: 'audius', label: 'Audius', blurb: 'Independent artists', run: () => searchOnlineTracks(query, { force }) },
    ...EXTRA_SOURCES.map((source) => ({
      id: source.id,
      label: source.label,
      blurb: source.blurb,
      source,
      run: () => source.search(query, { signal: controller.signal })
    }))
  ];

  slotEl.innerHTML = '<div class="online-sources"></div>';
  const wrap = slotEl.firstElementChild;

  await Promise.all(
    providers.map((provider) => {
      const blockEl = document.createElement('div');
      blockEl.className = 'online-source-block';
      blockEl.dataset.source = provider.id;
      wrap.appendChild(blockEl);
      const retry = () => { force = true; return renderProviderBlock(blockEl, provider, query, { isCurrent, excludeIds, retry }); };
      return renderProviderBlock(blockEl, provider, query, { isCurrent, excludeIds, retry });
    })
  );
}

// ----------------------------------------------------------------------------
// Cover art fetcher for songs without embedded/cloud cover (iTunes Search API)
// ----------------------------------------------------------------------------

const coverLookupCache = new Map();

export async function fetchCoverArtForTrack(track) {
  if (!track || !isOnline()) return null;
  if (track.coverBlob instanceof Blob || track.coverUrl || track.cover) return null;

  const title = String(track.title || '')
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const artist = String(track.artist || '')
    .replace(/^(unknown artist|soundwave cloud|audius artist)$/i, '')
    .trim();
  if (!title) return null;

  const cacheKey = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  if (coverLookupCache.has(cacheKey)) return coverLookupCache.get(cacheKey);

  const promise = (async () => {
    try {
      const term = [title, artist].filter(Boolean).join(' ');
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`;
      const res = await fetchWithRetry(url, { timeout: 6000, retries: 1 });
      if (!res.ok) return null;
      const data = await res.json();
      const items = Array.isArray(data?.results) ? data.results : [];
      if (!items.length) return null;

      const wantedTitle = title.toLowerCase();
      const wantedArtist = artist.toLowerCase();
      const best =
        items.find((it) => {
          const tMatch = String(it.trackName || '').toLowerCase().includes(wantedTitle) || wantedTitle.includes(String(it.trackName || '').toLowerCase());
          const aMatch = !wantedArtist || String(it.artistName || '').toLowerCase().includes(wantedArtist);
          return tMatch && aMatch && it.artworkUrl100;
        }) || items.find((it) => it.artworkUrl100);

      if (!best?.artworkUrl100) return null;
      // Upgrade 100x100 thumbnail to high-res 600x600 artwork
      const hiRes = String(best.artworkUrl100).replace(/100x100bb/i, '600x600bb');
      return hiRes;
    } catch {
      return null;
    }
  })();

  coverLookupCache.set(cacheKey, promise);
  return promise;
}
