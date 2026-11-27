// ============================================================================
// SoundWave — Audio Player Engine, Queue & Transport Controls (js/player.js)
// ============================================================================

import { getFavorites, toggleFavorite, getAudioBlob, recordRecentlyPlayed, getPlaybackPrefs, setPlaybackPrefs } from './storage.js?v=pro35';
import { escapeHtml, formatTime, toast, coverFor, placeholderCover } from './util.js?v=pro35';
import { recordTrackPlay, addListeningSeconds } from './stats.js?v=pro35';
import * as media from './native.js?v=pro35';
import { isSaved } from './offline.js?v=pro35';
import { isOnline, waitForOnline, onNetworkChange } from './network.js?v=pro35';

// Tiny silent clip used to "unlock" audio on iPhone/Android after the first tap.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';

const ICON_VOLUME =
  '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
const ICON_MUTED =
  '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';

const VOLUME_KEY = 'soundwave_volume_v1';

const state = {
  catalog: [],
  queue: [],
  index: -1,
  loaded: false, // has audio.src been set for the current track?
  shuffle: false,
  repeat: 'off', // 'off' | 'all' | 'one'
  history: [],
  failures: 0,
  seeking: false,
  initialized: false
};

const el = {};
let loadToken = 0;          // bumps on every loadTrack so stale async loads are ignored
let currentObjectUrl = null; // blob: URL of the song that is currently loaded
let libraryProvider = null;  // async () => tracks, set by script.js
let audioUnlocked = false;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------


// Tracks coming from the library are plain metadata. Audio for imported songs is
// fetched from IndexedDB at play time (see resolveSrc), so nothing heavy sits in memory.
export function prepareTrack(track) {
  return track || null;
}

function prepareList(list = []) {
  return list.map(prepareTrack).filter(Boolean);
}

function trackCover(track) {
  return coverFor(track);
}

function setImgWithFallback(img, src, seed) {
  if (!img) return;
  img.onerror = () => {
    img.onerror = null;
    img.src = placeholderCover(seed);
  };
  img.src = src;
}

export function getCurrentTrack() {
  return state.queue[state.index] || null;
}

export function isPlaying() {
  return Boolean(el.audio) && !el.audio.paused && !el.audio.ended;
}


let sleepInterval = null;
let sleepEndsAt = 0;
let sleepEndOfTrack = false;

function emitSleepState() {
  document.dispatchEvent(new CustomEvent('soundwave:sleepchange', { detail: getSleepTimerState() }));
}

export function getSleepTimerState() {
  if (sleepEndOfTrack) return { active: true, mode: 'track', remainingMs: 0 };
  if (sleepEndsAt > Date.now()) return { active: true, mode: 'minutes', remainingMs: Math.max(0, sleepEndsAt - Date.now()) };
  return { active: false, mode: 'off', remainingMs: 0 };
}

export function setSleepTimer(minutes) {
  clearInterval(sleepInterval);
  sleepInterval = null;
  sleepEndsAt = 0;
  sleepEndOfTrack = false;

  if (minutes === 'track') {
    sleepEndOfTrack = true;
    toast('Sleep timer: stops after current song');
    emitSleepState();
    return;
  }

  const mins = Number(minutes) || 0;
  if (mins <= 0) {
    emitSleepState();
    return;
  }

  sleepEndsAt = Date.now() + mins * 60 * 1000;
  const savedVol = el.audio ? el.audio.volume : 0.8;
  toast(`Sleep timer set for ${mins} min`);
  emitSleepState();

  sleepInterval = setInterval(() => {
    const rem = sleepEndsAt - Date.now();
    if (rem <= 0) {
      clearInterval(sleepInterval);
      sleepInterval = null;
      sleepEndsAt = 0;
      if (el.audio && !el.audio.paused) {
        el.audio.pause();
        el.audio.volume = savedVol;
        toast('Sleep timer ended — playback paused');
      }
      emitSleepState();
      return;
    }
    if (rem <= 5000 && el.audio && !el.audio.paused && !el.audio.muted) {
      el.audio.volume = Math.max(0.02, savedVol * (rem / 5000));
    }
    emitSleepState();
  }, 1000);
}

export function getPlaybackSpeed() {
  return getPlaybackPrefs().playbackRate;
}

export function setPlaybackSpeed(rate) {
  const clamped = Math.max(0.5, Math.min(2.0, Math.round(Number(rate) * 100) / 100 || 1.0));
  setPlaybackPrefs({ playbackRate: clamped });
  if (el.audio) {
    el.audio.playbackRate = clamped;
    el.audio.defaultPlaybackRate = clamped;
    if (Number.isFinite(el.audio.duration)) {
      media.setPosition({ duration: el.audio.duration, position: el.audio.currentTime, playbackRate: clamped }, { force: true });
    }
  }
  toast(`Playback speed: ${clamped.toFixed(2).replace(/\.00$/, '.0')}x`);
  return clamped;
}

function applySavedPlaybackRate() {
  if (!el.audio) return;
  const { playbackRate } = getPlaybackPrefs();
  el.audio.playbackRate = playbackRate;
  el.audio.defaultPlaybackRate = playbackRate;
}


let abLoop = { a: null, b: null };
let lastStatsTick = 0;

function emitABLoop() {
  document.dispatchEvent(new CustomEvent('soundwave:abloopchange', { detail: { ...abLoop } }));
}

export function getABLoop() {
  return { ...abLoop };
}

export function clearABLoop(silent = false) {
  abLoop = { a: null, b: null };
  emitABLoop();
  if (!silent) toast('A-B Loop cleared');
}

export function cycleABLoop() {
  if (!el.audio || !Number.isFinite(el.audio.duration)) return;
  const nowT = el.audio.currentTime || 0;
  if (abLoop.a === null) {
    abLoop.a = nowT;
    abLoop.b = null;
    toast(`Loop A set at ${formatTime(nowT)}`);
  } else if (abLoop.b === null) {
    if (nowT <= abLoop.a + 1) {
      toast('Point B must be after Point A');
      return;
    }
    abLoop.b = nowT;
    el.audio.currentTime = abLoop.a;
    toast(`Looping ${formatTime(abLoop.a)} – ${formatTime(abLoop.b)}`);
  } else {
    clearABLoop(false);
    return;
  }
  emitABLoop();
}

export function seekBySeconds(delta) {
  if (!el.audio || !Number.isFinite(el.audio.duration)) return;
  el.audio.currentTime = Math.max(0, Math.min(el.audio.duration, (el.audio.currentTime || 0) + Number(delta || 0)));
}

// ----------------------------------------------------------------------------
// UI sync
// ----------------------------------------------------------------------------

function updateNowPlayingUI(track) {
  if (!track) return;
  if (el.title) el.title.textContent = track.title || 'Untitled Track';
  if (el.artist) el.artist.textContent = track.artist || 'Unknown Artist';
  setImgWithFallback(el.cover, trackCover(track), track.coverSeed || track.album || track.title);
  if (el.totalDuration) el.totalDuration.textContent = formatTime(track.duration);
  if (el.currentTime) el.currentTime.textContent = '0:00';
  if (el.seek) {
    el.seek.value = 0;
    el.seek.style.setProperty('--progress', '0%');
  }
  updateLikeButton();

  // Notification bar / lock screen / system capsule metadata
  try {
    const cover = trackCover(track);
    const art = /^data:/i.test(cover) && media.isNativeApp ? '' : new URL(cover, location.href).href;
    media.setNowPlaying(track, art);
  } catch { /* artwork is optional */ }
}

function updatePlayButton() {
  const playing = isPlaying();
  el.playIcon?.classList.toggle('hidden', playing);
  el.pauseIcon?.classList.toggle('hidden', !playing);
  el.playBtn?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  el.playerBar?.classList.toggle('is-playing', playing);
}

function updateLikeButton() {
  if (!el.likeBtn) return;
  const track = getCurrentTrack();
  const liked = Boolean(track) && getFavorites().includes(track.id);
  el.likeBtn.classList.toggle('liked', liked);
  el.likeBtn.setAttribute('aria-pressed', String(liked));
}

function updateVolumeUI() {
  if (!el.audio) return;
  const muted = el.audio.muted || el.audio.volume === 0;
  if (el.volumeIcon) el.volumeIcon.innerHTML = muted ? ICON_MUTED : ICON_VOLUME;
  if (el.volumeSlider) el.volumeSlider.value = el.audio.muted ? 0 : el.audio.volume;
}

export function refreshPlayingState() {
  const current = getCurrentTrack();
  const id = current ? String(current.id) : null;
  document.querySelectorAll('.track-row[data-track-id]').forEach((row) => {
    row.classList.toggle('playing', id !== null && row.dataset.trackId === id);
  });
}

function renderQueue() {
  const list = el.queueList;
  if (!list) return;

  const current = getCurrentTrack();
  const upcoming = state.queue.slice(state.index + 1, state.index + 101);

  const itemHtml = (track, queueIndex, isCurrent) => `
    <li class="queue-item${isCurrent ? ' current' : ''}" data-queue-index="${queueIndex}">
      <img class="queue-thumb" src="${escapeHtml(trackCover(track))}" alt="" loading="lazy">
      <div class="queue-meta">
        <span class="queue-title">${escapeHtml(track.title || 'Untitled Track')}</span>
        <span class="queue-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
      </div>
      ${isCurrent ? '<span class="queue-now">Now</span>' : `<div class="queue-item-controls"><button type="button" class="queue-move-btn" data-move-up="${queueIndex}" aria-label="Move up">&#9650;</button><button type="button" class="queue-move-btn" data-move-down="${queueIndex}" aria-label="Move down">&#9660;</button><button type="button" class="queue-remove-btn" data-remove-index="${queueIndex}" aria-label="Remove from queue">&times;</button></div>`}
    </li>`;

  let html = '';
  if (current) html += itemHtml(current, state.index, true);
  html += upcoming.map((t, i) => itemHtml(t, state.index + 1 + i, false)).join('');
  if (!upcoming.length) {
    html += '<li class="queue-empty">Nothing up next. Use the ⋯ button on a song to add it here.</li>';
  }

  list.innerHTML = html;
  list.querySelectorAll('.queue-thumb').forEach((img) => {
    img.onerror = () => {
      img.onerror = null;
      img.src = placeholderCover(img.alt || 'soundwave');
    };
  });
}

// ----------------------------------------------------------------------------
// Core playback
// ----------------------------------------------------------------------------

// Saved / imported songs live in IndexedDB and are preferred (they work offline);
// everything else streams from its plain src (site songs, Appwrite, Audius).
async function resolveSrc(track) {
  if (track.isImported || isSaved(track.id)) {
    try {
      const blob = await getAudioBlob(track.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        return { src: url, objectUrl: url };
      }
    } catch (err) {
      console.warn('Could not read the saved copy:', err);
    }
  }
  if (track.src) return { src: track.src, objectUrl: null };
  return { src: null, objectUrl: null };
}

function releaseObjectUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function loadTrack(index, autoplay = true) {
  if (!state.queue.length || !el.audio) return;
  const safeIndex = Math.max(0, Math.min(index, state.queue.length - 1));
  state.index = safeIndex;
  const track = state.queue[safeIndex];
  const token = (loadToken += 1);

  updateNowPlayingUI(track);
  renderQueue();
  refreshPlayingState();
  if (autoplay) {
    recordRecentlyPlayed(track);
    recordTrackPlay(track);
  }
  clearABLoop(true);
  document.dispatchEvent(new CustomEvent('soundwave:trackchange', { detail: { track } }));
  document.title = `${track.title || 'SoundWave'} — SoundWave`;

  const apply = (src, objectUrl) => {
    if (!src) {
      state.loaded = false;
      handleTrackError(track);
      return;
    }
    const previousUrl = currentObjectUrl;
    currentObjectUrl = objectUrl;
    el.audio.src = src;
    state.loaded = true;
    el.audio.load();
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if (autoplay) playAudio();
    updatePlayButton();
  };

  // Songs with a plain src start synchronously (keeps the tap "gesture" alive on iOS).
  // Songs that also have a saved offline copy go through resolveSrc() instead.
  if (track.src && !isSaved(track.id)) {
    if (!isOnline() && /^https?:/i.test(track.src)) {
      toast("You're offline — save songs for offline listening to play them without internet");
    }
    apply(track.src, null);
    return;
  }

  resolveSrc(track)
    .then(({ src, objectUrl }) => {
      if (token !== loadToken) {
        // The user already picked another song while this one was loading.
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      apply(src, objectUrl);
    })
    .catch((err) => {
      console.warn('Could not load song from storage:', err);
      if (token === loadToken) {
        state.loaded = false;
        handleTrackError(track);
      }
    });
}

function playAudio() {
  if (!el.audio) return;
  applySavedPlaybackRate();
  const promise = el.audio.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      // AbortError: a new load interrupted play(). NotSupportedError is reported by the 'error' event.
      if (err && err.name === 'NotAllowedError') toast('Tap play to start the music');
    });
  }
}

export function togglePlay() {
  if (!state.queue.length) {
    if (libraryProvider) {
      libraryProvider()
        .then((list) => {
          if (!list || !list.length) {
            toast('Nothing to play yet — import some songs!');
            return;
          }
          playList(list, 0);
        })
        .catch(() => toast('Could not open your library.'));
    } else {
      toast('Nothing to play yet — import some songs!');
    }
    return;
  }
  if (!state.loaded) {
    loadTrack(Math.max(state.index, 0), true);
    return;
  }
  if (el.audio.paused) playAudio();
  else el.audio.pause();
}

function randomIndex() {
  if (state.queue.length <= 1) return 0;
  let i;
  do {
    i = Math.floor(Math.random() * state.queue.length);
  } while (i === state.index);
  return i;
}

let lastSkipAt = 0;

export function next(auto = false) {
  if (!state.queue.length) return;
  if (!auto) {
    const now = Date.now();
    if (now - lastSkipAt < 200) return;
    lastSkipAt = now;
  }

  if (auto && sleepEndOfTrack) {
    sleepEndOfTrack = false;
    el.audio.pause();
    el.audio.currentTime = 0;
    updatePlayButton();
    emitSleepState();
    toast('Sleep timer: stopped after track');
    return;
  }

  if (auto && state.repeat === 'one') {
    el.audio.currentTime = 0;
    playAudio();
    return;
  }

  let nextIndex;
  if (state.shuffle && state.queue.length > 1) {
    nextIndex = randomIndex();
  } else {
    nextIndex = state.index + 1;
  }

  if (nextIndex >= state.queue.length) {
    if (auto && state.repeat === 'off') {
      // End of the queue: stop quietly.
      el.audio.pause();
      el.audio.currentTime = 0;
      updatePlayButton();
      return;
    }
    nextIndex = 0;
  }

  state.history.push(state.index);
  if (state.history.length > 100) state.history.shift();
  loadTrack(nextIndex, true);
}

export function previous() {
  if (!state.queue.length) return;
  const now = Date.now();
  if (now - lastSkipAt < 200) return;
  lastSkipAt = now;
  if (el.audio.currentTime > 3) {
    el.audio.currentTime = 0;
    return;
  }
  let prevIndex;
  if (state.history.length) {
    prevIndex = state.history.pop();
  } else {
    prevIndex = state.index - 1;
    if (prevIndex < 0) prevIndex = state.repeat === 'all' ? state.queue.length - 1 : 0;
  }
  loadTrack(prevIndex, true);
}

function handleTrackError(track) {
  state.failures += 1;
  const name = track && track.title ? `"${track.title}"` : 'this track';

  if (state.queue.length > 1 && state.failures < state.queue.length) {
    toast(`Couldn't play ${name} — skipping`);
    // Skip ahead without wrapping forever
    const nextIndex = state.index + 1;
    if (nextIndex < state.queue.length) {
      state.history.push(state.index);
      setTimeout(() => loadTrack(nextIndex, true), 250);
      return;
    }
  }

  toast(`Couldn't play ${name}. The file may be missing or unsupported.`);
  state.failures = 0;
  updatePlayButton();
}

// ----------------------------------------------------------------------------
// Public queue API
// ----------------------------------------------------------------------------

export function playTrackById(trackId, list) {
  if (Array.isArray(list) && list.length) {
    state.queue = prepareList(list);
    state.history = [];
  } else if (!state.queue.length) {
    state.queue = prepareList(state.catalog);
  }

  let idx = state.queue.findIndex((t) => t.id === trackId);
  if (idx === -1) {
    const fromCatalog = state.catalog.find((t) => t.id === trackId);
    if (!fromCatalog) return;
    state.queue.splice(state.index + 1, 0, prepareTrack(fromCatalog));
    idx = state.index + 1;
  }

  state.failures = 0;
  loadTrack(idx, true);
}

export function playList(list, startIndex = 0) {
  const prepared = prepareList(list);
  if (!prepared.length) {
    toast('No songs to play');
    return;
  }
  state.queue = prepared;
  state.history = [];
  state.failures = 0;
  loadTrack(Math.min(startIndex, prepared.length - 1), true);
}

export function playShuffled(list) {
  const prepared = prepareList(list && list.length ? list : state.catalog);
  if (!prepared.length) {
    toast('No songs to shuffle');
    return;
  }
  for (let i = prepared.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [prepared[i], prepared[j]] = [prepared[j], prepared[i]];
  }
  state.queue = prepared;
  state.history = [];
  state.failures = 0;
  loadTrack(0, true);
}

export function addToQueueById(trackId, list) {
  const source = Array.isArray(list) && list.length ? list : state.catalog;
  const found = source.find((t) => t.id === trackId) || state.catalog.find((t) => t.id === trackId);
  if (!found) return;
  addTracksToQueue([found], 'Added to Up Next');
}

export function addTracksToQueue(tracks, message = 'Added to Up Next') {
  const prepared = prepareList(tracks);
  if (!prepared.length) return;

  if (!state.queue.length || state.index < 0) {
    state.queue = prepared;
    state.index = 0;
    state.loaded = false;
    updateNowPlayingUI(state.queue[0]);
  } else {
    state.queue.splice(state.index + 1, 0, ...prepared);
  }
  renderQueue();
  toast(message);
}

export function clearQueue() {
  if (state.index >= 0) {
    state.queue = state.queue.slice(0, state.index + 1);
  } else {
    state.queue = [];
  }
  renderQueue();
}

// script.js tells the player how to fetch the whole library (used by the Play button when idle).
export function setLibraryProvider(fn) {
  libraryProvider = typeof fn === 'function' ? fn : null;
}

function resetNowPlayingUI() {
  if (el.title) el.title.textContent = 'Nothing playing';
  if (el.artist) el.artist.textContent = 'Import songs to start';
  setImgWithFallback(el.cover, placeholderCover('soundwave'), 'soundwave');
  if (el.totalDuration) el.totalDuration.textContent = '0:00';
  if (el.currentTime) el.currentTime.textContent = '0:00';
  if (el.seek) {
    el.seek.value = 0;
    el.seek.style.setProperty('--progress', '0%');
  }
  updateLikeButton();
  document.title = 'SoundWave';
}

// While nothing is playing, show the first library song in the bar so Play works right after a refresh.
export function primeQueue(list = []) {
  if (!el.audio || state.loaded || isPlaying()) return;
  const prepared = prepareList(list);
  state.queue = prepared;
  state.index = prepared.length ? 0 : -1;
  if (prepared.length) updateNowPlayingUI(prepared[0]);
  else resetNowPlayingUI();
  renderQueue();
  refreshPlayingState();
  updatePlayButton();
}

function stopAudio() {
  loadToken += 1;
  if (el.audio) {
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
  }
  releaseObjectUrl();
  state.loaded = false;
}

// A song was deleted from the library.
export function removeTrackEverywhere(trackId) {
  const idx = state.queue.findIndex((t) => t.id === trackId);
  if (idx === -1) return;

  if (idx === state.index) {
    stopAudio();
    state.queue.splice(idx, 1);
    state.index = state.queue.length ? Math.min(idx, state.queue.length - 1) : -1;
    if (state.index >= 0) updateNowPlayingUI(state.queue[state.index]);
    else resetNowPlayingUI();
  } else {
    state.queue.splice(idx, 1);
    if (idx < state.index) state.index -= 1;
  }
  state.history = state.history.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i));
  renderQueue();
  refreshPlayingState();
  updatePlayButton();
}

// Library wiped completely.
export function resetPlayer() {
  stopAudio();
  state.queue = [];
  state.index = -1;
  state.history = [];
  resetNowPlayingUI();
  renderQueue();
  refreshPlayingState();
  updatePlayButton();
}

// iPhone / Android Chrome only allow sound after a tap. The first tap anywhere plays a silent
// clip so later play() calls (after loading a song from storage) are allowed.
function unlockAudio() {
  if (audioUnlocked || !el.audio) return;
  audioUnlocked = true;
  const a = el.audio;
  if (a.getAttribute('src')) return; // a real song is already loading — nothing to unlock

  const cleanup = () => {
    if (a.getAttribute('src') === SILENT_WAV) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
  };
  a.src = SILENT_WAV;
  const p = a.play();
  if (p && typeof p.then === 'function') p.then(cleanup, cleanup);
  else cleanup();
}

// ----------------------------------------------------------------------------
// Event wiring
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Network resilience: resume streaming after a dropped connection
// ----------------------------------------------------------------------------

const MAX_RECOVERY = 4;
const STALL_MS = 9000;
const recovery = { attempts: 0, timer: null, resumeAt: 0, waiting: false };
let stallTimer = null;

function resetRecovery() {
  recovery.attempts = 0;
  recovery.waiting = false;
  clearTimeout(recovery.timer);
  resetStallWatch();
}

function resetStallWatch() {
  clearTimeout(stallTimer);
  stallTimer = null;
}

function startStallWatch() {
  const a = el.audio;
  if (!a || stallTimer || a.paused || /^blob:/i.test(a.currentSrc || '')) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (a.paused || a.readyState >= 3) return;
    recoverPlayback();
  }, STALL_MS);
}

// Reloads the current stream and seeks back to where it stopped. Returns false when it gave up.
function recoverPlayback() {
  const a = el.audio;
  const track = getCurrentTrack();
  const src = a?.getAttribute('src');
  if (!a || !track || !src || !/^https?:/i.test(src)) return false;

  if (recovery.attempts >= MAX_RECOVERY) {
    recovery.attempts = 0;
    recovery.waiting = false;
    toast("Couldn't reconnect. Tap play to try again.");
    updatePlayButton();
    return true; // handled: do not skip the song
  }
  if (recovery.waiting) return true;

  recovery.attempts += 1;
  recovery.resumeAt = a.currentTime || recovery.resumeAt || 0;
  recovery.waiting = true;
  resetStallWatch();

  const resume = () => {
    recovery.waiting = false;
    const current = getCurrentTrack();
    if (!current || current.id !== track.id || a.getAttribute('src') !== src) return; // user moved on
    const at = recovery.resumeAt;
    const onMeta = () => {
      if (at > 1 && Number.isFinite(a.duration)) {
        try { a.currentTime = Math.min(at, Math.max(0, a.duration - 1)); } catch { /* not seekable yet */ }
      }
      playAudio();
    };
    a.addEventListener('loadedmetadata', onMeta, { once: true });
    a.load();
  };

  if (!isOnline()) {
    toast('Connection lost — playback will resume when you are back online');
    waitForOnline().then(resume);
  } else {
    recovery.timer = setTimeout(resume, 1200 * recovery.attempts);
  }
  return true;
}

function bindAudioEvents() {
  const a = el.audio;

  a.addEventListener('play', () => {
    updatePlayButton();
    media.setPlaybackState('playing');
    media.ensureNotificationPermission();
  });
  a.addEventListener('pause', () => {
    updatePlayButton();
    media.setPlaybackState('paused');
  });
  a.addEventListener('playing', () => {
    state.failures = 0;
    resetRecovery();
    updatePlayButton();
    media.setPlaybackState('playing');
  });
  a.addEventListener('canplay', resetStallWatch);
  a.addEventListener('waiting', startStallWatch);
  a.addEventListener('stalled', startStallWatch);
  a.addEventListener('ended', () => next(true));

  const syncDurationUI = () => {
    const track = getCurrentTrack();
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (track?.duration || 0);
    if (el.totalDuration && d > 0) {
      el.totalDuration.textContent = formatTime(d);
    }
    if (Number.isFinite(a.duration) && a.duration > 0) {
      media.setPosition({ duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate }, { force: true });
    }
  };
  a.addEventListener('loadedmetadata', syncDurationUI);
  a.addEventListener('durationchange', syncDurationUI);
  a.addEventListener('canplay', () => { resetStallWatch(); syncDurationUI(); });
  a.addEventListener('seeked', () => {
    media.setPosition({ duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate }, { force: true });
  });

  a.addEventListener('timeupdate', () => {
    if (!a.paused) {
      media.setPosition({ duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate });
      const nowMs = Date.now();
      if (lastStatsTick && nowMs - lastStatsTick >= 5000) {
        addListeningSeconds(5);
        lastStatsTick = nowMs;
      } else if (!lastStatsTick) {
        lastStatsTick = nowMs;
      }
      if (abLoop.a !== null && abLoop.b !== null && a.currentTime >= abLoop.b) {
        a.currentTime = abLoop.a;
      }
    }
    if (state.seeking) return;
    if (el.currentTime) el.currentTime.textContent = formatTime(a.currentTime);
    if (el.seek && Number.isFinite(a.duration) && a.duration > 0) {
      const pct = (a.currentTime / a.duration) * 100;
      el.seek.value = pct;
      el.seek.style.setProperty('--progress', `${pct}%`);
    }
  });

  a.addEventListener('volumechange', updateVolumeUI);

  a.addEventListener('error', () => {
    const src = a.getAttribute('src');
    if (!src || src === SILENT_WAV) return; // ignore the empty-src "error" and the unlock clip

    // A dropped connection while streaming is not a broken file: wait and resume.
    const streamed = /^https?:/i.test(src);
    const networkError = a.error && a.error.code === 2; // MEDIA_ERR_NETWORK
    if (streamed && (!isOnline() || networkError) && recoverPlayback()) return;

    handleTrackError(getCurrentTrack());
  });
}

function bindControls() {
  el.playBtn?.addEventListener('click', togglePlay);
  el.nextBtn?.addEventListener('click', () => next(false));
  el.prevBtn?.addEventListener('click', previous);

  el.shuffleBtn?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    el.shuffleBtn.classList.toggle('active', state.shuffle);
    el.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  });

  el.repeatBtn?.addEventListener('click', () => {
    const order = ['off', 'all', 'one'];
    state.repeat = order[(order.indexOf(state.repeat) + 1) % order.length];
    el.repeatBtn.dataset.repeat = state.repeat;
    el.repeatBtn.classList.toggle('active', state.repeat !== 'off');
    const label = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[state.repeat];
    el.repeatBtn.setAttribute('aria-label', label);
    el.repeatBtn.title = label;
    toast(label);
  });

  // Seek slider
  el.seek?.addEventListener('input', () => {
    state.seeking = true;
    const dur = el.audio.duration;
    const pct = Number(el.seek.value);
    el.seek.style.setProperty('--progress', `${pct}%`);
    if (Number.isFinite(dur) && el.currentTime) el.currentTime.textContent = formatTime((pct / 100) * dur);
  });
  const commitSeek = () => {
    const dur = el.audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      el.audio.currentTime = (Number(el.seek.value) / 100) * dur;
    }
    state.seeking = false;
  };
  el.seek?.addEventListener('change', commitSeek);
  el.seek?.addEventListener('pointerup', commitSeek);
  el.seek?.addEventListener('touchend', commitSeek);

  // Volume
  el.volumeSlider?.addEventListener('input', () => {
    const v = Number(el.volumeSlider.value);
    el.audio.muted = false;
    el.audio.volume = v;
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* ignore */ }
  });
  el.muteBtn?.addEventListener('click', () => {
    if (el.audio.muted || el.audio.volume === 0) {
      el.audio.muted = false;
      if (el.audio.volume === 0) el.audio.volume = 0.5;
    } else {
      el.audio.muted = true;
    }
    updateVolumeUI();
  });

  // Like current track
  el.likeBtn?.addEventListener('click', () => {
    const track = getCurrentTrack();
    if (!track) return;
    toggleFavorite(track.id);
    updateLikeButton();
    document.dispatchEvent(new CustomEvent('soundwave:favoritechange', { detail: { trackId: track.id } }));
  });
  document.addEventListener('soundwave:favoritechange', updateLikeButton);

  // Queue list (jump / remove)
  el.queueList?.addEventListener('click', (e) => {
    const moveUp = e.target.closest('[data-move-up]');
    if (moveUp) {
      const idx = Number(moveUp.dataset.moveUp);
      if (idx > state.index + 1) {
        [state.queue[idx - 1], state.queue[idx]] = [state.queue[idx], state.queue[idx - 1]];
        renderQueue();
      }
      return;
    }
    const moveDown = e.target.closest('[data-move-down]');
    if (moveDown) {
      const idx = Number(moveDown.dataset.moveDown);
      if (idx > state.index && idx < state.queue.length - 1) {
        [state.queue[idx + 1], state.queue[idx]] = [state.queue[idx], state.queue[idx + 1]];
        renderQueue();
      }
      return;
    }
    const removeBtn = e.target.closest('[data-remove-index]');
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.removeIndex);
      if (idx > state.index) {
        state.queue.splice(idx, 1);
        renderQueue();
      }
      return;
    }
    const item = e.target.closest('.queue-item[data-queue-index]');
    if (!item) return;
    const idx = Number(item.dataset.queueIndex);
    if (idx !== state.index) {
      state.history.push(state.index);
      state.failures = 0;
      loadTrack(idx, true);
    }
  });

  // Keyboard: space = play/pause
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (e.target.closest && e.target.closest('input, textarea, select, button, a, dialog, [contenteditable="true"]')) return;
    e.preventDefault();
    togglePlay();
  });

  // Unlock audio on the very first touch / click / key press
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, unlockAudio, { capture: true, once: true });
  });

  // Notification bar, lock screen, headset buttons and system media capsules
  const seekBy = (delta) => {
    const a = el.audio;
    if (!a || !Number.isFinite(a.duration)) return;
    a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + delta));
  };
  media.initMediaControls({
    play: () => (state.loaded ? playAudio() : togglePlay()),
    pause: () => el.audio.pause(),
    stop: () => el.audio.pause(),
    previoustrack: previous,
    nexttrack: () => next(false),
    seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
    seekforward: (d) => seekBy(d.seekOffset || 10),
    seekto: (d) => {
      const a = el.audio;
      if (a && Number.isFinite(d.seekTime) && Number.isFinite(a.duration)) a.currentTime = Math.min(d.seekTime, a.duration);
    }
  });

  // Back online: if a stream was waiting for the network, the recovery code resumes it.
  onNetworkChange((up) => {
    if (up && el.audio && !el.audio.paused && el.audio.readyState < 3) recoverPlayback();
  });
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

export function initPlayer({ tracks = [], queueListEl = null } = {}) {
  if (state.initialized) return;
  state.initialized = true;

  el.audio = document.getElementById('audio-engine');
  if (!el.audio) {
    console.warn('player.js: #audio-engine not found');
    return;
  }

  el.playerBar = document.getElementById('player-bar');
  el.cover = document.getElementById('player-cover');
  el.title = document.getElementById('player-title');
  el.artist = document.getElementById('player-artist');
  el.likeBtn = document.getElementById('player-like-btn');
  el.shuffleBtn = document.getElementById('shuffle-btn');
  el.prevBtn = document.getElementById('prev-btn');
  el.playBtn = document.getElementById('play-pause-btn');
  el.nextBtn = document.getElementById('next-btn');
  el.repeatBtn = document.getElementById('repeat-btn');
  el.playIcon = document.getElementById('play-icon');
  el.pauseIcon = document.getElementById('pause-icon');
  el.currentTime = document.getElementById('current-time');
  el.totalDuration = document.getElementById('total-duration');
  el.seek = document.getElementById('seek-slider');
  el.volumeSlider = document.getElementById('volume-slider');
  el.muteBtn = document.getElementById('mute-btn');
  el.volumeIcon = document.getElementById('volume-icon');
  el.queueList = queueListEl || document.getElementById('queue-list');

  state.catalog = tracks;
  state.queue = prepareList(tracks);
  state.index = state.queue.length ? 0 : -1;
  state.loaded = false; // don't touch audio.src until the user presses play (avoids a 404 on page load)

  // Restore volume
  try {
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY));
    el.audio.volume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;
  } catch {
    el.audio.volume = 0.8;
  }

  bindAudioEvents();
  bindControls();

  if (state.queue.length) updateNowPlayingUI(state.queue[0]);
  else resetNowPlayingUI();
  updateVolumeUI();
  updatePlayButton();
  renderQueue();
  refreshPlayingState();
}
