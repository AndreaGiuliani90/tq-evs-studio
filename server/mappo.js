// UFFICIO DI MAPPO, il cartografo: un editor della mappa a rioni del gioco (Livello 3) dentro lo Studio.
// Si spostano, girano, ingrandiscono, cambiano grafica o tolgono gli oggetti dei rioni e gli elementi del livello;
// Cosetta disegna sprite nuove su richiesta. Niente si scrive nella cartella del gioco: ogni salvataggio è un commit
// su un branch suo (una richiesta "Mappo" come le altre), da provare con «Prova questa versione» e da unire col Notaio.
//
// Nel gioco i ritocchi stanno in tools/mappo.json (la fonte) e si riportano nei file del livello con
// tools/mappo_applica.py (lo Studio lo mette nel gioco al primo salvataggio, e lo aggancia a tools/make_level3.py
// perché una rigenerazione non li cancelli). Gli oggetti dei .tmj passano dalle "correzioni" di levels/rioni/index.json,
// che il gioco già applica al caricamento (src/systems/Rioni.js; per sprite e grandezza lo Studio aggiunge 4 righe).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { now, ensureDir, writeFileAtomic, clip, run } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APPLICA_SRC = path.join(HERE, 'mappo', 'mappo_applica.py');
export const APPLICA_VERSION = 1;
// Mappo è il Level Designer dello Studio (agente "level"): questo è il suo ufficio
export const MAPPO = 'level';
const LISTS = ['targets', 'props', 'items', 'hideouts', 'citizens', 'lights', 'events', 'places', 'landmarks'];
const SINGLES = ['player', 'exit'];
const TMJ_LAYERS = ['arredi', 'aperture', 'recinzioni'];
const SPRITE_NAME = /^[a-z0-9][a-z0-9_-]{0,60}\.png$/;

const gitOut = (args, cwd) => new Promise((resolve) => {
  const c = spawn('git', args, { cwd }); const out = [];
  c.stdout.on('data', (d) => out.push(d)); c.on('close', (code) => resolve({ code, buf: Buffer.concat(out) })); c.on('error', () => resolve({ code: 1, buf: Buffer.alloc(0) }));
});

// ─── ganci nel gioco (idempotenti): sprite e grandezza nelle correzioni, rilancio dopo make_level3 ────────────────
export const RIONI_ANCHOR = '        o._corretto = true;\n';
export const RIONI_PATCH = `        for (const k of ['sprite', 'size']) if (d[k] !== undefined) {   // Mappo (editor della mappa dello Studio): grafica e grandezza
          o.properties ??= [];
          const q = o.properties.find((p) => p.name === k);
          if (q) q.value = d[k]; else o.properties.push({ name: k, value: d[k] });
        }
        if (d.sprite !== undefined) o.properties.push({ name: 'sprite_fissa', value: true });   // scelta a mano: il tipo non la ridipinge
`;
export const RESKIN_LINE = '        if (nuovo) finishArredo(s, img, nuovo, lit); else reskinArredo(s, img, o.type, lit);\n';
export const RESKIN_PATCH = '        if (nuovo) finishArredo(s, img, nuovo, lit); else if (!p.sprite_fissa) reskinArredo(s, img, o.type, lit);   // sprite_fissa: grafica scelta a mano (Mappo)\n';
export const MAKE_ANCHOR = /\nif __name__ == '__main__':\n    main\(\)\n?/;
export const MAKE_PATCH = "\nif __name__ == '__main__':\n    main()\n    import mappo_applica   # Mappo (editor della mappa dello Studio): i ritocchi a mano tornano sopra la rigenerazione\n    mappo_applica.main()\n";

export function installHooks(root) {
  const notes = [];
  const ap = path.join(root, 'tools', 'mappo_applica.py');
  const src = fs.readFileSync(APPLICA_SRC, 'utf8');
  const cur = fs.existsSync(ap) ? fs.readFileSync(ap, 'utf8') : null;
  const ver = cur && Number((cur.match(/MAPPO_APPLICA (\d+)/) || [])[1]);
  if (!cur || ver < APPLICA_VERSION) { ensureDir(path.dirname(ap)); fs.writeFileSync(ap, src); notes.push(cur ? 'aggiornato tools/mappo_applica.py' : 'aggiunto tools/mappo_applica.py (riporta i ritocchi di Mappo nei file del livello)'); }
  const rj = path.join(root, 'src', 'systems', 'Rioni.js');
  if (fs.existsSync(rj)) {
    const t = fs.readFileSync(rj, 'utf8');
    if (!t.includes('sprite_fissa')) {
      const i = t.indexOf(RIONI_ANCHOR), j = t.indexOf(RESKIN_LINE);
      if (i >= 0 && t.indexOf(RIONI_ANCHOR, i + 1) < 0 && j > i && t.indexOf(RESKIN_LINE, j + 1) < 0) {
        fs.writeFileSync(rj, t.slice(0, i) + RIONI_PATCH + t.slice(i, j) + RESKIN_PATCH + t.slice(j + RESKIN_LINE.length));
        notes.push('src/systems/Rioni.js: le correzioni ora possono cambiare anche grafica e grandezza degli arredi (e la grafica scelta a mano non viene ridipinta)');
      } else notes.push('ATTENZIONE: non trovo in src/systems/Rioni.js i punti dove aggiungere grafica e grandezza alle correzioni: gli spostamenti valgono, i cambi di grafica degli oggetti dei rioni no');
    }
  }
  const mk = path.join(root, 'tools', 'make_level3.py');
  if (fs.existsSync(mk)) {
    const t = fs.readFileSync(mk, 'utf8');
    if (!t.includes('mappo_applica')) {
      if (MAKE_ANCHOR.test(t)) { fs.writeFileSync(mk, t.replace(MAKE_ANCHOR, MAKE_PATCH)); notes.push('tools/make_level3.py rilancia i ritocchi di Mappo alla fine'); }
      else notes.push('ATTENZIONE: tools/make_level3.py non ha il solito finale: una rigenerazione potrebbe cancellare i ritocchi (rilancia python3 tools/mappo_applica.py dopo)');
    }
  }
  return notes;
}

// ─── unione delle modifiche dell'editor in tools/mappo.json ─────────────────────────────────────────────────────
const near = (o, p, r = 1) => !!(o && p && Math.hypot(o.x - p[0], o.y - p[1]) <= r);
const num = (v, d = 2) => Math.round(Number(v) * 10 ** d) / 10 ** d;

function cleanA(a) {
  if (a === null) return null;
  const out = {};
  for (const k of ['x', 'y', 'rotation', 'scale', 'size', 'w', 'h', 'r', 'radius']) if (a[k] !== undefined) out[k] = a[k] === null ? null : num(a[k]);
  if (a.type !== undefined) out.type = String(a.type).slice(0, 160);
  return out;
}

export function mergeEdits(m, edits = {}) {
  m.correzioni ??= {}; m.livello ??= []; m.aggiunti ??= [];
  const lines = [];
  for (const [k, v] of Object.entries(edits.tmj || {})) {
    if (!/^[a-z0-9_]+\/\d+$/.test(k)) throw new Error(`oggetto sconosciuto: ${k}`);
    const c = {};
    if (v?.rimuovi) c.rimuovi = true;
    else {
      for (const f of ['dx', 'dy', 'rotation', 'size']) if (v?.[f] !== undefined && v[f] !== null && Number.isFinite(Number(v[f]))) c[f] = num(v[f]);
      if (c.dx === 0) delete c.dx; if (c.dy === 0) delete c.dy;
      if (v?.sprite) c.sprite = String(v.sprite).slice(0, 160);
    }
    m.correzioni[k] = c;
    lines.push(`${k}${v?.label ? ` (${v.label})` : ''}: ${c.rimuovi ? 'tolto' : [c.dx || c.dy ? 'spostato' : '', c.rotation !== undefined ? `girato a ${c.rotation}°` : '', c.sprite ? 'grafica nuova' : '', c.size ? `grandezza ${c.size}` : ''].filter(Boolean).join(', ') || 'rimesso com\'era'}`);
  }
  for (const e of edits.level || []) {
    const lista = String(e.lista || '');
    if (![...LISTS, ...SINGLES].includes(lista)) throw new Error(`lista sconosciuta: ${lista}`);
    const a = cleanA(e.a ?? null);
    const da = Array.isArray(e.da) ? [num(e.da[0]), num(e.da[1])] : null;
    // un elemento già toccato da Mappo: si aggiorna la sua voce (il "da" resta quello originale)
    const prev = m.livello.find((x) => x.lista === lista && (e.id != null ? x.id === e.id : (SINGLES.includes(lista) || (x.a && near(x.a, da)))));
    const added = !SINGLES.includes(lista) && e.id == null && m.aggiunti.find((x) => x.lista === lista && near(x.voce, da) && (!e.tipo || x.voce.type === e.tipo));
    if (added && a === null) { m.aggiunti.splice(m.aggiunti.indexOf(added), 1); }
    else if (added) { Object.assign(added.voce, a); }
    if (prev) prev.a = a === null ? null : { ...(prev.a || {}), ...a };
    else m.livello.push({ lista, ...(e.id != null ? { id: e.id } : {}), ...(e.tipo ? { tipo: e.tipo } : {}), ...(da ? { da } : {}), a });
    lines.push(`${lista === 'targets' ? 'bersaglio' : lista === 'props' ? 'arredo' : lista} ${e.label || e.id || e.tipo || ''}: ${a === null ? 'tolto' : [a.x !== undefined ? 'spostato' : '', a.rotation !== undefined ? `girato a ${a.rotation}°` : '', a.type ? 'grafica nuova' : '', a.scale !== undefined ? `scala ${a.scale}` : ''].filter(Boolean).join(', ')}`);
  }
  for (const n of edits.add || []) {
    const v = n.voce || {};
    if (!v.type || !Number.isFinite(Number(v.x)) || !Number.isFinite(Number(v.y))) throw new Error('arredo nuovo senza tipo o posto');
    const voce = { type: String(v.type).slice(0, 160), x: num(v.x), y: num(v.y), centered: true, ...(v.rotation ? { rotation: num(v.rotation) } : {}), ...(v.scale && v.scale !== 1 ? { scale: num(v.scale, 4) } : {}) };
    m.aggiunti.push({ lista: 'props', voce });
    lines.push(`arredo nuovo ${n.label || voce.type} a (${Math.round(voce.x)}, ${Math.round(voce.y)})`);
  }
  return lines;
}

export class MappoOffice {
  constructor({ orch, git, store, events, agents, projectRoot, dataDir }) {
    Object.assign(this, { orch, git, store, events, agents, projectRoot, dataDir });
    this.pendingDir = ensureDir(path.join(dataDir, 'mappo-pending'));
  }
  get S() { return this.store.data; }
  // lo stato dell'agente nell'ufficio: solo se non sta già lavorando a un task suo (non gli si ruba il posto)
  status(id, st, o) {
    const r = this.agents.get(id)?.runtime;
    if (!r) return;
    if (st !== 'IDLE') { if (r.status !== 'IDLE') return; this.busy = { ...(this.busy || {}), [id]: true }; }
    else { if (!this.busy?.[id]) return; delete this.busy[id]; }
    this.agents.setStatus(id, st, o);
  }

  drafts() {
    return Object.values(this.S.requests).filter((r) => r.mappo && r.worktree && fs.existsSync(r.worktree) && !r.merged && !r.discarded)
      .sort((a, b) => b.id.localeCompare(a.id)).map((r) => ({ id: r.id, text: r.text, status: r.status, queued: !!r.mergeQueued, at: r.updatedAt || r.createdAt }));
  }

  source(src) {
    if (!src || src === 'main') return { cwd: this.projectRoot, play: '/play/main/', req: null };
    const r = this.S.requests[src];
    if (!r?.mappo || !r.worktree || !fs.existsSync(r.worktree) || r.discarded) throw new Error(`la bozza ${src} non c'è più`);
    return { cwd: r.worktree, play: `/play/${r.id}/`, req: r };
  }

  async scene(src) {
    const { cwd, play, req } = this.source(src);
    const show = async (rel, need = true) => {
      const g = await gitOut(['show', `HEAD:${rel}`], cwd);
      if (g.code !== 0) { if (need) throw new Error(`nel gioco manca ${rel}`); return null; }
      return JSON.parse(g.buf.toString('utf8'));
    };
    const idx = await show('levels/rioni/index.json').catch(() => { throw new Error('nel gioco non c\'è la mappa a rioni (levels/rioni/index.json): l\'Ufficio di Mappo lavora sul Livello 3'); });
    const tmj = {};
    for (const r of idx.rioni || []) {
      const t = await show(`levels/rioni/${r.tmj}`);
      tmj[r.id] = {
        width: t.width, height: t.height, tilewidth: t.tilewidth,
        tileset: (({ firstgid, columns, tilewidth, tileheight, tilecount }) => ({ firstgid, columns, tilewidth, tileheight, tilecount }))(t.tilesets?.[0] || {}),
        suolo: t.layers.find((l) => l.name === 'suolo')?.data || [],
        objects: Object.fromEntries(t.layers.filter((l) => l.type === 'objectgroup').map((l) => [l.name, l.objects || []])),
      };
    }
    const lvl = (await show('levels/level3.json', false)) || {};
    const level = Object.fromEntries([...LISTS, ...SINGLES, 'rioniClaimed'].map((k) => [k, lvl[k] ?? null]));
    level.citizens = (level.citizens || []).map((c) => ({ id: c.id, nameId: c.nameId, x: c.x, y: c.y, rione: c.rione, waypoints: c.waypoints || [] }));
    const manifests = [];
    for (const f of ['assets/props/borgo_t0217/manifest.json', 'assets/props/borgo_t0227/manifest.json']) { const m = await show(f, false); if (m) manifests.push(m); }
    const ls = (await gitOut(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'levels/rioni/sprite_nuovi', 'assets/props'], cwd)).buf.toString().split('\n').filter(Boolean);
    const spritesNuovi = ls.filter((f) => f.startsWith('levels/rioni/sprite_nuovi/') && f.endsWith('.png')).map((f) => f.slice('levels/rioni/'.length));
    const gameKeys = ls.filter((f) => /^assets\/props\/[^/]+\.png$/.test(f)).map((f) => f.slice('assets/props/'.length, -4));
    const strings = await show('strings/it.json', false) || {};
    const names = {};
    for (const c of level.citizens) if (strings[c.nameId]) names[c.nameId] = strings[c.nameId];
    for (const l of level.landmarks || []) if (l.nameId && strings[l.nameId]) names[l.nameId] = strings[l.nameId];
    const base = (await gitOut(['rev-parse', 'HEAD'], cwd)).buf.toString().trim();
    const pending = fs.readdirSync(this.pendingDir).filter((f) => SPRITE_NAME.test(f));
    return { src: req ? req.id : 'main', play, base, drafts: this.drafts(), draft: req ? { id: req.id, text: req.text, queued: !!req.mergeQueued } : null,
      idx, tmj, level, mappo: await show('tools/mappo.json', false), manifests, spritesNuovi, gameKeys, names, pending, layers: TMJ_LAYERS };
  }

  // una sprite nuova (disegnata da Cosetta o caricata da te), in attesa del salvataggio: data/mappo-pending/<nome>.png
  savePending(name, dataUrl) {
    name = String(name || '').toLowerCase().replace(/\.png$/, '').replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || `sprite_${Date.now().toString(36)}`;
    const mm = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!mm) throw new Error('serve un PNG');
    const buf = Buffer.from(mm[1], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new Error('PNG troppo grande');
    let file = `${name}.png`, i = 2;
    while (fs.existsSync(path.join(this.pendingDir, file))) file = `${name}_${i++}.png`;
    fs.writeFileSync(path.join(this.pendingDir, file), buf);
    return { file, path: `sprite_nuovi/mappo/${file}`, url: `/mappo-pending/${file}` };
  }

  async save({ src, edits = {}, sprites = [], note = '' } = {}) {
    const nTot = Object.keys(edits.tmj || {}).length + (edits.level || []).length + (edits.add || []).length;
    if (!nTot) throw new Error('nessuna modifica da salvare');
    const orch = this.orch;
    let req = null;
    if (src && src !== 'main') {
      const r = this.S.requests[src];
      if (r?.mappo && r.worktree && fs.existsSync(r.worktree) && !r.merged && !r.discarded && !r.mergeQueued && !(r.followedBy && this.S.requests[r.followedBy])) req = r;
    }
    const started = Date.now();
    if (!req) {
      req = { id: this.store.nextId('request', 'R'), text: `Mappo — ${clip(note || 'ritocchi alla mappa', 70)}`, status: 'RUNNING', mappo: true, createdAt: now(), taskIds: [], attachments: [] };
      this.S.requests[req.id] = req;
      this.store.save();
      this.events.emit('request.created', { request: req });
      try { await this.git.ensureWorktree(req); }
      catch (e) { orch.setRequest(req, { status: 'FAILED', error: e.message }); throw e; }
    } else orch.setRequest(req, { status: 'RUNNING' });
    const wt = req.worktree;
    this.status(MAPPO, 'WORKING', { task: { id: req.id, title: `Mappa: ${clip(note || 'ritocchi', 50)}` }, text: 'riporta i ritocchi nella mappa', semantic: 'agent.editing' });
    try {
      const notes = installHooks(wt);
      for (const s of sprites) {
        const f = path.basename(String(s));
        if (!SPRITE_NAME.test(f) || !fs.existsSync(path.join(this.pendingDir, f))) continue;
        const dest = path.join(wt, 'levels', 'rioni', 'sprite_nuovi', 'mappo', f);
        ensureDir(path.dirname(dest)); fs.copyFileSync(path.join(this.pendingDir, f), dest);
      }
      const mf = path.join(wt, 'tools', 'mappo.json');
      const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : {};
      const lines = mergeEdits(m, edits);
      const out = { _nota: 'Ritocchi a mano della mappa del Livello 3, fatti nell\'Ufficio di Mappo dello Studio. Si riportano nei file del livello con: python3 tools/mappo_applica.py (lo fa anche tools/make_level3.py alla fine).', correzioni: m.correzioni, livello: m.livello, aggiunti: m.aggiunti };
      writeFileAtomic(mf, JSON.stringify(out, null, 1) + '\n');
      const py = await run('python3', ['tools/mappo_applica.py'], { cwd: wt, timeoutMs: 60000 });
      if (py.code !== 0) throw new Error(`python3 tools/mappo_applica.py non è andato: ${(py.stderr || py.stdout).trim().slice(-600)}`);
      const agent = this.agents.get(MAPPO) || { id: MAPPO, name: 'Mappo' };
      const summary = [...lines.slice(0, 40), lines.length > 40 ? `…e altri ${lines.length - 40}` : '', ...notes].filter(Boolean).join('\n');
      const c = await this.git.commitAll(wt, { agent, task: { id: `${req.id}-M${(req.mappoSaves || 0) + 1}`, title: `Mappa: ${clip(note || `${lines.length} ritocchi`, 80)}` }, request: req, summary });
      const diff = await this.git.diffSummary(wt, req.baseCommit);
      const history = [...(req.mappoLines || []), ...lines];
      const prose = [`Mappo ha riportato nella mappa ${history.length === 1 ? 'un ritocco' : `${history.length} ritocchi`} (non ancora testati dal QA: provali nel Livello 3).`, ...history.slice(-30).map((l) => `• ${l}`), ...notes.map((n) => `• ${n}`)].join('\n');
      const report = { request: req.text, result: 'PASS', branch: req.branch, baseBranch: req.baseBranch, baseCommit: req.baseCommit?.slice(0, 7), filesChanged: diff.files, commits: diff.commits.map((x) => `${x.short} ${x.author}: ${x.subject}`), summaries: [], tests: [], prose, stat: diff.stat, createdAt: now(), outputs: [] };
      orch.setRequest(req, { status: 'DONE', result: 'PASS', report, finishedAt: now(), mappoSaves: (req.mappoSaves || 0) + 1, mappoLines: history });
      orch.work?.(MAPPO, { ok: true, ms: Date.now() - started, kind: 'mappa' });
      orch.chat('agent', `${c ? '' : '(niente di nuovo da salvare) '}${prose}\n\nProvala con «Prova questa versione» (Livello 3); se va bene, «Unisci al gioco».${req.mappoSaves > 1 ? ` Altri salvataggi dall'Ufficio di Mappo finiscono in questa stessa bozza finché non la unisci.` : ''}`, { agentId: this.agents.get(MAPPO) ? MAPPO : 'director', requestId: req.id, kind: 'report', report });
      this.status(MAPPO, 'IDLE', { task: null, text: `bozza ${req.id} salvata` });
      return { request: req, lines, notes, commit: c?.short || null };
    } catch (e) {
      this.status(MAPPO, 'IDLE', { task: null, text: `salvataggio non riuscito: ${clip(e.message, 120)}` });
      if (!req.report) orch.setRequest(req, { status: 'FAILED', error: e.message });
      else orch.setRequest(req, { status: 'DONE' });
      throw e;
    }
  }

  // ─── Cosetta: una sprite nuova vista dall'alto, nello stile di quella che c'è ─────────────────────────────────
  async cosettaOptions() {
    const art = this.agents.get('art') || this.agents.forKind?.('avatars') || { provider: 'auto' };
    const opts = (await this.orch.imageOptions(art)).filter((o) => !o.plan);
    const def = await this.orch.imageFor(art, null).catch(() => null);
    return { artist: art.name || 'Cosetta', options: opts.map((o) => ({ id: o.id, label: o.label, price: o.price })), default: def && !def.plan ? def.id : opts[0]?.id || null };
  }

  async cosetta({ text, ref, w, h, choice, label } = {}) {
    text = String(text || '').trim();
    if (!text) throw new Error('scrivi a Cosetta cosa disegnare');
    const art = this.agents.get('art') || { id: 'art', name: 'Cosetta', provider: 'auto' };
    const opts = (await this.orch.imageOptions(art)).filter((o) => !o.plan);
    const pick = opts.find((o) => o.id === choice) || opts[0];
    if (!pick) throw new Error('Per far disegnare Cosetta serve un generatore di immagini: metti OPENAI_API_KEY o GEMINI_API_KEY nel file .env dello Studio.');
    let refFile = null;
    const relRef = String(ref || '').replace(/^\/+/, '');
    if (relRef && !relRef.includes('..') && /\.(png|jpe?g|webp)$/i.test(relRef)) {
      const f = path.join(this.projectRoot, relRef);
      if (f.startsWith(path.resolve(this.projectRoot)) && fs.existsSync(f)) refFile = f;
    }
    const ratio = w && h ? (w / h > 1.25 ? 'wider than tall' : h / w > 1.25 ? 'taller than wide' : 'about square') : 'about square';
    const prompt = [
      `Game sprite for "Terraqualcosa", a top-down pixel-art game set in a small Italian hill village: ${text}.`,
      `Seen exactly from above (90° top-down, no perspective, no horizon), a single object centered in the frame, ${ratio} (in game it is about ${Math.round(w || 32)}×${Math.round(h || 32)} px).`,
      refFile ? 'Match the reference image exactly in art style, palette, outline thickness, lighting from the top-left and level of detail: it is the sprite this one replaces or sits next to.' : 'Warm, painterly pixel art with a dark outline, light from the top-left.',
      'No text, no labels, no frame, no ground, no cast shadow outside the object.',
      pick.prov.id === 'openai-image' ? 'Transparent background.' : 'Flat pure magenta (#FF00FF) background, nothing else in the image.',
    ].join(' ');
    this.status('art', 'WORKING', { task: { id: 'mappo', title: `Sprite per Mappo: ${clip(label || text, 40)}` }, text: `disegna per Mappo: ${clip(text, 80)}`, semantic: 'agent.editing' });
    const started = Date.now();
    try {
      const g = await pick.prov.generate({ ...pick.opts, prompt, size: '1024x1024', references: refFile ? [refFile] : [], ...(pick.prov.id === 'openai-image' ? { background: 'transparent' } : {}) });
      if (!g.ok) throw new Error(`${art.name || 'Cosetta'} non è riuscita a disegnarla: ${g.error}`);
      this.orch.work?.('art', { ok: true, ms: Date.now() - started, kind: 'sprite per Mappo' });
      const file = `raw_${Date.now().toString(36)}.png`;
      const dir = ensureDir(path.join(this.pendingDir, 'raw'));
      fs.writeFileSync(path.join(dir, file), g.png);
      this.status('art', 'IDLE', { task: null, text: 'sprite per Mappo pronta' });
      return { url: `/mappo-pending/raw/${file}`, chroma: pick.prov.id !== 'openai-image', provider: pick.label, price: pick.price };
    } catch (e) {
      this.status('art', 'IDLE', { task: null, text: clip(e.message, 120) });
      throw e;
    }
  }
}
