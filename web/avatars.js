// RENDERER DEGLI AVATAR — pensato per essere sostituito/esteso senza toccare il resto dell'interfaccia.
//
// Un avatar è un dato (agent.avatar):
//   { type: 'emoji',       emoji: '🧑‍💻', color: '#ff4fa3' }
//   { type: 'image',       image: '/avatars/tizo.png', color }
//   { type: 'spritesheet', sprite: { url, frameWidth, frameHeight, scale, animations: { typing: { row: 0, frames: 4, fps: 8 }, ... } } }
// Lo stato dell'agente (IDLE, WORKING, …) diventa un nome di animazione tramite agent.animations
// (predefiniti: WORKING→typing, TESTING→playing, THINKING→writing-notes, WAITING→waiting, BLOCKED→question,
//  DONE→celebrate, ERROR→error, IDLE→idle). Per gli avatar emoji/immagine l'animazione è CSS (classe anim-<nome>);
// per gli spritesheet si scorrono i fotogrammi della riga indicata.
//
//   { type: 'pixel', character: { skin, hair, hairStyle, shirt, accessory, accColor } }   ← predefinito: ritratto disegnato in codice
// Nell'ufficio isometrico (office.js) lo stesso avatar.character diventa il personaggio alla scrivania.

import { buildPortrait } from './sprites.js';

function drawPortrait(canvas, look) { const p = buildPortrait(look); canvas.width = p.width; canvas.height = p.height; canvas.getContext('2d').drawImage(p, 0, 0); }
const lookOf = (agent) => agent?.avatar?.character || {};

const PROPS = { typing: '⌨️', 'writing-notes': '📝', playing: '🎮', waiting: '⏳', question: '❓', celebrate: '✨', error: '⚠️', idle: '' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function animationFor(agent, status) {
  const map = agent.animations || {};
  return map[status || agent.runtime?.status || 'IDLE'] || 'idle';
}

export function avatarHTML(agent, { size = 72 } = {}) {
  const a = agent.avatar || {};
  const color = a.color || '#888';
  const style = `--av-size:${size}px;--av-color:${esc(color)}`;
  if (a.type === 'image' && a.image && a.chroma) return `<div class="avatar av-image av-gen" style="${style}"><canvas class="gen-portrait" data-src="${esc(a.image)}" data-chroma="${esc(a.chroma)}"></canvas></div>`;
  if (a.type === 'image' && a.image) return `<div class="avatar av-image" style="${style}"><img src="${esc(a.image)}" alt=""></div>`;
  if (a.type === 'spritesheet' && a.sprite?.url) {
    const s = a.sprite; const sc = s.scale || 2;
    return `<div class="avatar av-sprite" style="${style}"><div class="sprite" data-sprite='${esc(JSON.stringify(s))}' style="width:${s.frameWidth * sc}px;height:${s.frameHeight * sc}px;background-image:url('${esc(s.url)}')"></div></div>`;
  }
  if (a.type === 'pixel' || (!a.type && a.character)) return `<div class="avatar av-pixel" style="${style}"><canvas class="portrait" data-look='${esc(JSON.stringify(lookOf(agent)))}'></canvas></div>`;
  return `<div class="avatar av-emoji" style="${style}"><span>${esc(a.emoji || '🙂')}</span></div>`;
}

// Applica lo stato all'elemento dell'avatar (chiamato a ogni evento di stato)
const spriteTimers = new WeakMap();
export function applyAvatarState(root, agent) {
  const status = agent.runtime?.status || 'IDLE';
  const anim = animationFor(agent, status);
  const av = root.querySelector('.avatar');
  if (!av) return;
  paintPortraits(av);
  av.className = av.className.replace(/\banim-[\w-]+/g, '').trim() + ` anim-${anim}`;
  av.dataset.anim = anim;
  const prop = root.querySelector('.prop');
  if (prop) prop.textContent = PROPS[anim] ?? '';
  const sp = av.querySelector('.sprite');
  if (sp) {
    clearInterval(spriteTimers.get(sp));
    const s = JSON.parse(sp.dataset.sprite || '{}');
    const sc = s.scale || 2;
    const def = (s.animations || {})[anim] || (s.animations || {}).idle || { row: 0, frames: 1, fps: 1 };
    let f = 0;
    const draw = () => { sp.style.backgroundPosition = `-${f * s.frameWidth * sc}px -${(def.row || 0) * s.frameHeight * sc}px`; f = (f + 1) % (def.frames || 1); };
    draw();
    // background-size: l'immagine intera va scalata come i fotogrammi
    const img = new Image(); img.onload = () => { sp.style.backgroundSize = `${img.width * sc}px ${img.height * sc}px`; }; img.src = s.url;
    if ((def.frames || 1) > 1) spriteTimers.set(sp, setInterval(draw, 1000 / (def.fps || 6)));
  }
}

// Effetto "una tantum" per un evento (es. agent.completed → coriandoli, agent.editing → scintilla sulla tastiera)
export function pulse(root, kind) {
  const av = root.querySelector('.avatar');
  if (!av) return;
  paintPortraits(av);
  av.classList.remove('fx-edit', 'fx-done', 'fx-fail', 'fx-test');
  void av.offsetWidth;   // riavvia l'animazione CSS
  const cls = { 'agent.editing': 'fx-edit', 'agent.completed': 'fx-done', 'agent.failed': 'fx-fail', 'agent.testing': 'fx-test' }[kind];
  if (cls) av.classList.add(cls);
}

// disegna i ritratti pixel art non ancora disegnati dentro un elemento (chat, finestre, pannelli)
export function paintPortraits(root) {
  for (const c of root.querySelectorAll('canvas.portrait:not([data-drawn])')) { drawPortrait(c, JSON.parse(c.dataset.look)); c.dataset.drawn = '1'; }
  for (const c of root.querySelectorAll('canvas.gen-portrait:not([data-drawn])')) {
    c.dataset.drawn = '1';
    const paint = (src) => { if (!src) return; c.width = src.width; c.height = src.height; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(src, 0, 0); };
    paint(processedAvatar(c.dataset.src, { chroma: c.dataset.chroma, maxW: 72, maxH: 72, outline: true }, paint));
  }
}

// ── avatar generati (immagini AI): fondo magenta tolto, ritaglio, riduzione a pixel art ────────────────
const procCache = new Map();
export function processedAvatar(url, { chroma = '#ff00ff', maxW = 48, maxH = 58, outline = true } = {}, onReady) {
  const key = `${url}|${chroma}|${maxW}x${maxH}|${outline}`;
  const hit = procCache.get(key);
  if (hit instanceof HTMLCanvasElement) return hit;
  if (hit) { if (onReady) hit.then(onReady); return null; }
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 512 / Math.max(img.width, img.height));
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h), px = d.data;
      const kr = parseInt(chroma.slice(1, 3), 16), kg = parseInt(chroma.slice(3, 5), 16), kb = parseInt(chroma.slice(5, 7), 16);
      const corner = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4].map((i) => [px[i], px[i + 1], px[i + 2]]);
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const dk = Math.abs(r - kr) + Math.abs(g - kg) + Math.abs(b - kb);
        const magentaish = r > 150 && b > 150 && g < 120 && Math.abs(r - b) < 90;
        const nearCorner = corner.some(([cr, cg, cb]) => Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) < 48);
        if (dk < 170 || magentaish || nearCorner) { px[i + 3] = 0; continue; }
        if (r > g + 40 && b > g + 40) { px[i] = Math.round((r + g) / 2); px[i + 2] = Math.round((b + g) / 2); }   // via il riflesso magenta sui bordi
        const p2 = i / 4, xx = p2 % w, yy = (p2 / w) | 0;
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      }
      x.putImageData(d, 0, 0);
      if (maxX < 0) { resolve(null); return; }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const sc = Math.min(maxW / bw, maxH / bh);
      const ow = Math.max(1, Math.round(bw * sc)), oh = Math.max(1, Math.round(bh * sc));
      const o = document.createElement('canvas'); o.width = ow + 2; o.height = oh + 2;
      const ox = o.getContext('2d', { willReadFrequently: true }); ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
      ox.drawImage(c, minX, minY, bw, bh, 1, 1, ow, oh);
      const od = ox.getImageData(0, 0, o.width, o.height), q = od.data;
      for (let i = 0; i < q.length; i += 4) { if (q[i + 3] < 110) q[i + 3] = 0; else { q[i + 3] = 255; for (let k = 0; k < 3; k++) q[i + k] = Math.round(q[i + k] / 12) * 12; } }
      if (outline) {
        const W2 = o.width, H2 = o.height, add = [];
        for (let y = 0; y < H2; y++) for (let xx = 0; xx < W2; xx++) {
          const i = (y * W2 + xx) * 4; if (q[i + 3]) continue;
          const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ((y + dy) * W2 + xx + dx) * 4).find((j) => xx >= 0 && j >= 0 && j < q.length && q[j + 3]);
          if (n !== undefined) add.push([i, Math.round(q[n] * 0.35), Math.round(q[n + 1] * 0.35), Math.round(q[n + 2] * 0.35)]);
        }
        for (const [i, r, g, b] of add) { q[i] = r; q[i + 1] = g; q[i + 2] = b; q[i + 3] = 255; }
      }
      ox.putImageData(od, 0, 0);
      procCache.set(key, o);
      resolve(o);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  procCache.set(key, p);
  if (onReady) p.then(onReady);
  return null;
}
