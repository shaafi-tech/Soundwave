// ============================================================================
// SoundWave — Pro Suite: Dynamic Liquid Glass Themes, 8D Audio Auto-Panner
// & Full Library Backup / Restore (js/pro-features.js)
// ============================================================================

import { toast } from './util.js?v=pro35';
import * as eq from './equalizer.js?v=pro35';

const THEME_KEY = 'soundwave_theme_v1';

export const LIQUID_THEMES = {
  crimson: {
    name: 'Crimson Rose',
    accent: '#fa233b',
    accent2: '#ff477e',
    glow: 'rgba(250, 35, 59, 0.24)'
  },
  indigo: {
    name: 'Midnight Indigo',
    accent: '#6366f1',
    accent2: '#818cf8',
    glow: 'rgba(99, 102, 241, 0.26)'
  },
  emerald: {
    name: 'Emerald Glass',
    accent: '#10b981',
    accent2: '#34d399',
    glow: 'rgba(16, 185, 129, 0.24)'
  },
  amber: {
    name: 'Sunset Gold',
    accent: '#f59e0b',
    accent2: '#fbbf24',
    glow: 'rgba(245, 158, 11, 0.24)'
  },
  violet: {
    name: 'Royal Violet',
    accent: '#a855f7',
    accent2: '#c084fc',
    glow: 'rgba(168, 85, 247, 0.26)'
  }
};

export function getActiveTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved && LIQUID_THEMES[saved] ? saved : 'crimson';
  } catch {
    return 'crimson';
  }
}

export function applyLiquidTheme(key) {
  const th = LIQUID_THEMES[key] || LIQUID_THEMES.crimson;
  const root = document.documentElement;
  root.style.setProperty('--accent-primary', th.accent);
  root.style.setProperty('--accent-hover', th.accent2);
  root.style.setProperty('--sw-ambient-glow', th.glow);
  try {
    localStorage.setItem(THEME_KEY, key);
  } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent('soundwave:themechange', { detail: { key, theme: th } }));
}

// ----------------------------------------------------------------------------
// 8D Audio Auto-Panner (smooth L/R circular spatial sweep via equalizer.setBalance)
// ----------------------------------------------------------------------------

let pan8dTimer = null;
let pan8dPhase = 0;
let pan8dEnabled = false;

export function is8DAudioEnabled() {
  return pan8dEnabled;
}

export function set8DAudioEnabled(on) {
  pan8dEnabled = Boolean(on);
  if (pan8dTimer) {
    clearInterval(pan8dTimer);
    pan8dTimer = null;
  }
  if (!pan8dEnabled) {
    eq.setBalance(0);
    return;
  }
  pan8dTimer = setInterval(() => {
    const audio = document.getElementById('audio-engine');
    if (!audio || audio.paused) return;
    pan8dPhase += 0.08;
    const val = Math.round(Math.sin(pan8dPhase) * 85);
    eq.setBalance(val);
  }, 80);
}

// ----------------------------------------------------------------------------
// Full Settings, Playlists, Favorites, EQ & Stats Backup / Restore
// ----------------------------------------------------------------------------

const BACKUP_KEYS = [
  'soundwave_favorites_v1',
  'soundwave_playlists_v1',
  'soundwave_eq_settings_v2',
  'soundwave_playback_prefs_v1',
  'soundwave_stats_v1',
  'soundwave_tag_overrides_v1',
  'soundwave_theme_v1'
];

export function exportFullBackup() {
  const payload = {
    app: 'SoundWave Pro',
    version: 33,
    exportedAt: new Date().toISOString(),
    data: {}
  };
  BACKUP_KEYS.forEach((k) => {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) payload.data[k] = v;
    } catch { /* ignore */ }
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `soundwave-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Full SoundWave backup exported');
}

export async function importFullBackup(file) {
  if (!file) return false;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed.data !== 'object') {
      toast('Invalid backup file');
      return false;
    }
    let count = 0;
    Object.entries(parsed.data).forEach(([k, v]) => {
      if (BACKUP_KEYS.includes(k) && typeof v === 'string') {
        localStorage.setItem(k, v);
        count += 1;
      }
    });
    applyLiquidTheme(getActiveTheme());
    toast(`Restored ${count} settings — reloading library`);
    document.dispatchEvent(new CustomEvent('soundwave:librarychange'));
    return true;
  } catch {
    toast('Could not read backup file');
    return false;
  }
}

export function initProFeatures() {
  applyLiquidTheme(getActiveTheme());
}
