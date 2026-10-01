// L'UFFICIO — la sede della Pro Loco in pixel art isometrica, disegnata in codice su un <canvas>.
//
// Cosa è DATO (modificabile senza toccare questo file):
//   - la stanza, le postazioni e gli arredi: config/office.default.json (o data/office.json)
//   - l'aspetto dei personaggi: agent.avatar.character (pelle, capelli, pettinatura, maglia, accessorio)
//   - quale animazione per ogni stato: agent.animations (WORKING→typing, TESTING→playing, …)
// Cosa fa il codice:
//   - disegna stanza, arredi e luci (notte/giorno seguono l'ora vera)
//   - mette ogni agente alla sua postazione e lo anima secondo lo stato
//   - reagisce agli eventi (agent.editing → scintille dalla tastiera, agent.completed → coriandoli, …)
// Avatar di tipo "spritesheet": al posto del personaggio disegnato si usa il foglio di sprite dell'utente.
import { drawText, textWidth, shade } from './pixel.js';
import { cachedSprite, SPRITE_W, SPRITE_H } from './sprites.js';
import { processedAvatar, processedFrames } from './avatars.js';
import { layoutHash } from './layout-hash.js';

// risoluzione logica: dipende dalla stanza (setLayout), poi si ingrandisce a pixel pieni e si zooma
let LW = 448, LH = 356;
export function logicalSize(room) { return [(room.w + room.d) * 16 + 24, room.wallH + (room.w + room.d) * 8 + 30]; }
const TW = 16, TH = 8;             // mezza casella isometrica

const PAL = {
  plaster: '#ead8c0', plasterL: '#d5bfa4', stone: '#8d7d6c', stoneL: '#7a6b5c', mortar: '#6d5f51',
  beam: '#6b4a33', beamD: '#4f3524', cap: '#3d3f66', capL: '#4c4f7d', slab: '#2b2d4d', slabD: '#23243f',
  tileA: '#c98a6c', tileB: '#bd7d60', grout: '#9e654d',
  woodT: '#c99160', woodF: '#a8713f', woodS: '#8a5a31', woodD: '#6e4526',
  rug: '#a8403b', rugB: '#e1b05a', rugC: '#6f2a2a',
  leaf: '#4f9a4a', leafL: '#74c562', leafD: '#34703a', pot: '#b35a39', potD: '#8e4428',
  metal: '#3a3b47', metalL: '#5a5c6c', screenOff: '#1a2233', paper: '#f4ecd8', cork: '#b98a55',
};

// ── geometria ──────────────────────────────────────────────────────────────────────────────────
function makeIso(room) {
  const ox = LW / 2 - (room.w - room.d) * TW / 2;
  const oy = (LH - (room.wallH + (room.w + room.d) * TH + 14)) / 2 + room.wallH + 2;
  return (x, y, z = 0) => [ox + (x - y) * TW, oy + (x + y) * TH - z];
}

function poly(ctx, pts, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(Math.round(pts[0][0]), Math.round(pts[0][1]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(Math.round(pts[i][0]), Math.round(pts[i][1]));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

// Disegna un'immagine (tela piccola) "incollata" su una faccia: p0 = angolo in alto a sinistra, pu = in alto a destra, pv = in basso a sinistra
function mapFace(ctx, img, p0, pu, pv) {
  const w = img.width, h = img.height;
  ctx.save();
  ctx.setTransform((pu[0] - p0[0]) / w, (pu[1] - p0[1]) / w, (pv[0] - p0[0]) / h, (pv[1] - p0[1]) / h, p0[0], p0[1]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function tela(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; return [c, x]; }

// pseudo-casuale stabile (le mattonelle non "ballano" a ogni frame)
function rnd(i) { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

// ── ora del giorno → luce ──────────────────────────────────────────────────────────────────────
function skyFor(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 7.5 && h < 17.5) return { night: 0, top: '#6fb3e8', bottom: '#cfe8f7', dark: 0.05 };
  if (h >= 17.5 && h < 19.5) return { night: 0.5, top: '#3b3f7a', bottom: '#f09a5c', dark: 0.22 };
  if (h >= 5.5 && h < 7.5) return { night: 0.5, top: '#4a5a9a', bottom: '#f3c08a', dark: 0.2 };
  return { night: 1, top: '#0b1030', bottom: '#28305e', dark: 0.38 };
}

// ── l'ufficio ──────────────────────────────────────────────────────────────────────────────────
export class Office {
  constructor(canvas, overlay, { onSelect, onBoard } = {}) {
    this.canvas = canvas; this.overlay = overlay; this.onSelect = onSelect; this.onBoard = onBoard;
    canvas.width = LW; canvas.height = LH;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.agents = {};
    this.layout = null;
    this.particles = [];
    this.fx = {};                 // agentId → { kind, until }
    this.sprites = {};            // url → Image (avatar spritesheet)
    [this.darkC, this.darkX] = tela(LW, LH);
    this.t0 = performance.now();
    this.timer = setInterval(() => this.draw(), 1000 / 15);
  }

  setLayout(layout) {
    this.layout = layout;
    [LW, LH] = logicalSize(layout.room);
    this.LW = LW; this.LH = LH;
    if (this.canvas.width !== LW || this.canvas.height !== LH) {
      this.canvas.width = LW; this.canvas.height = LH; this.ctx.imageSmoothingEnabled = false;
      [this.darkC, this.darkX] = tela(LW, LH);
    }
    this.iso = makeIso(layout.room); this.staticLayer = null; this.placeLabels();
    this.onResize?.();
  }
  setCosts(c) { this.costs = c; this.staticLayer = null; this.placeLabels(); }
  setAgents(list) { for (const a of list) this.agents[a.id] = a; this.placeLabels(); }
  updateAgent(a) { this.agents[a.id] = a; this.updateLabel(a); }

  // chi sta dove: le postazioni con agent = id; gli agenti senza postazione prendono le "spare"
  stations({ all = false } = {}) {
    if (!this.layout) return [];
    if (all) return this.layout.stations.map((st) => ({ ...st, agentId: st.agent || null }));
    const out = [];
    const used = new Set();
    for (const st of this.layout.stations) {
      if (st.agent && this.agents[st.agent] && this.agents[st.agent].enabled !== false && (this.agents[st.agent].visible !== false || st.kind === 'table')) { out.push({ ...st, agentId: st.agent }); used.add(st.agent); }
    }
    const spare = this.layout.stations.filter((s) => s.spare);
    for (const a of Object.values(this.agents)) {
      if (used.has(a.id) || a.visible === false || a.enabled === false || a.id === 'director') continue;
      const s = spare.shift();
      if (s) { out.push({ ...s, agentId: a.id }); used.add(a.id); }
    }
    return out;
  }

  // coordinate locali di una postazione a parete: a = lungo la parete, b = distanza dalla parete
  local(st) {
    const R = st.wall === 'R', b0 = st.b0 || 0;
    return {
      xy: (a, b) => (R ? [st.at + a, b0 + b] : [b0 + b, st.at + a]),
      box: (a, b, al, bl) => (R ? [st.at + a, b0 + b, al, bl] : [b0 + b, st.at + a, bl, al]),
      front: R ? 'y' : 'x',
    };
  }

  seatOf(st) {
    if (st.spot) return [st.x, st.y];
    if (st.kind === 'table') return [st.x + 1.2, st.y + 0.35];
    const L = this.local(st);
    return L.xy(1.4, 0.75);
  }

  // ── etichette DOM sopra i personaggi (nome + stato; clic = dettaglio) ──────────────────────
  placeLabels() {
    if (!this.layout || !this.overlay) return;
    this.overlay.innerHTML = '';
    for (const st0 of this.stations()) {
      const a = this.agents[st0.agentId]; if (!a) continue;
      const st = this.spotOf(st0.agentId) || st0;
      const [x, y] = this.seatOf(st);
      const [sx, sy] = this.iso(x, y, 74);
      const el = document.createElement('button');
      el.className = `otag${st.kind === 'table' ? ' otag-table' : ''}`;
      el.dataset.agent = a.id;
      el.style.left = `${(sx / LW) * 100}%`;
      el.style.top = `${(sy / LH) * 100}%`;
      el.onclick = () => { if (!this.view?.wasDrag) this.onSelect?.(a.id); };
      this.overlay.appendChild(el);
      this.updateLabel(a);
      // area cliccabile sul personaggio
      const hit = document.createElement('button');
      hit.className = 'ohit'; hit.title = `${a.name} — ${a.role}`;
      const [hx, hy] = this.iso(x, y, 44);
      hit.style.left = `${(hx / LW) * 100}%`; hit.style.top = `${(hy / LH) * 100}%`;
      hit.onclick = () => { if (!this.view?.wasDrag) this.focusAgent(a.id); };
      this.overlay.appendChild(hit);
    }
    this.placeBoardHit();
  }

  // lavagna delle spese: sopra c'è solo un'area sensibile grande quanto la lavagna; il cartellino con le cifre
  // compare passandoci sopra col cursore (o al primo tocco); il clic apre il dettaglio
  placeBoardHit() {
    const d = (this.layout?.decor || []).find((x) => x.type === 'costboard');
    if (!d || !this.overlay || !this.wallRect) return;
    const z0 = d.z ?? 34, r = this.wallRect(d.wall, d.at, d.at + (d.w || 2.8), z0, z0 + 60);
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const c = this.costs || { totalUsd: 0, providers: [] };
    const SHORT = { 'openai-image': 'GPT', 'gemini-image': 'Nano', anthropic: 'API' };
    const paid = (c.providers || []).filter((p) => !p.included && (p.usd > 0 || p.images > 0));
    const sub = paid.length ? paid.slice(0, 3).map((p) => `${SHORT[p.id] || p.short} ${p.usd.toFixed(2)}`).join(' · ') : 'piano: incluso';
    const b = document.createElement('button');
    b.className = 'oboard-hit'; b.title = 'Spese dello Studio';
    Object.assign(b.style, { left: `${(x0 / LW) * 100}%`, top: `${(y0 / LH) * 100}%`, width: `${((x1 - x0) / LW) * 100}%`, height: `${((y1 - y0) / LH) * 100}%` });
    b.innerHTML = `<span class="oboard"><b>SPESE</b> $${Number(c.totalUsd || 0).toFixed(2)}<small>${escapeHTML(sub)}</small><small class="muted">clic per il dettaglio</small></span>`;
    b.onclick = (e) => {
      if (this.view?.wasDrag) return;
      // sui touch il primo tocco mostra il cartellino, il secondo apre il dettaglio
      if (matchMedia('(hover: none)').matches && !b.classList.contains('open')) { b.classList.add('open'); e.preventDefault(); return; }
      this.onBoard?.();
    };
    b.onblur = () => b.classList.remove('open');
    this.overlay.appendChild(b);
  }

  // ── pause: chi è libero da un po' va nell'angolo relax (caffè, telefono sul divano, scacchi) ─────────
  relaxSpots() {
    const out = [];
    for (const d of this.layout?.decor || []) {
      if (d.type === 'coffee') out.push({ x: d.x + 0.8, y: d.y + 1.55, act: 'coffee', face: 'left', group: `c${d.x}` });
      if (d.type === 'sofa' || d.type === 'armchair') {
        const L = d.type === 'sofa' ? (d.w || 2.4) : 1.05, rot = d.rot || 0, H = rot % 2 === 0;
        const seatB = [0.62, 0.62, 0.33, 0.33][rot];
        const face = ['left', 'right', 'right', 'left'][rot];
        for (const k of [0.5]) out.push({ x: d.x + (H ? L * k : seatB), y: d.y + (H ? seatB : L * k), act: 'phone', face, group: `s${d.x}${d.y}${k}` });
      }
      if (d.type === 'chesstable') { out.push({ x: d.x - 0.3, y: d.y + 0.45, act: 'chess', face: 'right', group: `k${d.x}`, pair: 0 }); out.push({ x: d.x + 1.3, y: d.y + 0.45, act: 'chess', face: 'left', group: `k${d.x}`, pair: 1 }); }
    }
    return out;
  }

  updateIdle() {
    const now = performance.now(), fast = /[?&]pausa=veloce/.test(location.search);
    const WAIT = fast ? 2500 : 180000, SLOT = fast ? 12000 : 240000, MAX_AWAY = 3;
    this.idleSince ??= {}; this.away ??= {};
    const hash = (str) => { let h = 7; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
    const slot = Math.floor(Date.now() / SLOT);
    const idle = [];
    for (const st of this.stations()) {
      if (st.kind === 'table') continue;
      const a = this.agents[st.agentId];
      if (!a || (a.runtime?.status || 'IDLE') !== 'IDLE') { delete this.idleSince[st.agentId]; continue; }
      this.idleSince[st.agentId] ??= now;
      if (now - this.idleSince[st.agentId] > WAIT && hash(`${a.id}${slot}`) % 4 !== 0) idle.push(a.id);   // qualcuno resta alla scrivania
    }
    idle.sort((p, q) => hash(`${p}${slot}`) - hash(`${q}${slot}`));
    const spots = this.relaxSpots(), next = {};
    const chess = spots.filter((p) => p.act === 'chess'), other = spots.filter((p) => p.act !== 'chess');
    let i = 0;
    if (chess.length >= 2 && idle.length >= 2 && MAX_AWAY >= 2 && hash(`scacchi${slot}`) % 2 === 0) { next[idle[i++]] = chess[0]; next[idle[i++]] = chess[1]; }
    for (const p of other) { if (i >= Math.min(idle.length, MAX_AWAY)) break; next[idle[i++]] = p; }
    const key = JSON.stringify(Object.entries(next).map(([k, v]) => [k, v.group]).sort());
    if (key !== this.awayKey) { this.away = next; this.awayKey = key; this.placeLabels(); }
  }
  spotOf(agentId) { const p = this.away?.[agentId]; return p ? { spot: true, x: p.x, y: p.y, face: p.face, act: p.act, agentId } : null; }

  drawProp(st, t) {
    const [sx, sy] = this.iso(st.x, st.y, 0), ctx = this.ctx, X = Math.round(sx), Y = Math.round(sy);
    if (st.act === 'coffee') {
      const hx = X + (st.face === 'left' ? -9 : 7), hy = Y - 30;
      ctx.fillStyle = '#fbf6ea'; ctx.fillRect(hx, hy, 4, 4); ctx.fillStyle = '#6b3b1a'; ctx.fillRect(hx, hy, 4, 1); ctx.fillStyle = '#fbf6ea'; ctx.fillRect(hx + 4, hy + 1, 1, 2);
      const k = (t * 0.7) % 1; ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - k)})`; ctx.fillRect(hx + 1 + Math.round(Math.sin(k * 6) * 1.5), hy - 2 - Math.round(k * 8), 1, 2);
    } else if (st.act === 'phone') {
      const hx = X - 2, hy = Y - 34;
      ctx.fillStyle = '#1c1c22'; ctx.fillRect(hx, hy, 5, 8);
      ctx.fillStyle = Math.floor(t * 1.5) % 5 === 0 ? '#ffd166' : '#6fd3ff'; ctx.fillRect(hx + 1, hy + 1, 3, 6);
    }
  }

  // superzoom sul personaggio (la scheda con il ritratto grande la mostra l'app: onFocusChange)
  focusAgent(id) {
    const st = this.spotOf(id) || this.stations().find((x) => x.agentId === id);
    if (!st || !this.view) return this.onSelect?.(id);
    const [x, y] = this.seatOf(st);
    const [sx, sy] = this.iso(x, y, 34);
    this.view.focusOn(sx, sy, 5, id);
    this.onFocusChange?.(id);
  }
  // punto (logico) sopra la testa di un agente: per chi vuole agganciarci qualcosa
  headOf(id) { const st = this.stations().find((x) => x.agentId === id); if (!st) return null; const [x, y] = this.seatOf(st); return this.iso(x, y, 50); }

  updateLabel(a) {
    const el = this.overlay?.querySelector(`.otag[data-agent="${CSS.escape(a.id)}"]`);
    if (!el) { if (this.layout) this.placeLabels(); return; }
    const st = a.runtime?.status || 'IDLE';
    el.innerHTML = `<b>${escapeHTML(a.name)}</b><i class="b-${st}">${st}</i>`;
    el.title = `${a.name} — ${a.role}${a.runtime?.currentTaskTitle ? '\n' + a.runtime.currentTaskTitle : ''}`;
  }

  // ── eventi → effetti ────────────────────────────────────────────────────────────────────────
  event(agentId, type) {
    const st = this.stations().find((s) => s.agentId === agentId);
    if (!st || !this.iso) return;
    const [x, y] = this.seatOf(st);
    const [sx, sy] = this.iso(x, y, 30);
    const now = performance.now();
    if (type === 'agent.editing') {
      const kb = st.kind === 'table' ? [sx, sy] : this.iso(...this.local(st).xy(1.3, 1.0), 28);
      for (let i = 0; i < 4; i++) this.particles.push({ x: kb[0] + (Math.random() - 0.5) * 8, y: kb[1], vx: (Math.random() - 0.5) * 0.6, vy: -0.6 - Math.random() * 0.6, life: 14, color: ['#7ff9e4', '#ff7ac4', '#ffe38a'][i % 3], size: 1 });
    } else if (type === 'agent.completed') {
      this.fx[agentId] = { kind: 'done', until: now + 2500 };
      for (let i = 0; i < 26; i++) this.particles.push({ x: sx, y: sy - 8, vx: (Math.random() - 0.5) * 3, vy: -1.5 - Math.random() * 2, g: 0.12, life: 30 + Math.random() * 15, color: ['#ff5d8f', '#ffd166', '#7bd88f', '#6fd3ff', '#ffffff'][i % 5], size: 1 + (i % 2) });
    } else if (type === 'agent.failed') {
      this.fx[agentId] = { kind: 'fail', until: now + 2500 };
      for (let i = 0; i < 8; i++) this.particles.push({ x: sx + (Math.random() - 0.5) * 10, y: sy - 4, vx: (Math.random() - 0.5) * 0.4, vy: -0.4 - Math.random() * 0.3, life: 28, color: '#8a8a96', size: 2, fade: true });
    } else if (type === 'agent.started_task') {
      this.fx[agentId] = { kind: 'start', until: now + 900 };
    }
  }

  // ── disegno ─────────────────────────────────────────────────────────────────────────────────
  draw() {
    if (!this.layout) return;
    const ctx = this.ctx, iso = this.iso, room = this.layout.room;
    const t = (performance.now() - this.t0) / 1000;
    const date = new Date();
    const sky = skyFor(date);
    this.sky = sky;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, LW, LH);

    // strato statico (pavimento, pareti) ridisegnato solo quando cambia l'ora del cielo; con lo sfondo dipinto
    // (un'immagine sotto la tela) qui si disegnano solo i personaggi e la luce
    const key = `${sky.top}|${date.getMinutes()}`;
    if (!this.painted) {
      if (!this.staticLayer || this.staticKey !== key) { this.staticLayer = this.drawStatic(sky, date); this.staticKey = key; }
      ctx.drawImage(this.staticLayer, 0, 0);
    }

    // oggetti a pavimento e personaggi, ordinati per profondità (con lo sfondo dipinto: solo i personaggi)
    for (const it of this.sceneItems(t, { furniture: !this.painted, characters: true })) it.draw();

    // particelle
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g || 0; p.life--;
      ctx.globalAlpha = p.fade ? Math.max(0, p.life / 28) : 1;
      ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.life > 0);

    this.drawLight(sky, t);
    this.drawDaylight(sky, t, date);

    // fumetti sopra la testa (dopo la luce: restano leggibili)
    for (const st of this.stations()) this.drawBubble(this.spotOf(st.agentId) || st, this.agents[st.agentId], t);
    if (!this.idleT || t - this.idleT > 2) { this.idleT = t; this.updateIdle(); }
  }

  sceneItems(t, { furniture = true, characters = true } = {}) {
    const items = [];
    const NOBODY = { id: '_', name: '', runtime: { status: 'IDLE' }, avatar: {} };
    if (furniture) for (const d of this.layout.decor) if (!d.wall && d.type !== 'rug') items.push({ k: d.x + d.y + (d.type === 'crates' ? 1 : 0.5), draw: () => this.drawDecor(d, t) });
    for (const st of this.stations({ all: !characters })) {
      const a = this.agents[st.agentId] || NOBODY;
      const [cx, cy] = this.seatOf(st);
      const away = characters && this.spotOf(st.agentId);
      if (away) items.push({ k: away.x + away.y + 0.3, draw: () => { this.drawCharacter(away, a, t); this.drawProp(away, t); } });
      if (st.kind === 'table') {
        if (characters && !away) items.push({ k: cx + cy, draw: () => this.drawCharacter(st, a, t) });
        if (furniture) items.push({ k: st.x + st.y + 1.9, draw: () => this.drawTable(st, a, t) });
        continue;
      }
      const L = this.local(st);
      const [bx, by] = L.xy(1.4, 0.3);
      if (furniture) items.push({ k: bx + by, draw: () => this.drawChair(st, a) });
      if (characters && !away) items.push({ k: cx + cy, draw: () => (this.painted ? this.behindDesk(st, () => this.drawCharacter(st, a, t)) : this.drawCharacter(st, a, t)) });
      const [dx, dy] = L.xy(1.4, 1.9);
      if (furniture) items.push({ k: dx + dy, draw: () => this.drawStation(st, a, t) });
    }
    return items.sort((p, q) => p.k - q.k);
  }

  // con lo sfondo dipinto la scrivania è nel dipinto: il personaggio si ritaglia dove la scrivania (e i monitor) gli
  // stanno davanti, così resta "seduto dietro" come nel disegno in codice
  behindDesk(st, draw) {
    const L = this.local(st), D0 = 1.15, DL = 1.2;
    const hull = (a0, a1, b0, b1, z0, z1) => {
      const pts = [];
      for (const a of [a0, a1]) for (const b of [b0, b1]) for (const z of [z0, z1]) pts.push(this.iso(...L.xy(a, b), z));
      pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
      for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
      return [...lo.slice(0, -1), ...up.slice(0, -1)];
    };
    const ctx = this.ctx;
    ctx.save();
    for (const h of [hull(0.05, 2.95, D0 - 0.05, D0 + DL + 0.05, 0, 27), hull(0.4, 2.6, D0 + 0.05, D0 + 0.55, 27, 43)]) {
      ctx.beginPath(); ctx.rect(0, 0, LW, LH);
      h.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.clip('evenodd');
    }
    try { draw(); } finally { ctx.restore(); }
  }

  // MAQUETTE per la ridipintura: stanza e mobili di giorno, senza personaggi né etichette, ingrandita e messa in un
  // riquadro 3:2 (il formato dei generatori di immagini). Restituisce anche dove sta la stanza nel riquadro.
  blockout(scale = 2) {
    const keep = this.ctx;
    const [off, ox] = tela(LW, LH);
    this.ctx = ox;
    const date = new Date(); date.setHours(12, 0, 0, 0);
    try {
      ox.drawImage(this.drawStatic(skyFor(date), date), 0, 0);
      for (const it of this.sceneItems(0, { furniture: true, characters: false })) it.draw();
    } finally { this.ctx = keep; }
    const W0 = LW * scale, H0 = LH * scale;
    const W = Math.max(W0, Math.round(H0 * 1.5)), H = Math.max(H0, Math.round(W / 1.5));
    const [out, x] = tela(W, H);
    x.fillStyle = '#0a0d22'; x.fillRect(0, 0, W, H);
    const px = Math.round((W - W0) / 2), py = Math.round((H - H0) / 2);
    x.drawImage(off, px, py, W0, H0);
    return { dataURL: out.toDataURL('image/png'), W, H, ox: px, oy: py, scale, hash: layoutHash(this.layout) };
  }

  // sfondo dipinto (da Cosetta): un'immagine sotto la tela, allineata con la maquette da cui è nato
  setPaint(paint, { use } = {}) {
    this.paint = paint || null;
    const stage = this.canvas.parentElement;
    let img = stage?.querySelector('img.office-paint');
    this.paintMatches = !!(paint && paint.hash === layoutHash(this.layout));
    if (use !== undefined) this.usePaint = use;
    this.painted = !!(this.paint && this.paintMatches && this.usePaint !== false);
    if (!this.painted) { if (img) img.hidden = true; this.staticLayer = null; return; }
    if (!img && stage) { img = document.createElement('img'); img.className = 'office-paint'; img.alt = ''; stage.insertBefore(img, this.canvas); }
    if (!img) return;
    img.hidden = false;
    if (img.getAttribute('src') !== paint.url) img.src = paint.url;
    const k = 1 / (paint.scale || 2);
    Object.assign(img.style, { left: `${-paint.ox * k}px`, top: `${-paint.oy * k}px`, width: `${paint.W * k}px`, height: `${paint.H * k}px` });
  }

  drawStatic(sky, date) {
    const [c, ctx] = tela(LW, LH);
    const iso = this.iso, { w: W, d: D, wallH: H } = this.layout.room;
    // base della "maquette": spessore del pavimento
    poly(ctx, [iso(0, D, 0), iso(W, D, 0), iso(W, D, -12), iso(0, D, -12)], PAL.slab);
    poly(ctx, [iso(W, 0, 0), iso(W, D, 0), iso(W, D, -12), iso(W, 0, -12)], PAL.slabD);
    // pareti: sinistra (x=0) e destra (y=0), con spessore
    poly(ctx, [iso(0, 0, 0), iso(0, D, 0), iso(0, D, H), iso(0, 0, H)], PAL.plasterL);
    poly(ctx, [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, H), iso(0, 0, H)], PAL.plaster);
    // zoccolo in pietra con i conci
    const ZH = 30;
    poly(ctx, [iso(0, 0, 0), iso(0, D, 0), iso(0, D, ZH), iso(0, 0, ZH)], PAL.stoneL);
    poly(ctx, [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, ZH), iso(0, 0, ZH)], PAL.stone);
    ctx.fillStyle = PAL.mortar;
    for (let row = 0; row < 3; row++) {
      const z = row * 10 + 10;
      for (let i = 0; i <= W * 2; i++) { const [sx, sy] = iso(i / 2 + (row % 2) * 0.25, 0, z); ctx.fillRect(Math.round(sx), Math.round(sy), 1, 10); }
      for (let i = 0; i <= D * 2; i++) { const [sx, sy] = iso(0, i / 2 + (row % 2) * 0.25, z); ctx.fillRect(Math.round(sx), Math.round(sy), 1, 10); }
      poly(ctx, [iso(0, 0, z), iso(W, 0, z), iso(W, 0, z + 1), iso(0, 0, z + 1)], PAL.mortar);
      poly(ctx, [iso(0, 0, z), iso(0, D, z), iso(0, D, z + 1), iso(0, 0, z + 1)], PAL.mortar);
    }
    // intonaco "vissuto": macchioline
    for (let i = 0; i < 160; i++) {
      const onR = i % 2 === 0; const a = rnd(i) * (onR ? W : D); const z = ZH + 4 + rnd(i + 99) * (H - ZH - 16);
      const [sx, sy] = onR ? iso(a, 0, z) : iso(0, a, z);
      ctx.fillStyle = onR ? '#e0cbb0' : '#c8b095'; ctx.fillRect(Math.round(sx), Math.round(sy), 1 + (i % 3 === 0), 1);
    }
    // travi di legno in alto e pilastro d'angolo
    poly(ctx, [iso(0, 0, H - 9), iso(W, 0, H - 9), iso(W, 0, H), iso(0, 0, H)], PAL.beam);
    poly(ctx, [iso(0, 0, H - 9), iso(0, D, H - 9), iso(0, D, H), iso(0, 0, H)], PAL.beamD);
    for (let i = 1; i < W; i += 3) poly(ctx, [iso(i, 0, H - 9), iso(i + 0.35, 0, H - 9), iso(i + 0.35, 0, H), iso(i, 0, H)], PAL.beamD);
    poly(ctx, [iso(0, 0, 0), iso(0.001, 0, 0), iso(0.001, 0, H), iso(0, 0, H)], PAL.beamD, PAL.beamD);
    // bordo superiore delle pareti (spessore) e testate
    poly(ctx, [iso(-0.45, -0.45, H), iso(W, -0.45, H), iso(W, 0, H), iso(0, 0, H), iso(0, D, H), iso(-0.45, D, H)], PAL.capL);
    poly(ctx, [iso(W, -0.45, 0), iso(W, 0, 0), iso(W, 0, H), iso(W, -0.45, H)], PAL.cap);
    poly(ctx, [iso(-0.45, D, 0), iso(0, D, 0), iso(0, D, H), iso(-0.45, D, H)], PAL.cap);
    poly(ctx, [iso(W, -0.45, -12), iso(W, 0, -12), iso(W, 0, 0), iso(W, -0.45, 0)], PAL.slabD);
    poly(ctx, [iso(-0.45, D, -12), iso(0, D, -12), iso(0, D, 0), iso(-0.45, D, 0)], PAL.slab);
    // pavimento in cotto
    for (let x = 0; x < W; x++) for (let y = 0; y < D; y++) {
      const tone = rnd(x * 31 + y * 7) * 0.06 - 0.03;
      poly(ctx, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], PAL.grout);
      poly(ctx, [iso(x + 0.04, y + 0.04), iso(x + 0.96, y + 0.04), iso(x + 0.96, y + 0.96), iso(x + 0.04, y + 0.96)], shade((x + y) % 2 ? PAL.tileA : PAL.tileB, tone));
    }
    // ombra delle pareti sul pavimento
    ctx.globalAlpha = 0.18;
    poly(ctx, [iso(0, 0), iso(W, 0), iso(W, 0.7), iso(0.7, 0.7), iso(0.7, D), iso(0, D)], '#2b1a14');
    ctx.globalAlpha = 1;
    // tappeto (piatto: va sotto a tutto)
    for (const d of this.layout.decor.filter((x) => x.type === 'rug')) this.drawRug(ctx, d);
    // oggetti a parete
    for (const d of this.layout.decor.filter((x) => x.wall)) this.drawWallDecor(ctx, d, sky, date);
    return c;
  }

  wallRect(wall, a0, a1, z0, z1) {
    const iso = this.iso;
    return wall === 'R'
      ? { p0: iso(a0, 0, z1), pu: iso(a1, 0, z1), pv: iso(a0, 0, z0), pts: [iso(a0, 0, z0), iso(a1, 0, z0), iso(a1, 0, z1), iso(a0, 0, z1)] }
      : { p0: iso(0, a1, z1), pu: iso(0, a0, z1), pv: iso(0, a1, z0), pts: [iso(0, a0, z0), iso(0, a1, z0), iso(0, a1, z1), iso(0, a0, z1)] };
  }

  drawRug(ctx, d) {
    const iso = this.iso, { x, y, w, d: dd } = d;
    poly(ctx, [iso(x, y), iso(x + w, y), iso(x + w, y + dd), iso(x, y + dd)], PAL.rugC);
    poly(ctx, [iso(x + 0.15, y + 0.15), iso(x + w - 0.15, y + 0.15), iso(x + w - 0.15, y + dd - 0.15), iso(x + 0.15, y + dd - 0.15)], PAL.rugB);
    poly(ctx, [iso(x + 0.3, y + 0.3), iso(x + w - 0.3, y + 0.3), iso(x + w - 0.3, y + dd - 0.3), iso(x + 0.3, y + dd - 0.3)], PAL.rug);
    // motivo a rombi
    for (let i = 1; i < w * 2 - 1; i++) for (let j = 1; j < dd * 2 - 1; j++) {
      if ((i + j) % 3) continue;
      const cx = x + i / 2, cy = y + j / 2;
      poly(ctx, [iso(cx, cy - 0.12), iso(cx + 0.12, cy), iso(cx, cy + 0.12), iso(cx - 0.12, cy)], (i + j) % 2 ? PAL.rugB : '#c9674a');
    }
    // frange
    ctx.fillStyle = '#efe2c4';
    for (let i = 0; i < w * 4; i++) { const [sx, sy] = iso(x + i / 4, y + dd); ctx.fillRect(Math.round(sx), Math.round(sy), 1, 2); }
  }

  // ── PARETE VETRATA: un'unica vetrata a tutta altezza con il panorama (Gran Sasso, colline, il borgo), la luce
  // del momento (alba, giorno, tramonto, notte), i riflessi sul vetro e i riquadri di luce che entrano sul pavimento
  panorama(W, Hh, sky, date, seed = 1) {
    const [c, x] = tela(W, Hh);
    const h = date.getHours() + date.getMinutes() / 60;
    const night = sky.night > 0.7, dusk = !night && sky.night > 0;
    const evening = h >= 12;
    // cielo: tre fasce con bagliore sull'orizzonte
    const g = x.createLinearGradient(0, 0, 0, Hh * 0.75);
    if (night) { g.addColorStop(0, '#070b22'); g.addColorStop(0.6, '#141c46'); g.addColorStop(1, '#27305f'); }
    else if (dusk) { g.addColorStop(0, evening ? '#2d2f6b' : '#3d4f94'); g.addColorStop(0.55, evening ? '#c4607a' : '#e7a0a0'); g.addColorStop(1, evening ? '#ffb45c' : '#ffd79a'); }
    else { g.addColorStop(0, '#4f9ee0'); g.addColorStop(0.6, '#8cc6ef'); g.addColorStop(1, '#d9eef8'); }
    x.fillStyle = g; x.fillRect(0, 0, W, Hh);
    // sole / luna con alone
    const t = night ? ((h + 24 - 19) % 24) / 11 : Math.min(1, Math.max(0, (h - 6) / 13));
    const bx = W * (0.12 + 0.76 * t), by = Hh * (0.55 - Math.sin(t * Math.PI) * 0.42);
    const halo = x.createRadialGradient(bx, by, 0, bx, by, night ? 26 : 60);
    halo.addColorStop(0, night ? 'rgba(220,230,255,0.45)' : dusk ? 'rgba(255,190,110,0.8)' : 'rgba(255,250,215,0.75)'); halo.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = halo; x.fillRect(0, 0, W, Hh);
    x.fillStyle = night ? '#eef0ff' : dusk ? '#ffd28a' : '#fffbe6'; x.beginPath(); x.arc(bx, by, night ? 5 : 7, 0, 7); x.fill();
    if (night) { x.fillStyle = '#141c46'; x.beginPath(); x.arc(bx + 2.5, by - 1, 4.4, 0, 7); x.fill(); }
    if (night) for (let i = 0; i < 140; i++) { const sx = rnd(i * 7 + seed) * W, sy = rnd(i * 13 + seed) * Hh * 0.55; x.fillStyle = `rgba(255,255,255,${0.35 + rnd(i) * 0.65})`; x.fillRect(Math.round(sx), Math.round(sy), rnd(i + 3) > 0.93 ? 2 : 1, 1); }
    // nuvole morbide (si spostano piano con i minuti)
    const drift = (date.getHours() * 60 + date.getMinutes()) * 0.35;
    for (let i = 0; i < 7; i++) {
      const cx = ((rnd(i + 40) * W * 1.4 + drift * (0.5 + rnd(i) * 0.5)) % (W + 120)) - 60, cy = Hh * (0.08 + rnd(i + 9) * 0.28), cw = 30 + rnd(i + 2) * 50;
      for (let k = 0; k < 9; k++) { x.fillStyle = night ? 'rgba(120,130,190,0.06)' : dusk ? 'rgba(255,200,190,0.16)' : 'rgba(255,255,255,0.22)'; x.beginPath(); x.ellipse(cx + k * cw * 0.11, cy + Math.sin(k * 1.7) * 2.5, cw * (0.18 + (k % 3) * 0.05), 3 + (k % 3) * 1.6, 0, 0, 7); x.fill(); }
    }
    // il Gran Sasso: creste frastagliate, facce in luce e in ombra, neve, foschia
    const ridge = (u, base, amp, c1) => base - amp * (0.55 * Math.abs(Math.sin(u * 0.011 + c1)) + 0.3 * Math.abs(Math.sin(u * 0.037 + c1 * 3)) + 0.15 * Math.abs(Math.sin(u * 0.11 + c1 * 7)));
    const haze = night ? '#1c2452' : dusk ? '#b67a8e' : '#a9c3de';
    for (const L of [{ base: Hh * 0.46, amp: Hh * 0.32, c1: 0.7, col: night ? '#1a2148' : dusk ? '#6d5a86' : '#7f97bd', snow: true }, { base: Hh * 0.53, amp: Hh * 0.18, c1: 2.9, col: night ? '#151b3b' : dusk ? '#5b5470' : '#6f8aa6', snow: !night }]) {
      for (let px = 0; px < W; px++) {
        const top = ridge(px + seed * 50, L.base, L.amp, L.c1), prev = ridge(px - 1 + seed * 50, L.base, L.amp, L.c1);
        const lit = (top - prev) * (evening ? 1 : -1) > 0;
        x.fillStyle = lit ? shade(L.col, night ? 0.05 : 0.12) : shade(L.col, -0.08); x.fillRect(px, Math.round(top), 1, Hh);
        if (L.snow && top < L.base - L.amp * 0.62) { x.fillStyle = night ? '#9aa6d8' : lit ? '#ffffff' : '#dfe7f5'; x.fillRect(px, Math.round(top), 1, Math.max(1, Math.round((L.base - L.amp * 0.62 - top) * 0.7))); }
      }
      x.fillStyle = haze; x.globalAlpha = 0.28; x.fillRect(0, L.base - L.amp * 0.2, W, Hh); x.globalAlpha = 1;
    }
    // colline con i boschi
    for (const L of [{ base: Hh * 0.6, amp: Hh * 0.07, c1: 5.1, col: night ? '#101830' : dusk ? '#4c5a44' : '#6b9a57' }, { base: Hh * 0.68, amp: Hh * 0.05, c1: 8.3, col: night ? '#0c1426' : dusk ? '#3d4d38' : '#5a8a48' }]) {
      for (let px = 0; px < W; px++) { const top = L.base - L.amp * (0.5 + 0.5 * Math.sin(px * 0.017 + L.c1) * Math.sin(px * 0.005 + L.c1)); x.fillStyle = L.col; x.fillRect(px, Math.round(top), 1, Hh); }
      for (let i = 0; i < W / 3; i++) { const px = rnd(i * 3 + L.c1) * W, py = L.base - L.amp * 0.2 + rnd(i * 5 + L.c1) * Hh * 0.12; x.fillStyle = shade(L.col, -0.18); x.beginPath(); x.arc(px, py, 1.6 + rnd(i) * 1.4, 0, 7); x.fill(); }
    }
    // il borgo sul colle: case in pietra, tetti in coppi, campanile, finestre accese la sera
    const vx = W * 0.5, vy = Hh * 0.6, wall = night ? '#2a3160' : dusk ? '#c79a86' : '#e0c49e', roof = night ? '#1c2046' : '#b0563c';
    for (let i = 0; i < 30; i++) {
      const hx = vx - 120 + i * 8 + Math.round(rnd(i) * 4), hh = 6 + Math.round(rnd(i + 5) * 7) - Math.abs(i - 15) * 0.3, hw = 7 + Math.round(rnd(i + 8) * 3);
      const top = vy - hh - (15 - Math.abs(i - 15)) * 0.8;
      x.fillStyle = shade(wall, (i % 3) * -0.05); x.fillRect(hx, top, hw, Hh);
      x.fillStyle = roof; x.fillRect(hx - 1, top - 2, hw + 2, 2); x.fillStyle = shade(roof, -0.2); x.fillRect(hx - 1, top, hw + 2, 1);
      for (let q = 0; q < 2; q++) { x.fillStyle = night || dusk ? (rnd(i * 4 + q) > 0.35 ? '#ffd27a' : shade(wall, -0.3)) : shade(wall, -0.35); x.fillRect(hx + 2 + q * 3, top + 3, 1, 2); }
    }
    x.fillStyle = shade(wall, -0.03); x.fillRect(vx + 4, vy - 38, 6, 30); x.fillStyle = roof; x.fillRect(vx + 3, vy - 41, 8, 3); x.fillRect(vx + 6, vy - 45, 2, 4);
    x.fillStyle = night ? '#ffd27a' : '#3a2a20'; x.fillRect(vx + 6, vy - 34, 2, 3);
    if (night || dusk) { const gl = x.createRadialGradient(vx, vy - 10, 0, vx, vy - 10, 90); gl.addColorStop(0, 'rgba(255,190,100,0.22)'); gl.addColorStop(1, 'rgba(255,190,100,0)'); x.fillStyle = gl; x.fillRect(0, 0, W, Hh); }
    // primo piano: prato, cipressi, e il muretto del terrazzo
    x.fillStyle = night ? '#0a1120' : dusk ? '#34462f' : '#4f7f3f'; x.fillRect(0, Hh * 0.74, W, Hh);
    for (let i = 0; i < 9; i++) { const px = rnd(i + 70) * W, ph = 14 + rnd(i + 71) * 12; x.fillStyle = night ? '#08101c' : '#2f5a33'; x.beginPath(); x.ellipse(px, Hh * 0.76 - ph / 2, 3, ph / 2, 0, 0, 7); x.fill(); }
    return c;
  }

  drawGlassWall(ctx, d, sky, date) {
    const H = this.layout.room.wallH, wall = d.wall || 'L';
    const a0 = d.from ?? 0.3, a1 = d.to ?? ((wall === 'L' ? this.layout.room.d : this.layout.room.w) - 0.3);
    const z0 = 30, z1 = H - 10, PX = 30;
    const W = Math.round((a1 - a0) * PX), Hh = Math.round(z1 - z0);
    const pano = this.panorama(W, Hh, sky, date, wall === 'L' ? 3 : 9);
    const inner = this.wallRect(wall, a0, a1, z0, z1);
    ctx.save(); ctx.beginPath(); inner.pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
    mapFace(ctx, pano, inner.p0, inner.pu, inner.pv);
    // vetro: leggera tinta, riflessi obliqui
    const [gC, gx] = tela(W, Hh);
    gx.fillStyle = sky.night > 0.7 ? 'rgba(90,120,200,0.10)' : 'rgba(200,230,255,0.10)'; gx.fillRect(0, 0, W, Hh);
    for (let i = 0; i < 9; i++) { const sx = rnd(i + 21) * W; gx.fillStyle = `rgba(255,255,255,${0.05 + rnd(i) * 0.07})`; gx.beginPath(); gx.moveTo(sx, 0); gx.lineTo(sx + 16 + rnd(i + 2) * 22, 0); gx.lineTo(sx - 30 + rnd(i + 2) * 22, Hh); gx.lineTo(sx - 46, Hh); gx.closePath(); gx.fill(); }
    mapFace(ctx, gC, inner.p0, inner.pu, inner.pv);
    ctx.restore();
    // telaio: montanti sottili in legno scuro, traverso, davanzale e bordo in alto
    const frame = PAL.beamD, frameL = PAL.beam;
    const step = d.pane || 2.4, n = Math.max(1, Math.round((a1 - a0) / step));
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; const m = this.wallRect(wall, a - 0.06, a + 0.06, z0, z1); poly(ctx, m.pts, frame); const hl = this.wallRect(wall, a - 0.06, a - 0.02, z0, z1); poly(ctx, hl.pts, frameL); }
    const tz = z0 + (z1 - z0) * 0.72; const tr = this.wallRect(wall, a0, a1, tz - 1.5, tz + 1.5); poly(ctx, tr.pts, frame);
    const top = this.wallRect(wall, a0 - 0.08, a1 + 0.08, z1, z1 + 3); poly(ctx, top.pts, frame);
    const sill = this.wallRect(wall, a0 - 0.12, a1 + 0.12, z0 - 4, z0); poly(ctx, sill.pts, PAL.woodT);
    const sillF = this.wallRect(wall, a0 - 0.12, a1 + 0.12, z0 - 6, z0 - 4); poly(ctx, sillF.pts, PAL.woodS);
    // la luce che entra dalla vetrata è animata: drawDaylight()
  }

  drawWallDecor(ctx, d, sky, date) {
    const H = this.layout.room.wallH;
    if (d.type === 'glasswall') return this.drawGlassWall(ctx, d, sky, date);
    // mobili appoggiati al muro: si disegnano con box() sulla tela statica
    if (['bookcase', 'shelf', 'frame'].includes(d.type)) {
      const keep = this.ctx; this.ctx = ctx;
      const R = d.wall === 'R';
      const bx = (a, b, al, bl, z, h, c1, c2, c3) => { const [x, y, w, dd] = R ? [d.at + a, b, al, bl] : [b, d.at + a, bl, al]; this.box(x, y, z, w, dd, h, c1, c2, c3); };
      const w = d.w || 1.6;
      if (d.type === 'bookcase') {
        const h = d.h || 70;
        bx(0, 0, w, 0.55, 0, h, PAL.woodT, PAL.woodF, PAL.woodS);
        const shelves = Math.max(3, Math.round(h / 17));
        const cols = ['#8e5ad6', '#d65a5a', '#3d7a3a', '#e0a53d', '#5a8fd6', '#c9ccd4', '#b35a39'];
        for (let i = 0; i < shelves; i++) {
          const z = 3 + i * ((h - 6) / shelves);
          let a = 0.08, k = i * 3;
          while (a < w - 0.15) { const bw = 0.08 + rnd(k) * 0.08, bh = 8 + rnd(k + 7) * 5; if (rnd(k + 3) > 0.2) bx(a, 0.3, bw, 0.28, z, bh, shade(cols[k % cols.length], 0.1), cols[k % cols.length], shade(cols[k % cols.length], -0.25)); a += bw + 0.01; k++; }
          bx(0.02, 0.02, w - 0.04, 0.56, z - 1.5, 1.5, PAL.woodT, PAL.woodF, PAL.woodS);
        }
        if (d.top !== false) { bx(w * 0.25, 0.1, 0.35, 0.35, h, 8, '#7a3a24', PAL.pot, PAL.potD); const [px, py] = R ? this.iso(d.at + w * 0.25 + 0.17, 0.27, h + 8) : this.iso(0.27, d.at + w * 0.25 + 0.17, h + 8); for (const [ox, oy, r] of [[0, -4, 5], [-4, -1, 4], [4, -1, 4], [-2, -8, 3], [3, -7, 3]]) { ctx.fillStyle = PAL.leafD; ctx.beginPath(); ctx.arc(px + ox, py + oy + 1, r, 0, 7); ctx.fill(); ctx.fillStyle = PAL.leaf; ctx.beginPath(); ctx.arc(px + ox, py + oy, r - 1, 0, 7); ctx.fill(); } }
      }
      if (d.type === 'shelf') {
        const z = d.z || 78;
        bx(0, 0, w, 0.4, z, 2, PAL.woodT, PAL.woodF, PAL.woodS);
        for (let i = 0; i < Math.floor(w / 0.45); i++) {
          const a = 0.1 + i * 0.45;
          if (i % 3 === 1) { bx(a, 0.1, 0.25, 0.25, z + 2, 6, '#7a3a24', PAL.pot, PAL.potD); const [px, py] = R ? this.iso(d.at + a + 0.12, 0.22, z + 8) : this.iso(0.22, d.at + a + 0.12, z + 8); ctx.fillStyle = PAL.leaf; for (let v = 0; v < 5; v++) ctx.fillRect(Math.round(px) - 3 + v * 1.5, Math.round(py) - 2 + (v % 2) * 2, 1, 8 - (v % 2) * 3); }
          else bx(a, 0.1, 0.22, 0.25, z + 2, 5 + (i % 2) * 3, i % 2 ? '#e8e1d4' : '#c9a24a', i % 2 ? '#cfc6b6' : '#a8862e', i % 2 ? '#b9b0a0' : '#8a6c20');
        }
      }
      if (d.type === 'frame') {
        const z0 = d.z || 52, hh = d.h || 22;
        const r = this.wallRect(d.wall, d.at, d.at + w, z0, z0 + hh);
        poly(ctx, r.pts, PAL.woodD);
        const [img, x] = tela(24, 18);
        const theme = d.picture || 'borgo';
        if (theme === 'borgo') { x.fillStyle = '#9fc4e0'; x.fillRect(0, 0, 24, 18); x.fillStyle = '#6b8f5a'; x.fillRect(0, 11, 24, 7); x.fillStyle = '#caa98a'; for (const [a, b, c2, e] of [[3, 7, 5, 5], [8, 5, 4, 7], [12, 8, 6, 4], [18, 6, 4, 6]]) x.fillRect(a, b, c2, e); x.fillStyle = '#b3533a'; for (const [a, b, c2] of [[2, 6, 7], [7, 4, 6], [11, 7, 8], [17, 5, 6]]) x.fillRect(a, b, c2, 1); x.fillStyle = '#fff4c4'; x.fillRect(19, 1, 3, 3); }
        else if (theme === 'foto') { x.fillStyle = '#e9dfc8'; x.fillRect(0, 0, 24, 18); for (let i = 0; i < 5; i++) { x.fillStyle = ['#6b4a33', '#3b2a20', '#8a5a31', '#2a1d16', '#7a4a26'][i]; x.fillRect(2 + i * 4, 6, 3, 3); x.fillStyle = '#a0746a'; x.fillRect(2 + i * 4, 9, 3, 6); } x.fillStyle = '#b9a676'; x.fillRect(0, 15, 24, 3); }
        else { x.fillStyle = '#1b1430'; x.fillRect(0, 0, 24, 18); x.fillStyle = '#ff4fa3'; for (let i = 0; i < 24; i++) x.fillRect(i, 9 + Math.round(Math.sin(i / 2) * 3), 1, 1); drawText(x, 'TQ', 8, 2, '#3fe0d0'); }
        const inner = this.wallRect(d.wall, d.at + 0.08, d.at + w - 0.08, z0 + 2, z0 + hh - 2);
        mapFace(ctx, img, inner.p0, inner.pu, inner.pv);
      }
      this.ctx = keep;
      return;
    }
    if (d.type === 'window') {
      // finestra: un pezzo del panorama continuo (montagne, colline, il borgo), con davanzale e gerani
      const w = d.w || 1.6, z0 = d.big ? 36 : 44, z1 = H - (d.big ? 16 : 22), PX = 26;
      const r = this.wallRect(d.wall, d.at, d.at + w, z0 - 3, z1 + 3);
      poly(ctx, r.pts, PAL.woodD);
      const TWp = Math.max(8, Math.round(w * PX)), THp = Math.round(z1 - z0);
      const [img, x] = tela(TWp, THp);
      const night = sky.night > 0.4, dusk = sky.night > 0 && !night;
      const g = x.createLinearGradient(0, 0, 0, THp); g.addColorStop(0, sky.top); g.addColorStop(1, sky.bottom);
      x.fillStyle = g; x.fillRect(0, 0, TWp, THp);
      const U = (d.wall === 'L' ? 700 : 0) + d.at * PX;          // coordinata del panorama: le finestre vicine continuano
      const ridge = (u, a, b, c) => a + Math.sin(u * 0.021 + c) * b + Math.sin(u * 0.057 + c * 2) * b * 0.45 + Math.abs(Math.sin(u * 0.009 + c)) * b * 0.9;
      if (night) { for (let i = 0; i < 26; i++) { const sx = Math.floor(rnd(i + U) * TWp), sy = Math.floor(rnd(i * 3 + U) * THp * 0.45); x.fillStyle = i % 5 ? '#cfd8ff' : '#ffffff'; x.fillRect(sx, sy, 1, 1); } }
      else { x.fillStyle = '#ffffffb0'; for (let i = 0; i < 3; i++) { const cx = Math.round(((U * 0.6 + i * 37 + date.getMinutes() * 0.4) % (TWp + 30)) - 15), cy = 6 + i * 5; x.fillRect(cx, cy, 10, 2); x.fillRect(cx + 3, cy - 1, 5, 1); } }
      if ((U % 180) < PX * w && d.wall === 'L') { const mx = Math.round(12 - (U % 180) + 20); x.fillStyle = night ? '#f5f1d6' : '#fff3c4'; x.beginPath(); x.arc(mx, 9, 4, 0, 7); x.fill(); if (night) { x.fillStyle = sky.top; x.beginPath(); x.arc(mx + 2, 8, 3.4, 0, 7); x.fill(); } }
      const layers = [
        { base: THp * 0.38, amp: THp * 0.13, c: 1.3, col: night ? '#1a1f3d' : dusk ? '#7c6a8f' : '#8ea3c4', snow: !night },   // Gran Sasso lontano
        { base: THp * 0.55, amp: THp * 0.07, c: 4.1, col: night ? '#141a33' : dusk ? '#5d6a58' : '#6f9a5c' },               // colline
        { base: THp * 0.7, amp: THp * 0.04, c: 7.7, col: night ? '#10152a' : '#5a8a4c' },
      ];
      for (const L of layers) for (let px = 0; px < TWp; px++) {
        const top = Math.round(L.base - ridge(U + px, 0, L.amp, L.c));
        x.fillStyle = L.col; x.fillRect(px, top, 1, THp - top);
        if (L.snow && top < L.base - L.amp * 0.9) { x.fillStyle = '#f4f6fb'; x.fillRect(px, top, 1, 2); }
      }
      // il borgo: case con i tetti in coppi e il campanile, alberi
      const houseCol = night ? '#252b52' : '#d9b48f', roofCol = night ? '#171b38' : '#a6533c';
      for (let hx = -((U) % 11); hx < TWp; hx += 11) {
        const k = Math.floor((U + hx) / 11), hh = 7 + Math.floor(rnd(k) * 6), hw = 7 + Math.floor(rnd(k + 9) * 4), by = Math.round(THp * 0.8);
        x.fillStyle = houseCol; x.fillRect(hx, by - hh, hw, hh + THp);
        x.fillStyle = roofCol; x.fillRect(hx - 1, by - hh - 2, hw + 2, 2);
        x.fillStyle = night ? (rnd(k + 3) > 0.4 ? '#ffcf6b' : '#1a1f3d') : '#6b4a33'; x.fillRect(hx + 2, by - hh + 3, 1, 2); x.fillRect(hx + hw - 3, by - hh + 3, 1, 2);
        if (k % 9 === 4) { x.fillStyle = houseCol; x.fillRect(hx + 2, by - hh - 12, 4, 12); x.fillStyle = roofCol; x.fillRect(hx + 1, by - hh - 14, 6, 2); x.fillRect(hx + 3, by - hh - 16, 2, 2); }
        if (k % 4 === 1) { x.fillStyle = night ? '#0e1a14' : '#3f7a3a'; x.beginPath(); x.arc(hx + 9, by - 5, 3, 0, 7); x.fill(); }
      }
      x.fillStyle = night ? '#0b1020' : '#4f7d42'; x.fillRect(0, Math.round(THp * 0.8) + 2, TWp, THp);
      const inner = this.wallRect(d.wall, d.at, d.at + w, z0, z1);
      ctx.save(); ctx.beginPath(); inner.pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
      mapFace(ctx, img, inner.p0, inner.pu, inner.pv);
      ctx.restore();
      // riflesso sul vetro e montanti
      ctx.globalAlpha = 0.12; const gl = this.wallRect(d.wall, d.at + w * 0.1, d.at + w * 0.22, z0 + 6, z1 - 4); poly(ctx, gl.pts, '#ffffff'); ctx.globalAlpha = 1;
      const nM = d.big ? 2 : 1;
      for (let i = 1; i <= nM; i++) { const m = this.wallRect(d.wall, d.at + (w * i) / (nM + 1) - 0.04, d.at + (w * i) / (nM + 1) + 0.04, z0, z1); poly(ctx, m.pts, PAL.woodF); }
      const zm = z0 + (z1 - z0) * 0.62; const m2 = this.wallRect(d.wall, d.at, d.at + w, zm - 1, zm + 1); poly(ctx, m2.pts, PAL.woodF);
      const sill = this.wallRect(d.wall, d.at - 0.1, d.at + w + 0.1, z0 - 5, z0 - 2); poly(ctx, sill.pts, PAL.woodT);
      // persiane verdi (sulle finestre piccole) e gerani sul davanzale
      if (!d.big) for (const [a0, a1] of [[d.at - 0.42, d.at - 0.06], [d.at + w + 0.06, d.at + w + 0.42]]) { const sh = this.wallRect(d.wall, a0, a1, z0 - 1, z1 + 1); poly(ctx, sh.pts, '#3f6b4a'); for (let q = 0; q < 6; q++) { const ln = this.wallRect(d.wall, a0 + 0.04, a1 - 0.04, z0 + 4 + q * ((z1 - z0) / 6), z0 + 5 + q * ((z1 - z0) / 6)); poly(ctx, ln.pts, '#2f5238'); } }
      for (const f of d.big ? [0.3, w - 0.5] : [0.5]) {
        const [px, py] = d.wall === 'R' ? this.iso(d.at + f, 0.2, z0 - 2) : this.iso(0.2, d.at + f, z0 - 2);
        ctx.fillStyle = PAL.pot; ctx.fillRect(Math.round(px) - 3, Math.round(py) - 4, 7, 4);
        ctx.fillStyle = PAL.leaf; ctx.fillRect(Math.round(px) - 4, Math.round(py) - 7, 9, 3);
        ctx.fillStyle = '#e8414e'; for (const o of [-3, 0, 3]) ctx.fillRect(Math.round(px) + o, Math.round(py) - 8, 2, 2);
      }
    }
    if (d.type === 'banner') {
      const w = d.w || 2.6;
      const [img, x] = tela(textWidth(d.text) + 10, 13);
      x.fillStyle = '#f2e6c9'; x.fillRect(0, 0, img.width, 11);
      x.fillStyle = '#2e8b4a'; x.fillRect(0, 0, 3, 11); x.fillStyle = '#c93b3b'; x.fillRect(img.width - 3, 0, 3, 11);
      drawText(x, d.text, 5, 3, '#8a2b2b');
      x.fillStyle = '#d9c7a0'; for (let i = 0; i < img.width; i += 2) x.fillRect(i, 11, 1, 2);
      const r = this.wallRect(d.wall, d.at, d.at + w, H - 34, H - 20);
      mapFace(ctx, img, r.p0, r.pu, r.pv);
    }
    if (d.type === 'noticeboard') {
      const w = d.w || 2;
      const [img, x] = tela(36, 26);
      x.fillStyle = PAL.woodD; x.fillRect(0, 0, 36, 26); x.fillStyle = PAL.cork; x.fillRect(2, 2, 32, 22);
      for (let i = 0; i < 40; i++) { x.fillStyle = '#a57744'; x.fillRect(2 + Math.floor(rnd(i) * 32), 2 + Math.floor(rnd(i + 5) * 22), 1, 1); }
      const flyers = [[4, 4, 11, 13, '#fff4d6'], [17, 3, 8, 9, '#ffd6e0'], [26, 5, 7, 8, '#d6f0ff'], [17, 14, 9, 8, '#e3ffd6'], [27, 15, 6, 7, '#fff4d6']];
      for (const [fx, fy, fw, fh, fc] of flyers) { x.fillStyle = fc; x.fillRect(fx, fy, fw, fh); x.fillStyle = '#c0392b'; x.fillRect(fx + Math.floor(fw / 2), fy, 1, 1); x.fillStyle = '#00000033'; for (let l = fy + 3; l < fy + fh - 1; l += 2) x.fillRect(fx + 1, l, fw - 2 - (l % 3), 1); }
      drawText(x, d.title || 'SAGRA', 5, 6, '#a0302a');
      const r = this.wallRect(d.wall, d.at, d.at + w, 46, 80);
      mapFace(ctx, img, r.p0, r.pu, r.pv);
    }
    if (d.type === 'costboard') {
      // la lavagna delle spese: totale + subtotali per provider a pagamento; gli abbonamenti = "PIANO"
      const w = d.w || 2.8, TW = Math.round(w * 22), TH = 60;
      const [img, x] = tela(TW, TH);
      x.fillStyle = PAL.woodD; x.fillRect(0, 0, TW, TH);
      x.fillStyle = '#2f4a3a'; x.fillRect(2, 2, TW - 4, TH - 6);
      for (let i = 0; i < 30; i++) { x.fillStyle = '#3a5745'; x.fillRect(2 + Math.floor(rnd(i + 3) * (TW - 5)), 2 + Math.floor(rnd(i + 9) * (TH - 7)), 2, 1); }
      x.fillStyle = PAL.woodT; x.fillRect(1, TH - 4, TW - 2, 2);
      x.fillStyle = '#f2f2e8'; x.fillRect(5, TH - 5, 3, 1); x.fillStyle = '#e8a0a0'; x.fillRect(TW - 9, TH - 5, 3, 1);
      // scritte di gesso decorative: le cifre vere sono nel cartellino sopra (leggibile a ogni scala)
      drawText(x, 'SPESE', 4, 4, '#f3e27a');
      for (let i = 0; i < 4; i++) { x.fillStyle = '#d8e8dc99'; x.fillRect(4, 13 + i * 7, 8 + Math.floor(rnd(i + 1) * 10), 1); x.fillRect(TW - 16, 13 + i * 7, 10, 1); }
      const z0 = d.z ?? 34, r = this.wallRect(d.wall, d.at, d.at + w, z0, z0 + 60);
      mapFace(ctx, img, r.p0, r.pu, r.pv);
    }
    if (d.type === 'map') {
      const w = d.w || 1.3;
      const [img, x] = tela(24, 20);
      x.fillStyle = '#e9dcb8'; x.fillRect(0, 0, 24, 20); x.fillStyle = '#cdbb8c'; x.fillRect(0, 0, 24, 1); x.fillRect(0, 19, 24, 1);
      x.fillStyle = '#a58f63'; for (const [a, b, c2, e] of [[2, 10, 20, 1], [11, 2, 1, 16], [4, 4, 1, 12], [16, 6, 1, 10], [5, 15, 12, 1]]) x.fillRect(a, b, c2, e);
      x.fillStyle = '#7fa6c9'; x.fillRect(18, 13, 4, 3);
      for (const [a, b] of [[6, 6], [13, 8], [9, 13], [18, 4]]) { x.fillStyle = '#d63a3a'; x.fillRect(a, b, 2, 2); }
      const r = this.wallRect(d.wall, d.at, d.at + w, 56, 84);
      mapFace(ctx, img, r.p0, r.pu, r.pv);
    }
    if (d.type === 'clock') {
      const [img, x] = tela(14, 14);
      x.fillStyle = PAL.woodD; x.beginPath(); x.arc(7, 7, 7, 0, 7); x.fill();
      x.fillStyle = '#f6efdc'; x.beginPath(); x.arc(7, 7, 5.5, 0, 7); x.fill();
      const hh = (date.getHours() % 12 + date.getMinutes() / 60) / 12 * Math.PI * 2, mm = date.getMinutes() / 60 * Math.PI * 2;
      x.strokeStyle = '#222'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(7, 7); x.lineTo(7 + Math.sin(hh) * 3, 7 - Math.cos(hh) * 3); x.stroke();
      x.beginPath(); x.moveTo(7, 7); x.lineTo(7 + Math.sin(mm) * 4.6, 7 - Math.cos(mm) * 4.6); x.stroke();
      const r = this.wallRect(d.wall, d.at, d.at + 0.8, H - 42, H - 28);
      mapFace(ctx, img, r.p0, r.pu, r.pv);
    }
    if (d.type === 'lantern') {
      const [sx, sy] = d.wall === 'R' ? this.iso(d.at, 0.15, 84) : this.iso(0.15, d.at, 84);
      ctx.fillStyle = PAL.metal; ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 6, 2, 4); ctx.fillRect(Math.round(sx) - 3, Math.round(sy) - 2, 6, 1);
      ctx.fillStyle = '#2b2b33'; ctx.fillRect(Math.round(sx) - 3, Math.round(sy) - 1, 6, 8);
      ctx.fillStyle = '#ffd98a'; ctx.fillRect(Math.round(sx) - 2, Math.round(sy), 4, 6);
      ctx.fillStyle = '#fff3c8'; ctx.fillRect(Math.round(sx) - 1, Math.round(sy) + 2, 2, 2);
    }
  }

  // box in coordinate mondo con le tre facce visibili
  box(x, y, z, w, d, h, top, left, right) {
    const iso = this.iso, ctx = this.ctx;
    poly(ctx, [iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h)], left);
    poly(ctx, [iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h)], right);
    poly(ctx, [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)], top);
  }
  wood(x, y, z, w, d, h) { this.box(x, y, z, w, d, h, PAL.woodT, PAL.woodF, PAL.woodS); }

  // faccia "frontale" (verso la stanza) di un box in coordinate locali della postazione: per incollarci schermi, fogli…
  frontFace(st, a, b, al, bl, z0, z1) {
    const iso = this.iso;
    b += st.b0 || 0;
    if (st.wall === 'R') { const y = b + bl, x0 = st.at + a, x1 = x0 + al; return { p0: iso(x0, y, z1), pu: iso(x1, y, z1), pv: iso(x0, y, z0) }; }
    const x = b + bl, y0 = st.at + a, y1 = y0 + al; return { p0: iso(x, y1, z1), pu: iso(x, y0, z1), pv: iso(x, y1, z0) };
  }

  screenImage(kind, status, t, color) {
    const [img, x] = tela(22, 14);
    x.fillStyle = PAL.screenOff; x.fillRect(0, 0, 22, 14);
    const fr = Math.floor(t * 6);
    if (status === 'ERROR') { x.fillStyle = fr % 2 ? '#b3242f' : '#7c1820'; x.fillRect(0, 0, 22, 14); drawText(x, '!', 10, 4, '#fff'); return img; }
    if (status === 'DONE') { x.fillStyle = '#1f5a36'; x.fillRect(0, 0, 22, 14); x.fillStyle = '#9ff0b8'; x.fillRect(7, 7, 2, 2); x.fillRect(9, 9, 2, 2); x.fillRect(11, 7, 2, 2); x.fillRect(13, 5, 2, 2); return img; }
    if (status === 'BLOCKED') { x.fillStyle = '#5a4a12'; x.fillRect(0, 0, 22, 14); drawText(x, '?', 10, 4, '#ffd166'); return img; }
    if (kind === 'tv') {
      // il gioco! pavimento di sampietrini, tetti, il giocatore che si muove
      x.fillStyle = '#3b3548'; x.fillRect(0, 0, 22, 14);
      for (let i = 0; i < 22; i += 2) for (let j = 0; j < 14; j += 2) if ((i + j) % 4 === 0) { x.fillStyle = '#4a4458'; x.fillRect(i, j, 1, 1); }
      x.fillStyle = '#c4553b'; x.fillRect(1, 1, 7, 4); x.fillRect(14, 8, 7, 5);
      if (status === 'TESTING' || status === 'WORKING') {
        const px = 4 + Math.round(Math.sin(t * 2) * 6 + 6), py = 7 + Math.round(Math.cos(t * 3) * 2);
        x.fillStyle = '#ff4fa3'; x.fillRect(px, py, 2, 2);
        x.fillStyle = '#3fe0d0'; x.fillRect(18 - (fr % 8), 3, 1, 1);
        x.fillStyle = '#ffd166'; x.fillRect(1, 12, Math.min(20, fr % 22), 1);
      } else { x.fillStyle = '#00000088'; x.fillRect(0, 0, 22, 14); drawText(x, 'TQ', 7, 5, '#ff4fa3'); }
      return img;
    }
    if (kind === 'drafting' && status !== 'IDLE') {
      x.fillStyle = '#20324a'; x.fillRect(0, 0, 22, 14); x.fillStyle = '#2f4a6a'; for (let i = 0; i < 22; i += 3) x.fillRect(i, 0, 1, 14); for (let j = 0; j < 14; j += 3) x.fillRect(0, j, 22, 1);
      x.fillStyle = '#c4553b'; x.fillRect(3, 3, 5, 3); x.fillRect(12, 7, 6, 4); x.fillStyle = '#e9dcb8'; x.fillRect(8, 5, 4, 1); x.fillRect(10, 5, 1, 5);
      if (status === 'WORKING') { x.fillStyle = '#ffd166'; x.fillRect(2 + (fr % 18), 11, 2, 2); }
      return img;
    }
    if (kind === 'audio' && status !== 'IDLE') {
      x.fillStyle = '#1b1430'; x.fillRect(0, 0, 22, 14);
      for (let i = 0; i < 22; i++) { const h = 2 + Math.round(Math.abs(Math.sin(i * 0.7 + t * 6)) * (status === 'WORKING' ? 9 : 3)); x.fillStyle = i % 2 ? '#ff7ac4' : '#7ff9e4'; x.fillRect(i, 7 - Math.floor(h / 2), 1, h); }
      return img;
    }
    if (status === 'WORKING' || status === 'TESTING') {
      const cols = ['#7ff9e4', '#ff7ac4', '#ffe38a', '#9fb7ff', '#ffffff'];
      for (let l = 0; l < 6; l++) { const r = (l + fr) % 11; x.fillStyle = cols[(l + fr) % 5]; x.fillRect(1 + (r % 3) * 2, 1 + l * 2, 4 + ((r * 7) % 12), 1); }
      if (fr % 2) { x.fillStyle = '#fff'; x.fillRect(3 + ((fr * 3) % 14), 11, 2, 1); }
    } else if (status === 'THINKING') {
      x.fillStyle = '#e9e4d4'; x.fillRect(2, 1, 18, 12); x.fillStyle = '#9a927e'; for (let l = 3; l < 12; l += 2) x.fillRect(4, l, 10 + (l % 4), 1);
    } else if (status === 'WAITING') {
      x.fillStyle = '#26324a'; x.fillRect(0, 0, 22, 14); x.fillStyle = '#6fa8ff'; x.fillRect(3, 6, 16, 2); x.fillStyle = '#b8d4ff'; x.fillRect(3, 6, (fr % 16) + 1, 2);
    } else {
      // salvaschermo: il logo che rimbalza
      const bx = Math.abs(((fr) % 30) - 15), by = Math.abs(((fr * 0.7 | 0) % 18) - 9);
      x.fillStyle = color || '#ff4fa3'; x.fillRect(2 + Math.round(bx * 1.1), 1 + Math.round(by * 1.1), 3, 2);
    }
    return img;
  }

  // Postazione: la scrivania è staccata dal muro; il personaggio siede fra muro e scrivania, girato verso di noi.
  // Coordinate locali: a = lungo il muro (0…2.8), b = distanza dal muro. Scrivania da b=1.15 a b=2.35.
  drawStation(st, agent, t) {
    const L = this.local(st), status = agent?.runtime?.status || 'IDLE';
    const W = (a, b, al, bl, z, h) => { const [x, y, w, d] = L.box(a, b, al, bl); this.wood(x, y, z, w, d, h); };
    const B = (a, b, al, bl, z, h, c1, c2, c3) => { const [x, y, w, d] = L.box(a, b, al, bl); this.box(x, y, z, w, d, h, c1, c2, c3); };
    const D0 = 1.15, DL = 1.2, TOP = 27;
    // scrivania con pannello frontale (nasconde le gambe) e cassettiera
    W(0.1, D0, 2.8, DL, 0, 24);
    B(0.05, D0 - 0.05, 2.9, DL + 0.1, 24, 3, PAL.woodT, PAL.woodF, PAL.woodS);
    const [dx0, dy0] = this.iso(...L.xy(0.35, D0 + DL), 6), [dx1, dy1] = this.iso(...L.xy(2.55, D0 + DL), 6);
    this.ctx.fillStyle = PAL.woodD;
    for (const [a1] of [[0.9], [1.9]]) { const [hx, hy] = this.iso(...L.xy(a1, D0 + DL), 16); this.ctx.fillRect(Math.round(hx) - 2, Math.round(hy), 4, 1); }
    void dx0; void dy0; void dx1; void dy1;
    const glow = (a, col) => { const [gx, gy] = this.iso(...L.xy(a, D0 + 0.3), 44); this.ctx.fillStyle = col; this.ctx.fillRect(Math.round(gx) - 1, Math.round(gy), 2, 1); };
    const scr = status === 'ERROR' ? '#ff5d6c' : status === 'DONE' ? '#7bd88f' : status === 'BLOCKED' ? '#ffd166' : ['WORKING', 'TESTING'].includes(status) ? (Math.floor(t * 6) % 2 ? '#7ff9e4' : '#9fb7ff') : '#4a6fa0';
    const monitor = (a, al) => {
      B(a + al / 2 - 0.12, D0 + 0.35, 0.24, 0.2, TOP, 5, PAL.metalL, PAL.metal, PAL.metal);
      B(a, D0 + 0.2, al, 0.16, TOP + 5, 17, '#4a4c5a', '#34353f', '#2b2c36');   // retro dello schermo verso di noi
      glow(a + al / 2, scr);
    };
    if (['pc', 'drafting', 'audio', 'easel', 'puzzle', 'library'].includes(st.kind) && st.kind !== 'library') {
      if (st.kind === 'pc') { monitor(0.45, 0.95); monitor(1.5, 0.95); }
      else if (st.kind !== 'easel' && st.kind !== 'puzzle') monitor(1.0, 1.0);
    }
    if (st.kind === 'pc') {
      B(2.45, D0 + 0.6, 0.25, 0.25, TOP, 6, '#e8e1d4', '#cfc6b6', '#b9b0a0');   // tazza
      const [mx, my] = this.iso(...L.xy(2.57, D0 + 0.72), TOP + 7); if (Math.floor(t * 2) % 3 === 0) { this.ctx.fillStyle = '#ffffff55'; this.ctx.fillRect(Math.round(mx), Math.round(my) - (Math.floor(t * 4) % 3), 1, 2); }
      B(0.1, D0 + 0.55, 0.3, 0.45, TOP, 9, '#5a8fd6', '#3d6bb0', '#2f5690');
      B(0.1, D0 + 0.55, 0.3, 0.45, TOP + 9, 4, '#d65a5a', '#b04040', '#903434');
      B(0.2, D0 + 0.1, 0.5, 0.35, TOP, 0.8, PAL.paper, '#e3d9c1', '#d2c7ad');   // post-it e fogli
    }
    if (st.kind === 'tv') {
      // TV a tubo sul tavolo (la vediamo da dietro), console accesa, cartucce
      B(0.6, D0 + 0.15, 1.6, 0.9, TOP, 20, '#4a4a58', '#393946', '#2c2c36');
      B(0.85, D0 + 0.3, 1.1, 0.6, TOP + 20, 3, '#393946', '#2c2c36', '#22222b');
      glow(1.4, scr);
      B(2.35, D0 + 0.45, 0.45, 0.55, TOP, 4, '#f2f2f2', '#d7d7d7', '#bdbdbd');
      const [lx, ly] = this.iso(...L.xy(2.55, D0 + 1.0), TOP + 2); this.ctx.fillStyle = status === 'TESTING' ? '#ff4040' : '#5a2020'; this.ctx.fillRect(Math.round(lx), Math.round(ly), 1, 1);
      for (let i = 0; i < 3; i++) B(0.1 + i * 0.16, D0 + 0.7, 0.12, 0.35, TOP, 5, ['#d65a5a', '#5a8fd6', '#7bd88f'][i], '#555', '#444');
    }
    if (st.kind === 'typewriter') {
      B(0.85, D0 + 0.3, 1.1, 0.65, TOP, 6, '#2f4a3a', '#243a2d', '#1b2c22');
      const grow = status === 'WORKING' || status === 'THINKING' ? 3 + (Math.floor(t * 3) % 6) : 4;
      B(1.0, D0 + 0.35, 0.8, 0.08, TOP + 6, grow + 5, PAL.paper, '#e3d9c1', '#d2c7ad');
      B(2.05, D0 + 0.35, 0.65, 0.7, TOP, 5, PAL.paper, '#e3d9c1', '#d2c7ad');
      B(0.1, D0 + 0.3, 0.45, 0.6, TOP, 13, '#8e5ad6', '#6d40b0', '#5a3490');
      B(0.1, D0 + 0.3, 0.45, 0.6, TOP + 13, 6, '#e0a53d', '#c28a2a', '#a67320');
      B(2.4, D0 + 0.95, 0.16, 0.16, TOP, 7, '#f5f0e0', '#e3dccb', '#cfc7b4');
      const [cx, cy] = this.iso(...L.xy(2.48, D0 + 1.03), TOP + 9); this.ctx.fillStyle = Math.floor(t * 8) % 2 ? '#ffd166' : '#ff9f43'; this.ctx.fillRect(Math.round(cx), Math.round(cy) - 2, 1, 2);
    }
    if (st.kind === 'drafting') {
      B(1.95, D0 + 0.3, 0.9, 0.75, TOP, 1, '#e9dcb8', '#cdbb8c', '#b9a676');
      for (const [pa, pb, c] of [[2.1, 0.5, '#d63a3a'], [2.5, 0.8, '#2e86de'], [2.7, 0.45, '#d63a3a']]) { const [px, py] = this.iso(...L.xy(pa, D0 + pb), TOP + 2); this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(px), Math.round(py) - 2, 1, 2); }
      B(0.15, D0 + 0.8, 0.6, 0.12, TOP, 1, '#f2c14e', '#d9a441', '#b88227');
    }
    if (st.kind === 'audio') {
      B(0.1, D0 + 0.7, 0.9, 0.4, TOP, 3, '#f4f4f4', '#2a2a33', '#1c1d24');
      for (const ca of [0.05, 2.45]) B(ca, D0 + 0.15, 0.38, 0.38, TOP, 16, '#3a3b47', '#2b2c36', '#22222b');
      if (['WORKING', 'TESTING'].includes(status)) { const [nx, ny] = this.iso(...L.xy(1.5, D0), 70 + (Math.floor(t * 4) % 8)); drawText(this.ctx, '/', Math.round(nx) + (Math.floor(t * 2) % 2) * 6, Math.round(ny), '#ff7ac4'); }
    }
    if (st.kind === 'library') {
      for (const [la, h, c] of [[0.1, 22, '#8e5ad6'], [0.45, 16, '#d65a5a'], [2.45, 26, '#3d7a3a'], [2.1, 12, '#e0a53d']]) B(la, D0 + 0.2, 0.3, 0.55, TOP, h, c, shade(c, -0.18), shade(c, -0.3));
      B(0.95, D0 + 0.3, 1.0, 0.65, TOP, 3, '#f4ecd8', '#6b3b1a', '#5a3216');
      const [bx2, by2] = this.iso(...L.xy(1.45, D0 + 0.6), TOP + 4); this.ctx.fillStyle = '#6b3b1a'; this.ctx.fillRect(Math.round(bx2), Math.round(by2) - 1, 1, 3);
      this.ctx.fillStyle = '#9a927e'; for (let l = 0; l < 3; l++) { this.ctx.fillRect(Math.round(bx2) - 6, Math.round(by2) - 1 + l * 2, 4, 1); this.ctx.fillRect(Math.round(bx2) + 3, Math.round(by2) - 1 + l * 2, 4, 1); }
    }
    if (st.kind === 'puzzle') {
      const cols = ['#ff5d8f', '#ffd166', '#6fd3ff', '#7bd88f'];
      for (let i = 0; i < 10; i++) { const [px, py] = this.iso(...L.xy(0.3 + (i % 5) * 0.2, D0 + 0.4 + Math.floor(i / 5) * 0.3), TOP + 1); this.ctx.fillStyle = cols[i % 4]; this.ctx.fillRect(Math.round(px), Math.round(py) - 1, 3, 2); }
      B(1.8, D0 + 0.3, 0.7, 0.5, TOP, 9, '#8a5a31', '#6e4526', '#5a371c');
      const [lx2, ly2] = this.iso(...L.xy(2.15, D0 + 0.8), TOP + 5); this.ctx.fillStyle = '#e8c46a'; this.ctx.fillRect(Math.round(lx2) - 1, Math.round(ly2) - 2, 3, 3);
    }
    if (st.kind === 'manager') {
      // catalogo dei mobili, mazzetta dei colori, barattoli di vernice, una piantina da sistemare
      B(0.3, D0 + 0.35, 0.9, 0.6, TOP, 2, '#f2e6c9', '#c9b48a', '#b39c70');
      const [cx2, cy2] = this.iso(...L.xy(0.75, D0 + 0.65), TOP + 2); drawText(this.ctx, 'IKEO', Math.round(cx2) - 7, Math.round(cy2) - 3, '#2e5aa0');
      const sw = ['#e84a5f', '#ffd166', '#7bd88f', '#3fb0e0', '#9b8cff'];
      for (let i = 0; i < 5; i++) B(1.35 + i * 0.12, D0 + 0.5, 0.1, 0.35, TOP, 1 + i * 0.3, sw[i], shade(sw[i], -0.2), shade(sw[i], -0.3));
      for (const [ca, c] of [[2.1, '#e67e22'], [2.4, '#3fb0e0']]) { B(ca, D0 + 0.8, 0.25, 0.25, TOP, 6, '#c9ccd4', '#a4a8b3', '#8a8e99'); const [px, py] = this.iso(...L.xy(ca + 0.12, D0 + 0.92), TOP + 6); this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(px) - 2, Math.round(py) - 1, 4, 2); }
      monitor(1.3, 0.8);
    }
    if (st.kind === 'easel') {
      // cavalletto accanto alla scrivania, con la tela verso di noi
      const ea = 3.0;
      W(ea, 1.5, 0.08, 0.08, 0, 64); W(ea + 0.6, 1.5, 0.08, 0.08, 0, 64); W(ea + 0.3, 1.1, 0.08, 0.08, 0, 60);
      B(ea - 0.1, 1.45, 0.9, 0.06, 26, 36, PAL.paper, '#efe6cf', '#d8cdb3');
      const [img, x] = tela(16, 20);
      x.fillStyle = '#f6efdc'; x.fillRect(0, 0, 16, 20);
      const prog = status === 'WORKING' ? Math.floor(t * 2) % 16 : 15;
      x.fillStyle = '#2b3a6b'; x.fillRect(0, 0, 16, 9); x.fillStyle = '#f5f1d6'; x.fillRect(11, 2, 2, 2);
      x.fillStyle = '#c4553b'; x.fillRect(2, 9, 5, 4); x.fillRect(9, 8, 5, 5); x.fillStyle = '#ffcf6b'; x.fillRect(3, 10, 1, 1); x.fillRect(11, 10, 1, 1);
      x.fillStyle = '#7a6b5c'; x.fillRect(0, 13, 16, 7);
      if (prog < 15) { x.fillStyle = '#f6efdc'; x.fillRect(0, 20 - (15 - prog), 16, 15 - prog); }
      const f = this.frontFace(st, ea - 0.1, 1.45, 0.9, 0.06, 28, 60);
      mapFace(this.ctx, img, f.p0, f.pu, f.pv);
      B(0.3, D0 + 0.5, 0.7, 0.45, TOP, 1, '#d9b98a', '#c19e6f', '#a8865a');   // tavolozza
      const [px, py] = this.iso(...L.xy(0.65, D0 + 0.7), TOP + 1);
      for (const [o, c] of [[-3, '#e84a5f'], [-1, '#ffd166'], [1, '#3fb0e0'], [3, '#7bd88f']]) { this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(px) + o, Math.round(py), 2, 1); }
      B(1.5, D0 + 0.4, 0.2, 0.2, TOP, 8, '#8a5a31', '#6e4526', '#5a371c');   // vasetto dei pennelli
    }
    // lampada da scrivania
    B(2.55, D0 + 0.2, 0.22, 0.22, TOP, 2, PAL.metalL, PAL.metal, PAL.metal);
    B(2.62, D0 + 0.27, 0.08, 0.08, TOP + 2, 12, PAL.metalL, PAL.metal, PAL.metal);
    B(2.5, D0 + 0.15, 0.34, 0.34, TOP + 14, 4, '#e0b13c', '#c2931f', '#a57a15');
  }

  drawChair(st, agent) {
    const L = this.local(st);
    const col = shade(agent?.avatar?.color || '#555555', -0.4);
    const [x, y, w, d] = L.box(0.9, 0.3, 1.0, 0.18);
    this.box(x, y, 14, w, d, 30, shade(col, 0.15), col, shade(col, -0.2));
  }

  drawTable(st, agent, t) {
    const { x, y } = st;
    this.wood(x, y + 0.9, 0, 2.4, 0.9, 22);   // fronte chiuso: il tavolo della presidenza
    this.box(x - 0.05, y - 0.05, 22, 2.5, 1.9, 3, PAL.woodT, PAL.woodF, PAL.woodS);
    // drappo tricolore sul davanti
    const [p0x, p0y] = this.iso(x + 0.6, y + 1.8, 20), [p1x] = this.iso(x + 1.8, y + 1.8, 20);
    void p0x; void p1x; void p0y;
    this.box(x + 0.6, y + 1.8, 8, 0.4, 0.02, 14, '#2e8b4a', '#2e8b4a', '#2e8b4a');
    this.box(x + 1.0, y + 1.8, 8, 0.4, 0.02, 14, '#f2efe6', '#f2efe6', '#f2efe6');
    this.box(x + 1.4, y + 1.8, 8, 0.4, 0.02, 14, '#c93b3b', '#c93b3b', '#c93b3b');
    // il verbale, il campanello del presidente, bicchieri
    this.box(x + 0.5, y + 0.9, 25, 0.8, 0.6, 1, PAL.paper, '#e3d9c1', '#d2c7ad');
    this.box(x + 0.55, y + 0.95, 26, 0.7, 0.5, 1, '#fffaf0', '#e3d9c1', '#d2c7ad');
    const [bx, by] = this.iso(x + 1.9, y + 0.9, 25);
    const ring = agent && ['THINKING', 'BLOCKED'].includes(agent.runtime?.status) && Math.floor(t * 4) % 2;
    this.ctx.fillStyle = '#c9a227'; this.ctx.fillRect(Math.round(bx) - 3 + (ring ? 1 : 0), Math.round(by) - 4, 6, 4); this.ctx.fillRect(Math.round(bx) - 1, Math.round(by) - 6, 2, 2);
    this.ctx.fillStyle = '#fff1a8'; this.ctx.fillRect(Math.round(bx) - 2, Math.round(by) - 4, 1, 2);
    for (const [gx, gy] of [[x + 1.5, y + 1.4], [x + 0.3, y + 1.45]]) { const [sx, sy] = this.iso(gx, gy, 25); this.ctx.fillStyle = '#d7ecf2aa'; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 4, 3, 4); this.ctx.fillStyle = '#e7b53d'; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 2, 3, 2); }
  }

  drawDecor(d, t) {
    if (d.type === 'tallplant') {
      // grande pianta d'angolo (come nella reference): vaso alto e chioma a nuvole
      const s2 = d.size || 1, { x, y } = d;
      this.box(x - 0.35 * s2, y - 0.35 * s2, 0, 0.7 * s2, 0.7 * s2, 16 * s2, '#8a4a30', PAL.pot, PAL.potD);
      const [sx, sy] = this.iso(x, y, 16 * s2);
      this.ctx.fillStyle = PAL.woodD; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 18 * s2, 2, 18 * s2);
      const sway = Math.sin(t * 0.9 + x) * 0.8;
      for (let i = 0; i < 26; i++) {
        const ang = rnd(i + x * 7) * Math.PI * 2, rad = rnd(i * 3 + y) * 14 * s2;
        const bx = sx + Math.cos(ang) * rad * 1.1 + sway, by = sy - 34 * s2 + Math.sin(ang) * rad * 1.2;
        const r = (4 + rnd(i * 5) * 2.5) * s2;
        this.ctx.fillStyle = PAL.leafD; this.ctx.beginPath(); this.ctx.arc(bx, by + 1, r, 0, 7); this.ctx.fill();
      }
      for (let i = 0; i < 26; i++) {
        const ang = rnd(i + x * 7) * Math.PI * 2, rad = rnd(i * 3 + y) * 14 * s2;
        const bx = sx + Math.cos(ang) * rad * 1.1 + sway, by = sy - 34 * s2 + Math.sin(ang) * rad * 1.2;
        const r = (4 + rnd(i * 5) * 2.5) * s2 - 1;
        this.ctx.fillStyle = i % 3 ? PAL.leaf : PAL.leafL; this.ctx.beginPath(); this.ctx.arc(bx - 0.5, by - 0.5, r, 0, 7); this.ctx.fill();
      }
      return;
    }
    if (d.type === 'floorlamp') {
      const { x, y } = d;
      this.box(x - 0.2, y - 0.2, 0, 0.4, 0.4, 2, PAL.metalL, PAL.metal, PAL.metal);
      this.box(x - 0.04, y - 0.04, 2, 0.08, 0.08, 56, PAL.metalL, PAL.metal, PAL.metal);
      this.box(x - 0.3, y - 0.3, 56, 0.6, 0.6, 10, '#f2d9a0', '#e0bd72', '#c9a24a');
      return;
    }
    if (d.type === 'plant') {
      const s = d.size || 1, { x, y } = d;
      this.box(x - 0.25 * s, y - 0.25 * s, 0, 0.5 * s, 0.5 * s, 12 * s, '#7a3a24', PAL.pot, PAL.potD);
      const [sx, sy] = this.iso(x, y, 12 * s);
      const sway = Math.round(Math.sin(t * 1.3 + x) * 0.6);
      const ctx = this.ctx;
      const blobs = [[0, -10, 7], [-6, -6, 5], [6, -6, 5], [-3, -16, 5], [4, -15, 5], [0, -21, 4], [-7, -13, 4], [7, -12, 4]];
      for (const [bx, by, r] of blobs) {
        const R = r * s;
        ctx.fillStyle = PAL.leafD; ctx.beginPath(); ctx.arc(sx + bx * s + sway, sy + by * s + 1, R, 0, 7); ctx.fill();
        ctx.fillStyle = PAL.leaf; ctx.beginPath(); ctx.arc(sx + bx * s + sway, sy + by * s, R - 1, 0, 7); ctx.fill();
        ctx.fillStyle = PAL.leafL; ctx.fillRect(Math.round(sx + (bx - 2) * s + sway), Math.round(sy + (by - 2) * s), 2, 1);
      }
    }
    if (d.type === 'crates') {
      // cassette della birra (la valuta del paese)
      const { x, y } = d;
      const crate = (cx, cy, z) => {
        this.box(cx, cy, z, 1.1, 0.8, 12, '#d9a441', '#b88227', '#9a6b1c');
        const [bx, by] = this.iso(cx + 0.1, cy + 0.1, z + 12);
        for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { const [sx, sy] = this.iso(cx + 0.18 + i * 0.25, cy + 0.15 + j * 0.23, z + 12); this.ctx.fillStyle = (i + j) % 3 ? '#6b3b1a' : '#2f6b33'; this.ctx.fillRect(Math.round(sx), Math.round(sy) - 5, 2, 5); this.ctx.fillStyle = '#e8c46a'; this.ctx.fillRect(Math.round(sx), Math.round(sy) - 6, 2, 1); }
        void bx; void by;
      };
      crate(x, y, 0); crate(x + 0.2, y + 0.9, 0); crate(x + 0.1, y + 0.1, 12);
    }
    if (d.type === 'sideboard') {
      const { x, y } = d;
      this.wood(x, y, 0, 0.9, 2.2, 26);
      this.box(x - 0.02, y + 0.1, 26, 0.94, 2.0, 1, '#b07a48', '#96633a', '#7a4f2d');
      // moka e bicchieri
      this.box(x + 0.3, y + 0.4, 27, 0.3, 0.3, 8, '#c9ccd4', '#a4a8b3', '#8a8e99');
      this.box(x + 0.32, y + 0.42, 35, 0.26, 0.26, 3, '#2a2a30', '#1c1c20', '#1c1c20');
      if (Math.floor(t * 2) % 3 === 0) { const [sx, sy] = this.iso(x + 0.45, y + 0.55, 40); this.ctx.fillStyle = '#ffffff66'; this.ctx.fillRect(Math.round(sx), Math.round(sy) - (Math.floor(t * 4) % 4), 1, 2); }
      for (let i = 0; i < 3; i++) { const [sx, sy] = this.iso(x + 0.4, y + 1.2 + i * 0.3, 27); this.ctx.fillStyle = '#6b3b1a'; this.ctx.fillRect(Math.round(sx), Math.round(sy) - 9, 2, 9); this.ctx.fillStyle = '#e8c46a'; this.ctx.fillRect(Math.round(sx), Math.round(sy) - 5, 2, 2); }
    }
    if (d.type === 'coffee') {
      // angolo caffè: bancone con la macchinetta espresso, tazzine e il vapore
      const { x, y } = d;
      this.wood(x, y, 0, 1.6, 0.8, 26);
      this.box(x - 0.03, y - 0.03, 26, 1.66, 0.86, 2, '#d8c8a8', '#bfae8c', '#a89676');
      this.box(x + 0.15, y + 0.12, 28, 0.8, 0.55, 17, '#c9352c', '#a52a22', '#86221c');   // la macchinetta
      this.box(x + 0.15, y + 0.12, 45, 0.8, 0.55, 2, '#d9dde4', '#b6bbc5', '#9aa0ac');
      this.box(x + 0.35, y + 0.6, 33, 0.12, 0.1, 5, '#2a2a30', '#1c1c20', '#1c1c20');     // beccuccio
      for (let i = 0; i < 3; i++) this.box(x + 1.05 + (i % 2) * 0.22, y + 0.2 + i * 0.18, 28, 0.14, 0.14, 3, '#fbf6ea', '#e6dfcf', '#d4ccba');
      const [sx, sy] = this.iso(x + 0.5, y + 0.4, 47);
      for (let i = 0; i < 4; i++) { const k = (t * 0.8 + i / 4) % 1; this.ctx.fillStyle = `rgba(255,255,255,${0.45 * (1 - k)})`; this.ctx.fillRect(Math.round(sx + Math.sin(k * 6 + i) * 2), Math.round(sy - k * 14), 2, 2); }
      return;
    }
    if (d.type === 'watercooler') {
      const { x, y } = d;
      this.box(x, y, 0, 0.55, 0.55, 24, '#e9ecef', '#cfd4da', '#b8bec6');
      this.box(x + 0.08, y + 0.08, 24, 0.4, 0.4, 13, '#9fd8f2', '#7ec3e3', '#66aecf');
      this.box(x + 0.2, y + 0.55, 12, 0.14, 0.05, 3, '#3a7bd5', '#2d62ab', '#2d62ab');
      return;
    }
    if (d.type === 'sofa' || d.type === 'armchair') {
      // divano / poltrona. rot = verso dove sta lo SCHIENALE: 0 parete destra (guarda verso chi osserva a sinistra),
      // 1 parete sinistra (guarda a destra), 2 davanti (guarda la parete destra), 3 davanti a destra (guarda la parete sinistra)
      const { x, y } = d, L = d.type === 'sofa' ? (d.w || 2.4) : 1.05, c = d.color || (d.type === 'sofa' ? '#3f6f78' : '#8a4a3a');
      const top = shade(c, 0.15), fr = c, sd = shade(c, -0.2), cu = shade(c, 0.25);
      const rot = d.rot || 0, H = rot % 2 === 0, W = H ? L : 0.95, D = H ? 0.95 : L;
      const back = [[x, y, L, 0.3], [x, y, 0.3, L], [x, y + 0.65, L, 0.3], [x + 0.65, y, 0.3, L]][rot];
      const seat = [[x, y + 0.3, L, 0.65], [x + 0.3, y, 0.65, L], [x, y, L, 0.65], [x, y, 0.65, L]][rot];
      const drawBack = () => this.box(back[0], back[1], 8, back[2], back[3], 14, top, fr, sd);
      if (rot < 2) drawBack();
      this.box(x, y, 0, W, D, 8, top, fr, sd);
      const n = Math.max(1, Math.round(L / 0.8)), step = (L - 0.5) / n;
      for (let i = 0; i < n; i++) {
        if (H) this.box(seat[0] + 0.25 + i * step, seat[1] + 0.02, 8, step - 0.05, seat[3] - 0.04, 2, cu, fr, sd);
        else this.box(seat[0] + 0.02, seat[1] + 0.25 + i * step, 8, seat[2] - 0.04, step - 0.05, 2, cu, fr, sd);
      }
      if (H) { this.box(x, seat[1], 8, 0.22, seat[3], 6, top, fr, sd); this.box(x + L - 0.22, seat[1], 8, 0.22, seat[3], 6, top, fr, sd); }
      else { this.box(seat[0], y, 8, seat[2], 0.22, 6, top, fr, sd); this.box(seat[0], y + L - 0.22, 8, seat[2], 0.22, 6, top, fr, sd); }
      if (rot >= 2) drawBack();
      if (d.type === 'sofa') { const [sx, sy] = this.iso(H ? x + L * 0.72 : seat[0] + 0.3, H ? seat[1] + 0.3 : y + L * 0.72, 12); this.ctx.fillStyle = '#e8c46a'; this.ctx.fillRect(Math.round(sx) - 3, Math.round(sy) - 4, 6, 5); this.ctx.fillStyle = '#c99a3a'; this.ctx.fillRect(Math.round(sx) - 3, Math.round(sy), 6, 1); }
      return;
    }
    if (d.type === 'chesstable') {
      // tavolino con la scacchiera e due sgabelli
      const { x, y } = d;
      this.wood(x - 0.55, y + 0.25, 0, 0.4, 0.4, 11); this.wood(x + 1.05, y + 0.25, 0, 0.4, 0.4, 11);
      this.wood(x + 0.35, y + 0.35, 0, 0.2, 0.2, 14);
      this.box(x, y, 14, 0.9, 0.9, 2, PAL.woodT, PAL.woodF, PAL.woodS);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) poly(this.ctx, [this.iso(x + 0.1 + i * 0.175, y + 0.1 + j * 0.175, 16), this.iso(x + 0.275 + i * 0.175, y + 0.1 + j * 0.175, 16), this.iso(x + 0.275 + i * 0.175, y + 0.275 + j * 0.175, 16), this.iso(x + 0.1 + i * 0.175, y + 0.275 + j * 0.175, 16)], (i + j) % 2 ? '#3b2a20' : '#efe3c8');
      for (const [px, py, col] of [[0.2, 0.2, '#fbf6ea'], [0.55, 0.2, '#fbf6ea'], [0.35, 0.7, '#22222a'], [0.7, 0.6, '#22222a']]) { const [sx, sy] = this.iso(x + px, y + py, 16); this.ctx.fillStyle = col; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 4, 2, 4); }
      return;
    }
    if (d.type === 'coffeetable') {
      const { x, y } = d;
      this.wood(x + 0.1, y + 0.1, 0, 0.12, 0.12, 8); this.wood(x + 1.08, y + 0.58, 0, 0.12, 0.12, 8);
      this.box(x, y, 8, 1.3, 0.8, 2, PAL.woodT, PAL.woodF, PAL.woodS);
      this.box(x + 0.2, y + 0.2, 10, 0.5, 0.35, 1, '#f4ecd8', '#d9cfb8', '#c9bfa6');       // giornale
      this.box(x + 0.9, y + 0.3, 10, 0.15, 0.15, 3, '#fbf6ea', '#e6dfcf', '#d4ccba');      // tazzina
      return;
    }
    if (d.type === 'arcade') {
      // cabinato: lo schermo lampeggia con un giochino
      const { x, y } = d, c = d.color || '#5b3a8c';
      this.box(x, y, 0, 0.85, 0.8, 46, shade(c, 0.2), c, shade(c, -0.25));
      const iso = this.iso, fy = y + 0.8;
      poly(this.ctx, [iso(x + 0.1, fy, 42), iso(x + 0.75, fy, 42), iso(x + 0.75, fy, 26), iso(x + 0.1, fy, 26)], '#0e1024');
      const fr = Math.floor(t * 4);
      for (let i = 0; i < 5; i++) { const [px, py] = iso(x + 0.16 + ((i * 13 + fr * 3) % 50) / 100, fy, 29 + ((i * 7 + fr) % 11)); this.ctx.fillStyle = ['#ff5d8f', '#ffd166', '#7bd88f', '#6fd3ff', '#ffffff'][i]; this.ctx.fillRect(Math.round(px), Math.round(py), 2, 1); }
      poly(this.ctx, [iso(x + 0.05, fy, 25), iso(x + 0.8, fy, 25), iso(x + 0.8, fy, 21), iso(x + 0.05, fy, 21)], shade(c, 0.35));
      const [bx, by] = iso(x + 0.35, fy, 23); this.ctx.fillStyle = '#e8414e'; this.ctx.fillRect(Math.round(bx), Math.round(by) - 1, 2, 2); this.ctx.fillStyle = '#3fe0d0'; this.ctx.fillRect(Math.round(bx) + 4, Math.round(by) + 1, 2, 2);
      poly(this.ctx, [iso(x + 0.05, fy, 50), iso(x + 0.8, fy, 50), iso(x + 0.8, fy, 44), iso(x + 0.05, fy, 44)], '#ffcf6b');
      return;
    }
    if (d.type === 'bench') {
      const { x, y } = d;
      this.wood(x, y, 0, 0.15, 0.4, 10); this.wood(x + 1.6, y, 0, 0.15, 0.4, 10);
      this.box(x - 0.05, y - 0.05, 10, 1.85, 0.5, 3, PAL.woodT, PAL.woodF, PAL.woodS);
      // una fisarmonica per le serate della Pro Loco
      this.box(x + 0.5, y + 0.05, 13, 0.6, 0.35, 7, '#c0392b', '#962d22', '#7d251c');
      this.box(x + 0.62, y + 0.05, 13, 0.36, 0.36, 7, '#f2e6c9', '#d9cba8', '#c4b590');
    }
  }

  // ── i personaggi ────────────────────────────────────────────────────────────────────────────
  drawCharacter(st, agent, t) {
    if (!agent) return;
    const ctx = this.ctx;
    const [cx, cy] = this.seatOf(st);
    const [sx, sy] = this.iso(cx, cy, 0);
    const status = agent.runtime?.status || 'IDLE';
    const anim = (agent.animations || {})[status] || 'idle';
    const fx = this.fx[agent.id] && this.fx[agent.id].until > performance.now() ? this.fx[agent.id].kind : null;
    const celebrate = anim === 'celebrate' && (fx === 'done' || Math.floor(t) % 6 === 0);
    const jump = celebrate ? Math.round(Math.abs(Math.sin(t * 9)) * 5) : 0;
    const shakeX = anim === 'error' && fx === 'fail' ? (Math.floor(t * 20) % 2 ? 1 : -1) : 0;
    const X = Math.round(sx) + shakeX, baseY = Math.round(sy) - 14 - jump;

    // spritesheet personale al posto del personaggio disegnato
    if (agent.avatar?.type === 'spritesheet' && agent.avatar.sprite?.url) {
      const s = agent.avatar.sprite;
      let img = this.sprites[s.url];
      if (!img) { img = new Image(); img.src = s.url; this.sprites[s.url] = img; }
      if (img.complete && img.naturalWidth) {
        const def = (s.animations || {})[anim] || (s.animations || {}).idle || { row: 0, frames: 1, fps: 1 };
        const f = Math.floor(t * (def.fps || 6)) % (def.frames || 1);
        const sc = s.officeScale || 1;
        ctx.drawImage(img, f * s.frameWidth, (def.row || 0) * s.frameHeight, s.frameWidth, s.frameHeight, X - s.frameWidth * sc / 2, baseY - s.frameHeight * sc, s.frameWidth * sc, s.frameHeight * sc);
      }
      return;
    }
    // personaggio animato generato con l'AI: fotogrammi per ogni stato
    if (agent.avatar?.type === 'frames' && agent.avatar.frames) {
      const set = processedFrames(agent.avatar.frames, { chroma: agent.avatar.chroma || '#ff00ff', maxW: 46, maxH: 56 });
      if (set) {
        const want = celebrate ? 'celebrate' : anim === 'celebrate' ? 'idle' : anim;
        const list = set[want]?.length ? set[want] : set.idle || Object.values(set).find(Array.isArray);
        const fps = agent.avatar.fps?.[want] ?? 2;
        const tt = t + agent.id.length * 0.7;
        let fr = Math.floor(tt * fps) % list.length;
        if (want === 'idle' && list.length > 1) fr = (tt % 4.5) < 0.18 ? 1 : 0;   // sbatte le palpebre ogni tanto
        const img = list[fr];
        const anchorH = set.__anchor.h || img.height;
        this.blit(img, X, baseY - anchorH + 4 - (img.height - anchorH), this.flipFor(st, agent));
        return;
      }
    }
    // avatar generato con l'AI: l'immagine (ripulita e ridotta a pixel art) si muove secondo lo stato
    if (agent.avatar?.type === 'image' && agent.avatar.image) {
      const img = processedAvatar(agent.avatar.image, { chroma: agent.avatar.chroma || '#ff00ff', maxW: 44, maxH: 54 });
      if (img) {
        const tt = t + agent.id.length;
        const dy = anim === 'typing' ? Math.floor(tt * 6) % 2 : anim === 'waiting' || anim === 'idle' ? Math.round(Math.sin(tt * 1.5)) : anim === 'writing-notes' ? Math.floor(tt * 1.5) % 2 : 0;
        const dx = anim === 'playing' ? (Math.floor(tt * 8) % 2 ? 1 : -1) : anim === 'error' ? (Math.floor(tt * 12) % 2 ? 1 : -1) : 0;
        this.blit(img, X + dx, baseY - img.height + 4 + dy, this.flipFor(st, agent));
        if (anim === 'playing') { ctx.fillStyle = '#2a2a33'; ctx.fillRect(X - 7, baseY - 16 + dy, 14, 5); ctx.fillStyle = '#ff4fa3'; ctx.fillRect(X - 5, baseY - 15, 1, 1); ctx.fillStyle = '#3fe0d0'; ctx.fillRect(X + 4, baseY - 15, 1, 1); }
        return;
      }
    }
    const fps = { typing: 6, playing: 8, 'writing-notes': 1.5, waiting: 1, question: 2, celebrate: 4, error: 5, idle: 0.35 }[anim] || 1;
    const frame = Math.floor(t * fps + (agent.id.length * 0.37)) % 2;
    const blink = (t + agent.id.length * 1.3) % 4.2 < 0.15;
    const pose = celebrate ? 'celebrate' : anim === 'celebrate' ? 'idle' : anim;
    const spr = cachedSprite(agent.avatar?.character || {}, pose, frame, blink);
    ctx.drawImage(spr, X - Math.floor(SPRITE_W / 2), baseY - SPRITE_H);
  }

  // da che parte guarda il personaggio: le immagini generate guardano verso SINISTRA (scrivania che scende a destra,
  // come alla parete destra); alla parete sinistra (e dove serve) si specchiano. avatar.faces dice verso dove guarda
  // l'immagine ('left' predefinito), avatar.flip = true inverte la scelta per un personaggio disegnato al contrario.
  flipFor(st, agent) {
    const need = st.face || (st.wall === 'L' ? 'right' : 'left');
    const flip = need !== (agent.avatar?.faces || 'left');
    return agent.avatar?.flip === true ? !flip : flip;
  }
  blit(img, cx, y, flip) {
    if (!flip) return this.ctx.drawImage(img, cx - Math.floor(img.width / 2), y);
    const ctx = this.ctx;
    ctx.save(); ctx.translate(cx, 0); ctx.scale(-1, 1);
    ctx.drawImage(img, -Math.floor(img.width / 2) - (img.width % 2), y);
    ctx.restore();
  }

  drawBubble(st, agent, t) {
    if (!agent) return;
    const status = agent.runtime?.status || 'IDLE';
    const anim = (agent.animations || {})[status] || 'idle';
    const icon = { 'writing-notes': 'dots', waiting: 'hourglass', question: '?', error: '!', celebrate: 'check' }[anim] || (st.kind === 'table' && status === 'THINKING' ? 'dots' : null);
    if (!icon) return;
    const ctx = this.ctx;
    const [cx, cy] = this.seatOf(st);
    const [sx, sy] = this.iso(cx, cy, 64);
    const bob = Math.round(Math.sin(t * 3) * 1.2);
    const x = Math.round(sx) + 12, y = Math.round(sy) - 8 + bob;
    const bg = icon === '?' ? '#ffd166' : icon === '!' ? '#ff5d6c' : icon === 'check' ? '#7bd88f' : '#ffffff';
    ctx.fillStyle = '#1b1426'; ctx.fillRect(x - 1, y - 1, 13, 11); ctx.fillRect(x + 2, y + 10, 3, 2);
    ctx.fillStyle = bg; ctx.fillRect(x, y, 11, 9); ctx.fillRect(x + 3, y + 9, 1, 2);
    ctx.fillStyle = '#1b1426';
    if (icon === 'dots') { const n = Math.floor(t * 3) % 4; for (let i = 0; i < n; i++) ctx.fillRect(x + 2 + i * 3, y + 5, 2, 2); }
    else if (icon === 'hourglass') { ctx.fillRect(x + 3, y + 1, 5, 1); ctx.fillRect(x + 3, y + 7, 5, 1); ctx.fillRect(x + 4, y + 2, 3, 1); ctx.fillRect(x + 5, y + 3, 1, 3); ctx.fillRect(x + 4, y + 6, 3, 1); ctx.fillStyle = '#e0a53d'; ctx.fillRect(x + 5, y + 5 - (Math.floor(t) % 2), 1, 1); }
    else if (icon === 'check') { ctx.fillRect(x + 2, y + 4, 2, 2); ctx.fillRect(x + 4, y + 5, 2, 2); ctx.fillRect(x + 6, y + 3, 2, 2); ctx.fillRect(x + 8, y + 1, 1, 2); }
    else drawText(ctx, icon, x + 4, y + 2, '#1b1426');
  }

  // ── luce: buio della sera + pozze di luce calda (lampade, lanterne) e fredda (schermi, finestre) ──
  drawLight(sky, t) {
    const d = this.darkX, iso = this.iso;
    d.globalCompositeOperation = 'source-over';
    d.clearRect(0, 0, LW, LH);
    d.fillStyle = `rgba(10,14,40,${this.painted ? sky.dark * 0.6 : sky.dark})`; d.fillRect(0, 0, LW, LH);
    d.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => { const g = d.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)'); d.fillStyle = g; d.fillRect(x - r, y - r, r * 2, r * 2); };
    const glows = [];
    for (const st of this.stations()) {
      if (st.kind === 'table') { const [x, y] = iso(st.x + 1.2, st.y + 0.9, 30); hole(x, y, 46, 0.8); glows.push([x, y, 40, '255,196,110', 0.1]); continue; }
      const L = this.local(st);
      const [lx, ly] = iso(...L.xy(2.67, 1.45), 42); hole(lx, ly + 8, 46, 0.95); glows.push([lx, ly + 8, 42, '255,200,120', 0.15]);
      const status = this.agents[st.agentId]?.runtime?.status;
      const [mx, my] = iso(...L.xy(1.4, 0.9), 34);
      const col = status === 'ERROR' ? '255,80,90' : status === 'DONE' ? '120,240,160' : status === 'BLOCKED' ? '255,210,100' : '110,210,255';
      const flick = status === 'WORKING' || status === 'TESTING' ? 0.12 + (Math.floor(t * 8) % 2) * 0.04 : 0.07;
      hole(mx, my, 30, 0.6); glows.push([mx, my, 28, col, flick]);
    }
    for (const dec of this.layout.decor) {
      if (dec.type === 'floorlamp') { const [x, y] = iso(dec.x, dec.y, 58); hole(x, y + 10, 60, 1); glows.push([x, y + 10, 56, '255,196,120', 0.18]); }
      if (dec.type === 'lantern') { const [x, y] = dec.wall === 'R' ? iso(dec.at, 0.3, 80) : iso(0.3, dec.at, 80); hole(x, y, 50, 0.9); glows.push([x, y, 46, '255,190,100', 0.16 + Math.sin(t * 5 + dec.at) * 0.015]); }
      if (dec.type === 'window') {
        const w = dec.w || 1.6; const [x, y] = dec.wall === 'R' ? iso(dec.at + w / 2, 0.5, 70) : iso(0.5, dec.at + w / 2, 70);
        hole(x, y, 36, sky.night ? 0.4 : 1); if (!sky.night) glows.push([x, y + 30, 50, '255,245,210', 0.1]);
      }
    }
    const ctx = this.ctx;
    ctx.drawImage(this.darkC, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, c, a] of glows) { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── LUCE DEL GIORNO (effetto, non oggetti): fasci volumetrici dalla vetrata, pulviscolo che brilla nei fasci,
  // ombre di foglie che ondeggiano sul pavimento, una gradazione calda e una vignettatura morbida. Solo di giorno e al
  // tramonto (più caldo e radente); di notte resta la luce delle lampade.
  drawDaylight(sky, t, date) {
    const gw = (this.layout.decor || []).find((d) => d.type === 'glasswall');
    if (!gw || sky.night > 0.7) return;
    const ctx = this.ctx, iso = this.iso, H = this.layout.room.wallH;
    const dusk = sky.night > 0;
    const h = date.getHours() + date.getMinutes() / 60;
    const wall = gw.wall || 'L';
    const a0 = gw.from ?? 0.3, a1 = gw.to ?? ((wall === 'L' ? this.layout.room.d : this.layout.room.w) - 0.3);
    const n = Math.max(1, Math.round((a1 - a0) / (gw.pane || 2.4)));
    const z0 = 30, z1 = H - 10;
    // il sole: di mattina i fasci scendono verso il fondo, nel pomeriggio verso chi guarda; al tramonto sono lunghi e radenti
    const lean = (h < 13 ? 1 : -1) * (dusk ? 3.2 : 1.6 + Math.abs(h - 13) * 0.25);
    const depth = dusk ? 10.5 : 6.5;
    const warm = dusk ? '255,150,70' : '255,226,160';
    const P = (x, y, z) => (wall === 'L' ? iso(x, y, z) : iso(y, x, z));
    const breath = 0.85 + Math.sin(t * 0.35) * 0.1 + Math.sin(t * 0.13 + 1) * 0.05;
    // tutti gli effetti restano dentro la stanza (pareti + pavimento), mai sullo sfondo scuro
    const { w: RW, d: RD } = this.layout.room;
    ctx.save();
    ctx.beginPath(); [iso(0, RD, 0), iso(RW, RD, 0), iso(RW, 0, 0), iso(RW, 0, H), iso(0, 0, H), iso(0, RD, H)].forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
    // 1) fasci di luce: dal bordo alto di ogni vetro al riquadro sul pavimento
    const beams = [];
    for (let i = 0; i < n; i++) {
      const b0 = a0 + ((a1 - a0) * i) / n + 0.12, b1 = a0 + ((a1 - a0) * (i + 1)) / n - 0.12;
      const q = { top0: P(0, b0, z1 - 4), top1: P(0, b1, z1 - 4), bot0: P(0, b0, z0), bot1: P(0, b1, z0), far0: P(depth, b0 + lean, 0), far1: P(depth, b1 + lean, 0), near0: P(0.15, b0 + lean * 0.02, 0), near1: P(0.15, b1 + lean * 0.02, 0) };
      beams.push(q);
      const flick = breath * (0.9 + 0.1 * Math.sin(t * 0.6 + i * 1.7));
      const g = ctx.createLinearGradient(q.top0[0], q.top0[1], q.far0[0], q.far0[1]);
      g.addColorStop(0, `rgba(${warm},${(dusk ? 0.34 : 0.3) * flick})`); g.addColorStop(0.5, `rgba(${warm},${(dusk ? 0.16 : 0.13) * flick})`); g.addColorStop(1, `rgba(${warm},0)`);
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      poly(ctx, [q.top0, q.top1, q.far1, q.far0], g);
      // riquadro di luce più netto sul pavimento
      const f = ctx.createLinearGradient(q.near0[0], q.near0[1], q.far0[0], q.far0[1]);
      f.addColorStop(0, `rgba(${warm},${(dusk ? 0.34 : 0.3) * flick})`); f.addColorStop(1, `rgba(${warm},0.03)`);
      poly(ctx, [q.near0, q.near1, q.far1, q.far0], f);
      ctx.restore();
    }
    // 2) ombre di foglie (un albero fuori dalla vetrata) che ondeggiano dentro i riquadri di luce
    ctx.save(); ctx.globalCompositeOperation = 'multiply';
    for (let k = 0; k < 46; k++) {
      const bi = k % n, q = beams[bi];
      const u = rnd(k * 3.1 + 7), v = rnd(k * 5.3 + 1);
      if (rnd(k * 9.7) > (bi % 3 === 1 ? 0.95 : 0.45)) continue;   // non su tutti i vetri: l'albero copre solo una parte
      const sway = Math.sin(t * 0.9 + k * 0.7) * 0.06 + Math.sin(t * 2.3 + k) * 0.02;
      const lerp = (p0, p1, x) => [p0[0] + (p1[0] - p0[0]) * x, p0[1] + (p1[1] - p0[1]) * x];
      const a = lerp(q.near0, q.near1, Math.min(1, Math.max(0, u + sway))), b = lerp(q.far0, q.far1, Math.min(1, Math.max(0, u + sway)));
      const [x, y] = lerp(a, b, 0.15 + v * 0.75);
      const r = 2.5 + rnd(k * 2.2) * 4.5;
      ctx.fillStyle = `rgba(150,110,80,${dusk ? 0.22 : 0.18})`;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.6, r * 0.8, 0, 0, 7); ctx.fill();
    }
    ctx.restore();
    // 3) pulviscolo: granelli che fluttuano lenti dentro i fasci e brillano quando passano nella luce
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const N = 90;
    for (let k = 0; k < N; k++) {
      const q = beams[k % n];
      const u = (rnd(k * 1.3) + Math.sin(t * 0.07 + k) * 0.08 + 1) % 1;              // lungo il vetro
      const v = (rnd(k * 2.9) + t * (0.004 + rnd(k) * 0.006)) % 1;                   // dall'alto verso il pavimento, piano piano
      const lerp = (p0, p1, x) => [p0[0] + (p1[0] - p0[0]) * x, p0[1] + (p1[1] - p0[1]) * x];
      const top = lerp(q.top0, q.top1, u), far = lerp(q.far0, q.far1, u);
      const [x, y] = lerp(top, far, v);
      const wob = Math.sin(t * (0.8 + rnd(k + 5)) + k * 2) * 1.6;
      const tw = Math.max(0, Math.sin(t * (1.2 + rnd(k + 9) * 2.4) + k * 3.3));
      const alpha = (0.25 + 0.75 * tw) * (1 - v) * breath * (dusk ? 0.9 : 0.75);
      if (alpha < 0.05) continue;
      ctx.fillStyle = `rgba(${dusk ? '255,200,140' : '255,246,215'},${alpha.toFixed(2)})`;
      ctx.fillRect(Math.round(x + wob), Math.round(y), tw > 0.9 ? 2 : 1, 1);
    }
    ctx.restore();
    // 4) gradazione calda e vignettatura morbida (atmosfera, non oggetti)
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = dusk ? 'rgba(255,140,60,0.28)' : 'rgba(255,214,150,0.18)';
    ctx.fillRect(0, 0, LW, LH);
    ctx.globalCompositeOperation = 'multiply';
    const [cx, cy] = P(depth * 0.45, (a0 + a1) / 2, 0);
    const vg = ctx.createRadialGradient(cx, cy, Math.min(LW, LH) * 0.25, LW / 2, LH / 2, Math.max(LW, LH) * 0.75);
    vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(1, dusk ? 'rgba(130,80,70,0.4)' : 'rgba(170,140,130,0.28)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, LW, LH);
    ctx.restore();
    ctx.restore();   // fine del ritaglio sulla stanza
  }

  destroy() { clearInterval(this.timer); }
}

function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
