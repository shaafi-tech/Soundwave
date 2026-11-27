// ============================================================================
// SoundWave — Library views, Home page & track/album renderers (js/library.js)
// ============================================================================

import {
  getAllImportedTracks,
  getFavorites,
  getRecentlyPlayed,
  toggleFavorite,
  deleteImportedTrack,
  clearAllImportedTracks,
  openAudioDB
} from './storage.js?v=pro35';
import { getCloudTracks, isCloudPending, deleteCloudTrack } from './cloud.js?v=pro35';
import { getCachedMediaStoreTracks, scanDeviceMediaStore } from './mediastore.js?v=pro35';
import { applyTagOverride, openTagEditor } from './tageditor.js?v=pro35';
import { getMostPlayedTracks } from './stats.js?v=pro35';
import { fetchCoverArtForTrack } from './search.js?v=pro35';
import * as player from './player.js?v=pro35';
import { isSaved, saveTrackOffline, removeOfflineCopy } from './offline.js?v=pro35';
import { isOnline } from './network.js?v=pro35';
import { requestAppNotification } from './native.js?v=pro35';
import {
  escapeHtml,
  formatTime,
  toast,
  coverFor,
  placeholderCover,
  imgFallbackAttr,
  forgetCover,
  hashString,
  saveCustomCover
} from './util.js?v=pro35';

const EMPTY_HINT = 'Tap Import and pick your songs from your phone or computer.';

// ----------------------------------------------------------------------------
// Merging imported songs with songs shipped with the site (music/tracks.json)
// ----------------------------------------------------------------------------

export async function getMergedLibraryTracks(catalogTracks = []) {
  let imported = [];
  try {
    imported = await getAllImportedTracks();
  } catch (err) {
    console.warn('Could not load imported tracks from IndexedDB:', err);
  }

  const normalizedImported = imported.map((item) => ({ ...item, isImported: true }));

  // A cloud song that was also saved offline exists twice (cloud entry + saved copy).
  // Show it once: keep the cloud entry (so it can still be deleted from Appwrite) and mark it saved.
  const offlineIds = new Set(normalizedImported.filter((t) => t.isOffline).map((t) => t.id));
  const cloud = getCloudTracks().map((t) => (offlineIds.has(t.id) ? { ...t, isOffline: true } : t));
  const cloudIds = new Set(cloud.map((t) => t.id));
  const localOnly = normalizedImported.filter((t) => !cloudIds.has(t.id));

  // Local (IndexedDB) songs + shared cloud songs + songs shipped with the site,
  // newest first. Array.sort is stable, so songs without a date keep their order.
  const deviceTracks = getCachedMediaStoreTracks();
  const seenSig = new Set(
    [...localOnly, ...cloud].map((t) => `${String(t.title || '').toLowerCase()}::${String(t.artist || '').toLowerCase()}`)
  );
  const uniqueDevice = deviceTracks.filter((t) => {
    const sig = `${String(t.title || '').toLowerCase()}::${String(t.artist || '').toLowerCase()}`;
    return !seenSig.has(sig);
  });

  return [...localOnly, ...uniqueDevice, ...cloud, ...catalogTracks]
    .map(applyTagOverride)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}


// Progressively fetches cover art for tracks without embedded/remote cover and refreshes visible <img> tags.
function hydrateMissingCovers(tracks = [], containerEl = null) {
  if (!isOnline() || !Array.isArray(tracks) || !tracks.length) return;
  const targets = tracks.filter((t) => !hasRealArt(t) && t.title).slice(0, 20);
  if (!targets.length) return;

  targets.forEach(async (track) => {
    const artUrl = await fetchCoverArtForTrack(track);
    if (!artUrl) return;
    track.coverUrl = artUrl;
    saveCustomCover(track.id, artUrl);

    const scope = containerEl || document;
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(track.id) : String(track.id).replace(/"/g, '');
    scope.querySelectorAll(`.track-row[data-track-id="${escapedId}"] .track-thumb, .sw-hcard[data-hcard-track="${escapedId}"] img`).forEach((img) => {
      img.onerror = () => {
        img.onerror = null;
        img.src = placeholderCover(track.coverSeed || track.album || track.title);
      };
      img.src = artUrl;
    });

    const cur = player.getCurrentTrack();
    if (cur && cur.id === track.id) {
      const pCover = document.getElementById('player-cover');
      const fpCover = document.getElementById('fp-cover');
      if (pCover) pCover.src = artUrl;
      if (fpCover) fpCover.src = artUrl;
    }
  });
}


function getGreetingText() {
  const hr = new Date().getHours();
  if (hr < 12) return 'Good Morning 👋';
  if (hr < 17) return 'Good Afternoon 👋';
  return 'Good Evening 👋';
}

function renderHorizontalTrackCards(tracks = [], favoritesSet = new Set()) {
  if (!tracks.length) return '';
  return `
    <div class="sw-hscroll-row" role="list">
      ${tracks
        .map((track) => {
          const liked = favoritesSet.has(track.id);
          const title = track.title || 'Untitled Track';
          return `
            <article class="sw-hcard" role="listitem" data-hcard-track="${escapeHtml(track.id)}" tabindex="0" aria-label="Play ${escapeHtml(title)}">
              <div class="sw-hcard-art">
                <img
                  src="${escapeHtml(coverFor(track))}"
                  alt=""
                  loading="lazy"
                  onerror="${imgFallbackAttr(track.coverSeed || track.album || title)}"
                >
                <button type="button" class="sw-hcard-like like-track-btn ${liked ? 'liked' : ''}" data-track-id="${escapeHtml(track.id)}" aria-pressed="${liked}" aria-label="Favorite ${escapeHtml(title)}">
                  ${ICON_HEART}
                </button>
              </div>
              <div class="sw-hcard-meta">
                <h3 class="sw-hcard-title">${escapeHtml(title)}</h3>
                <p class="sw-hcard-artist">${escapeHtml(track.artist || 'Unknown Artist')}</p>
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function bindHorizontalTrackCards(containerEl, playList = []) {
  if (!containerEl) return;
  containerEl.querySelectorAll('.sw-hcard[data-hcard-track]').forEach((card) => {
    const trackId = card.dataset.hcardTrack;
    card.querySelector('.sw-hcard-like')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(trackId);
      document.dispatchEvent(new CustomEvent('soundwave:favoritechange', { detail: { trackId } }));
    });
    card.addEventListener('click', () => {
      player.playTrackById(trackId, playList);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') player.playTrackById(trackId, playList);
    });
  });
}

function hasRealArt(track) {
  return Boolean(track.coverBlob || track.cover || track.coverUrl);
}

// Group every song by its album tag (Albums view, home page and search).

export function buildFolders(tracks = []) {
  const groups = new Map();
  tracks.forEach((t) => {
    const folder = String(
      t.folderName ||
      (t.isAppwrite ? 'SoundWave Cloud' : t.isOnline ? 'Online Streams' : 'Imported Songs')
    ).trim() || 'Imported Songs';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(t);
  });

  return Array.from(groups.entries()).map(([name, list]) => {
    const withArt = list.find(hasRealArt);
    const removable = list.some((t) => t.isImported || t.isAppwrite);
    return {
      id: `folder-${hashString(name)}`,
      name,
      title: name,
      artist: `${list.length} song${list.length === 1 ? '' : 's'}`,
      cover: withArt ? coverFor(withArt) : placeholderCover(name),
      trackIds: list.map((t) => t.id),
      removable
    };
  });
}

export function buildGenres(tracks = []) {
  const groups = new Map();
  tracks.forEach((t) => {
    const genre = String(
      t.genre ||
      (t.isAppwrite ? 'Cloud' : t.isOnline ? 'Discover' : 'General')
    ).trim() || 'General';
    if (!groups.has(genre)) groups.set(genre, []);
    groups.get(genre).push(t);
  });

  return Array.from(groups.entries()).map(([name, list]) => {
    const withArt = list.find(hasRealArt);
    return {
      id: `genre-${hashString(name)}`,
      title: name,
      artist: `${list.length} song${list.length === 1 ? '' : 's'}`,
      cover: withArt ? coverFor(withArt) : placeholderCover(name),
      trackIds: list.map((t) => t.id)
    };
  });
}

async function deleteFolderGroup(folder, allTracks = []) {
  if (!folder) return;
  const targets = allTracks.filter((t) => folder.trackIds.includes(t.id));
  const removable = targets.filter((t) => t.isImported || t.isAppwrite);
  if (!removable.length) {
    toast('Online or catalog songs cannot be deleted from device storage.');
    return;
  }
  if (!window.confirm(`Delete "${folder.name}" (${removable.length} song${removable.length === 1 ? '' : 's'})?`)) return;

  for (const track of removable) {
    try {
      if (track.isAppwrite) {
        await deleteCloudTrack(track.id);
      } else {
        await deleteImportedTrack(track.id);
      }
      if (isSaved(track.id)) await removeOfflineCopy(track.id);
      forgetCover(track.id);
      player.removeTrackEverywhere(track.id);
    } catch (err) {
      console.warn('Could not delete track in folder:', track.title, err);
    }
  }
  toast(`Deleted folder "${folder.name}"`);
  notifyLibraryChanged();
}

function renderFolderCards(folders = []) {
  return `
    <div class="media-grid sw-folder-grid">
      ${folders
        .map(
          (folder) => `
            <article class="album-card sw-folder-card" data-folder-id="${escapeHtml(folder.id)}" tabindex="0" role="button" aria-label="Play folder ${escapeHtml(folder.name)}">
              <div class="album-cover-wrapper">
                <img
                  src="${escapeHtml(folder.cover || placeholderCover(folder.name))}"
                  alt=""
                  class="album-cover"
                  loading="lazy"
                  onerror="${imgFallbackAttr(folder.name)}"
                >
                <div class="album-hover-overlay">
                  <button type="button" class="play-circle-btn" data-folder-play="${escapeHtml(folder.id)}" aria-label="Play ${escapeHtml(folder.name)}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="6 4 20 12 6 20 6 4"></polygon>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="album-meta">
                <h3 class="album-title">${escapeHtml(folder.name)}</h3>
                <p class="album-artist">${escapeHtml(folder.artist)}</p>
              </div>
              ${folder.removable
                ? `<button type="button" class="sw-folder-delete-btn" data-folder-delete="${escapeHtml(folder.id)}" aria-label="Delete folder ${escapeHtml(folder.name)}">Delete Folder</button>`
                : ''}
            </article>
          `
        )
        .join('')}
    </div>
  `;
}

function bindFolderCards(containerEl, folders = [], allTracks = []) {
  if (!containerEl) return;
  containerEl.querySelectorAll('.sw-folder-card[data-folder-id]').forEach((card) => {
    const folder = folders.find((f) => f.id === card.dataset.folderId);
    if (!folder) return;
    const byId = new Map(allTracks.map((t) => [t.id, t]));
    const play = () => {
      const list = folder.trackIds.map((id) => byId.get(id)).filter(Boolean);
      if (list.length) {
        player.playList(list, 0);
        toast(`Playing "${folder.name}"`);
      }
    };
    card.querySelector('[data-folder-play]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      play();
    });
    card.querySelector('[data-folder-delete]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteFolderGroup(folder, allTracks);
    });
    card.addEventListener('click', play);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') play();
    });
  });
}

export function buildAlbums(tracks = []) {
  const groups = new Map();
  tracks.forEach((t) => {
    const key = String(t.album || 'Local Library');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  return Array.from(groups.entries()).map(([title, list]) => {
    const artists = new Set(list.map((t) => t.artist || 'Unknown Artist'));
    const withArt = list.find(hasRealArt);
    return {
      id: `album-${hashString(title)}`,
      title,
      artist: artists.size === 1 ? [...artists][0] : 'Various Artists',
      cover: withArt ? coverFor(withArt) : placeholderCover(title),
      trackIds: list.map((t) => t.id)
    };
  });
}

// Kept for older callers: albums are now always derived from the songs themselves.
export function getMergedAlbums(_catalogAlbums = [], allTracks = []) {
  return buildAlbums(allTracks);
}

export function albumTracks(album, allTracks = []) {
  const byId = new Map(allTracks.map((t) => [t.id, t]));
  return (album?.trackIds || []).map((id) => byId.get(id)).filter(Boolean);
}

// ----------------------------------------------------------------------------
// Deleting songs
// ----------------------------------------------------------------------------

function notifyLibraryChanged() {
  document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
}

async function removeImportedTrack(track) {
  if (!window.confirm(`Remove "${track.title || 'this song'}" from your library?`)) return;
  try {
    if (track.isAppwrite) {
      await deleteCloudTrack(track.id);
      if (isSaved(track.id)) await removeOfflineCopy(track.id); // also drop the saved copy
    } else {
      await deleteImportedTrack(track.id);
      if (isSaved(track.id)) await removeOfflineCopy(track.id);
    }
    forgetCover(track.id);
    player.removeTrackEverywhere(track.id);
    toast('Song removed');
    notifyLibraryChanged();
  } catch (err) {
    console.error('Could not remove song:', err);
    toast(err?.message || 'Could not remove that song.');
  }
}

async function removeAllImported(count) {
  if (!window.confirm(`Remove all ${count} imported songs from this device? This cannot be undone.`)) return;
  try {
    await clearAllImportedTracks();
    player.resetPlayer();
    toast('Library cleared');
    notifyLibraryChanged();
  } catch (err) {
    console.error('Could not clear library:', err);
    toast('Could not clear the library.');
  }
}

// ----------------------------------------------------------------------------
// Shared renderers (also used by search.js and playlist.js)
// ----------------------------------------------------------------------------

const ICON_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
const ICON_HEART = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
const ICON_QUEUE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
const ICON_TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
const ICON_IMPORT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>';
const ICON_CLOUD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10a6 6 0 0 0-11.7-1.6A4.5 4.5 0 0 0 7 17h2"></path><path d="M17 17h1a4 4 0 0 0 .6-7.95"></path><polyline points="9 14 12 11 15 14"></polyline><line x1="12" y1="11" x2="12" y2="21"></line></svg>';
const ICON_DOWNLOAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
const ICON_CHECK_OFFLINE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="8 12.5 11 15.5 16 9"></polyline></svg>';
const ICON_SHUFFLE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';
const ICON_IMAGE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
const ICON_DOTS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>';

export function renderTrackList(tracks, favoritesSet, emptyMessage = EMPTY_HINT) {
  if (!tracks.length) {
    return `
      <div class="sw-empty-card" role="status">
        <div class="sw-empty-icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
        </div>
        <h3 class="sw-empty-title">No songs here yet</h3>
        <p class="sw-empty-desc">${escapeHtml(emptyMessage)}</p>
        <div class="sw-empty-actions">
          <button type="button" class="btn btn-primary sw-empty-import">${ICON_IMPORT}<span>Import Local</span></button>
          <button type="button" class="btn btn-secondary sw-empty-upload">${ICON_CLOUD}<span>Upload Cloud</span></button>
        </div>
      </div>
    `;
  }

  return `
    <div class="track-list" role="list">
      ${tracks
        .map((track, idx) => {
          const liked = favoritesSet.has(track.id);
          const title = track.title || 'Untitled Track';
          return `
            <div class="track-row" role="listitem" data-track-id="${escapeHtml(track.id)}">
              <div class="track-index-col">
                <span class="track-number">${idx + 1}</span>
                <button type="button" class="track-play-btn" aria-label="Play ${escapeHtml(title)}">${ICON_PLAY}</button>
              </div>
              <div class="track-info-col">
                <img
                  src="${escapeHtml(coverFor(track))}"
                  alt=""
                  class="track-thumb"
                  loading="lazy"
                  onerror="${imgFallbackAttr(track.coverSeed || track.album || title)}"
                >
                <div class="track-details">
                  <span class="track-title">${escapeHtml(title)}</span>
                  <span class="track-artist">${escapeHtml(track.artist || 'Unknown Artist')}${(track.isOffline || isSaved(track.id)) ? '<span class="offline-pill">Offline</span>' : ''}</span>
                </div>
              </div>
              <div class="track-album-col desktop-only">${escapeHtml(track.album || 'Local Library')}</div>
              <div class="track-actions-col">
                <button type="button" class="like-track-btn ${liked ? 'liked' : ''}" data-track-id="${escapeHtml(track.id)}" aria-pressed="${liked}" aria-label="Favorite ${escapeHtml(title)}">${ICON_HEART}</button>
                <span class="track-duration">${track.duration ? formatTime(track.duration) : ''}</span>
                <div class="track-menu-wrap">
                  <button type="button" class="track-dots-btn" data-track-id="${escapeHtml(track.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More options for ${escapeHtml(title)}" title="More options">${ICON_DOTS}</button>
                  <div class="track-dropdown hidden" role="menu">
                    <button type="button" class="track-menu-item track-more-btn" role="menuitem" data-track-id="${escapeHtml(track.id)}">${ICON_QUEUE}<span>Add to Up Next</span></button>
                    ${(track.isOnline || track.isAppwrite) ? (isSaved(track.id)
                      ? `<button type="button" class="track-menu-item track-offline-btn saved" role="menuitem" data-track-id="${escapeHtml(track.id)}" aria-pressed="true">${ICON_CHECK_OFFLINE}<span>Remove Offline Copy</span></button>`
                      : `<button type="button" class="track-menu-item track-offline-btn" role="menuitem" data-track-id="${escapeHtml(track.id)}" aria-pressed="false">${ICON_DOWNLOAD}<span>Save Offline</span></button>`) : ''}
                    ${(track.isImported || track.isAppwrite) ? `<button type="button" class="track-menu-item track-cover-btn" role="menuitem" data-track-id="${escapeHtml(track.id)}">${ICON_IMAGE}<span>Change Cover Image</span></button>` : ''}
                    <button type="button" class="track-menu-item track-edit-tag-btn" role="menuitem" data-track-id="${escapeHtml(track.id)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg><span>Edit Song Info</span></button>
                    ${(track.isImported || track.isAppwrite) ? `<button type="button" class="track-menu-item danger track-remove-btn" role="menuitem" data-track-id="${escapeHtml(track.id)}">${ICON_TRASH}<span>Delete Song</span></button>` : ''}
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

// Wires play / favorite / queue / remove on every .track-row inside containerEl.
// playList is the list that becomes the playback queue when a row is clicked.
export function bindTrackRows(containerEl, playList, { onChange } = {}) {
  if (!containerEl) return;

  containerEl.querySelectorAll('.sw-empty-import').forEach((b) => b.addEventListener('click', openImportPicker));
  containerEl.querySelectorAll('.sw-empty-upload').forEach((b) => b.addEventListener('click', openCloudUpload));

  containerEl.querySelectorAll('.track-row[data-track-id]').forEach((row) => {
    const trackId = row.dataset.trackId;

    row.querySelector('.like-track-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(trackId);
      document.dispatchEvent(new CustomEvent('soundwave:favoritechange', { detail: { trackId } }));
      if (typeof onChange === 'function') onChange(trackId);
    });

    const dotsBtn = row.querySelector('.track-dots-btn');
    const dropdown = row.querySelector('.track-dropdown');
    const closeMenu = () => {
      dropdown?.classList.add('hidden');
      dotsBtn?.setAttribute('aria-expanded', 'false');
      row.classList.remove('menu-open');
    };

    dotsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = dropdown?.classList.contains('hidden');
      document.querySelectorAll('.track-dropdown:not(.hidden)').forEach((el) => {
        el.classList.add('hidden');
        el.closest('.track-row')?.classList.remove('menu-open');
        el.closest('.track-menu-wrap')?.querySelector('.track-dots-btn')?.setAttribute('aria-expanded', 'false');
      });
      if (willOpen && dropdown) {
        dropdown.classList.remove('hidden');
        dotsBtn.setAttribute('aria-expanded', 'true');
        row.classList.add('menu-open');
      }
    });

    dropdown?.addEventListener('click', (e) => e.stopPropagation());

    row.querySelector('.track-more-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      player.addToQueueById(trackId, playList);
    });

    row.querySelector('.track-offline-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const track = playList.find((t) => t.id === trackId);
      const button = e.currentTarget;
      const labelSpan = button.querySelector('span');
      if (!track || button.disabled) return;

      // Already saved: tap again to remove the offline copy.
      if (isSaved(trackId)) {
        try {
          await removeOfflineCopy(trackId);
          button.classList.remove('saved');
          button.setAttribute('aria-pressed', 'false');
          button.innerHTML = `${ICON_DOWNLOAD}<span>Save Offline</span>`;
          row.querySelector('.offline-pill')?.remove();
          closeMenu();
          toast('Offline copy removed');
          notifyLibraryChanged();
        } catch (err) {
          console.warn(err);
          toast('Could not remove the offline copy.');
        }
        return;
      }

      if (!isOnline()) {
        closeMenu();
        toast('Connect to the internet to save this song offline.');
        return;
      }

      requestAppNotification();
      button.disabled = true;
      button.classList.add('busy');
      if (labelSpan) labelSpan.textContent = 'Saving 0%…';
      try {
        await saveTrackOffline(track, { onProgress: (p) => { if (labelSpan) labelSpan.textContent = `Saving ${p}%…`; } });
        button.classList.add('saved');
        button.setAttribute('aria-pressed', 'true');
        button.innerHTML = `${ICON_CHECK_OFFLINE}<span>Remove Offline Copy</span>`;
        if (!row.querySelector('.offline-pill')) {
          row.querySelector('.track-artist')?.insertAdjacentHTML('beforeend', '<span class="offline-pill">Offline</span>');
        }
        closeMenu();
        toast('Saved for offline playback');
        notifyLibraryChanged();
      } catch (err) {
        console.warn('Offline save failed:', err);
        button.innerHTML = `${ICON_DOWNLOAD}<span>Save Offline</span>`;
        toast(err?.message || 'Could not save this track offline.');
      } finally {
        button.disabled = false;
        button.classList.remove('busy');
      }
    });

    row.querySelector('.track-cover-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      document.dispatchEvent(new CustomEvent('soundwave:changecover', { detail: { trackId } }));
    });

    row.querySelector('.track-edit-tag-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      const track = playList.find((t) => t.id === trackId);
      if (track) openTagEditor(track);
    });

    row.querySelector('.track-remove-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      const track = playList.find((t) => t.id === trackId);
      if (track) removeImportedTrack(track);
    });

    row.addEventListener('click', () => {
      player.playTrackById(trackId, playList);
    });
  });
}

export function renderAlbumCards(albums = []) {
  return `
    <div class="media-grid">
      ${albums
        .map(
          (album) => `
            <article class="album-card" data-album-id="${escapeHtml(album.id)}" tabindex="0" role="button" aria-label="Play ${escapeHtml(album.title)}">
              <div class="album-cover-wrapper">
                <img
                  src="${escapeHtml(album.cover || placeholderCover(album.title))}"
                  alt=""
                  class="album-cover"
                  loading="lazy"
                  onerror="${imgFallbackAttr(album.title)}"
                >
                <div class="album-hover-overlay">
                  <button type="button" class="play-circle-btn" data-album-play="${escapeHtml(album.id)}" aria-label="Play ${escapeHtml(album.title)}">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="6 4 20 12 6 20 6 4"></polygon>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="album-meta">
                <h3 class="album-title">${escapeHtml(album.title)}</h3>
                <p class="album-artist">${escapeHtml(album.artist || 'Various Artists')}</p>
              </div>
            </article>
          `
        )
        .join('')}
    </div>
  `;
}

export function bindAlbumCards(containerEl, albums = [], allTracks = []) {
  if (!containerEl) return;
  containerEl.querySelectorAll('.album-card[data-album-id]').forEach((card) => {
    const album = albums.find((a) => a.id === card.dataset.albumId);
    if (!album) return;
    const play = () => {
      const list = albumTracks(album, allTracks);
      if (list.length) {
        player.playList(list, 0);
        toast(`Playing "${album.title}"`);
      }
    };
    card.querySelector('[data-album-play]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      play();
    });
    card.addEventListener('click', play);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') play();
    });
  });
}

function openImportPicker() {
  document.getElementById('bulk-import-input')?.click();
}

// Asks account.js to open the Upload modal (or the Login modal first, for guests).
function openCloudUpload() {
  document.dispatchEvent(new CustomEvent('soundwave:openupload'));
}

// ----------------------------------------------------------------------------
// Home ("Listen Now")
// ----------------------------------------------------------------------------

export async function renderHome(containerEl, { tracks = [] } = {}) {
  if (!containerEl) return;

  const allTracks = await getMergedLibraryTracks(tracks);
  const favoritesSet = new Set(getFavorites());
  const albums = buildAlbums(allTracks);

  if (!allTracks.length) {
    const loading = isCloudPending();
    containerEl.innerHTML = `
      <section class="hero-section" aria-label="Welcome">
        <div class="hero-card">
          <div class="hero-backdrop home-hero-backdrop"></div>
          <div class="hero-content">
            <span class="hero-tag">${loading ? 'SoundWave Cloud' : 'Your Library'}</span>
            <h2 class="hero-title">${loading ? 'Loading music…' : 'Add your music'}</h2>
            <p class="hero-description">${loading
              ? 'Fetching the latest songs from SoundWave Cloud.'
              : 'Import songs from your phone to keep them on this device, or log in and upload to SoundWave Cloud so everyone can listen.'}</p>
            ${loading ? '' : `<div class="hero-actions">
              <button type="button" id="home-import-btn" class="btn btn-primary">${ICON_IMPORT}<span>Import Songs</span></button>
              <button type="button" id="home-upload-btn" class="btn btn-secondary">${ICON_CLOUD}<span>Upload to Cloud</span></button>
            </div>`}
          </div>
        </div>
      </section>
    `;
    containerEl.querySelector('#home-import-btn')?.addEventListener('click', openImportPicker);
    containerEl.querySelector('#home-upload-btn')?.addEventListener('click', openCloudUpload);
    return;
  }

  const newest = allTracks[0];
  const heroCover = coverFor(newest);
  const recent = allTracks.slice(0, 12);
  const albumPreview = albums.slice(0, 8);
  const favTracks = allTracks.filter((t) => favoritesSet.has(t.id));

  const artistMap = new Map();
  allTracks.forEach((t) => {
    const a = String(t.artist || 'Unknown Artist');
    if (!artistMap.has(a)) artistMap.set(a, []);
    artistMap.get(a).push(t);
  });
  const artistCards = Array.from(artistMap.entries()).slice(0, 8).map(([artistName, list]) => {
    const art = list.find(hasRealArt);
    return {
      id: `artist-${hashString(artistName)}`,
      title: artistName,
      artist: `${list.length} song${list.length === 1 ? '' : 's'}`,
      cover: art ? coverFor(art) : placeholderCover(artistName),
      trackIds: list.map((t) => t.id)
    };
  });

  const rpSnaps = getRecentlyPlayed().slice(0, 6);
  const byId = new Map(allTracks.map((t) => [t.id, t]));
  // A song that left the library can only be replayed if it is an online one (has a stream link).
  const rpTracks = rpSnaps.map((s) => byId.get(s.id) || (s.src ? s : null)).filter(Boolean);

  const greeting = getGreetingText();

  containerEl.innerHTML = `
    <section class="hero-section" aria-label="Listen Now">
      <div class="hero-card sw-hero-banner" id="sw-hero-card">
        <div class="hero-backdrop">
          <img id="sw-hero-img" src="${escapeHtml(heroCover)}" alt="" class="hero-bg-img" onerror="${imgFallbackAttr(newest.coverSeed || newest.album || newest.title)}">
        </div>
        <div class="sw-hero-overlay">
          <div class="sw-hero-main">
            <div class="sw-hero-left">
              <span class="sw-hero-greeting">${escapeHtml(greeting)}</span>
              <h2 class="sw-hero-title" id="sw-hero-title">Listen Now</h2>
              <p class="sw-hero-subtitle" id="sw-hero-subtitle">Your music, your vibe &#127925;</p>
              <div class="sw-hero-btns">
                <button type="button" id="home-play-btn" class="btn btn-primary sw-hero-play-btn">${ICON_PLAY}<span>Play All</span></button>
                <button type="button" id="home-shuffle-btn" class="btn btn-secondary sw-hero-shuffle-btn">${ICON_SHUFFLE}<span>Shuffle</span></button>
              </div>
            </div>
            <div class="sw-hero-right">
              <button type="button" id="home-hero-circle-play" class="sw-hero-glass-play" aria-label="Play featured music">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"></polygon></svg>
              </button>
              <div class="sw-hero-eq-bars" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
              </div>
            </div>
          </div>
          <div class="sw-hero-dots" role="tablist" aria-label="Featured slides">
            <button type="button" class="sw-hero-dot active" data-hero-slide="0" aria-label="Listen Now"></button>
            <button type="button" class="sw-hero-dot" data-hero-slide="1" aria-label="Recently Added"></button>
            <button type="button" class="sw-hero-dot" data-hero-slide="2" aria-label="Favorites Mix"></button>
          </div>
        </div>
      </div>
    </section>

    <section class="content-section" aria-labelledby="home-recent-heading">
      <div class="section-header">
        <h2 id="home-recent-heading" class="section-title sw-bar-title">Recently Added</h2>
        <button type="button" class="text-link-btn sw-see-all" data-see-all="recently-added">See All &rsaquo;</button>
      </div>
      <div id="home-recent-cards">${renderHorizontalTrackCards(recent, favoritesSet)}</div>
    </section>

    ${rpTracks.length ? `
    <section class="content-section" aria-labelledby="home-played-heading">
      <div class="section-header">
        <h2 id="home-played-heading" class="section-title sw-bar-title">Recently Played</h2>
        <button type="button" class="text-link-btn sw-see-all" data-see-all="recently-played">See All &rsaquo;</button>
      </div>
      <div id="home-played-list">${renderTrackList(rpTracks, favoritesSet)}</div>
    </section>` : ''}

    ${favTracks.length ? `
    <section class="content-section" aria-labelledby="home-fav-heading">
      <div class="section-header">
        <h2 id="home-fav-heading" class="section-title sw-bar-title">Favorites</h2>
        <button type="button" class="text-link-btn sw-see-all" data-see-all="favorites">See All &rsaquo;</button>
      </div>
      <div id="home-fav-cards">${renderHorizontalTrackCards(favTracks.slice(0, 10), favoritesSet)}</div>
    </section>` : ''}

    <section class="content-section" aria-labelledby="home-albums-heading">
      <div class="section-header">
        <h2 id="home-albums-heading" class="section-title sw-bar-title">Albums</h2>
        <button type="button" class="text-link-btn sw-see-all" data-see-all="albums">See All &rsaquo;</button>
      </div>
      <div id="home-albums-grid">${renderAlbumCards(albumPreview)}</div>
    </section>

    <section class="content-section" aria-labelledby="home-playlists-heading">
      <div class="section-header">
        <h2 id="home-playlists-heading" class="section-title sw-bar-title">Playlists</h2>
        <button type="button" class="text-link-btn sw-see-all" id="home-new-playlist-btn">New Playlist &rsaquo;</button>
      </div>
      <div id="home-playlists-grid" class="sw-playlists-strip"></div>
    </section>

    <section class="content-section" aria-labelledby="home-artists-heading">
      <div class="section-header">
        <h2 id="home-artists-heading" class="section-title sw-bar-title">Artists</h2>
        <button type="button" class="text-link-btn sw-see-all" data-see-all="artists">See All &rsaquo;</button>
      </div>
      <div id="home-artists-grid" class="sw-artists-grid">${renderAlbumCards(artistCards)}</div>
    </section>
  `;

  const plGrid = containerEl.querySelector('#home-playlists-grid');
  containerEl.querySelector('#home-new-playlist-btn')?.addEventListener('click', () => {
    document.getElementById('create-playlist-btn')?.click();
  });
  if (plGrid) {
    try {
      const rawPl = JSON.parse(localStorage.getItem('soundwave_playlists_v1') || '[]');
      const lists = Array.isArray(rawPl) ? rawPl : [];
      if (!lists.length) {
        plGrid.innerHTML = `<button type="button" class="sw-glass-pill-card" id="home-create-pl-tile"><strong>+ Create Playlist</strong><span>Group your favorite tracks</span></button>`;
        plGrid.querySelector('#home-create-pl-tile')?.addEventListener('click', () => document.getElementById('create-playlist-btn')?.click());
      } else {
        plGrid.innerHTML = lists.map((pl) => {
          const count = Array.isArray(pl.trackIds) ? pl.trackIds.length : 0;
          return `<button type="button" class="sw-glass-pill-card" data-open-pl="${escapeHtml(pl.id)}"><strong>${escapeHtml(pl.name)}</strong><span>${count} song${count === 1 ? '' : 's'}</span></button>`;
        }).join('');
        plGrid.querySelectorAll('[data-open-pl]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const navBtn = document.querySelector(`.sidebar .nav-link[data-playlist-id="${btn.dataset.openPl}"]`);
            if (navBtn) navBtn.click();
          });
        });
      }
    } catch { /* ignore */ }
  }

  let activeSlide = 0;
  const slides = [
    {
      title: 'Listen Now',
      subtitle: 'Your music, your vibe 🎵',
      list: allTracks,
      cover: heroCover
    },
    {
      title: 'Fresh Arrivals',
      subtitle: `${recent.length} latest track${recent.length === 1 ? '' : 's'} in your library`,
      list: recent,
      cover: recent[0] ? coverFor(recent[0]) : heroCover
    },
    {
      title: 'Favorites Mix',
      subtitle: favTracks.length ? `${favTracks.length} loved track${favTracks.length === 1 ? '' : 's'}` : 'Tap hearts to build your mix',
      list: favTracks.length ? favTracks : allTracks,
      cover: favTracks[0] ? coverFor(favTracks[0]) : heroCover
    }
  ];

  const applySlide = (idx) => {
    activeSlide = idx;
    const s = slides[idx] || slides[0];
    const tEl = containerEl.querySelector('#sw-hero-title');
    const subEl = containerEl.querySelector('#sw-hero-subtitle');
    const imgEl = containerEl.querySelector('#sw-hero-img');
    if (tEl) tEl.textContent = s.title;
    if (subEl) subEl.textContent = s.subtitle;
    if (imgEl && s.cover) imgEl.src = s.cover;
    containerEl.querySelectorAll('.sw-hero-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
  };

  containerEl.querySelectorAll('.sw-hero-dot').forEach((dot) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      applySlide(Number(dot.dataset.heroSlide) || 0);
    });
  });

  const playActiveSlide = () => player.playList(slides[activeSlide].list, 0);
  containerEl.querySelector('#home-play-btn')?.addEventListener('click', playActiveSlide);
  containerEl.querySelector('#home-hero-circle-play')?.addEventListener('click', playActiveSlide);
  containerEl.querySelector('#home-shuffle-btn')?.addEventListener('click', () => {
    player.playShuffled(slides[activeSlide].list);
    toast('Shuffling your music');
  });

  bindHorizontalTrackCards(containerEl.querySelector('#home-recent-cards'), allTracks);
  bindHorizontalTrackCards(containerEl.querySelector('#home-fav-cards'), favTracks);
  bindTrackRows(containerEl.querySelector('#home-played-list'), allTracks);
  bindAlbumCards(containerEl.querySelector('#home-albums-grid'), albumPreview, allTracks);
  bindAlbumCards(containerEl.querySelector('#home-artists-grid'), artistCards, allTracks);
  hydrateMissingCovers(recent, containerEl);
  player.refreshPlayingState();
}

// ----------------------------------------------------------------------------
// Library views
// ----------------------------------------------------------------------------

export async function renderView(viewName, containerEl, { tracks = [] } = {}) {
  if (!containerEl) return;

  const allTracks = await getMergedLibraryTracks(tracks);
  const favoritesSet = new Set(getFavorites());
  const importedCount = allTracks.filter((t) => t.isImported).length;

  let filteredTracks = allTracks;
  let sectionHeading = 'Library Songs';

  if (viewName === 'favorites') {
    sectionHeading = 'Favorite Songs';
    filteredTracks = allTracks.filter((t) => favoritesSet.has(t.id));
  } else if (viewName === 'most-played') {
    sectionHeading = 'Most Played';
    filteredTracks = getMostPlayedTracks(allTracks, 50);
  } else if (viewName === 'recently-played') {
    sectionHeading = 'Recently Played';
    const byId = new Map(allTracks.map((t) => [t.id, t]));
    filteredTracks = getRecentlyPlayed().map((s) => byId.get(s.id) || (s.src ? s : null)).filter(Boolean);
  } else if (viewName === 'recently-added') {
    sectionHeading = 'Recently Added';
  } else if (viewName === 'folders') {
    const folders = buildFolders(allTracks);
    containerEl.innerHTML = `
      <section class="content-section sw-seamless-enter">
        <div class="library-toolbar">
          <div>
            <h2 class="section-title">Folders</h2>
            <p class="library-count-badge">${folders.length} folder${folders.length === 1 ? '' : 's'}</p>
          </div>
          <div class="library-toolbar-actions">
            <button type="button" id="toolbar-scan-device-btn" class="btn btn-primary">Scan Device</button>
            <button type="button" id="toolbar-import-mp3-btn" class="btn btn-secondary">${ICON_IMPORT}<span>Import</span></button>
            <button type="button" id="toolbar-upload-btn" class="btn btn-secondary">${ICON_CLOUD}<span>Upload</span></button>
          </div>
        </div>
        ${folders.length ? renderFolderCards(folders) : renderTrackList([], favoritesSet, EMPTY_HINT)}
      </section>
    `;
    containerEl.querySelector('#toolbar-scan-device-btn')?.addEventListener('click', async () => {
      toast('Scanning device audio…');
      const res = await scanDeviceMediaStore({ force: true });
      toast(res.granted ? `Found ${res.tracks.length} device songs` : 'Audio permission denied');
      notifyLibraryChanged();
    });
    containerEl.querySelector('#toolbar-import-mp3-btn')?.addEventListener('click', openImportPicker);
    containerEl.querySelector('#toolbar-upload-btn')?.addEventListener('click', openCloudUpload);
    bindFolderCards(containerEl, folders, allTracks);
    return;
  } else if (viewName === 'genres') {
    const genres = buildGenres(allTracks);
    containerEl.innerHTML = `
      <section class="content-section sw-seamless-enter">
        <div class="library-toolbar">
          <div>
            <h2 class="section-title">Genres</h2>
            <p class="library-count-badge">${genres.length} genre${genres.length === 1 ? '' : 's'}</p>
          </div>
          <div class="library-toolbar-actions">
            <button type="button" id="toolbar-import-mp3-btn" class="btn btn-secondary">${ICON_IMPORT}<span>Import</span></button>
            <button type="button" id="toolbar-upload-btn" class="btn btn-secondary">${ICON_CLOUD}<span>Upload</span></button>
          </div>
        </div>
        ${genres.length ? renderAlbumCards(genres) : renderTrackList([], favoritesSet, EMPTY_HINT)}
      </section>
    `;
    containerEl.querySelector('#toolbar-import-mp3-btn')?.addEventListener('click', openImportPicker);
    containerEl.querySelector('#toolbar-upload-btn')?.addEventListener('click', openCloudUpload);
    bindAlbumCards(containerEl, genres, allTracks);
    return;
  } else if (viewName === 'artists') {
    sectionHeading = 'Artists & Songs';
    filteredTracks = [...allTracks].sort((a, b) =>
      String(a.artist || '').localeCompare(String(b.artist || ''))
    );
  } else if (viewName === 'albums') {
    sectionHeading = 'Albums';
  } else if (viewName === 'browse') {
    sectionHeading = 'All Songs';
  } else if (viewName === 'radio') {
    sectionHeading = 'Shuffle Mix';
    filteredTracks = [...allTracks];
    for (let i = filteredTracks.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [filteredTracks[i], filteredTracks[j]] = [filteredTracks[j], filteredTracks[i]];
    }
  }

  const allAlbums = buildAlbums(allTracks);
  const emptyMessage =
    viewName === 'favorites' ? 'Tap the heart on a song to add it to your favorites.'
      : viewName === 'recently-played' ? 'Songs you play will show up here.'
      : EMPTY_HINT;
  const showAlbums = viewName === 'albums';
  const playable = !showAlbums && filteredTracks.length > 0;
  const subtitle = showAlbums
    ? `${allAlbums.length} album${allAlbums.length === 1 ? '' : 's'}`
    : `${filteredTracks.length} song${filteredTracks.length === 1 ? '' : 's'}`;

  containerEl.innerHTML = `
    <section class="content-section">
      <div class="library-toolbar">
        <div>
          <h2 class="section-title">${escapeHtml(sectionHeading)}</h2>
          <p class="library-count-badge">${subtitle}</p>
        </div>
        <div class="library-toolbar-actions">
          ${playable ? `<button type="button" id="toolbar-play-btn" class="btn btn-primary">${ICON_PLAY}<span>Play</span></button>
          <button type="button" id="toolbar-shuffle-btn" class="btn btn-secondary">${ICON_SHUFFLE}<span>Shuffle</span></button>` : ''}
          <button type="button" id="toolbar-import-mp3-btn" class="btn btn-secondary">${ICON_IMPORT}<span>Import</span></button>
          <button type="button" id="toolbar-upload-btn" class="btn btn-secondary">${ICON_CLOUD}<span>Upload</span></button>
          ${viewName === 'recently-added' && importedCount > 0 ? '<button type="button" id="toolbar-clear-btn" class="btn btn-secondary">Remove all</button>' : ''}
        </div>
      </div>

      ${showAlbums ? renderAlbumCards(allAlbums) : renderTrackList(filteredTracks, favoritesSet, emptyMessage)}
    </section>
  `;

  containerEl.querySelector('#toolbar-import-mp3-btn')?.addEventListener('click', openImportPicker);
  containerEl.querySelector('#toolbar-upload-btn')?.addEventListener('click', openCloudUpload);
  containerEl.querySelector('#toolbar-play-btn')?.addEventListener('click', () => player.playList(filteredTracks, 0));
  containerEl.querySelector('#toolbar-shuffle-btn')?.addEventListener('click', () => {
    player.playShuffled(filteredTracks);
    toast('Shuffling');
  });
  containerEl.querySelector('#toolbar-clear-btn')?.addEventListener('click', () => removeAllImported(importedCount));

  // (The Favorites view re-renders itself via the 'soundwave:favoritechange' event in script.js.)
  bindTrackRows(containerEl, filteredTracks);
  bindAlbumCards(containerEl, allAlbums, allTracks);
  if (!showAlbums) hydrateMissingCovers(filteredTracks, containerEl);
  player.refreshPlayingState();
}

// ----------------------------------------------------------------------------
// Change cover image after upload / import
// ----------------------------------------------------------------------------

let pendingCoverTrackId = null;

function compressImageToDataUrl(file, maxSize = 420) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
          canvas.toBlob((blob) => resolve({ dataUrl, blob }), 'image/jpeg', 0.84);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Could not load selected image.'));
      img.src = String(reader.result || '');
    };
    reader.onerror = () => reject(new Error('Could not read selected image.'));
    reader.readAsDataURL(file);
  });
}

async function updateIndexedDbCover(trackId, blob) {
  if (!trackId || !(blob instanceof Blob)) return;
  try {
    const db = await openAudioDB();
    await new Promise((resolve) => {
      const tx = db.transaction('imported_tracks', 'readwrite');
      const store = tx.objectStore('imported_tracks');
      const getReq = store.get(trackId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec) {
          rec.coverBlob = blob;
          store.put(rec);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore if not in IndexedDB */ }
}

document.addEventListener('soundwave:changecover', (e) => {
  const trackId = e.detail?.trackId;
  const input = document.getElementById('change-cover-input');
  if (!trackId || !input) return;
  pendingCoverTrackId = trackId;
  input.value = '';
  input.click();
});

document.getElementById('change-cover-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const trackId = pendingCoverTrackId;
  pendingCoverTrackId = null;
  if (!file || !trackId) return;
  if (!file.type.startsWith('image/')) {
    toast('Please choose an image file.');
    return;
  }

  try {
    const { dataUrl, blob } = await compressImageToDataUrl(file, 420);
    forgetCover(trackId);
    saveCustomCover(trackId, dataUrl);
    await updateIndexedDbCover(trackId, blob);

    // Update currently playing cover immediately if this song is loaded
    const cur = player.getCurrentTrack();
    if (cur && cur.id === trackId) {
      cur.coverUrl = dataUrl;
      const pCover = document.getElementById('player-cover');
      const fpCover = document.getElementById('fp-cover');
      const fpMini = document.getElementById('fp-mini-cover');
      if (pCover) pCover.src = dataUrl;
      if (fpCover) fpCover.src = dataUrl;
      if (fpMini) fpMini.src = dataUrl;
    }

    toast('Cover image updated');
    document.dispatchEvent(new CustomEvent('soundwave:cloudchange'));
    notifyLibraryChanged();
  } catch (err) {
    console.warn('Could not update cover image:', err);
    toast('Could not update cover image.');
  }
});

document.addEventListener('click', () => {
  document.querySelectorAll('.track-dropdown:not(.hidden)').forEach((el) => {
    el.classList.add('hidden');
    el.closest('.track-row')?.classList.remove('menu-open');
    el.closest('.track-menu-wrap')?.querySelector('.track-dots-btn')?.setAttribute('aria-expanded', 'false');
  });
});
