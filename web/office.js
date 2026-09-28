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
import { drawText, textWidth, shade, lookOf } from './pixel.js';

const LW = 448, LH = 356;          // risoluzione logica (poi ingrandita a pixel pieni)
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
  constructor(canvas, overlay, { onSelect } = {}) {
    this.canvas = canvas; this.overlay = overlay; this.onSelect = onSelect;
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

  setLayout(layout) { this.layout = layout; this.iso = makeIso(layout.room); this.staticLayer = null; this.placeLabels(); }
  setAgents(list) { for (const a of list) this.agents[a.id] = a; this.placeLabels(); }
  updateAgent(a) { this.agents[a.id] = a; this.updateLabel(a); }

  // chi sta dove: le postazioni con agent = id; gli agenti senza postazione prendono le "spare"
  stations() {
    if (!this.layout) return [];
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
    if (st.kind === 'table') return [st.x + 1.1, st.y + 0.8];
    const L = this.local(st);
    return L.xy(1.3, 1.75);
  }

  // ── etichette DOM sopra i personaggi (nome + stato; clic = dettaglio) ──────────────────────
  placeLabels() {
    if (!this.layout || !this.overlay) return;
    this.overlay.innerHTML = '';
    for (const st of this.stations()) {
      const a = this.agents[st.agentId]; if (!a) continue;
      const [x, y] = this.seatOf(st);
      const [sx, sy] = this.iso(x, y, st.kind === 'table' ? 34 : 58);
      const el = document.createElement('button');
      el.className = `otag${st.kind === 'table' ? ' otag-table' : ''}`;
      el.dataset.agent = a.id;
      el.style.left = `${(sx / LW) * 100}%`;
      el.style.top = `${(sy / LH) * 100}%`;
      el.onclick = () => this.onSelect?.(a.id);
      this.overlay.appendChild(el);
      this.updateLabel(a);
      // area cliccabile sul personaggio
      const hit = document.createElement('button');
      hit.className = 'ohit'; hit.title = `${a.name} — ${a.role}`;
      const [hx, hy] = this.iso(x, y, 30);
      hit.style.left = `${(hx / LW) * 100}%`; hit.style.top = `${(hy / LH) * 100}%`;
      hit.onclick = () => this.onSelect?.(a.id);
      this.overlay.appendChild(hit);
    }
  }

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

    // strato statico (pavimento, pareti) ridisegnato solo quando cambia l'ora del cielo
    const key = `${sky.top}|${date.getMinutes()}`;
    if (!this.staticLayer || this.staticKey !== key) { this.staticLayer = this.drawStatic(sky, date); this.staticKey = key; }
    ctx.drawImage(this.staticLayer, 0, 0);

    // oggetti a pavimento e personaggi, ordinati per profondità
    const items = [];
    for (const d of this.layout.decor) if (!d.wall && d.type !== 'rug') items.push({ k: d.x + d.y + (d.type === 'crates' ? 1 : 0.5), draw: () => this.drawDecor(d, t) });
    for (const st of this.stations()) {
      const a = this.agents[st.agentId];
      if (st.kind === 'table') { items.push({ k: st.x + st.y + 1.6, draw: () => this.drawTable(st, a, t) }); continue; }
      const L = this.local(st);
      const [dx, dy] = L.xy(1.3, 0.6);
      items.push({ k: dx + dy, draw: () => this.drawStation(st, a, t) });
      const [cx, cy] = this.seatOf(st);
      items.push({ k: cx + cy + 0.2, draw: () => this.drawCharacter(st, a, t) });
    }
    items.sort((p, q) => p.k - q.k);
    for (const it of items) it.draw();

    // particelle
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g || 0; p.life--;
      ctx.globalAlpha = p.fade ? Math.max(0, p.life / 28) : 1;
      ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.life > 0);

    this.drawLight(sky, t);

    // fumetti sopra la testa (dopo la luce: restano leggibili)
    for (const st of this.stations()) this.drawBubble(st, this.agents[st.agentId], t);
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

  drawWallDecor(ctx, d, sky, date) {
    const H = this.layout.room.wallH;
    if (d.type === 'window') {
      const w = d.w || 1.6, z0 = 44, z1 = H - 22;
      const r = this.wallRect(d.wall, d.at, d.at + w, z0 - 3, z1 + 3);
      poly(ctx, r.pts, PAL.woodD);
      const [img, x] = tela(40, 44);
      const g = x.createLinearGradient(0, 0, 0, 44); g.addColorStop(0, sky.top); g.addColorStop(1, sky.bottom);
      x.fillStyle = g; x.fillRect(0, 0, 40, 44);
      if (sky.night > 0.4) {
        for (let i = 0; i < 18; i++) { x.fillStyle = i % 5 ? '#cfd8ff' : '#ffffff'; x.fillRect(Math.floor(rnd(i + d.at) * 40), Math.floor(rnd(i * 3 + d.at) * 24), 1, 1); }
        x.fillStyle = '#f5f1d6'; x.beginPath(); x.arc(28 - d.at * 2, 9, 4, 0, 7); x.fill();
        x.fillStyle = sky.top; x.beginPath(); x.arc(30 - d.at * 2, 8, 3.4, 0, 7); x.fill();
      } else { x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(30, 10, 4, 0, 7); x.fill(); x.fillStyle = '#ffffffcc'; x.fillRect(5, 12, 9, 2); x.fillRect(8, 11, 5, 1); }
      // tetti e campanile del borgo
      const roof = sky.night > 0.4 ? '#141833' : '#7b4a3a', wall = sky.night > 0.4 ? '#1d2346' : '#caa98a';
      x.fillStyle = sky.night > 0.4 ? '#101428' : '#6b8f5a'; x.fillRect(0, 34, 40, 10);
      const houses = [[0, 30, 9, 8], [8, 27, 8, 11], [15, 31, 9, 7], [23, 25, 6, 13], [28, 29, 12, 9]];
      for (const [hx, hy, hw, hh] of houses) { x.fillStyle = wall; x.fillRect(hx, hy, hw, hh); x.fillStyle = roof; x.fillRect(hx - 1, hy - 2, hw + 2, 2); }
      x.fillStyle = wall; x.fillRect(24, 18, 4, 7); x.fillStyle = roof; x.fillRect(23, 16, 6, 2); x.fillRect(25, 14, 2, 2);
      if (sky.night > 0.4) for (const [lx, ly] of [[3, 33], [11, 30], [12, 34], [18, 34], [25, 28], [32, 32], [36, 34]]) { x.fillStyle = '#ffcf6b'; x.fillRect(lx, ly, 1, 2); }
      const inner = this.wallRect(d.wall, d.at, d.at + w, z0, z1);
      ctx.save(); ctx.beginPath(); inner.pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
      mapFace(ctx, img, inner.p0, inner.pu, inner.pv);
      ctx.restore();
      // montanti
      const m1 = this.wallRect(d.wall, d.at + w / 2 - 0.04, d.at + w / 2 + 0.04, z0, z1); poly(ctx, m1.pts, PAL.woodF);
      const zm = (z0 + z1) / 2; const m2 = this.wallRect(d.wall, d.at, d.at + w, zm - 1, zm + 1); poly(ctx, m2.pts, PAL.woodF);
      const sill = this.wallRect(d.wall, d.at - 0.1, d.at + w + 0.1, z0 - 5, z0 - 2); poly(ctx, sill.pts, PAL.woodT);
      // vaso di gerani sul davanzale
      const [px, py] = d.wall === 'R' ? this.iso(d.at + 0.5, 0.2, z0 - 2) : this.iso(0.2, d.at + 0.5, z0 - 2);
      ctx.fillStyle = PAL.pot; ctx.fillRect(Math.round(px) - 3, Math.round(py) - 4, 7, 4);
      ctx.fillStyle = PAL.leaf; ctx.fillRect(Math.round(px) - 4, Math.round(py) - 7, 9, 3);
      ctx.fillStyle = '#e8414e'; for (const o of [-3, 0, 3]) ctx.fillRect(Math.round(px) + o, Math.round(py) - 8, 2, 2);
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

  drawStation(st, agent, t) {
    const L = this.local(st), status = agent?.runtime?.status || 'IDLE';
    const W = (a, b, al, bl, z, h) => { const [x, y, w, d] = L.box(a, b, al, bl); this.wood(x, y, z, w, d, h); };
    const B = (a, b, al, bl, z, h, c1, c2, c3) => { const [x, y, w, d] = L.box(a, b, al, bl); this.box(x, y, z, w, d, h, c1, c2, c3); };
    // scrivania: gambe, piano, cassettiera
    W(0.15, 0.15, 0.18, 0.18, 0, 24); W(0.15, 1.05, 0.18, 0.18, 0, 24);
    W(2.45, 0.15, 0.18, 0.18, 0, 24); W(2.45, 1.05, 0.18, 0.18, 0, 24);
    W(1.7, 0.2, 0.9, 1.0, 0, 24);
    B(0.05, 0.05, 2.7, 1.3, 24, 3, PAL.woodT, PAL.woodF, PAL.woodS);
    const faceColor = agent?.avatar?.color;
    if (['pc', 'easel', 'drafting', 'audio'].includes(st.kind)) {
      // monitor (uno o due) con lo schermo verso la sedia
      const mons = st.kind === 'pc' ? [[0.55, 0.9], [1.5, 0.9]] : st.kind === 'drafting' ? [[1.55, 0.9]] : [[1.1, 0.9]];
      for (const [ma, ml] of mons) {
        B(ma + 0.35, 0.35, 0.2, 0.2, 27, 6, PAL.metalL, PAL.metal, PAL.metal);
        B(ma, 0.3, ml, 0.18, 33, 16, PAL.metalL, PAL.metal, '#2b2c36');
        const f = this.frontFace(st, ma + 0.05, 0.3, ml - 0.1, 0.18, 34.5, 47.5);
        mapFace(this.ctx, this.screenImage(st.kind, status, t + ma, faceColor), f.p0, f.pu, f.pv);
      }
      B(0.8, 0.85, 1.1, 0.35, 27, 1, '#2a2b33', '#1c1d24', '#1c1d24');   // tastiera
      B(2.05, 0.95, 0.2, 0.25, 27, 1, '#2a2b33', '#1c1d24', '#1c1d24');  // mouse
    }
    if (st.kind === 'pc') {
      B(2.3, 0.5, 0.25, 0.25, 27, 6, '#e8e1d4', '#cfc6b6', '#b9b0a0');   // tazza
      B(0.15, 0.25, 0.35, 0.5, 27, 10, '#5a8fd6', '#3d6bb0', '#2f5690');  // libri
      B(0.15, 0.25, 0.35, 0.5, 37, 5, '#d65a5a', '#b04040', '#903434');
    }
    if (st.kind === 'tv') {
      // mobiletto con la TV a tubo e la console
      B(0.4, 0.2, 1.8, 0.95, 27, 22, '#3a3a46', '#2c2c36', '#22222b');
      const f = this.frontFace(st, 0.52, 0.2, 1.56, 0.95, 30, 46);
      mapFace(this.ctx, this.screenImage('tv', status, t, faceColor), f.p0, f.pu, f.pv);
      B(0.7, 0.25, 1.2, 0.6, 49, 3, '#2c2c36', '#22222b', '#1a1a22');
      B(2.3, 0.4, 0.4, 0.5, 27, 4, '#f2f2f2', '#d7d7d7', '#bdbdbd');     // console
      if (status !== 'TESTING') B(1.9, 1.0, 0.35, 0.2, 27, 2, '#222', '#111', '#111');   // pad posato sul tavolo
    }
    if (st.kind === 'typewriter') {
      B(0.9, 0.55, 1.0, 0.6, 27, 6, '#2f4a3a', '#243a2d', '#1b2c22');     // macchina da scrivere
      const grow = status === 'WORKING' ? 4 + (Math.floor(t * 3) % 6) : 4;
      B(1.05, 0.6, 0.7, 0.08, 33, grow + 4, PAL.paper, '#e3d9c1', '#d2c7ad');  // foglio che sale
      B(2.0, 0.4, 0.6, 0.7, 27, 5, PAL.paper, '#e3d9c1', '#d2c7ad');       // pila di fogli
      B(0.2, 0.3, 0.45, 0.6, 27, 14, '#8e5ad6', '#6d40b0', '#5a3490');     // libri
      B(0.2, 0.3, 0.45, 0.6, 41, 6, '#e0a53d', '#c28a2a', '#a67320');
      B(2.2, 1.0, 0.18, 0.18, 27, 7, '#f5f0e0', '#e3dccb', '#cfc7b4');     // candela
      const [cx, cy] = this.iso(...L.xy(2.29, 1.09), 36); this.ctx.fillStyle = Math.floor(t * 8) % 2 ? '#ffd166' : '#ff9f43'; this.ctx.fillRect(Math.round(cx), Math.round(cy) - 2, 1, 2);
    }
    if (st.kind === 'easel') {
      // tavolozza + cavalletto con la tela
      B(2.0, 0.8, 0.5, 0.35, 27, 1, '#d9b98a', '#c19e6f', '#a8865a');
      const [px, py] = this.iso(...L.xy(2.2, 0.95), 29);
      for (const [o, c] of [[-2, '#e84a5f'], [0, '#ffd166'], [2, '#3fb0e0'], [4, '#7bd88f']]) { this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(px) + o, Math.round(py), 1, 1); }
      const ea = 2.95;
      W(ea, 1.2, 0.08, 0.08, 0, 64); W(ea + 0.55, 1.2, 0.08, 0.08, 0, 64); W(ea + 0.28, 0.9, 0.08, 0.08, 0, 60);
      B(ea - 0.1, 1.15, 0.85, 0.06, 28, 34, PAL.paper, '#efe6cf', '#d8cdb3');
      const [img, x] = tela(16, 18);
      x.fillStyle = '#f6efdc'; x.fillRect(0, 0, 16, 18);
      const prog = status === 'WORKING' ? Math.floor(t * 2) % 14 : 13;
      x.fillStyle = '#2b3a6b'; x.fillRect(0, 0, 16, 8); x.fillStyle = '#f5f1d6'; x.fillRect(11, 2, 2, 2);
      x.fillStyle = '#c4553b'; x.fillRect(2, 8, 5, 4); x.fillRect(9, 7, 5, 5);
      x.fillStyle = '#7a6b5c'; x.fillRect(0, 12, 16, 6);
      if (prog < 13) { x.fillStyle = '#f6efdc'; x.fillRect(0, 18 - (13 - prog), 16, 13 - prog); }
      const f = this.frontFace(st, ea - 0.1, 1.15, 0.85, 0.06, 30, 60);
      mapFace(this.ctx, img, f.p0, f.pu, f.pv);
    }
    if (st.kind === 'drafting') {
      // grande mappa del paese srotolata sul tavolo, con le puntine
      B(0.2, 0.55, 1.25, 0.7, 27, 1, '#e9dcb8', '#cdbb8c', '#b9a676');
      for (const [pa, pb, c] of [[0.45, 0.75, '#d63a3a'], [0.9, 0.95, '#2e86de'], [1.2, 0.7, '#d63a3a']]) { const [px, py] = this.iso(...L.xy(pa, pb), 29); this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(px), Math.round(py) - 2, 1, 2); }
      const [mx, my] = this.iso(...L.xy(0.8, 0.9), 28); this.ctx.fillStyle = '#a58f63'; this.ctx.fillRect(Math.round(mx) - 5, Math.round(my), 10, 1); this.ctx.fillRect(Math.round(mx), Math.round(my) - 3, 1, 6);
      B(2.2, 0.9, 0.5, 0.12, 27, 1, '#f2c14e', '#d9a441', '#b88227');     // righello
    }
    if (st.kind === 'audio') {
      // tastiera musicale e casse
      B(0.2, 0.75, 1.3, 0.45, 27, 3, '#f4f4f4', '#2a2a33', '#1c1d24');
      for (let i = 0; i < 9; i++) if (i % 3 !== 2) { const [kx, ky] = this.iso(...L.xy(0.3 + i * 0.13, 0.8), 30); this.ctx.fillStyle = '#1b1b22'; this.ctx.fillRect(Math.round(kx), Math.round(ky), 1, 2); }
      for (const ca of [0.05, 2.35]) { B(ca, 0.2, 0.35, 0.35, 27, 16, '#3a3b47', '#2b2c36', '#22222b'); const [sx2, sy2] = this.iso(...L.xy(ca + 0.17, 0.55), 36); this.ctx.fillStyle = '#5a5c6c'; this.ctx.fillRect(Math.round(sx2) - 1, Math.round(sy2) - 2, 3, 3); }
      if (status === 'WORKING' || status === 'TESTING') { const [nx, ny] = this.iso(...L.xy(1.3, 0.4), 60 + (Math.floor(t * 4) % 6)); this.ctx.fillStyle = '#ff7ac4'; drawText(this.ctx, '/', Math.round(nx), Math.round(ny), '#ff7ac4'); }
    }
    if (st.kind === 'library') {
      // pile di libri, il grande libro della Bibbia aperto, candela
      for (const [la, h, c] of [[0.1, 22, '#8e5ad6'], [0.45, 16, '#d65a5a'], [2.3, 26, '#3d7a3a'], [2.0, 12, '#e0a53d']]) B(la, 0.2, 0.3, 0.55, 27, h, c, shade(c, -0.18), shade(c, -0.3));
      B(0.95, 0.45, 1.0, 0.65, 27, 3, '#f4ecd8', '#6b3b1a', '#5a3216');
      const [bx2, by2] = this.iso(...L.xy(1.45, 0.75), 31); this.ctx.fillStyle = '#6b3b1a'; this.ctx.fillRect(Math.round(bx2), Math.round(by2) - 1, 1, 3);
      this.ctx.fillStyle = '#9a927e'; for (let l = 0; l < 3; l++) { this.ctx.fillRect(Math.round(bx2) - 6, Math.round(by2) - 1 + l * 2, 4, 1); this.ctx.fillRect(Math.round(bx2) + 3, Math.round(by2) - 1 + l * 2, 4, 1); }
      if (status === 'WORKING') { const [qx, qy] = this.iso(...L.xy(1.8, 0.95), 34); this.ctx.fillStyle = '#f5f5f5'; this.ctx.fillRect(Math.round(qx) + (Math.floor(t * 4) % 2), Math.round(qy) - 6, 1, 6); }
    }
    if (st.kind === 'puzzle') {
      // pezzi di puzzle, lente d'ingrandimento, cofanetto chiuso col lucchetto
      const cols = ['#ff5d8f', '#ffd166', '#6fd3ff', '#7bd88f'];
      for (let i = 0; i < 10; i++) { const [px, py] = this.iso(...L.xy(0.3 + (i % 5) * 0.2, 0.55 + Math.floor(i / 5) * 0.25), 28); this.ctx.fillStyle = cols[i % 4]; this.ctx.fillRect(Math.round(px), Math.round(py) - 1, 3, 2); }
      B(1.7, 0.35, 0.7, 0.5, 27, 9, '#8a5a31', '#6e4526', '#5a371c');
      const [lx2, ly2] = this.iso(...L.xy(2.05, 0.85), 32); this.ctx.fillStyle = '#e8c46a'; this.ctx.fillRect(Math.round(lx2) - 1, Math.round(ly2) - 2, 3, 3);
      const [gx, gy] = this.iso(...L.xy(1.3, 1.05), 29); this.ctx.strokeStyle = '#c9ccd4'; this.ctx.beginPath(); this.ctx.arc(Math.round(gx), Math.round(gy) - 2, 2.5, 0, 7); this.ctx.stroke(); this.ctx.fillStyle = '#6b3b1a'; this.ctx.fillRect(Math.round(gx) + 2, Math.round(gy), 3, 1);
      B(0.2, 1.0, 0.5, 0.3, 27, 1, PAL.paper, '#e3d9c1', '#d2c7ad');
      const [qx, qy] = this.iso(...L.xy(0.4, 1.1), 28); drawText(this.ctx, '?', Math.round(qx) - 1, Math.round(qy) - 3, '#a0302a');
    }
    // lampada da scrivania
    B(0.25, 0.95, 0.22, 0.22, 27, 2, PAL.metalL, PAL.metal, PAL.metal);
    B(0.32, 1.02, 0.08, 0.08, 29, 12, PAL.metalL, PAL.metal, PAL.metal);
    B(0.2, 0.9, 0.34, 0.34, 41, 4, '#e0b13c', '#c2931f', '#a57a15');
  }

  drawTable(st, agent, t) {
    const { x, y } = st;
    this.wood(x + 0.2, y + 0.2, 0, 0.2, 0.2, 22); this.wood(x + 2.0, y + 0.2, 0, 0.2, 0.2, 22);
    this.wood(x + 0.2, y + 1.4, 0, 0.2, 0.2, 22); this.wood(x + 2.0, y + 1.4, 0, 0.2, 0.2, 22);
    this.box(x, y, 22, 2.4, 1.8, 3, PAL.woodT, PAL.woodF, PAL.woodS);
    // il verbale, il campanello del presidente, bicchieri
    this.box(x + 0.5, y + 0.5, 25, 0.8, 0.6, 1, PAL.paper, '#e3d9c1', '#d2c7ad');
    this.box(x + 0.55, y + 0.55, 26, 0.7, 0.5, 1, '#fffaf0', '#e3d9c1', '#d2c7ad');
    const [bx, by] = this.iso(x + 1.8, y + 0.5, 25);
    const ring = agent && ['THINKING', 'BLOCKED'].includes(agent.runtime?.status) && Math.floor(t * 4) % 2;
    this.ctx.fillStyle = '#c9a227'; this.ctx.fillRect(Math.round(bx) - 3 + (ring ? 1 : 0), Math.round(by) - 4, 6, 4); this.ctx.fillRect(Math.round(bx) - 1, Math.round(by) - 6, 2, 2);
    this.ctx.fillStyle = '#fff1a8'; this.ctx.fillRect(Math.round(bx) - 2, Math.round(by) - 4, 1, 2);
    for (const [gx, gy] of [[x + 1.5, y + 1.3], [x + 0.4, y + 1.35]]) { const [sx, sy] = this.iso(gx, gy, 25); this.ctx.fillStyle = '#d7ecf2aa'; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 4, 3, 4); this.ctx.fillStyle = '#e7b53d'; this.ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 2, 3, 2); }
    // sedie impagliate
    for (const [cx, cy] of [[x + 0.6, y + 2.05], [x + 1.7, y + 2.05]]) { this.wood(cx, cy, 0, 0.5, 0.5, 13); this.box(cx, cy, 13, 0.5, 0.5, 2, '#d9b36b', '#b99048', '#9c7838'); this.wood(cx, cy + 0.42, 15, 0.5, 0.08, 14); }
  }

  drawDecor(d, t) {
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
    const [sx, sy0] = this.iso(cx, cy, 0);
    const flip = st.wall === 'L';
    const status = agent.runtime?.status || 'IDLE';
    const anim = (agent.animations || {})[status] || 'idle';
    const fx = this.fx[agent.id] && this.fx[agent.id].until > performance.now() ? this.fx[agent.id].kind : null;
    const celebrate = anim === 'celebrate' && (fx === 'done' || Math.floor(t) % 5 === 0);
    const jump = celebrate ? Math.round(Math.abs(Math.sin(t * 9)) * 4) : 0;
    const shakeX = anim === 'error' && fx === 'fail' ? (Math.floor(t * 20) % 2 ? 1 : -1) : 0;
    const X = Math.round(sx) + shakeX, Y = Math.round(sy0) - 16 - jump;
    const R = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(flip ? X - dx - w : X + dx, Y + dy, w, h); };
    const L = lookOf(agent);

    // ombra
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#1a0f0a'; ctx.beginPath(); ctx.ellipse(X, Y + 16 + jump, 9, 4, 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1;

    // spritesheet personale al posto del personaggio disegnato
    if (agent.avatar?.type === 'spritesheet' && agent.avatar.sprite?.url) {
      const s = agent.avatar.sprite;
      let img = this.sprites[s.url];
      if (!img) { img = new Image(); img.src = s.url; this.sprites[s.url] = img; }
      if (img.complete && img.naturalWidth) {
        const def = (s.animations || {})[anim] || (s.animations || {}).idle || { row: 0, frames: 1, fps: 1 };
        const f = Math.floor(t * (def.fps || 6)) % (def.frames || 1);
        const sc = s.officeScale || 1;
        ctx.drawImage(img, f * s.frameWidth, (def.row || 0) * s.frameHeight, s.frameWidth, s.frameHeight, X - s.frameWidth * sc / 2, Y + 16 - s.frameHeight * sc, s.frameWidth * sc, s.frameHeight * sc);
      }
      return;
    }

    const breathe = anim === 'idle' || anim === 'waiting' ? (Math.floor(t * 0.8) % 2) : 0;
    const shirtD = shade(L.shirt, -0.22), skinD = shade(L.skin, -0.18);
    const standing = celebrate;
    // gambe (visibili solo in piedi) e sedia dietro
    if (standing) { R(-4, 6, 3, 10, '#34384a'); R(1, 6, 3, 10, '#34384a'); R(-4, 15, 3, 1, '#1b1b22'); R(1, 15, 3, 1, '#1b1b22'); }
    // busto
    const ty = breathe;
    R(-7, -18 + ty, 14, 17, '#1b1426');
    R(-6, -17 + ty, 12, 15, L.shirt); R(-6, -17 + ty, 3, 15, shirtD); R(-5, -18 + ty, 10, 1, L.shirt); R(-2, -16 + ty, 1, 8, shirtD);
    // testa (vista di spalle, un po' di tre quarti)
    const hy = -28 + ty + (anim === 'waiting' ? Math.floor(t * 1.2) % 2 : 0);
    R(-1, -19 + ty, 3, 2, skinD);
    R(-5, hy - 1, 10, 11, '#1b1426');
    R(-4, hy, 8, 9, L.skin);
    const H = L.hair, HD = shade(L.hair, -0.2);
    if (L.hairStyle === 'long') { R(-5, hy - 1, 10, 7, H); R(-5, hy + 6, 10, 7, H); R(-5, hy + 6, 2, 7, HD); }
    else if (L.hairStyle === 'ponytail') { R(-4, hy - 1, 8, 7, H); R(-1, hy + 6, 3, 6 + (Math.floor(t * 3) % 2), H); R(-1, hy + 5, 3, 1, '#e84a5f'); }
    else if (L.hairStyle === 'bun') { R(-4, hy - 1, 8, 6, H); R(-2, hy - 4, 4, 3, H); R(-4, hy + 5, 1, 2, H); }
    else if (L.hairStyle === 'bald') { R(-4, hy + 3, 8, 3, H); R(-3, hy, 4, 1, shade(L.skin, 0.25)); }
    else if (L.hairStyle === 'curly') { R(-5, hy - 2, 10, 8, H); for (let i = 0; i < 5; i++) R(-5 + i * 2, hy - 3 + (i % 2), 2, 1, H); R(-5, hy + 6, 10, 1, HD); }
    else { R(-4, hy - 1, 8, 7, H); R(-4, hy + 5, 1, 2, H); }
    R(3, hy + 4, 1, 2, skinD);   // orecchio / guancia verso lo schermo
    const A = L.accColor;
    if (L.accessory === 'headphones') { R(-5, hy - 2, 10, 1, A); R(3, hy + 3, 2, 4, A); R(-5, hy + 3, 2, 4, A); }
    if (L.accessory === 'beret') { R(-5, hy - 3, 10, 3, A); R(-1, hy - 4, 2, 1, A); }
    if (L.accessory === 'cap') { R(-4, hy - 2, 8, 3, A); R(3, hy, 3, 1, shade(A, -0.2)); }
    if (L.accessory === 'glasses') { R(3, hy + 3, 2, 1, '#15151b'); }
    if (L.accessory === 'beard') { R(3, hy + 6, 1, 3, L.hair); }
    // braccia secondo l'animazione
    const f2 = Math.floor(t * 10) % 2, f4 = Math.floor(t * 4) % 2;
    if (anim === 'typing') {
      R(5, -16 + ty, 2, 6, shirtD); R(6, -11 + ty - f2, 3, 2, L.skin);
      R(-7, -16 + ty, 2, 6, shirtD); R(-8, -11 + ty - (1 - f2), 2, 2, L.skin);
    } else if (anim === 'playing') {
      const sh = Math.floor(t * 12) % 2;
      R(5, -15 + ty, 2, 5, shirtD); R(-7, -15 + ty, 2, 5, shirtD);
      R(-9, -11 + ty + sh, 18, 3, '#2a2a33'); R(-9, -11 + ty + sh, 2, 3, '#ff4fa3'); R(7, -11 + ty + sh, 2, 3, '#3fe0d0');
    } else if (anim === 'writing-notes') {
      R(5, -16 + ty, 2, 5, shirtD); R(6 + f4, -12 + ty, 2, 2, L.skin); R(8 + f4, -14 + ty, 1, 3, '#1f3a8a');
      R(-7, -16 + ty, 2, 8, shirtD); R(-7, -9 + ty, 2, 2, L.skin);
    } else if (anim === 'question') {
      R(4, -24 + ty, 2, 8, shirtD); R(2, hy - 1 + (f4), 3, 2, L.skin);
      R(-7, -16 + ty, 2, 8, shirtD); R(-7, -9 + ty, 2, 2, L.skin);
    } else if (anim === 'error') {
      R(4, -26 + ty, 2, 9, shirtD); R(2, hy - 2, 3, 2, L.skin); R(-6, -26 + ty, 2, 9, shirtD); R(-5, hy - 2, 3, 2, L.skin);
    } else if (celebrate) {
      R(5, -29, 2, 12, shirtD); R(5, -31, 2, 2, L.skin); R(-7, -29, 2, 12, shirtD); R(-7, -31, 2, 2, L.skin);
    } else {
      // idle / waiting: braccia giù, ogni tanto un sorso di caffè
      const sip = anim === 'idle' && Math.floor(t / 4) % 3 === 0;
      if (sip) { R(4, -22 + ty, 2, 8, shirtD); R(3, hy + 6, 3, 3, '#e8e1d4'); } else { R(5, -16 + ty, 2, 9, shirtD); R(5, -8 + ty, 2, 2, L.skin); }
      R(-7, -16 + ty, 2, 9, shirtD); R(-7, -8 + ty, 2, 2, L.skin);
    }
    // sedia davanti alla schiena (seduto)
    if (!standing) {
      const chair = shade(agent.avatar?.color || '#555555', -0.45), chairL = shade(chair, 0.25);
      R(-5, -8, 10, 8, chair); R(-4, -7, 8, 1, chairL); R(-7, 0, 14, 3, chairL); R(-1, 3, 2, 8, PAL.metal);
      R(-6, 11, 12, 1, PAL.metal); R(-7, 11, 2, 2, '#1b1b22'); R(5, 11, 2, 2, '#1b1b22'); R(-1, 12, 2, 2, '#1b1b22');
    }
    // lampo quando inizia un task
    if (fx === 'start') { ctx.globalAlpha = 0.5; R(-8, hy - 4, 16, 2, '#ffffff'); ctx.globalAlpha = 1; }
  }

  drawBubble(st, agent, t) {
    if (!agent) return;
    const status = agent.runtime?.status || 'IDLE';
    const anim = (agent.animations || {})[status] || 'idle';
    const icon = { 'writing-notes': 'dots', waiting: 'hourglass', question: '?', error: '!', celebrate: 'check' }[anim] || (st.kind === 'table' && status === 'THINKING' ? 'dots' : null);
    if (!icon) return;
    const ctx = this.ctx;
    const [cx, cy] = this.seatOf(st);
    const [sx, sy] = this.iso(cx, cy, st.kind === 'table' ? 44 : 52);
    const bob = Math.round(Math.sin(t * 3) * 1.2);
    const x = Math.round(sx) + (st.wall === 'L' ? -12 : 4), y = Math.round(sy) - 8 + bob;
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
    d.fillStyle = `rgba(10,14,40,${sky.dark})`; d.fillRect(0, 0, LW, LH);
    d.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => { const g = d.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)'); d.fillStyle = g; d.fillRect(x - r, y - r, r * 2, r * 2); };
    const glows = [];
    for (const st of this.stations()) {
      if (st.kind === 'table') { const [x, y] = iso(st.x + 1.2, st.y + 0.9, 30); hole(x, y, 46, 0.8); glows.push([x, y, 40, '255,196,110', 0.1]); continue; }
      const L = this.local(st);
      const [lx, ly] = iso(...L.xy(0.37, 1.07), 40); hole(lx, ly + 8, 44, 0.95); glows.push([lx, ly + 8, 40, '255,200,120', 0.14]);
      const status = this.agents[st.agentId]?.runtime?.status;
      const [mx, my] = iso(...L.xy(1.3, 0.6), 42);
      const col = status === 'ERROR' ? '255,80,90' : status === 'DONE' ? '120,240,160' : status === 'BLOCKED' ? '255,210,100' : '110,210,255';
      const flick = status === 'WORKING' || status === 'TESTING' ? 0.12 + (Math.floor(t * 8) % 2) * 0.04 : 0.07;
      hole(mx, my, 30, 0.6); glows.push([mx, my, 28, col, flick]);
    }
    for (const dec of this.layout.decor) {
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

  destroy() { clearInterval(this.timer); }
}

function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
