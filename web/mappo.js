// UFFICIO DI MAPPO — editor della mappa a rioni (Livello 3).
// Disegna i rioni come il gioco: terreno e case (tile + immagini del .tmj), aperture, recinzioni, arredi dei .tmj
// (con la grafica nuova del set di arredi, usando proprio src/systems/Arredi.js del gioco), e gli elementi del
// livello (bersagli, arredi, oggetti, persone, luci...). Ogni oggetto si sposta, gira, ingrandisce, cambia sprite
// o si toglie; il salvataggio va allo Studio (POST /api/mappo/save), che lo mette in una versione da provare.
import { buildPortrait, normalizeLook } from './sprites.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TILE = 24;
const r1 = (v) => Math.round(v * 10) / 10;
const clone = (o) => JSON.parse(JSON.stringify(o));
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `errore ${r.status}`);
  return j;
};

// strati: id, nome, colore del segno, visibile all'inizio
const LAYERS = [
  ['ground', 'Terreno e case', '#8a7a5a', true],
  ['aperture', 'Porte e finestre', '#5f8fb8', true],
  ['recinzioni', 'Recinzioni', '#8c6a3c', true],
  ['arredi', 'Arredi dei rioni', '#4f7a3a', true],
  ['props', 'Arredi del livello', '#7a9a3a', true],
  ['targets', 'Bersagli', '#b8402e', true],
  ['items', 'Oggetti da raccogliere', '#c08a20', true],
  ['citizens', 'Persone', '#a050a0', true],
  ['hideouts', 'Nascondigli', '#506070', false],
  ['lights', 'Luci', '#e8c050', false],
  ['places', 'Luoghi ed eventi', '#3080a0', false],
  ['landmarks', 'Nomi dei luoghi', '#404040', false],
  ['player', 'Partenza e uscita', '#e04080', true],
];
const LIST_LAYER = { targets: 'targets', props: 'props', items: 'items', citizens: 'citizens', hideouts: 'hideouts', lights: 'lights', events: 'places', places: 'places', landmarks: 'landmarks', player: 'player', exit: 'player' };
const KIND_NAME = { arredi: 'arredo del rione', aperture: 'apertura', recinzioni: 'recinzione', targets: 'bersaglio', props: 'arredo del livello', items: 'oggetto', citizens: 'persona', hideouts: 'nascondiglio', lights: 'luce', events: 'evento', places: 'luogo', landmarks: 'nome di luogo', player: 'partenza del giocatore', exit: 'uscita' };

const S = {
  scene: null, src: 'main', play: '/play/main/', A: null, fake: null, known: new Set(), man: new Map(),
  ents: [], byId: new Map(), sel: null, hover: null, seq: 0,
  view: { s: 1, tx: 0, ty: 0 }, rione: null, rioni: [], world: { w: 0, h: 0 },
  layers: Object.fromEntries(LAYERS.map(([id, , , on]) => [id, on])), locks: { ground: true },
  showRemoved: false, snap: 1, undo: [], redo: [], placing: null, dirtyDraw: true, pendingUrl: new Map(), pendingMeta: new Map(),
};
window.__mappo = S;   // per le prove dalla console
try { Object.assign(S.layers, JSON.parse(localStorage.getItem('mappo:layers') || '{}')); S.snap = Number(localStorage.getItem('mappo:snap')) || 1; } catch { /* niente */ }

// ─── trame (texture) e grandezze ─────────────────────────────────────────────────────────────────────────────
const TEX = new Map();   // chiave → { img, ready, fw, fh }
function bestSource(a) {
  let best = { file: a.file, frameSize: a.frameSize, density: 1 };
  for (const [k, d] of Object.entries(a)) {
    const n = Number(/^detail(\d+)x$/.exec(k)?.[1]);
    if (!n || n <= best.density || n > 4 || !d?.file || !d.frameSize) continue;
    best = { file: d.file, frameSize: d.frameSize, density: n };
  }
  return best;
}
function urlOf(key) {
  if (key.startsWith('rs:')) { const p = key.slice(3); return S.pendingUrl.get(p) || `${S.play}levels/rioni/${p}`; }
  const m = S.man.get(key); if (m) return `${S.play}${m.file}`;
  return `${S.play}assets/props/${key}.png`;
}
function frameOf(key) {
  const m = S.man.get(key); if (m) return m.frameSize;
  const t = TEX.get(key);
  return t?.img?.naturalWidth ? [t.img.naturalWidth, t.img.naturalHeight] : [16, 16];
}
function tex(key) {
  let t = TEX.get(key);
  if (!t) {
    const img = new Image(); t = { img, ok: false, bad: false };
    t.ready = new Promise((res) => { img.onload = () => { t.ok = true; S.dirtyDraw = true; S.texLoaded = true; res(t); }; img.onerror = () => { t.bad = true; S.texLoaded = true; res(t); }; });
    img.src = urlOf(key);
    TEX.set(key, t);
  }
  return t;
}

// ─── un'immagine finta, abbastanza Phaser per le funzioni di Arredi.js del gioco ─────────────────────────────
class FImg {
  constructor(x, y, key) { this.x = x; this.y = y; this.originX = 0.5; this.originY = 0.5; this.scaleX = 1; this.scaleY = 1; this.angle = 0; this.visible = true; this.depth = 0; this.alpha = 1; this.setTexture(key); S.fake?.made?.push(this); }
  get texture() { return { key: this.key }; }
  setTexture(key) { this.key = key; [this.width, this.height] = frameOf(key); S.used?.add(key); return this; }
  get rotation() { return (this.angle * Math.PI) / 180; }
  get displayWidth() { return this.width * Math.abs(this.scaleX); }
  get displayHeight() { return this.height * Math.abs(this.scaleY); }
  setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; }
  setAngle(a) { this.angle = a; return this; }
  setOrigin(x, y = x) { this.originX = x; this.originY = y; return this; }
  setDepth(d) { this.depth = d; return this; }
  setVisible(v) { this.visible = v; return this; }
  setTint() { return this; }
  setAlpha(a) { this.alpha = a; return this; }
  once() { return this; }
  on() { return this; }
  getCenter() {
    const dx = (0.5 - this.originX) * this.displayWidth * Math.sign(this.scaleX || 1), dy = (0.5 - this.originY) * this.displayHeight * Math.sign(this.scaleY || 1);
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return { x: this.x + dx * c - dy * s, y: this.y + dx * s + dy * c };
  }
}

async function loadArredi() {
  const sc = S.scene;
  const store = { arredi_manifest: clone(sc.manifests[0] || { assets: [] }), arredi_dipinti: clone(sc.manifests[1] || { assets: [] }) };
  S.fake = {
    cache: { json: { get: (k) => store[k], remove: (k) => { delete store[k]; }, add: (k, v) => { store[k] = v; } } },
    textures: { exists: (k) => S.known.has(k) }, anims: { exists: () => true, create() {} },
    load: { image() {}, spritesheet() {}, json() {} },
    add: { image: (x, y, key) => new FImg(x, y, key) },
    rioni: { rioneAt: (x, y) => rioneAt(x, y) },
    made: null,
  };
  // la grafica degli arredi del set (borgo_t0217 + borgo_t0227 sopra): chiavi, file e grandezze come nel gioco
  const merged = new Map();
  for (const m of sc.manifests) for (const a of m.assets || []) merged.set(a.key, a);
  for (const a of merged.values()) {
    const b = bestSource(a); S.man.set(a.key, { file: b.file, frameSize: b.frameSize, density: b.density, entry: a });
    if (a.shadow) { const s = bestSource(a.shadow); S.man.set(a.shadow.key, { file: s.file, frameSize: s.frameSize, density: s.density }); }
  }
  for (const k of S.man.keys()) S.known.add(k);
  try {
    S.A = await import(`${S.play}src/systems/Arredi.js`);
    S.A.queueArredi(S.fake); S.A.registerArredi(S.fake);
  } catch (e) { S.A = null; banner(`Non riesco a usare la grafica nuova degli arredi del gioco (${e.message}): disegno quella di base.`, true); }
}

// ─── regole del gioco (src/systems/Rioni.js) ─────────────────────────────────────────────────────────────────
const APERTURA = /sprite_nuovi\/(aperture|stati)\/(porta|portone|finestra|vetrina|vetrata|saracinesca|grata)_/;
const scalaAperture = (key) => (APERTURA.test(key ?? '') ? 1 / 4 : 1);
function spriteKey(sprite, p = {}) {
  if (!sprite) return null;
  if (sprite.startsWith('gioco:')) return sprite.slice(6);
  let path = sprite.replace(/^\.\.\//, '');
  if (!path.endsWith('.png')) {
    if (/signpost$/.test(path)) path += p.right === false ? '_left' : '_right';
    else if (/transenna$/.test(path) && p.vertical) path += '_v';
    path += '.png';
  }
  return `rs:${path}`;
}
const propsOf = (o) => Object.fromEntries((o.properties || []).map((p) => [p.name, p.value]));
function rioneAt(x, y) { return S.rioni.find((r) => x >= r.ox && y >= r.oy && x < r.ox + r.w && y < r.oy + r.h) || null; }

// ─── gli oggetti modificabili ────────────────────────────────────────────────────────────────────────────────
// e.cur = { x, y, rotation, sprite|type, size|scale, removed } · e.orig = come caricato · e.disp = immagini da disegnare
function addEnt(e) { e.id ??= `e${++S.seq}`; S.ents.push(e); S.byId.set(e.id, e); build(e); return e; }

function buildScene() {
  const sc = S.scene, idx = sc.idx;
  S.ents = []; S.byId = new Map(); S.sel = null; S.hover = null; S.undo = []; S.redo = [];
  const r0 = sc.tmj[idx.rioni[0].id];
  const G = idx.spazio ?? 240, pitchX = r0.width * TILE + G, pitchY = r0.height * TILE + G;
  S.rioni = idx.rioni.map((r) => { const t = sc.tmj[r.id]; return { ...r, t, ox: r.griglia[0] * pitchX, oy: r.griglia[1] * pitchY, w: t.width * TILE, h: t.height * TILE }; });
  S.world = { w: (Math.max(...S.rioni.map((r) => r.griglia[0])) + 1) * pitchX, h: (Math.max(...S.rioni.map((r) => r.griglia[1])) + 1) * pitchY };
  const claimed = sc.level.rioniClaimed || {};
  const claim = Object.fromEntries(['aperture', 'arredi', 'recinzioni'].map((k) => [k, new Set(claimed[k] || [])]));
  for (const r of S.rioni) {
    for (const layer of sc.layers) {
      for (const o of r.t.objects[layer] || []) {
        if (claim[layer]?.has(`${r.id}:${o.id}`)) continue;   // lo disegna il bersaglio
        const p = propsOf(o);
        if (!p.sprite) continue;
        const key = `${r.id}/${o.id}`, c = idx.correzioni?.[key] || {};
        const base = { x: r.ox + o.x, y: r.oy + o.y };
        const cur = { x: r1(base.x + (c.dx || 0)), y: r1(base.y + (c.dy || 0)), rotation: c.rotation ?? p.rotation ?? 0, sprite: c.sprite ?? p.sprite, size: c.size ?? p.size ?? null, removed: !!c.rimuovi };
        addEnt({ kind: 'tmj', layer, rione: r, o, p, key, base, corr0: c, orig: { ...cur }, cur: { ...cur }, label: o.name && o.name !== o.type ? `${o.name}` : `${o.type}${p.casa_id ? ` · ${p.casa_id}` : ''}` });
      }
    }
  }
  const L = sc.level;
  for (const list of ['targets', 'props', 'items', 'hideouts', 'citizens', 'lights', 'events', 'places', 'landmarks']) {
    (L[list] || []).forEach((d, i) => {
      if (typeof d?.x !== 'number') return;
      const cur = { x: d.x, y: d.y, rotation: d.rotation ?? 0, type: d.type ?? null, scale: d.scale ?? null, removed: false };
      const nm = d.nameId && sc.names[d.nameId];
      addEnt({ kind: 'lvl', layer: LIST_LAYER[list], list, ref: d, idx: i, orig: { ...cur }, cur: { ...cur }, label: list === 'landmarks' ? (nm || d.name || d.nameId) : list === 'citizens' ? (nm || d.id) : d.id || d.type || list });
    });
  }
  for (const list of ['player', 'exit']) if (L[list] && typeof L[list].x === 'number') {
    const cur = { x: L[list].x, y: L[list].y, rotation: 0, type: null, scale: null, removed: false };
    addEnt({ kind: 'lvl', layer: 'player', list, ref: L[list], orig: { ...cur }, cur: { ...cur }, label: list === 'player' ? 'Partenza del giocatore' : 'Uscita del livello' });
  }
}

// chi si può girare, ingrandire, cambiare di grafica
const canRotate = (e) => e.kind === 'new' || (e.kind === 'tmj' ? e.layer === 'arredi' : ['targets', 'props'].includes(e.list));
const canSprite = (e) => e.kind === 'new' || e.kind === 'tmj' || ['targets', 'props', 'items'].includes(e.list);
const canSize = (e) => e.kind === 'new' || (e.kind === 'tmj' ? e.layer === 'arredi' : ['targets', 'props'].includes(e.list));
const isMarker = (e) => e.kind === 'lvl' && !['targets', 'props', 'items'].includes(e.list);
const typeOf = (e) => (e.kind === 'tmj' ? e.cur.sprite : e.cur.type);

// costruisce le immagini di un oggetto con le stesse regole del gioco
function build(e) {
  const A = S.A, f = S.fake, c = e.cur;
  e.disp = []; e.main = null;
  if (isMarker(e)) return;
  f.made = []; S.used = new Set();
  try {
    if (e.kind === 'tmj') {
      const p = { ...e.p, rotation: c.rotation, sprite: c.sprite, size: c.size ?? undefined };
      let key = spriteKey(p.sprite, p);
      if (!key) return;
      if (e.layer === 'aperture') { e.main = new FImg(c.x, c.y, key).setScale(scalaAperture(key)).setDepth(-9); }
      else if (e.layer === 'recinzioni') { e.main = new FImg(c.x, c.y, key).setOrigin(0).setDepth(0.5); }
      else {
        const T = S.scene.idx.arredi || {}, def = { ...(T._default || {}), ...(T[e.o.type] || {}) };
        if (def.salta) return;
        const nuovo = S.known.has(key) || !A ? null : A.arredoDiretto(key, c.x, c.y, e.rione.id);
        if (nuovo) key = nuovo.key;
        const img = new FImg(c.x, c.y, key);
        const size = p.size ?? def.size;
        if (size) img.setScale(size / Math.max(img.width, img.height));
        else if (nuovo) img.setScale(A.scalaArredo(nuovo));
        if (p.rotation) img.setAngle(p.rotation);
        img.setDepth(def.chioma && A ? A.tallDepth(c.y) : 1);
        e.main = img;
        // sprite scelta a mano (correzione con "sprite"): il gioco non la ridipinge secondo il tipo (Rioni.js, sprite_fissa)
        const fissa = c.sprite !== e.p.sprite;
        if (A) { if (nuovo) A.finishArredo(f, img, nuovo); else if (!fissa) A.reskinArredo(f, img, e.o.type); }
      }
    } else if (e.list === 'targets') {
      const img = new FImg(c.x, c.y, c.type).setOrigin(e.ref.centered ? 0.5 : 0).setDepth(1);
      const sc = c.scale ?? scalaAperture(c.type);
      if (sc !== 1) img.setScale(sc);
      if (c.rotation) img.setAngle(c.rotation);
      e.main = img;
      if (A) A.reskinArredo(f, img, c.type);
    } else if (e.list === 'items') {
      e.main = new FImg(c.x, c.y, c.type).setOrigin(0).setDepth(1);
    } else {   // props del livello e arredi nuovi (GameScene: "Mobili")
      const centered = e.kind === 'new' ? true : !!e.ref.centered;
      const nuovo = S.known.has(c.type) || !A ? null : A.arredoDiretto(c.type, c.x, c.y, rioneAt(c.x, c.y)?.id ?? 'mappa');
      const img = new FImg(c.x, c.y, nuovo ? nuovo.key : c.type).setOrigin(centered ? 0.5 : 0).setDepth(1);
      if (c.scale) img.setScale(c.scale);
      if (nuovo) img.setScale(A.scalaArredo(nuovo, c.scale ?? 1));
      if (c.rotation) img.setAngle(c.rotation);
      e.main = img;
      if (A) { if (nuovo) A.finishArredo(f, img, nuovo); else A.reskinArredo(f, img, c.type); }
    }
  } catch (err) { console.warn('mappo build', e.label, err); }
  e.disp = (f.made || []).filter((d) => d !== e.main && d.visible !== false);
  if (e.main) e.disp.push(e.main);
  f.made = null;
  // grandezze ancora sconosciute (immagine non caricata): si ricostruisce quando arriva
  for (const k of S.used) tex(k);
  e.wait = [...S.used].filter((k) => !S.man.has(k) && !TEX.get(k)?.ok && !TEX.get(k)?.bad);
  S.used = null;
  S.dirtyDraw = true;
}

// ─── disegno ─────────────────────────────────────────────────────────────────────────────────────────────────
const cv = $('#mp-map'), ctx = cv.getContext('2d');
const GROUND = new Map();
async function groundOf(r) {
  if (GROUND.has(r.id)) return GROUND.get(r.id);
  const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  GROUND.set(r.id, c);
  const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const ts = await load(`${S.play}levels/rioni/${r.tileset}`), t = r.t, T = t.tileset;
  if (ts && T.columns) {
    t.suolo.forEach((gid, i) => {
      gid &= 0x1fffffff; if (!gid) return;
      const n = gid - (T.firstgid || 1), sx = (n % T.columns) * T.tilewidth, sy = Math.floor(n / T.columns) * T.tileheight;
      g.drawImage(ts, sx, sy, T.tilewidth, T.tileheight, (i % t.width) * TILE, Math.floor(i / t.width) * TILE, TILE, TILE);
    });
  }
  for (const im of r.immagini || []) { const i = await load(`${S.play}levels/rioni/${im}`); if (i) g.drawImage(i, 0, 0); }
  S.dirtyDraw = true;
  return c;
}

function resize() {
  const b = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(b.width * dpr); cv.height = Math.round(b.height * dpr);
  S.dpr = dpr; S.dirtyDraw = true;
}
const W2S = (x, y) => [x * S.view.s + S.view.tx, y * S.view.s + S.view.ty];
const S2W = (x, y) => [(x - S.view.tx) / S.view.s, (y - S.view.ty) / S.view.s];

function drawImg(d, alpha = 1) {
  const t = TEX.get(d.key);
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rotation); ctx.scale(d.scaleX, d.scaleY);
  ctx.globalAlpha = alpha * (d.alpha ?? 1);
  const x0 = -d.originX * d.width, y0 = -d.originY * d.height;
  if (t?.ok) ctx.drawImage(t.img, 0, 0, Math.min(d.width, t.img.naturalWidth), Math.min(d.height, t.img.naturalHeight), x0, y0, d.width, d.height);
  else { ctx.fillStyle = t?.bad ? 'rgba(200,60,40,.5)' : 'rgba(255,255,255,.15)'; ctx.fillRect(x0, y0, d.width, d.height); }
  ctx.restore();
}

function corners(d) {
  const w = d.width, h = d.height, c = Math.cos(d.rotation), s = Math.sin(d.rotation);
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
    const lx = (u - d.originX) * w * d.scaleX, ly = (v - d.originY) * h * d.scaleY;
    return [d.x + lx * c - ly * s, d.y + lx * s + ly * c];
  });
}
function bboxOf(e) {
  if (!e.main) return { x: e.cur.x - 8, y: e.cur.y - 8, w: 16, h: 16 };
  const pts = e.disp.flatMap(corners);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
const visibleEnt = (e) => S.layers[e.layer] && (!e.cur.removed || S.showRemoved);

function draw() {
  S.dirtyDraw = false;
  const { s, tx, ty } = S.view, dpr = S.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(s * dpr, 0, 0, s * dpr, tx * dpr, ty * dpr);
  ctx.imageSmoothingEnabled = s < 1.5;
  const [vx0, vy0] = S2W(0, 0), [vx1, vy1] = S2W(cv.width / dpr, cv.height / dpr);
  const inView = (b) => b.x + b.w >= vx0 && b.y + b.h >= vy0 && b.x <= vx1 && b.y <= vy1;
  for (const r of S.rioni) {
    if (!inView({ x: r.ox, y: r.oy, w: r.w, h: r.h })) continue;
    ctx.fillStyle = '#3a3a30'; ctx.fillRect(r.ox, r.oy, r.w, r.h);
    if (S.layers.ground) { const g = GROUND.get(r.id); if (g) ctx.drawImage(g, r.ox, r.oy); else groundOf(r); }
    ctx.strokeStyle = 'rgba(239,226,196,.35)'; ctx.lineWidth = 2 / s; ctx.strokeRect(r.ox, r.oy, r.w, r.h);
  }
  // immagini, per profondità come in Phaser (a parità: ordine di creazione)
  const items = [];
  S.ents.forEach((e, i) => { if (!visibleEnt(e) || !e.main) return; e.bb = bboxOf(e); if (!inView(e.bb)) return; for (const d of e.disp) items.push({ d, e, i }); });
  items.sort((a, b) => a.d.depth - b.d.depth || a.i - b.i);
  for (const { d, e } of items) drawImg(d, e.cur.removed ? 0.3 : 1);
  for (const e of S.ents) if (e.cur.removed && visibleEnt(e) && e.bb && inView(e.bb)) { ctx.strokeStyle = '#d04030'; ctx.lineWidth = 1.5 / s; ctx.beginPath(); ctx.moveTo(e.bb.x, e.bb.y); ctx.lineTo(e.bb.x + e.bb.w, e.bb.y + e.bb.h); ctx.moveTo(e.bb.x + e.bb.w, e.bb.y); ctx.lineTo(e.bb.x, e.bb.y + e.bb.h); ctx.stroke(); }
  // segni: persone, nascondigli, luci, luoghi, nomi, partenza
  for (const e of S.ents) if (isMarker(e) && visibleEnt(e)) drawMarker(e, e === S.sel);
  // ritoccati: un puntino d'oro
  for (const e of S.ents) if (dirty(e) && visibleEnt(e) && e !== S.sel) { const b = e.main ? bboxOf(e) : { x: e.cur.x, y: e.cur.y, w: 0, h: 0 }; ctx.fillStyle = '#d9a441'; ctx.beginPath(); ctx.arc(b.x + b.w, b.y, 3 / s, 0, Math.PI * 2); ctx.fill(); }
  if (S.hover && S.hover !== S.sel && visibleEnt(S.hover)) outline(S.hover, 'rgba(255,240,200,.8)', false);
  if (S.sel && S.byId.has(S.sel.id)) outline(S.sel, '#ffd166', true);
  if (S.placing?.at) { const g = S.placing.ghost; if (g) for (const d of g.disp) drawImg(d, 0.6); }
}

function drawMarker(e, sel) {
  const s = S.view.s, c = e.cur, col = LAYERS.find((l) => l[0] === e.layer)?.[2] || '#fff';
  ctx.save();
  ctx.globalAlpha = e.cur.removed ? 0.35 : 1;
  ctx.lineWidth = (sel ? 2.5 : 1.5) / s;
  if (e.list === 'hideouts') { ctx.fillStyle = 'rgba(80,96,112,.25)'; ctx.strokeStyle = col; ctx.setLineDash([4 / s, 3 / s]); ctx.fillRect(c.x, c.y, e.ref.w || 24, e.ref.h || 24); ctx.strokeRect(c.x, c.y, e.ref.w || 24, e.ref.h || 24); ctx.setLineDash([]); }
  else if (e.list === 'lights') { const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, e.ref.radius || 80); g.addColorStop(0, 'rgba(255,220,140,.35)'); g.addColorStop(1, 'rgba(255,220,140,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, e.ref.radius || 80, 0, Math.PI * 2); ctx.fill(); }
  else if (e.list === 'places' || e.list === 'events') { ctx.strokeStyle = col; ctx.fillStyle = 'rgba(48,128,160,.15)'; ctx.beginPath(); ctx.arc(c.x, c.y, e.ref.r || e.ref.radius || 26, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  else if (e.list === 'citizens') {
    const dx = c.x - e.orig.x, dy = c.y - e.orig.y, wp = (e.ref.waypoints || []).map((w) => [w.x + dx, w.y + dy]);
    if (wp.length > 1 && (sel || s > 1.2)) { ctx.strokeStyle = 'rgba(160,80,160,.7)'; ctx.setLineDash([3 / s, 3 / s]); ctx.beginPath(); wp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.setLineDash([]); }
  }
  if (e.list !== 'hideouts') {
    const R = (e.list === 'landmarks' ? 4 : s < 0.4 ? 4 : 7) / s;
    ctx.fillStyle = col; ctx.strokeStyle = sel ? '#ffd166' : '#1a1208';
    ctx.beginPath();
    if (e.list === 'player' || e.list === 'exit') { ctx.moveTo(c.x, c.y - R * 1.4); ctx.lineTo(c.x + R, c.y + R * 0.8); ctx.lineTo(c.x - R, c.y + R * 0.8); ctx.closePath(); }
    else ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  if (sel || (e.list === 'landmarks' && s >= 0.3) || ((e.list === 'citizens' || e.list === 'player' || e.list === 'exit') && s >= 0.6)) {
    const fs = 11 / s; ctx.font = `${e.list === 'landmarks' ? 'italic ' : ''}${fs}px Georgia, serif`; ctx.textAlign = 'center';
    ctx.lineWidth = 3 / s; ctx.strokeStyle = 'rgba(20,14,6,.85)'; ctx.fillStyle = e.list === 'landmarks' ? '#f3e6c8' : '#fff';
    const ty = c.y - 10 / s;
    ctx.strokeText(e.label, c.x, ty); ctx.fillText(e.label, c.x, ty);
  }
  ctx.restore();
}

function outline(e, color, handles) {
  const s = S.view.s;
  ctx.save(); ctx.lineWidth = 1.5 / s; ctx.strokeStyle = color;
  if (!e.main) { ctx.beginPath(); ctx.arc(e.cur.x, e.cur.y, 11 / s, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); return; }
  const p = corners(e.main);
  ctx.setLineDash([4 / s, 3 / s]); ctx.beginPath(); p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  if (handles && canRotate(e) && !e.cur.removed) {
    const h = rotHandle(e), m = e.main.getCenter();
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(h.x, h.y); ctx.stroke();
    ctx.fillStyle = '#ffd166'; ctx.strokeStyle = '#2a1a08'; ctx.beginPath(); ctx.arc(h.x, h.y, 5 / s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function rotHandle(e) {
  const d = e.main, m = d.getCenter(), r = Math.max(d.displayWidth, d.displayHeight) / 2 + 14 / S.view.s, a = d.rotation - Math.PI / 2;
  return { x: m.x + Math.cos(a) * r, y: m.y + Math.sin(a) * r };
}

function frame() {
  if (S.texLoaded) {
    S.texLoaded = false;
    for (const e of S.ents) if (e.wait?.length && e.wait.every((k) => TEX.get(k)?.ok || TEX.get(k)?.bad)) { build(e); if (e === S.sel) renderInspector(); }
    if (S.sel && !$('#mp-insp .thumb img')) renderInspector();
  }
  if (S.dirtyDraw && S.scene) draw();
  requestAnimationFrame(frame);
}

// ─── cosa c'è sotto il puntatore ─────────────────────────────────────────────────────────────────────────────
function hitImg(d, x, y) {
  const c = Math.cos(-d.rotation), s = Math.sin(-d.rotation), dx = x - d.x, dy = y - d.y;
  const lx = (dx * c - dy * s) / (d.scaleX || 1), ly = (dx * s + dy * c) / (d.scaleY || 1);
  return lx >= -d.originX * d.width && lx <= (1 - d.originX) * d.width && ly >= -d.originY * d.height && ly <= (1 - d.originY) * d.height;
}
function pick(x, y) {
  const s = S.view.s, R = 9 / s;
  let best = null;
  // prima i segni (stanno sopra), poi le immagini dall'alto in basso
  for (const e of S.ents) {
    if (!visibleEnt(e) || S.locks[e.layer] || !isMarker(e)) continue;
    if (e.list === 'hideouts') { if (x >= e.cur.x && y >= e.cur.y && x <= e.cur.x + (e.ref.w || 24) && y <= e.cur.y + (e.ref.h || 24)) best = e; continue; }
    if (Math.hypot(x - e.cur.x, y - e.cur.y) <= R) return e;
  }
  if (best) return best;
  const cand = [];
  S.ents.forEach((e, i) => { if (visibleEnt(e) && !S.locks[e.layer] && e.main && hitImg(e.main, x, y)) cand.push({ e, i, d: e.main.depth }); });
  cand.sort((a, b) => b.d - a.d || b.i - a.i);
  // a parità di posto, il più piccolo vince (una finestra sopra un muro grande, un vaso sotto una chioma)
  const top = cand[0];
  if (!top) return null;
  const small = cand.filter((c) => c.d >= -9.5).sort((a, b) => a.e.main.displayWidth * a.e.main.displayHeight - b.e.main.displayWidth * b.e.main.displayHeight)[0];
  return small && small.e.main.displayWidth * small.e.main.displayHeight < (top.e.main.displayWidth * top.e.main.displayHeight) / 3 ? small.e : top.e;
}

// ─── modifiche, annulla e rifai ──────────────────────────────────────────────────────────────────────────────
const same = (a, b) => (a ?? null) === (b ?? null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.05);
function dirty(e) {
  if (e.kind === 'new') return !e.cur.removed;
  const a = e.cur, b = e.orig;
  return !same(a.x, b.x) || !same(a.y, b.y) || !same(a.rotation, b.rotation) || !same(a.removed, b.removed) || !same(typeOf(e), e.kind === 'tmj' ? b.sprite : b.type) || !same(a.size, b.size) || !same(a.scale, b.scale);
}
// un gesto = un passo di annulla. change(e, patch) dentro begin()/commit()
let gesture = null;
function begin() { gesture = new Map(); }
function change(e, patch) {
  if (gesture && !gesture.has(e.id)) gesture.set(e.id, clone(e.cur));
  Object.assign(e.cur, patch);
  if ('x' in patch) e.cur.x = r1(e.cur.x);
  if ('y' in patch) e.cur.y = r1(e.cur.y);
  if ('rotation' in patch) e.cur.rotation = ((Math.round(e.cur.rotation * 10) / 10) % 360 + 360) % 360;
  build(e);
}
function commit() {
  if (!gesture || !gesture.size) { gesture = null; return; }
  const step = [...gesture].map(([id, before]) => ({ id, before, after: clone(S.byId.get(id)?.cur || before) })).filter((x) => JSON.stringify(x.before) !== JSON.stringify(x.after));
  gesture = null;
  if (!step.length) return;
  S.undo.push(step); S.redo = []; if (S.undo.length > 300) S.undo.shift();
  refresh();
}
function quick(e, patch) { begin(); change(e, patch); commit(); }
function undoRedo(from, to, key) {
  const step = from.pop(); if (!step) return;
  for (const x of step) { const e = S.byId.get(x.id); if (!e) continue; e.cur = clone(x[key]); build(e); }
  to.push(step); refresh();
}

// ─── azioni ──────────────────────────────────────────────────────────────────────────────────────────────────
function select(e) { S.sel = e; S.dirtyDraw = true; renderInspector(); }
function nudge(dx, dy) { const e = S.sel; if (!e || e.cur.removed) return; quick(e, { x: e.cur.x + dx, y: e.cur.y + dy }); }
function rotateBy(da) { const e = S.sel; if (!e || !canRotate(e) || e.cur.removed) return; quick(e, { rotation: (e.cur.rotation || 0) + da }); }
function toggleRemove() {
  const e = S.sel; if (!e) return;
  if (e.kind === 'new') { quick(e, { removed: !e.cur.removed }); return; }
  quick(e, { removed: !e.cur.removed });
}
function resetEnt(e) { if (e.kind === 'new') { quick(e, { removed: true }); return; } quick(e, clone(e.orig)); }
// un arredo nuovo del livello (Duplica, Aggiungi): tipo come nei livelli ("bench", "siepe", "rs:sprite_nuovi/...")
function typeForProp(e) {
  if (e.kind !== 'tmj') return { type: e.cur.type, scale: e.cur.scale };
  const k = spriteKey(e.cur.sprite, e.p);
  const T = S.scene.idx.arredi || {}, def = { ...(T._default || {}), ...(T[e.o.type] || {}) };
  const size = e.cur.size ?? def.size;
  const [w, h] = frameOf(S.known.has(k) || !S.A ? k : (S.A.arredoDiretto(k, 0, 0) || {}).key || k);
  const scale = size ? r1((size / Math.max(w, h)) * 1000) / 1000 : null;
  return { type: k?.startsWith('rs:') || S.known.has(k) ? k : (k || e.o.type), scale };
}
function newProp(type, x, y, { rotation = 0, scale = null, label } = {}) {
  const e = addEnt({ kind: 'new', layer: 'props', list: 'props', orig: { x, y, rotation: 0, type, scale: null, removed: true }, cur: { x: r1(x), y: r1(y), rotation, type, scale, removed: false }, label: label || `nuovo: ${String(type).replace(/^rs:sprite_nuovi\//, '')}` });
  S.undo.push([{ id: e.id, before: { ...e.cur, removed: true }, after: clone(e.cur) }]); S.redo = [];
  refresh(); return e;
}
function duplicate() {
  const e = S.sel; if (!e || isMarker(e) || e.list === 'items') return;
  const { type, scale } = typeForProp(e);
  if (!type) return;
  select(newProp(type, e.cur.x + 24, e.cur.y + 24, { rotation: e.cur.rotation || 0, scale, label: `copia di ${e.label}` }));
}

// ─── vista ───────────────────────────────────────────────────────────────────────────────────────────────────
function fitTo(b, pad = 20) {
  const r = cv.getBoundingClientRect();
  const s = Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h);
  S.view = { s, tx: r.width / 2 - (b.x + b.w / 2) * s, ty: r.height / 2 - (b.y + b.h / 2) * s };
  S.dirtyDraw = true; status();
}
function fit() { const r = S.rioni.find((x) => x.id === S.rione); fitTo(r ? { x: r.ox, y: r.oy, w: r.w, h: r.h } : { x: 0, y: 0, w: S.world.w, h: S.world.h }); }
function zoomAt(f, sx, sy) {
  const s = Math.max(0.08, Math.min(12, S.view.s * f)), k = s / S.view.s;
  S.view.tx = sx - (sx - S.view.tx) * k; S.view.ty = sy - (sy - S.view.ty) * k; S.view.s = s;
  S.dirtyDraw = true; status();
}
function status(wx, wy) {
  const r = wx !== undefined ? rioneAt(wx, wy) : null;
  $('#mp-status').textContent = `zoom ${Math.round(S.view.s * 100)}%${r ? ` · ${r.id} (${Math.round(wx - r.ox)}, ${Math.round(wy - r.oy)}) · casella ${Math.floor((wx - r.ox) / TILE)},${Math.floor((wy - r.oy) / TILE)}` : wx !== undefined ? ` · (${Math.round(wx)}, ${Math.round(wy)})` : ''}`;
}

// ─── puntatore ───────────────────────────────────────────────────────────────────────────────────────────────
let drag = null, spaceDown = false;
const ptr = (ev) => { const b = cv.getBoundingClientRect(); return [ev.clientX - b.left, ev.clientY - b.top]; };
cv.addEventListener('pointerdown', (ev) => {
  if (!S.scene) return;
  cv.setPointerCapture(ev.pointerId);
  const [sx, sy] = ptr(ev), [wx, wy] = S2W(sx, sy);
  if (ev.button === 1 || ev.button === 2 || spaceDown) { drag = { mode: 'pan', sx, sy, tx: S.view.tx, ty: S.view.ty }; cv.className = 'grabbing'; return; }
  if (S.placing) { placeAt(wx, wy, ev.altKey); return; }
  const e = S.sel;
  if (e && e.main && canRotate(e) && !e.cur.removed) {
    const h = rotHandle(e);
    if (Math.hypot(wx - h.x, wy - h.y) <= 8 / S.view.s) { begin(); drag = { mode: 'rot', e, c: e.main.getCenter() }; cv.className = 'rot'; return; }
  }
  const hit = pick(wx, wy);
  if (hit) {
    if (hit !== S.sel) select(hit);
    if (!hit.cur.removed) { begin(); drag = { mode: 'move', e: hit, wx, wy, x0: hit.cur.x, y0: hit.cur.y, moved: false }; cv.className = 'move'; }
  } else { if (S.sel) select(null); drag = { mode: 'pan', sx, sy, tx: S.view.tx, ty: S.view.ty, click: true }; cv.className = 'grabbing'; }
});
cv.addEventListener('pointermove', (ev) => {
  const [sx, sy] = ptr(ev), [wx, wy] = S2W(sx, sy);
  status(wx, wy);
  if (S.placing) { S.placing.at = [wx, wy]; ghost(wx, wy); }
  if (!drag) {
    const h = S.scene ? pick(wx, wy) : null;
    if (h !== S.hover) { S.hover = h; S.dirtyDraw = true; }
    const onRot = S.sel?.main && canRotate(S.sel) && (() => { const r = rotHandle(S.sel); return Math.hypot(wx - r.x, wy - r.y) <= 8 / S.view.s; })();
    cv.className = S.placing ? 'place' : spaceDown ? 'grab' : onRot ? 'rot' : h ? 'move' : '';
    tip(h ? `${h.label} · ${KIND_NAME[h.kind === 'tmj' ? h.layer : h.list] || ''}${dirty(h) ? ' · ritoccato' : ''}${h.cur.removed ? ' · tolto' : ''}` : '', sx, sy);
    return;
  }
  tip('', 0, 0);
  if (drag.mode === 'pan') { S.view.tx = drag.tx + sx - drag.sx; S.view.ty = drag.ty + sy - drag.sy; S.dirtyDraw = true; if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.click = false; return; }
  if (drag.mode === 'move') {
    let dx = wx - drag.wx, dy = wy - drag.wy;
    if (!drag.moved && Math.hypot(dx, dy) * S.view.s < 3) return;
    drag.moved = true;
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const st = S.snap; dx = Math.round(dx / st) * st; dy = Math.round(dy / st) * st;
    change(drag.e, { x: drag.x0 + dx, y: drag.y0 + dy });
    tip(`${Math.round(drag.e.cur.x)}, ${Math.round(drag.e.cur.y)}  (Δ ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`, sx, sy);
    return;
  }
  if (drag.mode === 'rot') {
    let a = (Math.atan2(wy - drag.c.y, wx - drag.c.x) * 180) / Math.PI + 90;
    if (!ev.shiftKey) a = Math.round(a / 15) * 15;
    change(drag.e, { rotation: a });
    tip(`${Math.round(drag.e.cur.rotation)}°`, sx, sy);
  }
});
const endDrag = () => { tip('', 0, 0); if (drag && drag.mode !== 'pan') commit(); else if (drag?.click && S.sel) select(null); drag = null; cv.className = ''; renderInspector(); };
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
cv.addEventListener('wheel', (ev) => { ev.preventDefault(); const [sx, sy] = ptr(ev); zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), sx, sy); }, { passive: false });
cv.addEventListener('pointerleave', () => { tip('', 0, 0); if (S.hover) { S.hover = null; S.dirtyDraw = true; } });
cv.addEventListener('dblclick', (ev) => { const [sx, sy] = ptr(ev), [wx, wy] = S2W(sx, sy); const h = pick(wx, wy); if (h) { const b = bboxOf(h); fitTo({ x: b.x - 60, y: b.y - 60, w: b.w + 120, h: b.h + 120 }); } });
function tip(t, x, y) { const el = $('#mp-tip'); if (!t) { el.style.display = 'none'; return; } el.textContent = t; el.style.display = 'block'; el.style.left = `${x + 14}px`; el.style.top = `${y + 12}px`; }

window.addEventListener('keydown', (ev) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || $('#mp-picker').open) return;
  const k = ev.key, mod = ev.metaKey || ev.ctrlKey;
  if (k === ' ') { spaceDown = true; cv.className = 'grab'; ev.preventDefault(); return; }
  if (mod && k.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) undoRedo(S.redo, S.undo, 'after'); else undoRedo(S.undo, S.redo, 'before'); return; }
  if (mod && k.toLowerCase() === 'y') { ev.preventDefault(); undoRedo(S.redo, S.undo, 'after'); return; }
  if (mod && k.toLowerCase() === 's') { ev.preventDefault(); save(); return; }
  if (mod) return;
  const step = ev.shiftKey ? 8 : 1;
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (map[k] && S.sel) { ev.preventDefault(); nudge(...map[k]); return; }
  if (k === 'Escape') { if (S.placing) stopPlacing(); else select(null); return; }
  if (k === 'r' || k === 'R') { rotateBy(ev.shiftKey ? -90 : 90); return; }
  if (k === '[') { rotateBy(-15); return; }
  if (k === ']') { rotateBy(15); return; }
  if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); toggleRemove(); return; }
  if (k === 'd' || k === 'D') { duplicate(); return; }
  if ((k === 's' || k === 'S') && S.sel && canSprite(S.sel)) { openPicker('sprite'); return; }
  if (k === 'a' || k === 'A') { openPicker('add'); return; }
  if (k === '+' || k === '=') { const r = cv.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); return; }
  if (k === '-') { const r = cv.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); return; }
  if (k === '0') fit();
});
window.addEventListener('keyup', (ev) => { if (ev.key === ' ') { spaceDown = false; cv.className = ''; } });

// ─── mettere un arredo nuovo ─────────────────────────────────────────────────────────────────────────────────
function startPlacing(type, label, scale = null) {
  S.placing = { type, label, scale, ghost: null };
  banner(`Clicca sulla mappa dove mettere «${label}» (Esc per smettere; con Alt ne metti un altro).`);
}
function stopPlacing() { S.placing = null; cv.className = ''; S.dirtyDraw = true; banner(''); }
function ghost(x, y) {
  const p = S.placing, st = S.snap;
  x = Math.round(x / st) * st; y = Math.round(y / st) * st;
  const g = p.ghost || (p.ghost = { kind: 'new', list: 'props', layer: 'props', cur: { x, y, rotation: 0, type: p.type, scale: p.scale }, disp: [] });
  g.cur.x = x; g.cur.y = y; build(g);
}
function placeAt(x, y, keep) {
  const p = S.placing, st = S.snap;
  const e = newProp(p.type, Math.round(x / st) * st, Math.round(y / st) * st, { scale: p.scale, label: p.label });
  if (!keep) stopPlacing();
  select(e);
}

// ─── catalogo delle sprite ───────────────────────────────────────────────────────────────────────────────────
let pickMode = 'sprite', pickTab = 'borgo';
function catalog() {
  const sc = S.scene, out = { borgo: [], rioni: [], gioco: [], nuove: [] };
  for (const [key, m] of S.man) {
    if (!m.entry) continue;
    const name = key.replace(/^borgo\./, '');
    out.borgo.push({ tab: 'borgo', id: key, name, group: m.entry.category || 'altro', desc: m.entry.description || '', url: `${S.play}${m.entry.file}`, frames: m.entry.frames?.count || 1 });
  }
  for (const f of sc.spritesNuovi) out.rioni.push({ tab: 'rioni', id: f, name: f.replace(/^sprite_nuovi\//, '').replace(/\.png$/, ''), group: f.split('/').slice(1, -1).join('/') || 'sprite_nuovi', url: `${S.play}levels/rioni/${f}` });
  for (const k of sc.gameKeys) out.gioco.push({ tab: 'gioco', id: k, name: k, group: 'assets/props', url: `${S.play}assets/props/${k}.png` });
  for (const [p, url] of S.pendingUrl) out.nuove.push({ tab: 'nuove', id: p, name: p.split('/').pop().replace(/\.png$/, ''), group: 'da salvare (di Cosetta o caricate da te)', url });
  return out;
}
function openPicker(mode) {
  pickMode = mode;
  $('#pk-title').textContent = mode === 'add' ? 'Metti un arredo nuovo' : `Nuova grafica per «${S.sel?.label || ''}»`;
  $('#pk-hint').textContent = mode === 'add' ? 'Scegli, poi clicca sulla mappa dove metterlo.' : 'La grandezza resta quella di adesso (la cambi dalla scheda).';
  renderPicker(); $('#mp-picker').showModal(); $('#pk-q').focus();
}
function renderPicker() {
  const q = $('#pk-q').value.trim().toLowerCase(), all = catalog()[pickTab] || [];
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === pickTab);
  const list = all.filter((x) => !q || `${x.name} ${x.group} ${x.desc || ''}`.toLowerCase().includes(q));
  const groups = new Map(); for (const x of list) (groups.get(x.group) || groups.set(x.group, []).get(x.group)).push(x);
  $('#pk-grid').innerHTML = list.length ? [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([g, xs]) => `<h4>${esc(g)} <span class="muted">(${xs.length})</span></h4>${xs.map((x) => `<div class="pk-it" data-pk="${esc(x.tab)}|${esc(x.id)}" title="${esc(x.desc || x.name)}"><div class="im">${x.frames > 1 ? `<div class="strip" style="background-image:url('${esc(x.url)}');background-size:${x.frames * 100}% 100%"></div>` : `<img loading="lazy" src="${esc(x.url)}" alt="">`}</div>${esc(x.name)}</div>`).join('')}`).join('')
    : `<p class="muted">${pickTab === 'nuove' ? 'Nessuna sprite nuova: chiedila a Cosetta dalla scheda di un oggetto, o caricane una.' : 'Niente con questo nome.'}</p>`;
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { pickTab = b.dataset.tab; renderPicker(); }));
$('#pk-q').addEventListener('input', renderPicker);
$('#pk-close').addEventListener('click', () => $('#mp-picker').close());
$('#pk-grid').addEventListener('click', (ev) => {
  const it = ev.target.closest('[data-pk]'); if (!it) return;
  const [tab, ...rest] = it.dataset.pk.split('|'), id = rest.join('|');
  $('#mp-picker').close();
  applyChoice(tab, id);
});
// la scelta del catalogo diventa il valore giusto per quel tipo di oggetto (vedi Rioni.spriteKey / GameScene)
function applyChoice(tab, id) {
  const meta = tab === 'nuove' ? S.pendingMeta.get(id) : null;
  const name = id.replace(/^borgo\./, '');
  if (pickMode === 'add') {
    const type = tab === 'borgo' ? name : tab === 'gioco' ? id : `rs:${id}`;
    startPlacing(type, name.split('/').pop().replace(/\.png$/, ''), meta && meta.density > 1 ? 1 / meta.density : null);
    return;
  }
  const e = S.sel; if (!e) return;
  if (e.kind === 'tmj') {
    // dal set di arredi: per nome se il gioco dà proprio quello (arredo sparso), altrimenti la chiave esatta
    // ("borgo.x": fuori dalla serie del rione) con la grandezza di adesso
    let sprite = tab === 'gioco' ? `gioco:${id}` : `../${id}`;
    if (tab === 'borgo') { const x = S.A?.arredoDiretto(name, e.cur.x, e.cur.y, e.rione.id); sprite = x && x.key === id ? `gioco:${name}` : `gioco:${id}`; }
    const patch = { sprite };
    if (meta && e.layer === 'arredi') patch.size = Math.round(Math.max(meta.w, meta.h) / meta.density);
    else if (e.cur.size == null && e.layer === 'arredi' && e.main) patch.size = Math.round(Math.max(e.main.displayWidth, e.main.displayHeight));   // stessa grandezza di adesso
    quick(e, patch);
  } else if (e.list === 'targets') {
    // un bersaglio usa il tipo come texture: per il set di arredi la chiave con "borgo." e la scala della densità
    if (tab === 'borgo') { const m = S.man.get(id); quick(e, { type: id, scale: m ? 1 / m.density : null }); }
    else quick(e, { type: tab === 'gioco' ? id : `rs:${id}`, scale: meta ? (meta.density > 1 ? 1 / meta.density : null) : (APERTURA.test(id) ? null : e.cur.scale) });
  } else {
    if (tab === 'borgo' && e.list === 'items') quick(e, { type: id });
    else if (tab === 'borgo') quick(e, { type: name, scale: e.cur.type?.startsWith('borgo.') ? null : e.cur.scale });
    else if (e.list === 'items') quick(e, { type: tab === 'gioco' ? id : `rs:${id}` });
    else quick(e, { type: tab === 'gioco' ? id : `rs:${id}`, scale: meta ? (meta.density > 1 ? 1 / meta.density : null) : e.cur.scale });
  }
  renderInspector();
}

// ─── scheda dell'oggetto scelto ──────────────────────────────────────────────────────────────────────────────
const THUMB = new Map();   // primo fotogramma, per la scheda
function thumbOf(e) {
  const d = e?.main; if (!d) return '';
  const t = TEX.get(d.key); if (!t?.ok) return '';
  let u = THUMB.get(d.key);
  if (!u) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(d.width)); c.height = Math.max(1, Math.round(d.height));
    c.getContext('2d').drawImage(t.img, 0, 0, d.width, d.height, 0, 0, d.width, d.height);
    try { u = c.toDataURL(); } catch { u = t.img.src; }
    THUMB.set(d.key, u);
  }
  return `<img src="${u}" alt="">`;
}
function renderInspectorCore() {
  const box = $('#mp-insp'), e = S.sel;
  if (!e) {
    const n = S.ents.filter(dirty).length;
    box.innerHTML = `<h3>Scheda</h3><p class="muted">Clicca un oggetto sulla mappa per vederne la scheda: posto, verso, grandezza e grafica. ${n ? `Hai ${n} ritocchi non ancora salvati.` : ''}</p>
      <p class="muted">Doppio clic su un oggetto per avvicinarti. Gli strati col lucchetto non si prendono col mouse.</p>`;
    return;
  }
  const c = e.cur, r = rioneAt(c.x, c.y), kn = KIND_NAME[e.kind === 'tmj' ? e.layer : e.list] || e.list || 'arredo nuovo';
  const spr = typeOf(e);
  const sizeRow = canSize(e) ? (e.kind === 'tmj'
    ? `<div class="row"><span>Grandezza</span><div class="pair"><input type="number" min="4" max="400" step="1" data-f="size" value="${c.size ?? ''}" placeholder="${e.main ? Math.round(Math.max(e.main.displayWidth, e.main.displayHeight)) : ''}" title="Lato lungo in px di mondo (vuoto: quella del catalogo)"><span class="btns"><button class="btn sm" data-sz="0.9">−</button><button class="btn sm" data-sz="1.1">＋</button></span></div></div>`
    : `<div class="row"><span>Scala</span><div class="pair"><input type="number" min="0.05" max="8" step="0.05" data-f="scale" value="${c.scale ?? ''}" placeholder="1"><span class="btns"><button class="btn sm" data-sz="0.9">−</button><button class="btn sm" data-sz="1.1">＋</button></span></div></div>`) : '';
  box.innerHTML = `<h3>Scheda</h3>
    <div class="insp-h"><div class="thumb">${thumbOf(e)}</div><div><b>${esc(e.label)}</b><span class="muted">${esc(kn)}${e.kind === 'tmj' ? ` · ${esc(e.key)}` : e.ref?.id ? ` · ${esc(e.ref.id)}` : ''}${r ? ` · rione ${esc(r.id)}` : ''}</span>${c.removed ? '<div style="color:var(--red)">tolto dalla mappa</div>' : ''}</div></div>
    <div class="row"><span>Posto</span><div class="pair"><input type="number" step="1" data-f="x" value="${c.x}" title="x nel mondo"><input type="number" step="1" data-f="y" value="${c.y}" title="y nel mondo"></div></div>
    ${r ? `<div class="row"><span></span><span class="code">nel rione: ${Math.round(c.x - r.ox)}, ${Math.round(c.y - r.oy)} · casella ${Math.floor((c.x - r.ox) / TILE)}, ${Math.floor((c.y - r.oy) / TILE)}</span></div>` : ''}
    ${canRotate(e) ? `<div class="row"><span>Verso</span><div class="pair"><input type="number" step="1" data-f="rotation" value="${c.rotation || 0}"><span class="btns"><button class="btn sm" data-rot="-90" title="Maiusc R">⟲ 90</button><button class="btn sm" data-rot="90" title="R">⟳ 90</button></span></div></div>` : ''}
    ${sizeRow}
    ${canSprite(e) ? `<div class="row"><span>Grafica</span><div><div class="code">${esc(spr || '—')}</div><button class="btn sm" data-act="sprite" style="margin-top:3px">Cambia sprite… (S)</button></div></div>` : ''}
    ${serieNote(e)}
    <div class="acts">
      ${!isMarker(e) && e.list !== 'items' ? '<button class="btn sm" data-act="dup" title="D">Duplica</button>' : ''}
      <button class="btn sm" data-act="rm" title="Canc">${c.removed ? 'Rimetti' : 'Togli'}</button>
      ${dirty(e) && e.kind !== 'new' ? '<button class="btn sm" data-act="reset">Com\'era</button>' : ''}
      <button class="btn sm" data-act="zoom">Avvicina</button>
    </div>
    ${canSprite(e) && !c.removed ? cosettaHTML(e) : ''}`;
}
$('#mp-insp').addEventListener('change', (ev) => {
  const f = ev.target.dataset.f, e = S.sel; if (!f || !e) return;
  const v = ev.target.value === '' ? null : Number(ev.target.value);
  if (v !== null && !Number.isFinite(v)) return;
  quick(e, { [f]: f === 'x' || f === 'y' || f === 'rotation' ? v ?? 0 : v });
  renderInspector();
});
$('#mp-insp').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const e = S.sel; if (!e) return;
  if (b.dataset.rot) { rotateBy(Number(b.dataset.rot)); renderInspector(); return; }
  if (b.dataset.sz) {
    const k = Number(b.dataset.sz);
    if (e.kind === 'tmj') { const cur = e.cur.size ?? (e.main ? Math.max(e.main.displayWidth, e.main.displayHeight) : 24); quick(e, { size: Math.max(4, Math.round(cur * k)) }); }
    else quick(e, { scale: Math.round((e.cur.scale ?? 1) * k * 100) / 100 });
    renderInspector(); return;
  }
  const a = b.dataset.act;
  if (a === 'sprite') openPicker('sprite');
  else if (a === 'dup') duplicate();
  else if (a === 'rm') { toggleRemove(); renderInspector(); }
  else if (a === 'reset') { resetEnt(e); renderInspector(); }
  else if (a === 'zoom') { const bb = bboxOf(e); fitTo({ x: bb.x - 80, y: bb.y - 80, w: bb.w + 160, h: bb.h + 160 }); }
  else if (a === 'cosetta') askCosetta();
  else if (a === 'exact') { const m = S.man.get(b.dataset.key); quick(e, { type: b.dataset.key, scale: m ? Math.round((e.cur.scale ?? 1) / m.density * 10000) / 10000 : null }); renderInspector(); }
  else if (a === 'upload') $('#cz-file')?.click();
  else if (a === 'use') useProof();
  else if (a === 'drop') { S.proof = null; renderInspector(); }
});

// arredi in serie (panchine, lampioni, vasi, siepi, alberi…): il gioco usa UN modello per rione (regola delle varianti,
// src/systems/Arredi.js), quindi un modello scelto a mano può non vedersi. Lo si dice, invece di far finta di niente.
function serieNote(e) {
  if (e.kind === 'tmj') return '';
  const v = typeOf(e) || '', name = v.replace(/^gioco:/, '');
  const want = S.man.has(`borgo.${name}`) ? `borgo.${name}` : null;
  if (!want || !e.main || e.main.key === want) return '';
  return `<div class="bubble" style="margin-top:6px;font-size:12px"><b>Mappo:</b> questo arredo fa serie: nel gioco ${esc(rioneAt(e.cur.x, e.cur.y)?.id ? `in tutto il rione ${rioneAt(e.cur.x, e.cur.y).id}` : 'in tutta la mappa')} ha lo stesso modello, quindi qui resta «${esc(e.main.key.replace(/^borgo\./, ''))}». <button class="btn sm" data-act="exact" data-key="${esc(want)}">Usa proprio «${esc(name)}»</button> (fuori serie) · per cambiare tutta la serie chiedilo allo Studio in chat.</div>`;
}

// ─── Cosetta disegna ─────────────────────────────────────────────────────────────────────────────────────────
let cosetta = null;   // { artist, options, default }
function cosettaHTML(e) {
  const opts = cosetta?.options || [];
  const p = S.proof && S.proof.for === e.id ? S.proof : null;
  return `<div class="cosetta"><div class="who"><canvas id="cz-face" width="36" height="36"></canvas>${esc(cosetta?.artist || 'Cosetta')} ti disegna una sprite nuova</div>
    <textarea id="cz-text" placeholder="Es.: una panchina di pietra con lo schienale, un vaso di gerani rossi, un'Ape Piaggio celeste…">${esc(S.czText || '')}</textarea>
    ${opts.length ? `<div style="display:flex;gap:4px;align-items:center;margin-top:4px"><select id="cz-opt">${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === (S.czOpt || cosetta.default) ? 'selected' : ''}>${esc(o.label)} · ≈ $${Number(o.price || 0).toFixed(2)}</option>`).join('')}</select><button class="btn sm primary" data-act="cosetta" ${S.czBusy ? 'disabled' : ''}>${S.czBusy ? 'Disegna…' : 'Chiedi'}</button></div>`
      : '<p class="muted" style="margin:4px 0">Per farla disegnare serve una chiave OPENAI_API_KEY o GEMINI_API_KEY nel file .env dello Studio.</p>'}
    <div style="margin-top:4px"><button class="btn sm" data-act="upload">Carica un tuo PNG…</button><input type="file" id="cz-file" accept="image/png,image/webp,image/jpeg" hidden></div>
    ${p ? `<div class="proof"><div class="chk"><img src="${p.url}" alt=""></div><div><div class="muted" style="font-size:11.5px">${p.w}×${p.h} px${p.density > 1 ? ` (×${p.density} di dettaglio)` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div><div class="acts"><button class="btn sm primary" data-act="use">Usa questa</button><button class="btn sm" data-act="drop">Scarta</button></div></div></div>` : ''}
  </div>`;
}
function paintFaces() {
  for (const [sel, agent] of [['#mp-face', S.agents?.level], ['#cz-face', S.agents?.art]]) {
    const c = $(sel); if (!c || !agent?.avatar?.character) continue;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, 36, 36);
    g.drawImage(buildPortrait(normalizeLook(agent.avatar.character, agent.avatar.color)), 0, 0);
  }
}
// la scheda e, dopo, le facce e il file da caricare
function renderInspector() { renderInspectorCore(); afterInspector(); }
function afterInspector() {
  paintFaces();
  const t = $('#cz-text'); if (t) t.addEventListener('input', () => { S.czText = t.value; });
  const o = $('#cz-opt'); if (o) o.addEventListener('change', () => { S.czOpt = o.value; });
  const f = $('#cz-file'); if (f) f.addEventListener('change', async () => { const file = f.files?.[0]; if (!file) return; const url = URL.createObjectURL(file); await makeProof(url, { chroma: false, note: file.name }); });
}

async function askCosetta() {
  const e = S.sel; if (!e || S.czBusy) return;
  const text = ($('#cz-text')?.value || '').trim();
  if (!text) { banner('Scrivi a Cosetta cosa disegnare.', true); return; }
  const opt = cosetta.options.find((o) => o.id === ($('#cz-opt')?.value || cosetta.default));
  if (opt?.price && !confirm(`${cosetta.artist} disegna con ${opt.label}: costa circa $${opt.price.toFixed(2)} (a consumo, non nell'abbonamento). Procedo?`)) return;
  const d = e.main, w = d ? Math.round(d.displayWidth) : 24, h = d ? Math.round(d.displayHeight) : 24;
  const ref = refPathOf(e);
  S.czBusy = true; renderInspector();
  try {
    const r = await api('/api/mappo/cosetta', { text, ref, w, h, choice: opt?.id, label: e.label });
    await makeProof(r.url, { chroma: r.chroma, note: `${r.provider}` });
  } catch (err) { banner(err.message, true); }
  S.czBusy = false; renderInspector();
}
// il file della sprite di adesso (riferimento di stile per Cosetta), percorso dentro il gioco
function refPathOf(e) {
  const k = e.main?.key; if (!k) return null;
  if (k.startsWith('rs:')) return S.pendingUrl.has(k.slice(3)) ? null : `levels/rioni/${k.slice(3)}`;
  const m = S.man.get(k); if (m) return m.entry?.file || m.file;
  return `assets/props/${k}.png`;
}
// pulisce l'immagine (fondo magenta via, bordi vuoti tagliati) e la porta a 4 pixel per pixel di mondo
async function makeProof(url, { chroma, note }) {
  const e = S.sel; if (!e) return;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('immagine non leggibile')); i.src = url; });
  const c0 = document.createElement('canvas'); c0.width = img.naturalWidth; c0.height = img.naturalHeight;
  const g0 = c0.getContext('2d', { willReadFrequently: true }); g0.drawImage(img, 0, 0);
  const data = g0.getImageData(0, 0, c0.width, c0.height), px = data.data;
  // fondo da togliere: il colore dei quattro angoli se è uno solo e pieno (magenta di Cosetta, bianco, verde…)
  const W0 = c0.width, H0 = c0.height, at = (x, y) => (y * W0 + x) * 4;
  const cs = [[0, 0], [W0 - 1, 0], [0, H0 - 1], [W0 - 1, H0 - 1]].map(([x, y]) => [...px.slice(at(x, y), at(x, y) + 4)]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let key = cs.every((c) => c[3] > 250) && cs.every((c) => dist(c, cs[0]) < 40) ? [0, 1, 2].map((k) => cs.reduce((s, c) => s + c[k], 0) / 4) : null;
  if (!key && chroma) key = [255, 0, 255];
  if (key) for (let i = 0; i < px.length; i += 4) {
    const d = dist([px[i], px[i + 1], px[i + 2]], key);
    if (d < 70) px[i + 3] = 0;
    else if (d < 120) px[i + 3] = Math.round(px[i + 3] * (d - 70) / 50);
  }
  g0.putImageData(data, 0, 0);
  let x0 = c0.width, y0 = c0.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c0.height; y++) for (let x = 0; x < c0.width; x++) if (px[(y * c0.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (x1 < x0) { banner('L\'immagine è vuota (tutta trasparente).', true); return; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const dens = canSize(e) ? 4 : 1;   // dove il gioco sa scalarla (grandezza/scala) si tiene più fitta: 4 pixel per pixel di mondo
  const d = e.main, W = Math.max(4, Math.round((d ? d.displayWidth : 24) * dens)), H = Math.max(4, Math.round((d ? d.displayHeight : 24) * dens));
  // ruotato di 90°? la grafica si disegna dritta: si confronta col lato giusto
  const k = Math.min(W / bw, H / bh);
  let cw = bw, ch = bh, src = c0, sx = x0, sy = y0;
  const tw = bw * k;
  while (cw / 2 >= tw && cw > 2) {   // dimezza a passi finché resta più grande della meta: niente scalini
    const t = document.createElement('canvas'); t.width = Math.ceil(cw / 2); t.height = Math.ceil(ch / 2);
    const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(src, sx, sy, cw, ch, 0, 0, t.width, t.height);
    src = t; sx = 0; sy = 0; cw = t.width; ch = t.height;
  }
  const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(bw * k)); out.height = Math.max(1, Math.round(bh * k));
  const og = out.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(src, sx, sy, cw, ch, 0, 0, out.width, out.height);
  S.proof = { for: e.id, url: out.toDataURL('image/png'), w: out.width, h: out.height, density: dens, note };
  renderInspector();
}
async function useProof() {
  const e = S.sel, p = S.proof; if (!e || !p) return;
  const base = String(e.label || 'sprite').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'sprite';
  try {
    const r = await api('/api/mappo/sprite', { name: base, dataUrl: p.url });
    S.pendingUrl.set(r.path, r.url); S.pendingMeta.set(r.path, { w: p.w, h: p.h, density: p.density });
    S.known.add(`rs:${r.path}`);
    S.proof = null;
    pickMode = 'sprite'; applyChoice('nuove', r.path);
    banner(`Sprite nuova messa a «${e.label}». Entra nel gioco quando salvi.`);
  } catch (err) { banner(err.message, true); }
}

// ─── elenco dei ritocchi e salvataggio ───────────────────────────────────────────────────────────────────────
function whatChanged(e) {
  if (e.kind === 'new') return 'arredo nuovo';
  const a = e.cur, b = e.orig, out = [];
  if (a.removed && !b.removed) return 'tolto'; if (!a.removed && b.removed) out.push('rimesso');
  if (!same(a.x, b.x) || !same(a.y, b.y)) out.push(`spostato (${a.x - b.x >= 0 ? '+' : ''}${r1(a.x - b.x)}, ${a.y - b.y >= 0 ? '+' : ''}${r1(a.y - b.y)})`);
  if (!same(a.rotation, b.rotation)) out.push(`girato a ${a.rotation}°`);
  if (!same(typeOf(e), e.kind === 'tmj' ? b.sprite : b.type)) out.push('grafica nuova');
  if (!same(a.size, b.size) || !same(a.scale, b.scale)) out.push('grandezza');
  return out.join(', ');
}
function refresh() {
  const list = S.ents.filter(dirty);
  $('#mp-nchg').textContent = list.length ? `(${list.length})` : '';
  $('#mp-changes').innerHTML = list.length ? list.slice(-200).reverse().map((e) => `<div class="chg" data-id="${e.id}"><div><b>${esc(e.label)}</b><div class="what">${esc(whatChanged(e))}</div></div><button class="btn sm" data-undo="${e.id}" title="Rimetti com'era">↺</button></div>`).join('') : '<p class="muted">Nessun ritocco. Trascina un oggetto sulla mappa per cominciare.</p>';
  $('#mp-save').disabled = !list.length;
  $('#mp-save-hint').textContent = S.scene?.draft ? `Si aggiunge alla bozza ${S.scene.draft.id} (non ancora unita).` : 'Diventa una versione nuova da provare: niente cambia nel gioco finché non la unisci.';
  S.dirtyDraw = true;
  if (S.sel) renderInspector();
}
$('#mp-changes').addEventListener('click', (ev) => {
  const u = ev.target.closest('[data-undo]'); if (u) { const e = S.byId.get(u.dataset.undo); if (e) resetEnt(e); return; }
  const row = ev.target.closest('[data-id]'); if (!row) return;
  const e = S.byId.get(row.dataset.id); if (!e) return;
  select(e); const b = bboxOf(e); fitTo({ x: b.x - 120, y: b.y - 120, w: b.w + 240, h: b.h + 240 });
});
function payload() {
  const out = { tmj: {}, level: [], add: [] }, sprites = new Set();
  for (const e of S.ents.filter(dirty)) {
    const c = e.cur, ty = typeOf(e) || '';
    const pend = ty.replace(/^rs:/, '').replace(/^\.\.\//, '');
    if (S.pendingUrl.has(pend)) sprites.add(pend.split('/').pop());
    if (e.kind === 'tmj') {
      const v = { label: e.label, dx: r1(c.x - e.base.x), dy: r1(c.y - e.base.y) };
      if (c.removed) v.rimuovi = true;
      if (!same(c.rotation, e.p.rotation ?? 0) || e.corr0.rotation !== undefined) v.rotation = c.rotation;
      if (c.sprite !== e.p.sprite) v.sprite = c.sprite;
      if (c.size != null && !same(c.size, e.p.size)) v.size = c.size;
      out.tmj[e.key] = v;
    } else if (e.kind === 'new') {
      out.add.push({ label: e.label, voce: { type: c.type, x: c.x, y: c.y, rotation: c.rotation || 0, scale: c.scale ?? undefined } });
    } else {
      const b = e.orig, a = {};
      if (!c.removed) {
        if (!same(c.x, b.x) || !same(c.y, b.y)) { a.x = c.x; a.y = c.y; }
        if (!same(c.rotation, b.rotation)) a.rotation = c.rotation;
        if (!same(c.type, b.type)) a.type = c.type;
        if (!same(c.scale, b.scale)) a.scale = c.scale;
      }
      out.level.push({ lista: e.list, label: e.label, ...(e.ref?.id != null && ['targets', 'citizens', 'hideouts', 'events', 'places'].includes(e.list) ? { id: e.ref.id } : e.list === 'landmarks' && e.ref.nameId ? { id: e.ref.nameId } : {}), ...(b.type ? { tipo: b.type } : {}), da: [b.x, b.y], a: c.removed ? null : a });
    }
  }
  return { edits: out, sprites: [...sprites] };
}
async function save() {
  const n = S.ents.filter(dirty).length; if (!n || S.saving) return;
  S.saving = true; $('#mp-save').disabled = true; $('#mp-save').textContent = 'Mappo salva…';
  try {
    const { edits, sprites } = payload();
    const r = await api('/api/mappo/save', { src: S.src, edits, sprites, note: $('#mp-note').value.trim() });
    $('#mp-note').value = '';
    banner(`Salvato in ${r.request.id}: provalo con «▶ Prova» (Livello 3); se va bene, uniscilo dallo Studio. ${r.notes?.length ? r.notes.join(' · ') : ''}`);
    await load(r.request.id, { keepView: true });
  } catch (err) { banner(`Non salvato: ${err.message}`, true); }
  S.saving = false; $('#mp-save').textContent = 'Salva come versione da provare'; refresh();
}
$('#mp-save').addEventListener('click', save);
window.addEventListener('beforeunload', (ev) => { if (S.ents.some(dirty)) { ev.preventDefault(); ev.returnValue = ''; } });

// ─── avvisi ──────────────────────────────────────────────────────────────────────────────────────────────────
let bannerT = null;
function banner(text, err = false) {
  let el = $('.mp-banner');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); $('#mp-stage').append(el); }
  el.className = `mp-banner${err ? ' err' : ''}`; el.textContent = text;
  clearTimeout(bannerT); bannerT = setTimeout(() => el.remove(), err ? 12000 : 9000);
}

// ─── strati, rioni, fonte ────────────────────────────────────────────────────────────────────────────────────
function renderLayers() {
  const count = (id) => S.ents.filter((e) => e.layer === id && !e.cur.removed).length;
  $('#mp-layers').innerHTML = LAYERS.map(([id, name, col]) => `<label class="layer"><input type="checkbox" data-layer="${id}" ${S.layers[id] ? 'checked' : ''}><span><i class="sw" style="background:${col}"></i>${esc(name)}</span><span class="n">${id === 'ground' ? '' : count(id)}</span><button class="lock ${S.locks[id] ? 'on' : ''}" data-lock="${id}" title="${S.locks[id] ? 'Bloccato: non si prende col mouse' : 'Si prende col mouse (clic per bloccare)'}">🔒</button></label>`).join('');
}
$('#mp-layers').addEventListener('change', (ev) => { const id = ev.target.dataset.layer; if (!id) return; S.layers[id] = ev.target.checked; try { localStorage.setItem('mappo:layers', JSON.stringify(S.layers)); } catch { /* */ } S.dirtyDraw = true; });
$('#mp-layers').addEventListener('click', (ev) => { const b = ev.target.closest('[data-lock]'); if (!b) return; ev.preventDefault(); S.locks[b.dataset.lock] = !S.locks[b.dataset.lock]; renderLayers(); });
$('#mp-removed').addEventListener('change', (ev) => { S.showRemoved = ev.target.checked; S.dirtyDraw = true; });
$('#mp-snap').value = String(S.snap);
$('#mp-snap').addEventListener('change', (ev) => { S.snap = Number(ev.target.value) || 1; try { localStorage.setItem('mappo:snap', String(S.snap)); } catch { /* */ } });
$('#mp-add').addEventListener('click', () => openPicker('add'));
document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => { const r = cv.getBoundingClientRect(); if (b.dataset.zoom === 'fit') fit(); else zoomAt(b.dataset.zoom === 'in' ? 1.25 : 0.8, r.width / 2, r.height / 2); }));
function renderRioni() {
  $('#mp-rioni').innerHTML = [['', 'Tutto il paese'], ...S.rioni.map((r) => [r.id, r.id[0].toUpperCase() + r.id.slice(1)])].map(([id, n]) => `<button class="btn sm ${S.rione === (id || null) ? 'on' : ''}" data-rione="${id}">${esc(n)}</button>`).join('');
}
$('#mp-rioni').addEventListener('click', (ev) => { const b = ev.target.closest('[data-rione]'); if (!b) return; S.rione = b.dataset.rione || null; try { localStorage.setItem('mappo:rione', S.rione || ''); } catch { /* */ } renderRioni(); fit(); });
function renderSrc() {
  const sc = S.scene;
  $('#mp-src').innerHTML = `<option value="main">il gioco com'è adesso</option>${sc.drafts.map((d) => `<option value="${esc(d.id)}">bozza ${esc(d.id)} — ${esc(String(d.text).replace(/^Mappo — /, '').slice(0, 40))}${d.queued ? ' (in unione)' : ''}</option>`).join('')}`;
  $('#mp-src').value = sc.src;
  $('#mp-play').href = sc.play;
}
$('#mp-src').addEventListener('change', async (ev) => {
  if (S.ents.some(dirty) && !confirm('Hai ritocchi non salvati: se cambi versione li perdi. Continuo?')) { ev.target.value = S.src; return; }
  await load(ev.target.value, { keepView: true });
});

// ─── avvio ───────────────────────────────────────────────────────────────────────────────────────────────────
async function load(src, { keepView = false } = {}) {
  $('#mp-loading').style.display = 'grid';
  const sc = await api(`/api/mappo/scene?src=${encodeURIComponent(src)}`);
  const samePlay = S.scene && S.play === sc.play;
  S.scene = sc; S.src = sc.src; S.play = sc.play;
  if (!samePlay) { TEX.clear(); GROUND.clear(); S.man = new Map(); S.known = new Set(); }
  S.known = new Set([...sc.idx.sprites.map((p) => `rs:${p}`), ...sc.gameKeys]);
  for (const f of sc.pending || []) { const p = `sprite_nuovi/mappo/${f}`; if (!S.pendingUrl.has(p)) S.pendingUrl.set(p, `/mappo-pending/${f}`); }
  for (const p of S.pendingUrl.keys()) S.known.add(`rs:${p}`);
  await loadArredi();
  // le grandezze delle immagini servono prima di costruire (le regole del gioco scalano su di esse)
  const keys = new Set();
  for (const r of sc.idx.rioni) for (const layer of sc.layers) for (const o of sc.tmj[r.id].objects[layer] || []) { const p = propsOf(o); const k = spriteKey(p.sprite, p); if (k) keys.add(k); }
  for (const l of ['targets', 'props', 'items']) for (const d of sc.level[l] || []) if (d.type) keys.add(d.type);
  for (const k of Object.keys(sc.idx.correzioni || {})) { const s = sc.idx.correzioni[k]?.sprite; if (s) keys.add(spriteKey(s)); }
  await Promise.all([...keys].filter((k) => S.known.has(k) && !S.man.has(k)).map((k) => tex(k).ready));
  buildScene();
  if (!keepView) { try { S.rione = localStorage.getItem('mappo:rione') || sc.idx.rioni[0].id; } catch { S.rione = sc.idx.rioni[0].id; } }
  renderSrc(); renderRioni(); renderLayers(); refresh(); renderInspector();
  $('#mp-loading').style.display = 'none';
  if (!keepView) fit();
  S.dirtyDraw = true;
}

(async () => {
  resize(); window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe($('#mp-stage'));
  try { const ags = await api('/api/agents'); S.agents = Object.fromEntries(ags.map((a) => [a.id, a])); } catch { S.agents = {}; }
  const who = S.agents.level?.name || 'Mappo';
  if (who !== 'Mappo') { $('.mp-plate b').textContent = `Ufficio di ${who}`; document.title = `Ufficio di ${who} — GAME STUDIO`; $('#mp-hello b').textContent = `${who}:`; }
  paintFaces();
  api('/api/mappo/cosetta').then((c) => { cosetta = c; if (S.sel) renderInspector(); }).catch(() => { cosetta = { artist: 'Cosetta', options: [] }; });
  try {
    // si riparte dall'ultima bozza aperta, se c'è (così i salvataggi si sommano lì finché non la unisci)
    const first = await api('/api/mappo/scene?src=main').catch((e) => { throw e; });
    const draft = first.drafts.find((d) => !d.queued);
    await load(draft ? draft.id : 'main');
    if (draft) banner(`Riprendo la bozza ${draft.id}, non ancora unita al gioco. Per ripartire dal gioco com'è, scegli «il gioco com'è adesso» in alto.`);
  } catch (e) { $('#mp-loading').textContent = e.message; }
  requestAnimationFrame(frame);
})();
