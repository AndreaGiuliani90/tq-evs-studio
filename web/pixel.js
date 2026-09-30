// Mattoncini di pixel art condivisi: font 3×5, colori, ritratto dei personaggi.
// Tutto disegnato in codice (nessun file immagine): si cambia l'aspetto cambiando i DATI di avatar.character.

const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '!': '010010010000010', '?': '110001010000010', '.': '000000000000010',
  '-': '000000111000000', ':': '000010000010000', "'": '010010000000000', '/': '001001010100100', '$': '011110010011110', ',': '000000000010100', '+': '000010111010000',
};

export function textWidth(s) { return String(s).length * 4 - 1; }
export function drawText(ctx, s, x, y, color) {
  ctx.fillStyle = color;
  let cx = Math.round(x);
  for (const ch of String(s).toUpperCase()) {
    const g = FONT[ch] || FONT['?'];
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3), Math.round(y) + Math.floor(i / 3), 1, 1);
    cx += 4;
  }
}

export function shade(hex, f) {
  // f < 0 scurisce, f > 0 schiarisce
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Aspetto predefinito se l'agente non ha ancora avatar.character
export function lookOf(agent) {
  const c = agent?.avatar?.character || {};
  return {
    skin: c.skin || '#e8b48a', hair: c.hair || '#3b2a20', hairStyle: c.hairStyle || 'short',
    shirt: c.shirt || agent?.avatar?.color || '#888888', accessory: c.accessory || 'none', accColor: c.accColor || '#2a2a33',
  };
}

// Ritratto frontale (testa e spalle) per le schede e la chat. Tela 24×24.
export function drawPortrait(canvas, look, { blink = false } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = 24; canvas.height = 24;
  ctx.imageSmoothingEnabled = false;
  const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  ctx.clearRect(0, 0, 24, 24);
  const L = look;
  // spalle
  R(4, 18, 16, 6, L.shirt); R(4, 18, 3, 6, shade(L.shirt, -0.2)); R(10, 18, 4, 2, shade(L.skin, -0.15));
  // collo + testa
  R(10, 16, 4, 3, shade(L.skin, -0.2));
  R(7, 6, 10, 11, L.skin); R(7, 6, 2, 11, shade(L.skin, -0.12));
  // capelli
  const H = L.hair;
  if (L.hairStyle === 'long') { R(6, 4, 12, 4, H); R(6, 4, 2, 14, H); R(16, 4, 2, 14, H); }
  else if (L.hairStyle === 'ponytail') { R(6, 4, 12, 4, H); R(6, 6, 1, 5, H); R(17, 6, 1, 5, H); R(18, 7, 2, 6, H); }
  else if (L.hairStyle === 'bun') { R(7, 4, 10, 3, H); R(10, 1, 4, 3, H); R(6, 6, 1, 4, H); R(17, 6, 1, 4, H); }
  else if (L.hairStyle === 'bald') { R(6, 9, 1, 4, H); R(17, 9, 1, 4, H); R(8, 5, 8, 1, shade(L.skin, 0.25)); }
  else if (L.hairStyle === 'curly') { R(6, 3, 12, 5, H); for (let i = 0; i < 6; i++) R(6 + i * 2, 2 + (i % 2), 2, 2, H); R(6, 7, 1, 4, H); R(17, 7, 1, 4, H); }
  else { R(7, 4, 10, 4, H); R(6, 5, 1, 5, H); R(17, 5, 1, 5, H); R(9, 8, 3, 1, H); }
  // occhi, bocca
  if (blink) { R(9, 11, 2, 1, '#2a1a14'); R(13, 11, 2, 1, '#2a1a14'); }
  else { R(9, 10, 2, 2, '#2a1a14'); R(13, 10, 2, 2, '#2a1a14'); R(9, 10, 1, 1, '#ffffff'); R(13, 10, 1, 1, '#ffffff'); }
  R(11, 14, 3, 1, shade(L.skin, -0.35));
  R(8, 13, 1, 1, '#e59a8a'); R(15, 13, 1, 1, '#e59a8a');
  // accessori
  const A = L.accColor;
  if (L.accessory === 'glasses') { R(8, 10, 4, 3, '#1b1b22'); R(12, 10, 4, 3, '#1b1b22'); R(9, 11, 2, 1, '#9fd7ff'); R(13, 11, 2, 1, '#9fd7ff'); }
  if (L.accessory === 'headphones') { R(6, 3, 12, 1, A); R(5, 8, 2, 5, A); R(17, 8, 2, 5, A); }
  if (L.accessory === 'beret') { R(6, 2, 12, 3, A); R(11, 1, 2, 1, A); }
  if (L.accessory === 'cap') { R(7, 3, 10, 3, A); R(14, 5, 5, 1, shade(A, -0.2)); }
  if (L.accessory === 'beard') { R(8, 13, 8, 4, L.hair); R(10, 14, 4, 1, shade(L.skin, -0.35)); }
  if (L.accessory === 'moustache') { R(9, 13, 6, 1, L.hair); }
}
