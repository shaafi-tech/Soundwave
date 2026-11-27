// ============================================================================
// SoundWave — Advanced Playlists: Reorder, Export (.json / .m3u) & Import
// (js/playlist.js)
// ============================================================================

import { getMergedLibraryTracks, renderTrackList, bindTrackRows } from './library.js?v=pro35';
import { getFavorites } from './storage.js?v=pro35';
import * as player from './player.js?v=pro35';
import { escapeHtml, toast } from './util.js?v=pro35';

const PLAYLISTS_KEY = 'soundwave_playlists_v1';
const LEGACY_DEMO_IDS = ['spatial-chill', 'midnight-synth', 'lossless-essentials'];
const LEGACY_DEMO_TRACKS = ['track-01', 'track-02', 'track-03', 'track-04'];

let catalog = [];
let sidebarEl = null;
let activeId = null;

function loadPlaylists() {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePlaylists(list) {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Could not save playlists:', err);
  }
}

export function getPlaylists() { return loadPlaylists(); }
export function getPlaylist(id) { return loadPlaylists().find((p) => p.id === id) || null; }
export function getActivePlaylistId() { return activeId; }

export function renderSidebar() {
  if (!sidebarEl) return;
  const lists = loadPlaylists();
  if (!lists.length) {
    sidebarEl.innerHTML = '<li class="nav-item"><span class="sidebar-empty-hint">Tap + to make a playlist</span></li>';
    return;
  }
  sidebarEl.innerHTML = lists
    .map(
      (p) => `
        <li class="nav-item">
          <button type="button" class="nav-link${p.id === activeId ? ' active' : ''}" data-playlist-id="${escapeHtml(p.id)}">
            <span class="playlist-dot"></span>
            <span>${escapeHtml(p.name)}</span>
          </button>
        </li>`
    )
    .join('');
}

export function initPlaylists({ tracks = [], sidebarListEl = null } = {}) {
  catalog = tracks;
  sidebarEl = sidebarListEl;
  try {
    const cleaned = loadPlaylists().filter(
      (p) => !(LEGACY_DEMO_IDS.includes(p.id) && (p.trackIds || []).every((id) => LEGACY_DEMO_TRACKS.includes(id)))
    );
    if (localStorage.getItem(PLAYLISTS_KEY) !== null) savePlaylists(cleaned);
  } catch { /* storage unavailable */ }
  renderSidebar();
}

export function createPlaylist({ name, description = '', trackIds = [] } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;

  const playlist = {
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    description: String(description || '').trim(),
    trackIds: Array.isArray(trackIds) ? [...new Set(trackIds)] : []
  };
  const list = loadPlaylists();
  list.push(playlist);
  savePlaylists(list);
  renderSidebar();
  return playlist;
}

export function deletePlaylist(id) {
  savePlaylists(loadPlaylists().filter((p) => p.id !== id));
  if (activeId === id) activeId = null;
  renderSidebar();
  document.dispatchEvent(new CustomEvent('soundwave:playlistdeleted', { detail: { id } }));
}

export function addTrackToPlaylist(playlistId, trackId) {
  const list = loadPlaylists();
  const pl = list.find((p) => p.id === playlistId);
  if (!pl || pl.trackIds.includes(trackId)) return false;
  pl.trackIds.push(trackId);
  savePlaylists(list);
  return true;
}

export function removeTrackFromPlaylist(playlistId, trackId) {
  const list = loadPlaylists();
  const pl = list.find((p) => p.id === playlistId);
  if (!pl) return false;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  savePlaylists(list);
  return true;
}

export function movePlaylistTrack(playlistId, fromIndex, toIndex) {
  const list = loadPlaylists();
  const pl = list.find((p) => p.id === playlistId);
  if (!pl || fromIndex < 0 || toIndex < 0 || fromIndex >= pl.trackIds.length || toIndex >= pl.trackIds.length) {
    return false;
  }
  const [moved] = pl.trackIds.splice(fromIndex, 1);
  pl.trackIds.splice(toIndex, 0, moved);
  savePlaylists(list);
  return true;
}

export function exportPlaylistData(playlist, allTracks = [], format = 'json') {
  if (!playlist) return;
  const resolved = playlist.trackIds.map((id) => allTracks.find((t) => t.id === id)).filter(Boolean);
  let content = '';
  let mime = 'application/json';
  let ext = 'json';

  if (format === 'm3u') {
    const lines = ['#EXTM3U', `#PLAYLIST:${playlist.name}`];
    resolved.forEach((t) => {
      lines.push(`#EXTINF:${Math.round(Number(t.duration) || -1)},${t.artist || 'Unknown'} - ${t.title || 'Untitled'}`);
      lines.push(t.nativeUri || t.src || `${t.artist || 'Unknown'} - ${t.title || 'Untitled'}.mp3`);
    });
    content = lines.join('\n');
    mime = 'audio/x-mpegurl';
    ext = 'm3u';
  } else {
    content = JSON.stringify({
      app: 'SoundWave',
      version: 1,
      name: playlist.name,
      description: playlist.description || '',
      tracks: resolved.map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album }))
    }, null, 2);
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${playlist.name.replace(/[^a-z0-9_-]+/gi, '_') || 'playlist'}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`Exported "${playlist.name}" (${ext.toUpperCase()})`);
}

export async function importPlaylistFile(file, allTracks = []) {
  const text = await file.text();
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'Imported Playlist';

  if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.tracks) ? parsed.tracks : [];
    const matchedIds = [];
    items.forEach((item) => {
      const byId = allTracks.find((t) => t.id === item.id);
      if (byId) { matchedIds.push(byId.id); return; }
      const byName = allTracks.find(
        (t) => String(t.title || '').toLowerCase() === String(item.title || '').toLowerCase()
      );
      if (byName) matchedIds.push(byName.id);
    });
    return createPlaylist({
      name: parsed?.name || baseName,
      description: parsed?.description || '',
      trackIds: matchedIds
    });
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const matchedIds = [];
  lines.forEach((line) => {
    if (line.startsWith('#EXTINF:')) {
      const label = line.split(',').slice(1).join(',').trim().toLowerCase();
      const hit = allTracks.find((t) => {
        const title = String(t.title || '').toLowerCase();
        return title && (label.includes(title) || title.includes(label));
      });
      if (hit) matchedIds.push(hit.id);
    }
  });
  return createPlaylist({ name: baseName, trackIds: matchedIds });
}

export async function openPlaylistView(playlistId, containerEl) {
  if (!containerEl) return;
  activeId = playlistId;
  renderSidebar();

  const playlist = getPlaylist(playlistId);
  if (!playlist) {
    containerEl.innerHTML = '<section class="content-section"><p class="library-count-badge">This playlist no longer exists.</p></section>';
    return;
  }

  const allTracks = await getMergedLibraryTracks(catalog);
  if (activeId !== playlistId) return;

  const favorites = new Set(getFavorites());
  const playlistTracks = playlist.trackIds
    .map((id) => allTracks.find((t) => t.id === id))
    .filter(Boolean);

  const orderRows = playlistTracks
    .map((t, idx) => `
      <div class="playlist-manage-row">
        <div class="playlist-manage-meta">
          <span class="track-title">${idx + 1}. ${escapeHtml(t.title || 'Untitled Track')}</span>
          <span class="track-artist">${escapeHtml(t.artist || 'Unknown Artist')}</span>
        </div>
        <div class="playlist-order-btns">
          <button type="button" class="icon-btn-sm" data-pl-up="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
          <button type="button" class="icon-btn-sm" data-pl-down="${idx}" ${idx === playlistTracks.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
        </div>
      </div>`)
    .join('');

  const manageRows = allTracks
    .map((t) => {
      const inList = playlist.trackIds.includes(t.id);
      return `
        <div class="playlist-manage-row">
          <div class="playlist-manage-meta">
            <span class="track-title">${escapeHtml(t.title || 'Untitled Track')}</span>
            <span class="track-artist">${escapeHtml(t.artist || 'Unknown Artist')}</span>
          </div>
          <button type="button" class="btn btn-secondary playlist-toggle-btn" data-toggle-track="${escapeHtml(t.id)}">
            ${inList ? 'Remove' : 'Add'}
          </button>
        </div>`;
    })
    .join('');

  containerEl.innerHTML = `
    <section class="content-section sw-seamless-enter">
      <div class="library-toolbar">
        <div>
          <h2 class="section-title">${escapeHtml(playlist.name)}</h2>
          <p class="library-count-badge">${escapeHtml(playlist.description ? playlist.description + ' • ' : '')}${playlistTracks.length} song${playlistTracks.length === 1 ? '' : 's'}</p>
        </div>
        <div class="playlist-actions">
          <button type="button" id="pl-play-btn" class="btn btn-primary">Play</button>
          <button type="button" id="pl-shuffle-btn" class="btn btn-secondary">Shuffle</button>
          <button type="button" id="pl-export-json-btn" class="btn btn-secondary">Export JSON</button>
          <button type="button" id="pl-export-m3u-btn" class="btn btn-secondary">Export M3U</button>
          <button type="button" id="pl-import-btn" class="btn btn-secondary">Import</button>
          <button type="button" id="pl-delete-btn" class="btn btn-secondary">Delete</button>
          <input type="file" id="pl-import-input" accept=".json,.m3u,.m3u8,application/json" class="hidden">
        </div>
      </div>

      ${renderTrackList(playlistTracks, favorites, 'This playlist is empty. Add songs from the list below.')}

      ${playlistTracks.length > 1 ? `
        <div class="section-header" style="margin-top:24px">
          <h2 class="section-title">Reorder Tracks</h2>
        </div>
        <div class="playlist-manage-list">${orderRows}</div>
      ` : ''}

      <div class="section-header" style="margin-top:28px">
        <h2 class="section-title">Add or Remove Songs</h2>
      </div>
      <div class="playlist-manage-list">${manageRows || '<p class="library-count-badge">No songs in your library yet.</p>'}</div>
    </section>
  `;

  bindTrackRows(containerEl, playlistTracks);
  player.refreshPlayingState();

  containerEl.querySelector('#pl-play-btn')?.addEventListener('click', () => {
    if (!playlistTracks.length) return toast('Add some songs first');
    player.playList(playlistTracks, 0);
  });
  containerEl.querySelector('#pl-shuffle-btn')?.addEventListener('click', () => {
    if (!playlistTracks.length) return toast('Add some songs first');
    player.playShuffled(playlistTracks);
  });
  containerEl.querySelector('#pl-export-json-btn')?.addEventListener('click', () => exportPlaylistData(playlist, allTracks, 'json'));
  containerEl.querySelector('#pl-export-m3u-btn')?.addEventListener('click', () => exportPlaylistData(playlist, allTracks, 'm3u'));
  containerEl.querySelector('#pl-import-btn')?.addEventListener('click', () => containerEl.querySelector('#pl-import-input')?.click());
  containerEl.querySelector('#pl-import-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const created = await importPlaylistFile(file, allTracks);
      if (created) {
        toast(`Imported playlist "${created.name}" (${created.trackIds.length} songs matched)`);
        openPlaylistView(created.id, containerEl);
      }
    } catch {
      toast('Could not import playlist file.');
    }
  });
  containerEl.querySelector('#pl-delete-btn')?.addEventListener('click', () => {
    if (window.confirm(`Delete playlist "${playlist.name}"?`)) {
      deletePlaylist(playlistId);
      toast('Playlist deleted');
    }
  });

  containerEl.querySelectorAll('[data-pl-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.plUp);
      if (movePlaylistTrack(playlistId, idx, idx - 1)) openPlaylistView(playlistId, containerEl);
    });
  });
  containerEl.querySelectorAll('[data-pl-down]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.plDown);
      if (movePlaylistTrack(playlistId, idx, idx + 1)) openPlaylistView(playlistId, containerEl);
    });
  });

  containerEl.querySelectorAll('[data-toggle-track]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const trackId = btn.dataset.toggleTrack;
      const current = getPlaylist(playlistId);
      if (!current) return;
      if (current.trackIds.includes(trackId)) removeTrackFromPlaylist(playlistId, trackId);
      else addTrackToPlaylist(playlistId, trackId);
      openPlaylistView(playlistId, containerEl);
    });
  });
}
