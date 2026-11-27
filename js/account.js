// ============================================================================
// SoundWave — Profile icon, Login / Sign Up, Profile ("My Uploads") & Upload UI
// (js/account.js)
// ============================================================================

import {
  initCloud,
  getUser,
  getMyUploads,
  getCloudListError,
  refreshCloudTracks,
  signIn,
  signUp,
  signOut,
  uploadSong,
  deleteCloudTrack,
  friendlyError,
  validateAudioFile,
  buildFileName,
  findCloudDuplicate,
  isRetryableError
} from './cloud.js?v=pro35';
import * as player from './player.js?v=pro35';
import { removeFavorite } from './storage.js?v=pro35';
import { isSaved, removeOfflineCopy } from './offline.js?v=pro35';
import { escapeHtml, toast, coverFor, imgFallbackAttr, forgetCover, saveCustomCover } from './util.js?v=pro35';
import { fetchCoverArtForTrack } from './search.js?v=pro35';
import { requestAppNotification, notifyAppEvent } from './native.js?v=pro35';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8; // Appwrite requires at least 8 characters

const $ = (id) => document.getElementById(id);

const dom = {};
let deps = { readMetadata: null, makeThumbnail: null };
let authMode = 'login';        // 'login' | 'signup'
let afterLogin = null;         // 'upload' when the login was triggered by "Upload"
let uploadBusy = false;
let uploadPhase = 'select';    // 'select' -> 'running' -> 'done'
let stopRequested = false;
let queue = [];                // [{ file, status, message }] for the current selection
let wakeLock = null;
let coverBlob = null;          // chosen (or auto-extracted) cover image
let coverPreviewUrl = null;
let metaToken = 0;

// ----------------------------------------------------------------------------
// Small dialog helpers
// ----------------------------------------------------------------------------

function openDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!dialog || !dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function setMessage(el, text, hidden = !text) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', hidden);
}

// ----------------------------------------------------------------------------
// Avatar (top-right Profile icon)
// ----------------------------------------------------------------------------

function initialOf(user) {
  const email = String(user?.email || user?.username || '?').trim();
  return (email[0] || '?').toUpperCase();
}

function updateAvatar() {
  const user = getUser();
  dom.profileBtn?.classList.toggle('logged-in', Boolean(user));
  if (dom.avatarInitial) dom.avatarInitial.textContent = user ? initialOf(user) : '';
  dom.profileBtn?.setAttribute('aria-label', user ? `Profile (${user.email || user.username})` : 'Log in or sign up');
}

// ----------------------------------------------------------------------------
// Login / Sign Up
// ----------------------------------------------------------------------------

function setAuthMode(mode) {
  authMode = mode === 'signup' ? 'signup' : 'login';
  const signup = authMode === 'signup';

  dom.authTabs.forEach((tab) => {
    const active = tab.dataset.mode === authMode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.authTitle.textContent = signup ? 'Create account' : 'Welcome back';
  dom.authSubmit.textContent = signup ? 'Sign Up' : 'Log In';
  dom.authPassword.autocomplete = signup ? 'new-password' : 'current-password';
  dom.authSwitch.textContent = signup ? 'Already have an account? Log in' : "New here? Create an account";
  dom.authEmail.autocomplete = 'email';
  setMessage(dom.authError, '');
  setMessage(dom.authInfo, '');
}

function openAuth({ mode = 'login', reason = '' } = {}) {
  setAuthMode(mode);
  dom.authSubtitle.textContent =
    reason === 'upload'
      ? 'Log in or create an account with your email and a password to upload songs.'
      : 'Log in with your email and password, or create an account. Listening never needs one.';
  dom.authPassword.value = '';
  openDialog(dom.authModal);
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  setMessage(dom.authError, '');
  setMessage(dom.authInfo, '');

  const email = dom.authEmail.value.trim().toLowerCase();
  const password = dom.authPassword.value;

  if (!email) {
    setMessage(dom.authError, 'Please enter your email address.');
    dom.authEmail.focus();
    return;
  }
  if (!EMAIL_RE.test(email)) {
    setMessage(dom.authError, 'Enter a valid email address, like name@example.com.');
    dom.authEmail.focus();
    return;
  }
  if (!password) {
    setMessage(dom.authError, 'Please enter your password.');
    dom.authPassword.focus();
    return;
  }
  if (password.length < MIN_PASSWORD) {
    setMessage(dom.authError, `Password must be at least ${MIN_PASSWORD} characters.`);
    dom.authPassword.focus();
    return;
  }

  dom.authSubmit.disabled = true;
  dom.authSubmit.classList.add('is-loading');
  const label = dom.authSubmit.textContent;
  dom.authSubmit.textContent = authMode === 'signup' ? 'Creating account…' : 'Logging in…';

  try {
    if (authMode === 'signup') {
      await signUp(email, password); // creates the account and logs in; no email verification step
      toast('Account created — you are logged in');
    } else {
      await signIn(email, password);
      toast('Logged in');
    }

    closeDialog(dom.authModal);
    dom.authForm.reset();
    const next = afterLogin;
    afterLogin = null;
    if (next === 'upload') openUpload();
  } catch (err) {
    setMessage(dom.authError, friendlyError(err));
  } finally {
    dom.authSubmit.disabled = false;
    dom.authSubmit.classList.remove('is-loading');
    if (dom.authSubmit.textContent !== label) dom.authSubmit.textContent = authMode === 'signup' ? 'Sign Up' : 'Log In';
  }
}

// ----------------------------------------------------------------------------
// Profile ("My Uploads")
// ----------------------------------------------------------------------------

function renderMyUploads() {
  const mine = getMyUploads();
  dom.uploadsCount.textContent = mine.length ? `${mine.length}` : '';

  if (!mine.length) {
    const why = getCloudListError();
    dom.uploadsList.innerHTML = why
      ? `<li class="upload-empty">Could not load songs: ${escapeHtml(why)}</li>`
      : '<li class="upload-empty">You haven\'t uploaded any songs yet.</li>';
    return;
  }

  dom.uploadsList.innerHTML = mine
    .map(
      (t, i) => `
      <li class="upload-row" data-index="${i}" tabindex="0" role="button" aria-label="Play ${escapeHtml(t.title)}">
        <img class="upload-thumb" src="${escapeHtml(coverFor(t))}" alt="" loading="lazy" onerror="${imgFallbackAttr(t.coverSeed || t.title)}">
        <div class="upload-meta">
          <span class="upload-title">${escapeHtml(t.title)}</span>
          <span class="upload-artist">${escapeHtml(t.artist)}</span>
        </div>
        <div class="track-menu-wrap">
          <button type="button" class="upload-dots-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${escapeHtml(t.title)}" title="More options"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg></button>
          <div class="track-dropdown hidden" role="menu">
            <button type="button" class="track-menu-item upload-cover-edit-btn" role="menuitem" data-cover-track-id="${escapeHtml(t.id)}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              <span>Change Cover Image</span>
            </button>
            <button type="button" class="track-menu-item danger upload-delete-btn" role="menuitem" data-track-id="${escapeHtml(t.id)}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
              <span>Delete Song</span>
            </button>
          </div>
        </div>
      </li>`
    )
    .join('');
}

function openProfile() {
  const user = getUser();
  if (!user) {
    openAuth();
    return;
  }
  dom.profileEmail.textContent = user.email || user.username || 'Signed in';
  dom.profileInitial.textContent = initialOf(user);
  renderMyUploads();
  openDialog(dom.profileModal);
  refreshCloudTracks(); // pick up anything new; re-renders via cloudchange
}

function handleProfileButton() {
  if (getUser()) openProfile();
  else {
    afterLogin = null;
    openAuth();
  }
}

async function handleLogout() {
  dom.logoutBtn.disabled = true;
  try {
    await signOut();
    closeDialog(dom.profileModal);
    toast('Logged out');
  } finally {
    dom.logoutBtn.disabled = false;
  }
}

// ----------------------------------------------------------------------------
// Upload
// ----------------------------------------------------------------------------

function resetCoverPreview() {
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = null;
  coverBlob = null;
  dom.uploadCoverPreview.classList.add('hidden');
  dom.uploadCoverPreview.removeAttribute('src');
  dom.uploadCoverName.textContent = 'Choose cover image (optional)';
}

function setCover(blob, label) {
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverBlob = blob;
  coverPreviewUrl = URL.createObjectURL(blob);
  dom.uploadCoverPreview.src = coverPreviewUrl;
  dom.uploadCoverPreview.classList.remove('hidden');
  dom.uploadCoverName.textContent = label;
}

const MAX_ATTEMPTS = 3;               // 1 try + 2 automatic retries for network / rate-limit errors
const ONLINE_WAIT_MS = 60000;         // how long a paused queue waits for the connection to return
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
// Reading tags from a phone file (Drive / SD card / slow storage) can hang; never wait forever.
const withTimeout = (promise, ms = 8000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Reading the file took too long.')), ms))]);

function setSingleFieldsVisible(visible) {
  dom.uploadSingleFields?.classList.toggle('hidden', !visible);
}

// --- Queue list (one row per selected file) ---------------------------------

const STATUS_TEXT = {
  queued: 'Queued',
  uploading: 'Uploading',
  done: 'Done',
  duplicate: 'Skipped — already in your library',
  invalid: 'Skipped',
  failed: 'Failed',
  stopped: 'Not uploaded (stopped)'
};

function rowText(entry) {
  const base = STATUS_TEXT[entry.status] || '';
  return entry.message ? `${base}${entry.status === 'invalid' || entry.status === 'failed' ? ' — ' : ' · '}${entry.message}` : base;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function syncBulkSummary() {
  const hasAny = queue.length >= 1;
  const bulk = queue.length >= 2;
  dom.uploadBulkSummary?.classList.toggle('hidden', !hasAny);
  if (dom.uploadBulkCount) dom.uploadBulkCount.textContent =
    `${plural(queue.length, 'song')} selected • ${formatBytes(queue.reduce((n, e) => n + e.file.size, 0))}`;
  if (dom.uploadQueue) dom.uploadQueue.classList.toggle('hidden', !bulk);
}
function renderQueue() {
  const list = dom.uploadQueue;
  if (!list) return;
  if (queue.length < 2) { list.innerHTML = ''; syncBulkSummary(); return; }
  list.innerHTML = queue.map((e, i) => `
    <li class="queue-row is-${e.status}" data-i="${i}">
      <div class="queue-meta">
        <span class="queue-name">${escapeHtml(e.title || e.file.name)}</span>
        <span class="queue-sub">${escapeHtml(e.artist || 'Unknown Artist')} • ${formatBytes(e.file.size)}</span>
      </div>
      <span class="queue-state">${escapeHtml(rowText(e))}</span>
      ${uploadBusy ? '' : `<button type="button" class="queue-remove" data-remove="${i}" aria-label="Remove ${escapeHtml(e.file.name)}">×</button>`}
    </li>`).join('');
  syncBulkSummary();
}

function updateQueueRow(i, scroll = false) {
  const e = queue[i];
  const row = dom.uploadQueue?.querySelector(`[data-i="${i}"]`);
  if (!e || !row) return;
  row.className = `queue-row is-${e.status}`;
  row.querySelector('.queue-state').textContent = rowText(e);
  if (scroll && e.status === 'uploading') row.scrollIntoView({ block: 'nearest' });
}

function setEntry(i, status, message = '') {
  queue[i].status = status;
  queue[i].message = message;
  updateQueueRow(i, true);
}

// --- Form state ---------------------------------------------------------------

function resetUploadForm() {
  dom.uploadForm.reset();
  if (dom.uploadAudio) dom.uploadAudio.value = '';
  if (dom.uploadFolder) dom.uploadFolder.value = '';
  if (dom.uploadCover) dom.uploadCover.value = '';
  resetCoverPreview();
  queue = [];
  uploadPhase = 'select';
  stopRequested = false;
  metaToken += 1;
  dom.uploadAudioName.textContent = 'Select Multiple Songs';
  setSingleFieldsVisible(true);
  renderQueue();
  syncBulkSummary();
  setUploadProgress(null);
  setCurrentLine('');
  setSummary('');
  setMessage(dom.uploadError, '');
  setMessage(dom.uploadStatus, '');
  syncUploadButtons();
}

function openUpload() {
  if (!getUser()) {
    afterLogin = 'upload';
    openAuth({ reason: 'upload' });
    return;
  }
  closeDialog(dom.profileModal);
  if (!uploadBusy) resetUploadForm();
  openDialog(dom.uploadModal);
}

function requestUpload() {
  if (getUser()) openUpload();
  else {
    afterLogin = 'upload';
    openAuth({ reason: 'upload' });
  }
}

function filenameInfo(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const split = base.match(/^(.{1,80}?)\s+-\s+(.+)$/);
  return split ? { artist: split[1].trim(), title: split[2].trim() } : { artist: '', title: base || 'Untitled Track' };
}
function cleanQueueTitle(name) { return filenameInfo(name).title; }

async function handleAudioPicked(directFiles = null, { fromFolder = false } = {}) {
  if (uploadBusy) return;
  let picked = Array.isArray(directFiles) ? directFiles : Array.from(dom.uploadAudio.files || []);
  if (fromFolder) {
    picked = picked.filter((f) => !validateAudioFile(f));
    if (!picked.length) {
      setMessage(dom.uploadError, 'No MP3 / audio files found in that folder.');
      return;
    }
  }
  const files = queue.length && picked.length ? [...queue.map((e) => e.file), ...picked] : picked;
  setMessage(dom.uploadError, '');
  setSummary('');
  uploadPhase = 'select';
  metaToken += 1;

  if (!files.length) {
    queue = [];
    dom.uploadAudioName.textContent = 'Select Multiple Songs';
    setSingleFieldsVisible(true);
    renderQueue();
    syncUploadButtons();
    return;
  }

  // Validate every file up front; the same file picked twice in one batch is skipped.
  const seen = new Set();
  queue = files.map((file) => {
    const entry = { file, status: 'queued', message: '' };
    const problem = validateAudioFile(file);
    if (problem) {
      entry.status = 'invalid';
      entry.message = problem;
    } else if (seen.has(fileKey(file))) {
      entry.status = 'duplicate';
      entry.message = 'selected twice';
    }
    seen.add(fileKey(file));
    return entry;
  });

  const valid = queue.filter((e) => e.status === 'queued').length;
  const skipped = queue.length - valid;
  dom.uploadAudioName.textContent =
    queue.length === 1
      ? queue[0].file.name
      : `${plural(queue.length, 'file')} selected` + (skipped ? ` (${skipped} will be skipped)` : '');

  const single = queue.length === 1;
  setSingleFieldsVisible(single);
  renderQueue();
  syncUploadButtons();

  if (!single) {
    const token = metaToken;
    for (const entry of queue) {
      if (entry.status !== 'queued') continue;
      const meta = await namesFor(entry.file);
      if (token !== metaToken) return;
      entry.title = meta.title || cleanQueueTitle(entry.file.name);
      entry.artist = meta.artist || 'Unknown Artist';
    }
    renderQueue();
  }

  if (single) {
    const only = queue[0];
    if (only.status === 'invalid') {
      setMessage(dom.uploadError, only.message);
      return;
    }
    // One song: pre-fill title / artist / cover from its own tags so the person can edit them.
    const fallback = filenameInfo(only.file.name);
    dom.uploadTitle.value = fallback.title;
    dom.uploadArtist.value = fallback.artist;
    resetCoverPreview();
    if (!deps.readMetadata) return;
    const token = metaToken;
    try {
      const meta = await withTimeout(deps.readMetadata(only.file));
      if (token !== metaToken) return;
      if (meta.title) dom.uploadTitle.value = meta.title;
      if (meta.artist && meta.artist !== 'Unknown Artist') dom.uploadArtist.value = meta.artist;
      if (meta.coverBlob) {
        const thumb = deps.makeThumbnail ? await deps.makeThumbnail(meta.coverBlob, 1000) : meta.coverBlob;
        if (token === metaToken && !coverBlob) setCover(thumb || meta.coverBlob, 'Cover from MP3 (tap to change)');
      }
    } catch (err) {
      console.warn('Could not read tags from the MP3:', err);
    }
  } else if (!valid) {
    setMessage(dom.uploadError, 'None of the selected files can be uploaded. See the list for the reasons.');
  }
}

function handleCoverPicked() {
  const file = dom.uploadCover.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setMessage(dom.uploadError, 'Please choose an image file for the cover.');
    dom.uploadCover.value = '';
    return;
  }
  setMessage(dom.uploadError, '');
  setCover(file, file.name);
}

// --- Progress -----------------------------------------------------------------

function setUploadProgress(percent) {
  const box = $('upload-progress');
  if (!box) return;
  const bar = $('upload-progress-bar');
  const label = $('upload-progress-text');
  if (percent == null) {
    box.classList.add('hidden');
    box.setAttribute('aria-valuenow', '0');
    if (bar) bar.style.width = '0%';
    if (label) label.textContent = '0%';
    return;
  }
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  box.classList.remove('hidden');
  box.setAttribute('aria-valuenow', String(p));
  if (bar) bar.style.width = `${p}%`;
  if (label) label.textContent = `${p}%`;
}

function setCurrentLine(text) {
  setMessage(dom.uploadCurrent, text);
}

function setSummary(text, tone = 'info') {
  const el = dom.uploadSummary;
  if (!el) return;
  el.classList.toggle('error', tone === 'error');
  el.classList.toggle('info', tone !== 'error');
  setMessage(el, text);
}

// Buttons follow the phase: select (Upload / Cancel), running (Uploading… / Stop), done (Upload more / Close).
function syncUploadButtons() {
  const running = uploadPhase === 'running';
  const done = uploadPhase === 'done';
  const hasWork = queue.some((e) => e.status === 'queued');

  dom.uploadSubmit.classList.toggle('is-loading', running);
  dom.uploadSubmit.disabled = running;
  const queued = queue.filter((e) => e.status === 'queued').length;
  dom.uploadSubmit.textContent = running ? 'Uploading…' : done ? 'Upload more' : queue.length >= 2 ? `Upload ${plural(queued, 'song')}` : 'Upload';
  dom.uploadCancel.disabled = false;
  dom.uploadCancel.textContent = running ? (stopRequested ? 'Stopping…' : 'Stop') : done ? 'Close' : 'Cancel';
  if (running && stopRequested) dom.uploadCancel.disabled = true;
  dom.uploadCloseX.disabled = running;
  if (dom.uploadAudio) dom.uploadAudio.disabled = running;
  dom.uploadAudio?.closest('form')?.classList.toggle('is-uploading', running);
}

function setUploadBusy(busy) {
  uploadBusy = busy;
  uploadPhase = busy ? 'running' : uploadPhase;
  syncUploadButtons();
}

async function keepScreenAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* Wake Lock is optional; uploads still work without it. */
  }
}

// Waits (up to ONLINE_WAIT_MS) for the connection to come back. Returns true when online.
async function waitForOnline() {
  if (navigator.onLine) return true;
  const until = Date.now() + ONLINE_WAIT_MS;
  while (!navigator.onLine && Date.now() < until && !stopRequested) await sleep(1000);
  return navigator.onLine;
}

// --- The queue ------------------------------------------------------------------

// Works out title / artist for a file in a bulk upload (tags first, then the file name).
async function namesFor(file) {
  let title = '';
  let artist = '';
  try {
    const meta = deps.readMetadata ? await withTimeout(deps.readMetadata(file)) : null;
    if (meta) {
      title = meta.title || '';
      artist = meta.artist && meta.artist !== 'Unknown Artist' ? meta.artist : '';
    }
  } catch (err) {
    console.warn('Could not read tags from', file.name, err);
  }
  const fallback = filenameInfo(file.name);
  return { title: title || fallback.title, artist: artist || fallback.artist };
}

async function runQueue(single) {
  const work = queue.map((e, i) => i).filter((i) => queue[i].status === 'queued');
  const total = work.length;
  const uploadedNames = new Set();
  const counts = { done: 0, failed: 0, skipped: 0 };
  let lastTrack = null;

  queue.forEach((e) => {
    if (e.status === 'duplicate' || e.status === 'invalid') counts.skipped += 1;
  });

  for (let n = 0; n < total; n += 1) {
    if (stopRequested) break;
    const i = work[n];
    const entry = queue[i];
    const position = n + 1;
    const overall = (pct = 0) => setUploadProgress(((n + pct / 100) / total) * 100);
    const label = entry.file.name;

    setMessage(dom.uploadStatus, `Uploading ${position} of ${queue.length}…` + (counts.skipped ? ` (${plural(counts.skipped, 'file')} skipped)` : ''));
    setCurrentLine(label);
    setEntry(i, 'uploading');
    overall(0);

    // Decide the final name, then skip songs that are already in the library.
    const names = single ? { title: dom.uploadTitle.value.trim(), artist: dom.uploadArtist.value.trim() } : await namesFor(entry.file);
    const fileName = buildFileName({ ...names, audioFile: entry.file });
    const lower = fileName.toLowerCase();
    if (findCloudDuplicate(fileName) || uploadedNames.has(lower)) {
      counts.skipped += 1;
      setEntry(i, 'duplicate');
      continue;
    }

    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !stopRequested; attempt += 1) {
      try {
        if (!(await waitForOnline())) throw new Error('No internet connection.');
        setCurrentLine(`${label}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
        lastTrack = await uploadSong({
          ...names,
          audioFile: entry.file,
          onProgress: (pct) => {
            overall(pct);
            setCurrentLine(`${label} — ${pct}%`);
            if (queue[i].status === 'uploading') queue[i].message = `${pct}%`;
            updateQueueRow(i);
          }
        });
        ok = true;
        break;
      } catch (err) {
        console.warn(`Upload failed for ${label} (attempt ${attempt}):`, err);
        if (attempt < MAX_ATTEMPTS && isRetryableError(err) && !stopRequested) {
          setEntry(i, 'uploading', 'retrying…');
          await sleep(1500 * attempt);
          continue;
        }
        counts.failed += 1;
        setEntry(i, 'failed', String(err?.message || friendlyError(err)));
        break;
      }
    }

    if (ok) {
      counts.done += 1;
      uploadedNames.add(lower);
      setEntry(i, 'done');
      // Attach cover image for this uploaded song (embedded ID3 cover or fetched cover art)
      if (lastTrack) {
        (async () => {
          try {
            let artSaved = false;
            if (single && coverBlob instanceof Blob) {
              const dataUrl = await new Promise((res) => {
                const r = new FileReader();
                r.onload = () => res(typeof r.result === 'string' ? r.result : '');
                r.onerror = () => res('');
                r.readAsDataURL(coverBlob);
              });
              if (dataUrl) {
                saveCustomCover(lastTrack.id, dataUrl);
                artSaved = true;
              }
            } else if (!single && deps.readMetadata) {
              const meta = await deps.readMetadata(entry.file).catch(() => null);
              if (meta?.coverBlob instanceof Blob) {
                const thumb = deps.makeThumbnail ? await deps.makeThumbnail(meta.coverBlob, 400) : meta.coverBlob;
                const dataUrl = await new Promise((res) => {
                  const r = new FileReader();
                  r.onload = () => res(typeof r.result === 'string' ? r.result : '');
                  r.onerror = () => res('');
                  r.readAsDataURL(thumb || meta.coverBlob);
                });
                if (dataUrl) {
                  saveCustomCover(lastTrack.id, dataUrl);
                  artSaved = true;
                }
              }
            }
            if (!artSaved) {
              const fetched = await fetchCoverArtForTrack(lastTrack);
              if (fetched) {
                lastTrack.coverUrl = fetched;
                saveCustomCover(lastTrack.id, fetched);
                artSaved = true;
              }
            }
            if (artSaved) {
              document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
            }
          } catch { /* cover is optional */ }
        })();
      }
    } else if (queue[i].status === 'uploading') {
      setEntry(i, 'stopped'); // stopped during a retry wait
    }
    overall(100);
  }

  // Anything still waiting was not uploaded because the person pressed Stop.
  queue.forEach((e, i) => {
    if (e.status === 'queued') setEntry(i, 'stopped');
  });
  const notUploaded = queue.filter((e) => e.status === 'stopped').length;

  return { counts, notUploaded, lastTrack, total };
}

async function handleUploadSubmit(e) {
  e.preventDefault();
  try {
    await submitUpload();
  } catch (err) {
    // Never fail silently: show what went wrong and get the buttons working again.
    console.error('Upload could not start:', err);
    uploadBusy = false;
    stopRequested = false;
    uploadPhase = 'select';
    keepScreenAwake(false);
    setUploadProgress(null);
    setCurrentLine('');
    setMessage(dom.uploadStatus, '');
    syncUploadButtons();
    setMessage(dom.uploadError, friendlyError(err) || 'Upload failed. Please try again.');
  }
}

async function submitUpload() {
  if (uploadBusy) return;

  if (uploadPhase === 'done') {
    resetUploadForm(); // "Upload more"
    return;
  }

  setMessage(dom.uploadError, '');
  setSummary('');

  if (!queue.length) {
    const fallbackFiles = [
      ...Array.from(dom.uploadAudio?.files || []),
      ...Array.from(dom.uploadFolder?.files || [])
    ];
    if (fallbackFiles.length) {
      await handleAudioPicked(fallbackFiles);
    }
  }
  if (!queue.length) return setMessage(dom.uploadError, 'Please choose one or more audio files.');
  const ready = queue.filter((x) => x.status === 'queued');
  if (!ready.length) return setMessage(dom.uploadError, 'None of the selected files can be uploaded.');

  const single = queue.length === 1;
  if (single) {
    if (!dom.uploadTitle.value.trim()) return setMessage(dom.uploadError, 'Please enter a song title.');
    if (!dom.uploadArtist.value.trim()) return setMessage(dom.uploadError, 'Please enter the artist name.');
  }

  stopRequested = false;
  requestAppNotification();
  setUploadBusy(true);
  setUploadProgress(0);
  setMessage(dom.uploadStatus, 'Starting… keep this screen open.');
  keepScreenAwake(true);

  let result;
  try {
    result = await runQueue(single);
  } catch (err) {
    console.error('Upload queue crashed:', err);
    setMessage(dom.uploadError, friendlyError(err));
    queue.forEach((x, i) => {
      if (x.status === 'queued' || x.status === 'uploading') setEntry(i, 'stopped');
    });
    result = { counts: { done: 0, failed: 0, skipped: 0 }, notUploaded: 0, lastTrack: null, total: 0 };
  } finally {
    uploadBusy = false;
    keepScreenAwake(false);
  }

  const { counts, notUploaded, lastTrack } = result;

  // One song that did not upload: show why and let the person edit and try again.
  if (single && counts.done === 0 && queue[0].status !== 'stopped') {
    const entry = queue[0];
    const reason =
      entry.status === 'duplicate'
        ? 'This song is already in your library. Change the title or artist to upload it again.'
        : entry.message || 'Upload failed.';
    setEntry(0, 'queued');
    uploadPhase = 'select';
    setMessage(dom.uploadStatus, '');
    setCurrentLine('');
    setUploadProgress(null);
    syncUploadButtons();
    setMessage(dom.uploadError, reason);
    return;
  }

  uploadPhase = 'done';
  setMessage(dom.uploadStatus, '');
  setCurrentLine('');
  setUploadProgress(null);
  syncUploadButtons();

  // One song uploaded successfully: behave like before (close + toast).
  if (single && counts.done === 1 && lastTrack) {
    if (coverBlob instanceof Blob) {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            saveCustomCover(lastTrack.id, reader.result);
            document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
          }
        };
        reader.readAsDataURL(coverBlob);
      } catch { /* optional cover */ }
    }
    closeDialog(dom.uploadModal);
    resetUploadForm();
    toast(`"${lastTrack.title}" is live for everyone`);
    document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
    return;
  }

  const parts = [`${counts.done} uploaded`];
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (notUploaded) parts.push(`${notUploaded} not uploaded`);
  const headline = `${stopRequested ? 'Stopped' : 'Finished'}: ${parts.join(' • ')}`;
  const tail = counts.failed ? ' Failed songs are marked in the list — pick them again to retry.' : '';
  setSummary(headline + (counts.failed ? '.' : '') + tail, counts.failed ? 'error' : 'info');
  toast(headline);
  if (counts.done > 0) notifyAppEvent('SoundWave', `${counts.done} songs uploaded to Cloud`);
  document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
}

function handleCancelClick() {
  // While uploading, the Cancel button becomes "Stop": finish the current file, skip the rest.
  if (uploadPhase === 'running' && uploadBusy) {
    stopRequested = true;
    syncUploadButtons();
  }
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

export function initAccountUI({ readMetadata, makeThumbnail } = {}) {
  deps = { readMetadata, makeThumbnail };

  Object.assign(dom, {
    profileBtn: $('profile-btn'),
    avatarInitial: $('avatar-initial'),

    authModal: $('auth-modal'),
    authForm: $('auth-form'),
    authTitle: $('auth-title'),
    authSubtitle: $('auth-subtitle'),
    authTabs: Array.from(document.querySelectorAll('.auth-tab[data-mode]')),
    authEmail: $('auth-email'),
    authPassword: $('auth-password'),
    authError: $('auth-error'),
    authInfo: $('auth-info'),
    authSubmit: $('auth-submit'),
    authSwitch: $('auth-switch'),

    profileModal: $('profile-modal'),
    profileEmail: $('profile-email'),
    profileInitial: $('profile-initial'),
    profileUploadBtn: $('profile-upload-btn'),
    uploadsList: $('my-uploads-list'),
    uploadsCount: $('my-uploads-count'),
    logoutBtn: $('logout-btn'),

    uploadModal: $('upload-modal'),
    uploadForm: $('upload-form'),
    uploadSingleFields: $('upload-single-fields'),
    uploadQueue: $('upload-queue'),
    uploadBulkSummary: $('upload-bulk-summary'),
    uploadBulkCount: $('upload-bulk-count'),
    uploadClearAll: $('upload-clear-all'),
    uploadAddMore: $('upload-add-more'),
    uploadCurrent: $('upload-current'),
    uploadSummary: $('upload-summary'),
    uploadTitle: $('upload-title'),
    uploadArtist: $('upload-artist'),
    uploadAudio: $('upload-audio'),
    uploadFolder: $('upload-folder'),
    uploadAudioName: $('upload-audio-name'),
    uploadCover: $('upload-cover'),
    uploadCoverName: $('upload-cover-name'),
    uploadCoverPreview: $('upload-cover-preview'),
    uploadError: $('upload-error'),
    uploadStatus: $('upload-status'),
    uploadSubmit: $('upload-submit'),
    uploadCancel: $('upload-cancel'),
    uploadCloseX: $('upload-close-x')
  });

  // Close buttons + tapping the dark backdrop
  document.querySelectorAll('dialog.glass-modal').forEach((dialog) => {
    dialog.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (dialog === dom.uploadModal && uploadBusy) return;
        closeDialog(dialog);
      });
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && !(dialog === dom.uploadModal && uploadBusy)) closeDialog(dialog);
    });
    dialog.addEventListener('cancel', (e) => {
      if (dialog === dom.uploadModal && uploadBusy) e.preventDefault();
    });
  });

  // Profile icon
  dom.profileBtn?.addEventListener('click', handleProfileButton);

  // Auth
  dom.authTabs.forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
  dom.authSwitch?.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  dom.authForm?.addEventListener('submit', handleAuthSubmit);

  // Profile
  dom.profileUploadBtn?.addEventListener('click', requestUpload);
  dom.logoutBtn?.addEventListener('click', handleLogout);
  const playUploadRow = (row) => {
    if (!row) return;
    const mine = getMyUploads();
    const idx = Number(row.dataset.index);
    if (!mine[idx]) return;
    closeDialog(dom.profileModal);
    player.playList(mine, idx);
  };
  const deleteUpload = async (btn) => {
    const id = btn?.dataset.trackId;
    const track = getMyUploads().find((t) => t.id === id);
    if (!track) return;
    if (!window.confirm(`Delete "${track.title}" from SoundWave Cloud? This removes it for everyone.`)) return;
    btn.disabled = true;
    try {
      await deleteCloudTrack(track.id);
      if (isSaved(track.id)) await removeOfflineCopy(track.id); // drop the saved offline copy too
      removeFavorite(track.id);
      forgetCover(track.id);
      player.removeTrackEverywhere(track.id);
      toast('Song deleted');
      document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
    } catch (err) {
      console.error('Delete failed:', err);
      btn.disabled = false;
      toast(`Could not delete: ${friendlyError(err)}`);
    }
  };
  dom.uploadsList?.addEventListener('click', (e) => {
    const dots = e.target.closest('.upload-dots-btn');
    if (dots) {
      e.stopPropagation();
      const wrap = dots.closest('.track-menu-wrap');
      const menu = wrap?.querySelector('.track-dropdown');
      const willOpen = menu?.classList.contains('hidden');
      dom.uploadsList.querySelectorAll('.track-dropdown:not(.hidden)').forEach((el) => {
        el.classList.add('hidden');
        el.closest('.upload-row')?.classList.remove('menu-open');
      });
      if (willOpen && menu) {
        menu.classList.remove('hidden');
        dots.closest('.upload-row')?.classList.add('menu-open');
      }
      return;
    }
    const editCover = e.target.closest('.upload-cover-edit-btn');
    if (editCover) {
      e.stopPropagation();
      editCover.closest('.track-dropdown')?.classList.add('hidden');
      editCover.closest('.upload-row')?.classList.remove('menu-open');
      document.dispatchEvent(new CustomEvent('soundwave:changecover', { detail: { trackId: editCover.dataset.coverTrackId } }));
      return;
    }
    const del = e.target.closest('.upload-delete-btn');
    if (del) {
      e.stopPropagation();
      del.closest('.track-dropdown')?.classList.add('hidden');
      del.closest('.upload-row')?.classList.remove('menu-open');
      deleteUpload(del);
      return;
    }
    if (e.target.closest('.track-dropdown')) {
      e.stopPropagation();
      return;
    }
    playUploadRow(e.target.closest('.upload-row'));
  });
  dom.uploadsList?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('.upload-delete-btn')) playUploadRow(e.target.closest('.upload-row'));
  });

  // Upload
  const onAudioInput = () => {
    const picked = Array.from(dom.uploadAudio?.files || []);
    if (!picked.length) return;
    dom.uploadAudio.value = '';
    handleAudioPicked(picked).catch((err) => { console.error(err); setMessage(dom.uploadError, friendlyError(err)); });
  };
  const onFolderInput = () => {
    const folderFiles = Array.from(dom.uploadFolder?.files || []);
    if (!folderFiles.length) return;
    dom.uploadFolder.value = '';
    handleAudioPicked(folderFiles, { fromFolder: true }).catch((err) => { console.error(err); setMessage(dom.uploadError, friendlyError(err)); });
  };
  dom.uploadAudio?.addEventListener('change', onAudioInput);
  dom.uploadAudio?.addEventListener('input', onAudioInput);
  dom.uploadFolder?.addEventListener('change', onFolderInput);
  dom.uploadFolder?.addEventListener('input', onFolderInput);
  dom.uploadModal?.addEventListener('dragover', (e) => {
    if (!uploadBusy) e.preventDefault();
  });
  dom.uploadModal?.addEventListener('drop', (e) => {
    if (uploadBusy || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    const dt = new DataTransfer();
    const existing = queue.map((q) => q.file);
    [...existing, ...Array.from(e.dataTransfer.files)].forEach((f) => dt.items.add(f));
    dom.uploadAudio.files = dt.files;
    handleAudioPicked();
  });
  dom.uploadAddMore?.addEventListener('click', () => {
    if (!uploadBusy) { dom.uploadAudio.value = ''; dom.uploadAudio.click(); }
  });
  dom.uploadClearAll?.addEventListener('click', () => {
    if (uploadBusy) return;
    queue = []; dom.uploadAudio.value = ''; dom.uploadAudioName.textContent = 'Select Multiple Songs';
    setSingleFieldsVisible(true); renderQueue(); syncUploadButtons(); setMessage(dom.uploadError, '');
  });
  dom.uploadQueue?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn || uploadBusy) return;
    queue.splice(Number(btn.dataset.remove), 1);
    if (queue.length === 1) {
      setSingleFieldsVisible(true);
      const one = queue[0]; dom.uploadTitle.value = one.title || cleanQueueTitle(one.file.name);
      dom.uploadArtist.value = one.artist || '';
    }
    renderQueue(); syncUploadButtons();
    dom.uploadAudioName.textContent = queue.length ? `${queue.length} file${queue.length === 1 ? '' : 's'} selected` : 'Select Multiple Songs';
  });
  dom.uploadCover?.addEventListener('change', handleCoverPicked);
  dom.uploadForm?.addEventListener('submit', handleUploadSubmit);
  dom.uploadCancel?.addEventListener('click', handleCancelClick);

  // Warn before leaving the page in the middle of a bulk upload.
  window.addEventListener('beforeunload', (ev) => {
    if (uploadBusy) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  // Any "Upload" button elsewhere in the app just fires this event
  document.addEventListener('soundwave:openupload', requestUpload);

  // Keep UI in sync with login state / feed changes
  document.addEventListener('soundwave:authchange', () => {
    updateAvatar();
    if (!getUser()) closeDialog(dom.profileModal);
  });
  document.addEventListener('soundwave:cloudchange', () => {
    if (dom.profileModal?.open) renderMyUploads();
  });

  updateAvatar();
  initCloud(); // start loading the SDK + feed + restoring the saved session
}
