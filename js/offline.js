// ============================================================================
// SoundWave — Offline saving for cloud (Appwrite) and online (Audius) tracks
// (js/offline.js)
// ----------------------------------------------------------------------------
// Saved songs live in IndexedDB (audio blob + metadata + cover) and the player
// prefers that copy over the network, so they keep playing with no connection.
// ============================================================================

import { cacheRemoteTrack, getAllImportedTracks, deleteOfflineCopy, requestPersistence } from './storage.js?v=pro35';
import { fetchWithRetry, waitForOnline, isOnline } from './network.js?v=pro35';
import { notifyAppEvent } from './native.js?v=pro35';

const saved = new Set();
const inflight = new Map();
let initPromise = null;

const emit = () => document.dispatchEvent(new CustomEvent('soundwave:offlinechange'));

export function initOffline() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const list = await getAllImportedTracks();
        saved.clear();
        list.filter((t) => t.isOffline).forEach((t) => saved.add(t.id));
      } catch (err) {
        console.warn('Could not read offline songs:', err);
      }
      emit();
    })();
  }
  return initPromise;
}

export const isSaved = (trackId) => saved.has(trackId);
export const isSaving = (trackId) => inflight.has(trackId);
export const savedCount = () => saved.size;

function friendlyStorageError(err) {
  if (err?.name === 'QuotaExceededError' || /quota/i.test(String(err?.message || ''))) {
    return 'Not enough free storage on this device to save the song.';
  }
  return err?.message || 'Could not save this song offline.';
}

async function downloadBlob(url, { onProgress, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithRetry(url, { signal, timeout: 20000, retries: 1 });
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);

      const type = response.headers.get('content-type') || '';
      if (/text\/html|application\/json/i.test(type)) throw new Error('The server did not return audio.');

      const total = Number(response.headers.get('content-length')) || 0;
      if (!response.body || !response.body.getReader) {
        const blob = await response.blob();
        onProgress?.(100);
        return blob;
      }

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      }
      onProgress?.(100);
      return new Blob(chunks, { type: type || 'audio/mpeg' });
    } catch (err) {
      lastError = err;
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      // Connection dropped mid-download: wait for the network, then try again.
      if (attempt < 2) await waitForOnline(20000);
    }
  }
  throw lastError || new Error('Download failed.');
}

async function fetchCover(url, signal) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const res = await fetchWithRetry(url, { signal, timeout: 8000, retries: 1 });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.type.startsWith('image/') && blob.size < 5 * 1024 * 1024 ? blob : null;
  } catch {
    return null; // cover is optional; the placeholder cover covers for it
  }
}

// Downloads the audio (+ cover) and stores it. onProgress(0-100).
export async function saveTrackOffline(track, { onProgress, signal } = {}) {
  if (!track?.id) throw new Error('Nothing to save.');
  if (saved.has(track.id)) return true;
  if (inflight.has(track.id)) return inflight.get(track.id);

  const url = track.downloadUrl || track.src;
  if (!url) throw new Error('This song has no download link.');
  if (!isOnline()) throw new Error('Connect to the internet to save this song.');

  const job = (async () => {
    try {
      requestPersistence?.();
      const [blob, coverBlob] = await Promise.all([
        downloadBlob(url, { onProgress, signal }),
        fetchCover(track.coverUrl || track.cover, signal)
      ]);
      if (!blob || blob.size < 1024) throw new Error('The downloaded file looks empty.');
      await cacheRemoteTrack(track, blob, coverBlob);
      saved.add(track.id);
      emit();
      notifyAppEvent('SoundWave', `Offline download complete: ${track.title || 'Track'}`);
      return true;
    } catch (err) {
      throw new Error(friendlyStorageError(err));
    } finally {
      inflight.delete(track.id);
    }
  })();

  inflight.set(track.id, job);
  return job;
}

export async function removeOfflineCopy(trackId) {
  await deleteOfflineCopy(trackId);
  saved.delete(trackId);
  emit();
  return true;
}
