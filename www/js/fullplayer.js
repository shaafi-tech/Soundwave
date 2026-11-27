// ============================================================================
// SoundWave — Full-screen "Now Playing" sheet + live synced lyrics (js/fullplayer.js)
//
//  - tap the mini player to expand, swipe down / back button / chevron to close
//  - big rounded cover in the centre, blurred copy of the cover behind everything
//  - "Lyrics" toggle: LRCLIB synced lyrics follow audio.currentTime, highlighted + auto-scrolled
//  - Apple Music-style lyrics view: colour gradient taken from the cover, big left-aligned bold
//    lines, the active line is sharp while the others are dimmed + blurred by distance,
//    tap a line to seek, compact mini controls, tap the small cover (or the pill) for artwork
// ============================================================================

import * as player from './player.js?v=pro35';
import { registerVisualizerTargets } from './visualizer.js?v=pro35';
import { escapeHtml, formatTime, coverFor, placeholderCover, toast, hashString } from './util.js?v=pro35';
import { getLyrics, lyricsKey } from './lyrics.js?v=pro35';
import { openLyricsShareModal } from './lyricsshare.js?v=pro35';

const LYRICS_PREF_KEY = 'soundwave_lyrics_on_v1';
const LEAD_SECONDS = 0.35;   // highlight a line slightly before its timestamp
const USER_SCROLL_HOLD = 3500; // ms auto-scroll pauses after the user scrolls the lyrics

const els = {};
let audio = null;
let initialized = false;

const st = {
  open: false,
  lyricsMode: false,
  seeking: false,
  historyPushed: false,
  // backdrop
  bgFlip: false,
  bgSrc: '',
  bgToken: 0,
  // lyrics
  key: '',
  token: 0,
  data: null,
  lines: [],
  lineEls: [],
  activeIdx: -1,
  holdUntil: 0
};

// ----------------------------------------------------------------------------
// Cover colours -> animated gradient behind the lyrics
// ----------------------------------------------------------------------------

const paletteCache = new Map();
let paletteToken = 0;

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

// Same seed -> same colours, so covers without art still get a pleasant gradient.
export function fallbackPalette(seed = '') {
  const h = hashString(String(seed) || 'soundwave') % 360;
  return [hsl(h, 62, 46), hsl(h + 42, 58, 36), hsl(h + 205, 50, 26)];
}

// pixels: RGBA bytes (e.g. from getImageData). Returns three CSS colours [main, second, deep].
export function pickPalette(pixels) {
  const buckets = new Map();
  let vivid = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 200) continue;
    const [h, s, l] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (l < 0.08 || l > 0.94) continue;
    const weight = (s * 0.8 + 0.2) * (1 - Math.abs(l - 0.5));
    if (s > 0.25) vivid += 1;
    const shifted = (h + 15) % 360; // keeps reds (350°–10°) in one bucket
    const key = Math.floor(shifted / 30);
    const b = buckets.get(key) || { w: 0, h: 0, s: 0 };
    b.w += weight;
    b.h += shifted * weight;
    b.s += s * weight;
    buckets.set(key, b);
  }

  const ranked = [...buckets.values()]
    .filter((b) => b.w > 0)
    .map((b) => ({ w: b.w, h: (b.h / b.w - 15 + 360) % 360, s: b.s / b.w }))
    .sort((a, b) => b.w - a.w);

  // Almost no colour in the cover (black & white art): calm neutral gradient.
  if (!ranked.length || vivid < pixels.length / 4 / 40) {
    const h = ranked[0]?.h ?? 230;
    return [hsl(h, 10, 34), hsl(h, 8, 24), hsl(h, 8, 15)];
  }

  const main = ranked[0];
  const second = ranked.find((c) => {
    const diff = Math.abs(c.h - main.h);
    return Math.min(diff, 360 - diff) >= 40;
  });
  const clampS = (s) => Math.max(45, Math.min(85, s * 100));

  return [
    hsl(main.h, clampS(main.s), 46),
    hsl(second ? second.h : main.h + 38, clampS(second ? second.s : main.s), 36),
    hsl(main.h + 200, clampS(main.s) * 0.7, 24)
  ];
}

function paletteFromImage(img) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  return pickPalette(g.getImageData(0, 0, size, size).data); // throws if the image is cross-origin
}

function applyPalette(colors) {
  if (!els.aurora) return;
  els.aurora.style.setProperty('--fp-c1', colors[0]);
  els.aurora.style.setProperty('--fp-c2', colors[1]);
  els.aurora.style.setProperty('--fp-c3', colors[2]);
}

function updatePalette(src, seed) {
  if (!els.aurora || !src) return;
  const cached = paletteCache.get(src);
  if (cached) {
    applyPalette(cached);
    return;
  }
  const token = (paletteToken += 1);
  const fallback = fallbackPalette(seed);

  const probe = new Image();
  probe.crossOrigin = 'anonymous';
  probe.onload = () => {
    let colors;
    try {
      colors = paletteFromImage(probe);
    } catch {
      colors = fallback; // cover without CORS headers can't be read: use the seeded colours
    }
    paletteCache.set(src, colors);
    if (paletteCache.size > 60) paletteCache.delete(paletteCache.keys().next().value);
    if (token === paletteToken) applyPalette(colors);
  };
  probe.onerror = () => {
    if (token === paletteToken) applyPalette(fallback);
  };
  probe.src = src;
}

function setMiniCover(src, seed) {
  if (!els.miniCover) return;
  els.miniCover.onerror = () => {
    els.miniCover.onerror = null;
    els.miniCover.src = placeholderCover(seed);
  };
  els.miniCover.src = src;
}

// Elements the lyrics view needs but that are not in index.html: the colour gradient layer,
// the small cover next to the title (shown in lyrics mode) and the developer credit.
function injectExtras() {
  const bg = els.root.querySelector('.fp-bg');
  if (bg && !bg.querySelector('.fp-aurora')) {
    els.aurora = document.createElement('div');
    els.aurora.className = 'fp-aurora';
    els.aurora.setAttribute('aria-hidden', 'true');
    bg.appendChild(els.aurora);
  } else {
    els.aurora = bg?.querySelector('.fp-aurora') || null;
  }

  const meta = els.root.querySelector('.fp-meta');
  els.miniCover = document.getElementById('fp-mini-cover');
  if (meta && !els.miniCover) {
    const img = document.createElement('img');
    img.id = 'fp-mini-cover';
    img.className = 'fp-mini-cover';
    img.alt = 'Show album artwork';
    img.draggable = false;
    meta.insertBefore(img, meta.firstChild);
    els.miniCover = img;
  }

  const inner = els.root.querySelector('.fp-inner');
  if (inner && !inner.querySelector('.fp-credit')) {
    const credit = document.createElement('p');
    credit.className = 'fp-credit';
    credit.textContent = 'Designed and Developed by Shaafi';
    inner.appendChild(credit);
  }
}

// ----------------------------------------------------------------------------
// Track UI
// ----------------------------------------------------------------------------

function setBackdrop(src, seed) {
  if (!src || src === st.bgSrc) return;
  st.bgSrc = src;
  const token = (st.bgToken += 1);

  const apply = (finalSrc) => {
    if (token !== st.bgToken) return;
    const next = st.bgFlip ? els.bgA : els.bgB;
    const prev = st.bgFlip ? els.bgB : els.bgA;
    st.bgFlip = !st.bgFlip;
    next.style.backgroundImage = `url("${finalSrc.replace(/"/g, '%22')}")`;
    next.classList.add('on');
    prev.classList.remove('on');
  };

  // Preload so the cross-fade never shows an empty frame.
  const probe = new Image();
  probe.onload = () => apply(src);
  probe.onerror = () => apply(placeholderCover(seed));
  probe.src = src;
}

function syncTrack(track) {
  if (!track || !els.root) return;
  const seed = track.coverSeed || track.album || track.title;
  const src = coverFor(track);

  els.title.textContent = track.title || 'Untitled Track';
  els.artist.textContent = track.artist || 'Unknown Artist';

  els.cover.onerror = () => {
    els.cover.onerror = null;
    els.cover.src = placeholderCover(seed);
  };
  els.cover.src = src;
  setBackdrop(src, seed);
  setMiniCover(src, seed);
  updatePalette(src, seed);

  const d = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track.duration;
  els.duration.textContent = formatTime(d);
  syncLike();
  syncModes();
}

function syncPlayState() {
  const playing = player.isPlaying();
  els.iconPlay.classList.toggle('hidden', playing);
  els.iconPause.classList.toggle('hidden', !playing);
  els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  els.root.classList.toggle('paused', !playing);
}

function syncProgress() {
  if (!st.open || st.seeking || !audio) return;
  els.current.textContent = formatTime(audio.currentTime || 0);
  const d = audio.duration;
  if (Number.isFinite(d) && d > 0) {
    const pct = Math.min(100, ((audio.currentTime || 0) / d) * 100);
    els.seek.value = pct;
    els.seek.style.setProperty('--progress', `${pct}%`);
    els.duration.textContent = formatTime(d);
  } else {
    els.seek.value = 0;
    els.seek.style.setProperty('--progress', '0%');
  }
}

function syncLike() {
  const barLike = document.getElementById('player-like-btn');
  const liked = Boolean(barLike?.classList.contains('liked'));
  els.like.classList.toggle('liked', liked);
  els.like.setAttribute('aria-pressed', String(liked));
}

function syncModes() {
  const shuffleOn = Boolean(document.getElementById('shuffle-btn')?.classList.contains('active'));
  els.shuffle.classList.toggle('active', shuffleOn);
  els.shuffle.setAttribute('aria-pressed', String(shuffleOn));

  const repeat = document.getElementById('repeat-btn')?.dataset.repeat || 'off';
  els.repeat.dataset.repeat = repeat;
  els.repeat.classList.toggle('active', repeat !== 'off');
}

// ----------------------------------------------------------------------------
// Lyrics
// ----------------------------------------------------------------------------

function showLyricsMessage(message, { retry = false, manual = false } = {}) {
  st.lines = [];
  st.lineEls = [];
  st.activeIdx = -1;
  els.lyrics.innerHTML = `
    <div class="fp-lyrics-inner">
      <p class="lyrics-status"${retry ? ' data-retry="1"' : ''}>${escapeHtml(message)}</p>
      ${manual ? '<button type="button" class="lyrics-manual-btn" data-manual="1">Search lyrics manually</button>' : ''}
    </div>`;
  els.lyrics.scrollTop = 0;
}

function renderLyrics(data) {
  st.data = data;
  st.activeIdx = -1;
  st.lines = [];
  st.lineEls = [];

  if (!data || data.status === 'none') {
    showLyricsMessage('Lyrics not available', { manual: true });
    return;
  }
  if (data.status === 'error') {
    showLyricsMessage("Couldn't load lyrics. Tap to try again.", { retry: true });
    st.key = ''; // allow another attempt
    return;
  }
  if (data.status === 'instrumental') {
    showLyricsMessage('♪ Instrumental');
    return;
  }

  if (data.status === 'synced') {
    st.lines = data.lines;
    els.lyrics.innerHTML = `
      <div class="fp-lyrics-inner synced">
        ${data.lines
          .map(
            (line, i) =>
              `<p class="lyric-line${line.text ? '' : ' lyric-gap'}" data-i="${i}">${escapeHtml(line.text || '♪')}</p>`
          )
          .join('')}
      </div>`;
    st.lineEls = Array.from(els.lyrics.querySelectorAll('.lyric-line'));
    els.lyrics.scrollTop = 0;
    return;
  }

  // plain lyrics: no timestamps, just readable text
  els.lyrics.innerHTML = `
    <div class="fp-lyrics-inner plain">
      ${String(data.plain)
        .split(/\r?\n/)
        .map((line) => (line.trim() ? `<p class="lyric-line plain">${escapeHtml(line)}</p>` : '<p class="lyric-line plain gap"></p>'))
        .join('')}
    </div>`;
  els.lyrics.scrollTop = 0;
}

async function loadLyrics(track, query = '') {
  if (!track) return;
  const token = (st.token += 1);
  st.key = lyricsKey(track);
  st.data = null;
  showLyricsMessage('Searching for lyrics…');

  const data = await getLyrics(track, { query });
  if (token !== st.token) return; // another song started meanwhile
  renderLyrics(data);
  updateActiveLine(true);
}

function ensureLyrics() {
  const track = player.getCurrentTrack();
  if (!track) return;
  if (lyricsKey(track) !== st.key) loadLyrics(track);
}

function scrollToLine(idx, smooth) {
  const el = st.lineEls[idx];
  if (!el) return;
  const wrap = els.lyrics;
  const top = el.offsetTop - (wrap.clientHeight - el.offsetHeight) * 0.36;
  wrap.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// Finds the last line whose timestamp has passed, highlights it and keeps it in view.
function updateActiveLine(force = false) {
  if (!st.open || !st.lyricsMode || !audio || st.data?.status !== 'synced') return;

  const lines = st.lines;
  const t = (audio.currentTime || 0) + LEAD_SECONDS;

  let lo = 0;
  let hi = lines.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (idx === st.activeIdx && !force) return;
  const prevIdx = st.activeIdx;
  st.activeIdx = idx;

  if (!force && prevIdx >= 0 && prevIdx < st.lineEls.length && Math.abs(idx - prevIdx) === 1) {
    st.lineEls[prevIdx].classList.remove('active');
    st.lineEls[prevIdx].classList.toggle('past', prevIdx < idx);
    if (idx >= 0 && idx < st.lineEls.length) {
      st.lineEls[idx].classList.remove('past');
      st.lineEls[idx].classList.add('active');
    }
  } else {
    for (let i = 0; i < st.lineEls.length; i += 1) {
      const el = st.lineEls[i];
      const isAct = i === idx;
      const isPast = i < idx;
      if (el.classList.contains('active') !== isAct) el.classList.toggle('active', isAct);
      if (el.classList.contains('past') !== isPast) el.classList.toggle('past', isPast);
    }
  }

  if (idx < 0) {
    if (force) els.lyrics.scrollTo({ top: 0 });
    return;
  }
  if (force || Date.now() > st.holdUntil) scrollToLine(idx, !force);
}

function setLyricsMode(on, { remember = true } = {}) {
  st.lyricsMode = Boolean(on);
  els.root.classList.toggle('lyrics-mode', st.lyricsMode);
  els.lyricsBtn.classList.toggle('active', st.lyricsMode);
  els.lyricsBtn.setAttribute('aria-pressed', String(st.lyricsMode));
  const label = document.getElementById('fp-lyrics-label');
  if (label) label.textContent = st.lyricsMode ? 'Artwork' : 'Lyrics';
  els.lyricsBtn.setAttribute('aria-label', st.lyricsMode ? 'Show album artwork' : 'Show lyrics');
  if (remember) {
    try { localStorage.setItem(LYRICS_PREF_KEY, st.lyricsMode ? '1' : '0'); } catch { /* ignore */ }
  }
  if (st.lyricsMode && st.open) {
    ensureLyrics();
    requestAnimationFrame(() => updateActiveLine(true));
  }
}

// ----------------------------------------------------------------------------
// Open / close
// ----------------------------------------------------------------------------

export function isFullPlayerOpen() {
  return st.open;
}

export function openFullPlayer({ lyrics } = {}) {
  if (!initialized) return;
  const track = player.getCurrentTrack();
  if (!track) {
    toast('Nothing playing yet');
    return;
  }

  if (st.open) {
    if (typeof lyrics === 'boolean') setLyricsMode(lyrics);
    return;
  }

  st.open = true;
  syncTrack(track);
  syncPlayState();
  syncProgress();

  els.root.classList.add('open');
  els.root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('fp-open');

  if (typeof lyrics === 'boolean') setLyricsMode(lyrics);
  else setLyricsMode(st.lyricsMode, { remember: false });
  ensureLyrics();

  // Lets the Android back button close the sheet instead of leaving the app.
  try {
    history.pushState({ soundwaveFullPlayer: true }, '');
    st.historyPushed = true;
  } catch { st.historyPushed = false; }
}

function hide() {
  st.open = false;
  st.historyPushed = false;
  els.root.style.transition = '';
  els.root.style.transform = '';
  els.root.classList.remove('open');
  els.root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('fp-open');
}

export function closeFullPlayer() {
  if (!st.open) return;
  if (st.historyPushed) {
    history.back(); // popstate handler hides the sheet
    return;
  }
  hide();
}

// ----------------------------------------------------------------------------
// Gestures
// ----------------------------------------------------------------------------

function bindSwipeDown() {
  let startY = 0;
  let dy = 0;
  let startTime = 0;
  let active = false;

  const onStart = (e) => {
    if (e.touches.length !== 1) return;
    active = true;
    dy = 0;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    els.root.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!active) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    els.root.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = () => {
    if (!active) return;
    active = false;
    els.root.style.transition = '';
    const velocity = dy / Math.max(1, Date.now() - startTime);
    if (dy > 130 || (velocity > 0.6 && dy > 40)) closeFullPlayer();
    else els.root.style.transform = '';
  };

  els.root.querySelectorAll('.fp-header, .fp-art-wrap').forEach((zone) => {
    zone.addEventListener('touchstart', onStart, { passive: true });
    zone.addEventListener('touchmove', onMove, { passive: true });
    zone.addEventListener('touchend', onEnd);
    zone.addEventListener('touchcancel', onEnd);
  });
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

export function initFullPlayer() {
  if (initialized) return;

  els.root = document.getElementById('full-player');
  audio = document.getElementById('audio-engine');
  if (!els.root || !audio) {
    console.warn('fullplayer.js: markup not found');
    return;
  }

  Object.assign(els, {
    bgA: document.getElementById('fp-bg-a'),
    bgB: document.getElementById('fp-bg-b'),
    closeBtn: document.getElementById('fp-close-btn'),
    cover: document.getElementById('fp-cover'),
    title: document.getElementById('fp-title'),
    artist: document.getElementById('fp-artist'),
    like: document.getElementById('fp-like-btn'),
    current: document.getElementById('fp-current'),
    duration: document.getElementById('fp-duration'),
    seek: document.getElementById('fp-seek'),
    shuffle: document.getElementById('fp-shuffle-btn'),
    prev: document.getElementById('fp-prev-btn'),
    playBtn: document.getElementById('fp-play-btn'),
    iconPlay: document.getElementById('fp-icon-play'),
    iconPause: document.getElementById('fp-icon-pause'),
    next: document.getElementById('fp-next-btn'),
    repeat: document.getElementById('fp-repeat-btn'),
    lyricsBtn: document.getElementById('fp-lyrics-btn'),
    queueBtn: document.getElementById('fp-queue-btn'),
    eqBtn: document.getElementById('fp-eq-btn'),
    shareBtn: document.getElementById('fp-share-btn'),
    topShareBtn: document.getElementById('fp-top-share-btn'),
    waveCanvas: document.getElementById('fp-wave-canvas'),
    lyrics: document.getElementById('fp-lyrics')
  });

  initialized = true;
  injectExtras();

  try { st.lyricsMode = localStorage.getItem(LYRICS_PREF_KEY) === '1'; } catch { st.lyricsMode = false; }

  // --- Opening the sheet ---
  const info = document.querySelector('.player-track-info');
  info?.addEventListener('click', (e) => {
    if (e.target.closest('#player-like-btn')) return;
    openFullPlayer();
  });
  document.getElementById('expand-now-playing-btn')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openFullPlayer();
  });
  // Desktop lyrics button in the bottom bar
  document.getElementById('lyrics-btn')?.addEventListener('click', () => openFullPlayer({ lyrics: true }));

  // --- Closing ---
  els.closeBtn.addEventListener('click', closeFullPlayer);
  window.addEventListener('popstate', () => {
    if (st.open) {
      st.historyPushed = false;
      hide();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.open && !document.querySelector('dialog[open]')) closeFullPlayer();
  });
  bindSwipeDown();

  // --- Transport (reuses the real player so everything stays in sync) ---
  els.playBtn.addEventListener('click', () => player.togglePlay());
  els.next.addEventListener('click', () => player.next(false));
  els.prev.addEventListener('click', () => player.previous());
  els.shuffle.addEventListener('click', () => {
    document.getElementById('shuffle-btn')?.click();
    syncModes();
  });
  els.repeat.addEventListener('click', () => {
    document.getElementById('repeat-btn')?.click();
    syncModes();
  });
  els.like.addEventListener('click', () => {
    document.getElementById('player-like-btn')?.click();
    syncLike();
  });
  document.addEventListener('soundwave:favoritechange', syncLike);

  // --- Seek ---
  els.seek.addEventListener('input', () => {
    st.seeking = true;
    const pct = Number(els.seek.value);
    els.seek.style.setProperty('--progress', `${pct}%`);
    if (Number.isFinite(audio.duration)) els.current.textContent = formatTime((pct / 100) * audio.duration);
  });
  els.seek.addEventListener('change', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(els.seek.value) / 100) * audio.duration;
    }
    st.seeking = false;
    updateActiveLine(true);
  });

  // --- Lyrics toggle & interactions ---
  els.lyricsBtn.addEventListener('click', () => setLyricsMode(!st.lyricsMode));

  // Register full-screen & mini-player frequency spectrum canvases with real AnalyserNode engine
  registerVisualizerTargets({
    fpCanvasEl: els.waveCanvas,
    miniCanvasEl: document.getElementById('mini-wave-canvas')
  });

  const triggerShareLyrics = () => {
    const track = player.getCurrentTrack();
    if (!track) return;
    const activeLineText = st.activeIdx >= 0 && st.lines[st.activeIdx] ? st.lines[st.activeIdx].text : '';
    openLyricsShareModal({
      track,
      lines: st.lines.length ? st.lines : [],
      currentText: activeLineText || st.data?.plain || ''
    });
  };


  // --- Double-tap artwork (-10s / +10s) & Horizontal Swipe (Next / Previous) ---
  const coverZone = els.root.querySelector('.fp-cover-wrap');
  if (coverZone) {
    let lastTapAt = 0;
    let swipeStartX = 0;
    let swipeStartY = 0;

    const showSeekHud = (label) => {
      let hud = coverZone.querySelector('.fp-seek-hud');
      if (!hud) {
        hud = document.createElement('div');
        hud.className = 'fp-seek-hud';
        coverZone.appendChild(hud);
      }
      hud.textContent = label;
      hud.classList.remove('show');
      void hud.offsetWidth;
      hud.classList.add('show');
    };

    coverZone.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
    }, { passive: true });

    coverZone.addEventListener('touchend', (e) => {
      if (!e.changedTouches || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - swipeStartX;
      const dy = e.changedTouches[0].clientY - swipeStartY;
      // Horizontal swipe to change song
      if (Math.abs(dx) > 68 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0) player.next(false);
        else player.previous();
        return;
      }
      // Double-tap left/right to seek -10s / +10s
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) {
        const now = Date.now();
        if (now - lastTapAt < 320) {
          const rect = coverZone.getBoundingClientRect();
          const tapX = e.changedTouches[0].clientX - rect.left;
          const delta = tapX < rect.width / 2 ? -10 : 10;
          player.seekBySeconds(delta);
          showSeekHud(delta < 0 ? '« 10s' : '10s »');
          lastTapAt = 0;
        } else {
          lastTapAt = now;
        }
      }
    });
  }

  // --- A-B Loop button in Full-Screen Player ---
  const abBtn = document.getElementById('fp-ab-btn');
  const abLabel = document.getElementById('fp-ab-label');
  abBtn?.addEventListener('click', () => player.cycleABLoop());
  document.addEventListener('soundwave:abloopchange', (e) => {
    const loop = e.detail || { a: null, b: null };
    if (!abBtn || !abLabel) return;
    if (loop.a !== null && loop.b !== null) {
      abBtn.setAttribute('aria-pressed', 'true');
      abLabel.textContent = 'A-B On';
    } else if (loop.a !== null) {
      abBtn.setAttribute('aria-pressed', 'true');
      abLabel.textContent = 'Set B';
    } else {
      abBtn.setAttribute('aria-pressed', 'false');
      abLabel.textContent = 'A-B';
    }
  });

  els.eqBtn?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('soundwave:openfx'));
  });
  els.shareBtn?.addEventListener('click', triggerShareLyrics);
  els.topShareBtn?.addEventListener('click', triggerShareLyrics);



  els.queueBtn.addEventListener('click', () => {
    closeFullPlayer();
    document.dispatchEvent(new CustomEvent('soundwave:openqueue'));
  });

  // While the person is scrolling the lyrics themselves, auto-scroll pauses and the blur lifts
  // so every line is readable. Both come back a few seconds after they let go.
  let scrollTimer = null;
  const holdScroll = () => {
    st.holdUntil = Date.now() + USER_SCROLL_HOLD;
    els.lyrics.classList.add('user-scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => els.lyrics.classList.remove('user-scrolling'), USER_SCROLL_HOLD);
  };
  ['touchstart', 'wheel', 'pointerdown'].forEach((evt) => {
    els.lyrics.addEventListener(evt, holdScroll, { passive: true });
  });
  els.miniCover?.addEventListener('click', () => setLyricsMode(false));
  els.lyrics.addEventListener('click', (e) => {
    if (e.target.closest('[data-manual]')) {
      const track = player.getCurrentTrack();
      const q = track ? window.prompt('Type the song name and artist (e.g. "My Ordinary Life The Living Tombstone")', `${track.title || ''} ${track.artist || ''}`.trim()) : '';
      if (q && q.trim()) loadLyrics(track, q.trim());
      return;
    }
    if (e.target.closest('[data-retry]')) {
      st.key = '';
      ensureLyrics();
      return;
    }
    const line = e.target.closest('.lyric-line[data-i]');
    if (!line || st.data?.status !== 'synced') return;
    const target = st.lines[Number(line.dataset.i)];
    if (!target) return;
    audio.currentTime = target.time;
    st.holdUntil = 0;
    clearTimeout(scrollTimer);
    els.lyrics.classList.remove('user-scrolling');
    updateActiveLine(true);
  });

  // --- Audio + player events ---
  ['play', 'pause', 'playing', 'ended', 'emptied'].forEach((evt) => audio.addEventListener(evt, syncPlayState));
  audio.addEventListener('timeupdate', () => {
    syncProgress();
    updateActiveLine();
  });
  audio.addEventListener('seeked', () => updateActiveLine(true));
  audio.addEventListener('loadedmetadata', syncProgress);
  audio.addEventListener('durationchange', syncProgress);

  document.addEventListener('soundwave:trackchange', (e) => {
    if (!st.open) return;
    const track = e.detail?.track || player.getCurrentTrack();
    syncTrack(track);
    syncProgress();
    loadLyrics(track);
  });

  syncPlayState();
}
