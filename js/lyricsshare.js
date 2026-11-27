// ============================================================================
// SoundWave — Aesthetic Lyrics Sharing Card Studio & PNG Export
// (js/lyricsshare.js)
// ============================================================================

import { coverFor, placeholderCover, toast } from './util.js?v=pro35';

const THEMES = {
  cinematic: {
    name: 'Cinematic Rose',
    bgTop: '#241222',
    bgBottom: '#0c0a12',
    glow: 'rgba(250, 35, 59, 0.36)',
    cardBg: 'rgba(22, 16, 26, 0.62)',
    text: '#ffffff',
    sub: 'rgba(255, 255, 255, 0.72)',
    accent: '#fa233b',
    font: 'Georgia, "Times New Roman", serif'
  },
  midnight: {
    name: 'Midnight Glass',
    bgTop: '#111827',
    bgBottom: '#07090f',
    glow: 'rgba(94, 92, 230, 0.38)',
    cardBg: 'rgba(17, 24, 39, 0.64)',
    text: '#f8fafc',
    sub: 'rgba(226, 232, 240, 0.75)',
    accent: '#818cf8',
    font: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
  },
  crimson: {
    name: 'Velvet Crimson',
    bgTop: '#3b0d18',
    bgBottom: '#12060a',
    glow: 'rgba(244, 63, 94, 0.42)',
    cardBg: 'rgba(36, 10, 18, 0.65)',
    text: '#fff1f2',
    sub: 'rgba(255, 228, 230, 0.76)',
    accent: '#fb7185',
    font: 'Georgia, serif'
  },
  noir: {
    name: 'Minimal Noir',
    bgTop: '#18181b',
    bgBottom: '#09090b',
    glow: 'rgba(255, 255, 255, 0.14)',
    cardBg: 'rgba(24, 24, 27, 0.72)',
    text: '#fafafa',
    sub: 'rgba(212, 212, 216, 0.72)',
    accent: '#fa233b',
    font: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
  }
};

let activeTrack = null;
let activeLines = [];
let selectedIndices = new Set();
let currentTheme = 'cinematic';
let cardStyle = 'poster'; // 'poster' | 'glass'

function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      const fb = new Image();
      fb.onload = () => resolve(fb);
      fb.onerror = () => resolve(null);
      fb.src = placeholderCover(activeTrack?.title || 'soundwave');
    };
    img.src = src;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out;
}

export async function renderLyricsShareCanvas(canvas, { track, lyricText, themeKey = 'cinematic', style = 'poster' } = {}) {
  if (!canvas) return;
  const W = 900;
  const H = 1200;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const th = THEMES[themeKey] || THEMES.cinematic;

  // 1. Deep cinematic gradient backdrop
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, th.bgTop);
  bgGrad.addColorStop(1, th.bgBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const coverUrl = track ? coverFor(track) : placeholderCover('soundwave');
  const artImg = await loadImg(coverUrl);

  // 2. Blurred ambient artwork behind card
  if (artImg) {
    ctx.save();
    ctx.globalAlpha = style === 'poster' ? 0.55 : 0.42;
    ctx.filter = 'blur(42px) saturate(1.4)';
    ctx.drawImage(artImg, -80, -80, W + 160, H + 160);
    ctx.restore();
  }

  // Pink/crimson ambient glow
  const radGlow = ctx.createRadialGradient(W * 0.72, H * 0.28, 40, W * 0.5, H * 0.5, W * 0.85);
  radGlow.addColorStop(0, th.glow);
  radGlow.addColorStop(1, 'rgba(0,0,0,0.68)');
  ctx.fillStyle = radGlow;
  ctx.fillRect(0, 0, W, H);

  // 3. Outer Glass Card Frame
  const pad = 64;
  const cardX = pad;
  const cardY = pad;
  const cardW = W - pad * 2;
  const cardH = H - pad * 2;

  ctx.save();
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 46);
  ctx.fillStyle = th.cardBg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.clip();

  if (style === 'poster' && artImg) {
    // Upper artwork hero with smooth fade into dark glass
    const artH = 620;
    ctx.drawImage(artImg, cardX, cardY, cardW, artH);
    const fade = ctx.createLinearGradient(0, cardY + 260, 0, cardY + artH + 20);
    fade.addColorStop(0, 'rgba(12, 10, 18, 0)');
    fade.addColorStop(1, th.bgBottom);
    ctx.fillStyle = fade;
    ctx.fillRect(cardX, cardY + 240, cardW, artH - 220);

    // Song title & artist centered over fade
    ctx.textAlign = 'center';
    ctx.fillStyle = th.text;
    ctx.font = `italic 700 54px ${th.font}`;
    const titleLines = wrapLines(ctx, track?.title || 'SoundWave Track', cardW - 96).slice(0, 2);
    let ty = cardY + 510;
    titleLines.forEach((tl) => {
      ctx.fillText(tl, W / 2, ty);
      ty += 62;
    });

    ctx.fillStyle = th.sub;
    ctx.font = '600 30px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
    ctx.fillText(track?.artist || 'Unknown Artist', W / 2, ty + 6);

    // Selected lyrics quote
    ctx.fillStyle = th.text;
    ctx.font = '700 42px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
    const quoteLines = wrapLines(ctx, `“${lyricText || 'Feel every beat in lossless clarity.'}”`, cardW - 120).slice(0, 4);
    let qy = ty + 96;
    quoteLines.forEach((ql) => {
      ctx.fillText(ql, W / 2, qy);
      qy += 54;
    });
  } else {
    // Frosted Glass Header Row (Cover thumbnail + Title + Artist)
    const thumbSize = 132;
    const tx = cardX + 52;
    const ty = cardY + 56;
    if (artImg) {
      ctx.save();
      roundRectPath(ctx, tx, ty, thumbSize, thumbSize, 24);
      ctx.clip();
      ctx.drawImage(artImg, tx, ty, thumbSize, thumbSize);
      ctx.restore();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = th.text;
    ctx.font = '800 38px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
    const tShort = wrapLines(ctx, track?.title || 'SoundWave Track', cardW - thumbSize - 140)[0] || 'SoundWave';
    ctx.fillText(tShort, tx + thumbSize + 28, ty + 56);

    ctx.fillStyle = th.sub;
    ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
    const aShort = wrapLines(ctx, track?.artist || 'Unknown Artist', cardW - thumbSize - 140)[0] || '';
    ctx.fillText(aShort, tx + thumbSize + 28, ty + 102);

    // Large left-aligned lyrics block
    ctx.fillStyle = th.text;
    ctx.font = `800 52px ${th.font}`;
    const qLines = wrapLines(ctx, `“${lyricText || 'Feel every beat in lossless clarity.'}”`, cardW - 110).slice(0, 7);
    let ly = ty + thumbSize + 125;
    qLines.forEach((line) => {
      ctx.fillText(line, tx, ly);
      ly += 68;
    });
  }

  // 4. Bottom SoundWave Branding + Waveform Bars
  const footerY = cardY + cardH - 64;
  ctx.fillStyle = th.accent;
  roundRectPath(ctx, cardX + 52, footerY - 30, 38, 38, 10);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  const bars = [12, 22, 28, 18];
  bars.forEach((bh, idx) => {
    const bx = cardX + 61 + idx * 7;
    ctx.beginPath();
    ctx.moveTo(bx, footerY - 11 - bh / 2);
    ctx.lineTo(bx, footerY - 11 + bh / 2);
    ctx.stroke();
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = th.text;
  ctx.font = '700 28px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
  ctx.fillText('SoundWave', cardX + 104, footerY - 2);

  // Decorative mini waveform on bottom right
  const waveHeights = [14, 28, 20, 38, 46, 30, 42, 24, 34, 18, 26, 14];
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  waveHeights.forEach((wh, idx) => {
    const wx = cardX + cardW - 190 + idx * 11;
    roundRectPath(ctx, wx, footerY - 12 - wh / 2, 5, wh, 3);
    ctx.fill();
  });

  ctx.restore();
}

export function openLyricsShareModal({ track, lines = [], currentText = '' } = {}) {
  const modal = document.getElementById('lyrics-share-modal');
  if (!modal) return;

  activeTrack = track || { title: 'SoundWave', artist: 'Lossless Music' };
  const rawLines = Array.isArray(lines) && lines.length
    ? lines.map((l) => (typeof l === 'string' ? l : l.text)).filter((t) => t && t !== '♪')
    : currentText
      ? String(currentText).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [`Listening to ${activeTrack.title} by ${activeTrack.artist}`];

  activeLines = rawLines.slice(0, 40);
  selectedIndices = new Set([0]);
  if (activeLines.length > 1) selectedIndices.add(1);

  const pickerEl = document.getElementById('share-lyric-lines');
  const customInput = document.getElementById('share-custom-lyric');
  const canvas = document.getElementById('lyrics-share-canvas');

  const getSelectedText = () => {
    if (customInput && customInput.value.trim()) return customInput.value.trim();
    const chosen = [...selectedIndices].sort((a, b) => a - b).map((i) => activeLines[i]).filter(Boolean);
    return chosen.join(' ') || activeLines[0] || activeTrack.title;
  };

  const redraw = () => {
    renderLyricsShareCanvas(canvas, {
      track: activeTrack,
      lyricText: getSelectedText(),
      themeKey: currentTheme,
      style: cardStyle
    });
  };

  if (pickerEl) {
    pickerEl.innerHTML = activeLines
      .map((line, i) => `
        <button type="button" class="share-line-chip${selectedIndices.has(i) ? ' active' : ''}" data-share-line="${i}">
          ${line.replace(/</g, '&lt;')}
        </button>
      `)
      .join('');
  }
  if (customInput) customInput.value = '';

  // Wire theme & style chips once
  if (!modal.dataset.wired) {
    modal.dataset.wired = '1';

    modal.querySelectorAll('[data-share-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentTheme = btn.dataset.shareTheme;
        modal.querySelectorAll('[data-share-theme]').forEach((b) => b.classList.toggle('active', b === btn));
        redraw();
      });
    });

    modal.querySelectorAll('[data-share-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cardStyle = btn.dataset.shareStyle;
        modal.querySelectorAll('[data-share-style]').forEach((b) => b.classList.toggle('active', b === btn));
        redraw();
      });
    });

    pickerEl?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-share-line]');
      if (!chip) return;
      const idx = Number(chip.dataset.shareLine);
      if (selectedIndices.has(idx)) {
        if (selectedIndices.size > 1) selectedIndices.delete(idx);
      } else {
        if (selectedIndices.size >= 4) {
          const first = selectedIndices.values().next().value;
          selectedIndices.delete(first);
        }
        selectedIndices.add(idx);
      }
      pickerEl.querySelectorAll('[data-share-line]').forEach((c) => {
        c.classList.toggle('active', selectedIndices.has(Number(c.dataset.shareLine)));
      });
      if (customInput) customInput.value = '';
      redraw();
    });

    customInput?.addEventListener('input', redraw);

    document.getElementById('share-download-png-btn')?.addEventListener('click', () => {
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(activeTrack?.title || 'soundwave-lyrics').replace(/[^a-z0-9_-]+/gi, '_')}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast('Lyrics card saved as PNG');
      }, 'image/png');
    });

    document.getElementById('share-native-btn')?.addEventListener('click', async () => {
      if (!canvas) return;
      const text = `“${getSelectedText()}” — ${activeTrack?.title || ''} (${activeTrack?.artist || ''}) via SoundWave`;
      try {
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const file = blob ? new File([blob], 'soundwave-lyrics.png', { type: 'image/png' }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: activeTrack?.title || 'SoundWave Lyrics', text, files: [file] });
          return;
        }
        if (navigator.share) {
          await navigator.share({ title: activeTrack?.title || 'SoundWave Lyrics', text });
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
      // Fallback: download PNG
      document.getElementById('share-download-png-btn')?.click();
    });

    modal.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
      if (typeof modal.close === 'function') modal.close();
      else modal.removeAttribute('open');
    }));
  }

  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
  redraw();
}
