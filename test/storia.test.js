// Ufficio della Storia: lettura della lavagna, confronto coi flag del gioco, richieste che la cambiano
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixtureRepo, ScriptedProvider, registryWith, studioFor, sh, waitFor, planJSON } from './helpers.js';
import { flagsOf, checkStoria, STORIA_FILE } from '../server/storia.js';
import { taskPrompt } from '../server/prompts.js';

const w = (root, f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), typeof c === 'string' ? c : JSON.stringify(c, null, 1)); };

const STORIA = {
  aggiornata: { gioco: '0.1.0' },
  missioni: [
    { id: 'inizio', titolo: 'Inizio', tipo: 'principale', stato: 'nel gioco', flag: ['porta_aperta'], soluzioni: [{ id: 'apri', titolo: 'Apri la porta', etica: 'alta', sblocca: ['fine'], flag: ['porta_aperta'] }] },
    { id: 'fine', titolo: 'Fine', tipo: 'finale', stato: 'progettata', richiede: ['inizio', 'flag:chiave>=1'], sottomissioni: [{ id: 'sub', titolo: 'Sotto', soluzioni: [{ id: 'x', titolo: 'X', sblocca: ['manca'] }] }] },
  ],
};

function repo({ storia = STORIA } = {}) {
  const root = makeFixtureRepo();
  w(root, 'levels/index.json', { levels: [{ id: 'l1', file: 'levels/l1.json' }] });
  w(root, 'levels/l1.json', { state: { chiave: 0 }, targets: [{ id: 't', verbs: { rompere: { set: { porta_aperta: true } } } }], dialoghi: [{ when: { amico: true } }] });
  w(root, 'src/systems/Cosa.js', "export const f = (st) => st.set('codice_flag', 1);\n");
  if (storia) w(root, STORIA_FILE, storia);
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'storia');
  return root;
}

test('flagsOf e checkStoria: flag dai livelli e dal codice, rimandi rotti', () => {
  const f = flagsOf([{ state: { a: 1 }, x: [{ when: { b: true }, set: { c: '+1' } }], y: { requires: [{ d: 1 }] } }], "st.get('e') state.set(\"f\"");
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(f.has(k), k);
  const c = checkStoria(STORIA);
  assert.deepEqual(c.problems, ['sub › x: sblocca «manca», che non c\'è']);
  assert.ok(checkStoria({ missioni: [{ id: 'a' }, { id: 'a' }] }).problems.some((p) => /doppio/.test(p)));
});

test('scene: lavagna, flag del gioco, versione, avviso se è rimasta indietro', async () => {
  const root = repo();
  const st = await studioFor(root, registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));
  let sc = await st.storia.scene();
  assert.equal(sc.storia.missioni.length, 2);
  assert.equal(sc.version, '0.1.0');
  assert.ok(sc.flags.includes('porta_aperta') && sc.flags.includes('chiave') && sc.flags.includes('codice_flag') && sc.flags.includes('amico'));
  assert.equal(sc.problems.length, 1);
  assert.equal(sc.stale.commits, 0);
  assert.ok(sc.agents.puzzle && sc.agents.lore);
  w(root, 'levels/l1.json', { state: { chiave: 1 } }); sh(root, 'commit', '-qam', 'livello cambiato');
  sc = await st.storia.scene();
  assert.equal(sc.stale.commits, 1, 'un cambio ai livelli dopo la lavagna');
  // più lavagne: la principale per prima, le altre (STORIA_<nome>.json) scegliibili; un file a caso no
  w(root, 'docs/memoria/STORIA_altri.json', { titolo: 'Prototipi', missioni: [{ id: 'p1', titolo: 'P1', tipo: 'principale' }] }); sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'altra');
  const sb = await st.storia.scene('main', 'docs/memoria/STORIA_altri.json');
  assert.deepEqual(sb.boards.map((b) => [b.file, b.main]), [[STORIA_FILE, true], ['docs/memoria/STORIA_altri.json', false]]);
  assert.equal(sb.storia.titolo, 'Prototipi');
  assert.equal((await st.storia.scene('main', '../../etc/passwd')).file, STORIA_FILE);
  // lavagna rotta e lavagna assente
  w(root, STORIA_FILE, '{ rotto'); sh(root, 'commit', '-qam', 'rotta');
  assert.match((await st.storia.scene()).parseError, /JSON|token|property/i);
  const empty = await studioFor(repo({ storia: null }), registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));
  const e = await empty.storia.scene();
  assert.equal(e.storia, null);
  assert.equal(e.parseError, null);
});

test('prompt: richiesta nuova (niente smistamento) segnata come storia, con lo schema nei task di Enigma e Custode', async () => {
  const root = repo();
  const plan = planJSON([{ key: 'p', agent: 'puzzle', kind: 'puzzle', title: 'nuova soluzione', instructions: 'aggiorna' }], 'ok');
  const prov = new ScriptedProvider('mock', () => plan);
  const st = await studioFor(root, registryWith(prov));
  const r = await st.storia.prompt({ text: 'aggiungi una soluzione', node: { kind: 'missione', id: 'inizio', titolo: 'Inizio' } });
  const req = st.store.data.requests[r.request.id];
  assert.equal(req.storia, true);
  assert.equal(req.storiaNode, 'inizio');
  assert.match(req.text, /^\[Ufficio della Storia — per .+\] aggiungi una soluzione/);
  assert.match(req.text, /missione «Inizio» \(id inizio\)/);
  assert.ok(!/docs\/memoria\/STORIA\.json è la mappa/.test(st.store.data.chat.at(-1)?.text || ''), 'lo schema non finisce nella chat');
  const p = taskPrompt({ task: { id: 'T-1', title: 't', kind: 'implement' }, req, agent: { name: 'A', role: 'r' }, deps: [], contextList: '' });
  assert.match(p, /La lavagna della storia/);
  const p2 = taskPrompt({ task: { id: 'T-1', title: 't', kind: 'implement' }, req: { id: 'R-9', text: 'x' }, agent: { name: 'A', role: 'r' }, deps: [], contextList: '' });
  assert.ok(!/La lavagna della storia/.test(p2), 'agli altri task no');
  const rb = await st.storia.prompt({ mode: 'rebuild' });
  assert.match(st.store.data.requests[rb.request.id].text, /Ricostruisci la lavagna/);
  await assert.rejects(st.storia.prompt({ text: '  ' }), /scrivi/);
  await waitFor(() => (st.storia.related().length >= 2), 3000, 'richieste sulla storia');
});
