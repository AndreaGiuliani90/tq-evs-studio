// Ufficio di Mappo: unione dei ritocchi, ganci nel gioco, salvataggio come versione da provare, Cosetta
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtureRepo, ScriptedProvider, registryWith, studioFor, sh } from './helpers.js';
import { mergeEdits, installHooks, RIONI_ANCHOR, RESKIN_LINE } from '../server/mappo.js';

const hasPython = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
const w = (root, f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), typeof c === 'string' ? c : JSON.stringify(c, null, 1)); };

// un gioco finto con un rione, un livello a rioni, Rioni.js e make_level3.py con i punti dove agganciarsi
function rioniRepo() {
  const root = makeFixtureRepo();
  w(root, 'levels/rioni/index.json', { rioni: [{ id: 'nord', tmj: 'rione_nord/rione_nord.tmj', tileset: 'rione_nord/t.png', immagini: [], griglia: [0, 0] }], spazio: 240, arredi: { _default: { solido: true } }, correzioni: { 'nord/2': { dx: 3 } }, sprites: ['sprite_nuovi/vaso.png'] });
  w(root, 'levels/rioni/rione_nord/rione_nord.tmj', { width: 4, height: 3, tilewidth: 24, tilesets: [{ firstgid: 1, columns: 1, tilewidth: 24, tileheight: 24, tilecount: 1 }],
    layers: [{ name: 'suolo', type: 'tilelayer', data: Array(12).fill(1) }, { name: 'arredi', type: 'objectgroup', objects: [{ id: 2, name: 'vaso', type: 'pot', x: 30, y: 30, point: true, properties: [{ name: 'sprite', type: 'string', value: '../sprite_nuovi/vaso' }] }] }] });
  w(root, 'levels/rioni/sprite_nuovi/vaso.png', 'png');
  w(root, 'levels/level3.json', { rioni: 'levels/rioni/index.json', player: { x: 10, y: 10 }, targets: [{ id: 'bici', type: 'bike', x: 50, y: 40, centered: true }, { id: 'lampione_1', type: 'lamp', x: 60, y: 20, lightAt: { x: 60, y: 20 } }],
    props: [{ type: 'bench', x: 40, y: 60, centered: true }], lights: [{ x: 60, y: 20, radius: 100 }],
    citizens: [{ id: 'npc_a', nameId: 'npc_a', x: 20, y: 20, waypoints: [{ x: 20, y: 20 }, { x: 30, y: 20 }], schedule: [{ waypoints: [{ x: 20, y: 20 }] }] }] });
  w(root, 'src/systems/Rioni.js', `export default class Rioni {\n  constructor() {\n    for (const [k, d] of Object.entries(idx.correzioni ?? {})) {\n      for (const o of []) {\n        o.x += d.dx ?? 0;\n${RIONI_ANCHOR}      }\n    }\n  }\n  addProps() {\n    for (const o of []) {\n${RESKIN_LINE}    }\n  }\n}\n`);
  w(root, 'tools/make_level3.py', "def main():\n    pass\n\nif __name__ == '__main__':\n    main()\n");
  w(root, 'strings/it.json', { npc_a: 'Persona A' });
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'rioni');
  return root;
}

test('mergeEdits: correzioni finali, spostamenti a catena col "da" originale, aggiunti tolti', () => {
  const m = {};
  mergeEdits(m, { tmj: { 'nord/2': { dx: 10, dy: 0, rotation: 90, sprite: 'gioco:siepe_2', size: 30, label: 'vaso' } } });
  assert.deepEqual(m.correzioni['nord/2'], { dx: 10, rotation: 90, sprite: 'gioco:siepe_2', size: 30 });
  mergeEdits(m, { tmj: { 'nord/2': { rimuovi: true } } });
  assert.deepEqual(m.correzioni['nord/2'], { rimuovi: true });
  // un arredo del livello spostato due volte: una voce sola, "da" resta quello di partenza
  mergeEdits(m, { level: [{ lista: 'props', tipo: 'bench', da: [40, 60], a: { x: 48, y: 60 } }] });
  mergeEdits(m, { level: [{ lista: 'props', tipo: 'bench', da: [48, 60], a: { x: 50, y: 70, rotation: 90 } }] });
  assert.equal(m.livello.length, 1);
  assert.deepEqual(m.livello[0], { lista: 'props', tipo: 'bench', da: [40, 60], a: { x: 50, y: 70, rotation: 90 } });
  // un arredo aggiunto, poi spostato, poi tolto: sparisce dagli aggiunti e resta la voce che lo toglie dal livello
  mergeEdits(m, { add: [{ voce: { type: 'siepe', x: 100, y: 100 } }] });
  mergeEdits(m, { level: [{ lista: 'props', tipo: 'siepe', da: [100, 100], a: { x: 110, y: 100 } }] });
  assert.equal(m.aggiunti[0].voce.x, 110);
  mergeEdits(m, { level: [{ lista: 'props', tipo: 'siepe', da: [110, 100], a: null }] });
  assert.equal(m.aggiunti.length, 0);
  assert.ok(m.livello.some((e) => e.tipo === 'siepe' && e.a === null));
  assert.throws(() => mergeEdits(m, { tmj: { '../x': {} } }), /sconosciuto/);
  assert.throws(() => mergeEdits(m, { level: [{ lista: 'walls', a: null }] }), /lista sconosciuta/);
});

test('installHooks: aggancia Rioni.js e make_level3.py una volta sola, e avvisa se non trova i punti', () => {
  const root = rioniRepo();
  const n1 = installHooks(root);
  assert.equal(n1.length, 3);
  const rj = fs.readFileSync(path.join(root, 'src/systems/Rioni.js'), 'utf8');
  assert.match(rj, /sprite_fissa/);
  assert.match(rj, /else if \(!p\.sprite_fissa\) reskinArredo/);
  assert.match(fs.readFileSync(path.join(root, 'tools/make_level3.py'), 'utf8'), /mappo_applica\.main\(\)/);
  assert.deepEqual(installHooks(root), []);
  if (hasPython) execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(root, 'tools/make_level3.py')]);
  const other = rioniRepo();
  fs.writeFileSync(path.join(other, 'src/systems/Rioni.js'), 'export default class Rioni {}\n');
  assert.ok(installHooks(other).some((x) => /ATTENZIONE/.test(x)));
});

test('Mappo: scena, salvataggio come versione da provare (stessa bozza per i salvataggi dopo), unione', { skip: !hasPython && 'serve python3' }, async () => {
  const root = rioniRepo();
  const st = await studioFor(root, registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));
  const sc = await st.mappo.scene('main');
  assert.deepEqual(Object.keys(sc.tmj), ['nord']);
  assert.equal(sc.level.targets.length, 2);
  assert.equal(sc.names.npc_a, 'Persona A');
  assert.ok(sc.spritesNuovi.includes('sprite_nuovi/vaso.png'));
  await assert.rejects(st.mappo.save({ src: 'main', edits: {} }), /nessuna modifica/);

  const pend = st.mappo.savePending('Vaso Nuovo!', `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);
  assert.equal(pend.path, 'sprite_nuovi/mappo/vaso_nuovo.png');
  const r1 = await st.mappo.save({ src: 'main', note: 'prima prova', sprites: [pend.file], edits: {
    tmj: { 'nord/2': { dx: 13, dy: 0, sprite: `../${pend.path}`, size: 20 } },
    level: [{ lista: 'targets', id: 'lampione_1', da: [60, 20], a: { x: 70, y: 25 } },
      { lista: 'citizens', id: 'npc_a', da: [20, 20], a: { x: 25, y: 20 } },
      { lista: 'props', tipo: 'bench', da: [40, 60], a: { rotation: 90 } }],
    add: [{ voce: { type: 'siepe', x: 80, y: 80 } }],
  } });
  const req = st.store.data.requests[r1.request.id];
  assert.equal(req.mappo, true);
  assert.equal(req.status, 'DONE');
  assert.ok(req.report.commits.length >= 1);
  assert.match(req.report.prose, /ritocchi/);
  const wt = req.worktree;
  const L = JSON.parse(fs.readFileSync(path.join(wt, 'levels/level3.json'), 'utf8'));
  const idx = JSON.parse(fs.readFileSync(path.join(wt, 'levels/rioni/index.json'), 'utf8'));
  assert.deepEqual(idx.correzioni['nord/2'], { dx: 13, sprite: '../sprite_nuovi/mappo/vaso_nuovo.png', size: 20 });
  assert.ok(idx.sprites.includes('sprite_nuovi/mappo/vaso_nuovo.png'), 'la sprite nuova entra fra quelle da caricare');
  assert.ok(fs.existsSync(path.join(wt, 'levels/rioni/sprite_nuovi/mappo/vaso_nuovo.png')));
  const lamp = L.targets.find((t) => t.id === 'lampione_1');
  assert.deepEqual([lamp.x, lamp.y, lamp.lightAt.x], [70, 25, 70]);
  assert.deepEqual([L.lights[0].x, L.lights[0].y], [70, 25], 'la luce segue il lampione');
  const npc = L.citizens[0];
  assert.deepEqual([npc.x, npc.waypoints[1].x, npc.schedule[0].waypoints[0].x], [25, 35, 25], 'la persona si porta dietro il suo giro');
  assert.equal(L.props[0].rotation, 90);
  assert.equal(L.props[0].x, 40);
  assert.ok(L.props.some((p) => p.type === 'siepe' && p.x === 80));
  // il gioco nella cartella dell'utente non è toccato
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'levels/level3.json'), 'utf8')).targets[1].x, 60);
  // idempotente: rilanciare l'applicazione non cambia niente
  const before = fs.readFileSync(path.join(wt, 'levels/level3.json'), 'utf8');
  execFileSync('python3', ['tools/mappo_applica.py'], { cwd: wt });
  assert.equal(fs.readFileSync(path.join(wt, 'levels/level3.json'), 'utf8'), before);

  // la scena della bozza vede i ritocchi; un secondo salvataggio va nella stessa richiesta
  const sc2 = await st.mappo.scene(req.id);
  assert.equal(sc2.draft.id, req.id);
  assert.equal(sc2.drafts.length, 1);
  assert.ok(sc2.mappo.correzioni['nord/2']);
  const r2 = await st.mappo.save({ src: req.id, edits: { level: [{ lista: 'props', tipo: 'siepe', da: [80, 80], a: null }] } });
  assert.equal(r2.request.id, req.id);
  const L2 = JSON.parse(fs.readFileSync(path.join(wt, 'levels/level3.json'), 'utf8'));
  assert.ok(!L2.props.some((p) => p.type === 'siepe'));
  assert.equal(req.mappoSaves, 2);
  assert.ok(st.store.data.chat.some((m) => m.agentId === 'level' && m.kind === 'report'));

  // si unisce come le altre richieste (dal Notaio)
  await st.orch.merge(req.id);
  assert.equal(req.merged, true);
  assert.ok(fs.existsSync(path.join(root, 'tools/mappo.json')));
  const sc3 = await st.mappo.scene('main');
  assert.equal(sc3.drafts.length, 0);
  assert.equal(sc3.level.targets.find((t) => t.id === 'lampione_1').x, 70);
});

test('Mappo: Cosetta disegna con il generatore a pagamento (conta la spesa), senza chiavi lo dice', async () => {
  const root = rioniRepo();
  const img = { id: 'openai-image', kind: 'image', label: 'GPT', quality: 'medium', calls: [], async available() { return { ok: true }; }, async generate(o) { this.calls.push(o); return { ok: true, png: Buffer.from('IMG') }; } };
  const st = await studioFor(root, registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' })), img));
  const o = await st.mappo.cosettaOptions();
  assert.ok(o.options.length >= 1 && !o.options.some((x) => x.id === 'plan'));
  const r = await st.mappo.cosetta({ text: 'una panchina di pietra', ref: 'levels/rioni/sprite_nuovi/vaso.png', w: 30, h: 12, choice: o.options[0].id });
  assert.match(r.url, /^\/mappo-pending\/raw\/raw_/);
  assert.equal(r.chroma, false);
  assert.equal(img.calls[0].background, 'transparent');
  assert.equal(img.calls[0].references.length, 1, 'la sprite di adesso fa da riferimento di stile');
  assert.match(img.calls[0].prompt, /top-down/);
  assert.ok(st.orch.costs.summary().totalUsd > 0, 'la spesa entra nel contatore');

  const root2 = rioniRepo();
  const st2 = await studioFor(root2, registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));
  await assert.rejects(st2.mappo.cosetta({ text: 'x' }), /OPENAI_API_KEY o GEMINI_API_KEY/);
});
