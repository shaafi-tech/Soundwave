// ============================================================================
// SoundWave — Real-Time Frequency Spectrum Visualizer (js/visualizer.js)
// Web Audio AnalyserNode reacting to Bass, Vocals (Mids) & Treble across
// Panel Visualizer, Full-Screen Now Playing & Mini-Player.
// ============================================================================

import * as eq from './equalizer.js?v=pro35';

const BAR_COUNT = 44;
const MINI_BAR_COUNT = 16;

let audioEl = null;
let panelCanvas = null;
let panelCtx = null;
let fpCanvas = null;
let fpCtx = null;
let miniCanvas = null;
let miniCtx = null;

let audioCtx = null;
let analyser = null;
let sourceNode = null;
let freqData = null;

let rafId = null;
let running = false;
let webAudioFailed = false;

let panelCssW = 300;
let panelCssH = 260;

const levels = new Array(BAR_COUNT).fill(0);
const miniLevels = new Array(MINI_BAR_COUNT).fill(0);

function isActivelyPlaying() {
  return Boolean(audioEl && !audioEl.paused && !audioEl.ended && audioEl.readyState >= 2);
}

function resizePanelCanvas() {
  if (!panelCanvas || !panelCtx) return;
  const rect = panelCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  panelCssW = rect.width;
  panelCssH = rect.height;
  panelCanvas.width = Math.round(panelCssW * dpr);
  panelCanvas.height = Math.round(panelCssH * dpr);
  panelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensureAudioGraph() {
  if (analyser && freqData) return true;
  if (webAudioFailed || !audioEl) return false;

  // Avoid creating a CORS-blocked MediaElementSource on external HTTP URLs without same-origin/blob
  if (audioEl.currentSrc && /^https?:\/\//i.test(audioEl.currentSrc) && !audioEl.currentSrc.startsWith(location.origin)) {
    return false;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    webAudioFailed = true;
    return false;
  }

  try {
    if (!audioCtx) {
      audioCtx = new AC();
      audioCtx.onstatechange = () => {
        if (audioEl && !audioEl.paused && audioCtx && audioCtx.state !== 'running') {
          audioCtx.resume().catch(() => {});
        }
      };
    }
    if (!sourceNode) {
      sourceNode = audioCtx.createMediaElementSource(audioEl);
    }
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -12;

      const eqOut = eq.attachAudioGraph(audioCtx, sourceNode, analyser);
      if (!eqOut) {
        sourceNode.connect(analyser);
      }
      analyser.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    return true;
  } catch (err) {
    console.warn('Visualizer: Web Audio graph unavailable:', err);
    webAudioFailed = true;
    analyser = null;
    freqData = null;
    return false;
  }
}

export function registerVisualizerTargets({ panelCanvasEl, fpCanvasEl, miniCanvasEl } = {}) {
  if (panelCanvasEl) {
    panelCanvas = panelCanvasEl;
    panelCtx = panelCanvas.getContext('2d');
    resizePanelCanvas();
  }
  if (fpCanvasEl) {
    fpCanvas = fpCanvasEl;
    fpCtx = fpCanvas.getContext('2d');
  }
  if (miniCanvasEl) {
    miniCanvas = miniCanvasEl;
    miniCtx = miniCanvas.getContext('2d');
  }
  ensureLoopState();
}

export function initVisualizer({ audioEl: audio, canvasEl: canvas } = {}) {
  audioEl = audio || null;
  if (canvas) {
    panelCanvas = canvas;
    panelCtx = panelCanvas.getContext('2d');
    resizePanelCanvas();
  }

  window.addEventListener('resize', () => {
    resizePanelCanvas();
  });

  // Never mute audio: resume AudioContext safely when playback starts or app returns
  audioEl?.addEventListener('play', () => {
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    ensureLoopState();
  });

  audioEl?.addEventListener('playing', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    ensureLoopState();
  });

  audioEl?.addEventListener('pause', () => {
    // Keep current bar positions frozen while paused; reset smoothly only when stopped/ended
    if (audioEl.ended) {
      resetLevels();
    }
  });

  audioEl?.addEventListener('ended', () => {
    resetLevels();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (audioCtx && audioEl && !audioEl.paused && audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
    }
    ensureLoopState();
  });
}

function resetLevels() {
  for (let i = 0; i < BAR_COUNT; i += 1) levels[i] = 0;
  for (let i = 0; i < MINI_BAR_COUNT; i += 1) miniLevels[i] = 0;
}

function hasResidualEnergy() {
  return levels.some((v) => v > 0.004) || miniLevels.some((v) => v > 0.004);
}

// Computes frequency-weighted targets across Bass (low bins), Vocals (mid bins) & Treble (high bins)
function computeFrequencyTargets(count, playing) {
  const out = new Array(count).fill(0);
  if (!playing) return out;

  const hasLiveData = ensureAudioGraph() && analyser && freqData;
  if (hasLiveData) {
    analyser.getByteFrequencyData(freqData);
    // Split spectrum into Bass (0..18%), Vocals/Mids (18..55%), Treble (55..90%)
    const totalBins = freqData.length;
    const bassEnd = Math.max(2, Math.floor(totalBins * 0.18));
    const vocalEnd = Math.max(bassEnd + 2, Math.floor(totalBins * 0.55));
    const trebleEnd = Math.max(vocalEnd + 2, Math.floor(totalBins * 0.90));

    const bandAvg = (start, end) => {
      let sum = 0;
      let n = 0;
      for (let b = start; b < end && b < totalBins; b += 1) {
        sum += freqData[b];
        n += 1;
      }
      return n ? (sum / n) / 255 : 0;
    };

    const bassLevel = bandAvg(1, bassEnd);
    const vocalLevel = bandAvg(bassEnd, vocalEnd);
    const trebleLevel = bandAvg(vocalEnd, trebleEnd);

    for (let i = 0; i < count; i += 1) {
      const pos = count > 1 ? i / (count - 1) : 0;
      const binIdx = Math.min(totalBins - 1, Math.floor(pos * trebleEnd));
      const directBin = (freqData[binIdx] || 0) / 255;

      // Blend direct FFT bin energy with band response (bass / vocals / treble)
      let bandWeight = 0;
      if (pos < 0.28) {
        bandWeight = bassLevel * 1.15;
      } else if (pos < 0.68) {
        bandWeight = vocalLevel * 1.1;
      } else {
        bandWeight = trebleLevel * 1.05;
      }

      // Slight center-vocal lift for expressive dynamic bar heights
      const vocalCurve = 0.85 + 0.25 * Math.sin(pos * Math.PI);
      out[i] = Math.min(1, Math.max(0, (directBin * 0.65 + bandWeight * 0.35) * vocalCurve));
    }
  }
  return out;
}

function drawBarsToContext(ctx, width, height, barLevels, {
  gap = 3,
  radius = 4,
  glowColor = 'rgba(250, 35, 59, 0.65)',
  glowBlur = 10,
  bottomPad = 6,
  topPad = 8,
  drawGlow = true
} = {}) {
  if (!ctx || width <= 0 || height <= 0) return;
  ctx.clearRect(0, 0, width, height);

  const count = barLevels.length;
  const barW = Math.max(2, (width - gap * (count - 1)) / count);
  const maxBarH = Math.max(4, height - bottomPad - topPad);

  const grad = ctx.createLinearGradient(0, height - bottomPad, 0, topPad);
  grad.addColorStop(0, '#ff1e42');
  grad.addColorStop(0.55, '#ff477e');
  grad.addColorStop(1, '#ff9ebb');

  ctx.save();
  ctx.fillStyle = grad;
  if (drawGlow) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowBlur;
  }

  for (let i = 0; i < count; i += 1) {
    const val = barLevels[i];
    const h = val <= 0.003 ? 2 : Math.max(3, Math.min(maxBarH, val * maxBarH));
    const x = i * (barW + gap);
    const y = height - bottomPad - h;

    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, barW, h, Math.min(radius, barW / 2));
    } else {
      ctx.rect(x, y, barW, h);
    }
    ctx.fill();
  }

  ctx.restore();
}

function renderFrame() {
  const playing = isActivelyPlaying();

  if (playing) {
    const targets = computeFrequencyTargets(BAR_COUNT, true);
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const t = targets[i];
      // Fast rise on transient hits, smooth fall for 60 FPS fluid motion
      levels[i] = t > levels[i]
        ? levels[i] + (t - levels[i]) * 0.42
        : Math.max(t, levels[i] - 0.032);
    }

    const miniTargets = computeFrequencyTargets(MINI_BAR_COUNT, true);
    for (let i = 0; i < MINI_BAR_COUNT; i += 1) {
      const mt = miniTargets[i];
      miniLevels[i] = mt > miniLevels[i]
        ? miniLevels[i] + (mt - miniLevels[i]) * 0.45
        : Math.max(mt, miniLevels[i] - 0.038);
    }
  } else if (audioEl && audioEl.ended) {
    // Smoothly decay bars to zero when playback finishes
    for (let i = 0; i < BAR_COUNT; i += 1) levels[i] = Math.max(0, levels[i] - 0.045);
    for (let i = 0; i < MINI_BAR_COUNT; i += 1) miniLevels[i] = Math.max(0, miniLevels[i] - 0.05);
  }

  if (panelCtx && panelCanvas && !panelCanvas.closest('.hidden')) {
    if (!panelCssW || !panelCssH) resizePanelCanvas();
    drawBarsToContext(panelCtx, panelCssW, panelCssH, levels, {
      gap: 3,
      radius: 4,
      glowColor: 'rgba(250, 35, 59, 0.72)',
      glowBlur: 12,
      bottomPad: 10,
      topPad: 12,
      drawGlow: playing
    });
  }

  if (fpCtx && fpCanvas && fpCanvas.closest('.full-player.open')) {
    drawBarsToContext(fpCtx, fpCanvas.width, fpCanvas.height, levels.slice(0, 36), {
      gap: 4,
      radius: 3,
      glowColor: 'rgba(255, 56, 100, 0.75)',
      glowBlur: 10,
      bottomPad: 4,
      topPad: 4,
      drawGlow: playing
    });
  }

  if (miniCtx && miniCanvas) {
    drawBarsToContext(miniCtx, miniCanvas.width, miniCanvas.height, miniLevels, {
      gap: 2,
      radius: 2,
      glowColor: 'rgba(250, 35, 59, 0.65)',
      glowBlur: 6,
      bottomPad: 2,
      topPad: 2,
      drawGlow: playing
    });
  }

  const stillDecaying = !playing && audioEl && audioEl.ended && hasResidualEnergy();
  if (playing || stillDecaying) {
    rafId = requestAnimationFrame(renderFrame);
  } else {
    running = false;
    rafId = null;
  }
}

function ensureLoopState() {
  if (isActivelyPlaying() || (audioEl && audioEl.ended && hasResidualEnergy())) {
    if (!running) {
      running = true;
      resizePanelCanvas();
      rafId = requestAnimationFrame(renderFrame);
    }
  }
}

export function start() {
  resizePanelCanvas();
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  ensureLoopState();
  renderFrame();
}

export function stop() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}
