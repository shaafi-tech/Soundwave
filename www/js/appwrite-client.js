// ============================================================================
// SoundWave — Shared Appwrite client (js/appwrite-client.js)
// ----------------------------------------------------------------------------
// The Appwrite Web SDK is loaded from a CDN <script> tag in index.html and the
// project settings live in window.SOUNDWAVE_APPWRITE (also in index.html).
// This module creates ONE client that auth.js (Account) and cloud.js (Storage)
// both share. If the main CDN is blocked, a second CDN is tried.
// ============================================================================

const cfg = window.SOUNDWAVE_APPWRITE || {};

export const APPWRITE_ENDPOINT = cfg.endpoint || 'https://sgp.cloud.appwrite.io/v1';
export const APPWRITE_PROJECT = cfg.projectId || '6b07edaf0008c5c436be';
export const BUCKET = cfg.bucketId || '6b07edd600041a5f035f';

const SDK_FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/npm/appwrite@17.0.0/dist/iife/sdk.js',
  'https://unpkg.com/appwrite@17.0.0/dist/iife/sdk.js'
];

let instance = null;
let pending = null;

function loadScript(url) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(true);
    s.onerror = () => {
      s.remove();
      resolve(false);
    };
    document.head.appendChild(s);
  });
}

async function ensureSdk() {
  if (window.Appwrite?.Client) return true;
  for (const url of SDK_FALLBACK_URLS) {
    await loadScript(url);
    if (window.Appwrite?.Client) return true;
  }
  return false;
}

// Resolves to { sdk, client, account, storage }. Rejects if the SDK cannot load.
export function getAppwrite() {
  if (instance) return Promise.resolve(instance);
  if (pending) return pending;

  pending = (async () => {
    if (!(await ensureSdk())) {
      throw new Error('Appwrite SDK did not load. Check your internet connection.');
    }
    const sdk = window.Appwrite;
    const client = new sdk.Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT);
    instance = {
      sdk,
      client,
      account: new sdk.Account(client),
      storage: new sdk.Storage(client)
    };
    return instance;
  })();

  // Allow another attempt later if loading failed (e.g. the phone was offline).
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
