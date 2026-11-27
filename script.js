// ============================================================================
// SoundWave — Main Application Entry Point & Controller (script.js)
// Coordinates UI state, navigation, modals, and modular JS services
// ============================================================================

import * as storage from './js/storage.js?v=pro35';
import * as player from './js/player.js?v=pro35';
import * as library from './js/library.js?v=pro35';
import * as playlist from './js/playlist.js?v=pro35';
import * as search from './js/search.js?v=pro35';
import * as visualizer from './js/visualizer.js?v=pro35';
import * as fullplayer from './js/fullplayer.js?v=pro35';
import * as account from './js/account.js?v=pro35';
import * as discover from './js/discover.js?v=pro35';
import * as eq from './js/equalizer.js?v=pro35';
import * as stats from './js/stats.js?v=pro35';
import * as pro from './js/pro-features.js?v=pro35';
import * as offline from './js/offline.js?v=pro35';
import * as network from './js/network.js?v=pro35';
import { hashString } from './js/util.js?v=pro35';

// Songs shipped WITH the website (optional). The songs you import with the Import button
// are stored on the visitor's own device; see music/README.txt for site-wide songs.
let CATALOG_TRACKS = [];

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|webm|mp4|3gp|amr)$/i;

const VIEW_TITLES = {
  'listen-now': 'SoundWave',
  'browse': 'Browse',
  'radio': 'Radio',
  'most-played': 'Most Played',
  'recently-played': 'Recently Played',
  'most-played': 'Most Played',
  'recently-played': 'Recently Played',
  'recently-added': 'Recently Added',
  'folders': 'Folders',
  'genres': 'Genres',
  'artists': 'Artists',
  'albums': 'Albums',
  'favorites': 'Favorites'
};

// Application UI state
const state = {
  currentView: 'listen-now',
  history: ['listen-now'],
  historyIndex: 0,
  activeRightTab: 'queue',
  searchActive: false
};

// Cached DOM references
const dom = {
  sidebar: document.getElementById('sidebar'),
  sidebarOverlay: document.getElementById('sidebar-overlay'),
  openSidebarBtn: document.getElementById('open-sidebar-btn'),
  closeSidebarBtn: document.getElementById('close-sidebar-btn'),
  brandLogo: document.getElementById('brand-logo'),

  navLinks: Array.from(document.querySelectorAll('.sidebar .nav-link[data-view]')),
  navBackBtn: document.getElementById('nav-back-btn'),
  navForwardBtn: document.getElementById('nav-forward-btn'),
  pageTitle: document.getElementById('page-title'),

  discoveryView: document.getElementById('discovery-view'),
  dynamicLibraryView: document.getElementById('dynamic-library-view'),
  searchResultsSection: document.getElementById('search-results-section'),
  searchResultsGrid: document.getElementById('search-results-grid'),
  searchResultsCount: document.getElementById('search-results-count'),

  searchInput: document.getElementById('global-search-input'),
  clearSearchBtn: document.getElementById('clear-search-btn'),

  rightPanel: document.getElementById('right-panel'),
  closeRightPanelBtn: document.getElementById('close-right-panel-btn'),
  visualizerToggleBtn: document.getElementById('visualizer-toggle-btn'),
  queueToggleBtn: document.getElementById('queue-toggle-btn'),
  panelTabs: Array.from(document.querySelectorAll('.panel-tab')),
  panelQueue: document.getElementById('panel-queue'),
  panelVisualizer: document.getElementById('panel-visualizer'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  queueList: document.getElementById('queue-list'),

  playlistModal: document.getElementById('playlist-modal'),
  createPlaylistBtn: document.getElementById('create-playlist-btn'),
  closePlaylistModal: document.getElementById('close-playlist-modal'),
  cancelPlaylistBtn: document.getElementById('cancel-playlist-btn'),
  createPlaylistForm: document.getElementById('create-playlist-form'),
  newPlaylistName: document.getElementById('new-playlist-name'),
  newPlaylistDesc: document.getElementById('new-playlist-desc'),
  sidebarPlaylistList: document.getElementById('sidebar-playlist-list'),

  toastContainer: document.getElementById('toast-container'),
  cloudUploadBtn: document.getElementById('cloud-upload-btn'),

  bulkImportBtn: document.getElementById('bulk-import-btn'),
  bulkImportInput: document.getElementById('bulk-import-input'),
  importProgressBanner: document.getElementById('bulk-import-progress'),
  importProgressText: document.getElementById('import-progress-text'),
  importProgressPercent: document.getElementById('import-progress-percent'),
  importProgressBar: document.getElementById('import-progress-bar'),
  cancelImportBtn: document.getElementById('cancel-import-btn')
};

// ============================================================================
// Toast & Mobile Drawer Helpers
// ============================================================================

export function showToast(message, duration = 2400) {
  if (!dom.toastContainer) return;
  // Keep at most 3 toasts on screen
  while (dom.toastContainer.children.length >= 3) {
    dom.toastContainer.firstElementChild.remove();
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, duration);
}

function openMobileSidebar() {
  dom.sidebar?.classList.add('open');
  dom.sidebarOverlay?.classList.add('active');
}

function closeMobileSidebar() {
  dom.sidebar?.classList.remove('open');
  dom.sidebarOverlay?.classList.remove('active');
}

// ============================================================================
// Navigation & View Routing
// ============================================================================

function updateHistoryButtons() {
  if (dom.navBackBtn) dom.navBackBtn.disabled = state.historyIndex <= 0;
  if (dom.navForwardBtn) dom.navForwardBtn.disabled = state.historyIndex >= state.history.length - 1;
}

function setActiveBottomNav(tabName) {
  document.querySelectorAll('#mobile-bottom-nav .bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bottomNav === tabName);
  });
}

function setActiveNavItem(viewOrPlaylistId) {
  document.querySelectorAll('.sidebar .nav-link').forEach((btn) => {
    const matchesView = btn.dataset.view === viewOrPlaylistId;
    const matchesPlaylist = btn.dataset.playlistId === viewOrPlaylistId;
    btn.classList.toggle('active', Boolean(matchesView || matchesPlaylist));
  });
  if (state.searchActive) {
    setActiveBottomNav('search');
  } else if (viewOrPlaylistId === 'listen-now') {
    setActiveBottomNav('home');
  } else if (String(viewOrPlaylistId || '').startsWith('pl-')) {
    setActiveBottomNav('playlists');
  } else {
    setActiveBottomNav('library');
  }
}

// Single place that decides which main panel is visible.
function applyViewVisibility() {
  const onDiscovery = state.currentView === 'listen-now';
  const showDiscovery = !state.searchActive && onDiscovery;
  const showDynamic = !state.searchActive && !onDiscovery;

  dom.discoveryView?.classList.toggle('hidden', !showDiscovery);
  dom.discoveryView?.classList.toggle('active', showDiscovery);
  dom.dynamicLibraryView?.classList.toggle('hidden', !showDynamic);
  dom.dynamicLibraryView?.classList.toggle('active', showDynamic);
  dom.searchResultsSection?.classList.toggle('hidden', !state.searchActive);
}

function clearSearch() {
  state.searchActive = false;
  searchSeq += 1;
  clearTimeout(searchTimer);
  if (dom.searchInput) dom.searchInput.value = '';
  dom.clearSearchBtn?.classList.add('hidden');
}

export function navigateTo(viewName, { recordHistory = true, titleOverride = null } = {}) {
  const isPlaylist = viewName.startsWith('playlist:');
  const playlistId = isPlaylist ? viewName.slice('playlist:'.length) : null;

  state.currentView = viewName;
  setActiveNavItem(isPlaylist ? playlistId : viewName);

  if (dom.pageTitle) {
    const playlistName = isPlaylist ? playlist.getPlaylist(playlistId)?.name : null;
    dom.pageTitle.textContent = titleOverride || playlistName || VIEW_TITLES[viewName] || 'SoundWave';
  }

  clearSearch();
  applyViewVisibility();

  if (isPlaylist) {
    playlist.openPlaylistView(playlistId, dom.dynamicLibraryView);
  } else if (viewName === 'listen-now') {
    library.renderHome(dom.discoveryView, { tracks: CATALOG_TRACKS }).then(() => discover.renderDiscover(dom.discoveryView));
  } else {
    library.renderView(viewName, dom.dynamicLibraryView, { tracks: CATALOG_TRACKS });
  }

  if (recordHistory) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    if (state.history[state.history.length - 1] !== viewName) {
      state.history.push(viewName);
      state.historyIndex = state.history.length - 1;
    }
  }

  updateHistoryButtons();
  closeMobileSidebar();
}

function goBack() {
  if (state.historyIndex > 0) {
    state.historyIndex -= 1;
    navigateTo(state.history[state.historyIndex], { recordHistory: false });
  }
}

function goForward() {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex += 1;
    navigateTo(state.history[state.historyIndex], { recordHistory: false });
  }
}

// ============================================================================
// Right Panel (Queue / Visualizer — lyrics live in the full-screen player)
// ============================================================================

function openRightPanel(tabName = 'queue') {
  dom.rightPanel?.classList.remove('hidden');
  switchRightPanelTab(tabName);
}

function closeRightPanel() {
  dom.rightPanel?.classList.add('hidden');
  visualizer.stop();
}

function toggleRightPanel(tabName) {
  const isHidden = dom.rightPanel?.classList.contains('hidden');
  if (!isHidden && state.activeRightTab === tabName) {
    closeRightPanel();
  } else {
    openRightPanel(tabName);
  }
}

function switchRightPanelTab(tabName) {
  state.activeRightTab = tabName;

  dom.panelTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === tabName);
  });

  dom.panelQueue?.classList.toggle('hidden', tabName !== 'queue');
  dom.panelQueue?.classList.toggle('active', tabName === 'queue');

  dom.panelVisualizer?.classList.toggle('hidden', tabName !== 'visualizer');
  dom.panelVisualizer?.classList.toggle('active', tabName === 'visualizer');

  if (tabName === 'visualizer') {
    visualizer.start();
  } else {
    visualizer.stop();
  }
}

// ============================================================================
// Playlist Modal & Favorites Sync
// ============================================================================

function openPlaylistModal() {
  if (!dom.playlistModal) return;
  dom.createPlaylistForm?.reset();
  if (typeof dom.playlistModal.showModal === 'function') {
    dom.playlistModal.showModal();
  } else {
    dom.playlistModal.setAttribute('open', '');
  }
  dom.newPlaylistName?.focus();
}

function closePlaylistModal() {
  if (!dom.playlistModal) return;
  if (typeof dom.playlistModal.close === 'function') {
    dom.playlistModal.close();
  } else {
    dom.playlistModal.removeAttribute('open');
  }
}

function handleCreatePlaylistSubmit(event) {
  event.preventDefault();
  const name = dom.newPlaylistName?.value.trim();
  const description = dom.newPlaylistDesc?.value.trim() || '';
  if (!name) return;

  // playlist.createPlaylist also refreshes the sidebar list.
  const created = playlist.createPlaylist({ name, description });
  closePlaylistModal();
  if (!created) return;

  showToast(`Created playlist "${name}"`);
  navigateTo(`playlist:${created.id}`);
}

function syncFavoriteButtons() {
  const favorites = storage.getFavorites();
  document.querySelectorAll('.like-track-btn[data-track-id]').forEach((btn) => {
    const isLiked = favorites.includes(btn.dataset.trackId);
    btn.classList.toggle('liked', isLiked);
    btn.setAttribute('aria-pressed', String(isLiked));
  });
}

async function refreshCurrentView() {
  if (state.searchActive) return;

  if (state.currentView === 'listen-now') {
    await library.renderHome(dom.discoveryView, { tracks: CATALOG_TRACKS });
    discover.renderDiscover(dom.discoveryView);
    return;
  }
  if (dom.dynamicLibraryView?.classList.contains('hidden')) return;

  if (state.currentView.startsWith('playlist:')) {
    await playlist.openPlaylistView(state.currentView.slice('playlist:'.length), dom.dynamicLibraryView);
  } else {
    await library.renderView(state.currentView, dom.dynamicLibraryView, { tracks: CATALOG_TRACKS });
  }
}

async function onLibraryChanged() {
  const all = await library.getMergedLibraryTracks(CATALOG_TRACKS);
  player.primeQueue(all);
  await refreshCurrentView();
  const query = dom.searchInput?.value.trim();
  if (state.searchActive && query) performSearch(query);
}

// ============================================================================
// ID3v2 / ID3v1 Metadata + APIC Artwork Parser & Bulk MP3 Importer
// ============================================================================

let importCancelled = false;
let isImporting = false;

function stripExtension(filename = '') {
  return filename.replace(/\.[^/.]+$/, '');
}

function cleanFilenameTitle(filename = '') {
  return stripExtension(filename).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled Track';
}

// "Artist - Song.mp3" -> { artist, title }. Anything else becomes just a title.
function parseFilename(filename = '') {
  const base = cleanFilenameTitle(filename);
  const m = base.match(/^(.{1,80}?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

function decodeSyncsafeInt(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function decodeFrameSize(bytes, offset, majorVersion) {
  if (majorVersion === 4) {
    return decodeSyncsafeInt(bytes, offset);
  }
  return (
    ((bytes[offset] & 0xff) << 24) |
    ((bytes[offset + 1] & 0xff) << 16) |
    ((bytes[offset + 2] & 0xff) << 8) |
    (bytes[offset + 3] & 0xff)
  );
}

function decodeTextFramePayload(bytes, start, end) {
  if (start >= end) return '';
  const encoding = bytes[start];
  const slice = bytes.subarray(start + 1, end);

  try {
    let text;
    if (encoding === 0) {
      text = new TextDecoder('iso-8859-1').decode(slice);
    } else if (encoding === 1) {
      // UTF-16 with BOM — the BOM tells us the byte order
      let label = 'utf-16le';
      let data = slice;
      if (slice[0] === 0xfe && slice[1] === 0xff) {
        label = 'utf-16be';
        data = slice.subarray(2);
      } else if (slice[0] === 0xff && slice[1] === 0xfe) {
        data = slice.subarray(2);
      }
      text = new TextDecoder(label).decode(data);
    } else if (encoding === 2) {
      text = new TextDecoder('utf-16be').decode(slice);
    } else {
      text = new TextDecoder('utf-8').decode(slice);
    }
    // Frames can hold several null-separated values; keep the first one.
    return text.split('\0')[0].trim();
  } catch {
    let out = '';
    for (let i = 0; i < slice.length; i += 1) {
      if (slice[i] !== 0) out += String.fromCharCode(slice[i]);
    }
    return out.trim();
  }
}

function parseApicFrame(bytes, start, end) {
  if (end - start < 5) return null;
  const encoding = bytes[start];
  let cursor = start + 1;

  let mimeEnd = cursor;
  while (mimeEnd < end && bytes[mimeEnd] !== 0) mimeEnd += 1;
  const mimeType =
    new TextDecoder('iso-8859-1').decode(bytes.subarray(cursor, mimeEnd)).trim() || 'image/jpeg';
  cursor = mimeEnd + 1;

  if (cursor >= end) return null;
  cursor += 1;

  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < end) {
      if (bytes[cursor] === 0 && bytes[cursor + 1] === 0) {
        cursor += 2;
        break;
      }
      cursor += 2;
    }
  } else {
    while (cursor < end && bytes[cursor] !== 0) cursor += 1;
    cursor += 1;
  }

  if (cursor >= end) return null;
  const imgBytes = bytes.subarray(cursor, end);
  if (!imgBytes.length) return null;

  return new Blob([imgBytes], { type: mimeType });
}

const V22_FRAME_MAP = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TCO: 'TCON' };

function extractId3Metadata(bytes, tail, filename) {
  const parsedName = parseFilename(filename);
  const fallbackTitle = parsedName.title;
  const meta = {
    title: fallbackTitle,
    artist: 'Unknown Artist',
    album: 'Local Library',
    genre: 'General',
    coverBlob: null
  };

  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const majorVersion = bytes[3];
    const flags = bytes[5];
    const tagSize = decodeSyncsafeInt(bytes, 6);
    const tagEnd = Math.min(bytes.length, 10 + tagSize);
    const isV22 = majorVersion === 2;
    const idLen = isV22 ? 3 : 4;
    const headerLen = isV22 ? 6 : 10;
    const latin1 = new TextDecoder('iso-8859-1');

    let offset = 10;
    if (!isV22 && flags & 0x40 && offset + 4 <= tagEnd) {
      const extSize =
        majorVersion === 4
          ? decodeSyncsafeInt(bytes, offset)
          : 4 + ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
      offset += Math.max(4, extSize);
    }

    while (offset + headerLen <= tagEnd) {
      const rawId = latin1.decode(bytes.subarray(offset, offset + idLen));
      if (!new RegExp(`^[A-Z0-9]{${idLen}}$`).test(rawId)) break;

      const frameSize = isV22
        ? (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
        : decodeFrameSize(bytes, offset + 4, majorVersion);
      if (frameSize <= 0 || offset + headerLen + frameSize > tagEnd) break;

      const frameId = isV22 ? V22_FRAME_MAP[rawId] || rawId : rawId;
      const frameStart = offset + headerLen;
      const frameEnd = frameStart + frameSize;

      if (frameId === 'TIT2') {
        const val = decodeTextFramePayload(bytes, frameStart, frameEnd);
        if (val) meta.title = val;
      } else if (frameId === 'TPE1') {
        const val = decodeTextFramePayload(bytes, frameStart, frameEnd);
        if (val) meta.artist = val;
      } else if (frameId === 'TALB') {
        const val = decodeTextFramePayload(bytes, frameStart, frameEnd);
        if (val) meta.album = val;
      } else if (frameId === 'TCON') {
        const val = decodeTextFramePayload(bytes, frameStart, frameEnd).replace(/^\(\d+\)/, '').trim();
        if (val) meta.genre = val;
      } else if (frameId === 'APIC' && !meta.coverBlob) {
        const artBlob = parseApicFrame(bytes, frameStart, frameEnd);
        if (artBlob) meta.coverBlob = artBlob;
      }

      offset = frameEnd;
    }
  }

  // ID3v1 fallback (last 128 bytes of the file)
  if (tail && tail.length === 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
    const dec = new TextDecoder('iso-8859-1');
    const clean = (str) => str.replace(/\0+$/g, '').trim();
    const v1Title = clean(dec.decode(tail.subarray(3, 33)));
    const v1Artist = clean(dec.decode(tail.subarray(33, 63)));
    const v1Album = clean(dec.decode(tail.subarray(63, 93)));

    if (meta.title === fallbackTitle && v1Title) meta.title = v1Title;
    if (meta.artist === 'Unknown Artist' && v1Artist) meta.artist = v1Artist;
    if (meta.album === 'Local Library' && v1Album) meta.album = v1Album;
  }

  // No tags at all? Use "Artist - Title" from the file name when present.
  if (meta.title === fallbackTitle && meta.artist === 'Unknown Artist' && parsedName.artist) {
    meta.artist = parsedName.artist;
  }

  return meta;
}

// Reads only the tag area at the start/end of the file — never the whole song.
async function readMetadata(file) {
  const head10 = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let head = head10;
  if (head10.length >= 10 && head10[0] === 0x49 && head10[1] === 0x44 && head10[2] === 0x33) {
    const tagEnd = Math.min(file.size, 10 + decodeSyncsafeInt(head10, 6), 24 * 1024 * 1024);
    head = new Uint8Array(await file.slice(0, tagEnd).arrayBuffer());
  }
  let tail = null;
  if (file.size >= 128) tail = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
  return extractId3Metadata(head, tail, file.name);
}

// Embedded album art can be several MB. Shrink it so hundreds of songs stay light.
async function makeThumbnail(blob, maxSize = 400) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return out && out.size < blob.size ? out : blob;
  } catch {
    return null; // unreadable image: the generated cover is used instead
  }
}

function guessMime(name = '') {
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
    webm: 'audio/webm', '3gp': 'audio/3gpp', amr: 'audio/amr'
  };
  return map[ext] || 'audio/mpeg';
}

// Confirms the browser can actually decode the file and reads its length.
function probeAudio(blob) {
  return new Promise((resolve) => {
    const tempAudio = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tempAudio.removeAttribute('src');
      tempAudio.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    // A very slow device shouldn't block the import: accept the file, length unknown.
    const timer = setTimeout(() => finish({ ok: true, duration: 0 }), 6000);

    tempAudio.preload = 'metadata';
    tempAudio.onloadedmetadata = () => {
      const d = tempAudio.duration;
      finish({ ok: true, duration: Number.isFinite(d) && d > 0 ? Math.round(d) : 0 });
    };
    tempAudio.onerror = () => finish({ ok: false, duration: 0 });
    tempAudio.src = url;
  });
}

function buildTrackFingerprint(file, meta) {
  const normalizedTitle = String(meta.title || '').trim().toLowerCase();
  const normalizedArtist = String(meta.artist || '').trim().toLowerCase();
  return `${file.size}::${file.lastModified || 0}::${normalizedTitle}::${normalizedArtist}`;
}

function updateImportProgress(current, total, statusText) {
  if (!dom.importProgressBanner) return;
  dom.importProgressBanner.classList.remove('hidden');
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  if (dom.importProgressText) dom.importProgressText.textContent = statusText;
  if (dom.importProgressPercent) dom.importProgressPercent.textContent = `${pct}%`;
  if (dom.importProgressBar) dom.importProgressBar.style.width = `${pct}%`;

  const barTrack = dom.importProgressBanner.querySelector('[role="progressbar"]');
  if (barTrack) barTrack.setAttribute('aria-valuenow', String(pct));
}

async function handleBulkMp3Import(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name)
  );

  if (!files.length) {
    showToast('No audio files selected.');
    return;
  }

  if (isImporting) {
    showToast('An import is already in progress.');
    return;
  }

  isImporting = true;
  importCancelled = false;

  let importedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  const unsupported = [];

  try {
    let existingFingerprints = new Set();
    try {
      existingFingerprints = await storage.getAllFingerprints();
    } catch (err) {
      console.warn('Could not read existing fingerprints:', err);
    }

    updateImportProgress(0, files.length, `Importing 0 / ${files.length} songs...`);

    for (let i = 0; i < files.length; i += 1) {
      if (importCancelled) {
        showToast(`Import stopped (${importedCount} imported).`);
        break;
      }

      const file = files[i];
      updateImportProgress(i, files.length, `Reading ${i + 1} / ${files.length}: ${file.name}`);

      try {
        const meta = await readMetadata(file);
        const fingerprint = buildTrackFingerprint(file, meta);

        if (existingFingerprints.has(fingerprint)) {
          duplicateCount += 1;
          updateImportProgress(i + 1, files.length, `Skipped duplicate (${i + 1}/${files.length}): ${meta.title}`);
          continue;
        }

        const audioBlob = file.slice(0, file.size, file.type || guessMime(file.name));
        const probe = await probeAudio(audioBlob);
        if (!probe.ok) {
          errorCount += 1;
          unsupported.push(file.name);
          continue;
        }

        const coverBlob = meta.coverBlob ? await makeThumbnail(meta.coverBlob) : null;
        const trackId = `local-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;

        const record = {
          id: trackId,
          fingerprint,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          genre: meta.genre || 'General',
          folderName: (file.webkitRelativePath ? file.webkitRelativePath.split('/')[0] : 'Imported Songs'),
          albumId: 'local-library',
          duration: probe.duration,
          coverBlob,
          cover: null,
          lyrics: [],
          addedAt: Date.now() + i
        };

        await storage.saveImportedTrack(record, audioBlob);

        existingFingerprints.add(fingerprint);
        importedCount += 1;
        updateImportProgress(i + 1, files.length, `Imported ${importedCount} (${i + 1}/${files.length}): ${meta.title}`);
      } catch (err) {
        if (err && err.name === 'ConstraintError') {
          duplicateCount += 1; // same song already stored
        } else if (err && err.name === 'QuotaExceededError') {
          errorCount += 1;
          showToast('Storage is full — free some space and try again.', 4500);
          break;
        } else {
          console.error('Error importing song:', file.name, err);
          errorCount += 1;
        }
      }

      // Let the UI breathe between files (keeps phones responsive).
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    isImporting = false;
  }

  if (unsupported.length) console.warn('These files are not playable in this browser:', unsupported);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary =
    `Imported ${plural(importedCount, 'song')}` +
    (duplicateCount ? ` • ${plural(duplicateCount, 'duplicate')} skipped` : '') +
    (errorCount ? ` • ${errorCount} couldn't be read` : '');

  updateImportProgress(files.length, files.length, summary);
  showToast(summary, 4200);

  if (importedCount > 0) storage.requestPersistence();
  await onLibraryChanged();
}


// ============================================================================
// Search (debounced)
// ============================================================================

let searchTimer = null;
let searchSeq = 0;

async function performSearch(query) {
  const seq = (searchSeq += 1);
  const allTracks = await library.getMergedLibraryTracks(CATALOG_TRACKS);
  if (seq !== searchSeq || !state.searchActive) return; // a newer keystroke / cleared search won

  // 1) Instant results from the library (IndexedDB + Appwrite + shipped songs)
  const local = search.runSearch(query, {
    tracks: allTracks,
    albums: library.buildAlbums(allTracks),
    gridEl: dom.searchResultsGrid,
    countEl: dom.searchResultsCount
  });

  // 2) Online results from Audius, with loading / empty / error / offline states
  const slot = dom.searchResultsGrid?.querySelector('#online-search-slot');
  await search.renderOnlineSection(slot, query, {
    isCurrent: () => seq === searchSeq && state.searchActive,
    excludeIds: new Set(local.tracks.map((t) => t.id))
  });
}

// ============================================================================
// Event Listeners
// ============================================================================

function bindEvents() {
  // --- Import ---
  dom.bulkImportBtn?.addEventListener('click', () => {
    dom.bulkImportInput?.click();
  });

  dom.bulkImportInput?.addEventListener('change', async (e) => {
    const selected = Array.from(e.target.files || []);
    await handleBulkMp3Import(selected);
    e.target.value = ''; // allow picking the same files again later
  });

  dom.cancelImportBtn?.addEventListener('click', () => {
    if (isImporting) {
      importCancelled = true;
    } else {
      dom.importProgressBanner?.classList.add('hidden');
    }
  });

  // --- Mobile sidebar drawer ---
  dom.openSidebarBtn?.addEventListener('click', openMobileSidebar);
  dom.closeSidebarBtn?.addEventListener('click', closeMobileSidebar);
  dom.sidebarOverlay?.addEventListener('click', closeMobileSidebar);

  dom.brandLogo?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('listen-now');
  });

  // --- Sidebar navigation ---
  dom.navLinks.forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.view);
    });
  });

  dom.sidebarPlaylistList?.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-link[data-playlist-id]');
    if (!btn) return;
    navigateTo(`playlist:${btn.dataset.playlistId}`);
  });

  dom.navBackBtn?.addEventListener('click', goBack);
  dom.navForwardBtn?.addEventListener('click', goForward);

  // --- Search ---
  dom.searchInput?.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    dom.clearSearchBtn?.classList.toggle('hidden', query.length === 0);

    clearTimeout(searchTimer);
    if (!query) {
      clearSearch();
      applyViewVisibility();
      return;
    }

    state.searchActive = true;
    applyViewVisibility();
    searchTimer = setTimeout(() => performSearch(query), 350); // gentle on the Audius API
  });

  dom.searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
      applyViewVisibility();
    } else if (e.key === 'Enter') {
      // Search now (skip the typing delay) and close the on-screen keyboard.
      const query = dom.searchInput.value.trim();
      if (query) {
        clearTimeout(searchTimer);
        state.searchActive = true;
        applyViewVisibility();
        performSearch(query);
        dom.searchInput.blur();
      }
    }
  });

  dom.clearSearchBtn?.addEventListener('click', () => {
    clearSearch();
    applyViewVisibility();
    dom.searchInput?.focus();
  });

  // --- "See All" links on the home page ---
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-see-all]');
    if (!btn) return;
    navigateTo(btn.dataset.seeAll);
  });

  // --- Right panel ---
  dom.visualizerToggleBtn?.addEventListener('click', () => toggleRightPanel('visualizer'));
  dom.queueToggleBtn?.addEventListener('click', () => toggleRightPanel('queue'));
  dom.closeRightPanelBtn?.addEventListener('click', closeRightPanel);

  dom.panelTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchRightPanelTab(tab.dataset.panel));
  });

  dom.clearQueueBtn?.addEventListener('click', () => {
    player.clearQueue();
    showToast('Queue cleared');
  });

  // --- Playlist modal ---
  dom.createPlaylistBtn?.addEventListener('click', openPlaylistModal);
  dom.closePlaylistModal?.addEventListener('click', closePlaylistModal);
  dom.cancelPlaylistBtn?.addEventListener('click', closePlaylistModal);
  dom.createPlaylistForm?.addEventListener('submit', handleCreatePlaylistSubmit);

  // The Profile icon (login / profile modal) is wired up in js/account.js.
  dom.cloudUploadBtn?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('soundwave:openupload'));
    closeMobileSidebar();
  });


  // Equalizer & Audio FX modal wiring
  const fxModal = document.getElementById('audio-fx-modal');
  const fxBtn = document.getElementById('eq-toggle-btn');
  const eqToggle = document.getElementById('eq-enabled-toggle');
  const presetTrigger = document.getElementById('eq-preset-trigger');
  const presetLabel = document.getElementById('eq-preset-label');
  const presetMenu = document.getElementById('eq-preset-menu');
  const savePresetBtn = document.getElementById('eq-save-preset-btn');
  const bandsGrid = document.getElementById('eq-bands-grid');
  const bassSl = document.getElementById('eq-bass-slider');
  const bassLbl = document.getElementById('eq-bass-val');
  const virtSl = document.getElementById('eq-virt-slider');
  const virtLbl = document.getElementById('eq-virt-val');
  if (fxModal && bandsGrid) {
    bandsGrid.innerHTML = eq.EQ_BANDS.map((freq, i) => `
      <div class="eq-band-col">
        <span class="eq-band-db" data-eq-db="${i}">0dB</span>
        <input type="range" class="eq-band-slider" data-eq-band="${i}" min="-12" max="12" step="0.5" value="0" aria-label="${eq.EQ_LABELS[i]}">
        <span class="eq-band-freq">${eq.EQ_LABELS[i]}</span>
      </div>`).join('');
  }
  const syncFx = () => {
    const st = eq.getEqState();
    if (eqToggle) eqToggle.checked = st.enabled;
    if (presetMenu && presetLabel) {
      const all = eq.getAllPresets();
      const activeName = st.preset === 'custom' ? 'Custom' : (all[st.preset]?.name || 'Flat');
      presetLabel.textContent = activeName;
      const items = Object.entries(all).map(([k, p]) => ({ key: k, name: p.name }));
      if (st.preset === 'custom') items.push({ key: 'custom', name: 'Custom' });
      presetMenu.innerHTML = items.map(({ key, name }) => `
        <button type="button" class="eq-preset-option${key === st.preset ? ' active' : ''}" role="option" aria-selected="${key === st.preset}" data-preset-key="${key}">
          <span>${name}</span>
          ${key === st.preset ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
        </button>
      `).join('');
    }
    st.gains.forEach((g, i) => {
      const sl = bandsGrid?.querySelector(`[data-eq-band="${i}"]`);
      const db = bandsGrid?.querySelector(`[data-eq-db="${i}"]`);
      if (sl) sl.value = String(g);
      if (db) db.textContent = `${g > 0 ? '+' : ''}${g}dB`;
    });
    if (bassSl) bassSl.value = String(st.bass);
    if (bassLbl) bassLbl.textContent = `${st.bass}%`;
    if (virtSl) virtSl.value = String(st.virtualizer);
    if (virtLbl) virtLbl.textContent = `${st.virtualizer}%`;
    const preSl = document.getElementById('eq-preamp-slider');
    const preLbl = document.getElementById('eq-preamp-val');
    if (preSl) preSl.value = String(st.preamp || 0);
    if (preLbl) preLbl.textContent = `${(st.preamp || 0) > 0 ? '+' : ''}${st.preamp || 0} dB`;
    const revSl = document.getElementById('eq-reverb-slider');
    const revLbl = document.getElementById('eq-reverb-val');
    if (revSl) revSl.value = String(st.reverb || 0);
    if (revLbl) revLbl.textContent = `${st.reverb || 0}%`;
    const balSl = document.getElementById('eq-balance-slider');
    const balLbl = document.getElementById('eq-balance-val');
    const bal = st.balance || 0;
    if (balSl) balSl.value = String(bal);
    if (balLbl) balLbl.textContent = bal === 0 ? 'Center' : bal < 0 ? `L ${Math.abs(bal)}%` : `R ${bal}%`;
    fxModal?.querySelectorAll('[data-quick-preset]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.quickPreset === st.preset);
    });
  };
  const openFxModal = () => {
    if (!fxModal) return;
    syncFx();
    if (!fxModal.open) {
      if (typeof fxModal.showModal === 'function') fxModal.showModal();
      else fxModal.setAttribute('open', '');
    }
  };
  const closeFxModal = () => {
    if (!fxModal) return;
    if (typeof fxModal.close === 'function') fxModal.close();
    else fxModal.removeAttribute('open');
  };
  fxBtn?.addEventListener('click', openFxModal);
  document.addEventListener('soundwave:openfx', openFxModal);
  fxModal?.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeFxModal));
  fxModal?.addEventListener('click', (e) => {
    if (e.target === fxModal) closeFxModal();
  });
  eqToggle?.addEventListener('change', () => eq.setEqEnabled(eqToggle.checked));
  const closePresetMenu = () => {
    presetMenu?.classList.add('hidden');
    presetTrigger?.setAttribute('aria-expanded', 'false');
  };
  presetTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = presetMenu?.classList.contains('hidden');
    if (opening) {
      presetMenu.classList.remove('hidden');
      presetTrigger.setAttribute('aria-expanded', 'true');
    } else {
      closePresetMenu();
    }
  });
  presetMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('[data-preset-key]');
    if (!opt) return;
    const key = opt.dataset.presetKey;
    if (key !== 'custom') eq.applyPreset(key);
    syncFx();
    closePresetMenu();
  });
  fxModal?.addEventListener('click', (e) => {
    if (!e.target.closest('#eq-preset-dropdown')) closePresetMenu();
  });
  const resetEqBtn = document.getElementById('eq-reset-btn');
  resetEqBtn?.addEventListener('click', () => {
    eq.applyPreset('flat');
    syncFx();
    showToast('Equalizer reset to Flat');
  });
  fxModal?.querySelectorAll('[data-quick-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      eq.applyPreset(chip.dataset.quickPreset);
      syncFx();
    });
  });
  document.getElementById('eq-quick-add-btn')?.addEventListener('click', () => {
    savePresetBtn?.click();
  });
  document.getElementById('sidebar-eq-btn')?.addEventListener('click', () => {
    closeMobileSidebar();
    openFxModal();
  });
  document.getElementById('sidebar-account-btn')?.addEventListener('click', () => {
    closeMobileSidebar();
    document.getElementById('profile-btn')?.click();
  });
  savePresetBtn?.addEventListener('click', () => {
    const name = window.prompt('Preset name:');
    if (name?.trim()) { eq.saveCustomPreset(name.trim()); syncFx(); showToast(`Saved "${name.trim()}"`); }
  });
  bandsGrid?.addEventListener('input', (e) => {
    const sl = e.target.closest('[data-eq-band]');
    if (!sl) return;
    const i = Number(sl.dataset.eqBand);
    const v = Number(sl.value);
    eq.setBandGain(i, v);
    const db = bandsGrid.querySelector(`[data-eq-db="${i}"]`);
    if (db) db.textContent = `${v > 0 ? '+' : ''}${v}dB`;
  });
  bassSl?.addEventListener('input', () => { eq.setBassBoost(Number(bassSl.value)); if (bassLbl) bassLbl.textContent = `${bassSl.value}%`; });
  virtSl?.addEventListener('input', () => { eq.setVirtualizer(Number(virtSl.value)); if (virtLbl) virtLbl.textContent = `${virtSl.value}%`; });
  const preSl = document.getElementById('eq-preamp-slider');
  const preLbl = document.getElementById('eq-preamp-val');
  preSl?.addEventListener('input', () => {
    const v = Number(preSl.value);
    eq.setPreamp(v);
    if (preLbl) preLbl.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  });
  const revSl = document.getElementById('eq-reverb-slider');
  const revLbl = document.getElementById('eq-reverb-val');
  revSl?.addEventListener('input', () => {
    const v = Number(revSl.value);
    eq.setReverb(v);
    if (revLbl) revLbl.textContent = `${v}%`;
  });
  const balSl = document.getElementById('eq-balance-slider');
  const balLbl = document.getElementById('eq-balance-val');
  balSl?.addEventListener('input', () => {
    const v = Number(balSl.value);
    eq.setBalance(v);
    if (balLbl) balLbl.textContent = v === 0 ? 'Center' : v < 0 ? `L ${Math.abs(v)}%` : `R ${v}%`;
  });

  // Listening Insights / Stats modal wiring
  const statsModal = document.getElementById('stats-modal');
  const openStatsModal = async () => {
    closeMobileSidebar();
    const all = await library.getMergedLibraryTracks(CATALOG_TRACKS);
    stats.renderStatsModal(all);
    if (statsModal) {
      if (typeof statsModal.showModal === 'function') statsModal.showModal();
      else statsModal.setAttribute('open', '');
    }
  };
  document.getElementById('sidebar-stats-btn')?.addEventListener('click', openStatsModal);
  statsModal?.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
    if (typeof statsModal.close === 'function') statsModal.close();
    else statsModal.removeAttribute('open');
  }));
  statsModal?.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-stats-play]');
    if (!item) return;
    const all = await library.getMergedLibraryTracks(CATALOG_TRACKS);
    player.playTrackById(item.dataset.statsPlay, all);
    if (typeof statsModal.close === 'function') statsModal.close();
    else statsModal.removeAttribute('open');
  });
  document.getElementById('stats-reset-btn')?.addEventListener('click', async () => {
    if (!window.confirm('Reset all listening stats and play counts?')) return;
    stats.clearStats();
    const all = await library.getMergedLibraryTracks(CATALOG_TRACKS);
    stats.renderStatsModal(all);
    showToast('Listening stats reset');
  });
  const speedSl = document.getElementById('fx-speed-slider');
  const speedLbl = document.getElementById('fx-speed-val');
  const sleepLbl = document.getElementById('fx-sleep-status');
  const syncSpeedUI = () => {
    const rate = player.getPlaybackSpeed();
    if (speedSl) speedSl.value = String(rate);
    if (speedLbl) speedLbl.textContent = `${rate.toFixed(2).replace(/\.00$/, '.0')}x`;
  };
  syncSpeedUI();
  speedSl?.addEventListener('input', () => {
    const r = player.setPlaybackSpeed(Number(speedSl.value));
    if (speedLbl) speedLbl.textContent = `${r.toFixed(2).replace(/\.00$/, '.0')}x`;
  });
  fxModal?.querySelectorAll('[data-sleep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.sleep;
      player.setSleepTimer(val === 'track' ? 'track' : Number(val));
      fxModal.querySelectorAll('[data-sleep]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  document.addEventListener('soundwave:sleepchange', (e) => {
    if (!sleepLbl) return;
    const st = e.detail;
    if (!st || !st.active) {
      sleepLbl.textContent = 'Off';
      fxModal?.querySelectorAll('[data-sleep]').forEach((b) => b.classList.toggle('active', b.dataset.sleep === '0'));
    } else if (st.mode === 'track') {
      sleepLbl.textContent = 'End of Track';
    } else {
      const totalSec = Math.ceil(st.remainingMs / 1000);
      sleepLbl.textContent = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
    }
  });


  // --- Voice Search (Web Speech API) ---
  const voiceBtn = document.getElementById('voice-search-btn');
  voiceBtn?.addEventListener('click', () => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      dom.searchInput?.focus();
      showToast('Voice search unavailable — type to search');
      return;
    }
    try {
      const rec = new SpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      voiceBtn.classList.add('listening');
      showToast('Listening… speak song or artist name');
      rec.onresult = (ev) => {
        const spoken = ev.results?.[0]?.[0]?.transcript || '';
        if (spoken && dom.searchInput) {
          dom.searchInput.value = spoken;
          dom.clearSearchBtn?.classList.remove('hidden');
          state.searchActive = true;
          applyViewVisibility();
          setActiveBottomNav('search');
          performSearch(spoken.trim());
        }
      };
      rec.onerror = () => showToast('Could not capture voice — try again');
      rec.onend = () => voiceBtn.classList.remove('listening');
      rec.start();
    } catch {
      voiceBtn.classList.remove('listening');
      dom.searchInput?.focus();
    }
  });

  // --- Bottom 5-Tab Navigation Bar ---
  document.getElementById('mobile-bottom-nav')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-bottom-nav]');
    if (!tab) return;
    const target = tab.dataset.bottomNav;
    if (target === 'home') {
      navigateTo('listen-now');
      dom.discoveryView?.closest('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (target === 'library') {
      navigateTo('browse');
      setActiveBottomNav('library');
    } else if (target === 'search') {
      setActiveBottomNav('search');
      dom.searchInput?.focus();
      dom.searchInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (target === 'playlists') {
      setActiveBottomNav('playlists');
      const lists = playlist.getPlaylists();
      if (lists.length) {
        navigateTo(`playlist:${lists[0].id}`);
        setActiveBottomNav('playlists');
      } else {
        openPlaylistModal();
      }
    } else if (target === 'settings') {
      setActiveBottomNav('settings');
      document.dispatchEvent(new CustomEvent('soundwave:openfx'));
    }
  });


  // Keep subtle ambient artwork behind transparent glass components (not full-screen blur)
  document.addEventListener('soundwave:trackchange', (e) => {
    const track = e.detail?.track;
    const amb = document.getElementById('sw-ambient-art');
    if (!amb) return;
    const art = track?.coverUrl || track?.cover || '';
    if (art && !/^data:/i.test(art)) {
      amb.style.backgroundImage = `url("${String(art).replace(/"/g, '%22')}")`;
      amb.classList.add('has-art');
    } else {
      amb.classList.remove('has-art');
    }
  });


  // 8D Audio, Dynamic Themes & Full Backup/Restore
  pro.initProFeatures();
  const toggle8d = document.getElementById('fx-8d-toggle');
  toggle8d?.addEventListener('change', () => {
    pro.set8DAudioEnabled(toggle8d.checked);
    showToast(toggle8d.checked ? '8D Spatial Audio enabled' : '8D Spatial Audio off');
  });
  const syncThemeChips = () => {
    const active = pro.getActiveTheme();
    document.querySelectorAll('#fx-theme-chips [data-theme-key]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeKey === active);
    });
  };
  syncThemeChips();
  document.getElementById('fx-theme-chips')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-key]');
    if (!btn) return;
    pro.applyLiquidTheme(btn.dataset.themeKey);
    syncThemeChips();
  });
  document.getElementById('fx-backup-export-btn')?.addEventListener('click', () => pro.exportFullBackup());
  document.getElementById('fx-backup-import-btn')?.addEventListener('click', () => document.getElementById('fx-backup-input')?.click());
  document.getElementById('fx-backup-input')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await pro.importFullBackup(f);
    e.target.value = '';
  });

  // --- Cross-module events ---
  document.addEventListener('soundwave:toast', (e) => showToast(e.detail?.message || ''));

  // Full-screen player's "Up Next" button
  document.addEventListener('soundwave:openqueue', () => openRightPanel('queue'));

  // Songs were uploaded / fetched from the cloud feed (Supabase)
  document.addEventListener('soundwave:cloudchange', onLibraryChanged);

  document.addEventListener('soundwave:favoritechange', () => {
    syncFavoriteButtons();
    if (state.currentView === 'favorites') refreshCurrentView();
  });

  document.addEventListener('soundwave:playlistdeleted', () => {
    navigateTo('listen-now');
  });

  // Songs were imported / removed
  document.addEventListener('soundwave:librarychange', onLibraryChanged);

  // --- Drag & drop songs anywhere on the page (desktop) ---
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('drag-over');
  });
  document.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drag-over');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drag-over');
    handleBulkMp3Import(e.dataTransfer.files);
  });

  // --- Android Capacitor hardware back button ---
  const handleHardwareBack = (e) => {
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) {
      if (openDialog.id === 'upload-modal' && document.getElementById('upload-form')?.classList.contains('is-uploading')) {
        return;
      }
      if (typeof openDialog.close === 'function') openDialog.close();
      else openDialog.removeAttribute('open');
      e?.preventDefault?.();
      return;
    }
    if (fullplayer.isFullPlayerOpen()) {
      fullplayer.closeFullPlayer();
      e?.preventDefault?.();
      return;
    }
    if (dom.rightPanel && !dom.rightPanel.classList.contains('hidden')) {
      closeRightPanel();
      e?.preventDefault?.();
      return;
    }
    if (dom.sidebar?.classList.contains('open')) {
      closeMobileSidebar();
      e?.preventDefault?.();
      return;
    }
    if (state.historyIndex > 0) {
      goBack();
      e?.preventDefault?.();
      return;
    }
    window.Capacitor?.Plugins?.App?.minimizeApp?.();
  };

  document.addEventListener('backbutton', handleHardwareBack);
  if (window.Capacitor?.Plugins?.App?.addListener) {
    window.Capacitor.Plugins.App.addListener('backButton', handleHardwareBack);
  }
}

// Optional: songs that ship with the website itself (music/tracks.json).
async function loadSiteTracks() {
  try {
    const res = await fetch('music/tracks.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.tracks;
    if (!Array.isArray(list)) return [];

    return list
      .filter((t) => t && typeof t.src === 'string' && t.src.trim())
      .map((t) => {
        const fromName = parseFilename(t.src.split('/').pop() || '');
        return {
          id: t.id || `site-${hashString(t.src)}`,
          title: t.title || fromName.title,
          artist: t.artist || fromName.artist || 'Unknown Artist',
          album: t.album || 'Singles',
          duration: Number(t.duration) || 0,
          cover: t.cover || null,
          src: t.src.trim(),
          lyrics: Array.isArray(t.lyrics) ? t.lyrics : [],
          isImported: false
        };
      });
  } catch (err) {
    console.warn('Could not read music/tracks.json:', err);
    return [];
  }
}

let appBooted = false;

async function initApp() {
  if (appBooted) return;
  appBooted = true;

  // Bind UI controls FIRST so buttons and navigation are immediately responsive
  try { updateHistoryButtons(); } catch (e) { console.warn('History init:', e); }
  try { bindEvents(); } catch (e) { console.error('bindEvents failed:', e); }

  Promise.resolve(storage.initStorage()).catch((err) => console.warn('Storage init failed:', err));

  let offlineReady = Promise.resolve();
  try {
    network.initNetwork();
    offlineReady = Promise.resolve(offline.initOffline()).catch((e) => console.warn('Offline init:', e));
    network.onNetworkChange((up) => {
      const q = dom.searchInput?.value.trim();
      if (up && state.searchActive && q) performSearch(q);
    });
  } catch (e) { console.warn('Network init:', e); }

  try {
    player.initPlayer({ tracks: [], queueListEl: dom.queueList });
    player.setLibraryProvider(() => library.getMergedLibraryTracks(CATALOG_TRACKS));
  } catch (e) { console.error('Player init failed:', e); }

  try {
    visualizer.initVisualizer({
      audioEl: document.getElementById('audio-engine'),
      canvasEl: document.getElementById('audio-visualizer-canvas')
    });
  } catch (e) { console.warn('Visualizer init:', e); }

  try { fullplayer.initFullPlayer(); } catch (e) { console.warn('Fullplayer init:', e); }
  try { account.initAccountUI({ readMetadata, makeThumbnail }); } catch (e) { console.warn('Account init:', e); }
  import('./js/cloud.js?v=pro35').then((m) => m.initCloud()).catch((e) => console.warn('Cloud init:', e));

  await offlineReady;
  try { CATALOG_TRACKS = await loadSiteTracks(); } catch { CATALOG_TRACKS = []; }
  try { playlist.initPlaylists({ tracks: CATALOG_TRACKS, sidebarListEl: dom.sidebarPlaylistList }); } catch (e) { console.warn('Playlist init:', e); }
  try { await onLibraryChanged(); } catch (e) { console.warn('Library render:', e); }
  try { syncFavoriteButtons(); } catch (e) { console.warn('Favorites sync:', e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
