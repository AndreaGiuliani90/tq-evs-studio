// ORCHESTRATORE: la Regia (Director) + lo scheduler dei task + il ciclo QA.
//
//   messaggio utente → richiesta (R-xxxx) → piano della Regia → task con dipendenze → agenti in parallelo
//   → ogni task che scrive = commit a nome dell'agente → test QA → FAIL: task di correzione + nuovo test
//   (al massimo maxFixLoops giri, poi si passa la palla all'utente) → PASS: rapporto finale della Regia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { now, truncate, clip, extractJSON, run, ensureDir, writeFileAtomic } from './util.js';
import { directorPlanPrompt, taskPrompt, qaPrompt, reportPrompt, TASK_KINDS } from './prompts.js';

const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const WRITE_KINDS = ['implement', 'fix', 'narrative', 'art', 'level', 'audio', 'puzzle', 'lore', 'integrate'];
// tipi che cambiano il gioco: dopo di loro serve un test del QA (lore tocca solo i documenti)
const GAME_KINDS = ['implement', 'fix', 'narrative', 'art', 'level', 'audio', 'puzzle'];
// tipi che non toccano il repository del gioco: l'arredo dell'ufficio (dati) e il codice dello Studio (repository suo)
const STUDIO_KINDS = ['office', 'studio_ui'];

export class Orchestrator {
  constructor({ store, events, agents, providers, git, knowledge, config, studioDir, projectRoot, dataDir, qaRunner, office, studioGit }) {
    Object.assign(this, { store, events, agents, providers, git, knowledge, config, studioDir, projectRoot, dataDir, office, studioGit });
    this.running = new Map();   // taskId → { abort: AbortController, promise }
    this.planning = new Set();
    this.harness = path.join(studioDir, 'qa', 'game-test.mjs');
    this.qaRunner = qaRunner || ((args, cwd) => run(process.execPath, [this.harness, ...args], { cwd, timeoutMs: 15 * 60 * 1000 }));
    this.gitOk = null;
    this.idleTimers = new Map();
  }

  get S() { return this.store.data; }
  get uploadsDir() { return path.join(this.dataDir, 'uploads'); }
  attachOpts(req) {
    const att = req.attachments || [];
    return { addDirs: att.length ? [this.uploadsDir] : [], images: att.filter((a) => /^image\//.test(a.type)).map((a) => a.path) };
  }
  tasksOf(reqId) { return Object.values(this.S.tasks).filter((t) => t.requestId === reqId).sort((a, b) => a.id.localeCompare(b.id)); }
  agentName(id) { return this.agents.get(id)?.name || id; }

  // ─── avvio / ripresa dopo un riavvio ───────────────────────────────────────────────────────────
  async init() {
    this.gitOk = await this.git.available();
    for (const t of Object.values(this.S.tasks)) {
      if (t.status === 'RUNNING') { t.status = 'PENDING'; t.log.push({ ts: now(), text: 'ripreso dopo un riavvio dello Studio' }); }
    }
    for (const r of Object.values(this.S.requests)) {
      // copia di lavoro sparita (cartella spostata, altro computer, pulizia): la si ricrea dal branch
      if (this.gitOk && r.branch && !r.discarded && (!r.worktree || !fs.existsSync(r.worktree))) {
        const exists = (await this.git.git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`], this.projectRoot, { allowFail: true })).code === 0;
        if (exists) { r.worktree = null; await this.git.ensureWorktree(r).catch(() => { r.worktree = null; }); }
        else r.worktree = null;
      }
      if (r.status === 'PLANNING') this.plan(r).catch((e) => this.fail(r, e));
    }
    this.store.save();
    this.schedule();
  }

  // ─── chat ──────────────────────────────────────────────────────────────────────────────────────
  chat(role, text, extra = {}) {
    const m = { id: this.store.nextId('msg', 'M'), role, text, ts: now(), ...extra };
    if (extra.agentId) m.agentName = this.agentName(extra.agentId);
    this.S.chat.push(m);
    this.store.save();
    this.events.emit('chat.message', { message: m });
    return m;
  }

  async handleUserMessage(text, { attachments = [] } = {}) {
    text = String(text || '').trim();
    if (!text && !attachments.length) throw new Error('messaggio vuoto');
    if (!text) text = '(vedi allegati)';
    this.chat('user', text, attachments.length ? { attachments } : {});
    // se la Regia aveva fatto una domanda, questo messaggio è la risposta: la richiesta originale continua qui
    const asked = Object.values(this.S.requests).filter((r) => r.status === 'NEEDS_USER' && r.question && !r.answeredBy).sort((a, b) => b.id.localeCompare(a.id))[0];
    const req = { id: this.store.nextId('request', 'R'), text, status: 'PLANNING', createdAt: now(), taskIds: [], attachments: [...(asked?.attachments || []), ...attachments] };
    if (asked) { req.continues = asked.id; req.originalText = asked.originalText || asked.text; asked.answeredBy = req.id; this.setRequest(asked, { status: 'ANSWERED' }); }
    this.S.requests[req.id] = req;
    this.store.save();
    this.events.emit('request.created', { request: req });
    this.plan(req).catch((e) => this.fail(req, e));
    return req;
  }

  setRequest(req, patch) {
    Object.assign(req, patch, { updatedAt: now() });
    this.store.save();
    this.events.emit('request.updated', { request: req });
  }

  fail(req, e) {
    this.setRequest(req, { status: 'FAILED', error: String(e?.message || e) });
    this.agents.setStatus('director', 'ERROR', { task: null, text: `errore: ${e?.message || e}`, semantic: 'agent.failed' });
    this.chat('director', `Non sono riuscita a gestire la richiesta: ${e?.message || e}`, { agentId: 'director', requestId: req.id, kind: 'error' });
  }

  // ─── pianificazione (Regia) ────────────────────────────────────────────────────────────────────
  async plan(req) {
    if (this.planning.has(req.id)) return;
    this.planning.add(req.id);
    try {
      const director = this.agents.get('director');
      this.agents.setStatus('director', 'THINKING', { task: { id: req.id, title: `Pianifico: ${clip(req.text, 60)}` }, text: 'analizzo la richiesta', semantic: 'agent.thinking' });
      const plan = await this.directorPlan(req, director);
      req.plan = plan;
      if (!plan.tasks.length) {
        this.chat('director', plan.reply || 'Fatto.', { agentId: 'director', requestId: req.id, kind: plan.needsUser ? 'question' : 'text' });
        this.setRequest(req, { status: plan.needsUser ? 'NEEDS_USER' : 'ANSWERED', question: plan.needsUser ? plan.reply : null });
        this.agents.setStatus('director', 'IDLE', { task: null, text: 'risposta data' });
        return;
      }
      const needsGame = plan.tasks.some((pt) => !STUDIO_KINDS.includes(pt.kind));
      if (needsGame) {
        if (!this.gitOk) this.gitOk = await this.git.available();
        if (!this.gitOk) throw new Error('la cartella del gioco non è un repository git con almeno un commit: per sicurezza lo Studio non modifica file senza git');
        await this.git.ensureWorktree(req);
      }
      const keyToId = {};
      const created = [];
      for (const pt of plan.tasks) {
        const id = this.store.nextId('task', 'T');
        keyToId[pt.key] = id;
        created.push({ pt, id });
      }
      for (const { pt, id } of created) {
        this.createTask({ id, requestId: req.id, agentId: pt.agent, kind: pt.kind, title: pt.title, instructions: pt.instructions, dependsOn: (pt.dependsOn || []).map((k) => keyToId[k]).filter(Boolean) });
      }
      const lines = this.tasksOf(req.id).map((t) => `• ${this.agentName(t.agentId)} — ${t.title}${t.dependsOn.length ? ` (dopo ${t.dependsOn.map((d) => this.agentName(this.S.tasks[d]?.agentId)).join(', ')})` : ''}`);
      this.chat('director', `${plan.reply || 'Ci penso io.'}\n\n${lines.join('\n')}`, { agentId: 'director', requestId: req.id, kind: 'plan', taskIds: req.taskIds });
      if (req.baseDirty) this.chat('system', 'Nota: nella cartella del gioco ci sono modifiche non salvate in un commit. Lo Studio lavora sull\'ultimo commit in una copia separata e non tocca i tuoi file.', { requestId: req.id });
      this.setRequest(req, { status: 'RUNNING' });
      this.agents.setStatus('director', 'WAITING', { task: { id: req.id, title: `Coordino ${req.id}` }, text: `${req.taskIds.length} task delegati`, semantic: 'agent.waiting' });
      this.schedule();
    } finally { this.planning.delete(req.id); }
  }

  async directorPlan(req, director) {
    const agents = this.agents.list();
    const chat = this.S.chat.slice(-(this.config.chatContextMessages || 8) - 1, -1);
    const projectBrief = this.knowledge.read('PROJECT_STATE');
    const provider = await this.providers.resolve(director.provider);
    let plan = null, raw = null;
    if (provider.id !== 'mock') {
      const r = await provider.run({ agent: director, system: director.systemInstructions, prompt: directorPlanPrompt({ req, agents, chat, projectBrief, running: Object.values(this.S.requests).filter((x) => x.id !== req.id && ['RUNNING', 'PLANNING'].includes(x.status)) }), images: (req.attachments || []).filter((a) => /^image\//.test(a.type)).map((a) => a.path), addDirs: req.attachments?.length ? [this.uploadsDir] : [], cwd: this.projectRoot, mode: 'plan', model: director.model, timeoutMs: 8 * 60 * 1000, onEvent: (e) => this.onProviderEvent('director', null, e) });
      raw = r;
      if (r.ok) plan = extractJSON(r.text) || extractJSON(r.allText);
      if (!plan && r.ok && r.text) plan = { reply: r.text, tasks: [] };
      if (!r.ok) this.events.emit('studio.warning', { text: `Regia: provider ${provider.id} non ha risposto (${truncate(r.error, 200)}), uso il piano semplice` });
    }
    if (!plan) plan = this.heuristicPlan(req.text);
    return this.normalizePlan(plan, raw);
  }

  // Piano di riserva senza AI: parole chiave → agenti
  heuristicPlan(text) {
    const t = text.toLowerCase();
    const has = (re) => re.test(t);
    const tasks = [];
    const q = /\?\s*$/.test(t) && !has(/implementa|aggiungi|cambia|correggi|sistema|fai|crea|rendi/);
    if (q) return { reply: 'Senza un provider AI configurato posso solo smistare lavoro, non rispondere a domande. Vedi Impostazioni → Provider.', tasks: [] };
    const narrative = has(/dialog|testo|testi|battut|stori|narra|lore|personagg|scrivi|copy|nome/);
    const art = has(/grafic|sprite|asset|immagin|disegn|avatar|colore|pixel|icona|visiv/);
    const level = has(/mappa|rione|livello|piazza|varco|posiziona/) && this.agents.forKind('level');
    const audio = has(/suono|musica|audio|effetto sonoro|sfx|volume/) && this.agents.forKind('audio');
    const puzzle = has(/enigma|indagine|indizi|rompicapo|puzzle/) && this.agents.forKind('puzzle');
    const lore = has(/bibbia|canone|coerenz|lore/) && this.agents.forKind('lore');
    const office = has(/ufficio|arred|decor|scrivani|postazion|aspetto de|avatar|personagg.*studio/) && this.agents.forKind('office');
    if (office && !has(/gioco|livello|bug/)) return { reply: 'Ci pensa il Responsabile dell\'ufficio.', tasks: [{ key: 'o', agent: office.id, kind: 'office', title: 'Arredo dell\'ufficio', instructions: text, dependsOn: [] }] };
    const code = has(/implementa|bug|codice|gameplay|meccanic|aggiungi|correggi|sistema|boss|npc|nemic|comand|tasto|velocit|miglior/) || (!narrative && !art && !level && !audio && !puzzle && !lore);
    if (narrative) tasks.push({ key: 'n', agent: 'narrative', kind: 'narrative', title: 'Testi e dialoghi', instructions: text, dependsOn: [] });
    if (art) tasks.push({ key: 'a', agent: 'art', kind: 'art', title: 'Requisiti visivi', instructions: text, dependsOn: [] });
    if (puzzle) tasks.push({ key: 'p', agent: 'puzzle', kind: 'puzzle', title: 'Progetto dell\'enigma', instructions: text, dependsOn: [] });
    if (level) tasks.push({ key: 'l', agent: 'level', kind: 'level', title: 'Mappa e posizionamenti', instructions: text, dependsOn: [] });
    if (audio) tasks.push({ key: 's', agent: 'audio', kind: 'audio', title: 'Suono', instructions: text, dependsOn: [] });
    if (code) tasks.push({ key: 'd', agent: 'dev', kind: 'implement', title: 'Implementazione', instructions: text, dependsOn: tasks.map((x) => x.key) });
    if (lore) tasks.push({ key: 'b', agent: 'lore', kind: 'lore', title: 'Controllo del canone', instructions: text, dependsOn: tasks.map((x) => x.key) });
    return { reply: 'Smisto il lavoro alla squadra.', tasks };
  }

  normalizePlan(plan, raw) {
    const out = { reply: String(plan.reply || ''), needsUser: !!plan.needsUser, tasks: [] };
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const keys = new Set();
    for (const [i, t] of tasks.entries()) {
      let kind = TASK_KINDS[t.kind] ? t.kind : 'implement';
      let agent = this.agents.get(t.agent);
      if (!agent || agent.enabled === false || agent.id === 'director') agent = this.agents.forKind(kind);
      if (!agent) continue;
      if (!(agent.kinds || []).includes(kind) && agent.kinds?.length) {
        // agente giusto ma tipo sbagliato: si tiene l'agente, si usa il suo primo tipo
        const byKind = this.agents.forKind(kind);
        if (byKind) agent = byKind; else kind = agent.kinds[0];
      }
      const key = String(t.key || `t${i + 1}`);
      keys.add(key);
      out.tasks.push({ key, agent: agent.id, kind, title: clip(t.title || TASK_KINDS[kind], 100), instructions: String(t.instructions || t.title || ''), dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [] });
    }
    for (const t of out.tasks) t.dependsOn = t.dependsOn.filter((k) => keys.has(k) && k !== t.key);
    // regola dello studio: dopo ogni lavoro che cambia il gioco c'è un test del QA
    const qa = this.agents.forKind('test');
    const writers = out.tasks.filter((t) => GAME_KINDS.includes(t.kind));
    if (qa && writers.length) {
      const tests = out.tasks.filter((t) => t.kind === 'test');
      const covered = new Set(tests.flatMap((t) => this.closure(out.tasks, t)));
      const uncovered = writers.filter((w) => !covered.has(w.key));
      if (uncovered.length) out.tasks.push({ key: 'qa_auto', agent: qa.id, kind: 'test', title: 'Verifica QA delle modifiche', instructions: `Verifica che le modifiche funzionino e che il gioco non abbia regressioni. Richiesta: ${out.tasks.map((t) => t.title).join('; ')}`, dependsOn: uncovered.map((w) => w.key) });
    }
    // niente cicli: una dipendenza verso un task successivo che dipende da questo viene tolta
    for (const t of out.tasks) t.dependsOn = t.dependsOn.filter((k) => !this.closure(out.tasks, out.tasks.find((x) => x.key === k)).includes(t.key));
    out.raw = raw ? { ok: raw.ok, costUsd: raw.costUsd ?? null } : null;
    return out;
  }

  closure(tasks, t, seen = new Set()) {
    if (!t) return [];
    for (const k of t.dependsOn || []) { if (!seen.has(k)) { seen.add(k); this.closure(tasks, tasks.find((x) => x.key === k), seen); } }
    return [...seen];
  }

  // ─── task ──────────────────────────────────────────────────────────────────────────────────────
  createTask(def) {
    const t = {
      id: def.id || this.store.nextId('task', 'T'), requestId: def.requestId, agentId: def.agentId, kind: def.kind, title: def.title,
      instructions: def.instructions || '', dependsOn: def.dependsOn || [], status: 'PENDING', attempt: 0, loop: def.loop || 0,
      parentTaskId: def.parentTaskId || null, writes: WRITE_KINDS.includes(def.kind) && this.agents.get(def.agentId)?.writes !== false,
      createdAt: now(), log: [], result: null,
    };
    this.S.tasks[t.id] = t;
    const req = this.S.requests[t.requestId];
    if (req && !req.taskIds.includes(t.id)) req.taskIds.push(t.id);
    this.store.save();
    this.events.emit('task.created', { task: t });
    return t;
  }

  setTask(t, patch, logText) {
    Object.assign(t, patch, { updatedAt: now() });
    if (logText) t.log.push({ ts: now(), text: logText });
    this.store.save();
    this.events.emit('task.updated', { task: t });
    this.knowledge.regenerate(this.S);
  }

  // Lancia tutti i task pronti. Idempotente: si può chiamare quando si vuole.
  schedule() {
    // un agente può lavorare a più richieste insieme (copie di lavoro separate), fino a parallelPerAgent
    const load = {};
    for (const id of this.running.keys()) { const a = this.S.tasks[id]?.agentId; load[a] = (load[a] || 0) + 1; }
    const perAgent = Math.max(1, this.config.parallelPerAgent ?? 2);
    let officeBusy = [...this.running.keys()].some((id) => this.S.tasks[id]?.kind === 'office');
    for (const req of Object.values(this.S.requests).filter((r) => r.status === 'RUNNING')) {
      const tasks = this.tasksOf(req.id);
      // nello stesso worktree: chi scrive lavora da solo; chi legge (analisi, QA) può stare in parallelo con altri lettori
      let writeBusy = tasks.some((t) => t.status === 'RUNNING' && t.writes);
      let readBusy = tasks.some((t) => t.status === 'RUNNING' && !t.writes);
      for (const t of tasks.filter((x) => x.status === 'PENDING')) {
        const deps = t.dependsOn.map((d) => this.S.tasks[d]).filter(Boolean);
        if (deps.some((d) => d.status === 'CANCELLED' || (d.status === 'FAILED' && !d.superseded))) {
          this.setTask(t, { status: 'CANCELLED' }, 'annullato: un task da cui dipende è fallito');
          continue;
        }
        if (!deps.every((d) => d.status === 'DONE')) continue;
        if ((load[t.agentId] || 0) >= perAgent) continue;
        if (tasks.some((x) => x.status === 'RUNNING' && x.agentId === t.agentId)) continue;   // nella stessa richiesta, uno alla volta
        if (writeBusy || (t.writes && readBusy)) continue;
        if (t.kind === 'office' && officeBusy) continue;   // l'ufficio è uno solo: un riarredo alla volta
        if (t.kind === 'office') officeBusy = true;
        load[t.agentId] = (load[t.agentId] || 0) + 1;
        if (t.writes) writeBusy = true; else readBusy = true;
        this.startTask(t, req);
      }
      this.checkRequestDone(req);
    }
    this.refreshWaiting();
  }

  refreshWaiting() {
    const pending = Object.values(this.S.tasks).filter((t) => t.status === 'PENDING' && this.S.requests[t.requestId]?.status === 'RUNNING');
    for (const a of this.agents.list()) {
      if (a.id === 'director') continue;
      const isRunning = [...this.running.keys()].some((id) => this.S.tasks[id]?.agentId === a.id);
      if (isRunning) continue;
      const mine = pending.find((t) => t.agentId === a.id);
      if (mine) {
        const waitingFor = mine.dependsOn.map((d) => this.S.tasks[d]).filter((d) => d && d.status !== 'DONE').map((d) => this.agentName(d.agentId));
        const text = waitingFor.length ? `in attesa di ${[...new Set(waitingFor)].join(', ')}` : 'in coda';
        if (a.runtime.status !== 'WAITING' || a.runtime.currentTaskId !== mine.id) this.agents.setStatus(a.id, 'WAITING', { task: mine, text: `${mine.title} — ${text}`, semantic: 'agent.waiting' });
      } else if (a.runtime.status === 'WAITING') this.agents.setStatus(a.id, 'IDLE', { task: null });
    }
  }

  startTask(t, req) {
    const agent = this.agents.get(t.agentId);
    const ctrl = new AbortController();
    this.setTask(t, { status: 'RUNNING', startedAt: now(), attempt: t.attempt + 1 }, `avviato (tentativo ${t.attempt + 1})`);
    clearTimeout(this.idleTimers.get(agent.id));
    const status = t.kind === 'test' ? 'TESTING' : t.kind === 'analyze' ? 'THINKING' : 'WORKING';
    this.agents.setStatus(agent.id, status, { task: t, text: `inizio: ${t.title}`, semantic: 'agent.started_task' });
    const p = this.executeTask(t, req, agent, ctrl.signal)
      .then((res) => this.onTaskResult(t, req, agent, res))
      .catch((e) => this.onTaskResult(t, req, agent, { ok: false, error: String(e?.stack || e) }))
      .finally(() => { this.running.delete(t.id); this.schedule(); });
    this.running.set(t.id, { abort: ctrl, promise: p });
  }

  onProviderEvent(agentId, task, e) {
    const a = this.agents.get(agentId);
    if (!a) return;
    if (e.type === 'tool') {
      const file = e.input?.file_path || e.input?.path || e.input?.pattern || '';
      const short = typeof file === 'string' ? file.replace(/^.*\/worktrees\/[^/]+\//, '') : '';
      if (/^(Edit|Write|MultiEdit|write_file|replace_in_file)$/.test(e.tool)) {
        if (a.runtime.status !== 'TESTING') this.agents.setStatus(agentId, 'WORKING', { task: task ?? undefined });
        this.agents.activity(agentId, `modifica ${short}`, 'agent.editing', { tool: e.tool, file: short });
      } else if (/^Bash$/.test(e.tool)) {
        const cmd = String(e.input?.command || '').slice(0, 160);
        this.agents.activity(agentId, `esegue: ${cmd}`, /game-test|--check/.test(cmd) ? 'agent.testing' : 'agent.activity', { tool: e.tool, command: cmd });
      } else {
        this.agents.activity(agentId, `${e.tool} ${short}`.trim(), 'agent.activity', { tool: e.tool, file: short });
      }
    } else if (e.type === 'text' && e.text) {
      this.agents.activity(agentId, truncate(e.text.replace(/\s+/g, ' '), 200), 'agent.thinking');
    }
  }

  depsOf(t) {
    // i risultati di tutta la catena di dipendenze (utile al QA e alle correzioni)
    const seen = new Set(); const out = [];
    const walk = (id) => { const d = this.S.tasks[id]; if (!d || seen.has(id)) return; seen.add(id); d.dependsOn.forEach(walk); out.push({ ...d, agentName: this.agentName(d.agentId) }); };
    t.dependsOn.forEach(walk);
    return out;
  }

  async executeTask(t, req, agent, signal) {
    if (t.kind === 'test') return this.runQA(t, req, agent, signal);
    if (t.kind === 'office') return this.runOffice(t, req, agent, signal);
    if (t.kind === 'studio_ui') return this.runStudioUI(t, req, agent, signal);
    if (t.kind === 'integrate') {
      const mr = await this.git.git(['merge', '--no-ff', '--no-commit', req.baseBranch], req.worktree, { allowFail: true });
      const conflicted = (await this.git.git(['diff', '--name-only', '--diff-filter=U'], req.worktree, { allowFail: true })).stdout.trim();
      if (!conflicted) {
        const c = await this.git.commitAll(req.worktree, { agent, task: t, request: req, summary: `Allineato con ${req.baseBranch} (senza conflitti)` });
        return { ok: true, result: { summary: `Allineato con ${req.baseBranch}: nessun conflitto da risolvere.`, commit: c, filesChanged: c?.files || [] } };
      }
      t.instructions += `\n\nFile in conflitto:\n${conflicted}\n(esito dell'unione: ${truncate(mr.stdout + mr.stderr, 600)})`;
    }
    const provider = await this.providers.resolve(agent.provider);
    const mode = t.writes ? 'work' : 'readonly';
    const cwd = req.worktree;
    const qaCmd = `node ${this.harness} --root .`;
    let extra = t.kind === 'fix' && t.bugReport ? `## Bug report del QA\n${t.bugReport}` : '';
    if (t.lastError) extra += `\n\n## Il tentativo precedente di questo task è fallito\n${truncate(t.lastError, 2000)}\nTienine conto.`;
    if (t.kind === 'art' && provider.id === 'codex') extra += `\n\n## Immagini\nPuoi generare le immagini direttamente con il tuo strumento di generazione immagini (gpt-image). Salva ogni immagine finita come PNG in assets/generated/<nome>.png nella cartella di lavoro (sprite su fondo magenta pieno #FF00FF, come da convenzione del progetto). Elenca i file creati nel campo "imageRequests" del JSON finale (con il prompt usato).`;
    const startedAt = Date.now();
    const prompt = taskPrompt({ task: t, req, agent, deps: this.depsOf(t), contextList: this.knowledge.contextFor(agent, cwd, { inline: provider.id === 'anthropic' }), qaCmd, extra });
    const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd, mode, model: agent.model, signal, ...this.attachOpts(req), timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, extraAllowedTools: [`Bash(node ${this.harness}:*)`], onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.code === 'PROVIDER_UNAVAILABLE' };
    const j = extractJSON(r.text) || extractJSON(r.allText) || {};
    const result = { summary: j.summary || truncate(r.text, 600), handoff: j.handoff || '', notes: j.notes || '', output: truncate(r.text, 6000), provider: provider.id, costUsd: r.costUsd ?? null, durationMs: r.durationMs };
    if (t.kind === 'art') {
      const made = provider.id === 'codex' ? this.collectCodexImages(cwd, startedAt) : [];
      const pending = (j.imageRequests || []).filter((ir) => !made.includes(String(ir.file || '').replace(/^\/+/, '')));
      result.images = [...made.map((f) => ({ file: f, status: 'generated', provider: 'codex' })), ...(await this.generateImages(pending, req, agent, t))];
      if (made.length) this.recordImages(req, agent, t, made, j.imageRequests || []);
    }
    if (t.kind === 'integrate') {
      const left = (await this.git.git(['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) '], cwd, { allowFail: true })).stdout.trim();
      if (left) return { ok: false, error: `restano segni di conflitto in: ${left}` };
    }
    if (t.writes) {
      const commit = await this.git.commitAll(cwd, { agent, task: t, request: req, summary: result.summary });
      result.commit = commit;
      result.filesChanged = commit?.files || [];
      if (commit) this.agents.activity(agent.id, `commit ${commit.short}: ${commit.files.length} file`, 'agent.activity');
    } else {
      const stray = await this.git.revertUncommitted(cwd);
      if (stray.length) result.notes = `${result.notes} [lo Studio ha annullato modifiche non previste per un task di sola lettura: ${stray.join(', ')}]`.trim();
    }
    return { ok: true, result };
  }

  // immagini fatte da Codex: quelle nuove in assets/generated/ e, se le ha lasciate nella sua cartella, ~/.codex/generated_images
  collectCodexImages(cwd, since) {
    const out = [];
    const gen = path.join(cwd, 'assets', 'generated');
    ensureDir(gen);
    const scan = (dir, copy) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p, copy); continue; }
        if (!/\.(png|jpe?g|webp)$/i.test(e.name) || fs.statSync(p).mtimeMs < since - 1000) continue;
        let dest = p;
        if (copy) { dest = path.join(gen, e.name); if (!fs.existsSync(dest)) fs.copyFileSync(p, dest); }
        out.push(path.relative(cwd, dest));
      }
    };
    scan(gen, false);
    scan(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images'), true);
    return [...new Set(out)];
  }

  recordImages(req, agent, t, files, requests) {
    const metaFile = path.join(req.worktree, 'assets', 'generated', 'metadata.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { assets: [] };
    for (const f of files) {
      if (meta.assets.some((a) => a.file === f && a.status === 'generated')) continue;
      const ir = requests.find((r) => String(r.file || '').replace(/^\/+/, '') === f) || {};
      meta.assets.push({ file: f, prompt: ir.prompt || '', purpose: ir.purpose || '', agent: agent.id, task: t.id, request: req.id, provider: 'codex', status: 'generated', createdAt: now() });
      this.events.emit('asset.created', { agentId: agent.id, file: f, requestId: req.id });
    }
    writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
  }

  async generateImages(requests, req, agent, t) {
    if (!Array.isArray(requests) || !requests.length) return [];
    const provider = await this.providers.resolveImage(agent.imageProvider || 'auto');
    const av = provider ? await provider.available() : { ok: false, reason: 'nessun provider immagini configurato (GPT Image o Nano Banana: vedi Impostazioni)' };
    const out = [];
    const metaFile = path.join(req.worktree, 'assets', 'generated', 'metadata.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { assets: [] };
    for (const ir of requests.slice(0, 6)) {
      const rel = String(ir.file || `assets/generated/${t.id.toLowerCase()}.png`).replace(/^\/+/, '');
      if (!rel.startsWith('assets/') || rel.includes('..')) { out.push({ file: rel, status: 'rifiutato: deve stare sotto assets/' }); continue; }
      const entry = { file: rel, prompt: ir.prompt, size: ir.size || '1024x1024', purpose: ir.purpose || '', agent: agent.id, task: t.id, request: req.id, createdAt: now() };
      if (!av.ok) { entry.status = 'pending'; entry.reason = av.reason; out.push(entry); meta.assets.push(entry); continue; }
      this.agents.activity(agent.id, `genera immagine ${rel}`, 'agent.editing', { file: rel });
      // reference: file del gioco (sprite esistenti) o allegati dell'utente, per restare coerenti con lo stile
      const refs = (Array.isArray(ir.references) ? ir.references : []).map((r) => (path.isAbsolute(r) ? r : path.join(req.worktree, r)))
        .filter((r) => r.startsWith(req.worktree) || r.startsWith(this.uploadsDir));
      entry.references = refs.map((r) => path.relative(req.worktree, r));
      const g = await provider.generate({ prompt: ir.prompt, size: entry.size, references: refs });
      if (g.ok) { ensureDir(path.dirname(path.join(req.worktree, rel))); fs.writeFileSync(path.join(req.worktree, rel), g.png); entry.status = 'generated'; entry.provider = provider.id; this.events.emit('asset.created', { agentId: agent.id, file: rel, requestId: req.id }); }
      else { entry.status = 'error'; entry.reason = g.error; }
      out.push(entry); meta.assets.push(entry);
    }
    writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
    return out;
  }

  // ─── Responsabile dell'ufficio ───────────────────────────────────────────────────────────────────
  async runOffice(t, req, agent, signal) {
    if (!this.office) return { ok: false, error: 'ufficio non disponibile' };
    const dir = this.office.prepareWorkspace(t.id, this.agents);
    const provider = await this.providers.resolve(agent.provider);
    const prompt = taskPrompt({ task: t, req, agent, deps: this.depsOf(t), contextList: '- GUIDA_UFFICIO.md (in questa cartella): come sono fatti office.json e agents-look.json', qaCmd: null,
      extra: `## Cartella di lavoro\nSei in una cartella con office.json (la stanza), agents-look.json (l'aspetto dei personaggi) e GUIDA_UFFICIO.md. Leggi la guida, poi modifica SOLO questi due file JSON (devono restare JSON validi). Non ci sono altri file da toccare.${t.lastError ? `\n\nIl tentativo precedente è stato rifiutato: ${truncate(t.lastError, 1500)}` : ''}` });
    const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd: dir, mode: 'work', model: agent.model, signal, ...this.attachOpts(req), timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.code === 'PROVIDER_UNAVAILABLE' };
    let applied;
    try { applied = this.office.apply(dir, this.agents); } catch (e) { return { ok: false, error: `modifica all'ufficio rifiutata: ${e.message}` }; }
    const j = extractJSON(r.text) || {};
    const what = [applied.officeChanged ? 'ufficio riarredato' : null, applied.changedAvatars.length ? `aspetto di ${applied.changedAvatars.map((id) => this.agentName(id)).join(', ')}` : null].filter(Boolean).join(' · ') || 'nessuna modifica';
    return { ok: true, result: { summary: j.summary || truncate(r.text, 500), output: truncate(r.text, 4000), office: applied, notes: `${what}. Annullabile col pulsante "Annulla ultimo arredo".`, provider: provider.id } };
  }

  // ─── Codice dello Studio (interfaccia, grafica): repository dello Studio, branch separato ────────
  async runStudioUI(t, req, agent, signal) {
    if (!this.studioGit || !(await this.studioGit.available())) return { ok: false, error: 'la cartella dello Studio non è un repository git: le modifiche al programma non sono sicure', blocked: true };
    req.studio ??= { id: `${req.id}-studio`, text: req.text };
    await this.studioGit.ensureWorktree(req.studio);
    this.store.save();
    const cwd = req.studio.worktree;
    const provider = await this.providers.resolve(agent.provider);
    const prompt = taskPrompt({ task: t, req, agent, deps: this.depsOf(t), contextList: '- README.md (com\'è fatto lo Studio)\n- web/ (interfaccia: app.js, office.js ufficio, sprites.js personaggi, styles.css)\n- server/ (backend)', qaCmd: null,
      extra: `## Stai modificando il programma GAME STUDIO (non il gioco)\nCartella: una copia di lavoro del repository dello Studio. Modifiche mirate; niente dipendenze nuove; interfaccia in italiano. Alla fine lo Studio lancia i suoi test automatici (npm test): devono passare.${t.lastError ? `\n\nIl tentativo precedente è fallito:\n${truncate(t.lastError, 2000)}` : ''}` });
    const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd, mode: 'work', model: agent.model, signal, ...this.attachOpts(req), timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, extraAllowedTools: ['Bash(npm test:*)'], onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.code === 'PROVIDER_UNAVAILABLE' };
    // verifica: sintassi di tutti i moduli + test dello Studio
    this.agents.setStatus(agent.id, 'TESTING', { task: t, text: 'verifico lo Studio (sintassi + npm test)', semantic: 'agent.testing' });
    const check = await this.checkStudio(cwd);
    if (!check.ok) { await this.studioGit.revertUncommitted(cwd); return { ok: false, error: `le verifiche dello Studio non passano:\n${check.detail}` }; }
    const j = extractJSON(r.text) || {};
    const commit = await this.studioGit.commitAll(cwd, { agent, task: t, request: req, summary: j.summary || '' });
    return { ok: true, result: { summary: j.summary || truncate(r.text, 500), output: truncate(r.text, 4000), commit, filesChanged: commit?.files || [], studioChecks: check.detail, provider: provider.id } };
  }

  async checkStudio(cwd) {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'data', '.git'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) files.push(p); } };
    walk(cwd);
    const bad = [];
    for (const f of files) {
      const tmp = path.join(this.dataDir, 'tmp-check.mjs'); fs.copyFileSync(f, tmp);
      const r = await run(process.execPath, ['--check', tmp], { timeoutMs: 20000 });
      if (r.code !== 0) bad.push(`${path.relative(cwd, f)}: ${r.stderr.split('\n').slice(0, 3).join(' ')}`);
    }
    if (bad.length) return { ok: false, detail: `errori di sintassi:\n${bad.join('\n')}` };
    if (this.config.studioTests === false) return { ok: true, detail: `${files.length} file JS controllati (test dello Studio disattivati)` };
    if (!fs.existsSync(path.join(cwd, 'node_modules')) && fs.existsSync(path.join(this.studioDir, 'node_modules'))) { try { fs.symlinkSync(path.join(this.studioDir, 'node_modules'), path.join(cwd, 'node_modules'), 'dir'); } catch { /* pazienza */ } }
    const r = await run(process.execPath, ['--test', 'test/studio.test.js'], { cwd, timeoutMs: 4 * 60 * 1000, env: { ...process.env, STUDIO_PROJECT_ROOT: this.projectRoot } });
    const tail = (r.stdout + r.stderr).split('\n').filter((l) => /^# (pass|fail)|^not ok|error:/.test(l)).slice(0, 20).join('\n');
    return { ok: r.code === 0, detail: `${files.length} file JS controllati\n${tail}` };
  }

  // ─── QA ────────────────────────────────────────────────────────────────────────────────────────
  async runQA(t, req, agent, signal) {
    const cwd = req.worktree;
    const outDir = ensureDir(path.join(this.dataDir, 'artifacts', t.id));
    this.agents.setStatus(agent.id, 'TESTING', { task: t, text: 'lancio il QA harness (statico + browser)', semantic: 'agent.testing' });
    const args = ['--root', cwd, '--json', '--out', outDir, '--settle', String(this.config.qaSettleMs ?? 2500)];
    if (this.config.qaBrowser === false) args.push('--no-browser');
    const hr = await this.qaRunner(args, cwd);
    let harness = extractJSON(hr.stdout);
    if (!harness) harness = { verdict: 'FAIL', static: { ok: false, checks: [{ name: 'harness eseguito', ok: false, detail: truncate(hr.stderr || hr.stdout, 800) }] }, browser: { available: false, ok: false, note: 'harness non eseguito' } };
    const harnessSummary = summarizeHarness(harness);
    this.agents.activity(agent.id, `harness: ${harness.verdict}`, 'agent.testing', { verdict: harness.verdict });
    const deps = this.depsOf(t);
    const provider = await this.providers.resolve(agent.provider);
    let verdict = harness.verdict, summary = `Test automatico: ${harness.verdict}.`, bugs = [], checks = [], output = '';
    if (provider.id !== 'mock') {
      const diff = await this.git.diffText(cwd, req.baseCommit);
      const prompt = qaPrompt({ task: t, req, agent, deps, diff, harnessSummary, harnessCmd: `node ${this.harness} --root .`, outDir, contextList: this.knowledge.contextFor(agent, cwd) });
      const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd, mode: 'readonly', model: agent.model, signal, ...this.attachOpts(req), timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, extraAllowedTools: [`Bash(node ${this.harness}:*)`, `Read(${outDir}/**)`], onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
      if (!r.ok) return { ok: false, error: r.error };
      const j = extractJSON(r.text) || extractJSON(r.allText);
      output = truncate(r.text, 5000);
      if (j && /^(PASS|FAIL)$/i.test(j.verdict || '')) {
        verdict = String(j.verdict).toUpperCase();
        summary = j.summary || summary; bugs = j.bugs || []; checks = j.checks || [];
      } else summary = `${summary} (il QA non ha dato un verdetto leggibile: vale quello del test automatico)`;
      if (harness.verdict === 'FAIL' && verdict === 'PASS') { verdict = 'FAIL'; summary = `${summary} — ma il test automatico è FALLITO: si corregge prima.`; }
    }
    if (verdict === 'FAIL' && !bugs.length) bugs = harnessBugs(harness);
    const stray = await this.git.revertUncommitted(cwd);   // il QA non corregge di nascosto
    return { ok: true, result: { verdict, summary, bugs, checks, output, harness: { verdict: harness.verdict, summary: harnessSummary, screenshots: harness.browser?.screenshots || [] }, strayEditsReverted: stray, provider: provider.id } };
  }

  // ─── esito di un task ──────────────────────────────────────────────────────────────────────────
  onTaskResult(t, req, agent, res) {
    if (t.status === 'CANCELLED') { this.agents.setStatus(agent.id, 'IDLE', { task: null, text: 'task annullato' }); return; }
    if (!res.ok) {
      const canRetry = !res.blocked && t.attempt <= (this.config.maxTaskRetries ?? 1);
      if (canRetry) {
        this.setTask(t, { status: 'PENDING', lastError: truncate(res.error, 2000) }, `errore, riprovo: ${truncate(res.error, 300)}`);
        this.agents.setStatus(agent.id, 'ERROR', { task: t, text: `errore, riprovo: ${truncate(res.error, 160)}`, semantic: 'agent.failed' });
        return;
      }
      this.setTask(t, { status: 'FAILED', finishedAt: now(), lastError: truncate(res.error, 2000) }, `fallito: ${truncate(res.error, 300)}`);
      agent.runtime.stats.failed++;
      this.agents.setStatus(agent.id, res.blocked ? 'BLOCKED' : 'ERROR', { task: t, text: truncate(res.error, 200), semantic: res.blocked ? 'agent.blocked' : 'agent.failed' });
      this.escalate(req, `${agent.name} non è riuscito a completare "${t.title}": ${truncate(res.error, 500)}`, res.blocked);
      return;
    }
    const r = res.result;
    if (t.kind === 'test' && r.verdict === 'FAIL') {
      this.setTask(t, { status: 'FAILED', finishedAt: now(), result: r }, `QA: FAIL — ${truncate(r.summary, 200)}`);
      this.agents.setStatus(agent.id, 'DONE', { task: t, text: `FAIL: ${truncate(r.summary, 160)}`, semantic: 'agent.completed' });
      this.chat('agent', `❌ Test non superato: ${r.summary}\n${(r.bugs || []).slice(0, 3).map((b) => `• ${b.title}`).join('\n')}`, { agentId: agent.id, requestId: req.id, taskId: t.id, kind: 'agent-update' });
      this.handleQAFailure(t, req, r);
      return;
    }
    this.setTask(t, { status: 'DONE', finishedAt: now(), result: r }, `completato${r.commit ? ` (commit ${r.commit.short})` : ''}`);
    agent.runtime.stats.done++;
    this.agents.setStatus(agent.id, 'DONE', { task: t, text: truncate(r.summary, 200), semantic: 'agent.completed' });
    this.chat('agent', `${t.kind === 'test' ? '✅ Test superato: ' : '✔ '}${truncate(r.summary, 500)}${r.commit ? `\n(commit ${r.commit.short}, ${r.commit.files.length} file)` : ''}`, { agentId: agent.id, requestId: req.id, taskId: t.id, kind: 'agent-update' });
    // dopo un po' l'agente torna libero (l'animazione DONE resta visibile qualche secondo)
    this.idleTimers.set(agent.id, setTimeout(() => { if (agent.runtime.status === 'DONE' && ![...this.running.keys()].some((id) => this.S.tasks[id]?.agentId === agent.id)) { this.agents.setStatus(agent.id, 'IDLE', { task: null }); this.refreshWaiting(); } }, 8000).unref?.() ?? null);
  }

  handleQAFailure(testTask, req, r) {
    const loop = testTask.loop || 0;
    const dev = this.agents.forKind('fix');
    // giri già usati in questa "tornata" (un Riprova dell'utente ne apre una nuova)
    const used = loop + 1 - (req.fixBudgetBase || 0);
    if (!dev || used >= (this.config.maxFixLoops ?? 3)) {
      this.escalate(req, `Dopo ${loop + 1} giri di correzione il test "${testTask.title}" non passa ancora. Ultimo esito: ${r.summary}`, false, testTask);
      return;
    }
    const bugReport = (r.bugs || []).map((b, i) => `${i + 1}. ${b.title}\n   Passi: ${b.steps || '-'}\n   Atteso: ${b.expected || '-'}\n   Ottenuto: ${b.actual || '-'}`).join('\n') + `\n\nEsito del test automatico:\n${r.harness?.summary || ''}`;
    const fix = this.createTask({ requestId: req.id, agentId: dev.id, kind: 'fix', title: `Correggi: ${clip((r.bugs?.[0]?.title) || r.summary, 70)}`, instructions: `Il QA ha trovato dei problemi nelle modifiche di questa richiesta. Correggili (senza rifare tutto) e verifica.\n\nVerifica originale: ${testTask.instructions}`, dependsOn: [], loop: loop + 1, parentTaskId: testTask.id });
    fix.bugReport = bugReport;
    const retest = this.createTask({ requestId: req.id, agentId: testTask.agentId, kind: 'test', title: `Riprova: ${testTask.title.replace(/^Riprova: /, '')}`, instructions: `${testTask.instructions}\n\nÈ il giro di verifica n. ${loop + 2}: controlla in particolare che siano risolti questi problemi:\n${bugReport}`, dependsOn: [fix.id], loop: loop + 1, parentTaskId: testTask.id });
    testTask.superseded = retest.id;
    // chi aspettava il vecchio test ora aspetta il nuovo
    for (const t of this.tasksOf(req.id)) if (t.dependsOn.includes(testTask.id)) t.dependsOn = t.dependsOn.map((d) => (d === testTask.id ? retest.id : d));
    this.store.save();
    this.chat('director', `Rimando a ${dev.name} per la correzione (giro ${used} di ${(this.config.maxFixLoops ?? 3) - 1}), poi ${this.agentName(testTask.agentId)} riprova.`, { agentId: 'director', requestId: req.id, kind: 'text' });
  }

  escalate(req, text, blocked, task) {
    // i task ancora in attesa di questa richiesta non partiranno
    for (const t of this.tasksOf(req.id)) if (t.status === 'PENDING') this.setTask(t, { status: 'CANCELLED' }, 'annullato: la richiesta è passata all\'utente');
    this.setRequest(req, { status: 'NEEDS_USER', escalation: text });
    this.chat('director', `⚠️ Serve una tua decisione su ${req.id}.\n${text}\n\n${blocked ? 'Configura un provider AI (Impostazioni → Provider) e premi "Riprova".' : 'Puoi: premere "Riprova" (rimette in coda i task non riusciti), scrivermi come procedere, oppure scartare il branch.'} Il lavoro fatto finora è nel branch ${req.branch || '-'}.`, { agentId: 'director', requestId: req.id, kind: 'escalation' });
    this.agents.setStatus('director', 'BLOCKED', { task: { id: req.id, title: `Decisione richiesta: ${req.id}` }, text, semantic: 'agent.blocked' });
    this.appendKnownIssue(req, text, task).catch(() => {});
  }

  async resolveKnownIssue(req) {
    const f = path.join(req.worktree, 'docs', 'memoria', 'KNOWN_ISSUES.md');
    if (!fs.existsSync(f)) return;
    const t = fs.readFileSync(f, 'utf8');
    const u = t.split('\n').map((l) => (l.includes(`· ${req.id}`) && l.includes('· APERTO —') ? l.replace('· APERTO —', `· RISOLTO ${now().slice(0, 10)} —`) : l)).join('\n');
    if (u === t) return;
    fs.writeFileSync(f, u);
    await this.git.commitAll(req.worktree, { agent: this.agents.get('director'), task: { id: req.id, title: 'KNOWN_ISSUES: problema risolto' }, request: req, summary: 'Il test ora passa.' });
    req.knownIssueLogged = false;
  }

  async appendKnownIssue(req, text, task) {
    if (!req.worktree) return;
    const f = path.join(req.worktree, 'docs', 'memoria', 'KNOWN_ISSUES.md');
    if (!fs.existsSync(f)) return;
    req.knownIssueLogged = true;
    fs.appendFileSync(f, `\n- ${now().slice(0, 10)} · ${req.id}${task ? ' · ' + task.id : ''} · APERTO — ${text.replace(/\n/g, ' ')} (branch \`${req.branch}\`)\n`);
    const director = this.agents.get('director');
    await this.git.commitAll(req.worktree, { agent: director, task: { id: task?.id || req.id, title: 'KNOWN_ISSUES: problema non risolto' }, request: req, summary: text });
  }

  checkRequestDone(req) {
    if (req.status !== 'RUNNING' || req.finalizing) return;
    const tasks = this.tasksOf(req.id);
    if (!tasks.length || !tasks.every((t) => TERMINAL.includes(t.status))) return;
    if (tasks.some((t) => this.running.has(t.id))) return;
    const unresolved = tasks.filter((t) => t.status === 'FAILED' && !t.superseded);
    if (unresolved.length) return;   // gestiti da escalate()
    req.finalizing = true;
    this.finalize(req).catch((e) => this.fail(req, e)).finally(() => { req.finalizing = false; this.store.save(); });
  }

  // ─── rapporto finale ───────────────────────────────────────────────────────────────────────────
  async finalize(req) {
    this.agents.setStatus('director', 'THINKING', { task: { id: req.id, title: `Rapporto finale ${req.id}` }, text: 'scrivo il rapporto', semantic: 'agent.thinking' });
    const tasks = this.tasksOf(req.id);
    const diff = req.worktree ? await this.git.diffSummary(req.worktree, req.baseCommit) : { stat: '', files: [], commits: [] };
    const sdiff = req.studio?.worktree ? await this.studioGit.diffSummary(req.studio.worktree, req.studio.baseCommit) : null;
    const tests = tasks.filter((t) => t.kind === 'test').map((t) => ({ taskId: t.id, agent: this.agentName(t.agentId), verdict: t.result?.verdict || t.status, summary: t.result?.summary, checks: t.result?.checks || [], harness: t.result?.harness?.verdict, screenshots: (t.result?.harness?.screenshots || []).map((s) => path.basename(s)) }));
    const participants = {};
    for (const t of tasks) { const n = this.agentName(t.agentId); participants[n] = participants[n] || { id: t.agentId, name: n, role: this.agents.get(t.agentId)?.role, tasks: [] }; participants[n].tasks.push(`${t.id} ${t.kind}: ${t.title} → ${t.status}${t.result?.verdict ? ' ' + t.result.verdict : ''}`); }
    const lastTest = [...tests].reverse().find(Boolean);
    const anyChange = diff.commits.length || sdiff?.commits.length || tasks.some((t) => t.kind === 'office' && t.status === 'DONE');
    const result = !anyChange && !tasks.some((t) => t.kind === 'test') ? 'NESSUNA MODIFICA' : (lastTest?.verdict === 'PASS' || !lastTest ? 'PASS' : 'FAIL');
    const facts = {
      request: req.text, result, branch: req.branch, baseBranch: req.baseBranch, baseCommit: req.baseCommit?.slice(0, 7),
      agents: Object.values(participants), tests, filesChanged: diff.files, commits: diff.commits.map((c) => `${c.short} ${c.author}: ${c.subject}`),
      summaries: tasks.filter((t) => t.status === 'DONE').map((t) => `${this.agentName(t.agentId)}: ${t.result?.summary || ''}`),
      fixLoops: tasks.filter((t) => t.kind === 'fix').length,
      studioCommits: sdiff ? sdiff.commits.map((c) => `${c.short} ${c.author}: ${c.subject}`) : [],
      studioFiles: sdiff ? sdiff.files : [],
      studioBranch: req.studio?.branch || null,
      officeChanges: tasks.filter((t) => t.kind === 'office' && t.status === 'DONE').map((t) => t.result?.notes),
    };
    let prose = '';
    const director = this.agents.get('director');
    const provider = await this.providers.resolve(director.provider);
    if (this.config.directorProseReport !== false && provider.id !== 'mock') {
      const r = await provider.run({ agent: director, system: director.systemInstructions, prompt: reportPrompt({ req, facts }), cwd: req.worktree, mode: 'plan', model: director.model, timeoutMs: 5 * 60 * 1000, maxTurns: 3, onEvent: () => {} });
      if (r.ok) prose = String(r.text || '').trim();
    }
    if (!prose) prose = [`Richiesta completata: ${result}.`, ...facts.summaries].join('\n');
    if (result === 'PASS' && req.knownIssueLogged) await this.resolveKnownIssue(req).catch(() => {});
    const report = { ...facts, prose, stat: diff.stat, createdAt: now() };
    this.setRequest(req, { status: 'DONE', result, report, finishedAt: now() });
    let mergeNote = `Le modifiche sono nel branch \`${req.branch}\`: provale con "Gioca questa versione", poi "Unisci" per portarle nel tuo ${req.baseBranch}.`;
    if (this.config.autoMerge && result === 'PASS' && diff.commits.length) {
      try { const m = await this.git.merge(req); this.setRequest(req, { mergeCommit: m.mergeCommit, merged: true }); mergeNote = `Unito automaticamente in ${req.baseBranch} (${m.mergeCommit.slice(0, 7)}).`; }
      catch (e) { mergeNote = `Unione automatica non fatta: ${e.message}`; }
    }
    if (!diff.commits.length) mergeNote = 'Nessun file del gioco è stato modificato.';
    if (sdiff?.commits.length) mergeNote += `\nModifiche al programma dello Studio nel branch \`${req.studio.branch}\`: premi "Unisci", poi riavvia lo Studio (./stop-studio.sh && ./start-studio.sh).`;
    if (facts.officeChanges.length) mergeNote += '\nL\'ufficio è già cambiato: se non ti piace, "Annulla ultimo arredo" in alto a destra nell\'ufficio.';
    this.chat('director', `${prose}\n\n${mergeNote}`, { agentId: 'director', requestId: req.id, kind: 'report', report });
    this.agents.setStatus('director', 'IDLE', { task: null, text: `rapporto ${req.id}: ${result}` });
  }

  // ─── azioni dell'utente ────────────────────────────────────────────────────────────────────────
  retry(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    this.setRequest(req, { status: 'RUNNING', escalation: null });
    for (const t of this.tasksOf(reqId)) {
      if (t.status === 'FAILED' && !t.superseded && t.kind === 'test' && t.result?.verdict === 'FAIL') {
        // test fallito: nuova tornata di correzioni (non si ripete lo stesso test sullo stesso codice)
        req.fixBudgetBase = t.loop || 0;
        this.handleQAFailure(t, req, t.result);
      } else if ((t.status === 'FAILED' && !t.superseded) || t.status === 'CANCELLED') {
        this.setTask(t, { status: 'PENDING', attempt: 0 }, 'rimesso in coda dall\'utente');
      }
    }
    this.agents.setStatus('director', 'WAITING', { task: { id: req.id, title: `Coordino ${req.id}` }, text: 'riprovo' });
    this.schedule();
    return req;
  }

  cancel(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    for (const t of this.tasksOf(reqId)) {
      if (t.status === 'PENDING' || t.status === 'RUNNING') {
        this.running.get(t.id)?.abort.abort();
        this.setTask(t, { status: 'CANCELLED' }, 'annullato dall\'utente');
        this.agents.setStatus(t.agentId, 'IDLE', { task: null, text: 'task annullato' });
      }
    }
    this.setRequest(req, { status: 'CANCELLED' });
    this.agents.setStatus('director', 'IDLE', { task: null });
    this.refreshWaiting();
    return req;
  }

  async merge(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (req.merged) throw new Error('già unita');
    const lines = [];
    if (req.branch && req.report?.commits?.length) {
      let m;
      try { m = await this.git.merge(req); }
      catch (e) {
        if (!/conflitto|conflict|Unione non riuscita/i.test(e.message)) throw e;
        this.integrate(req);
        return req;
      }
      this.setRequest(req, { mergeCommit: m.mergeCommit });
      lines.push(`Gioco: unito ${req.branch} in ${req.baseBranch} (commit ${m.mergeCommit.slice(0, 7)}). Per annullare: "Annulla unione" o \`git revert -m 1 ${m.mergeCommit.slice(0, 7)}\`.`);
    }
    if (req.studio?.branch && req.report?.studioCommits?.length) {
      const m = await this.studioGit.merge(req.studio);
      req.studio.mergeCommit = m.mergeCommit;
      lines.push(`Studio: unito ${req.studio.branch} (commit ${m.mergeCommit.slice(0, 7)}). Riavvia lo Studio per vederlo: ./stop-studio.sh && ./start-studio.sh`);
    }
    if (!lines.length) throw new Error('niente da unire');
    this.setRequest(req, { merged: true, mergedAt: now() });
    this.chat('system', lines.join('\n'), { requestId: req.id });
    return req;
  }

  // Due richieste hanno toccato gli stessi file (tipico: versione e CHANGELOG). Lo sviluppo porta nel branch le novità
  // del branch principale, risolve i conflitti, il QA riprova; poi si può unire.
  integrate(req) {
    const dev = this.agents.forKind('fix');
    const qa = this.agents.forKind('test');
    const t1 = this.createTask({ requestId: req.id, agentId: dev.id, kind: 'integrate', title: `Allinea con ${req.baseBranch} e risolvi i conflitti`, instructions: `Mentre lavoravamo a questa richiesta, nel branch ${req.baseBranch} sono entrate altre modifiche che toccano gli stessi file. Lo Studio ha avviato l'unione di ${req.baseBranch} in questo branch: risolvi i conflitti (cerca i segni <<<<<<< ======= >>>>>>>), tenendo TUTTE e due le modifiche. Regole: in src/version.js tieni la versione più alta e aumentala di una PATCH; in CHANGELOG.md tieni tutte le voci, la tua in cima con il nuovo numero. Poi controlla che non restino segni di conflitto.`, dependsOn: [] });
    const deps = [t1.id];
    if (qa) deps.push(this.createTask({ requestId: req.id, agentId: qa.id, kind: 'test', title: 'Riprova dopo l\'allineamento', instructions: 'Verifica che le modifiche di questa richiesta e quelle già presenti nel gioco funzionino insieme, senza regressioni.', dependsOn: [t1.id] }).id);
    this.setRequest(req, { status: 'RUNNING', finalizing: false, report: null, integrating: true });
    this.chat('director', `${req.id} tocca gli stessi file di modifiche già unite nel gioco. ${dev.name} allinea il branch e risolve i conflitti, ${qa ? qa.name + ' riprova' : ''}; poi potrai unire.`, { agentId: 'director', requestId: req.id, kind: 'plan', taskIds: deps });
    this.schedule();
  }

  async revertMerge(reqId) {
    const req = this.S.requests[reqId];
    if (req.studio?.mergeCommit) { await this.studioGit.revertMerge(req.studio); req.studio.mergeCommit = null; }
    if (!req.mergeCommit) { this.setRequest(req, { merged: false }); this.chat('system', `Unione di ${req.id} annullata. Riavvia lo Studio.`, { requestId: req.id }); return req; }
    const r = await this.git.revertMerge(req);
    this.setRequest(req, { merged: false, revertCommit: r.revertCommit });
    this.chat('system', `Unione di ${req.id} annullata (commit ${r.revertCommit.slice(0, 7)}).`, { requestId: req.id });
    return req;
  }

  async discard(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if ([...this.running.keys()].some((id) => this.S.tasks[id]?.requestId === reqId)) this.cancel(reqId);
    if (req.branch) await this.git.removeWorktree(req, { deleteBranch: !req.merged });
    if (req.studio?.branch) await this.studioGit.removeWorktree(req.studio, { deleteBranch: !req.merged });
    this.setRequest(req, { discarded: true, worktree: null, status: req.status === 'RUNNING' ? 'CANCELLED' : req.status });
    this.chat('system', `Scartato il lavoro di ${req.id}${req.merged ? ' (la parte già unita resta: usa "Annulla unione")' : ` (branch ${req.branch} eliminato)`}.`, { requestId: req.id });
    return req;
  }
}

export function summarizeHarness(h) {
  const L = [`VERDETTO HARNESS: ${h.verdict}`];
  for (const c of h.static?.checks || []) L.push(`${c.ok ? '✔' : '✘'} ${c.name}${!c.ok && c.detail ? ' — ' + truncate(c.detail, 600) : ''}`);
  const b = h.browser || {};
  if (!b.available) L.push(`browser: non disponibile (${b.note || ''})`);
  else {
    L.push(`${b.menu?.ok ? '✔' : '✘'} menu avviato`);
    for (const l of b.levels || []) L.push(`${l.ok ? '✔' : '✘'} livello ${l.id} avviato=${l.started} hud=${l.hud}${l.errors?.length ? ' errori: ' + l.errors.map((e) => e.text).join(' | ').slice(0, 400) : ''}`);
    for (const e of (b.errors || []).slice(0, 8)) L.push(`ERRORE ${e.type}: ${truncate(e.text, 300)}`);
    if (b.fatal) L.push(`FATALE: ${b.fatal}`);
  }
  return L.join('\n');
}

function harnessBugs(h) {
  const bugs = [];
  for (const c of h.static?.checks || []) if (!c.ok) bugs.push({ title: `Controllo statico fallito: ${c.name}`, steps: 'node <Studio>/qa/game-test.mjs --no-browser', expected: 'controllo superato', actual: truncate(c.detail, 800), severity: 'alta' });
  const b = h.browser || {};
  if (b.menu && !b.menu.ok) bugs.push({ title: 'Il menu del gioco non parte', steps: 'aprire il gioco nel browser', expected: 'scena Menu attiva', actual: b.menu.detail || 'non attiva', severity: 'alta' });
  for (const l of b.levels || []) if (!l.ok) bugs.push({ title: `Il livello ${l.id} non parte o dà errori`, steps: `avviare il livello ${l.id}`, expected: 'livello avviato senza errori', actual: (l.errors || []).map((e) => e.text).join(' | ').slice(0, 800) || 'scena Game non attiva', severity: 'alta' });
  for (const e of (b.errors || []).slice(0, 5)) bugs.push({ title: `Errore a runtime (${e.type})`, steps: 'avviare il gioco', expected: 'nessun errore', actual: truncate(e.text, 500), severity: 'alta' });
  if (b.fatal) bugs.push({ title: 'Il test nel browser è andato in errore', steps: '-', expected: '-', actual: b.fatal, severity: 'alta' });
  return bugs.length ? bugs : [{ title: 'Test automatico fallito', steps: 'node <Studio>/qa/game-test.mjs', expected: 'PASS', actual: 'FAIL', severity: 'media' }];
}
