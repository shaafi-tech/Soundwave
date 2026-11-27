// ============================================================================
// SoundWave — Network state + resilient fetch (js/network.js)
// ----------------------------------------------------------------------------
// - isOnline() / onNetworkChange(): one place that knows if the device is online
// - waitForOnline(): resolves when the connection comes back
// - fetchWithRetry(): timeout + abort + automatic retry with back-off
// - initNetwork(): shows / hides the "You're offline" banner and toasts
// ============================================================================

import { toast } from './util.js?v=pro35';

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
const listeners = new Set();
let initialized = false;

export const isOnline = () => online;

export function onNetworkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyState(next, { announce = true } = {}) {
  const changed = next !== online;
  online = next;
  document.body.classList.toggle('is-offline', !online);
  const banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('hidden', online);
  if (!changed) return;
  if (announce) toast(online ? 'Back online' : "You're offline — saved songs still play");
  listeners.forEach((fn) => {
    try { fn(online); } catch (err) { console.warn('network listener failed:', err); }
  });
}

export function initNetwork() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('online', () => applyState(true));
  window.addEventListener('offline', () => applyState(false));
  applyState(navigator.onLine !== false, { announce: false });
}

export function waitForOnline(timeoutMs = 0) {
  if (online) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const off = onNetworkChange((isUp) => {
      if (!isUp) return;
      off();
      if (timer) clearTimeout(timer);
      resolve(true);
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TimeoutError extends Error {
  constructor(message = 'The request timed out.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

// fetch() with: per-attempt timeout, an optional outside AbortSignal, and
// retries on network errors / 408 / 429 / 5xx. 4xx answers are returned as-is.
export async function fetchWithRetry(url, { retries = 2, timeout = 12000, signal, backoff = 500, ...init } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!online) {
      const back = await waitForOnline(15000);
      if (!back) throw new Error("You're offline. Check your connection and try again.");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok || (response.status < 500 && response.status !== 408 && response.status !== 429)) {
        return response;
      }
      lastError = new Error(`Server answered ${response.status}`);
    } catch (err) {
      if (signal?.aborted) throw err; // the caller cancelled: never retry
      lastError = timedOut ? new TimeoutError() : err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (attempt < retries) await sleep(backoff * (attempt + 1));
  }
  throw lastError || new Error('Network request failed.');
}
