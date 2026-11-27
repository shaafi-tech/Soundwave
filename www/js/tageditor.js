// ============================================================================
// SoundWave — Track Metadata / Tag Editor (js/tageditor.js)
// Persists edited Title, Artist, Album & Genre to IndexedDB (imported tracks)
// and local overrides map (for cloud / device tracks).
// ============================================================================

import { openAudioDB } from './storage.js?v=pro35';
import { toast } from './util.js?v=pro35';

const OVERRIDES_KEY = 'soundwave_tag_overrides_v1';

export function getTagOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function applyTagOverride(track) {
  if (!track || !track.id) return track;
  const ov = getTagOverrides()[track.id];
  return ov ? { ...track, ...ov } : track;
}

function saveTagOverride(trackId, patch) {
  try {
    const map = getTagOverrides();
    map[trackId] = { ...(map[trackId] || {}), ...patch };
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

async function persistToIndexedDB(trackId, patch) {
  try {
    const db = await openAudioDB();
    await new Promise((resolve) => {
      const tx = db.transaction('imported_tracks', 'readwrite');
      const store = tx.objectStore('imported_tracks');
      const req = store.get(trackId);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec) {
          Object.assign(rec, patch);
          store.put(rec);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore if not in IndexedDB */ }
}

let activeEditTrack = null;

export function openTagEditor(track) {
  const modal = document.getElementById('tag-editor-modal');
  if (!modal || !track) return;
  activeEditTrack = track;

  const titleEl = document.getElementById('tag-edit-title');
  const artistEl = document.getElementById('tag-edit-artist');
  const albumEl = document.getElementById('tag-edit-album');
  const genreEl = document.getElementById('tag-edit-genre');

  if (titleEl) titleEl.value = track.title || '';
  if (artistEl) artistEl.value = track.artist || '';
  if (albumEl) albumEl.value = track.album || '';
  if (genreEl) genreEl.value = track.genre || 'General';

  if (!modal.dataset.wired) {
    modal.dataset.wired = '1';
    const form = document.getElementById('tag-editor-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeEditTrack) return;
      const patch = {
        title: String(document.getElementById('tag-edit-title')?.value || '').trim() || activeEditTrack.title || 'Untitled Track',
        artist: String(document.getElementById('tag-edit-artist')?.value || '').trim() || 'Unknown Artist',
        album: String(document.getElementById('tag-edit-album')?.value || '').trim() || 'Local Library',
        genre: String(document.getElementById('tag-edit-genre')?.value || '').trim() || 'General'
      };
      saveTagOverride(activeEditTrack.id, patch);
      await persistToIndexedDB(activeEditTrack.id, patch);
      Object.assign(activeEditTrack, patch);

      if (typeof modal.close === 'function') modal.close();
      else modal.removeAttribute('open');
      toast('Song info updated');
      document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
    });

    modal.querySelectorAll('[data-close-modal]').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof modal.close === 'function') modal.close();
        else modal.removeAttribute('open');
      });
    });
  }

  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}
