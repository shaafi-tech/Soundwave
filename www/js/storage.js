// ============================================================================
// SoundWave — Favorites (localStorage) & Song Library (IndexedDB) (js/storage.js)
//
// IndexedDB layout (v2):
//   imported_tracks : small metadata records (title, artist, album, cover art...)
//   audio_blobs     : { id, blob } — the actual audio, kept separate so listing
//                     hundreds of songs never loads audio data into memory.
// ============================================================================

const FAVORITES_KEY = 'soundwave_favorites_v1';
const DB_NAME = 'SoundWaveAudioDB';
const DB_VERSION = 2;
const TRACKS_STORE = 'imported_tracks';
const AUDIO_STORE = 'audio_blobs';
const FINGERPRINT_INDEX = 'by_fingerprint';

let dbPromise = null;

// ============================================================================
// Favorites (localStorage)
// ============================================================================

export function initStorage() {
  try {
    if (!Array.isArray(getFavorites())) {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([]));
    }
  } catch (err) {
    console.warn('localStorage unavailable:', err);
  }
  // A DB failure must never break the rest of the app.
  return openAudioDB().catch((err) => {
    console.warn('IndexedDB unavailable:', err);
    return null;
  });
}

export function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ============================================================================
// Recently played (localStorage) — newest first, max 50, one entry per song
// ============================================================================

const RECENT_KEY = 'soundwave_recently_played_v1';
const RECENT_MAX = 50;

export function getRecentlyPlayed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((t) => t && t.id) : [];
  } catch {
    return [];
  }
}

// Stores a light snapshot (never audio data). Online songs keep their stream link
// so they can still be played from Recently Played when they are not in the library.
export function recordRecentlyPlayed(track) {
  if (!track?.id) return getRecentlyPlayed();
  const snap = {
    id: track.id,
    title: track.title || 'Untitled Track',
    artist: track.artist || '',
    album: track.album || '',
    duration: Number(track.duration) || 0,
    coverSeed: track.coverSeed || track.album || track.title || '',
    playedAt: Date.now()
  };
  if (typeof track.coverUrl === 'string' && /^https?:/i.test(track.coverUrl)) snap.coverUrl = track.coverUrl;
  if (track.isOnline && typeof track.src === 'string' && /^https?:/i.test(track.src)) {
    snap.src = track.src;
    snap.isOnline = true;
    if (track.source) snap.source = track.source;
  }
  const next = [snap, ...getRecentlyPlayed().filter((t) => t.id !== track.id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('Could not save recently played:', err);
  }
  return next;
}

export function clearRecentlyPlayed() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch { /* storage blocked */ }
}

export function isFavorite(trackId) {
  return getFavorites().includes(trackId);
}

export function toggleFavorite(trackId) {
  if (!trackId) return [];
  const current = getFavorites();
  const exists = current.includes(trackId);
  const next = exists ? current.filter((id) => id !== trackId) : [...current, trackId];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('Could not save favorites:', err);
  }
  return next;
}

export function removeFavorite(trackId) {
  const next = getFavorites().filter((id) => id !== trackId);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// Ask the browser not to evict our songs when the device is low on space.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}

// ============================================================================
// IndexedDB setup + migration
// ============================================================================

export function openAudioDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      dbPromise = null;
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const oldVersion = event.oldVersion;

      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        const store = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
        store.createIndex(FINGERPRINT_INDEX, 'fingerprint', { unique: true });
        store.createIndex('by_added_at', 'addedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      }

      // v1 kept the audio blob inside the track record. Move it to its own store.
      if (oldVersion === 1) {
        const tracks = tx.objectStore(TRACKS_STORE);
        const audio = tx.objectStore(AUDIO_STORE);
        const cursorReq = tracks.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const record = cursor.value;
          if (record.audioBlob) {
            audio.put({ id: record.id, blob: record.audioBlob });
            delete record.audioBlob;
            cursor.update(record);
          }
          cursor.continue();
        };
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open SoundWave IndexedDB.'));
    };

    request.onblocked = () => {
      console.warn('SoundWave DB open is blocked by another tab. Close other SoundWave tabs.');
    };
  });

  return dbPromise;
}

function runTransaction(storeNames, mode, callback) {
  return openAudioDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          reject(err);
        };

        tx.oncomplete = () => resolve(result);
        // event.target.error carries the real reason (ConstraintError, QuotaExceededError...)
        tx.onerror = (e) =>
          fail((e.target && e.target.error) || tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = (e) =>
          fail((e.target && e.target.error) || tx.error || new Error('IndexedDB transaction aborted.'));

        try {
          const stores = Array.isArray(storeNames)
            ? storeNames.map((n) => tx.objectStore(n))
            : [tx.objectStore(storeNames)];
          result = callback(...stores);
        } catch (err) {
          try { tx.abort(); } catch { /* already finished */ }
          fail(err);
        }
      })
  );
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// Track CRUD
// ============================================================================

// Real index keys (fingerprints) without loading any audio.
export async function getAllFingerprints() {
  const db = await openAudioDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS_STORE, 'readonly');
    const index = tx.objectStore(TRACKS_STORE).index(FINGERPRINT_INDEX);
    const found = new Set();
    const req = index.openKeyCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        found.add(cursor.key);
        cursor.continue();
      } else {
        resolve(found);
      }
    };
    req.onerror = () => reject(req.error || new Error('Failed to read fingerprints.'));
  });
}

// record = metadata only; audioBlob is stored separately but in the same transaction.
export async function saveImportedTrack(record, audioBlob) {
  if (!record || !record.id || !(audioBlob instanceof Blob)) {
    throw new Error('Invalid track: missing id or audio data.');
  }
  const { audioBlob: _ignored, ...meta } = record;

  return runTransaction([TRACKS_STORE, AUDIO_STORE], 'readwrite', (tracks, audio) => {
    tracks.put({ ...meta, addedAt: meta.addedAt || Date.now() });
    audio.put({ id: meta.id, blob: audioBlob });
    return true;
  });
}

// Metadata for every imported song (newest first). No audio data is loaded.
export async function getAllImportedTracks() {
  const db = await openAudioDB();
  const tx = db.transaction(TRACKS_STORE, 'readonly');
  const records = await requestToPromise(tx.objectStore(TRACKS_STORE).getAll());
  const list = Array.isArray(records) ? records : [];
  list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return list;
}

export async function getAudioBlob(trackId) {
  if (!trackId) return null;
  const db = await openAudioDB();
  const tx = db.transaction(AUDIO_STORE, 'readonly');
  const row = await requestToPromise(tx.objectStore(AUDIO_STORE).get(trackId));
  return row ? row.blob : null;
}

export async function deleteImportedTrack(trackId) {
  if (!trackId) return false;
  await runTransaction([TRACKS_STORE, AUDIO_STORE], 'readwrite', (tracks, audio) => {
    tracks.delete(trackId);
    audio.delete(trackId);
    return true;
  });
  removeFavorite(trackId);
  return true;
}

export async function clearAllImportedTracks() {
  await runTransaction([TRACKS_STORE, AUDIO_STORE], 'readwrite', (tracks, audio) => {
    tracks.clear();
    audio.clear();
    return true;
  });
  return true;
}

// Cache a remote/cloud track for offline playback in the existing audio store.
// The record keeps the track's metadata (and optionally its cover image) but
// never the remote URLs, so it always plays from the saved file.
export async function cacheRemoteTrack(track, blob, coverBlob = null) {
  if (!track?.id || !(blob instanceof Blob)) throw new Error('Invalid offline track data.');
  const record = { ...track, isImported: true, isOffline: true, addedAt: track.addedAt || Date.now() };
  ['src', 'downloadUrl', 'isOnline', 'isAppwrite', 'isCloud', 'coverBlob', 'fingerprint'].forEach((k) => delete record[k]);
  if (track.isAppwrite) record.offlineSource = 'appwrite';
  else if (track.isOnline) record.offlineSource = 'audius';
  if (coverBlob instanceof Blob) record.coverBlob = coverBlob;
  await runTransaction([TRACKS_STORE, AUDIO_STORE], 'readwrite', (tracks, audio) => {
    tracks.put(record);
    audio.put({ id: record.id, blob });
    return true;
  });
  return record;
}

// Remove only the saved copy (keeps favourites, unlike deleteImportedTrack).
export async function deleteOfflineCopy(trackId) {
  if (!trackId) return false;
  await runTransaction([TRACKS_STORE, AUDIO_STORE], 'readwrite', (tracks, audio) => {
    tracks.delete(trackId);
    audio.delete(trackId);
    return true;
  });
  return true;
}

const PLAYBACK_PREFS_KEY = 'soundwave_playback_prefs_v1';
const DEFAULT_PLAYBACK_PREFS = { crossfadeSec: 0, gapless: true, playbackRate: 1.0 };

export function getPlaybackPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYBACK_PREFS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAYBACK_PREFS };
    return {
      crossfadeSec: Math.max(0, Math.min(12, Number(raw.crossfadeSec) || 0)),
      gapless: raw.gapless !== false,
      playbackRate: Math.max(0.5, Math.min(2.0, Number(raw.playbackRate) || 1.0))
    };
  } catch {
    return { ...DEFAULT_PLAYBACK_PREFS };
  }
}

export function setPlaybackPrefs(patch = {}) {
  const next = { ...getPlaybackPrefs(), ...patch };
  try {
    localStorage.setItem(PLAYBACK_PREFS_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent('soundwave:prefschange', { detail: next }));
  return next;
}
