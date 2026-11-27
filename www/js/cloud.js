// ============================================================================
// SoundWave — Appwrite Cloud Storage (js/cloud.js)
// ----------------------------------------------------------------------------
// Lists, uploads (with progress), streams and deletes MP3 files in the
// Appwrite "Music" bucket. Sign-in (email + password) lives in auth.js and the
// shared Appwrite client lives in appwrite-client.js.
// ============================================================================
import * as localAuth from './auth.js?v=pro35';
import { getAppwrite, APPWRITE_ENDPOINT, APPWRITE_PROJECT, BUCKET } from './appwrite-client.js?v=pro35';

export { APPWRITE_ENDPOINT, APPWRITE_PROJECT, BUCKET };
export const MAX_UPLOAD_MB = 100;

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|aac|opus|flac)$/i;
const MIME_BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac' };
export const SUPPORTED_AUDIO_LABEL = 'MP3, M4A, WAV, OGG or AAC';

// Returns '' when the file can be uploaded, otherwise a short reason.
// The extension list matches what the library lists back, so an uploaded song never "disappears".
export function validateAudioFile(file) {
  if (!file) return 'No file selected.';
  if (!file.size) return 'The file is empty.';
  const name = String(file.name || '');
  const t = String(file.type || '').toLowerCase();
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
  const hasAudioExt = AUDIO_EXT.test(name);
  const hasAudioMime = t.startsWith('audio/');
  // Reject obvious non-audio types (images, video, text, pdf, zip, apk, etc.)
  if (t && !hasAudioMime && t !== 'application/octet-stream' && t !== 'video/mp4') {
    return 'This is not an audio file.';
  }
  // If the file has a visible extension, require it to be an audio extension;
  // if Android DocumentsUI gave a content ID with no extension, allow it when MIME is audio/octet-stream/empty.
  if (hasExt && !hasAudioExt && !hasAudioMime) {
    return `Not a supported audio file (use ${SUPPORTED_AUDIO_LABEL}).`;
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `Larger than ${MAX_UPLOAD_MB} MB.`;
  return '';
}

// Network drops, rate limits and server hiccups are worth another try; permission errors are not.
export function isRetryableError(err) {
  const code = Number(err?.code) || 0;
  const msg = String(err?.message || err || '');
  if (/failed to fetch|networkerror|network request failed|load failed|timeout|offline/i.test(msg)) return true;
  return code === 429 || code === 408 || code >= 500;
}

let storage = null;
let sdk = null;
let cloudTracks = [];
let ready = false;
let initPromise = null;
let listError = '';

const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

// ----------------------------------------------------------------------- init
export function initCloud() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const aw = await getAppwrite();
      sdk = aw.sdk;
      storage = aw.storage;

      // Confirm the saved login in the background while the song list loads.
      localAuth.restoreSession().then((user) => emit('soundwave:authchange', { user }));

      await refreshCloudTracks();
      return true;
    } catch (err) {
      console.warn('Appwrite init failed:', err);
      ready = true;
      emit('soundwave:cloudchange');
      initPromise = null; // allow a retry later (e.g. on the next upload)
      return false;
    }
  })();
  return initPromise;
}

export const isCloudAvailable = () => !!storage;
export const isCloudPending = () => !ready;

// ----------------------------------------------------------------------- auth
export const getUser = () => localAuth.getLocalUser();
export const signIn = async (email, password) => {
  const user = await localAuth.signIn(email, password);
  emit('soundwave:authchange', { user });
  return user;
};
export const signUp = async (email, password) => {
  const result = await localAuth.signUp(email, password);
  emit('soundwave:authchange', { user: result.user });
  return result;
};
export const signOut = async () => {
  await localAuth.signOut();
  emit('soundwave:authchange', { user: null });
};

// --------------------------------------------------------------------- errors
export function friendlyError(err) {
  if (err?.friendly) return err.message; // already worded for the user (auth.js)
  const code = Number(err?.code) || 0;
  const type = String(err?.type || '');
  const msg = String(err?.message || err || '');

  if (/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) {
    return 'Network problem. Check your internet connection and try again.';
  }
  if (code === 401 || type === 'user_unauthorized' || /not authorized|missing scope/i.test(msg)) {
    return 'Appwrite rejected this action. In the Appwrite Console, give the "Music" bucket Create, Read and Delete permissions for "Any".';
  }
  if (code === 404 || type === 'storage_bucket_not_found') {
    return 'Appwrite bucket not found. Check the bucket ID and that this app\'s platform is added in the console.';
  }
  if (code === 413 || type === 'storage_invalid_file_size') {
    return 'That file is too large for the Appwrite bucket. Raise the bucket\'s maximum file size or pick a smaller file.';
  }
  if (type === 'storage_file_type_unsupported') {
    return 'The Appwrite bucket does not allow this file type. Allow "mp3" in the bucket settings.';
  }
  if (code === 429) return 'Too many requests. Wait a moment and try again.';
  return msg || 'Something went wrong. Please try again.';
}

// ----------------------------------------------------------------------- URLs
function fileUrl(id, kind = 'view') {
  return `${APPWRITE_ENDPOINT}/storage/buckets/${BUCKET}/files/${encodeURIComponent(id)}/${kind}?project=${APPWRITE_PROJECT}`;
}

// "Artist - Title.mp3" is kept in the file name so it survives a reload.
function toTrack(file) {
  const name = file.name || 'Untitled Track';
  const base = name.replace(/\.[^.]+$/, '');
  const sep = base.indexOf(' - ');
  const artist = sep > 0 ? base.slice(0, sep).trim() : 'SoundWave Cloud';
  const title = sep > 0 ? base.slice(sep + 3).trim() : base;
  return {
    id: `appwrite-${file.$id}`,
    cloudId: file.$id,
    title,
    artist,
    album: artist,
    duration: 0,
    src: fileUrl(file.$id, 'view'),
    downloadUrl: fileUrl(file.$id, 'download'),
    coverSeed: name,
    isCloud: true,
    isAppwrite: true,
    isImported: false,
    fileName: name,
    size: Number(file.sizeOriginal) || 0,
    addedAt: Date.parse(file.$createdAt) || 0
  };
}

export const getCloudTracks = () => cloudTracks;
export const getMyUploads = () => cloudTracks;
export const getCloudListError = () => listError;

// ----------------------------------------------------------------------- list
export async function refreshCloudTracks() {
  if (!storage) {
    ready = true;
    return cloudTracks;
  }
  try {
    const all = [];
    let offset = 0;
    let page;
    do {
      page = await storage.listFiles(BUCKET, [
        sdk.Query.limit(100),
        sdk.Query.offset(offset)
      ]);
      all.push(...(page.files || []));
      offset += 100;
    } while ((page.files || []).length === 100);

    listError = '';
    cloudTracks = all
      .filter((f) => AUDIO_EXT.test(f.name || ''))
      .map(toTrack)
      .sort((a, b) => b.addedAt - a.addedAt);
  } catch (err) {
    console.warn('Appwrite list failed (check bucket read permissions):', err);
    listError = friendlyError(err);
  }
  ready = true;
  emit('soundwave:cloudchange');
  return cloudTracks;
}

// --------------------------------------------------------------------- upload
const cleanPart = (x) => String(x || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120);

// "Artist - Title.ext" — the name stored in Appwrite (the artist/title survive a reload).
export function buildFileName({ title, artist, audioFile } = {}) {
  const safeName = (audioFile?.name || 'track.mp3').replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = (safeName.includes('.') ? safeName.split('.').pop() : 'mp3').toLowerCase();
  const base = cleanPart(title) || safeName.replace(/\.[^.]+$/, '') || 'Untitled';
  const a = cleanPart(artist);
  return `${a ? `${a} - ${base}` : base}.${ext}`;
}

// True when a song with this stored name is already in the cloud library.
export function findCloudDuplicate(fileName) {
  const key = String(fileName || '').toLowerCase();
  return cloudTracks.some((t) => String(t.fileName || '').toLowerCase() === key);
}

// onProgress(percent 0-100) is called while the file is being sent.
export async function uploadSong({ title, artist, audioFile, onProgress } = {}) {
  if (!audioFile) throw new Error('Choose an audio file first.');
  const invalid = validateAudioFile(audioFile);
  if (invalid) throw new Error(invalid);
  if (!navigator.onLine) throw new Error('You appear to be offline. Connect to the internet and try again.');

  if (!localAuth.getLocalUser()) throw new Error('Log in to upload songs.');

  if (!storage) await initCloud();
  if (!storage) throw new Error('Could not reach Appwrite. Check your connection and try again.');

  const fileName = buildFileName({ title, artist, audioFile });
  const ext = fileName.split('.').pop().toLowerCase();
  const mime = audioFile.type && audioFile.type.startsWith('audio/') ? audioFile.type : MIME_BY_EXT[ext] || 'audio/mpeg';

  const named = new File([audioFile], fileName, { type: mime });
  const id = sdk.ID.unique(); // Appwrite file IDs max 36 chars

  if (typeof onProgress === 'function') onProgress(0);

  const file = await storage.createFile(
    BUCKET,
    id,
    named,
    undefined, // Bucket-level security is enabled; do not send file permissions.
    (p) => {
      if (typeof onProgress === 'function' && p && Number.isFinite(p.progress)) {
        onProgress(Math.max(0, Math.min(100, Math.round(p.progress))));
      }
    }
  );

  if (typeof onProgress === 'function') onProgress(100);

  // Show it in the library straight away (no need to wait for a list refresh).
  const track = toTrack({ ...file, name: fileName });
  cloudTracks = [track, ...cloudTracks.filter((t) => t.id !== track.id)];
  emit('soundwave:cloudchange');
  return track;
}

// --------------------------------------------------------------------- delete
export async function deleteCloudTrack(trackId) {
  const raw = String(trackId).replace(/^appwrite-/, '');
  if (!storage) await initCloud();
  if (!storage) throw new Error('Could not reach Appwrite. Check your connection and try again.');
  try {
    await storage.deleteFile(BUCKET, raw);
  } catch (err) {
    // Already gone on the server? Then just drop it locally.
    if (Number(err?.code) !== 404) throw err;
  }
  cloudTracks = cloudTracks.filter((t) => t.id !== `appwrite-${raw}`);
  emit('soundwave:cloudchange');
  return true;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && storage) refreshCloudTracks();
});
