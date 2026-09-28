// PERSONAGGI IN PIXEL ART — costruiti in codice, pixel per pixel, a partire dai DATI di avatar.character.
//
// Stile: contorno scuro "selettivo" (ogni bordo prende una tonalità scura del colore vicino), ombre a tre toni con la
// luce da sinistra in alto, occhi con riflesso, capelli a ciocche. I personaggi sono di tre quarti, girati verso lo
// spettatore, seduti dietro la scrivania (se ne vede il busto) oppure in piedi.
//
// Aspetto (avatar.character):
//   skin, hair, eyes, shirt, accColor           colori
//   hairStyle: short | spiky | long | ponytail | bun | curly | bob | bald
//   outfit:    tee | shirt | hoodie | sweater | apron | labcoat | vest
//   facial:    none | beard | moustache | stubble
//   accessory: none | glasses | headphones | beret | cap | headband | earrings
// Pose (dall'animazione dello stato): idle, typing, writing-notes, playing, waiting, question, celebrate, error.

import { shade } from './pixel.js';

export const SPRITE_W = 40, SPRITE_H = 54;

class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.c = new Array(w * h).fill(null); this.p = new Array(w * h).fill(''); }
  in(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  set(x, y, c, part = '') { x = Math.round(x); y = Math.round(y); if (this.in(x, y)) { this.c[y * this.w + x] = c; this.p[y * this.w + x] = part; } }
  get(x, y) { return this.in(x, y) ? this.c[y * this.w + x] : null; }
  part(x, y) { return this.in(x, y) ? this.p[y * this.w + x] : ''; }
  rect(x, y, w, h, c, part) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, part); }
  ellipse(cx, cy, rx, ry, c, part) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / (rx + 0.35), dy = (y - cy) / (ry + 0.35);
      if (dx * dx + dy * dy <= 1) this.set(x, y, c, part);
    }
  }
  poly(pts, c, part) {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= y + 0.5 && y2 > y + 0.5) || (y2 <= y + 0.5 && y1 > y + 0.5)) xs.push(x1 + ((y + 0.5 - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.set(x, y, c, part);
    }
  }
  line(x1, y1, x2, y2, c, part) {
    const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) || 1;
    for (let i = 0; i <= n; i++) this.set(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, c, part);
  }
  // ombra a tre toni per una parte: luce da sinistra-alto
  shadePart(part, base) {
    const dark = shade(base, -0.24), deep = shade(base, -0.42), light = shade(base, 0.16);
    const out = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.part(x, y) !== part) continue;
      const r1 = this.part(x + 1, y) !== part, r2 = this.part(x + 2, y) !== part, b1 = this.part(x, y + 1) !== part;
      const l1 = this.part(x - 1, y) !== part, t1 = this.part(x, y - 1) !== part;
      if (r1 && b1) out.push([x, y, deep]);
      else if (r1 || (r2 && b1)) out.push([x, y, dark]);
      else if (b1) out.push([x, y, dark]);
      else if ((l1 || t1) && !(r1 || r2)) out.push([x, y, light]);
    }
    for (const [x, y, c] of out) this.c[y * this.w + x] = c;
  }
  // contorno selettivo: i pixel vuoti attaccati alla figura prendono il colore vicino, molto scurito
  outline() {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y)) continue;
      const n = this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1);
      if (n) add.push([x, y, shade(n, -0.62)]);
    }
    for (const [x, y, c] of add) this.set(x, y, c, 'outline');
  }
  toCanvas() {
    const cv = document.createElement('canvas'); cv.width = this.w; cv.height = this.h;
    const ctx = cv.getContext('2d'); const img = ctx.createImageData(this.w, this.h);
    for (let i = 0; i < this.c.length; i++) {
      const c = this.c[i]; if (!c) continue;
      const n = parseInt(c.slice(1, 7), 16);
      img.data[i * 4] = (n >> 16) & 255; img.data[i * 4 + 1] = (n >> 8) & 255; img.data[i * 4 + 2] = n & 255; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }
}

export function normalizeLook(c = {}, fallbackColor) {
  const L = {
    skin: c.skin || '#e8b48a', hair: c.hair || '#3b2a20', eyes: c.eyes || '#3a6fb0', shirt: c.shirt || fallbackColor || '#888888',
    accColor: c.accColor || '#2a2a33', hairStyle: c.hairStyle || 'short', outfit: c.outfit || 'tee',
    facial: c.facial || 'none', accessory: c.accessory || 'none',
  };
  // compatibilità con i vecchi dati: barba e baffi stavano fra gli accessori
  if (L.accessory === 'beard' || L.accessory === 'moustache') { L.facial = L.accessory; L.accessory = 'none'; }
  return L;
}

// ── la figura ────────────────────────────────────────────────────────────────────────────────────
// pose: idle typing writing-notes playing waiting question celebrate error ; frame 0/1 ; blink
export function buildSprite(look, pose = 'idle', frame = 0, { blink = false } = {}) {
  const L = normalizeLook(look);
  const g = new Grid(SPRITE_W, SPRITE_H);
  const skinD = shade(L.skin, -0.22), skinDD = shade(L.skin, -0.4);
  const hairD = shade(L.hair, -0.28), hairL = shade(L.hair, 0.22);
  const ox = 0, oy = pose === 'celebrate' ? 0 : 2;   // tutta la figura
  const X = (x) => x + ox, Y = (y) => y + oy;

  // capelli dietro (lunghi, caschetto, coda) — prima di tutto
  if (L.hairStyle === 'long') g.poly([[X(10), Y(10)], [X(30), Y(10)], [X(31), Y(36)], [X(9), Y(36)]], L.hair, 'hairback');
  if (L.hairStyle === 'bob') g.poly([[X(10), Y(10)], [X(30), Y(10)], [X(30), Y(26)], [X(10), Y(26)]], L.hair, 'hairback');
  if (L.hairStyle === 'ponytail') { g.ellipse(X(30), Y(18), 3, 6, L.hair, 'hairback'); g.ellipse(X(31), Y(25), 2, 4, L.hair, 'hairback'); }
  if (L.outfit === 'hoodie') g.ellipse(X(20), Y(29), 11, 4, shade(L.shirt, -0.12), 'hood');

  // busto (spalle, maglia)
  const shirt = L.outfit === 'labcoat' ? '#eef0f2' : L.shirt;
  g.poly([[X(6), Y(33)], [X(11), Y(29)], [X(29), Y(29)], [X(34), Y(33)], [X(35), Y(54)], [X(5), Y(54)]], shirt, 'torso');
  // collo
  g.rect(X(17), Y(25), 7, 5, skinD, 'neck');
  // dettagli della maglia
  if (L.outfit === 'shirt') { g.poly([[X(16), Y(29)], [X(20), Y(33)], [X(24), Y(29)]], '#f3f3f3', 'collar'); g.line(X(20), Y(33), X(20), Y(50), shade(shirt, -0.3), 'torso'); for (const b of [37, 42, 47]) g.set(X(20), Y(b), '#f3f3f3', 'torso'); }
  if (L.outfit === 'tee') g.poly([[X(16), Y(29)], [X(20), Y(31)], [X(24), Y(29)]], skinD, 'neck');
  if (L.outfit === 'sweater') { g.rect(X(15), Y(28), 11, 2, shade(shirt, -0.2), 'collar'); for (let i = 7; i < 34; i += 3) g.line(X(i), Y(50), X(i), Y(53), shade(shirt, -0.18), 'torso'); }
  if (L.outfit === 'hoodie') { g.poly([[X(15), Y(29)], [X(20), Y(34)], [X(25), Y(29)]], shade(shirt, -0.3), 'collar'); g.line(X(18), Y(33), X(18), Y(39), '#e8e8e8', 'torso'); g.line(X(22), Y(33), X(22), Y(39), '#e8e8e8', 'torso'); g.rect(X(13), Y(44), 14, 6, shade(shirt, -0.15), 'pocket'); }
  if (L.outfit === 'apron') { g.poly([[X(12), Y(35)], [X(28), Y(35)], [X(29), Y(54)], [X(11), Y(54)]], L.accColor, 'apron'); g.line(X(13), Y(35), X(16), Y(29), L.accColor, 'apron'); g.line(X(27), Y(35), X(24), Y(29), L.accColor, 'apron'); g.rect(X(17), Y(40), 6, 4, shade(L.accColor, -0.2), 'apron'); }
  if (L.outfit === 'labcoat') { g.poly([[X(15), Y(29)], [X(20), Y(40)], [X(25), Y(29)]], L.shirt, 'under'); g.line(X(15), Y(29), X(20), Y(41), '#c9ced6', 'torso'); g.line(X(25), Y(29), X(20), Y(41), '#c9ced6', 'torso'); g.rect(X(25), Y(37), 5, 1, '#c9ced6', 'torso'); g.set(X(27), Y(36), '#e84a5f', 'torso'); }
  if (L.outfit === 'vest') { g.poly([[X(9), Y(31)], [X(16), Y(29)], [X(20), Y(40)], [X(24), Y(29)], [X(31), Y(31)], [X(31), Y(54)], [X(9), Y(54)]], L.accColor, 'vest'); g.poly([[X(16), Y(29)], [X(20), Y(33)], [X(24), Y(29)]], '#f3f3f3', 'collar'); }

  // testa (tre quarti, girata verso sinistra-basso)
  g.ellipse(X(20), Y(16), 8, 9, L.skin, 'head');
  g.poly([[X(12), Y(16)], [X(28), Y(16)], [X(27), Y(21)], [X(22), Y(26)], [X(16), Y(25)], [X(13), Y(21)]], L.skin, 'head');
  g.ellipse(X(28), Y(18), 2, 3, L.skin, 'ear'); g.set(X(28), Y(18), skinDD, 'ear');

  // capelli davanti
  const H = L.hair;
  const fringe = (y0) => { for (let x = 11; x <= 29; x++) { const d = (x * 7) % 3; g.rect(X(x), Y(y0), 1, 2 + d, H, 'hair'); } };
  if (L.hairStyle === 'bald') { g.rect(X(11), Y(15), 2, 5, H, 'hair'); g.rect(X(27), Y(14), 2, 4, H, 'hair'); }
  else if (L.hairStyle === 'spiky') {
    g.ellipse(X(20), Y(11), 10, 6, H, 'hair');
    for (const [sx, sy] of [[11, 3], [15, 1], [19, 0], [23, 1], [27, 3], [30, 7]]) g.poly([[X(sx - 3), Y(9)], [X(sx), Y(sy)], [X(sx + 3), Y(9)]], H, 'hair');
    fringe(13); g.rect(X(10), Y(12), 2, 7, H, 'hair');
  } else if (L.hairStyle === 'curly') {
    for (const [cx, cy, r] of [[12, 12, 3], [16, 8, 4], [21, 7, 4], [26, 9, 4], [29, 13, 3], [11, 17, 2], [29, 18, 2], [19, 11, 3]]) g.ellipse(X(cx), Y(cy), r, r, H, 'hair');
  } else {
    g.ellipse(X(20), Y(11), 10, 6, H, 'hair');
    if (L.hairStyle === 'bun') g.ellipse(X(21), Y(3), 4, 3, H, 'hair');
    if (L.hairStyle === 'long' || L.hairStyle === 'bob') { g.rect(X(10), Y(11), 3, 13, H, 'hair'); g.rect(X(27), Y(11), 3, 9, H, 'hair'); }
    fringe(13);
    g.rect(X(10), Y(12), 2, 6, H, 'hair');
  }

  // ombre a tre toni
  for (const [p, c] of [['hairback', L.hair], ['hood', shade(L.shirt, -0.12)], ['torso', shirt], ['apron', L.accColor], ['vest', L.accColor], ['head', L.skin], ['hair', L.hair], ['pocket', shade(L.shirt, -0.15)]]) g.shadePart(p, c);
  // ciocche di luce nei capelli
  if (L.hairStyle !== 'bald') for (const [x, y] of [[15, 8], [16, 8], [17, 9], [22, 7], [23, 7], [13, 11]]) if (g.part(X(x), Y(y)) === 'hair') g.set(X(x), Y(y), hairL, 'hair');
  if (L.hairStyle === 'bald') { g.set(X(16), Y(9), shade(L.skin, 0.3), 'head'); g.set(X(17), Y(9), shade(L.skin, 0.3), 'head'); }
  // ombra sotto il mento
  g.rect(X(17), Y(25), 7, 2, skinDD, 'neck');

  // faccia
  const eye = (x, y, w) => {
    if (blink) { g.rect(X(x), Y(y + 1), w, 1, '#2b1a14', 'eye'); return; }
    if (pose === 'celebrate') { g.set(X(x), Y(y + 1), '#2b1a14', 'eye'); g.set(X(x + 1), Y(y), '#2b1a14', 'eye'); g.set(X(x + w - 1), Y(y + 1), '#2b1a14', 'eye'); return; }
    const px = x + (w > 3 ? 1 : 0) + (look > 0 ? 1 : 0);
    g.rect(X(x), Y(y), w, 3, shade(L.skin, 0.12), 'eye');
    g.rect(X(x), Y(y + 1), w, 2, '#f4f1ea', 'eye');
    g.rect(X(px), Y(y + 1), 2, 2, L.eyes, 'eye');
    g.set(X(px + 1), Y(y + 2), shade(L.eyes, -0.5), 'eye');
    g.set(X(px), Y(y + 1), '#ffffff', 'eye');
    g.rect(X(x), Y(y), w, 1, '#2b1a14', 'eye');   // palpebra
  };
  eye(14, 17, 3); eye(22, 17, 4);
  // sopracciglia (espressione)
  const browC = shade(L.hair, -0.1);
  if (pose === 'question' || pose === 'error') { g.line(X(14), Y(14), X(17), Y(13), browC, 'brow'); g.line(X(22), Y(13), X(26), Y(14), browC, 'brow'); }
  else if (pose === 'typing' || pose === 'playing') { g.line(X(14), Y(14), X(17), Y(15), browC, 'brow'); g.line(X(22), Y(15), X(26), Y(14), browC, 'brow'); }
  else { g.rect(X(14), Y(14), 4, 1, browC, 'brow'); g.rect(X(22), Y(14), 4, 1, browC, 'brow'); }
  // naso e guance
  g.set(X(19), Y(20), skinD, 'nose'); g.set(X(19), Y(21), skinDD, 'nose'); g.set(X(20), Y(21), skinD, 'nose');
  g.set(X(14), Y(21), shade('#e88a8a', 0.1), 'cheek'); g.set(X(25), Y(21), shade('#e88a8a', 0.1), 'cheek');
  // bocca
  const M = '#7a2e2e';
  if (pose === 'celebrate') { g.rect(X(16), Y(23), 6, 2, M, 'mouth'); g.rect(X(17), Y(23), 4, 1, '#ffffff', 'mouth'); g.set(X(15), Y(22), M, 'mouth'); g.set(X(22), Y(22), M, 'mouth'); }
  else if (pose === 'error') { g.ellipse(X(19), Y(23.5), 1.5, 1.5, M, 'mouth'); }
  else if (pose === 'playing' && frame) { g.rect(X(17), Y(23), 4, 1, M, 'mouth'); g.rect(X(19), Y(24), 2, 1, '#e86a7a', 'mouth'); }
  else if (pose === 'question') { g.line(X(16), Y(24), X(21), Y(23), M, 'mouth'); }
  else if (pose === 'waiting') { g.rect(X(17), Y(23), 4, 1, M, 'mouth'); }
  else { g.rect(X(17), Y(23), 4, 1, M, 'mouth'); g.set(X(16), Y(22), M, 'mouth'); g.set(X(21), Y(22), M, 'mouth'); }

  // barba / baffi
  if (L.facial === 'beard') { g.poly([[X(12), Y(19)], [X(14), Y(24)], [X(19), Y(28)], [X(25), Y(26)], [X(28), Y(20)], [X(27), Y(24)], [X(21), Y(22)], [X(17), Y(22)]], L.hair, 'beard'); g.rect(X(16), Y(22), 6, 1, L.hair, 'beard'); g.rect(X(17), Y(23), 4, 1, M, 'mouth'); g.shadePart('beard', L.hair); }
  if (L.facial === 'moustache') { g.rect(X(15), Y(22), 8, 1, L.hair, 'beard'); g.set(X(15), Y(23), L.hair, 'beard'); g.set(X(22), Y(23), L.hair, 'beard'); }
  if (L.facial === 'stubble') for (let x = 14; x < 26; x += 2) for (let y = 22; y < 26; y += 2) if (g.part(X(x), Y(y)) === 'head') g.set(X(x), Y(y), shade(L.skin, -0.2), 'head');

  // accessori
  const A = L.accColor;
  if (L.accessory === 'glasses') {
    const fr = '#1b1b22';
    for (const [x, w] of [[13, 5], [21, 6]]) { g.rect(X(x), Y(16), w, 1, fr, 'glasses'); g.rect(X(x), Y(20), w, 1, fr, 'glasses'); g.rect(X(x), Y(16), 1, 5, fr, 'glasses'); g.rect(X(x + w - 1), Y(16), 1, 5, fr, 'glasses'); }
    g.rect(X(18), Y(17), 3, 1, fr, 'glasses'); g.line(X(27), Y(17), X(29), Y(17), fr, 'glasses');
    g.set(X(24), Y(19), '#cfe6ff', 'glasses');
  }
  if (L.accessory === 'headphones') { g.poly([[X(9), Y(15)], [X(10), Y(6)], [X(20), Y(2)], [X(30), Y(6)], [X(31), Y(15)], [X(29), Y(15)], [X(28), Y(7)], [X(20), Y(4)], [X(12), Y(7)], [X(11), Y(15)]], A, 'phones'); g.ellipse(X(29), Y(18), 3, 4, A, 'phones'); g.ellipse(X(11), Y(18), 2, 4, shade(A, -0.2), 'phones'); g.shadePart('phones', A); }
  if (L.accessory === 'beret') { g.ellipse(X(19), Y(6), 11, 4, A, 'beret'); g.rect(X(19), Y(1), 2, 2, A, 'beret'); g.shadePart('beret', A); }
  if (L.accessory === 'cap') { g.ellipse(X(20), Y(8), 10, 5, A, 'cap'); g.poly([[X(6), Y(11)], [X(16), Y(9)], [X(18), Y(12)], [X(8), Y(13)]], shade(A, -0.15), 'cap'); g.shadePart('cap', A); }
  if (L.accessory === 'headband') { g.rect(X(10), Y(10), 21, 2, A, 'band'); }
  if (L.accessory === 'earrings') { g.set(X(28), Y(21), '#ffd166', 'ear'); g.set(X(28), Y(22), '#ffd166', 'ear'); }

  // braccia e mani (dipendono dalla posa)
  const sleeve = L.outfit === 'labcoat' ? '#eef0f2' : L.outfit === 'vest' || L.outfit === 'apron' ? L.shirt : shirt;
  const arm = (pts) => g.poly(pts, sleeve, 'arm');
  const hand = (x, y) => { g.ellipse(X(x), Y(y), 2, 2, L.skin, 'hand'); g.set(X(x + 1), Y(y + 1), skinD, 'hand'); };
  const f = frame % 2;
  if (pose === 'typing') {
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(15), Y(43)], [X(11), Y(45)]]); arm([[X(30), Y(32)], [X(34), Y(33)], [X(29), Y(45)], [X(25), Y(43)]]);
    hand(13, 44 - f); hand(27, 43 + f);
  } else if (pose === 'playing') {
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(17), Y(40)], [X(13), Y(42)]]); arm([[X(30), Y(32)], [X(34), Y(33)], [X(27), Y(42)], [X(23), Y(40)]]);
    const py = 39 + f;
    g.rect(X(13), Y(py), 14, 5, '#2a2a33', 'pad'); g.rect(X(12), Y(py + 2), 3, 4, '#2a2a33', 'pad'); g.rect(X(25), Y(py + 2), 3, 4, '#2a2a33', 'pad');
    g.set(X(16), Y(py + 2), '#ff4fa3', 'pad'); g.set(X(23), Y(py + 1), '#3fe0d0', 'pad'); g.set(X(24), Y(py + 2), '#ffd166', 'pad'); g.set(X(22), Y(py + 2), '#7bd88f', 'pad');
    hand(14, py + 3); hand(26, py + 3);
  } else if (pose === 'writing-notes') {
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(15), Y(43)], [X(11), Y(45)]]); hand(13, 44);
    arm([[X(30), Y(32)], [X(34), Y(34)], [X(26), Y(33)], [X(24), Y(28)], [X(27), Y(28)]]); hand(24, 27 - f);   // mano al mento
  } else if (pose === 'waiting') {
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(28), Y(38)], [X(28), Y(41)], [X(9), Y(39)]]); arm([[X(30), Y(32)], [X(34), Y(33)], [X(12), Y(42)], [X(12), Y(39)]]);
    hand(29, 39); hand(11, 40);
  } else if (pose === 'question') {
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(15), Y(43)], [X(11), Y(45)]]); hand(13, 44);
    arm([[X(30), Y(31)], [X(34), Y(33)], [X(33), Y(14)], [X(30), Y(13)]]); hand(30 + f, 10);
  } else if (pose === 'celebrate') {
    arm([[X(6), Y(32)], [X(10), Y(30)], [X(7), Y(8)], [X(3), Y(9)]]); arm([[X(30), Y(30)], [X(34), Y(32)], [X(37), Y(9)], [X(33), Y(8)]]);
    hand(5, 6 - f); hand(35, 6 - f);
  } else if (pose === 'error') {
    arm([[X(6), Y(33)], [X(10), Y(31)], [X(13), Y(24)], [X(10), Y(22)]]); arm([[X(30), Y(31)], [X(34), Y(33)], [X(30), Y(22)], [X(27), Y(24)]]);
    hand(11, 21 + f); hand(29, 21 + f);
    g.ellipse(X(31), Y(9), 1, 2, '#9fd7ff', 'sweat');
  } else {
    // idle: braccia sul tavolo; ogni tanto un sorso dalla tazza
    arm([[X(6), Y(33)], [X(10), Y(32)], [X(13), Y(44)], [X(9), Y(45)]]); hand(11, 45);
    if (f) { arm([[X(30), Y(32)], [X(34), Y(33)], [X(27), Y(32)], [X(25), Y(28)], [X(28), Y(27)]]); g.rect(X(22), Y(24), 5, 5, '#e8e1d4', 'mug'); g.rect(X(21), Y(25), 1, 2, '#e8e1d4', 'mug'); hand(26, 28); }
    else { arm([[X(30), Y(32)], [X(34), Y(33)], [X(31), Y(45)], [X(27), Y(44)]]); hand(29, 45); }
  }
  g.shadePart('arm', sleeve);
  g.outline();
  return g.toCanvas();
}

// Ritratto: busto (testa e spalle) ritagliato dalla figura in posa tranquilla
export function buildPortrait(look, { blink = false, pose = 'idle' } = {}) {
  const s = buildSprite(look, pose, 0, { blink });
  const cv = document.createElement('canvas'); cv.width = 36; cv.height = 36;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s, 2, 0, 36, 36, 0, 0, 36, 36);
  return cv;
}

const cache = new Map();
export function cachedSprite(look, pose, frame, blink) {
  const key = JSON.stringify([look, pose, frame, blink]);
  let c = cache.get(key);
  if (!c) { c = buildSprite(look, pose, frame, { blink }); if (cache.size > 400) cache.clear(); cache.set(key, c); }
  return c;
}
