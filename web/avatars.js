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
  for (const c of av.querySelectorAll('canvas.portrait:not([data-drawn])')) { drawPortrait(c, JSON.parse(c.dataset.look)); c.dataset.drawn = '1'; }
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
  for (const c of av.querySelectorAll('canvas.portrait:not([data-drawn])')) { drawPortrait(c, JSON.parse(c.dataset.look)); c.dataset.drawn = '1'; }
  av.classList.remove('fx-edit', 'fx-done', 'fx-fail', 'fx-test');
  void av.offsetWidth;   // riavvia l'animazione CSS
  const cls = { 'agent.editing': 'fx-edit', 'agent.completed': 'fx-done', 'agent.failed': 'fx-fail', 'agent.testing': 'fx-test' }[kind];
  if (cls) av.classList.add(cls);
}

// disegna i ritratti pixel art non ancora disegnati dentro un elemento (chat, finestre, pannelli)
export function paintPortraits(root) {
  for (const c of root.querySelectorAll('canvas.portrait:not([data-drawn])')) { drawPortrait(c, JSON.parse(c.dataset.look)); c.dataset.drawn = '1'; }
}
