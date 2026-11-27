// ============================================================================
// SoundWave — Home "Free music to discover" (js/discover.js)
// ----------------------------------------------------------------------------
// Trending / popular lists from every free source, shown under the Home page:
//   Audius (trending this week) · Jamendo (popular) · Internet Archive (most downloaded)
// Results are cached for 10 minutes so re-drawing Home never re-downloads them,
// and each source loads on its own (one failing source never blocks the others).
// ============================================================================

import { renderTrackList, bindTrackRows } from './library.js?v=pro35';
import { getFavorites } from './storage.js?v=pro35';
import { refreshPlayingState, playList } from './player.js?v=pro35';
import { fetchAudiusTrending } from './search.js?v=pro35';
import { EXTRA_SOURCES, keyPromptHtml, bindKeyPrompt } from './sources.js?v=pro35';
import { isOnline } from './network.js?v=pro35';
import { escapeHtml } from './util.js?v=pro35';

const TTL = 10 * 60 * 1000;
const SHOWN = 8;
const cache = new Map(); // provider id -> { at, tracks }

const PROVIDERS = [
  {
    id: 'audius',
    label: 'Trending on Audius',
    blurb: 'This week',
    load: (signal) => fetchAudiusTrending({ signal })
  },
  ...EXTRA_SOURCES.map((source) => ({
    id: source.id,
    label: source.trendingTitle || source.label,
    blurb: source.blurb,
    source,
    load: (signal) => source.trending({ signal })
  }))
];

const SPINNER = '<span class="spinner" aria-hidden="true"></span>';

function fresh(id) {
  const hit = cache.get(id);
  return hit && Date.now() - hit.at < TTL ? hit.tracks : null;
}

async function fillBlock(blockEl, provider, { force = false } = {}) {
  const head = (extra = '') => `
    <div class="section-header">
      <h3 class="section-title">${escapeHtml(provider.label)} <span class="source-chip">${escapeHtml(provider.blurb || '')}</span></h3>
      ${extra}
    </div>`;
  const draw = (html) => { if (blockEl.isConnected) blockEl.innerHTML = html; };

  if (provider.source?.needsKey && !provider.source.hasKey()) {
    draw(head() + keyPromptHtml(provider.source));
    bindKeyPrompt(blockEl, provider.source, () => fillBlock(blockEl, provider, { force: true }));
    return;
  }

  let tracks = force ? null : fresh(provider.id);
  if (!tracks) {
    if (!isOnline()) {
      draw(head() + '<p class="online-note">You\'re offline — free music is paused.</p>');
      return;
    }
    draw(head() + `<p class="online-note">${SPINNER}Loading…</p>`);
    try {
      tracks = (await provider.load()).slice(0, SHOWN);
      cache.set(provider.id, { at: Date.now(), tracks });
    } catch (err) {
      if (!blockEl.isConnected) return;
      console.warn(`${provider.label} failed:`, err);
      if (err?.code === 'NO_KEY' || err?.code === 'BAD_KEY') {
        draw(head() + `<p class="online-note error">${escapeHtml(err.message)}</p>` + keyPromptHtml(provider.source));
        bindKeyPrompt(blockEl, provider.source, () => fillBlock(blockEl, provider, { force: true }));
        return;
      }
      draw(head() + '<p class="online-note error">Could not load this list right now.</p><button type="button" class="btn btn-secondary online-retry-btn">Try again</button>');
      blockEl.querySelector('.online-retry-btn')?.addEventListener('click', () => fillBlock(blockEl, provider, { force: true }));
      return;
    }
  }

  if (!tracks.length) {
    draw(head() + '<p class="online-note">Nothing to show here yet.</p>');
    return;
  }

  draw(head('<button type="button" class="text-link-btn discover-play-all">Play all</button>') + renderTrackList(tracks, new Set(getFavorites())));
  bindTrackRows(blockEl, tracks);
  blockEl.querySelector('.discover-play-all')?.addEventListener('click', () => playList(tracks, 0));
  refreshPlayingState();
}

// Adds (or redraws) the section at the bottom of the Home container.
export function renderDiscover(containerEl) {
  if (!containerEl) return;
  containerEl.querySelector('#home-discover')?.remove();

  const root = document.createElement('section');
  root.id = 'home-discover';
  root.className = 'content-section home-discover';
  root.innerHTML = '<div class="section-header"><h2 class="section-title">Recommended Music</h2></div><p class="online-note">Free &amp; legal: Creative Commons and independent artists.</p>';
  containerEl.appendChild(root);

  PROVIDERS.forEach((provider) => {
    const block = document.createElement('div');
    block.className = 'discover-block';
    block.dataset.source = provider.id;
    root.appendChild(block);
    fillBlock(block, provider);
  });
}
