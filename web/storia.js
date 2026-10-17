// UFFICIO DELLA STORIA — la lavagna delle missioni (docs/memoria/STORIA.json del gioco) come diagramma di flusso:
// schede delle missioni per livelli (cosa viene prima → cosa dopo), frecce di requisito e di sblocco (dalle soluzioni,
// colorate per etica), schede che si aprono con sottomissioni e soluzioni, scheda di dettaglio, richieste a Enigma e
// Custode. I flag dichiarati si confrontano con quelli che esistono nel gioco: si vede cosa è vero e cosa è progetto.
import { buildPortrait, normalizeLook } from './sprites.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `errore ${r.status}`);
  return j;
};
const TIPI = ['principale', 'secondaria', 'lavoro', 'indagine', 'evento', 'finale'];
const TIPO_IT = { principale: 'Principale', secondaria: 'Secondaria', lavoro: 'Lavoro', indagine: 'Indagine', evento: 'Evento', finale: 'Finale' };
const ETICA = { alta: 'var(--e-alta)', media: 'var(--e-media)', bassa: 'var(--e-bassa)' };
const ETICA_HEX = { alta: '#7bd88f', media: '#ffd166', bassa: '#ff7b6b' };
const STATO_CLS = (s) => `s-${String(s || 'idea').toLowerCase().replace(/\s+/g, '-')}`;
const slugT = (t) => (TIPI.includes(t) ? t : 'secondaria');

const S = {
  scene: null, src: 'main', file: 'docs/memoria/STORIA.json', flow: 'tutto', open: new Set(), sel: null, hover: null, dir: 'v', hidden: new Set(), q: '',
  view: { s: 1, x: 0, y: 0 }, cards: new Map(), byId: new Map(), parentOf: new Map(), edges: [], flags: new Set(),
};
try { S.file = localStorage.getItem('storia:file') || S.file; S.flow = localStorage.getItem('storia:flow') || 'tutto'; S.dir = localStorage.getItem('storia:dir') || 'v'; S.open = new Set(JSON.parse(localStorage.getItem('storia:open') || '[]')); S.hidden = new Set(JSON.parse(localStorage.getItem('storia:hidden') || '[]')); } catch { /* niente */ }
const save = () => { try { localStorage.setItem('storia:file', S.file); localStorage.setItem('storia:flow', S.flow); localStorage.setItem('storia:dir', S.dir); localStorage.setItem('storia:open', JSON.stringify([...S.open])); localStorage.setItem('storia:hidden', JSON.stringify([...S.hidden])); } catch { /* */ } };

// ─── il grafo ────────────────────────────────────────────────────────────────────────────────────────────────
function index() {
  const st = S.scene.storia || {};
  S.missions = (st.missioni || []).filter((m) => m && m.id);
  S.byId = new Map(); S.parentOf = new Map();
  for (const m of S.missions) {
    S.byId.set(m.id, m);
    for (const x of m.sottomissioni || []) if (x?.id) { S.byId.set(x.id, x); S.parentOf.set(x.id, m.id); }
  }
  S.atti = (st.atti || []).filter((a) => a?.id);
  S.flags = new Set(S.scene.flags || []);
  S.allEdges = edges();
  if (!flowOptions().some((o) => o.id === S.flow)) S.flow = 'tutto';
}

// ─── i flussi: quale parte della storia si sta guardando ─────────────────────────────────────────────────────
// tutta la lavagna · la trama principale · un atto · le strade verso un finale · la catena di una missione
function linked(id, dir) {
  const out = new Set([id]); let ch = true;
  while (ch) { ch = false; for (const e of S.allEdges || []) { if (e.kind === 'chiude') continue; const [a, b] = dir === 'up' ? [e.to, e.from] : [e.from, e.to]; if (out.has(a) && !out.has(b)) { out.add(b); ch = true; } } }
  return out;
}
function flowOptions() {
  const ms = S.missions || [], o = [{ id: 'tutto', label: 'Tutta la lavagna' }];
  if (ms.some((m) => m.tipo === 'principale')) o.push({ id: 'trama', label: 'Solo la trama principale', ids: () => new Set(ms.filter((m) => ['principale', 'finale'].includes(m.tipo)).map((m) => m.id)) });
  if (ms.some((m) => m.tipo !== 'principale' && m.tipo !== 'finale')) o.push({ id: 'contorno', label: 'Solo secondarie, lavori, indagini, eventi', ids: () => new Set(ms.filter((m) => !['principale', 'finale'].includes(m.tipo)).map((m) => m.id)) });
  for (const a of S.atti || []) if (ms.some((m) => m.atto === a.id)) o.push({ id: `atto:${a.id}`, label: `Atto: ${a.titolo || a.id}`, ids: () => new Set(ms.filter((m) => m.atto === a.id).map((m) => m.id)) });
  for (const f of ms.filter((m) => m.tipo === 'finale')) o.push({ id: `finale:${f.id}`, label: `Strade verso il finale «${f.titolo || f.id}»`, ids: () => linked(f.id, 'up') });
  if (S.flow.startsWith('catena:') && S.byId?.has(S.flow.slice(7))) { const id = S.flow.slice(7); o.push({ id: S.flow, label: `Catena di «${S.byId.get(id).titolo || id}»`, ids: () => new Set([...linked(id, 'up'), ...linked(id, 'down')]) }); }
  return o;
}
function flowSet() { const o = flowOptions().find((x) => x.id === S.flow); return o?.ids ? o.ids() : null; }
function renderFlows() {
  const o = flowOptions();
  $('#flow').innerHTML = o.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  $('#flow').value = S.flow;
  const b = (S.scene?.boards || []).find((x) => x.file === S.file);
  const name = b ? boardName(b) : 'Lavagna';
  $('#where').innerHTML = S.scene?.storia ? `📍 <b>${esc(name)}</b> › ${esc(o.find((x) => x.id === S.flow)?.label || '')}${S.flow !== 'tutto' ? ' <button class="btn sm" data-flow-all>mostra tutto</button>' : ''}` : '';
}
function boardName(b) { return b.main ? (b.titolo || 'Storia principale') : (b.titolo || b.file.replace(/^docs\/memoria\/STORIA_?/, '').replace(/\.json$/, '').replace(/_/g, ' ')); }
function renderBoards() {
  const bs = S.scene?.boards || [];
  $('#board-sel').innerHTML = bs.map((b) => `<option value="${esc(b.file)}">${b.main ? '★ ' : ''}${esc(boardName(b))}</option>`).join('') || '<option>Storia principale</option>';
  $('#board-sel').value = S.file;
  $('#board-grp').hidden = bs.length < 2;
}
const top = (id) => S.parentOf.get(id) || id;
// requisiti scritti come id di missione (gli altri — flag:…, testo — restano scritti nella scheda)
const reqIds = (m) => (m.richiede || []).filter((r) => typeof r === 'string' && S.byId.has(r));

function edges() {
  const out = [];
  for (const m of S.missions) {
    for (const x of [m, ...(m.sottomissioni || [])]) {
      for (const r of reqIds(x)) if (top(r) !== m.id) out.push({ from: top(r), to: m.id, kind: 'req', fromNode: r, toNode: x.id });
      for (const so of x.soluzioni || []) {
        for (const t of so.sblocca || []) if (S.byId.has(t) && top(t) !== m.id) out.push({ from: m.id, to: top(t), kind: 'sblocca', sol: so, solOf: x.id, toNode: t });
        for (const t of so.chiude || []) if (S.byId.has(t) && top(t) !== m.id) out.push({ from: m.id, to: top(t), kind: 'chiude', sol: so, solOf: x.id, toNode: t });
      }
    }
  }
  // requisiti scritti come flag («flag:colpa_nota>=1»): la freccia parte dalla missione la cui soluzione scrive quel flag
  const writers = new Map();
  for (const m of S.missions) for (const x of [m, ...(m.sottomissioni || [])]) for (const so of x.soluzioni || []) for (const fl of so.flag || []) (writers.get(fl) || writers.set(fl, new Set()).get(fl)).add(m.id);
  for (const m of S.missions) for (const x of [m, ...(m.sottomissioni || [])]) for (const r of x.richiede || []) {
    const fl = typeof r === 'string' && /^flag:/.test(r) ? r.slice(5).split(/[<>=!\s]/)[0] : null;
    for (const from of writers.get(fl) || []) if (from !== m.id) out.push({ from, to: m.id, kind: 'req', fromNode: from, toNode: x.id, viaFlag: fl });
  }
  // doppioni (stesso requisito scritto due volte): uno solo
  const seen = new Set();
  const uniq = out.filter((e) => { const k = `${e.from}>${e.to}>${e.kind}>${e.sol?.id || e.sol?.titolo || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // un requisito che è già una freccia di sblocco fra le stesse due schede non si ridisegna
  const unl = new Set(uniq.filter((e) => e.kind === 'sblocca').map((e) => `${e.from}>${e.to}`));
  const res = uniq.filter((e) => !(e.kind === 'req' && unl.has(`${e.from}>${e.to}`)));
  // frecce parallele (più soluzioni verso la stessa scheda): una sola etichetta, «2 modi»
  const par = {};
  for (const e of res) if (e.sol) (par[`${e.from}>${e.to}`] ??= []).push(e);
  for (const g of Object.values(par)) if (g.length > 1) g.forEach((e, i) => { e.label = i === 0 ? `${g.length} modi` : ''; });
  return res;
}

// livelli: la lunghezza del cammino più lungo (requisiti e sblocchi, non le chiusure); i finali in fondo
function ranks(es) {
  const ids = S.missions.map((m) => m.id), r = new Map(ids.map((id) => [id, 0]));
  const fwd = es.filter((e) => e.kind !== 'chiude');
  for (let it = 0; it < ids.length + 1; it++) {
    let ch = false;
    for (const e of fwd) { const v = r.get(e.from) + 1; if (v > r.get(e.to) && v <= ids.length) { r.set(e.to, v); ch = true; } }
    if (!ch) break;
  }
  // l'atto (se c'è) mette un pavimento: le missioni di un atto dopo non salgono sopra quelle di prima
  if (S.atti.length) {
    const order = new Map(S.atti.map((a, i) => [a.id, i]));
    let floor = 0;
    for (const [ai] of S.atti.entries()) {
      const inAct = S.missions.filter((m) => order.get(m.atto) === ai);
      if (!inAct.length) continue;
      for (const m of inAct) r.set(m.id, Math.max(r.get(m.id), floor));
      for (let it = 0; it < ids.length; it++) { let ch = false; for (const e of fwd) { const v = r.get(e.from) + 1; if (v > r.get(e.to) && v <= ids.length * 2) { r.set(e.to, v); ch = true; } } if (!ch) break; }
      floor = Math.max(...inAct.map((m) => r.get(m.id))) + 1;
    }
  }
  const maxR = Math.max(0, ...r.values());
  for (const m of S.missions) if (m.tipo === 'finale' && !es.some((e) => e.from === m.id && e.kind !== 'chiude')) r.set(m.id, Math.max(r.get(m.id), maxR));
  return r;
}

// ─── le schede ───────────────────────────────────────────────────────────────────────────────────────────────
function evidence(x) {
  const fl = [...(x.flag || []), ...(x.soluzioni || []).flatMap((s) => s.flag || [])];
  if (!fl.length) return '';
  const ok = fl.filter((f) => S.flags.has(f)).length;
  return ok === fl.length ? `<span class="ev ok" title="Tutti i flag esistono nel gioco">✓ flag nel gioco</span>` : `<span class="ev ko" title="Flag che nel gioco non ci sono (ancora)">${fl.length - ok}/${fl.length} flag non nel gioco</span>`;
}
const people = (x) => (x.personaggi || []).map((p) => S.scene.names?.[p] || p.replace(/^npc_/, '')).join(', ');
function solHTML(so, ownerId) {
  const to = [...(so.sblocca || []).map((t) => `→ ${esc(S.byId.get(t)?.titolo || t)}`), ...(so.chiude || []).map((t) => `✕ chiude ${esc(S.byId.get(t)?.titolo || t)}`)].join(' · ');
  return `<button class="sol" data-sol="${esc(ownerId)}|${esc(so.id || so.titolo)}" title="${esc(so.come || '')}"><span class="dot" style="background:${ETICA[so.etica] || '#bbb'}"></span>${esc(so.titolo || so.id)}${to ? `<span class="to">${to}</span>` : ''}</button>`;
}
function cardHTML(m) {
  const open = S.open.has(m.id), t = slugT(m.tipo);
  const subs = m.sottomissioni || [], sols = m.soluzioni || [];
  const nSol = sols.length + subs.reduce((s, x) => s + (x.soluzioni || []).length, 0);
  const meta = [m.rione, people(m)].filter(Boolean).join(' · ');
  const atto = S.atti.find((a) => a.id === m.atto);
  return `<div class="pin"></div><div class="ch">
      <div class="row1"><span class="tipo" title="${esc(atto?.titolo || '')}">${esc(TIPO_IT[t])}</span><span class="stato ${STATO_CLS(m.stato)}">${esc(m.stato || 'idea')}</span></div>
      <h4>${esc(m.titolo || m.id)}</h4>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      <div class="counts"><span>${subs.length ? `${subs.length} sottomissioni · ` : ''}${nSol ? `${nSol} ${nSol === 1 ? 'soluzione' : 'soluzioni'}` : t === 'finale' ? '' : 'nessuna soluzione scritta'} ${evidence(m)}</span>${subs.length || sols.length || m.riassunto ? `<button class="xp" data-xp="${esc(m.id)}">${open ? '▾ chiudi' : '▸ apri'}</button>` : ''}</div>
    </div>
    ${open ? `<div class="cb">
      ${m.riassunto ? `<p>${esc(m.riassunto)}</p>` : ''}
      ${m.obiettivo ? `<p><b>Obiettivo:</b> ${esc(m.obiettivo)}</p>` : ''}
      ${(m.richiede || []).length ? `<div class="lbl">Serve</div><div>${(m.richiede || []).map((r) => esc(S.byId.get(r)?.titolo || String(r).replace(/^flag:/, 'flag '))).join(' · ')}</div>` : ''}
      ${subs.length ? `<div class="lbl">Sottomissioni</div>${subs.map((x) => `<div class="sub" data-node="${esc(x.id)}" style="--tc:var(--t-${slugT(x.tipo || 'secondaria')})"><b>${esc(x.titolo || x.id)}</b> <span class="stato ${STATO_CLS(x.stato)}">${esc(x.stato || 'idea')}</span>${x.riassunto ? `<div class="meta">${esc(x.riassunto)}</div>` : ''}${(x.soluzioni || []).map((so) => solHTML(so, x.id)).join('')}</div>`).join('')}` : ''}
      ${sols.length ? `<div class="lbl">Come si risolve</div>${sols.map((so) => solHTML(so, m.id)).join('')}` : ''}
    </div>` : ''}`;
}

// ─── disegno: schede nel DOM (si misurano), poi posti e frecce ─────────────────────────────────────────────────
const world = $('#world'), svg = $('#edges'), board = $('#board');
function matches(m) {
  if (S.hidden.has(slugT(m.tipo))) return false;
  if (S.fset && !S.fset.has(m.id)) return false;
  if (!S.q) return true;
  const hay = JSON.stringify([m.id, m.titolo, m.riassunto, m.personaggi, m.flag, m.rione, (m.soluzioni || []).map((s) => [s.titolo, s.flag]), (m.sottomissioni || []).map((x) => [x.titolo, x.id]), people(m)]).toLowerCase();
  return hay.includes(S.q);
}
function render({ keepView = true } = {}) {
  if (!S.scene) return;
  for (const el of world.querySelectorAll('.card, .lane')) el.remove();
  S.cards = new Map();
  if (!S.missions.length) { svg.innerHTML = ''; return; }
  S.fset = flowSet();
  const vis = S.missions.filter(matches);
  const visIds = new Set(vis.map((m) => m.id));
  S.edges = edges().filter((e) => visIds.has(e.from) && visIds.has(e.to));
  // con un flusso o un filtro, chi è nascosto in mezzo non spezza la catena: freccia «passando da…» fra le schede visibili
  if (vis.length < S.missions.length) {
    const fwd = (S.allEdges || []).filter((e) => e.kind !== 'chiude');
    const have = new Set(S.edges.map((e) => `${e.from}>${e.to}`));
    for (const a of vis) {
      const seen = new Set([a.id]), q = fwd.filter((e) => e.from === a.id && !visIds.has(e.to)).map((e) => ({ id: e.to, via: [e.to] }));
      while (q.length) {
        const { id, via } = q.shift();
        if (seen.has(id)) continue; seen.add(id);
        for (const e of fwd.filter((x) => x.from === id)) {
          if (visIds.has(e.to)) { if (e.to !== a.id && !have.has(`${a.id}>${e.to}`)) { have.add(`${a.id}>${e.to}`); S.edges.push({ from: a.id, to: e.to, kind: 'req', via }); } }
          else if (!seen.has(e.to) && via.length < 8) q.push({ id: e.to, via: [...via, e.to] });
        }
      }
    }
  }
  const rk = ranks(S.edges);
  for (const m of vis) {
    const el = document.createElement('div');
    el.className = `card t-${slugT(m.tipo)} st-${String(m.stato || 'idea').replace(/\s+/g, '-')}${S.open.has(m.id) ? ' open' : ''}${S.sel?.card === m.id ? ' sel' : ''}`;
    el.style.setProperty('--tc', `var(--t-${slugT(m.tipo)})`);
    el.dataset.id = m.id;
    el.innerHTML = cardHTML(m);
    world.append(el);
    S.cards.set(m.id, { el, m, r: rk.get(m.id) || 0, w: el.offsetWidth, h: el.offsetHeight });
  }
  layout();
  drawEdges();
  highlight();
  if (!keepView) fit();
}

function layout() {
  const V = S.dir === 'v', GAP = V ? 34 : 46, RGAP = V ? 90 : 130;
  const byRank = new Map();
  for (const c of S.cards.values()) (byRank.get(c.r) || byRank.set(c.r, []).get(c.r)).push(c);
  const ranksSorted = [...byRank.keys()].sort((a, b) => a - b);
  // ordine dentro il livello: prima per atto e tipo, poi baricentro dei genitori (due passate)
  const pos = new Map();
  ranksSorted.forEach((r) => byRank.get(r).sort((a, b) => TIPI.indexOf(slugT(a.m.tipo)) - TIPI.indexOf(slugT(b.m.tipo))).forEach((c, i) => pos.set(c.m.id, i)));
  for (let pass = 0; pass < 3; pass++) for (const r of ranksSorted) {
    const list = byRank.get(r);
    const bary = (c) => { const ps = S.edges.filter((e) => e.to === c.m.id && e.kind !== 'chiude').map((e) => pos.get(e.from)).filter((x) => x !== undefined); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(c.m.id); };
    list.sort((a, b) => bary(a) - bary(b)); list.forEach((c, i) => pos.set(c.m.id, i));
  }
  // misure: ogni livello è una riga (verticale) o una colonna (orizzontale), centrata
  const along = (c) => (V ? c.w : c.h), across = (c) => (V ? c.h : c.w);
  const lens = ranksSorted.map((r) => byRank.get(r).reduce((s, c) => s + along(c), 0) + GAP * (byRank.get(r).length - 1));
  const maxLen = Math.max(...lens);
  let off = 40;
  S.lanes = [];
  ranksSorted.forEach((r, i) => {
    const list = byRank.get(r), thick = Math.max(...list.map(across));
    let p = 40 + (maxLen - lens[i]) / 2;
    for (const c of list) {
      const a = along(c);
      c.x = V ? p : off; c.y = V ? off : p;
      if (V) c.y += 0; else c.x += (thick - c.w) / 2 * 0;
      c.el.style.left = `${c.x}px`; c.el.style.top = `${c.y}px`;
      p += a + GAP;
    }
    off += thick + RGAP;
  });
  S.size = V ? { w: maxLen + 80, h: off } : { w: off, h: maxLen + 80 };
  svg.setAttribute('width', S.size.w); svg.setAttribute('height', S.size.h);
  // gli atti come titoli a lato del loro primo livello
  for (const a of S.atti) {
    const cs = [...S.cards.values()].filter((c) => c.m.atto === a.id);
    if (!cs.length) continue;
    const el = document.createElement('div'); el.className = 'lane'; el.textContent = a.titolo || a.id;
    if (V) { el.style.left = '6px'; el.style.top = `${Math.min(...cs.map((c) => c.y)) - 26}px`; }
    else { el.style.left = `${Math.min(...cs.map((c) => c.x))}px`; el.style.top = '8px'; }
    world.append(el);
  }
}

// punto d'attacco: lato d'uscita (sotto / destra) o d'entrata (sopra / sinistra); da una soluzione aperta, la soluzione
function anchor(id, out, sub) {
  const c = S.cards.get(id); if (!c) return null;
  const V = S.dir === 'v';
  if (sub && S.open.has(id)) {
    const el = c.el.querySelector(sub);
    if (el) {
      const s = S.view.s, br = c.el.getBoundingClientRect(), r = el.getBoundingClientRect();
      const oy = (r.top - br.top) / s, h = r.height / s;
      return out ? [c.x + c.w, c.y + oy + h / 2, 'r'] : [c.x, c.y + oy + h / 2, 'l'];   // la soluzione esce dal fianco, all'altezza della sua riga
    }
  }
  return V ? (out ? [c.x + c.w / 2, c.y + c.h, 'b'] : [c.x + c.w / 2, c.y, 't']) : (out ? [c.x + c.w, c.y + c.h / 2, 'r'] : [c.x, c.y + c.h / 2, 'l']);
}
function pathD(a, b) {
  const [x1, y1, s1] = a, [x2, y2, s2] = b, k = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.35);
  const d = { b: [0, 1], t: [0, -1], r: [1, 0], l: [-1, 0] };
  const c1 = [x1 + d[s1][0] * k, y1 + d[s1][1] * k], c2 = [x2 + d[s2][0] * k, y2 + d[s2][1] * k];
  return `M${x1},${y1} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x2},${y2}`;
}
function drawEdges() {
  const defs = `<defs>${[['req', 'rgba(240,236,220,.7)'], ['alta', ETICA_HEX.alta], ['media', ETICA_HEX.media], ['bassa', ETICA_HEX.bassa], ['chiude', '#ff7b6b'], ['neutra', '#cfc6b0']].map(([k, c]) => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('')}</defs>`;
  const paths = S.edges.map((e, i) => {
    const solSel = e.sol ? `[data-sol="${CSS.escape(`${e.solOf}|${e.sol.id || e.sol.titolo}`)}"]` : null;
    const subSel = e.kind === 'req' && e.toNode !== e.to ? `[data-node="${CSS.escape(e.toNode)}"]` : null;
    const a = anchor(e.from, true, solSel), b = anchor(e.to, false, subSel);
    if (!a || !b) return '';
    const col = e.kind === 'req' ? 'rgba(240,236,220,.55)' : e.kind === 'chiude' ? '#ff7b6b' : ETICA_HEX[e.sol?.etica] || '#cfc6b0';
    const mk = e.kind === 'req' ? 'req' : e.kind === 'chiude' ? 'chiude' : (ETICA_HEX[e.sol?.etica] ? e.sol.etica : 'neutra');
    const label = e.via ? esc(`passando da ${e.via.map((v) => S.byId.get(v)?.titolo || v).slice(0, 2).join(', ')}${e.via.length > 2 ? '…' : ''}`) : e.sol && S.open.has(e.from) ? '' : e.sol ? esc(e.label ?? e.sol.titolo ?? '') : '';
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return `<g class="edge" data-e="${i}"><path d="${pathD(a, b)}" fill="none" stroke="${col}" stroke-width="${e.kind === 'req' ? 2 : 2.4}" ${e.kind === 'chiude' ? 'stroke-dasharray="6 5"' : e.via ? 'stroke-dasharray="2 5"' : ''} marker-end="url(#m-${mk})" stroke-linecap="round"/>${label ? `<text x="${mid[0]}" y="${mid[1] - 4}" text-anchor="middle" font-size="11" fill="${col}" stroke="#233129" stroke-width="3" paint-order="stroke" font-family="Georgia, serif" font-style="italic">${label.length > 34 ? label.slice(0, 33) + '…' : label}</text>` : ''}</g>`;
  }).join('');
  svg.innerHTML = defs + paths;
}

// passando sopra a una scheda: la sua catena (da dove viene, dove porta) resta accesa, il resto si spegne
function chain(id) {
  const up = new Set([id]), down = new Set([id]);
  let ch = true;
  while (ch) { ch = false; for (const e of S.edges) { if (e.kind === 'chiude') continue; if (down.has(e.from) && !down.has(e.to)) { down.add(e.to); ch = true; } if (up.has(e.to) && !up.has(e.from)) { up.add(e.from); ch = true; } } }
  return new Set([...up, ...down]);
}
function highlight() {
  const focus = S.hover || S.sel?.card || null;
  const on = focus ? chain(focus) : null;
  for (const [id, c] of S.cards) c.el.classList.toggle('dim', !!on && !on.has(id));
  svg.querySelectorAll('.edge').forEach((g) => { const e = S.edges[Number(g.dataset.e)]; g.style.opacity = on ? (on.has(e.from) && on.has(e.to)) || (e.kind === 'chiude' && (e.from === focus || e.to === focus)) ? 1 : 0.1 : e.kind === 'chiude' ? 0.3 : 1; });
}

// ─── vista ───────────────────────────────────────────────────────────────────────────────────────────────────
function apply() { world.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.s})`; $('#zoomlbl').textContent = `${Math.round(S.view.s * 100)}%`; }
function fit() {
  if (!S.size) return;
  const r = board.getBoundingClientRect();
  const s = Math.min(1.2, Math.max(0.15, Math.min((r.width - 40) / S.size.w, (r.height - 60) / S.size.h)));
  S.view = { s, x: (r.width - S.size.w * s) / 2, y: Math.max(40, (r.height - S.size.h * s) / 2) };
  apply();
}
function zoomAt(f, cx, cy) { const s = Math.max(0.12, Math.min(3, S.view.s * f)), k = s / S.view.s; S.view.x = cx - (cx - S.view.x) * k; S.view.y = cy - (cy - S.view.y) * k; S.view.s = s; apply(); }
function focusCard(id) {
  const c = S.cards.get(id); if (!c) return;
  const r = board.getBoundingClientRect(), s = Math.max(S.view.s, 0.8);
  S.view = { s, x: r.width / 2 - (c.x + c.w / 2) * s, y: r.height / 3 - (c.y + c.h / 2) * s };
  apply();
}
let drag = null;
board.addEventListener('pointerdown', (e) => { if (e.target.closest('.card, .notice, .legend')) return; drag = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, moved: false }; board.setPointerCapture(e.pointerId); board.classList.add('drag'); });
board.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; S.view.x = drag.vx + dx; S.view.y = drag.vy + dy; apply(); });
board.addEventListener('pointerup', () => { if (drag && !drag.moved && S.sel) { S.sel = null; renderDetail(); render(); } drag = null; board.classList.remove('drag'); });
board.addEventListener('wheel', (e) => { e.preventDefault(); const r = board.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
document.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => { const r = board.getBoundingClientRect(); if (b.dataset.z === 'fit') fit(); else zoomAt(b.dataset.z === 'in' ? 1.25 : 0.8, r.width / 2, r.height / 2); }));
window.addEventListener('keydown', (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.key === '0') fit(); if (e.key === 'Escape') { S.sel = null; renderDetail(); render(); } });

// clic: apri/chiudi, scegli una scheda, una sottomissione o una soluzione
world.addEventListener('click', (e) => {
  const xp = e.target.closest('[data-xp]');
  if (xp) { e.stopPropagation(); toggle(xp.dataset.xp); return; }
  const sol = e.target.closest('[data-sol]');
  if (sol) { const [owner, ...rest] = sol.dataset.sol.split('|'); select({ card: top(owner), node: owner, sol: rest.join('|') }); return; }
  const sub = e.target.closest('[data-node]');
  if (sub) { select({ card: top(sub.dataset.node), node: sub.dataset.node }); return; }
  const card = e.target.closest('.card');
  if (card) { const id = card.dataset.id; if (S.sel?.card === id && S.sel.node === id && !S.open.has(id)) toggle(id); else select({ card: id, node: id }); }
});
world.addEventListener('dblclick', (e) => { const card = e.target.closest('.card'); if (card && !e.target.closest('.cb')) toggle(card.dataset.id); });
world.addEventListener('mouseover', (e) => { const c = e.target.closest('.card'); const id = c?.dataset.id || null; if (id !== S.hover) { S.hover = id; highlight(); } });
world.addEventListener('mouseleave', () => { S.hover = null; highlight(); });
function toggle(id) { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); save(); render(); }
function select(sel) { S.sel = sel; renderDetail(); render(); setChip(); }

// ─── scheda di dettaglio ─────────────────────────────────────────────────────────────────────────────────────
function flagsHTML(list) { return list?.length ? `<div class="flags">${list.map((f) => `<code class="${S.flags.has(f) ? 'ok' : 'ko'}" title="${S.flags.has(f) ? 'esiste nel gioco' : 'non c\'è nel gioco (ancora)'}">${esc(f)}</code>`).join(' ')}</div>` : ''; }
const link = (id) => (S.byId.has(id) ? `<span class="link" data-go="${esc(id)}">${esc(S.byId.get(id).titolo || id)}</span>` : esc(id));
function renderDetail() {
  const box = $('#det'), sel = S.sel;
  if (!S.scene?.storia) { box.innerHTML = '<h3>Scheda</h3><p class="muted">Quando c\'è la lavagna, qui vedi tutto di una missione: cosa serve, come si risolve, cosa comporta ogni scelta.</p>'; return; }
  if (!sel) {
    const st = S.scene.storia, n = S.missions.length, sub = S.missions.reduce((s, m) => s + (m.sottomissioni || []).length, 0);
    const sol = [...S.byId.values()].reduce((s, x) => s + (x.soluzioni || []).length, 0);
    const byStato = {}; for (const m of S.missions) byStato[m.stato || 'idea'] = (byStato[m.stato || 'idea'] || 0) + 1;
    box.innerHTML = `<h3>${esc(S.scene.storia.titolo || 'La storia, oggi')}</h3>
      <p>${n} missioni, ${sub} sottomissioni, ${sol} modi di risolverle.</p>
      <p>${Object.entries(byStato).map(([k, v]) => `<span class="stato ${STATO_CLS(k)}">${esc(k)}</span> ${v}`).join(' &nbsp; ')}</p>
      ${st.aggiornata ? `<p class="muted">Lavagna aggiornata alla versione ${esc(st.aggiornata.gioco || '?')}${st.aggiornata.nota ? `: ${esc(st.aggiornata.nota)}` : ''}.</p>` : ''}
      <p class="muted">Clic su una scheda per i dettagli, doppio clic (o ▸) per aprirla. Passando sopra a una scheda resta accesa la sua catena: da dove viene e dove porta.</p>`;
    return;
  }
  const x = S.byId.get(sel.node); if (!x) { box.innerHTML = ''; return; }
  if (sel.sol) {
    const so = (x.soluzioni || []).find((s) => (s.id || s.titolo) === sel.sol); if (!so) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="det"><div class="muted">Soluzione di ${link(x.id)}</div><h2>${esc(so.titolo || so.id)}</h2>
      ${so.etica ? `<p><span class="stato" style="background:${ETICA_HEX[so.etica] || '#999'};color:#222">etica ${esc(so.etica)}</span></p>` : ''}
      ${so.come ? `<div class="lbl">Cosa fa il giocatore</div><p>${esc(so.come)}</p>` : ''}
      ${so.esito ? `<div class="lbl">Cosa succede</div><p>${esc(so.esito)}</p>` : ''}
      ${so.implica?.length ? `<div class="lbl">Cosa comporta</div><ul>${so.implica.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${so.sblocca?.length ? `<div class="lbl">Sblocca</div><p>${so.sblocca.map(link).join(' · ')}</p>` : ''}
      ${so.chiude?.length ? `<div class="lbl">Chiude</div><p>${so.chiude.map(link).join(' · ')}</p>` : ''}
      ${so.flag?.length ? `<div class="lbl">Flag</div>${flagsHTML(so.flag)}` : ''}</div>`;
    return;
  }
  const parent = S.parentOf.get(x.id);
  const into = S.edges.filter((e) => e.to === top(x.id) && e.kind !== 'req').map((e) => `${link(e.from)} con «${esc(e.sol?.titolo || '')}»${e.kind === 'chiude' ? ' (la chiude)' : ''}`);
  box.innerHTML = `<div class="det">${parent ? `<div class="muted">Sottomissione di ${link(parent)}</div>` : `<div class="muted">${esc(TIPO_IT[slugT(x.tipo)])}${x.rione ? ` · ${esc(x.rione)}` : ''}</div>`}
    <h2>${esc(x.titolo || x.id)}</h2>
    <p><span class="stato ${STATO_CLS(x.stato)}">${esc(x.stato || 'idea')}</span> <span class="muted">id ${esc(x.id)}</span> <button class="btn sm" style="color:var(--ink);border-color:var(--ink2)" data-chain="${esc(top(x.id))}" title="Mostra solo da dove viene e dove porta">Solo la sua catena</button></p>
    ${x.riassunto ? `<p>${esc(x.riassunto)}</p>` : ''}
    ${x.obiettivo ? `<div class="lbl">Obiettivo</div><p>${esc(x.obiettivo)}</p>` : ''}
    ${x.personaggi?.length ? `<div class="lbl">Personaggi</div><p>${esc(people(x))}</p>` : ''}
    ${x.richiede?.length ? `<div class="lbl">Serve</div><ul>${x.richiede.map((r) => `<li>${S.byId.has(r) ? link(r) : esc(String(r))}${/^flag:/.test(r) ? (S.flags.has(String(r).slice(5).split(/[<>=!]/)[0].trim()) ? ' ✓' : ' <span class="ev ko">(flag non nel gioco)</span>') : ''}</li>`).join('')}</ul>` : ''}
    ${into.length ? `<div class="lbl">Ci si arriva da</div><ul>${into.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
    ${(x.sottomissioni || []).length ? `<div class="lbl">Sottomissioni</div><ul>${x.sottomissioni.map((s) => `<li>${link(s.id)} <span class="stato ${STATO_CLS(s.stato)}">${esc(s.stato || 'idea')}</span></li>`).join('')}</ul>` : ''}
    ${(x.soluzioni || []).length ? `<div class="lbl">Come si risolve</div>${x.soluzioni.map((so) => `<div style="margin:4px 0"><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ETICA_HEX[so.etica] || '#bbb'}"></span> <span class="link" data-so="${esc(x.id)}|${esc(so.id || so.titolo)}">${esc(so.titolo || so.id)}</span>${so.esito ? `<div class="muted" style="margin-left:14px">${esc(so.esito)}</div>` : ''}${so.implica?.length ? `<div style="margin-left:14px;font-size:12px">⤷ ${so.implica.map(esc).join(' · ')}</div>` : ''}</div>`).join('')}` : ''}
    ${x.flag?.length ? `<div class="lbl">Flag</div>${flagsHTML(x.flag)}` : ''}
    ${x.fonti?.length ? `<div class="lbl">Dove sta scritto</div><p class="muted">${x.fonti.map(esc).join('<br>')}</p>` : ''}</div>`;
}
$('#det').addEventListener('click', (e) => {
  const ch = e.target.closest('[data-chain]'); if (ch) { setFlow(`catena:${ch.dataset.chain}`); return; }
  const g = e.target.closest('[data-go]'); if (g) { const id = g.dataset.go; select({ card: top(id), node: id }); focusCard(top(id)); return; }
  const so = e.target.closest('[data-so]'); if (so) { const [owner, ...rest] = so.dataset.so.split('|'); select({ card: top(owner), node: owner, sol: rest.join('|') }); }
});

function setFlow(id) { S.flow = id; save(); renderFlows(); render({ keepView: false }); }
$('#flow').addEventListener('change', (e) => setFlow(e.target.value));
$('#board-sel').addEventListener('change', async (e) => { S.file = e.target.value; S.flow = 'tutto'; S.sel = null; save(); try { await load(S.src, { keepView: false }); } catch (err) { notice(err.message, 'err'); } });
$('#where').addEventListener('click', (e) => { if (e.target.closest('[data-flow-all]')) setFlow('tutto'); });

// ─── richieste a Enigma e Custode ────────────────────────────────────────────────────────────────────────────
function setChip() {
  const sel = S.sel, x = sel && S.byId.get(sel.node);
  const so = x && sel.sol ? (x.soluzioni || []).find((s) => (s.id || s.titolo) === sel.sol) : null;
  $('#ask-chip').innerHTML = x ? `<span class="chip">riferito a: ${esc(so ? `${so.titolo} (${x.titolo})` : x.titolo || x.id)} <button title="Togli il riferimento" data-unchip>✕</button></span>` : '';
}
$('#ask-chip').addEventListener('click', (e) => { if (e.target.closest('[data-unchip]')) { S.sel = null; renderDetail(); render(); setChip(); } });
async function send(mode) {
  const text = $('#ask-text').value.trim();
  if (!text && mode !== 'rebuild') { $('#ask-text').focus(); return; }
  const sel = S.sel, x = sel && S.byId.get(sel.node);
  const so = x && sel.sol ? (x.soluzioni || []).find((s) => (s.id || s.titolo) === sel.sol) : null;
  const node = x ? (so ? { kind: 'soluzione', id: so.id || so.titolo, titolo: so.titolo, parent: x.id } : { kind: 'missione', id: x.id, titolo: x.titolo }) : null;
  const b = $('#ask-send'); b.disabled = true;
  try {
    const r = await api('/api/storia/prompt', { text, node, mode, file: S.file });
    $('#ask-text').value = '';
    await refresh();
    notice(`Mandata: ${r.request?.id || ''}. La segui qui sotto e nella chat dello Studio; quando la unisci, la lavagna si aggiorna.`, 'ok');
  } catch (e) { notice(e.message, 'err'); }
  b.disabled = false;
}
$('#ask-send').addEventListener('click', () => send());
$('#ask-text').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
const REQ_IT = { PLANNING: 'si pianifica', RUNNING: 'in lavoro', QUEUED: 'in attesa', NEEDS_USER: 'aspetta te', DONE: 'da provare', ANSWERED: 'risposta data', FAILED: 'fallita', CANCELLED: 'fermata' };
function renderReqs() {
  const list = S.scene?.related || [];
  $('#reqs').innerHTML = `<h3>Richieste sulla storia</h3>${list.length ? list.map((r) => `<div class="req"><b>${esc(r.id)}</b><span>${esc(r.text)}</span><span class="st ${esc(r.status)}">${r.merged ? 'unita ✓' : r.discarded ? 'scartata' : esc(REQ_IT[r.status] || r.status)}</span></div>`).join('') : '<p class="muted">Ancora nessuna. Scrivi qui sopra cosa cambiare: la storia, una missione, una soluzione.</p>'}`;
}

// ─── avvisi, intestazione ────────────────────────────────────────────────────────────────────────────────────
let noticeT;
function notice(text, kind) { const n = $('#notice'); const d = document.createElement('div'); d.className = kind === 'err' ? 'err' : ''; d.textContent = text; n.prepend(d); clearTimeout(noticeT); noticeT = setTimeout(() => { d.remove(); }, 9000); }
function renderNotices() {
  const sc = S.scene, n = $('#notice');
  n.innerHTML = '';
  const st = sc.storia;
  if (sc.parseError) n.insertAdjacentHTML('beforeend', `<div class="err">La lavagna (docs/memoria/STORIA.json) non è un JSON valido: ${esc(sc.parseError)} <button class="btn sm" data-fix>Fatela sistemare</button></div>`);
  if (st && sc.stale?.commits) n.insertAdjacentHTML('beforeend', `<div class="warn">Dopo l'ultimo aggiornamento della lavagna${st.aggiornata?.gioco ? ` (v${esc(st.aggiornata.gioco)})` : ''} sono cambiati livelli, testi o documenti ${sc.stale.commits} volte: potrebbe non essere aggiornata. <button class="btn sm" data-rebuild>Aggiornatela</button></div>`);
  if (sc.problems?.length) n.insertAdjacentHTML('beforeend', `<div class="warn" title="${esc(sc.problems.join('\n'))}">${sc.problems.length} rimandi da sistemare (es. ${esc(sc.problems[0])}) <button class="btn sm" data-fix>Fateli sistemare</button></div>`);
  $('#board .empty')?.remove();
  if (!st && !sc.parseError) {
    board.insertAdjacentHTML('beforeend', `<div class="empty"><div><h2>La lavagna è ancora vuota</h2><p>${esc(names())} leggono i livelli, i testi e i documenti della storia e ci mettono tutte le missioni, cosa sblocca cosa e i modi di risolverle, segnando cosa è già nel gioco e cosa è solo progetto.</p><button class="btn primary" data-rebuild>Fate la lavagna</button><p class="muted" style="font-size:12px;margin-top:10px">Diventa una richiesta dello Studio (la Regia la affida a loro): poi «Prova questa versione» o «Unisci al gioco», e la lavagna compare qui.</p></div></div>`);
  }
  const lg = $('#legend');
  lg.hidden = !st;
  lg.innerHTML = `<div><i style="border-color:rgba(240,236,220,.7)"></i>serve prima</div><div><i style="border-color:${ETICA_HEX.alta}"></i>sblocca · etica alta</div><div><i style="border-color:${ETICA_HEX.media}"></i>sblocca · etica media</div><div><i style="border-color:${ETICA_HEX.bassa}"></i>sblocca · etica bassa</div><div><i style="border-color:#ff7b6b;border-top-style:dashed"></i>chiude</div>`;
}
board.addEventListener('click', (e) => {
  if (e.target.closest('[data-rebuild]')) { $('#ask-text').value = ''; send('rebuild'); }
  if (e.target.closest('[data-fix]')) { $('#ask-text').value = `Sistema la lavagna della storia: ${S.scene.parseError ? `il file non è un JSON valido (${S.scene.parseError})` : S.scene.problems.join('; ')}.`; send(); }
});
function names() { const a = S.scene?.agents || {}; return [a.puzzle?.name, a.lore?.name].filter(Boolean).join(' e ') || 'Enigma e Custode'; }
function paintFaces() {
  for (const id of ['puzzle', 'lore']) {
    const c = $(`#f-${id}`), a = S.scene?.agents?.[id]; if (!c || !a?.avatar?.character) continue;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, 36, 36);
    g.drawImage(buildPortrait(normalizeLook(a.avatar.character, a.avatar.color)), 0, 0);
  }
  $('#ask-who').textContent = names();
  $('#who').textContent = `${names()} · missioni, cosa sblocca cosa, come si risolvono`;
}
function renderTypes() {
  $('#types').innerHTML = TIPI.map((t) => `<button class="btn sm ${S.hidden.has(t) ? '' : 'on'}" data-t="${t}" title="Mostra o nascondi: ${TIPO_IT[t]}" style="${S.hidden.has(t) ? '' : `background:var(--t-${t});border-color:var(--t-${t});color:#fff`}">${TIPO_IT[t]}</button>`).join('');
}
$('#types').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; const t = b.dataset.t; if (S.hidden.has(t)) S.hidden.delete(t); else S.hidden.add(t); save(); renderTypes(); render(); });
$('#q').addEventListener('input', (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });
$('#dir').addEventListener('click', () => { S.dir = S.dir === 'v' ? 'h' : 'v'; save(); $('#dir').textContent = S.dir === 'v' ? '↓ Verticale' : '→ Orizzontale'; render({ keepView: false }); });
$('#open-all').addEventListener('click', () => { for (const m of S.missions || []) S.open.add(m.id); save(); render(); });
$('#close-all').addEventListener('click', () => { S.open.clear(); save(); render(); });
$('#src').addEventListener('change', (e) => load(e.target.value, { keepView: false }));
function renderSrc() {
  const sc = S.scene;
  $('#src').innerHTML = `<option value="main">il gioco com'è adesso${sc.version ? ` (v${esc(sc.version)})` : ''}</option>${(sc.drafts || []).map((d) => `<option value="${esc(d.id)}">da provare: ${esc(d.id)} — ${esc(d.text)}</option>`).join('')}`;
  $('#src').value = sc.src;
  $('#play').href = sc.play;
}

// ─── carica ──────────────────────────────────────────────────────────────────────────────────────────────────
async function load(src = S.src, { keepView = true } = {}) {
  const sc = await api(`/api/storia?src=${encodeURIComponent(src)}&file=${encodeURIComponent(S.file)}`);
  S.scene = sc; S.src = sc.src; S.file = sc.file || S.file;
  index();
  renderBoards(); renderFlows(); renderSrc(); renderTypes(); paintFaces(); renderNotices(); renderReqs(); renderDetail(); setChip();
  render({ keepView });
}
async function refresh() { try { await load(S.src); } catch (e) { notice(e.message, 'err'); } }

(async () => {
  $('#dir').textContent = S.dir === 'v' ? '↓ Verticale' : '→ Orizzontale';
  try { await load('main', { keepView: false }); } catch (e) { notice(e.message, 'err'); }
  apply();
  // si aggiorna da sola: quando una richiesta sulla storia cambia stato (o una viene unita), e tornando sulla pagina
  setInterval(() => { if (document.visibilityState === 'visible' && (S.scene?.related || []).some((r) => ['PLANNING', 'RUNNING', 'QUEUED'].includes(r.status) || (r.status === 'DONE' && !r.merged && !r.discarded))) refresh(); }, 20000);
  window.addEventListener('focus', refresh);
  window.addEventListener('resize', () => { if (S.size) apply(); });
})();
