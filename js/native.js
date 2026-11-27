// ============================================================================
// SoundWave — Media controls bridge (js/native.js)
// ----------------------------------------------------------------------------
// One API for notification-bar / lock-screen / headset controls:
//   * Inside the Capacitor Android app -> native plugin "MediaSession"
//     (@jofr/capacitor-media-session). It starts an Android foreground service
//     so audio keeps playing when the app is minimised or the screen locks.
//   * In a normal browser / PWA -> the Web Media Session API.
// If neither exists, every call is a safe no-op.
// ============================================================================

const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;

export const isNativeApp = Boolean(
  cap && (typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : cap.getPlatform?.() !== 'web')
);

let plugin = null;
if (isNativeApp) {
  try {
    plugin = cap.Plugins?.MediaSession || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('MediaSession') : null);
  } catch (err) {
    console.warn('Native MediaSession plugin is not available:', err);
  }
}

const webSession = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

export const hasMediaControls = Boolean(plugin || webSession);

function safe(promiseOrValue, label) {
  try {
    const result = promiseOrValue();
    if (result && typeof result.catch === 'function') result.catch((e) => console.debug(`${label} failed:`, e));
  } catch (e) {
    console.debug(`${label} failed:`, e);
  }
}

const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto', 'stop'];

// handlers: { play, pause, previoustrack, nexttrack, seekbackward, seekforward, seekto(details), stop }
export function initMediaControls(handlers = {}) {
  ACTIONS.forEach((action) => {
    const fn = handlers[action];
    if (typeof fn !== 'function') return;
    if (plugin) safe(() => plugin.setActionHandler({ action }, (details) => fn(details || {})), `setActionHandler(${action})`);
    else if (webSession) safe(() => webSession.setActionHandler(action, (details) => fn(details || {})), `setActionHandler(${action})`);
  });
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const isData = (u) => typeof u === 'string' && /^data:/i.test(u);
const isBlob = (u) => typeof u === 'string' && /^blob:/i.test(u);

const ART_SIZES = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];

function mimeFromUrl(url) {
  const clean = String(url).split(/[?#]/)[0];
  if (/\.png$/i.test(clean)) return 'image/png';
  if (/\.webp$/i.test(clean)) return 'image/webp';
  if (/\.gif$/i.test(clean)) return 'image/gif';
  if (/\.svg$/i.test(clean)) return 'image/svg+xml';
  return 'image/jpeg';
}

// Notification / lock-screen artwork must be a bitmap. SVG (our generated placeholder cover)
// is drawn on a canvas and sent as PNG so the capsule still shows a cover.
function rasterize(src, size = 512) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve('');
      }
    };
    img.onerror = () => resolve('');
    img.src = src;
  });
}

const sizedList = (src, type) => ART_SIZES.map((sizes) => ({ src, sizes, type }));

// Turns any cover URL (https / data: / blob:) into a MediaImage list the OS can use.
async function buildArtwork(src) {
  if (!src) return [];

  // Native Android plugin: the notification is built outside the WebView, so only
  // real http(s) URLs can be fetched. data: / blob: URLs are skipped there.
  if (plugin) return isHttp(src) ? [{ src, sizes: '512x512', type: mimeFromUrl(src) }] : [];

  if (isHttp(src)) return sizedList(src, mimeFromUrl(src));

  if (isData(src)) {
    const mime = (src.match(/^data:([^;,]+)/i) || [])[1] || 'image/png';
    if (/svg/i.test(mime)) {
      const png = await rasterize(src);
      return png ? sizedList(png, 'image/png') : [];
    }
    return sizedList(src, mime);
  }

  if (isBlob(src)) {
    try {
      const blob = await (await fetch(src)).blob();
      const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
      return sizedList(src, type);
    } catch {
      return [];
    }
  }

  return [];
}

function applyMetadata(meta) {
  if (plugin) safe(() => plugin.setMetadata(meta), 'setMetadata');
  else if (webSession && typeof MediaMetadata === 'function') {
    safe(() => { webSession.metadata = new MediaMetadata(meta); }, 'metadata');
  }
}

let nowToken = 0;

// Called on every track change. The text shows immediately; the cover follows as soon as
// it is ready (a newer track cancels an older cover that is still being prepared).
export function setNowPlaying(track, artworkUrl) {
  if (!track) return;
  const token = (nowToken += 1);
  const meta = {
    title: track.title || 'Untitled Track',
    artist: track.artist || 'Unknown Artist',
    album: track.album || 'SoundWave',
    artwork: []
  };
  applyMetadata(meta);

  if (!artworkUrl) return;
  buildArtwork(artworkUrl)
    .then((artwork) => {
      if (token !== nowToken || !artwork.length) return;
      applyMetadata({ ...meta, artwork });
    })
    .catch((err) => console.debug('artwork failed:', err));
}

// state: 'playing' | 'paused' | 'none'
// The native plugin only shows the notification after it is told "playing".
export function setPlaybackState(state) {
  if (plugin) safe(() => plugin.setPlaybackState({ playbackState: state }), 'setPlaybackState');
  else if (webSession) safe(() => { webSession.playbackState = state; }, 'playbackState');
}

let lastPositionAt = 0;
export function setPosition({ duration, position, playbackRate = 1 } = {}, { force = false } = {}) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  const now = Date.now();
  if (!force && now - lastPositionAt < 1000) return;
  lastPositionAt = now;
  const state = { duration, position: Math.max(0, Math.min(position, duration)), playbackRate: playbackRate || 1 };
  if (plugin) safe(() => plugin.setPositionState(state), 'setPositionState');
  else if (webSession?.setPositionState) safe(() => webSession.setPositionState(state), 'setPositionState');
}

export function clearNowPlaying() {
  setPlaybackState('none');
}

// Android 13+ hides the media notification until the user allows notifications.
// Asked once, right after the first play tap (needs @capacitor/local-notifications).
let askedNotifications = false;
export async function ensureNotificationPermission() {
  if (!isNativeApp || askedNotifications) return;
  askedNotifications = true;
  try {
    const notifications = cap.Plugins?.LocalNotifications || cap.registerPlugin('LocalNotifications');
    const status = await notifications.checkPermissions();
    if (status?.display === 'prompt' || status?.display === 'prompt-with-rationale') {
      await notifications.requestPermissions();
    }
  } catch (err) {
    console.debug('Notification permission request skipped:', err);
  }
}

// App-event notifications. Permission is requested only from an explicit user action
// (upload/download button), never automatically at page load.
let eventNotificationPermission = false;
export async function requestAppNotification() {
  if (eventNotificationPermission) return true;
  try {
    if (isNativeApp) {
      const notifications = cap.Plugins?.LocalNotifications ||
        (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('LocalNotifications') : null);
      if (!notifications) return false;
      const current = await notifications.checkPermissions();
      const granted = current?.display === 'granted' ? current : await notifications.requestPermissions();
      eventNotificationPermission = granted?.display === 'granted';
      return eventNotificationPermission;
    }
    if (typeof Notification !== 'undefined') {
      const result = Notification.permission === 'granted'
        ? 'granted'
        : Notification.permission === 'default' ? await Notification.requestPermission() : 'denied';
      eventNotificationPermission = result === 'granted';
      return eventNotificationPermission;
    }
  } catch (err) { console.debug('Notification permission unavailable:', err); }
  return false;
}

export async function notifyAppEvent(title, body) {
  try {
    if (isNativeApp) {
      const notifications = cap.Plugins?.LocalNotifications ||
        (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('LocalNotifications') : null);
      if (notifications) {
        await notifications.schedule({ notifications: [{
          id: Math.floor(Date.now() % 2147483647),
          title: String(title || 'SoundWave'),
          body: String(body || ''),
          schedule: { at: new Date(Date.now() + 250) }
        }] });
        return true;
      }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(String(title || 'SoundWave'), { body: String(body || '') });
      return true;
    }
  } catch (err) { console.debug('Could not show notification:', err); }
  document.dispatchEvent(new CustomEvent('soundwave:toast', { detail: { message: body || title } }));
  return false;
}
