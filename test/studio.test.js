import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeFixtureRepo, ScriptedProvider, registryWith, studioFor, waitFor, planJSON, sh } from './helpers.js';
import { createServer } from '../server/app.js';
import { extractJSON } from '../server/util.js';
import { AnthropicProvider } from '../server/providers/anthropic.js';
import { staticChecks } from '../qa/game-test.mjs';

const PLAN = [
  { key: 't1', agent: 'dev', kind: 'implement', title: 'Aggiungi feature', instructions: 'crea src/feature.js', dependsOn: [] },
  { key: 't2', agent: 'qa', kind: 'test', title: 'Verifica feature', instructions: 'controlla src/feature.js', dependsOn: ['t1'] },
];

// dev: al primo giro scrive un BUG, alla correzione lo toglie. qa: verdetto dal harness (passato nel prompt)
function studioProvider({ devAlwaysBug = false } = {}) {
  let devRuns = 0;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return o.prompt.includes('rapporto finale') ? { text: 'Rapporto.' } : planJSON(PLAN, 'Delego.');
    if (o.agent.id === 'dev') {
      devRuns++;
      o.onEvent({ type: 'tool', tool: 'Edit', input: { file_path: path.join(o.cwd, 'src/feature.js') } });
      fs.writeFileSync(path.join(o.cwd, 'src/feature.js'), (devAlwaysBug && !prov.fixed) || devRuns === 1 ? 'export const x = "BUG";\n' : 'export const x = 1;\n');
      return { text: 'fatto\n```json\n{"summary":"feature scritta","handoff":"guarda src/feature.js"}\n```' };
    }
    if (o.agent.id === 'qa') {
      const fail = /già eseguito[^\n]*\nVERDETTO HARNESS: FAIL/.test(o.prompt);
      return { text: '```json\n' + JSON.stringify({ verdict: fail ? 'FAIL' : 'PASS', summary: fail ? 'c\'è un BUG' : 'tutto ok', bugs: fail ? [{ title: 'BUG in feature.js', steps: 'leggi', expected: 'niente BUG', actual: 'BUG' }] : [] }) + '\n```' };
    }
    return { text: '{}' };
  });
  return prov;
}

test('agenti: caricati dai predefiniti, rinomina persistente dopo il riavvio', async () => {
  const root = makeFixtureRepo();
  const s1 = await studioFor(root, registryWith(studioProvider()));
  const ids = s1.agents.list().map((a) => a.id).sort();
  assert.deepEqual(ids, ['art', 'audio', 'dev', 'director', 'level', 'lore', 'narrative', 'office', 'puzzle', 'qa', 'strategist']);
  assert.equal(s1.agents.get('dev').name, 'Tizo');
  s1.agents.update('dev', { name: 'Pippo', role: 'Capo Codice', avatar: { emoji: '🦊' } });
  s1.store.flush();
  const s2 = await studioFor(root, registryWith(studioProvider()));
  assert.equal(s2.agents.get('dev').name, 'Pippo');
  assert.equal(s2.agents.get('dev').avatar.emoji, '🦊');
  assert.equal(s2.agents.get('dev').kinds.includes('implement'), true, 'le capacità restano: il routing non dipende dal nome');
  s2.agents.resetToDefault('dev');
  assert.equal(s2.agents.get('dev').name, 'Tizo');
});

test('flusso completo: Regia delega → Tizo implementa → Tizia FAIL → correzione → ritest PASS → rapporto', async () => {
  const root = makeFixtureRepo();
  fs.writeFileSync(path.join(root, 'mio-lavoro.txt'), 'lavoro non committato dell\'utente');   // non va toccato
  const s = await studioFor(root, registryWith(studioProvider()));
  const seen = [];
  s.events.on((e) => seen.push(e.type));
  const req = await s.orch.handleUserMessage('Aggiungi una feature di prova');
  await waitFor(() => req.status === 'DONE', 15000, 'richiesta DONE');
  const tasks = s.orch.tasksOf(req.id);
  const kinds = tasks.map((t) => `${t.kind}:${t.status}`);
  assert.deepEqual(kinds, ['implement:DONE', 'test:FAILED', 'fix:DONE', 'test:DONE']);
  assert.equal(tasks[1].superseded, tasks[3].id);
  assert.equal(tasks[3].result.verdict, 'PASS');
  // commit attribuiti all'agente, nel branch della richiesta
  const log = sh(req.worktree, 'log', '--format=%an|%s', `${req.baseCommit}..HEAD`).split('\n');
  assert.equal(log.length, 2);
  assert.ok(log.every((l) => l.startsWith('Tizo (Studio)|[dev]')));
  assert.match(sh(req.worktree, 'log', '-1', '--format=%B'), /Studio-Agent: dev/);
  // la cartella dell'utente è intatta
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(fs.existsSync(path.join(root, 'src/feature.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'mio-lavoro.txt'), 'utf8'), 'lavoro non committato dell\'utente');
  // eventi per il frontend
  for (const t of ['request.created', 'task.created', 'agent.started_task', 'agent.editing', 'agent.testing', 'agent.completed', 'chat.message', 'git.commit']) assert.ok(seen.includes(t), `evento ${t}`);
  // rapporto
  const rep = s.store.data.chat.find((m) => m.kind === 'report');
  assert.ok(rep, 'rapporto finale in chat');
  assert.equal(rep.report.result, 'PASS');
  assert.equal(rep.report.commits.length, 2);
  assert.ok(rep.report.filesChanged.some((f) => f.file === 'src/feature.js'));
  assert.ok(rep.report.agents.some((a) => a.name === 'Tizia'));
  // unione sicura: con la cartella pulita (file non tracciati ammessi) si unisce, poi si annulla
  await s.orch.merge(req.id);
  assert.equal(fs.readFileSync(path.join(root, 'src/feature.js'), 'utf8'), 'export const x = 1;\n');
  await s.orch.revertMerge(req.id);
  assert.equal(fs.existsSync(path.join(root, 'src/feature.js')), false);
});

test('limite ai giri di correzione: dopo maxFixLoops si passa all\'utente (niente loop infiniti)', async () => {
  const root = makeFixtureRepo();
  const prov = studioProvider({ devAlwaysBug: true });
  const s = await studioFor(root, registryWith(prov), { maxFixLoops: 2 });
  const req = await s.orch.handleUserMessage('Aggiungi una feature che non passa mai');
  await waitFor(() => req.status === 'NEEDS_USER', 15000, 'escalation');
  const tasks = s.orch.tasksOf(req.id);
  assert.equal(tasks.filter((t) => t.kind === 'fix').length, 1);
  assert.equal(tasks.filter((t) => t.kind === 'test').length, 2);
  assert.ok(s.store.data.chat.some((m) => m.kind === 'escalation'));
  assert.equal(s.agents.get('director').runtime.status, 'BLOCKED');
  await waitFor(() => /APERTO/.test(fs.readFileSync(path.join(req.worktree, 'docs/memoria/KNOWN_ISSUES.md'), 'utf8')), 5000, 'known issue');
  // l'utente preme "Riprova": nuova tornata di correzioni (non si ripete lo stesso test sullo stesso codice)
  prov.fixed = true;
  s.orch.retry(req.id);
  await waitFor(() => req.status === 'DONE', 15000, 'DONE dopo Riprova ' + JSON.stringify(s.orch.tasksOf(req.id).map((t) => [t.kind, t.status])));
  const after = s.orch.tasksOf(req.id);
  assert.equal(after.filter((t) => t.kind === 'fix').length, 2);
  assert.equal(after.at(-1).result.verdict, 'PASS');
  assert.match(fs.readFileSync(path.join(req.worktree, 'docs/memoria/KNOWN_ISSUES.md'), 'utf8'), /RISOLTO/);
  // copia di lavoro cancellata: al riavvio lo Studio la ricrea dal branch
  fs.rmSync(req.worktree, { recursive: true, force: true });
  s.store.flush();
  const s2 = await studioFor(root, registryWith(studioProvider()));
  const r2 = s2.store.data.requests[req.id];
  assert.ok(fs.existsSync(path.join(r2.worktree, 'src/feature.js')));
  assert.equal(r2.baseCommit, req.baseCommit);
});

test('git: niente unione se la cartella dell\'utente ha modifiche non salvate', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(studioProvider()));
  const req = await s.orch.handleUserMessage('feature');
  await waitFor(() => req.status === 'DONE', 15000);
  fs.writeFileSync(path.join(root, 'src/version.js'), "export const VERSION = '9.9.9';\n");   // modifica dell'utente
  await assert.rejects(() => s.orch.merge(req.id), /modifiche non salvate/);
  assert.equal(fs.readFileSync(path.join(root, 'src/version.js'), 'utf8'), "export const VERSION = '9.9.9';\n");
  await s.orch.discard(req.id);
  assert.equal(fs.existsSync(req.worktree || '/nope'), false);
  assert.equal(sh(root, 'branch', '--list', 'studio/*'), '');
});

test('task di sola lettura (QA) che modifica file: lo Studio annulla le modifiche', async () => {
  const root = makeFixtureRepo();
  const prov = studioProvider();
  const orig = prov.handler;
  prov.handler = async (o, n) => { if (o.agent.id === 'qa') fs.writeFileSync(path.join(o.cwd, 'src/main.js'), 'HACK'); return orig(o, n); };
  const s = await studioFor(root, registryWith(prov));
  const req = await s.orch.handleUserMessage('feature');
  await waitFor(() => req.status === 'DONE', 15000);
  assert.notEqual(fs.readFileSync(path.join(req.worktree, 'src/main.js'), 'utf8'), 'HACK');
  const t = s.orch.tasksOf(req.id).find((x) => x.kind === 'test' && x.status === 'DONE');
  assert.ok(t.result.strayEditsReverted.includes('src/main.js'));
});

test('Regia: risposta diretta senza task, e piano di riserva senza AI', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '```json\n{"reply":"Il gioco usa Phaser 3.80.","tasks":[]}\n```' }))));
  const req = await s.orch.handleUserMessage('Che versione di Phaser usiamo?');
  await waitFor(() => req.status === 'ANSWERED', 5000);
  assert.equal(s.store.data.chat.at(-1).text, 'Il gioco usa Phaser 3.80.');
  const h = s.orch.normalizePlan(s.orch.heuristicPlan('Riscrivi il dialogo del boss e rendi il boss più difficile'));
  assert.deepEqual(h.tasks.map((t) => `${t.agent}:${t.kind}`), ['narrative:narrative', 'dev:implement', 'qa:test']);
  assert.deepEqual(h.tasks[1].dependsOn, ['n']);
});

test('piano: agente sconosciuto → instradato per capacità; test QA aggiunto se manca; niente cicli', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(studioProvider()));
  const p = s.orch.normalizePlan({ reply: 'x', tasks: [
    { key: 'a', agent: 'boh', kind: 'narrative', title: 'dialogo', dependsOn: ['b'] },
    { key: 'b', agent: 'dev', kind: 'implement', title: 'codice', dependsOn: ['a'] },
  ] });
  assert.equal(p.tasks[0].agent, 'narrative');
  assert.ok(p.tasks.some((t) => t.kind === 'test' && t.agent === 'qa'));
  const a = p.tasks[0], b = p.tasks[1];
  assert.ok(!(a.dependsOn.includes('b') && b.dependsOn.includes('a')), 'dipendenza circolare rimossa');
});

test('provider non configurato: il task va in BLOCKED e la Regia chiede all\'utente', async () => {
  const root = makeFixtureRepo();
  const reg = registryWith(new ScriptedProvider('scripted', async () => planJSON([{ key: 'x', agent: 'dev', kind: 'implement', title: 'x', dependsOn: [] }])));
  const s = await studioFor(root, reg);
  s.agents.update('dev', { provider: 'mock' });
  reg.resolve = async (id) => (id === 'mock' ? reg.get('mock') : reg.get('scripted'));
  const req = await s.orch.handleUserMessage('fai x');
  await waitFor(() => req.status === 'NEEDS_USER', 8000);
  assert.equal(s.agents.get('dev').runtime.status, 'BLOCKED');
  assert.match(s.store.data.chat.at(-1).text, /provider AI/);
});

test('riavvio: stato persistente e task interrotti rimessi in coda', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(studioProvider()));
  const req = await s.orch.handleUserMessage('feature');
  await waitFor(() => req.status === 'DONE', 15000);
  const t = s.orch.tasksOf(req.id)[0];
  t.status = 'RUNNING';
  s.store.flush();
  const s2 = await studioFor(root, registryWith(studioProvider()));
  assert.equal(s2.store.data.requests[req.id].status, 'DONE');
  assert.equal(s2.store.data.tasks[t.id].status, 'PENDING');
  assert.ok(s2.store.data.chat.length >= 3);
});

test('server HTTP: stato, chat, modifica agente e stream di eventi SSE', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(studioProvider()));
  const server = createServer(s);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.agents.filter((a) => a.visible).length, 10);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /GAME STUDIO/);
    // SSE
    const ctrl = new AbortController();
    const events = [];
    const sse = fetch(`${base}/api/events?since=${st.lastSeq}`, { signal: ctrl.signal }).then(async (res) => {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); for (const m of buf.matchAll(/data: (.+)\n/g)) events.push(JSON.parse(m[1]).type); buf = buf.slice(buf.lastIndexOf('\n\n') + 2); }
    }).catch(() => {});
    const r = await (await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: 'aggiungi feature' }) })).json();
    assert.match(r.request.id, /^R-/);
    const upd = await (await fetch(`${base}/api/agents/qa`, { method: 'PUT', body: JSON.stringify({ name: 'Tester' }) })).json();
    assert.equal(upd.name, 'Tester');
    await waitFor(() => s.store.data.requests[r.request.id].status === 'DONE', 15000);
    await waitFor(() => events.includes('agent.completed') && events.includes('request.updated'), 3000, 'eventi SSE');
    ctrl.abort(); await sse;
    const diff = await (await fetch(`${base}/api/requests/${r.request.id}/diff`)).json();
    assert.ok(diff.summary.commits.length >= 1);
    const mem = await (await fetch(`${base}/api/memory/PROJECT_STATE`)).json();
    assert.match(mem.content, /Stato vivo del repository/);
    const office = await (await fetch(`${base}/api/office`)).json();
    assert.ok(office.stations.some((x) => x.agent === 'dev') && office.room.w > 0, 'ufficio caricato');
    const pixel = (await (await fetch(`${base}/api/agents`)).json()).find((a) => a.id === 'art');
    assert.equal(pixel.avatar.type, 'pixel'); assert.ok(pixel.avatar.character.hairStyle);
    const play = await fetch(`${base}/play/${r.request.id}/index.html`);
    assert.equal(play.status, 200);
  } finally { server.close(); }
});

test('extractJSON trova il blocco finale anche in mezzo al testo', () => {
  assert.deepEqual(extractJSON('bla bla\n```json\n{"a":1}\n```\nfine'), { a: 1 });
  assert.deepEqual(extractJSON('risultato: {"verdict":"PASS","x":{"y":2}} ok'), { verdict: 'PASS', x: { y: 2 } });
  assert.equal(extractJSON('niente'), null);
});

test('provider Anthropic: ciclo di strumenti sui file (con fetch finto)', async () => {
  const root = makeFixtureRepo();
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    const b = JSON.parse(init.body);
    assert.ok(b.tools.some((t) => t.name === 'replace_in_file'));
    const content = n === 1
      ? [{ type: 'tool_use', id: 'u1', name: 'replace_in_file', input: { path: 'src/version.js', old: '0.1.0', new: '0.1.1' } }]
      : [{ type: 'text', text: 'fatto {"summary":"versione"}' }];
    return { ok: true, json: async () => ({ content, stop_reason: n === 1 ? 'tool_use' : 'end_turn' }) };
  };
  const p = new AnthropicProvider({ apiKey: 'x', fetchImpl });
  const r = await p.run({ system: 's', prompt: 'p', cwd: root, mode: 'work' });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'src/version.js'), 'utf8'), /0\.1\.1/);
  await assert.rejects(async () => { throw new Error((await import('../server/providers/anthropic.js')).FILE_TOOLS.read_file.run(root, { path: '../../etc/passwd' })); });
});

test('QA harness: controlli statici sul gioco vero', () => {
  const game = path.resolve(process.env.STUDIO_PROJECT_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'tq-evs'));
  if (!fs.existsSync(path.join(game, 'index.html'))) return;   // gioco non accanto allo Studio: niente da controllare
  const r = staticChecks(game);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('dipendenze: Coso scrive il dialogo → Tizo lo implementa (riceve il passaggio di consegne) → Tizia testa; niente scritture in parallelo', async () => {
  const root = makeFixtureRepo();
  let active = 0, maxActiveWriters = 0;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([
      { key: 'n', agent: 'narrative', kind: 'narrative', title: 'Dialogo del mercante', instructions: 'scrivi', dependsOn: [] },
      { key: 'a', agent: 'art', kind: 'art', title: 'Brief sprite mercante', instructions: 'brief', dependsOn: [] },
      { key: 'd', agent: 'dev', kind: 'implement', title: 'Mercante nel villaggio', instructions: 'implementa', dependsOn: ['n', 'a'] },
      { key: 'q', agent: 'qa', kind: 'test', title: 'Prova il mercante', dependsOn: ['d'] },
    ]);
    if (o.mode === 'work') { active++; maxActiveWriters = Math.max(maxActiveWriters, active); await new Promise((r) => setTimeout(r, 60)); active--; }
    if (o.agent.id === 'narrative') { fs.writeFileSync(path.join(o.cwd, 'dialogo.txt'), 'Ciao, sono il mercante'); return { text: '```json\n{"summary":"dialogo scritto","handoff":"id dlg_mercante_hello"}\n```' }; }
    if (o.agent.id === 'art') return { text: '```json\n{"summary":"brief","imageRequests":[{"file":"assets/generated/mercante.png","prompt":"pixel art merchant, magenta bg"}]}\n```' };
    if (o.agent.id === 'dev') { assert.match(o.prompt, /dlg_mercante_hello/); fs.writeFileSync(path.join(o.cwd, 'src/mercante.js'), 'export default 1;'); return { text: '{"summary":"mercante fatto"}' }; }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov));
  const req = await s.orch.handleUserMessage('Aggiungi un mercante al villaggio');
  await waitFor(() => req.status === 'DONE', 15000);
  assert.equal(maxActiveWriters, 1);
  const ts = s.orch.tasksOf(req.id);
  assert.deepEqual(ts.map((t) => `${t.agentId}:${t.status}`), ['narrative:DONE', 'art:DONE', 'dev:DONE', 'qa:DONE']);
  const art = ts.find((t) => t.agentId === 'art');
  assert.equal(art.result.images[0].status, 'pending', 'senza chiave OpenAI resta un brief in attesa');
  const meta = JSON.parse(fs.readFileSync(path.join(req.worktree, 'assets/generated/metadata.json'), 'utf8'));
  assert.equal(meta.assets[0].agent, 'art');
  const authors = sh(req.worktree, 'log', '--format=%an', `${req.baseCommit}..HEAD`).split('\n');
  assert.deepEqual(authors.sort(), ['Cosetta (Studio)', 'Coso (Studio)', 'Tizo (Studio)']);
});

test('Responsabile dell\'ufficio: riarreda e cambia un personaggio (dati), senza toccare il gioco; poi si annulla', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'o', agent: 'office', kind: 'office', title: 'Metti una pianta e cambia la maglia di Tizia', dependsOn: [] }]);
    if (o.agent.id === 'office') {
      assert.ok(fs.existsSync(path.join(o.cwd, 'GUIDA_UFFICIO.md')));
      const off = JSON.parse(fs.readFileSync(path.join(o.cwd, 'office.json'), 'utf8'));
      off.decor.push({ type: 'plant', x: 7, y: 7, size: 1 });
      fs.writeFileSync(path.join(o.cwd, 'office.json'), JSON.stringify(off));
      const looks = JSON.parse(fs.readFileSync(path.join(o.cwd, 'agents-look.json'), 'utf8'));
      looks.find((l) => l.id === 'qa').avatar.character.shirt = '#123456';
      looks.find((l) => l.id === 'qa').name = 'NON DEVE CAMBIARE';
      fs.writeFileSync(path.join(o.cwd, 'agents-look.json'), JSON.stringify(looks));
      return { text: '{"summary":"pianta e maglia"}' };
    }
    return { text: '{}' };
  });
  const s = await studioFor(root, registryWith(prov));
  const before = s.office.get().decor.length;
  const req = await s.orch.handleUserMessage('Metti una pianta in mezzo all\'ufficio e dai a Tizia una maglia blu scuro');
  await waitFor(() => req.status === 'DONE', 10000, 'DONE');
  assert.equal(req.worktree, undefined, 'nessuna copia del gioco per un lavoro sull\'ufficio');
  assert.equal(s.orch.tasksOf(req.id).some((t) => t.kind === 'test'), false, 'niente test del gioco');
  assert.equal(s.office.get().decor.length, before + 1);
  assert.equal(s.agents.get('qa').avatar.character.shirt, '#123456');
  assert.equal(s.agents.get('qa').name, 'Tizia');
  s.office.undo(s.agents);
  assert.equal(s.office.get().decor.length, before);
  assert.notEqual(s.agents.get('qa').avatar.character.shirt, '#123456');
});

test('Responsabile dell\'ufficio: un office.json rotto viene rifiutato e l\'ufficio resta com\'era', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'o', agent: 'office', kind: 'office', title: 'rompi', dependsOn: [] }]);
    fs.writeFileSync(path.join(o.cwd, 'office.json'), '{"room":{"w":3,"d":3},"stations":[],"decor":[{"type":"astronave"}]}');
    return { text: '{}' };
  });
  const s = await studioFor(root, registryWith(prov));
  const before = JSON.stringify(s.office.get());
  const req = await s.orch.handleUserMessage('arreda');
  await waitFor(() => req.status === 'NEEDS_USER', 10000);
  assert.equal(JSON.stringify(s.office.get()), before);
  assert.match(s.orch.tasksOf(req.id)[0].lastError, /astronave|room\.w/);
});

test('Responsabile dell\'ufficio: modifica al codice dello Studio in un branch del repository dello Studio, poi unione', async () => {
  const root = makeFixtureRepo();
  const studioRepo = makeFixtureRepo();   // un repository qualsiasi fa da "Studio"
  fs.mkdirSync(path.join(studioRepo, 'web'), { recursive: true });
  fs.writeFileSync(path.join(studioRepo, 'web', 'ui.js'), 'export const colore = "rosa";\n');
  sh(studioRepo, 'add', '-A'); sh(studioRepo, 'commit', '-q', '-m', 'ui');
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 's', agent: 'office', kind: 'studio_ui', title: 'Tema verde', dependsOn: [] }]);
    fs.writeFileSync(path.join(o.cwd, 'web', 'ui.js'), 'export const colore = "verde";\n');
    return { text: '{"summary":"tema verde"}' };
  });
  const s = await studioFor(root, registryWith(prov), { studioTests: false }, { studioRepo });
  const req = await s.orch.handleUserMessage('Fai il tema dello Studio verde');
  await waitFor(() => req.status === 'DONE', 10000);
  assert.equal(fs.readFileSync(path.join(studioRepo, 'web', 'ui.js'), 'utf8'), 'export const colore = "rosa";\n', 'lo Studio in uso non cambia prima dell\'unione');
  assert.equal(req.report.studioCommits.length, 1);
  await s.orch.merge(req.id);
  assert.equal(fs.readFileSync(path.join(studioRepo, 'web', 'ui.js'), 'utf8'), 'export const colore = "verde";\n');
});

test('provider Codex: legge gli eventi JSONL di `codex exec` (CLI finta)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 9.9'); process.exit(0); }
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  const out = a[a.indexOf('-o') + 1];
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }));
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/x.js', kind: 'update' }] } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fatto ' + (input.includes('RUOLO-X') ? 'con ruolo' : '') } }));
  require('fs').writeFileSync(out, '{"summary":"ok da codex"}');
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`);
  fs.chmodSync(bin, 0o755);
  const { CodexProvider } = await import('../server/providers/codex.js');
  const p = new CodexProvider({ bin });
  const ev = [];
  const r = await p.run({ prompt: 'fai', system: 'RUOLO-X', cwd: dir, mode: 'work', onEvent: (e) => ev.push(e.tool || e.type) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, '{"summary":"ok da codex"}');
  assert.deepEqual(ev, ['Bash', 'Edit', 'text']);
  assert.match(r.allText, /con ruolo/);
});

test('la Regia fa domande quando serve; la risposta dell\'utente continua la stessa richiesta', async () => {
  const root = makeFixtureRepo();
  const seen = [];
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') {
      seen.push(o.prompt);
      if (!o.prompt.includes('È la RISPOSTA')) return { text: '```json\n{"reply":"1. Quale boss? 2. Più difficile o più corto?","needsUser":true,"tasks":[]}\n```' };
      return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: 'Boss più corto', dependsOn: [] }]);
    }
    if (o.agent.id === 'dev') { fs.writeFileSync(path.join(o.cwd, 'src/boss.js'), 'ok'); return { text: '{"summary":"ok"}' }; }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov));
  const r1 = await s.orch.handleUserMessage('Sistema il boss');
  await waitFor(() => r1.status === 'NEEDS_USER', 5000);
  assert.equal(s.store.data.chat.at(-1).kind, 'question');
  const r2 = await s.orch.handleUserMessage('Il primo, e più corto');
  await waitFor(() => r2.status === 'DONE', 10000);
  assert.equal(r1.status, 'ANSWERED');
  assert.equal(r2.continues, r1.id);
  assert.match(seen.at(-1), /Richiesta originale: "Sistema il boss"/);
});

test('richieste in parallelo: la seconda che tocca gli stessi file viene allineata (conflitto risolto) prima di unirla', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: o.prompt.includes('ROSSO') ? 'rosso' : 'blu', dependsOn: [] }]);
    if (o.agent.id === 'dev') {
      const f = path.join(o.cwd, 'CHANGELOG.md');
      if (/conflitti/.test(o.prompt)) { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/<<<<<<< .*\n|=======\n|>>>>>>> .*\n/g, '')); return { text: '{"summary":"conflitti risolti"}' }; }
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('# changelog\n', `# changelog\n\n## 0.1.1 — ${o.prompt.includes('ROSSO') ? 'rosso' : 'blu'}\n`));
      return { text: '{"summary":"voce"}' };
    }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov), { parallelPerAgent: 2 });
  const a = await s.orch.handleUserMessage('Fai ROSSO');
  const b = await s.orch.handleUserMessage('Fai BLU');
  await waitFor(() => a.status === 'DONE' && b.status === 'DONE', 15000, 'due richieste DONE');
  await s.orch.merge(a.id);
  await s.orch.merge(b.id);   // conflitto → allineamento automatico
  await waitFor(() => b.status === 'DONE' && s.orch.tasksOf(b.id).some((t) => t.kind === 'integrate' && t.status === 'DONE'), 15000, 'allineata');
  await s.orch.merge(b.id);
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(cl, /rosso/); assert.match(cl, /blu/); assert.doesNotMatch(cl, /<<<<<<<|>>>>>>>/);
});

test('allegati: caricati via HTTP, finiscono nella richiesta e sono leggibili dagli agenti', async () => {
  const root = makeFixtureRepo();
  let devOpts = null;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') { assert.match(o.prompt, /bug\.png/); return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: 'Correggi il bug dello screenshot', dependsOn: [] }]); }
    if (o.agent.id === 'dev') { devOpts = o; fs.writeFileSync(path.join(o.cwd, 'src/fix.js'), 'ok'); return { text: '{"summary":"ok"}' }; }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov));
  const server = createServer(s);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const png = 'data:image/png;base64,' + Buffer.from('finto png').toString('base64');
    const up = await (await fetch(`${base}/api/uploads`, { method: 'POST', body: JSON.stringify({ name: 'bug.png', type: 'image/png', dataUrl: png }) })).json();
    assert.ok(up.id && up.url);
    assert.equal((await fetch(base + up.url)).status, 200);
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: 'x', attachments: [{ id: '../../etc', name: 'passwd' }] }) });
    assert.equal(bad.status, 400);
    const r = await (await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ text: 'Guarda lo screenshot', attachments: [up] }) })).json();
    await waitFor(() => s.store.data.requests[r.request.id].status === 'DONE', 10000);
    assert.ok(devOpts.addDirs[0].endsWith('uploads'));
    assert.ok(devOpts.images[0].endsWith('bug.png'));
    assert.match(devOpts.prompt, /Allegati dell'utente/);
    assert.equal(s.store.data.chat.find((m) => m.role === 'user' && m.attachments).attachments[0].name, 'bug.png');
  } finally { server.close(); }
});

test('immagini: Nano Banana (Gemini) e GPT Image con reference, scelta automatica del provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  const ref = path.join(dir, 'player.png'); fs.writeFileSync(ref, 'PNGDATA');
  const { GeminiImageProvider } = await import('../server/providers/gemini-image.js');
  let sent;
  const g = new GeminiImageProvider({ apiKey: 'k', fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ecco' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('IMG').toString('base64') } }] } }] }) }; } });
  const r = await g.generate({ prompt: 'sprite', size: '1792x1024', references: [ref] });
  assert.equal(r.ok, true); assert.equal(r.png.toString(), 'IMG');
  assert.match(sent.url, /gemini-3\.1-flash-image:generateContent$/);
  assert.equal(sent.key, 'k');
  assert.equal(sent.body.generationConfig.imageConfig.aspectRatio, '16:9');
  assert.equal(sent.body.contents[0].parts[1].inline_data.data, Buffer.from('PNGDATA').toString('base64'));

  const { OpenAIImageProvider } = await import('../server/providers/openai-image.js');
  let oUrl, oBody;
  const o = new OpenAIImageProvider({ apiKey: 'k', fetchImpl: async (url, init) => { oUrl = url; oBody = init.body; return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('X').toString('base64') }] }) }; } });
  assert.equal((await o.generate({ prompt: 'p', references: [ref] })).ok, true);
  assert.match(oUrl, /images\/edits$/); assert.ok(oBody instanceof FormData); assert.equal(oBody.get('model'), 'gpt-image-2');
  await o.generate({ prompt: 'p' }); assert.match(oUrl, /images\/generations$/);

  const reg = registryWith();
  reg.register(new GeminiImageProvider({ apiKey: 'k' }));
  reg.register(new OpenAIImageProvider({ apiKey: '' }));
  assert.equal((await reg.resolveImage('auto')).id, 'gemini-image', 'senza chiave OpenAI si usa Nano Banana');
});

test('provider Gemini CLI: legge il JSON di `gemini -p` (CLI finta)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-'));
  const bin = path.join(dir, 'gemini');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('0.61.0'); process.exit(0); }
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  if (!a.includes('auto_edit')) { console.log(JSON.stringify({ error: { message: 'modo sbagliato' } })); process.exit(1); }
  console.log(JSON.stringify({ response: 'fatto ' + (input.includes('RUOLO') ? 'col ruolo' : '') + ' {"summary":"ok da gemini"}', stats: { files: { 'src/a.js': {} } } }));
});
`);
  fs.chmodSync(bin, 0o755);
  const { GeminiCliProvider } = await import('../server/providers/gemini-cli.js');
  const ev = [];
  const r = await new GeminiCliProvider({ bin }).run({ prompt: 'fai', system: 'RUOLO', cwd: dir, mode: 'work', onEvent: (e) => ev.push(e.tool || e.type) });
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /col ruolo/);
  assert.ok(ev.includes('Edit'));
});

test('Cosetta ridisegna i personaggi della squadra: art direction + generatore immagini, applicati e annullabili', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'v', agent: 'art', kind: 'avatars', title: 'Nuovi personaggi', dependsOn: [] }]);
    if (o.agent.id === 'art') { assert.ok(fs.existsSync(path.join(o.cwd, 'squadra.json'))); return { text: '```json\n{"style":"cozy pixel art","avatars":[{"agent":"dev","prompt":"a hacker"},{"agent":"qa","prompt":"a tester"}],"summary":"ok"}\n```' }; }
    return { text: '{}' };
  });
  const reg = registryWith(prov);
  const calls = [];
  reg.register({ id: 'openai-image', kind: 'image', label: 'finto', available: async () => ({ ok: true }), generate: async (o) => { calls.push(o); return { ok: true, png: Buffer.from('PNG' + calls.length) }; } });
  const s = await studioFor(root, reg, { avatarFrames: 'light', quoteThresholdUsd: 1e6 });
  const before = s.agents.get('dev').avatar.type;
  const req = await s.orch.handleUserMessage('Cosetta, fai nuovi sprite per te e tutti i tuoi colleghi');
  await waitFor(() => req.status === 'DONE', 10000, 'DONE');
  assert.equal(req.worktree, undefined);
  assert.equal(calls.length, 12, 'modalità light: 6 fotogrammi per agente, 2 agenti');
  const dev = s.agents.get('dev').avatar, qa = s.agents.get('qa').avatar;
  assert.equal(dev.type, 'frames');
  assert.deepEqual(Object.keys(dev.frames).sort(), ['celebrate', 'idle', 'question', 'typing']);
  assert.equal(dev.frames.idle.length, 2); assert.equal(dev.frames.typing.length, 2);
  // le varianti partono dal ritratto base; il base del secondo agente usa il primo come riferimento di stile
  const qaBase = calls.find((c) => /a tester/.test(c.prompt));
  assert.equal(qaBase.references.length, 1);
  assert.ok(calls.filter((c) => /SAME character/.test(c.prompt)).every((c) => c.references.length >= 1));
  assert.match(qa.image, /^\/avatars\/qa-\d+\/idle-1\.png$/);
  s.office.undo(s.agents);
  assert.equal(s.agents.get('dev').avatar.type, before);
});

test('preventivo: prima dei lavori a pagamento la Regia mostra il costo e aspetta l\'ok (sì / leggera / no)', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'v', agent: 'art', kind: 'avatars', title: 'Nuovi personaggi', dependsOn: [] }]);
    if (o.agent.id === 'art') return { text: '```json\n{"style":"x","avatars":[{"agent":"dev","prompt":"a hacker"}]}\n```' };
    return { text: '{}' };
  });
  const reg = registryWith(prov);
  const calls = [];
  reg.register({ id: 'gemini-image', kind: 'image', model: 'gemini-3.1-flash-image', label: 'finto', available: async () => ({ ok: true }), generate: async (o) => { calls.push(o); return { ok: true, png: Buffer.from('PNG') }; } });
  const s = await studioFor(root, reg, { quoteThresholdUsd: 0.5 });
  const team = s.agents.list().filter((a) => a.enabled !== false && (a.visible !== false || a.id === 'director')).length;
  // 1) "no": nessuna immagine generata
  const r1 = await s.orch.handleUserMessage('Cosetta, nuovi sprite per tutti');
  await waitFor(() => r1.status === 'NEEDS_USER' && r1.quotePending, 5000, 'preventivo');
  assert.equal(r1.quote.usd, Math.round(team * 13 * 0.067 * 100) / 100);
  assert.equal(r1.quote.usdLight, Math.round(team * 6 * 0.067 * 100) / 100);
  assert.match(s.store.data.chat.at(-1).text, /Preventivo[\s\S]*incluso nel piano|Preventivo/);
  assert.equal(s.store.data.chat.at(-1).kind, 'quote');
  await s.orch.handleUserMessage('no, lascia stare');
  assert.equal(r1.status, 'CANCELLED');
  assert.equal(calls.length, 0);
  assert.equal(Object.keys(s.store.data.tasks).length, 0);
  // 2) "leggera" in chat: parte con 6 fotogrammi
  const r2 = await s.orch.handleUserMessage('Cosetta, nuovi sprite per tutti');
  await waitFor(() => r2.quotePending, 5000, 'preventivo 2');
  const back = await s.orch.handleUserMessage('vai con la versione leggera');
  assert.equal(back.id, r2.id, 'la risposta non crea una nuova richiesta');
  await waitFor(() => r2.status === 'DONE', 10000, 'DONE');
  assert.equal(calls.length, 6);
  // 3) sotto soglia nessuna domanda; "preventivo" nel testo la forza comunque
  s.config.quoteThresholdUsd = 1e6;
  const r3 = await s.orch.handleUserMessage('fammi un preventivo per nuovi sprite a tutti');
  await waitFor(() => r3.quotePending, 5000, 'preventivo esplicito');
  await s.orch.answerQuote(r3.id, 'approve');
  await waitFor(() => r3.status === 'DONE', 10000, 'DONE 3');
  assert.equal(calls.length, 6 + 13);
  // 4) alternative nel preventivo: «leggera con Nano Banana Pro» sceglie il modello Pro e 6 fotogrammi
  const r4 = await s.orch.handleUserMessage('preventivo: nuovi sprite a tutti');
  await waitFor(() => r4.quotePending, 5000, 'preventivo 4');
  const pro = r4.quote.options.find((o) => o.id === 'gemini-image:gemini-3-pro-image');
  assert.ok(pro && !pro.current);
  assert.equal(pro.usd, Math.round(team * 13 * 0.134 * 100) / 100);
  await s.orch.handleUserMessage('leggera con nano banana pro');
  await waitFor(() => r4.status === 'DONE', 10000, 'DONE 4');
  assert.equal(r4.imageChoice, 'gemini-image:gemini-3-pro-image');
  assert.equal(calls.length, 6 + 13 + 6);
  assert.ok(calls.slice(-6).every((c) => c.model === 'gemini-3-pro-image'));
  // la lavagna: 19 immagini Nano Banana 2 + 6 Pro
  const gi = s.orch.costs.summary().providers.find((p) => p.id === 'gemini-image');
  assert.equal(gi.images, 25);
  assert.equal(gi.usd, Math.round((19 * 0.067 + 6 * 0.134) * 100) / 100);
});

test('piano: più task "avatars" diventano uno solo e sparisce il task di codice per animarli', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  const p = s.orch.normalizePlan({ reply: 'x', tasks: [
    { key: 'a', agent: 'art', kind: 'avatars', title: 'Sprite lotto 1', instructions: 'primi 5' },
    { key: 'b', agent: 'art', kind: 'avatars', title: 'Sprite lotto 2', instructions: 'altri 4' },
    { key: 'c', agent: 'office', kind: 'studio_ui', title: 'Animare gli sprite nell\'ufficio', dependsOn: ['a', 'b'] },
  ] });
  assert.equal(p.tasks.length, 1);
  assert.match(p.tasks[0].instructions, /primi 5[\s\S]*altri 4/);
});

test('Stratega: sceglie il modello per ogni task; se tutto è incluso nel piano parte senza chiedere; la lavagna conta', async () => {
  const root = makeFixtureRepo();
  const prov = studioProvider();
  prov.id = 'claude-code';   // così lo Stratega vede il catalogo di Claude Code (opus / sonnet / haiku)
  const inner = prov.handler;
  const stratPrompts = [];
  prov.handler = async (o, n) => {
    if (o.agent.id === 'strategist') {
      stratPrompts.push(o.prompt);
      const keys = [...o.prompt.matchAll(/^### (\S+) — [^·]+· (\w+)/gm)].map((m) => ({ key: m[1], kind: m[2] }));
      return { text: '```json\n' + JSON.stringify({ summary: 'Codice delicato su opus, test su haiku.', tasks: keys.map((k) => ({ key: k.key, provider: 'claude-code', model: k.kind === 'implement' ? 'opus' : 'haiku', why: 'x' })), advice: '' }) + '\n```' };
    }
    return inner(o, n);
  };
  const reg = registryWith(prov);
  const s = await studioFor(root, reg, { strategist: 'ai' });
  const req = await s.orch.handleUserMessage('Aggiungi una feature di prova');
  await waitFor(() => req.status === 'DONE', 15000, 'DONE');
  assert.equal(stratPrompts.length, 1);
  assert.match(stratPrompts[0], /"model": "opus"[\s\S]*INCLUSO/);
  assert.ok(!s.store.data.chat.some((m) => m.kind === 'quote'), 'tutto incluso: nessun preventivo');
  const devCall = prov.calls.find((c) => c.agent.id === 'dev');
  assert.equal(devCall.model, 'opus');
  assert.ok(prov.calls.filter((c) => c.agent.id === 'qa').every((c) => c.model === 'haiku'), 'anche il ritest usa la scelta per i test');
  assert.equal(prov.calls.find((c) => c.agent.id === 'strategist').model, 'haiku', 'lo Stratega usa un modello veloce');
  const tasks = s.orch.tasksOf(req.id);
  assert.equal(tasks.find((t) => t.kind === 'implement').usedModel, 'claude-code · opus');
  assert.ok(s.store.data.chat.some((m) => m.kind === 'plan' && /claude-code · opus/.test(m.text) && /Codice delicato/.test(m.text)));
  // lavagna: le chiamate incluse nel piano si contano, ma non costano
  const c = s.orch.costs.summary();
  const cc = c.providers.find((p) => p.id === 'claude-code');
  assert.ok(cc.included && cc.runs >= 4 && cc.usd === 0);
  assert.equal(c.totalUsd, 0);
  assert.ok(s.office.get().decor.some((d) => d.type === 'costboard'), 'la lavagna è nell\'ufficio');
});

test('Stratega a regole: codice su qualità alta, arredo su bassa; costi API registrati nei subtotali', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  // catalogo finto con due livelli per il provider di test
  s.orch.catalog.text.scripted = { label: 'finto', included: true, models: [{ id: 'grande', tier: 'alta' }, { id: 'piccolo', tier: 'bassa' }] };
  const st = await s.orch.strategize({ id: 'R-x', text: 'x' }, { tasks: [{ key: 'a', agent: 'dev', kind: 'implement', title: 't' }, { key: 'b', agent: 'office', kind: 'office', title: 't' }] });
  assert.equal(st.tasks.a.model, 'grande');
  assert.equal(st.tasks.b.model, 'piccolo');
  // spese a consumo: immagini e API Anthropic finiscono nei subtotali
  s.orch.recordUsage({ id: 'openai-image', quality: 'high' }, 'image', { ok: true }, {});
  s.orch.recordUsage({ id: 'anthropic' }, 'run', { ok: true, usage: { input_tokens: 1e6, output_tokens: 0 } }, {});
  const c = s.orch.costs.summary();
  assert.equal(c.providers.find((p) => p.id === 'openai-image').usd, 0.21);
  assert.equal(c.providers.find((p) => p.id === 'anthropic').usd, 3);
  assert.equal(c.totalUsd, 3.21);
  s.orch.costs.reset();
  assert.equal(s.orch.costs.summary().totalUsd, 0);
});
