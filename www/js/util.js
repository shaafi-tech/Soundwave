// ============================================================================
// SoundWave — Shared helpers (js/util.js)
// ============================================================================

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '0:00';
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function toast(message) {
  document.dispatchEvent(new CustomEvent('soundwave:toast', { detail: { message } }));
}

// ----------------------------------------------------------------------------
// Cover art
// ----------------------------------------------------------------------------

export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// A nice gradient cover generated from the song/album name, so songs without
// artwork never show a broken image. No files needed.
export function placeholderCover(seed = '') {
  const h = hashString(String(seed) || 'soundwave');
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + (h % 70)) % 360;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue1},62%,38%)'/>` +
    `<stop offset='1' stop-color='hsl(${hue2},58%,18%)'/></linearGradient></defs>` +
    `<rect width='200' height='200' fill='url(#g)'/>` +
    `<g fill='none' stroke='rgba(255,255,255,0.85)' stroke-width='9' stroke-linecap='round'>` +
    `<path d='M78 128V78l52-12v50'/></g>` +
    `<g fill='rgba(255,255,255,0.85)'><circle cx='66' cy='130' r='14'/><circle cx='118' cy='118' r='14'/></g>` +
    `</svg>`;
  // encodeURIComponent leaves ' untouched; escape it so the URI is safe inside onerror='...'
  return `data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}`;
}

const coverUrlCache = new Map();
const CUSTOM_COVERS_KEY = 'soundwave_custom_covers_v1';

export function saveCustomCover(trackId, dataUrl) {
  if (!trackId || !dataUrl) return;
  try {
    const map = JSON.parse(localStorage.getItem(CUSTOM_COVERS_KEY) || '{}');
    map[trackId] = dataUrl;
    localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(map));
  } catch { /* storage quota */ }
}

export function getCustomCover(trackId) {
  if (!trackId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(CUSTOM_COVERS_KEY) || '{}');
    return map[trackId] || null;
  } catch {
    return null;
  }
}

// Returns a usable <img src> for any track-like object (blob art, url or placeholder).
export function coverFor(track) {
  if (!track) return placeholderCover('soundwave');

  // A saved cover image wins when the device is offline (or there is no web cover).
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const webCover = track.coverUrl || track.cover;
  if (webCover && !(offline && track.coverBlob instanceof Blob)) return webCover;

  if (track.coverBlob instanceof Blob) {
    if (!coverUrlCache.has(track.id)) {
      coverUrlCache.set(track.id, URL.createObjectURL(track.coverBlob));
    }
    return coverUrlCache.get(track.id);
  }

  const custom = getCustomCover(track.id);
  if (custom) return custom;

  return placeholderCover(track.coverSeed || track.album || track.title || track.id);
}

export function forgetCover(trackId) {
  const url = coverUrlCache.get(trackId);
  if (url) URL.revokeObjectURL(url);
  coverUrlCache.delete(trackId);
  try {
    const map = JSON.parse(localStorage.getItem(CUSTOM_COVERS_KEY) || '{}');
    if (trackId in map) {
      delete map[trackId];
      localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(map));
    }
  } catch { /* ignore */ }
}

// Handy inline onerror for <img> tags rendered as HTML strings.
export function imgFallbackAttr(seed) {
  return `this.onerror=null;this.src='${placeholderCover(seed)}'`;
}
