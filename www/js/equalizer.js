// ============================================================================
// SoundWave — Pro DSP Engine: 10-Band Parametric EQ, Preamp, Bass Boost,
// Stereo Virtualizer, L/R Balance, Room Reverb & Custom Presets (js/equalizer.js)
// ============================================================================

const EQ_STORAGE_KEY = 'soundwave_eq_settings_v2';

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['31Hz', '62Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz'];

export const BUILTIN_PRESETS = {
  flat:       { name: 'Flat',            gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],    bass: 0,  virtualizer: 0,  reverb: 0,  preamp: 0 },
  rock:       { name: 'Rock',            gains: [5, 4, 2, 0, -2, -1, 2, 4, 5, 6],  bass: 40, virtualizer: 30, reverb: 12, preamp: 1 },
  pop:        { name: 'Pop',             gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2], bass: 20, virtualizer: 25, reverb: 8,  preamp: 0 },
  jazz:       { name: 'Jazz',            gains: [4, 3, 1, 2, -2, -2, 0, 2, 3, 4],  bass: 25, virtualizer: 45, reverb: 22, preamp: 0 },
  classical:  { name: 'Classical',       gains: [4, 3, 2, 1, -1, -1, 0, 2, 4, 5],  bass: 10, virtualizer: 60, reverb: 35, preamp: 0 },
  bass:       { name: 'Bass Boost',      gains: [7, 6, 4, 2, 0, 0, 0, 0, 1, 2],    bass: 70, virtualizer: 15, reverb: 5,  preamp: 1 },
  poweramp:   { name: 'Poweramp Pro',    gains: [6, 5, 3, 0, -1, 0, 2, 4, 5, 6],   bass: 55, virtualizer: 45, reverb: 15, preamp: 2 },
  electronic: { name: 'Electronic',      gains: [6, 5, 2, 0, -2, 2, 1, 3, 5, 6],   bass: 60, virtualizer: 50, reverb: 18, preamp: 1 },
  hiphop:     { name: 'Hip-Hop',         gains: [6, 5, 3, 1, -1, -1, 1, 2, 3, 4],  bass: 75, virtualizer: 20, reverb: 10, preamp: 1 },
  vocal:      { name: 'Vocal / Podcast', gains: [-3, -2, -1, 2, 5, 6, 5, 3, 1, 0], bass: 0,  virtualizer: 10, reverb: 0,  preamp: 2 },
  concert:    { name: 'Concert Hall',    gains: [3, 2, 1, 0, 0, 1, 2, 3, 4, 3],    bass: 30, virtualizer: 65, reverb: 55, preamp: 0 },
  night:      { name: 'Late Night',      gains: [3, 2, 1, 0, 1, 2, 2, 1, 0, -1],   bass: 25, virtualizer: 20, reverb: 10, preamp: -2 }
};

const defaultState = () => ({
  enabled: true,
  preset: 'flat',
  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  preamp: 0,      // -12 to +12 dB
  bass: 0,        // 0 to 100
  virtualizer: 0, // 0 to 100
  reverb: 0,      // 0 to 100
  balance: 0,     // -100 (L) to +100 (R)
  customPresets: {}
});

let state = loadState();
let audioCtx = null;
let filters = [];
let bassFilter = null;
let splitter = null;
let merger = null;
let delayL = null;
let delayR = null;
let crossGainL = null;
let crossGainR = null;
let wetGain = null;
let dryGain = null;
let convolver = null;
let reverbWet = null;
let pannerNode = null;
let preampGain = null;
let limiter = null;
let wired = false;

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(EQ_STORAGE_KEY) || localStorage.getItem('soundwave_eq_settings_v1') || 'null');
    if (!raw || typeof raw !== 'object') return defaultState();
    const d = defaultState();
    return {
      enabled: raw.enabled !== false,
      preset: typeof raw.preset === 'string' ? raw.preset : 'flat',
      gains: Array.isArray(raw.gains) && raw.gains.length === 10
        ? raw.gains.map((g) => Math.max(-12, Math.min(12, Number(g) || 0)))
        : d.gains,
      preamp: Math.max(-12, Math.min(12, Number(raw.preamp) || 0)),
      bass: Math.max(0, Math.min(100, Number(raw.bass) || 0)),
      virtualizer: Math.max(0, Math.min(100, Number(raw.virtualizer) || 0)),
      reverb: Math.max(0, Math.min(100, Number(raw.reverb) || 0)),
      balance: Math.max(-100, Math.min(100, Number(raw.balance) || 0)),
      customPresets: raw.customPresets && typeof raw.customPresets === 'object' ? raw.customPresets : {}
    };
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function createImpulseResponse(ctx, duration = 1.6, decay = 2.6) {
  const rate = ctx.sampleRate || 44100;
  const length = Math.floor(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

export function getEqState() {
  return { ...state, gains: [...state.gains], customPresets: { ...state.customPresets } };
}

export function getAllPresets() {
  return { ...BUILTIN_PRESETS, ...state.customPresets };
}

export function attachAudioGraph(ctx, sourceNode, destinationNode) {
  if (!ctx || !sourceNode) return null;
  if (wired && audioCtx === ctx && preampGain) {
    applyAllNodes();
    return limiter || preampGain;
  }

  try {
    audioCtx = ctx;
    preampGain = ctx.createGain();
    filters = EQ_BANDS.map((freq, idx) => {
      const f = ctx.createBiquadFilter();
      f.type = idx === 0 ? 'lowshelf' : idx === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.4;
      f.gain.value = 0;
      return f;
    });

    bassFilter = ctx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 75;
    bassFilter.gain.value = 0;

    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    splitter = ctx.createChannelSplitter(2);
    merger = ctx.createChannelMerger(2);
    delayL = ctx.createDelay(0.05);
    delayR = ctx.createDelay(0.05);
    delayL.delayTime.value = 0.011;
    delayR.delayTime.value = 0.017;
    crossGainL = ctx.createGain();
    crossGainR = ctx.createGain();
    crossGainL.gain.value = 0.35;
    crossGainR.gain.value = 0.35;

    // Room Reverb (ConvolverNode)
    convolver = ctx.createConvolver();
    convolver.buffer = createImpulseResponse(ctx, 1.5, 2.8);
    reverbWet = ctx.createGain();
    reverbWet.gain.value = 0;

    // Stereo L/R Balance
    pannerNode = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;

    // Anti-clipping Limiter
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.0;
    limiter.knee.value = 6.0;
    limiter.ratio.value = 12.0;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;

    sourceNode.connect(preampGain);
    let head = preampGain;
    filters.forEach((f) => {
      head.connect(f);
      head = f;
    });
    head.connect(bassFilter);

    // Dry + Virtualizer + Reverb mix into panner/limiter
    const mixTarget = pannerNode || limiter;

    bassFilter.connect(dryGain);
    dryGain.connect(mixTarget);

    bassFilter.connect(splitter);
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    delayL.connect(crossGainL);
    delayR.connect(crossGainR);
    crossGainL.connect(merger, 0, 1);
    crossGainR.connect(merger, 0, 0);
    merger.connect(wetGain);
    wetGain.connect(mixTarget);

    bassFilter.connect(convolver);
    convolver.connect(reverbWet);
    reverbWet.connect(mixTarget);

    if (pannerNode) pannerNode.connect(limiter);
    if (destinationNode) limiter.connect(destinationNode);

    wired = true;
    applyAllNodes();
    return limiter;
  } catch (err) {
    console.warn('EQ graph setup failed:', err);
    wired = false;
    return null;
  }
}

function applyAllNodes() {
  if (!wired || !audioCtx) return;
  const now = audioCtx.currentTime;
  const on = state.enabled;

  const maxPos = on ? Math.max(0, ...state.gains, (state.bass / 100) * 8) : 0;
  const autoHeadroom = maxPos > 3 ? -(maxPos - 3) * 0.42 : 0;
  const totalPreampDb = on ? (state.preamp + autoHeadroom) : 0;
  preampGain.gain.setTargetAtTime(Math.pow(10, totalPreampDb / 20), now, 0.02);

  filters.forEach((f, idx) => {
    f.gain.setTargetAtTime(on ? (state.gains[idx] || 0) : 0, now, 0.02);
  });

  bassFilter.gain.setTargetAtTime(on ? (state.bass / 100) * 10 : 0, now, 0.02);

  const virt = on ? state.virtualizer / 100 : 0;
  dryGain.gain.setTargetAtTime(1 - virt * 0.22, now, 0.02);
  wetGain.gain.setTargetAtTime(virt * 0.65, now, 0.02);

  if (reverbWet) {
    const rev = on ? (state.reverb / 100) * 0.55 : 0;
    reverbWet.gain.setTargetAtTime(rev, now, 0.03);
  }

  if (pannerNode && pannerNode.pan) {
    const panVal = on ? Math.max(-1, Math.min(1, state.balance / 100)) : 0;
    pannerNode.pan.setTargetAtTime(panVal, now, 0.02);
  }
}

export function setEqEnabled(enabled) {
  state.enabled = Boolean(enabled);
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setBandGain(bandIndex, db) {
  if (bandIndex < 0 || bandIndex >= 10) return;
  state.gains[bandIndex] = Math.max(-12, Math.min(12, Number(db) || 0));
  state.preset = 'custom';
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setPreamp(db) {
  state.preamp = Math.max(-12, Math.min(12, Number(db) || 0));
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setBassBoost(percent) {
  state.bass = Math.max(0, Math.min(100, Number(percent) || 0));
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setVirtualizer(percent) {
  state.virtualizer = Math.max(0, Math.min(100, Number(percent) || 0));
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setReverb(percent) {
  state.reverb = Math.max(0, Math.min(100, Number(percent) || 0));
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function setBalance(percent) {
  state.balance = Math.max(-100, Math.min(100, Number(percent) || 0));
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
}

export function applyPreset(presetKey) {
  const p = getAllPresets()[presetKey];
  if (!p) return false;
  state.preset = presetKey;
  state.gains = [...p.gains];
  state.bass = Number(p.bass) || 0;
  state.virtualizer = Number(p.virtualizer) || 0;
  state.reverb = Number(p.reverb) || 0;
  state.preamp = Number(p.preamp) || 0;
  saveState();
  applyAllNodes();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
  return true;
}

export function saveCustomPreset(name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) return null;
  const slug = 'custom_' + clean.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  state.customPresets[slug] = {
    name: clean,
    gains: [...state.gains],
    bass: state.bass,
    virtualizer: state.virtualizer,
    reverb: state.reverb,
    preamp: state.preamp
  };
  state.preset = slug;
  saveState();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
  return slug;
}

export function deleteCustomPreset(slug) {
  if (!state.customPresets[slug]) return false;
  delete state.customPresets[slug];
  if (state.preset === slug) state.preset = 'flat';
  saveState();
  document.dispatchEvent(new CustomEvent('soundwave:eqchange', { detail: getEqState() }));
  return true;
}
