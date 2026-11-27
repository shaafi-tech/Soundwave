// ============================================================================
// SoundWave — Native Android MediaStore Scanner & Local Folder Bridge
// (js/mediastore.js)
// ============================================================================

import { isNativeApp } from './native.js?v=pro35';

const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
const MEDIASTORE_CACHE_KEY = 'soundwave_mediastore_cache_v1';

let nativePlugin = null;
if (isNativeApp) {
  try {
    nativePlugin =
      cap.Plugins?.SoundWaveMediaStore ||
      (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('SoundWaveMediaStore') : null);
  } catch (err) {
    console.warn('SoundWaveMediaStore plugin unavailable:', err);
  }
}

export const hasNativeMediaStore = Boolean(nativePlugin);

function convertFileSrc(uri) {
  if (!uri) return '';
  if (/^(https?:|blob:|data:)/i.test(uri)) return uri;
  if (cap && typeof cap.convertFileSrc === 'function') {
    try { return cap.convertFileSrc(uri); } catch { /* fallback */ }
  }
  return uri;
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

function readCachedScan() {
  try {
    const raw = JSON.parse(localStorage.getItem(MEDIASTORE_CACHE_KEY) || 'null');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeCachedScan(tracks) {
  try {
    localStorage.setItem(MEDIASTORE_CACHE_KEY, JSON.stringify(tracks.slice(0, 1500)));
  } catch { /* storage quota */ }
}

function normalizeNativeTrack(raw) {
  if (!raw || (!raw.uri && !raw.path)) return null;
  const rawUri = raw.uri || (raw.path.startsWith('file://') ? raw.path : `file://${raw.path}`);
  const playableSrc = convertFileSrc(rawUri);
  const folderPath = String(raw.folderPath || raw.bucketDisplayName || 'Device Music').trim();
  const folderName = String(raw.folderName || folderPath.split('/').filter(Boolean).pop() || 'Music').trim();
  const artSrc = raw.albumArtUri ? convertFileSrc(raw.albumArtUri) : null;

  return {
    id: `ms-${raw.id || Math.abs(hashCode(rawUri))}`,
    mediaStoreId: String(raw.id || ''),
    title: String(raw.title || 'Untitled Track').trim(),
    artist: String(raw.artist || 'Unknown Artist').trim(),
    album: String(raw.album || folderName || 'Device Music').trim(),
    genre: String(raw.genre || 'Unknown Genre').trim(),
    folderPath,
    folderName,
    duration: Math.round((Number(raw.duration) || 0) / 1000) || Number(raw.durationSec) || 0,
    src: playableSrc,
    nativeUri: rawUri,
    coverUrl: artSrc,
    coverSeed: raw.album || raw.title || folderName,
    addedAt: Number(raw.dateAdded) ? Number(raw.dateAdded) * 1000 : Date.now(),
    isNativeMediaStore: true,
    isImported: false
  };
}

export function getCachedMediaStoreTracks() {
  return readCachedScan();
}

export async function scanDeviceMediaStore({ force = false } = {}) {
  if (!nativePlugin) {
    return { tracks: readCachedScan(), native: false, granted: true };
  }

  try {
    if (typeof nativePlugin.requestPermissions === 'function') {
      const perm = await nativePlugin.requestPermissions();
      const status = perm?.audio || perm?.storage || perm?.state || 'granted';
      if (status === 'denied') {
        return { tracks: readCachedScan(), native: true, granted: false };
      }
    }

    const res = await nativePlugin.scanAudio({ force: Boolean(force) });
    const rawList = Array.isArray(res?.tracks) ? res.tracks : [];
    const normalized = rawList.map(normalizeNativeTrack).filter(Boolean);
    normalized.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    writeCachedScan(normalized);
    return { tracks: normalized, native: true, granted: true };
  } catch (err) {
    console.warn('Native MediaStore scan failed:', err);
    return { tracks: readCachedScan(), native: true, granted: true, error: err?.message || 'Scan failed' };
  }
}
