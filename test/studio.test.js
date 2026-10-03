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
  assert.deepEqual(ids, ['art', 'audio', 'dev', 'director', 'level', 'lore', 'narrative', 'puzzle', 'qa', 'release', 'strategist']);
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
    if (o.agent.id === 'art') {
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
  await waitFor(() => b.merged, 20000, 'allineata e unita da sola');   // il Notaio la rimette in coda da solo
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
  const st = await s.orch.strategize({ id: 'R-x', text: 'x' }, { tasks: [{ key: 'a', agent: 'dev', kind: 'implement', title: 't' }, { key: 'b', agent: 'art', kind: 'office', title: 't' }] });
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

test('ufficio: la pianta grande sostituisce quella vecchia personalizzata, che resta recuperabile con "Annulla"', async () => {
  const root = makeFixtureRepo();
  const dataDir = path.join(root, '.studio-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const old = { name: 'Sede vecchia', room: { w: 15, d: 13, wallH: 112 }, stations: [{ agent: 'dev', wall: 'R', at: 1, kind: 'pc' }], decor: [{ type: 'costboard', wall: 'L', at: 3, w: 2.2 }] };
  fs.writeFileSync(path.join(dataDir, 'office.json'), JSON.stringify(old));
  const s = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  const o = s.office.get();
  assert.equal(o.room.w, 24);
  assert.ok(['coffee', 'sofa', 'costboard'].every((t) => o.decor.some((d) => d.type === t)), 'angolo relax e lavagna');
  assert.ok(o.stations.some((st) => st.agent === 'strategist'));
  assert.equal(s.office.validate(o).length, 0);
  // "Annulla ultimo arredo" riporta l'ufficio di prima, e al riavvio non viene sostituito di nuovo
  s.office.undo(s.agents);
  assert.equal(s.office.get().room.w, 15);
  const s2 = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  assert.equal(s2.office.get().room.w, 15);
});

test('ridipintura dell\'ufficio: preventivo, maquette + stile al generatore, sfondo applicato e annullabile, zero token di testo', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'p', agent: 'art', kind: 'office_paint', title: 'Ridipingere l\'ufficio', dependsOn: [] }]);
    return { text: '{}' };
  });
  const reg = registryWith(prov);
  const calls = [];
  reg.register({ id: 'openai-image', kind: 'image', quality: 'high', label: 'finto', available: async () => ({ ok: true }), generate: async (o) => { calls.push(o); return { ok: true, png: Buffer.from('DIPINTO') }; } });
  const s = await studioFor(root, reg);
  s.orch.snapshotter = async ({ out }) => { fs.writeFileSync(out, 'MAQUETTE'); return { file: out, W: 1518, H: 1012, ox: 31, oy: 0, scale: 2 }; };
  const req = await s.orch.handleUserMessage('Cosetta, ridipingi l\'ufficio in questo stile: illustrazione isometrica dipinta, luce calda');
  await waitFor(() => req.quotePending, 5000, 'preventivo');
  assert.equal(req.quote.usd, 0.21, 'una sola immagine in alta qualità');
  assert.match(s.store.data.chat.at(-1).text, /ridipintura dell'ufficio, \*\*1 immagine\*\*/);
  await s.orch.answerQuote(req.id, 'approve');
  await waitFor(() => req.status === 'DONE', 8000, 'DONE');
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /KEEP EXACTLY[\s\S]*luce calda/);
  assert.ok(calls[0].references[0].endsWith('.png') && fs.readFileSync(calls[0].references[0], 'utf8') === 'MAQUETTE', 'la maquette è il primo riferimento');
  assert.equal(calls[0].size, '1536x1024');
  assert.equal(prov.calls.filter((c) => c.agent.id === 'art').length, 0, 'nessuna chiamata all\'AI di testo per Cosetta');
  const paint = s.office.paint();
  assert.match(paint.url, /^\/office-paint\/ufficio-\d+\.png$/);
  assert.equal(paint.ox, 31);
  const { layoutHash } = await import('../web/layout-hash.js');
  assert.equal(paint.hash, layoutHash(s.office.get()));
  assert.equal(s.orch.costs.summary().providers.find((p) => p.id === 'openai-image').usd, 0.21);
  s.office.undo(s.agents);
  assert.equal(s.office.paint(), null, 'annulla: torna senza sfondo dipinto');
});

test('generatore senza credito: messaggio chiaro, "Riprova" anche senza branch, e riprova con un altro generatore', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => (o.agent.id === 'director' ? planJSON([{ key: 'p', agent: 'art', kind: 'office_paint', title: 'Ridipingi', dependsOn: [] }]) : { text: '{}' }));
  const reg = registryWith(prov);
  const oa = [], gm = [];
  reg.register({ id: 'openai-image', kind: 'image', quality: 'high', label: 'o', available: async () => ({ ok: true }), generate: async (o) => { oa.push(o); return { ok: false, error: 'API 429: You have no credits remaining.' }; } });
  reg.register({ id: 'gemini-image', kind: 'image', model: 'gemini-3.1-flash-image', label: 'g', available: async () => ({ ok: true }), generate: async (o) => { gm.push(o); return { ok: true, png: Buffer.from('X') }; } });
  const s = await studioFor(root, reg, { maxTaskRetries: 0 });
  s.orch.snapshotter = async ({ out }) => { fs.writeFileSync(out, 'M'); return { file: out, W: 3, H: 2, ox: 0, oy: 0, scale: 2 }; };
  const req = await s.orch.handleUserMessage('ridipingi l\'ufficio');
  await waitFor(() => req.quotePending, 5000, 'preventivo');
  await s.orch.answerQuote(req.id, 'approve');
  await waitFor(() => req.status === 'NEEDS_USER' && !req.quotePending, 8000, 'escalation');
  const esc = s.store.data.chat.filter((m) => m.kind === 'escalation').at(-1).text;
  assert.match(esc, /finito il credito[\s\S]*Nano Banana/);
  assert.doesNotMatch(esc, /branch -/);
  s.orch.retry(req.id, { choice: 'gemini-image:gemini-3.1-flash-image' });
  await waitFor(() => req.status === 'DONE', 8000, 'DONE');
  assert.equal(gm.length, 1);
  assert.equal(gm[0].model, 'gemini-3.1-flash-image');
});

test('Regia che non risponde: niente piano "a indovinare", si chiede e "Riprova" ripianifica; personaggi solo per chi è nominato', async () => {
  const root = makeFixtureRepo();
  let n = 0;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') { n++; if (n === 1) return { ok: false, error: 'claude è uscito con codice 143' }; return planJSON([{ key: 'v', agent: 'art', kind: 'avatars', title: 'Sprite dello Stratega', instructions: 'Disegna lo Stratega', dependsOn: [] }]); }
    return { text: '{}' };
  });
  const reg = registryWith(prov);
  reg.register({ id: 'gemini-image', kind: 'image', model: 'gemini-3.1-flash-image', label: 'g', available: async () => ({ ok: true }), generate: async () => ({ ok: true, png: Buffer.from('X') }) });
  const s = await studioFor(root, reg);
  const req = await s.orch.handleUserMessage('Lo Stratega ha ancora la vecchia sprite da aggiornare. Cosetta disegnagli una sprite.');
  await waitFor(() => req.status === 'NEEDS_USER', 5000, 'domanda');
  assert.ok(req.planFailed);
  assert.equal(req.taskIds.length, 0, 'nessun task avviato');
  assert.match(s.store.data.chat.at(-1).text, /Non sono riuscita a pianificare/);
  s.orch.retry(req.id);
  await waitFor(() => req.quotePending, 5000, 'preventivo');
  assert.equal(req.quote.usd, Math.round(13 * 0.067 * 100) / 100, 'un solo personaggio: lo Stratega');
  assert.deepEqual(s.orch.avatarTargets('Cosetta, fai nuovi sprite per te e tutti i colleghi').length, s.orch.avatarTargets('tutti').length);
  assert.deepEqual(s.orch.avatarTargets('ridisegna Tizo e Tizia, Cosetta').map((a) => a.id).sort(), ['dev', 'qa']);
});

test('licenziare un agente: i compiti passano a un collega, l\'aspetto a un altro; Arredo di chi lo aveva viene licenziato al riavvio', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  const srv = createServer(s);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const look = structuredClone(s.agents.get('level').avatar);
  const r = await fetch(`${base}/api/agents/level/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'dev', lookTo: 'strategist' }) });
  assert.equal(r.status, 200);
  assert.equal(s.agents.get('level').enabled, false);
  assert.ok(s.agents.get('dev').kinds.includes('level'));
  assert.deepEqual(s.agents.get('strategist').avatar.character, look.character);
  assert.equal(s.agents.forKind('level').id, 'dev');
  const bad = await fetch(`${base}/api/agents/director/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'art' }) });
  assert.notEqual(bad.status, 200);
  srv.close();
  // uno Studio vecchio con Arredo (e il suo personaggio generato): al riavvio se ne va, compiti a Cosetta e aspetto allo Stratega
  const root2 = makeFixtureRepo();
  const s1 = await studioFor(root2, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  s1.agents.create({ id: 'office', name: 'Arredo', role: 'Responsabile dell\'ufficio', kinds: ['office', 'studio_ui'], avatar: { type: 'frames', frames: { idle: ['/avatars/x/idle-1.png'] }, image: '/avatars/x/idle-1.png' } });
  s1.store.flush();
  const s2 = await studioFor(root2, registryWith(new ScriptedProvider('scripted', async () => ({ text: '{}' }))));
  assert.equal(s2.agents.get('office').enabled, false);
  assert.equal(s2.agents.forKind('office').id, 'art');
  assert.equal(s2.agents.get('strategist').avatar.type, 'frames');
  assert.match(s2.store.data.chat.at(-1).text, /Arredo ha lasciato lo Studio/);
});

test('"riprova" e "ferma" scritti in chat agiscono sulla richiesta che aspetta una decisione', async () => {
  const root = makeFixtureRepo();
  const prov = new ScriptedProvider('scripted', async (o) => (o.agent.id === 'director' ? planJSON([{ key: 'p', agent: 'art', kind: 'office_paint', title: 'Ridipingi', dependsOn: [] }]) : { text: '{}' }));
  const reg = registryWith(prov);
  let fail = true;
  reg.register({ id: 'openai-image', kind: 'image', quality: 'high', label: 'o', available: async () => ({ ok: true }), generate: async () => (fail ? { ok: false, error: 'API 429: You have no credits remaining.' } : { ok: true, png: Buffer.from('X') }) });
  const s = await studioFor(root, reg, { quoteThresholdUsd: 1e6 });
  s.orch.snapshotter = async ({ out }) => { fs.writeFileSync(out, 'M'); return { file: out, W: 3, H: 2, ox: 0, oy: 0, scale: 2 }; };
  const req = await s.orch.handleUserMessage('ridipingi l\'ufficio');
  await waitFor(() => req.status === 'NEEDS_USER', 8000, 'escalation');
  assert.equal(s.agents.get('art').runtime.status !== 'IDLE', true);
  fail = false;
  const r2 = await s.orch.handleUserMessage('riprova');
  assert.equal(r2.id, req.id, 'non crea una richiesta nuova');
  await waitFor(() => req.status === 'DONE', 8000, 'DONE');
  fail = true;
  const req2 = await s.orch.handleUserMessage('ridipingi di nuovo l\'ufficio');
  await waitFor(() => req2.status === 'NEEDS_USER', 8000, 'escalation 2');
  await s.orch.handleUserMessage('Ferma.');
  assert.equal(req2.status, 'CANCELLED');
  assert.equal(s.agents.get('art').runtime.status, 'IDLE', 'niente ERRORE appeso dopo la chiusura');
});

test('effetti sonori: Rumore progetta, ElevenLabs e jsfxr generano 3 varianti, rifinitura, manifest con licenza, cache e conferma oltre 10 suoni', async () => {
  const root = makeFixtureRepo();
  let design = [
    { id: 'vetro_rotto_01', label: 'Vetro rotto', category: 'vandalismo', engine: 'elevenlabs', prompt: 'a glass bottle shattering on cobblestones, close, dry', duration: 1.5 },
    { id: 'notte_borgo', label: 'Notte nel borgo', category: 'ambient', engine: 'elevenlabs', prompt: 'quiet mountain village night ambience, crickets, distant dog', duration: 10, loop: true },
    { id: 'click_menu', label: 'Click del menu', category: 'ui', engine: 'jsfxr', preset: 'blipSelect' },
    { id: 'pickup_birra', label: 'Pickup birra', category: 'gameplay', engine: 'jsfxr', preset: 'pickupCoin' },
  ];
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 's', agent: 'audio', kind: 'sfx', title: 'Primo lotto di suoni', dependsOn: [] }]);
    if (o.agent.id === 'audio') return { text: '```json\n' + JSON.stringify({ summary: 'ok', sounds: design }) + '\n```' };
    return { text: '{}' };
  });
  const reg = registryWith(prov);
  // un mp3 vero (un tono) per far lavorare ffmpeg come con ElevenLabs
  const tone = path.join(os.tmpdir(), `tono-${Date.now()}.mp3`);
  sh(os.tmpdir(), '--version');
  const ff = (await import('node:child_process')).spawnSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', tone]);
  const calls = [];
  reg.register({ id: 'elevenlabs', kind: 'audio', model: 'eleven_text_to_sound_v2', format: 'mp3_44100_128', available: async () => ({ ok: true }), subscription: async () => ({ ok: true, tier: 'free', used: 0, limit: 10000, commercial: false }), sound: async (o) => { calls.push(o); return { ok: true, buf: ff.status === 0 ? fs.readFileSync(tone) : Buffer.from('ID3fake'), ext: 'mp3', credits: 200 }; } });
  const s = await studioFor(root, reg);
  const req = await s.orch.handleUserMessage('Rumore, primo lotto di suoni: vetro rotto, notte del borgo, click del menu, pickup della birra');
  await waitFor(() => req.status === 'DONE', 60000, 'DONE');
  assert.equal(calls.length, 6, '2 suoni ElevenLabs × 3 varianti');
  assert.match(calls[0].text, /no music, no voice$/);
  assert.equal(calls.find((c) => /night/.test(c.text)).loop, true);
  assert.ok(s.store.data.chat.some((m) => /Genero 4 suoni: 6 generazioni ElevenLabs \(≈ 1380 crediti, piano free\)/.test(m.text)));
  const man = s.orch.sfx.manifest().sounds;
  assert.deepEqual(Object.keys(man).sort(), ['sfx_click_menu', 'sfx_notte_borgo', 'sfx_pickup_birra', 'sfx_vetro_rotto_01']);
  for (const x of Object.values(man)) { assert.equal(x.variants.length, 3); assert.equal(x.status, 'bozza'); }
  assert.equal(man.sfx_vetro_rotto_01.license.plan, 'free');
  assert.equal(man.sfx_vetro_rotto_01.license.commercial, false);
  assert.equal(man.sfx_click_menu.license.commercial, true);
  assert.ok(man.sfx_click_menu.variants[1].params && man.sfx_click_menu.variants[1].params.wave_type !== undefined, 'parametri jsfxr salvati');
  if (ff.status === 0) {
    assert.ok(man.sfx_vetro_rotto_01.variants[0].ogg.endsWith('.ogg') && man.sfx_vetro_rotto_01.variants[0].mp3.endsWith('.mp3'));
    const v0 = man.sfx_click_menu.variants[0];
    // a volume giusto, oppure già al limite dei picchi (un clic secco non può salire oltre senza distorcere)
    assert.ok(Math.abs(v0.lufs - -20) < 2.5 || (v0.lufs < -20 && v0.peak >= -2), `volume della categoria ui (${v0.lufs} LUFS, picco ${v0.peak})`);
  }
  assert.match(s.store.data.chat.find((m) => m.kind === 'report' || /Suoni pronti/.test(m.text))?.text || JSON.stringify(s.orch.tasksOf(req.id)[0].result), /release commerciale/);
  const el = s.orch.costs.summary().providers.find((p) => p.id === 'elevenlabs');
  assert.equal(el.runs, 6); assert.equal(el.credits, 1200); assert.equal(el.usd, 0);
  // stessa richiesta: tutto dalla cache, nessuna nuova generazione
  const req2 = await s.orch.handleUserMessage('rifai gli stessi suoni');
  await waitFor(() => req2.status === 'DONE', 60000, 'DONE 2');
  assert.equal(calls.length, 6);
  // lotto grande: oltre 10 suoni si chiede l'ok, "riprova" li genera
  design = Array.from({ length: 11 }, (_, i) => ({ id: `ui_${i}`, category: 'ui', engine: 'jsfxr', preset: 'click' }));
  const req3 = await s.orch.handleUserMessage('undici suoni di interfaccia');
  await waitFor(() => req3.status === 'NEEDS_USER', 30000, 'conferma');
  assert.match(s.store.data.chat.at(-1).text, /Serve il tuo ok[\s\S]*11 suoni[\s\S]*riprova/);
  await s.orch.handleUserMessage('riprova');
  await waitFor(() => req3.status === 'DONE', 60000, 'DONE 3');
  assert.equal(Object.keys(s.orch.sfx.manifest().sounds).length, 15);
});

test('lavagne: la Regia programma le attività in DA FARE (senza eseguirle), «avvia B-1» le fa partire e si spuntano; performance della squadra', async () => {
  const root = makeFixtureRepo();
  const base = studioProvider();
  const inner = base.handler;
  base.handler = async (o, n) => {
    if (o.agent.id === 'director' && /programm/i.test(o.prompt) && !/Esegui l'attività/.test(o.prompt)) {
      assert.match(o.prompt, /Lavagna DA FARE attuale: vuota/);
      return { text: '```json\n' + JSON.stringify({ reply: 'Ecco il piano.', needsUser: false, tasks: [], backlog: [{ title: 'Aggiungi una feature di prova', agent: 'dev', priority: 'alta', details: 'feature.js' }, { title: 'Testi del secondo rione', agent: 'narrative', priority: 'media' }] }) + '\n```' };
    }
    return inner(o, n);
  };
  const s = await studioFor(root, registryWith(base));
  const r1 = await s.orch.handleUserMessage('Programmate le prossime attività');
  await waitFor(() => r1.status === 'ANSWERED', 5000, 'risposta');
  assert.equal(r1.taskIds.length, 0, 'programmare non avvia lavori');
  const b = s.orch.backlog.summary();
  assert.deepEqual(b.open.map((i) => i.id), ['B-1', 'B-2']);
  assert.match(s.store.data.chat.at(-1).text, /Lavagna DA FARE[\s\S]*B-1[\s\S]*Tizo[\s\S]*avvia B-1/);
  const r2 = await s.orch.handleUserMessage('avvia B-1');
  assert.equal(s.orch.backlog.get('B-1').status, 'in corso');
  await waitFor(() => r2.status === 'DONE', 15000, 'DONE');
  assert.equal(s.orch.backlog.get('B-1').status, 'fatto');
  assert.equal(s.orch.backlog.summary().counts.open, 1);
  // performance: Tizo ha fatto implement + fix (il primo giro aveva un BUG → rifacimento), Tizia ha trovato il bug
  const p = s.orch.performance();
  const dev = p.rows.find((r) => r.id === 'dev'), qa = p.rows.find((r) => r.id === 'qa');
  assert.equal(dev.done, 2); assert.equal(dev.rework, 1); assert.equal(dev.quality, 67);
  assert.equal(qa.done, 2); assert.equal(qa.bugsFound, 1); assert.equal(qa.quality, 100);
  assert.ok(['dev', 'qa'].includes(p.most));
  assert.ok(s.office.get().decor.some((d) => d.type === 'todoboard') && s.office.get().decor.some((d) => d.type === 'perfboard'));
});

test('Notaio: coda in ordine, prova generale, blocca un\'unione che perderebbe righe, la fa riparare e la unisce; registro', async () => {
  const root = makeFixtureRepo();
  let careless = true;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: o.prompt.includes('ROSSO') ? 'rosso' : 'blu', dependsOn: [] }]);
    if (o.agent.id === 'dev') {
      const f = path.join(o.cwd, 'src/main.js');
      if (/conflitti/.test(o.prompt)) {
        let t = fs.readFileSync(f, 'utf8');
        // la prima volta "risolve" tenendo solo la voce già nel gioco (perde la propria!), la seconda le tiene entrambe
        if (careless && !/PERSE/.test(o.prompt)) { careless = false; t = t.replace(/<<<<<<< .*\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> .*\n/, '$1'); }
        else t = t.replace(/<<<<<<< .*\n|=======\n|>>>>>>> .*\n/g, '');
        // il Notaio ha elencato le righe perse: lo sviluppo le rimette
        for (const m of o.prompt.matchAll(/src\/main\.js: «(.+?)»/g)) if (!t.includes(m[1])) t = t.replace('console.log(VERSION);\n', `console.log(VERSION);\n${m[1]}\n`);
        fs.writeFileSync(f, t); return { text: '{"summary":"conflitti risolti"}' };
      }
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('console.log(VERSION);\n', `console.log(VERSION);\nconsole.log('voce ${o.prompt.includes('ROSSO') ? 'rosso' : 'blu'} importante');\n`));
      return { text: '{"summary":"voce"}' };
    }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov), { parallelPerAgent: 2 });
  const a = await s.orch.handleUserMessage('Fai ROSSO');
  const b = await s.orch.handleUserMessage('Fai BLU');
  await waitFor(() => a.status === 'DONE' && b.status === 'DONE', 15000, 'due richieste DONE');
  // approvate "nell'ordine sbagliato": prima la più nuova
  await s.orch.merge(b.id);
  assert.ok(b.merged);
  await s.orch.merge(a.id);   // conflitto → allineamento; la soluzione sbagliata viene scoperta e riparata
  await waitFor(() => a.merged, 30000, 'unita dopo la riparazione');
  const cl = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  assert.match(cl, /voce rosso importante/); assert.match(cl, /voce blu importante/, 'la voce di BLU (entrata prima) non è andata persa');
  assert.ok(s.store.data.chat.some((m) => /Fermata l'unione[\s\S]*voce rosso importante/.test(m.text)), 'il Notaio ha segnalato la riga che si sarebbe persa');
  const L = s.orch.release.summary();
  assert.deepEqual(L.entries.map((e) => e.requestId), [a.id, b.id]);
  assert.equal(L.queue.length, 0);
  // annullare B romperebbe A (stesso punto del codice): il Notaio si ferma e non tocca niente
  const head = sh(root, 'rev-parse', 'HEAD');
  await assert.rejects(() => s.orch.revertMerge(b.id), /romperebbe/);
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
});

test('Notaio: i numeri di versione e le righe ritoccate non sono "righe perse"; una riga sparita sì', async () => {
  const { GitService } = await import('../server/git.js');
  const { ReleaseDesk } = await import('../server/release.js');
  const root = makeFixtureRepo();
  const f = path.join(root, 'CHANGELOG.md');
  fs.writeFileSync(f, '# changelog\n'); sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base');
  const base = sh(root, 'rev-parse', 'HEAD');
  const lunga = '| `MenuScene.js` | Elenco livelli da `levels/index.json`, partita salvata, voci Musica, Modalità TV, Schermo intero, Calibra controller.';
  fs.writeFileSync(f, `# changelog\n## Stato attuale (v0.33.0)\n## 0.32.1 — Il menu in basso a sinistra\n## voce blu importante\n${lunga}\n`);
  sh(root, 'commit', '-qam', 'lato'); const ref = sh(root, 'rev-parse', 'HEAD');
  // risultato: versione salita, voce rinumerata, riga lunga ritoccata, la voce blu sparita
  fs.writeFileSync(f, `# changelog\n## Stato attuale (v0.33.1)\n## 0.33.1 — Il menu in basso a sinistra\n${lunga.replace('Calibra controller.', 'Calibra controller, IMPOSTAZIONI e LIVELLI EXTRA.')}\n`);
  const desk = new ReleaseDesk({ git: new GitService(root), store: { data: {} }, events: null, dataDir: path.join(root, '.studio') });
  const { missing, changed } = await desk.lostCheck({ cwd: root, base, sides: [{ label: 'x', ref }], withChanged: true });
  assert.deepEqual(missing.map((m) => m.line), ['## voce blu importante'], 'solo la riga sparita davvero blocca');
  assert.equal(changed.length, 1, 'la riga lunga ritoccata è un avviso');
});

test('Studio: un ramo già unito a mano con git risulta unito; "Unisci comunque" e "Rimanda allo sviluppo" esistono', async () => {
  const root = makeFixtureRepo();
  const s = await studioFor(root, registryWith(studioProvider()));
  const req = await s.orch.handleUserMessage('Aggiungi una feature');
  await waitFor(() => req.status === 'DONE', 15000, 'richiesta DONE');
  assert.ok(!req.merged);
  sh(root, 'merge', '--no-ff', '-q', '-m', 'unione a mano', req.branch);
  await s.orch.syncMerged();
  assert.ok(req.merged, 'riconosciuta come unita');
  assert.equal(req.mergedOutside, true);
  assert.equal(req.mergeCommit, sh(root, 'rev-parse', 'HEAD'));
  await s.orch.merge(req.id);   // nessun errore, nessuna seconda unione
  assert.equal(sh(root, 'log', '--merges', '--format=%s').split('\n').length, 1);
  assert.equal(typeof s.orch.repairMerge, 'function');
});

test('seguiti: un messaggio agganciato a una richiesta continua sul suo branch, aspetta se è in corso, o riparte dal gioco se era unita', async () => {
  const root = makeFixtureRepo();
  let hold = null;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') {
      const w = (o.prompt.match(/PAROLA (\w+)/g) || []).pop()?.split(' ')[1] || 'x';
      return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: `scrivi ${w}`, instructions: `PAROLA ${w}`, dependsOn: [] }]);
    }
    if (o.agent.id === 'dev') {
      const w = (o.prompt.match(/PAROLA (\w+)/g) || []).pop().split(' ')[1];
      if (w === 'lenta') await new Promise((r) => { hold = r; });
      fs.appendFileSync(path.join(o.cwd, `${w}.txt`), `${w}\n`);
      return { text: '{"summary":"ok"}' };
    }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov), { parallelPerAgent: 2 });
  const o = s.orch;
  // 1. finita e non unita → stesso branch
  const a = await o.handleUserMessage('Fai PAROLA alfa');
  await waitFor(() => a.status === 'DONE', 15000, 'A DONE');
  const b = await o.handleUserMessage('aggiungi PAROLA beta', { replyTo: a.id });
  await waitFor(() => b.status === 'DONE', 15000, 'B DONE');
  assert.equal(b.parent, a.id); assert.ok(b.sameBranch); assert.equal(b.branch, a.branch); assert.equal(a.followedBy, b.id);
  await assert.rejects(() => o.merge(a.id), /proseguita/);
  await o.merge(b.id);
  assert.ok(fs.existsSync(path.join(root, 'alfa.txt')) && fs.existsSync(path.join(root, 'beta.txt')), 'il seguito porta con sé anche il lavoro di A');
  // 2. agganciata a una richiesta unita (anche passando dalla vecchia A) → nuova richiesta dal gioco attuale
  const c = await o.handleUserMessage('ancora PAROLA gamma', { replyTo: a.id });
  await waitFor(() => c.status === 'DONE', 15000, 'C DONE');
  assert.equal(c.parent, b.id); assert.ok(!c.sameBranch); assert.notEqual(c.branch, b.branch);
  // 3. agganciata a una richiesta ancora in lavorazione → aspetta, poi continua sul suo branch; «R-n:» a voce vale come aggancio
  const d = await o.handleUserMessage('Fai PAROLA lenta');
  await waitFor(() => hold, 15000, 'D al lavoro');
  const e = await o.handleUserMessage(`${d.id.replace('R-000', 'R ')}: poi PAROLA delta`);
  assert.equal(e.status, 'QUEUED'); assert.equal(e.parent, d.id); assert.equal(e.text, 'poi PAROLA delta');
  hold();
  await waitFor(() => e.status === 'DONE', 20000, 'E DONE dopo D');
  assert.ok(e.sameBranch); assert.equal(e.branch, d.branch);
  assert.ok(fs.existsSync(path.join(e.worktree, 'lenta.txt')) && fs.existsSync(path.join(e.worktree, 'delta.txt')));
});

test('Stratega smista i messaggi senza aggancio: seguito di un lavoro aperto, cosa nuova in parallelo, «Sgancia»', async () => {
  const root = makeFixtureRepo();
  let hold = null; let triaged = 0;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (/Smistamento di un nuovo messaggio/.test(o.prompt)) {
      triaged++;
      const msg = o.prompt.split('## Messaggio\n')[1].split('\n')[0];
      const open = [...o.prompt.matchAll(/### (R-\d+) — [^\n]*\nRichiesta: ([^\n]*)/g)].find((m) => /lenta/.test(m[2]))?.[1];
      return { text: /lenta/.test(msg) && open ? JSON.stringify({ decision: 'seguito', request: open, why: 'riguarda la stessa parola' }) : '{"decision":"nuova","request":null,"why":"altra parte del gioco"}' };
    }
    if (o.agent.id === 'director') {
      const w = (o.prompt.match(/PAROLA (\w+)/g) || []).pop()?.split(' ')[1] || 'x';
      return planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: `scrivi ${w}`, instructions: `PAROLA ${w}`, dependsOn: [] }]);
    }
    if (o.agent.id === 'dev') {
      const w = (o.prompt.match(/PAROLA (\w+)/g) || []).pop().split(' ')[1];
      if (w === 'lenta') await new Promise((r) => { hold = r; });
      fs.appendFileSync(path.join(o.cwd, `${w}.txt`), `${w}\n`);
      return { text: '{"summary":"ok"}' };
    }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov), { parallelPerAgent: 2, strategist: 'ai' });
  const o = s.orch;
  const a = await o.handleUserMessage('Fai PAROLA lenta');
  assert.equal(triaged, 0, 'nessun lavoro aperto: niente smistamento');
  await waitFor(() => hold, 15000, 'A al lavoro');
  const b = await o.handleUserMessage('la parola lenta falla PAROLA rossa');
  assert.equal(b.status, 'QUEUED'); assert.equal(b.parent, a.id); assert.equal(b.linkedBy, 'stratega');
  assert.ok(s.store.data.chat.some((m) => m.agentId === 'strategist' && m.requestId === b.id && /dipende da/.test(m.text)));
  const c = await o.handleUserMessage('Fai PAROLA verde');
  assert.ok(!c.parent, 'cosa indipendente: parte subito');
  await waitFor(() => c.status === 'DONE', 15000, 'C DONE in parallelo ad A');
  const d = await o.handleUserMessage('anche lenta: PAROLA eco');
  assert.equal(d.status, 'QUEUED');
  o.unlink(d.id);
  await waitFor(() => d.status === 'DONE', 15000, 'D sganciata e finita');
  assert.ok(!d.parent && d.branch !== a.branch);
  hold();
  await waitFor(() => b.status === 'DONE', 20000, 'B DONE dopo A');
  assert.ok(b.sameBranch); assert.equal(b.branch, a.branch);
  assert.throws(() => o.unlink(b.id), /già partita/);
});

test('Notaio: conta solo quello che si perde risolvendo i conflitti; i file di lavoro (.shots) non entrano; un seguito di sola risposta restituisce l\'unione', async () => {
  const { GitService } = await import('../server/git.js');
  const { ReleaseDesk } = await import('../server/release.js');
  // 1) una riga entrata dal gioco con l'allineamento e poi cambiata APPOSTA con un commit normale: non è persa
  const root = makeFixtureRepo();
  const f = path.join(root, 'src/main.js');
  const base = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'checkout', '-q', '-b', 'ramo');
  fs.appendFileSync(f, "console.log('mia');\n"); sh(root, 'commit', '-qam', 'mia');
  sh(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'src/altro.js'), "export const vecchio = 'gioco';\nexport const resta = [1, 2, 3];\n"); sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'gioco');
  sh(root, 'checkout', '-q', 'ramo');
  sh(root, 'merge', '-q', '--no-ff', '-m', 'allinea', 'main');
  fs.writeFileSync(path.join(root, 'src/altro.js'), "export const nuovo = 'riscritto apposta';\nexport const resta = [1, 2, 3];\n"); sh(root, 'commit', '-qam', 'riscrivo');
  const desk = new ReleaseDesk({ git: new GitService(root), store: { data: {} }, events: null, dataDir: path.join(root, '.studio-data') });
  let rc = await desk.resolutionCheck({ cwd: root, base, tip: 'ramo' });
  assert.deepEqual(rc.missing, [], 'una modifica fatta dopo, apposta, non è una riga persa');
  // 2) la stessa riga tolta DENTRO la soluzione di un conflitto e mai più rimessa: persa
  sh(root, 'checkout', '-q', 'main');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + "console.log('del gioco');\n"); sh(root, 'commit', '-qam', 'gioco 2');
  sh(root, 'checkout', '-q', 'ramo');
  try { sh(root, 'merge', '-q', '--no-ff', '-m', 'allinea 2', 'main'); } catch { /* conflitto atteso */ }
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/<<<<<<< .*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> .*\n/, '$1'));   // tiene solo la propria
  sh(root, 'commit', '-qam', 'allinea 2');
  rc = await desk.resolutionCheck({ cwd: root, base, tip: 'ramo' });
  assert.deepEqual(rc.missing.map((m) => m.line), ["console.log('del gioco');"]);

  // 3) .shots e simili restano fuori dai commit; seguito di sola risposta → la richiesta di prima torna unibile
  const root2 = makeFixtureRepo();
  let answerOnly = false;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (o.agent.id === 'director') return answerOnly ? planJSON([], 'Te lo spiego: è tutto a posto.') : planJSON([{ key: 'd', agent: 'dev', kind: 'implement', title: 'x', dependsOn: [] }]);
    if (o.agent.id === 'dev') { fs.mkdirSync(path.join(o.cwd, '.shots'), { recursive: true }); fs.writeFileSync(path.join(o.cwd, '.shots/prova.png'), 'png'); fs.writeFileSync(path.join(o.cwd, 'src/x.js'), 'export const x = 1;\n'); return { text: '{"summary":"ok"}' }; }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root2, registryWith(prov));
  const a = await s.orch.handleUserMessage('Fai x');
  await waitFor(() => a.status === 'DONE', 15000, 'A DONE');
  const files = sh(root2, 'ls-tree', '-r', '--name-only', a.branch).split('\n');
  assert.ok(files.includes('src/x.js') && !files.some((x) => x.startsWith('.shots/')), 'niente file di lavoro nel branch');
  answerOnly = true;
  const q = await s.orch.handleUserMessage('non capisco, spiegami', { replyTo: a.id });
  await waitFor(() => q.status === 'ANSWERED', 15000, 'risposta');
  assert.equal(a.followedBy, null, 'il seguito di sola risposta non si tiene l\'unione');
  await s.orch.merge(a.id);
  assert.ok(a.merged && fs.existsSync(path.join(root2, 'src/x.js')));
});

test('Stratega: una risposta secca a una scelta («1-b 2-a») va alla domanda aperta; «Chiudi» toglie una domanda appesa', async () => {
  const root = makeFixtureRepo();
  let asked = 0;
  const prov = new ScriptedProvider('scripted', async (o) => {
    if (/Smistamento/.test(o.prompt)) return { text: '{"decision":"nuova","request":null,"why":"sbaglio apposta"}' };
    if (o.agent.id === 'director') { asked++; return { text: '```json\n' + JSON.stringify({ reply: asked % 2 ? 'Domanda: 1) a o b? 2) a o b?' : 'ok', needsUser: !!(asked % 2), tasks: [] }) + '\n```' }; }
    return { text: '{"verdict":"PASS","summary":"ok"}' };
  });
  const s = await studioFor(root, registryWith(prov), { strategist: 'ai' });
  const q = await s.orch.handleUserMessage('Facciamo una prova?');
  await waitFor(() => q.status === 'NEEDS_USER', 15000, 'domanda');
  const r = await s.orch.handleUserMessage('1-b 2-a');
  assert.equal(r.continues, q.id, 'la risposta va alla domanda, anche se lo Stratega avrebbe detto "nuova"');
  const q2 = await s.orch.handleUserMessage('Un\'altra prova?');
  await waitFor(() => q2.status === 'NEEDS_USER', 15000, 'seconda domanda');
  s.orch.closeQuestion(q2.id);
  assert.equal(q2.status, 'ANSWERED');
});
