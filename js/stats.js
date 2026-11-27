// ============================================================================
// SoundWave — Listening Analytics, Play Counts & Smart Insights (js/stats.js)
// ============================================================================

import { escapeHtml, coverFor, imgFallbackAttr } from './util.js?v=pro35';

const STATS_KEY = 'soundwave_stats_v1';

function loadStats() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        totalSeconds: Number(raw.totalSeconds) || 0,
        totalPlays: Number(raw.totalPlays) || 0,
        tracks: raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {},
        artists: raw.artists && typeof raw.artists === 'object' ? raw.artists : {}
      };
    }
  } catch { /* ignore */ }
  return { totalSeconds: 0, totalPlays: 0, tracks: {}, artists: {} };
}

function saveStats(data) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(data));
  } catch { /* ignore quota */ }
}

export function recordTrackPlay(track) {
  if (!track || !track.id) return;
  const data = loadStats();
  data.totalPlays += 1;
  const prev = data.tracks[track.id] || { count: 0, title: track.title || 'Untitled', artist: track.artist || 'Unknown Artist' };
  data.tracks[track.id] = {
    count: prev.count + 1,
    title: track.title || prev.title,
    artist: track.artist || prev.artist,
    lastPlayed: Date.now()
  };
  const artistName = String(track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
  data.artists[artistName] = (data.artists[artistName] || 0) + 1;
  saveStats(data);
}

export function addListeningSeconds(sec) {
  const s = Number(sec) || 0;
  if (s <= 0 || s > 60) return;
  const data = loadStats();
  data.totalSeconds += s;
  saveStats(data);
}

export function getStatsSnapshot() {
  return loadStats();
}

export function getMostPlayedTracks(allTracks = [], limit = 25) {
  const data = loadStats();
  const byId = new Map(allTracks.map((t) => [t.id, t]));
  return Object.entries(data.tracks)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .map(([id, info]) => {
      const found = byId.get(id);
      return found ? { ...found, playCount: info.count } : null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

export function clearStats() {
  try {
    localStorage.removeItem(STATS_KEY);
  } catch { /* ignore */ }
}

function formatDurationHuman(totalSec) {
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

export function renderStatsModal(allTracks = []) {
  const body = document.getElementById('stats-modal-body');
  if (!body) return;
  const data = loadStats();
  const topTracks = getMostPlayedTracks(allTracks, 5);
  const topArtists = Object.entries(data.artists)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const maxArtistPlays = topArtists.length ? Math.max(1, topArtists[0][1]) : 1;

  body.innerHTML = `
    <div class="stats-kpi-grid">
      <div class="stats-kpi-card">
        <span class="stats-kpi-val">${data.totalPlays}</span>
        <span class="stats-kpi-lbl">Total Plays</span>
      </div>
      <div class="stats-kpi-card">
        <span class="stats-kpi-val">${formatDurationHuman(data.totalSeconds)}</span>
        <span class="stats-kpi-lbl">Listening Time</span>
      </div>
      <div class="stats-kpi-card">
        <span class="stats-kpi-val">${allTracks.length}</span>
        <span class="stats-kpi-lbl">Library Songs</span>
      </div>
    </div>

    <div class="stats-section">
      <h3 class="stats-heading">Top Artists</h3>
      ${topArtists.length
        ? topArtists.map(([name, count]) => `
            <div class="stats-bar-row">
              <div class="stats-bar-top">
                <span class="stats-bar-name">${escapeHtml(name)}</span>
                <span class="stats-bar-count">${count} play${count === 1 ? '' : 's'}</span>
              </div>
              <div class="stats-bar-track">
                <div class="stats-bar-fill" style="width:${Math.max(8, Math.round((count / maxArtistPlays) * 100))}%"></div>
              </div>
            </div>`).join('')
        : '<p class="online-note">Play a few songs to see your Top Artists.</p>'}
    </div>

    <div class="stats-section">
      <h3 class="stats-heading">Most Played Songs</h3>
      ${topTracks.length
        ? `<div class="stats-top-list">${topTracks.map((t, i) => `
            <div class="stats-track-item" data-stats-play="${escapeHtml(t.id)}">
              <span class="stats-rank">${i + 1}</span>
              <img class="stats-thumb" src="${escapeHtml(coverFor(t))}" alt="" onerror="${imgFallbackAttr(t.title)}">
              <div class="stats-track-meta">
                <span class="stats-track-title">${escapeHtml(t.title)}</span>
                <span class="stats-track-artist">${escapeHtml(t.artist)}</span>
              </div>
              <span class="stats-pill">${t.playCount}x</span>
            </div>`).join('')}</div>`
        : '<p class="online-note">Your most replayed tracks will appear here.</p>'}
    </div>
  `;
}
