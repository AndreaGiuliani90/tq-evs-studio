// ORCHESTRATORE: la Regia (Director) + lo scheduler dei task + il ciclo QA.
//
//   messaggio utente → richiesta (R-xxxx) → piano della Regia → task con dipendenze → agenti in parallelo
//   → ogni task che scrive = commit a nome dell'agente → test QA → FAIL: task di correzione + nuovo test
//   (al massimo maxFixLoops giri, poi si passa la palla all'utente) → PASS: rapporto finale della Regia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { now, truncate, clip, extractJSON, run, ensureDir, writeFileAtomic, readJSON } from './util.js';
import { directorPlanPrompt, taskPrompt, qaPrompt, reportPrompt, strategistPrompt, triagePrompt, TASK_KINDS } from './prompts.js';
import { CostBook, INCLUDED_PROVIDERS } from './costs.js';
import { Backlog, teamPerformance } from './boards.js';
import { ReleaseDesk, isJunk } from './release.js';
import { layoutHash } from '../web/layout-hash.js';
import { SfxStore, SFX_CATEGORIES, JSFXR_PRESETS, elevenCredits, jsfxrVariants, jsfxrRender, postProcess, hasFfmpeg, slug } from './sfx.js';

// qualità di partenza per tipo di task (regole dello Stratega quando non c'è un'AI che valuta)
const KIND_TIER = { implement: 'alta', fix: 'alta', integrate: 'alta', analyze: 'media', test: 'media', narrative: 'media', lore: 'media', puzzle: 'media', level: 'media', art: 'media', audio: 'media', studio_ui: 'media', office: 'bassa', avatars: 'bassa', office_paint: 'bassa', sfx: 'media' };
const TIERS = ['alta', 'media', 'bassa'];
function pickByTier(options, tier) {
  const inc = options.filter((o) => o.included);
  const pool = inc.length ? inc : options;
  const want = TIERS.indexOf(tier);
  return [...pool].sort((a, b) => Math.abs(TIERS.indexOf(a.tier) - want) - Math.abs(TIERS.indexOf(b.tier) - want) || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier))[0];
}

const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const WRITE_KINDS = ['implement', 'fix', 'narrative', 'art', 'level', 'audio', 'puzzle', 'lore', 'integrate'];
// tipi che cambiano il gioco: dopo di loro serve un test del QA (lore tocca solo i documenti)
const GAME_KINDS = ['implement', 'fix', 'narrative', 'art', 'level', 'audio', 'puzzle'];
// tipi che non toccano il repository del gioco: l'arredo dell'ufficio (dati) e il codice dello Studio (repository suo)
const STUDIO_KINDS = ['office', 'studio_ui', 'avatars', 'office_paint', 'sfx'];

// Fotogrammi dei personaggi animati (avatar generati): animazione → descrizione di ogni fotogramma per il generatore
const AVATAR_FRAMES = {
  full: {
    idle: ['relaxed neutral pose, slight smile', 'same relaxed pose, eyes closed (blinking)'],
    typing: ['typing on a keyboard just below the frame, both hands visible at the bottom, left hand pressing keys, focused on a screen', 'typing on a keyboard, right hand pressing keys, focused'],
    playing: ['holding a game controller with both hands, excited, leaning slightly left', 'holding a game controller, leaning slightly right, mouth open with excitement'],
    'writing-notes': ['thinking, one hand on the chin, eyes looking up', 'writing in a small notebook with a pencil, concentrated'],
    celebrate: ['both arms raised in celebration, big open smile', 'fists up cheering, eyes closed with joy'],
    waiting: ['arms crossed, bored, glancing sideways'],
    question: ['puzzled, scratching the head, one eyebrow raised'],
    error: ['shocked, both hands on the cheeks, mouth open, a sweat drop'],
  },
  light: {
    idle: ['relaxed neutral pose, slight smile', 'same relaxed pose, eyes closed (blinking)'],
    typing: ['typing on a keyboard just below the frame, hands visible, focused', 'typing, other hand pressing keys'],
    celebrate: ['both arms raised in celebration, big open smile'],
    question: ['puzzled, scratching the head'],
  },
};
const AVATAR_FPS = { idle: 0.4, typing: 6, playing: 5, 'writing-notes': 1, celebrate: 3, waiting: 1, question: 1, error: 4 };

export class Orchestrator {
  constructor({ store, events, agents, providers, git, knowledge, config, studioDir, projectRoot, dataDir, qaRunner, office, studioGit }) {
    Object.assign(this, { store, events, agents, providers, git, knowledge, config, studioDir, projectRoot, dataDir, office, studioGit });
    this.running = new Map();   // taskId → { abort: AbortController, promise }
    this.planning = new Set();
    this.harness = path.join(studioDir, 'qa', 'game-test.mjs');
    this.qaRunner = qaRunner || ((args, cwd) => run(process.execPath, [this.harness, ...args], { cwd, timeoutMs: 15 * 60 * 1000 }));
    this.gitOk = null;
    this.idleTimers = new Map();
    this.costs = new CostBook(store, events);
    this.backlog = new Backlog(store, events);
    this.release = new ReleaseDesk({ git, store, events, dataDir });
    this.sfx = new SfxStore(dataDir);
    this.catalog = { text: { ...(readJSON(path.join(studioDir, 'config', 'models.default.json'), {}).text || {}), ...(readJSON(path.join(dataDir, 'models.json'), {}).text || {}) } };
    providers.onUsage = (p, kind, r, o) => this.recordUsage(p, kind, r, o);
  }

  // ─── Contabilità: ogni chiamata ai provider finisce nei subtotali della lavagna ─────────────────
  recordUsage(p, kind, r, o) {
    if (kind === 'image') return this.costs.add(p.id, { usd: this.imagePriceFor(p.id === 'openai-image' ? `openai-image:${o.quality || p.quality || 'high'}` : (o.model || p.model || '')), images: 1 });
    if (p.id === 'mock' || ['PROVIDER_UNAVAILABLE', 'USE_HEURISTIC'].includes(r?.code)) return;
    if (p.id === 'anthropic') {
      const pr = this.catalog.text?.anthropic?.usdPerMTok || { input: 3, output: 15 };
      const u = r?.usage || {};
      return this.costs.add('anthropic', { usd: r?.costUsd ?? (((u.input_tokens || 0) * pr.input + (u.output_tokens || 0) * pr.output) / 1e6), runs: 1 });
    }
    this.costs.add(p.id, { runs: 1 });
  }

  // ─── Stratega: per ogni task sceglie provider e modello (qualità / velocità / costo) ───────────
  // Opzioni di testo per un agente: se l'utente gli ha fissato un provider si sceglie solo il modello,
  // altrimenti fra tutti i provider disponibili del catalogo.
  async textOptions(agent) {
    const out = [];
    const locked = agent.provider && agent.provider !== 'auto';
    for (const id of locked ? [agent.provider] : Object.keys(this.catalog.text)) {
      const p = this.providers.get(id);
      if (!p || !(await p.available()).ok) continue;
      const c = this.catalog.text[id];
      if (!c) { out.push({ provider: id, model: agent.model || '', tier: 'media', included: INCLUDED_PROVIDERS.includes(id), usd: 0, label: id }); continue; }
      for (const m of c.models || []) out.push({ provider: id, model: m.id || '', tier: m.tier || 'media', speed: m.speed || '', note: m.note || '', included: !!c.included, usd: c.included ? 0 : (m.usdPerTask ?? 0.4), label: `${c.label}${m.id ? ` · ${m.id}` : ''}` });
    }
    if (!out.length) {
      const p = await this.providers.resolve(agent.provider);
      out.push({ provider: p.id, model: agent.model || '', tier: 'media', included: p.id !== 'anthropic', usd: p.id === 'anthropic' ? 0.4 : 0, label: p.label || p.id });
    }
    return out;
  }

  // per chi vanno fatti i personaggi: gli agenti nominati nella richiesta, oppure tutti ("tutti", "la squadra"…)
  avatarTargets(text, artistId = 'art') {
    const team = this.agents.list().filter((a) => a.enabled !== false && (a.visible !== false || a.id === 'director'));
    const t = String(text || '').toLowerCase();
    if (/\btutt[ieao]\b|squadra|colleghi|ogni agente|all agents|everyone/.test(t)) return team;
    const re = (w) => new RegExp(`(^|[^\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u');
    const named = team.filter((a) => re(a.name).test(t) || re(a.id).test(t) || (a.role && a.role.length > 5 && re(a.role.split(/[\s/]/)[0]).test(t) && a.id !== 'director'));
    const self = /per te\b|te stess|anche te|la tua|il tuo/.test(t);
    const out = named.filter((a) => a.id !== artistId || self);
    return out.length ? out : team;
  }

  imageNeeds(req, plan) {
    const count = (k) => Object.values(AVATAR_FRAMES[k]).flat().length;
    const mode = req.avatarFrames || this.config.avatarFrames || 'full';
    const team = this.agents.list().filter((a) => a.enabled !== false && (a.visible !== false || a.id === 'director')).length;
    let nFull = 0, nLight = 0, agent = null, avatars = false, paint = false;
    for (const pt of plan.tasks) {
      if (pt.kind === 'avatars' && !avatars) { avatars = true; agent ??= this.agents.get(pt.agent); const n = this.avatarTargets(`${req.originalText || ''} ${req.text} ${pt.instructions || ''}`, pt.agent).length; nFull += n * count(mode); nLight += n * count('light'); }
      else if (pt.kind === 'art') { agent ??= this.agents.get(pt.agent); nFull += 6; nLight += 6; }
      else if (pt.kind === 'office_paint') { agent ??= this.agents.get(pt.agent); nFull += 1; nLight += 1; paint = true; }
    }
    return { nFull, nLight, agent, avatars, paint, team, mode, perAgent: count(mode), perAgentLight: count('light') };
  }

  async strategize(req, plan) {
    const perTask = [];
    for (const pt of plan.tasks) { const a = this.agents.get(pt.agent); if (a) perTask.push({ pt, agent: a, options: await this.textOptions(a) }); }
    const need = this.imageNeeds(req, plan);
    const imgOptions = need.agent ? await this.imageOptions(need.agent) : [];
    // regole di base (valgono anche come riserva se l'AI non risponde)
    const rules = { by: 'regole', tasks: {}, byKind: {}, images: null, summary: '', advice: '' };
    for (const { pt, options } of perTask) { const tier = KIND_TIER[pt.kind] || 'media'; const o = pickByTier(options, tier); rules.tasks[pt.key] = { tier: o.tier, provider: o.provider, model: o.model, why: '' }; }
    if (imgOptions.length) {
      const pref = need.agent.imageProvider && need.agent.imageProvider !== 'auto' ? (await this.imageFor(need.agent, {}))?.id : null;
      // lo sfondo dell'ufficio si vede sempre ed è una sola immagine: qualità alta; per i lotti grandi conta il prezzo
      const want = need.paint && !need.avatars ? ['openai-image:high', 'gemini-image:gemini-3-pro-image', 'gemini-image:gemini-3.1-flash-image'] : ['gemini-image:gemini-3.1-flash-image'];
      const best = want.map((id) => imgOptions.find((o) => o.id === id)).find(Boolean);
      rules.images = { choice: pref || (best || imgOptions.find((o) => !o.plan) || imgOptions[0]).id, why: '' };
    }
    let out = rules;
    const strat = this.agents.get('strategist');
    if ((this.config.strategist ?? 'ai') === 'ai' && strat && strat.enabled !== false) {
      const sopts = await this.textOptions(strat);
      const fast = pickByTier(sopts, 'bassa');
      const provider = this.providers.get(fast.provider)?.run ? this.providers.get(fast.provider) : await this.providers.resolve(strat.provider);
      if (provider.id !== 'mock') {
        this.agents.setStatus('strategist', 'THINKING', { task: { id: req.id, title: `Valuto: ${clip(req.originalText || req.text, 60)}` }, text: 'scelgo i modelli e controllo i costi', semantic: 'agent.thinking' });
        const r = await provider.run({ agent: strat, system: strat.systemInstructions, prompt: strategistPrompt({ req, tasks: perTask.map(({ pt, agent, options }) => ({ ...pt, agentName: agent.name, options })), images: imgOptions, need }), cwd: this.projectRoot, mode: 'plan', model: strat.model || fast.model, timeoutMs: 4 * 60 * 1000, onEvent: (e) => this.onProviderEvent('strategist', null, e) }).catch((e) => ({ ok: false, error: String(e) }));
        const j = r.ok ? (extractJSON(r.text) || extractJSON(r.allText)) : null;
        if (j) out = this.validateStrategy(j, perTask, imgOptions, rules);
        else if (!r.ok) this.events.emit('studio.warning', { text: `Stratega: ${truncate(r.error, 200)} — uso le regole di base` });
        this.agents.setStatus('strategist', 'IDLE', { task: null, text: out.by === 'stratega' ? 'valutazione fatta' : 'regole di base' });
      }
    }
    for (const { pt } of perTask) out.byKind[pt.kind] ??= out.tasks[pt.key];
    return out;
  }

  validateStrategy(j, perTask, imgOptions, rules) {
    const out = { by: 'stratega', tasks: {}, byKind: {}, images: rules.images, summary: clip(String(j.summary || ''), 400), advice: clip(String(j.advice || ''), 600) };
    const byKey = Object.fromEntries((Array.isArray(j.tasks) ? j.tasks : []).map((x) => [String(x.key), x]));
    for (const { pt, options } of perTask) {
      const x = byKey[pt.key];
      const o = x && options.find((y) => y.provider === x.provider && (y.model || '') === (x.model || ''));
      out.tasks[pt.key] = o ? { tier: o.tier, provider: o.provider, model: o.model, why: clip(String(x.why || ''), 160) } : rules.tasks[pt.key];
    }
    const ic = j.images?.choice;
    if (ic && imgOptions.some((o) => o.id === ic)) out.images = { choice: ic, why: clip(String(j.images.why || ''), 200) };
    return out;
  }

  modelLabel(s) { return s ? `${s.provider}${s.model ? ` · ${s.model}` : ''}` : ''; }

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
    for (const a of this.agents.list()) {
      const r = a.runtime || {};
      if (!['ERROR', 'BLOCKED'].includes(r.status)) continue;
      const t = r.currentTaskId && this.S.tasks[r.currentTaskId];
      const req = this.S.requests[t?.requestId || r.currentTaskId];
      if (!req || !['NEEDS_USER', 'RUNNING', 'PLANNING'].includes(req.status)) this.agents.setStatus(a.id, 'IDLE', { task: null });
    }
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
    await this.syncMerged().catch(() => {});
    this.releaseOrphans();
    this.store.save();
    this.schedule();
    this.wakeFollowups();
    setTimeout(() => this.recheckStuck(), 1500);
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

  async handleUserMessage(text, { attachments = [], replyTo = null } = {}) {
    text = String(text || '').trim();
    if (!text && !attachments.length) throw new Error('messaggio vuoto');
    // «R-12: …» o «su R-12 …» all'inizio del messaggio (anche dettato) = aggancio a quella richiesta
    if (!replyTo) {
      const m = text.match(/^(?:su |per |riguardo (?:a |alla )?)?(?:la )?R[- ]?0*(\d{1,4})\b\s*[:,.\-–—]?\s+/i);
      const id = m && `R-${m[1].padStart(4, '0')}`;
      if (id && this.S.requests[id]) { replyTo = id; text = text.slice(m[0].length).trim(); }
    }
    if (!text) text = '(vedi allegati)';
    const target = replyTo ? this.S.requests[replyTo] : null;
    if (replyTo && !target) throw new Error(`richiesta sconosciuta: ${replyTo}`);
    this.chat('user', text, { ...(attachments.length ? { attachments } : {}), ...(target ? { requestId: target.id, replyTo: target.id } : {}) });
    if (target) {
      const cmd = text.toLowerCase().trim().replace(/[.!]+$/, '');
      if (target.status === 'NEEDS_USER' && !target.quotePending && /^(riprova|riprovaci|ritenta|vai di nuovo)$/.test(cmd)) return this.retry(target.id);
      if (['NEEDS_USER', 'RUNNING', 'PLANNING', 'QUEUED'].includes(target.status) && /^(ferma|fermala|annulla|lascia stare|lascia perdere|stop)$/.test(cmd)) return this.cancel(target.id);
      // agganciato a una richiesta che aspetta la risposta a una domanda / a un preventivo: è quella risposta
      if (!(target.status === 'NEEDS_USER' && target.question && !target.answeredBy)) return this.followUp(target, text, attachments);
    }
    const startM = text.match(/^(?:avvia|fai|esegui|parti con|lavora (?:a|su))\s+(?:la\s+|l')?\b(b-?\d+)\b[.!]?$/i);
    if (startM) return this.startBacklogItem(startM[1].replace(/^b-?/i, 'B-'), { echoed: true });
    // "riprova" / "ferma" detti in chat valgono come i pulsanti sulla richiesta che aspetta una decisione
    const waiting = Object.values(this.S.requests).filter((r) => r.status === 'NEEDS_USER' && !r.quotePending && (r.escalation || r.planFailed));
    const cmd = text.toLowerCase().trim().replace(/[.!]+$/, '');
    if (waiting.length && /^(riprova|riprovaci|ritenta|vai di nuovo)$/.test(cmd)) { const r = waiting.sort((x, y) => y.id.localeCompare(x.id))[0]; this.chat('director', `Riprovo ${r.id}.`, { agentId: 'director', requestId: r.id }); return this.retry(r.id); }
    if (waiting.length && /^(ferma|fermala|annulla|lascia stare|lascia perdere|stop)$/.test(cmd)) { const r = waiting.sort((x, y) => y.id.localeCompare(x.id))[0]; this.chat('director', `Fermo ${r.id}: nessun altro tentativo.`, { agentId: 'director', requestId: r.id }); return this.cancel(r.id); }
    // messaggio senza aggancio: lo Stratega decide se è una cosa nuova, il seguito di un lavoro aperto o una risposta
    let asked = target;
    if (!target) {
      const tri = await this.triage(text);
      if (tri.decision === 'seguito') {
        const f = this.followUp(tri.target, text, attachments, { by: tri });
        return f;
      }
      if (tri.decision === 'risposta') {
        asked = tri.target;
        if (tri.by === 'stratega') this.say2(`È la risposta a ${asked.id}. ${tri.why}`.trim(), asked);
      }
    }
    if (asked?.quotePending) {
      const t = text.toLowerCase().trim();
      const opts = asked.quote?.options || [];
      const pick = (f) => opts.find(f)?.id;
      const choice = /banana pro|nano ?banana ?pro|gemini pro/.test(t) ? pick((o) => /pro/.test(o.id))
        : /banana|gemini/.test(t) ? pick((o) => o.id === 'gemini-image:gemini-3.1-flash-image') || pick((o) => o.id.startsWith('gemini'))
        : /gpt|openai/.test(t) ? (/media|medium/.test(t) ? pick((o) => o.id === 'openai-image:medium') : pick((o) => o.id === 'openai-image:high') || pick((o) => o.id.startsWith('openai')))
        : /piano|abbonamento|codex|gratis/.test(t) ? pick((o) => o.plan) : undefined;
      const cancel = /^(no\b|annulla|lascia (stare|perdere)|stop|ferma|non farlo)/.test(t);
      const lightW = /legger|light|econom|meno fotogramm/.test(t);
      const action = cancel ? 'cancel' : lightW ? 'light' : (choice || /^(s[iì]\b|ok\b|okay|vai|procedi|conferm|approv|va bene|d'accordo|fallo)/.test(t)) ? 'approve' : null;
      if (action) return this.answerQuote(asked.id, action, { choice });
    }
    const req = { id: this.store.nextId('request', 'R'), text, status: 'PLANNING', createdAt: now(), taskIds: [], attachments: [...(asked?.attachments || []), ...attachments] };
    if (asked) { req.continues = asked.id; req.originalText = asked.originalText || asked.text; asked.answeredBy = req.id; this.setRequest(asked, { status: 'ANSWERED' }); }
    this.S.requests[req.id] = req;
    this.store.save();
    this.events.emit('request.created', { request: req });
    this.plan(req).catch((e) => this.fail(req, e));
    return req;
  }

  // ─── Seguiti: un nuovo messaggio agganciato a una richiesta (finita o no) ──────────────────────────
  //   - ancora in lavorazione (o in coda per l'unione) → il seguito aspetta e parte appena finisce;
  //   - finita ma non unita (branch vivo) → continua SULLO STESSO BRANCH: poi si unisce solo il seguito, che contiene tutto;
  //   - unita, scartata o senza file → nuova richiesta dal gioco attuale, con il contesto di quella vecchia.
  lastOf(r) { const seen = new Set(); while (r?.followedBy && this.S.requests[r.followedBy] && !seen.has(r.id)) { seen.add(r.id); r = this.S.requests[r.followedBy]; } return r; }
  mustWait(r) { return this.isBusy(r) || (r.status === 'NEEDS_USER' && !!r.quotePending); }
  isBusy(r) { return ['PLANNING', 'RUNNING', 'QUEUED'].includes(r.status) || !!r.mergeQueued || this.planning.has(r.id); }

  followUp(target, text, attachments = [], { by = null } = {}) {
    const t = this.lastOf(target);
    const req = { id: this.store.nextId('request', 'R'), text, status: 'QUEUED', createdAt: now(), taskIds: [], attachments: [...attachments], parent: t.id, parentText: clip(t.originalText ? `${t.originalText} — ${t.text}` : t.text, 600), linkedBy: by ? 'stratega' : 'utente' };
    this.S.requests[req.id] = req;
    this.store.save();
    this.events.emit('request.created', { request: req });
    const why = by ? `${by.why ? by.why + ' ' : ''}` : '';
    if (by && !this.mustWait(t)) this.chat('agent', `Questo messaggio dipende da ${t.id}: lo aggancio come ${req.id}. ${why}`.trim(), { agentId: 'strategist', requestId: req.id, kind: 'agent-update' });
    if (this.mustWait(t)) {
      req.waitingFor = t.id; this.store.save();
      if (by) { this.chat('agent', `Questo messaggio dipende da ${t.id}: lo aggancio come ${req.id} e parte appena ${t.id} ${t.status === 'NEEDS_USER' ? 'avrà la tua decisione' : 'finisce'}, sullo stesso branch. ${why}\nSe invece è indipendente: «Sgancia» e parte subito da sola.`, { agentId: 'strategist', requestId: req.id, kind: 'plan' }); return req; }
      this.chat('director', `${req.id} agganciata a ${t.id}${t.id !== target.id ? ` (che ha proseguito ${target.id})` : ''}. ${t.status === 'NEEDS_USER' ? `${t.id} aspetta il tuo ok al preventivo: appena decidi parto` : `${t.id} è ancora in lavorazione: parto appena finisce`}, sullo stesso branch, così non si perde niente.`, { agentId: 'director', requestId: req.id, kind: 'plan' });
      return req;
    }
    this.startFollowup(req).catch((e) => this.fail(req, e));
    return req;
  }

  say2(text, req) { this.chat('agent', text, { agentId: 'strategist', requestId: req?.id, kind: 'agent-update' }); }

  // i lavori a cui un messaggio nuovo potrebbe agganciarsi: aperti, finiti ma non uniti, domande in sospeso
  triageCandidates() {
    return Object.values(this.S.requests).filter((r) => !r.followedBy && !r.discarded && (
      ['PLANNING', 'RUNNING', 'QUEUED', 'NEEDS_USER'].includes(r.status) || r.mergeQueued
      || (r.status === 'DONE' && !r.merged && (r.report?.commits?.length || r.report?.studioCommits?.length))))
      .sort((a, b) => b.id.localeCompare(a.id)).slice(0, 12);
  }

  async triage(text) {
    const cands = this.triageCandidates();
    const pendingQ = cands.filter((r) => r.status === 'NEEDS_USER' && r.question && !r.answeredBy);
    // regole di riserva (Stratega spento o che non risponde): come prima, la domanda in sospeso più recente
    const rules = pendingQ.length ? { decision: 'risposta', target: pendingQ[0], by: 'regole', why: '' } : { decision: 'nuova', by: 'regole', why: '' };
    if (!cands.length || this.config.autoLink === false) return rules;
    // risposte secche a una scelta («1-b 2-a», «sì», «ok», «la seconda») con una sola domanda aperta: niente da valutare
    if (pendingQ.length === 1 && text.length <= 60 && /^\s*((\d+\s*[-.):]?\s*[a-z]\b|[a-z]\s*[-.):]?\s*\d+\b|s[iì]|no|ok|okay|va bene|procedi|vai|la (prima|seconda|terza)|opzione \w+)[\s,;/.!]*)+$/i.test(text)) return { decision: 'risposta', target: pendingQ[0], by: 'regole', why: '' };
    const strat = this.agents.get('strategist');
    if ((this.config.strategist ?? 'ai') !== 'ai' || !strat || strat.enabled === false) return rules;
    const sopts = await this.textOptions(strat);
    const fast = pickByTier(sopts, 'bassa');
    const provider = this.providers.get(fast.provider)?.run ? this.providers.get(fast.provider) : await this.providers.resolve(strat.provider);
    if (provider.id === 'mock') return rules;
    const STATE = { PLANNING: 'in pianificazione', RUNNING: 'in lavorazione', QUEUED: 'in attesa di un altro lavoro', NEEDS_USER: 'aspetta una decisione dell\'utente', DONE: 'finita, non ancora unita al gioco' };
    const candidates = cands.map((r) => ({ id: r.id, state: r.mergeQueued ? 'in coda per l\'unione' : STATE[r.status] || r.status, text: r.originalText ? `${r.originalText} — ${r.text}` : r.text, question: r.status === 'NEEDS_USER' && !r.answeredBy ? r.question : null, files: (r.report?.filesChanged || []).map((f) => f.file || f), tasks: this.tasksOf(r.id).map((t) => `${this.agentName(t.agentId)}: ${t.title}`) }));
    this.agents.setStatus('strategist', 'THINKING', { task: { id: 'triage', title: `Smisto: ${clip(text, 50)}` }, text: 'controllo se dipende da lavori aperti', semantic: 'agent.thinking' });
    try {
      const r = await provider.run({ agent: strat, system: strat.systemInstructions, prompt: triagePrompt({ text, candidates }), cwd: this.projectRoot, mode: 'plan', model: fast.model, timeoutMs: 90 * 1000, maxTurns: 2, onEvent: () => {} }).catch((e) => ({ ok: false, error: String(e) }));
      const j = r.ok ? (extractJSON(r.text) || extractJSON(r.allText)) : null;
      const dec = String(j?.decision || '').toLowerCase();
      const tgt = j?.request && cands.find((c) => c.id === String(j.request).toUpperCase().trim());
      const why = clip(String(j?.why || ''), 300);
      if (!['nuova', 'seguito', 'risposta'].includes(dec)) { if (!r.ok) this.events.emit('studio.warning', { text: `Stratega (smistamento): ${truncate(r.error, 160)} — regole di base` }); return rules; }
      if (dec === 'nuova') return { decision: 'nuova', by: 'stratega', why };
      if (!tgt) return rules;
      if (dec === 'risposta' && pendingQ.includes(tgt)) return { decision: 'risposta', target: tgt, by: 'stratega', why };
      return { decision: 'seguito', target: tgt, by: 'stratega', why };
    } finally { this.agents.setStatus('strategist', 'IDLE', { task: null, text: 'smistamento fatto' }); }
  }

  // "Sgancia": il seguito che lo Stratega aveva agganciato (e che ancora aspetta) parte da solo, dal gioco attuale
  unlink(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (req.status !== 'QUEUED') throw new Error(`${req.id} è già partita${req.sameBranch ? ` sul branch di ${req.parent}` : ''}: non si può più sganciare`);
    const was = req.parent;
    Object.assign(req, { parent: null, parentText: null, waitingFor: null, linkedBy: null, unlinkedFrom: was });
    this.chat('director', `${req.id} sganciata da ${was}: parte da sola, dal gioco attuale.`, { agentId: 'director', requestId: req.id, kind: 'agent-update' });
    this.setRequest(req, { status: 'PLANNING' });
    this.plan(req).catch((e) => this.fail(req, e));
    return req;
  }

  async startFollowup(req) {
    const t = this.lastOf(this.S.requests[req.parent]);
    req.parent = t.id;
    const same = !!(t.branch && !t.discarded && !t.merged && t.worktree && fs.existsSync(t.worktree));
    req.parentOutcome = clip(t.report?.prose || t.report?.summaries?.join('\n') || t.question || '', 1200);
    if (same) {
      Object.assign(req, { branch: t.branch, worktree: t.worktree, baseBranch: t.baseBranch, baseCommit: t.baseCommit, baseDirty: t.baseDirty, sameBranch: true });
      if (t.studio?.branch && !t.studio.mergeCommit) req.studio = { ...t.studio, id: `${req.id}-studio` };
    }
    req.waitingFor = null;
    if (t.status === 'NEEDS_USER') for (const x of this.tasksOf(t.id)) if (x.status === 'PENDING') this.setTask(x, { status: 'CANCELLED' }, `superato dal seguito ${req.id}`);
    this.setRequest(t, { followedBy: req.id, ...(t.status === 'NEEDS_USER' ? { status: 'ANSWERED' } : {}) });
    this.chat('director', same ? `${req.id} continua ${t.id} sullo stesso branch (\`${t.branch}\`): alla fine unirai solo ${req.id}, che contiene anche il lavoro di ${t.id}.` : `${req.id} parte dal gioco attuale con il contesto di ${t.id}${t.merged ? ' (già unita)' : ''}.`, { agentId: 'director', requestId: req.id, kind: 'agent-update' });
    this.setRequest(req, { status: 'PLANNING' });
    return this.plan(req);
  }

  // i seguiti in attesa partono quando la richiesta a cui sono agganciati si libera
  wakeFollowups() {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      for (const r of Object.values(this.S.requests)) {
        if (r.status !== 'QUEUED') continue;
        const t = this.lastOf(this.S.requests[r.waitingFor || r.parent]);
        if (!t || !this.mustWait(t) || t.discarded) this.startFollowup(r).catch((e) => this.fail(r, e));
      }
    }, 0);
  }

  // avvia un'attività della lavagna DA FARE: diventa una richiesta normale (piano, preventivo, task…)
  async startBacklogItem(id, { echoed = false } = {}) {
    const it = this.backlog.get(id);
    if (!it) throw new Error(`attività sconosciuta: ${id}`);
    if (it.status === 'in corso' && it.requestId) throw new Error(`${it.id} è già in corso (${it.requestId})`);
    const text = `Esegui l'attività ${it.id} della lavagna DA FARE: ${it.title}.${it.details ? `\n${it.details}` : ''}${it.agent ? `\n(concordata con ${this.agentName(it.agent)})` : ''}`;
    if (!echoed) this.chat('user', `▶ Avvia ${it.id}: ${it.title}`);
    const req = { id: this.store.nextId('request', 'R'), text, status: 'PLANNING', createdAt: now(), taskIds: [], attachments: [], backlogId: it.id };
    this.S.requests[req.id] = req;
    this.store.save();
    this.events.emit('request.created', { request: req });
    this.backlog.update(it.id, { status: 'in corso', requestId: req.id });
    this.plan(req).catch((e) => this.fail(req, e));
    return req;
  }

  performance() { return teamPerformance(this.S.tasks, this.agents.list().filter((a) => a.id !== 'director')); }

  setRequest(req, patch) {
    Object.assign(req, patch, { updatedAt: now() });
    this.store.save();
    this.events.emit('request.updated', { request: req });
    if (['CANCELLED', 'DONE', 'ANSWERED'].includes(req.status) || (req.status === 'RUNNING' && patch.status)) this.clearStaleStatus(req);
    if (['CANCELLED', 'DONE', 'FAILED'].includes(req.status)) this.backlog?.onRequest(req);
    if (Object.values(this.S.requests).some((r) => r.status === 'QUEUED')) this.wakeFollowups();
    if (req.sameBranch && ['ANSWERED', 'CANCELLED', 'FAILED'].includes(req.status)) this.releaseOrphans();
  }

  // un ERRORE o un BLOCCO che riguarda una richiesta ormai chiusa (o ripartita) non deve restare appeso agli agenti
  clearStaleStatus(req) {
    const ids = new Set([req.id, ...(req.taskIds || [])]);
    for (const a of this.agents.list()) {
      const r = a.runtime || {};
      if (!['ERROR', 'BLOCKED'].includes(r.status)) continue;
      const t = r.currentTaskId && this.S.tasks[r.currentTaskId];
      if (ids.has(r.currentTaskId) || (t && t.requestId === req.id) || (!r.currentTaskId && req.status !== 'RUNNING')) this.agents.setStatus(a.id, 'IDLE', { task: null, text: req.status === 'RUNNING' ? 'si riparte' : 'richiesta chiusa' });
    }
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
      if (plan.tasks.length && !req.strategy) {
        req.strategy = await this.strategize(req, plan).catch((e) => ({ by: 'errore', tasks: {}, byKind: {}, error: String(e?.message || e) }));
        if (req.strategy.images?.choice && !req.imageChoice) req.imageChoice = req.strategy.images.choice;
        this.store.save();
      }
      if (plan.tasks.length && !req.quoteApproved) {
        const q = await this.quote(req, plan);
        req.quote = q;
        if (q.ask) {
          this.chat('director', `${plan.reply ? plan.reply + '\n\n' : ''}${q.text}`, { agentId: 'director', requestId: req.id, kind: 'quote' });
          this.setRequest(req, { status: 'NEEDS_USER', question: q.text, quotePending: true });
          this.agents.setStatus('director', 'IDLE', { task: null, text: 'aspetto l\'ok al preventivo' });
          return;
        }
      }
      await this.startPlan(req, plan);
    } finally { this.planning.delete(req.id); }
  }

  async startPlan(req, plan) {
    {
      if (plan.backlog?.length || plan.backlogDone?.length) {
        const added = plan.backlog.map((b) => this.backlog.add({ ...b, source: req.id }));
        const dropped = plan.backlogDone.map((id) => { try { return this.backlog.remove(id); } catch { return null; } }).filter(Boolean);
        const lines = [...added.map((i) => `• **${i.id}** ${i.title}${i.agent ? ` — ${this.agentName(i.agent)}` : ''} _(${i.priority})_`), ...dropped.map((i) => `• ~~${i.id} ${i.title}~~ tolta`)];
        if (!plan.tasks.length) plan.reply = `${plan.reply || 'Ho aggiornato la lista.'}\n\n**Lavagna DA FARE:**\n${lines.join('\n')}\n\nPer avviarne una: pulsante sulla lavagna oppure scrivi «avvia ${added[0]?.id || 'B-1'}».`;
      }
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
        this.createTask({ id, requestId: req.id, agentId: pt.agent, kind: pt.kind, title: pt.title, instructions: pt.instructions, dependsOn: (pt.dependsOn || []).map((k) => keyToId[k]).filter(Boolean), strategy: req.strategy?.tasks?.[pt.key] || null });
      }
      const lines = this.tasksOf(req.id).map((t) => `• ${this.agentName(t.agentId)} — ${t.title}${t.strategy ? ` · _${this.modelLabel(t.strategy)}_` : ''}${t.dependsOn.length ? ` (dopo ${t.dependsOn.map((d) => this.agentName(this.S.tasks[d]?.agentId)).join(', ')})` : ''}`);
      const sline = req.strategy?.summary && !req.quote?.ask ? `\n\n**${this.agentName('strategist')}:** ${req.strategy.summary}` : '';
      this.chat('director', `${plan.reply || 'Ci penso io.'}\n\n${lines.join('\n')}${sline}`, { agentId: 'director', requestId: req.id, kind: 'plan', taskIds: req.taskIds });
      if (req.baseDirty) this.chat('system', 'Nota: nella cartella del gioco ci sono modifiche non salvate in un commit. Lo Studio lavora sull\'ultimo commit in una copia separata e non tocca i tuoi file.', { requestId: req.id });
      this.setRequest(req, { status: 'RUNNING' });
      this.agents.setStatus('director', 'WAITING', { task: { id: req.id, title: `Coordino ${req.id}` }, text: `${req.taskIds.length} task delegati`, semantic: 'agent.waiting' });
      this.schedule();
    }
  }

  // ─── Preventivo ────────────────────────────────────────────────────────────────────────────────
  // Prima di lavori che costano soldi (immagini via API, modelli a consumo) la Regia mostra una stima e aspetta l'ok.
  // Claude Code / Codex / Gemini CLI con login dell'abbonamento: inclusi nel piano (consumano solo i limiti d'uso).
  imagePriceFor(key) {
    const prices = { 'openai-image:high': 0.21, 'openai-image:medium': 0.053, 'openai-image:low': 0.011, 'gemini-3.1-flash-image': 0.067, 'gemini-3-pro-image': 0.134, 'gemini-2.5-flash-image': 0.039, ...(this.config.imagePrices || {}) };
    return prices[key] ?? (key.startsWith('openai') ? 0.21 : 0.1);
  }

  // Generatori di immagini possibili per un agente. id: "openai-image:<qualità>", "gemini-image:<modello>", "plan"
  // ("plan" = le disegna Codex col piano ChatGPT, solo se l'agente lavora con Codex: niente costi API).
  async imageOptions(agent) {
    const out = [];
    const o = this.providers.get('openai-image'), g = this.providers.get('gemini-image');
    if (o && (await o.available()).ok) for (const q of [...new Set([o.quality || 'high', 'high', 'medium'])]) out.push({ id: `openai-image:${q}`, prov: o, opts: { quality: q }, label: `GPT Image 2 · qualità ${q === 'high' ? 'alta' : q === 'medium' ? 'media' : 'bassa'}`, price: this.imagePriceFor(`openai-image:${q}`) });
    if (g && (await g.available()).ok) for (const m of [...new Set([g.model, 'gemini-3.1-flash-image', 'gemini-3-pro-image'])]) out.push({ id: `gemini-image:${m}`, prov: g, opts: { model: m }, label: m === 'gemini-3-pro-image' ? 'Nano Banana Pro' : m === 'gemini-3.1-flash-image' ? 'Nano Banana 2' : `Nano Banana (${m})`, price: this.imagePriceFor(m) });
    const tp = await this.providers.resolve(agent.provider);
    if (tp.id === 'codex') out.push({ id: 'plan', plan: true, label: 'Codex col tuo piano ChatGPT (sperimentale)', price: 0 });
    return out;
  }

  // il generatore scelto: quello indicato nella richiesta (dal preventivo), altrimenti quello dell'agente
  async imageFor(agent, req) {
    const opts = await this.imageOptions(agent);
    const want = req?.imageChoice || agent.imageProvider || 'auto';
    const o = this.providers.get('openai-image'), g = this.providers.get('gemini-image');
    const id = want === 'openai-image' ? `openai-image:${o?.quality || 'high'}` : want === 'gemini-image' ? `gemini-image:${g?.model}` : want;
    return opts.find((x) => x.id === id) || opts.find((x) => x.id.startsWith(`${want}:`)) || (want === 'plan' ? null : opts.find((x) => x.id === `openai-image:${o?.quality || 'high'}`) || opts.find((x) => !x.plan)) || opts.find((x) => x.plan) || null;
  }

  async quote(req, plan) {
    const text = req.originalText ? `${req.originalText} ${req.text}` : req.text;
    const explicit = /preventiv|quanto (mi )?cost|quanto (si )?spend/i.test(text);
    const INCLUDED = { 'claude-code': 'Claude Code (abbonamento Claude)', codex: 'Codex (abbonamento ChatGPT)', gemini: 'Gemini CLI (account Google)' };
    const included = new Set(), metered = [];
    const lines = [];
    let base = 0, nFull = 0, nLight = 0, imgAgent = null, avatarsSeen = false;
    const count = (k) => Object.values(AVATAR_FRAMES[k]).flat().length;
    const mode = req.avatarFrames || this.config.avatarFrames || 'full';
    for (const pt of plan.tasks) {
      const agent = this.agents.get(pt.agent); if (!agent) continue;
      const st = req.strategy?.tasks?.[pt.key];
      const pid = st?.provider || (await this.providers.resolve(agent.provider)).id;
      if (INCLUDED[pid]) included.add(INCLUDED[pid]);
      else if (pid === 'anthropic') { metered.push(agent.name); base += this.catalog.text?.anthropic?.models?.[0]?.usdPerTask ?? 0.4; }
      if (pt.kind === 'avatars' && !avatarsSeen) {
        avatarsSeen = true; imgAgent ??= agent;
        const team = this.avatarTargets(`${req.originalText || ''} ${req.text} ${pt.instructions || ''}`, pt.agent).length;
        nFull += team * count(mode); nLight += team * count('light');
        lines.push(`• ${agent.name}: personaggi animati, fino a ${team} agenti × ${count(mode)} fotogrammi = **${team * count(mode)} immagini**${mode !== 'light' ? ` (versione leggera: ${team * count('light')})` : ''}`);
      } else if (pt.kind === 'office_paint') {
        imgAgent ??= agent; nFull += 1; nLight += 1;
        lines.push(`• ${agent.name}: ridipintura dell'ufficio, **1 immagine** grande (niente lavoro dell'AI di testo: la maquette la fa lo Studio)`);
      } else if (pt.kind === 'art') {
        imgAgent ??= agent; nFull += 6; nLight += 6;
        lines.push(`• ${agent.name}: immagini per il gioco, al massimo 6`);
      }
    }
    const light = mode !== 'light' && nLight < nFull;
    let options = [], current = null;
    if (imgAgent) {
      const opts = await this.imageOptions(imgAgent);
      current = await this.imageFor(imgAgent, req);
      options = opts.map((o) => ({ id: o.id, label: o.label, usd: Math.round((base + nFull * o.price) * 100) / 100, usdLight: light ? Math.round((base + nLight * o.price) * 100) / 100 : null, current: o.id === current?.id, plan: !!o.plan, price: o.price }));
      if (!opts.length) lines.push('• Nessun generatore di immagini attivo: metti una chiave OpenAI o Gemini nel file .env (righe senza # davanti), oppure fai lavorare Cosetta con Codex per usare il piano ChatGPT.');
    }
    const cur = options.find((o) => o.current);
    const usd = cur ? cur.usd : Math.round(base * 100) / 100, usdLight = cur ? cur.usdLight : null;
    const threshold = this.config.quoteThresholdUsd ?? 1;
    const ask = explicit || usd > threshold;
    const parts = ['**Preventivo (stima indicativa)**'];
    const sName = this.agentName('strategist');
    if (req.strategy?.summary) parts.push(`**${sName}:** ${req.strategy.summary}`);
    if (lines.length) parts.push(lines.join('\n'));
    if (options.length) parts.push(`Generatore di immagini:\n${options.map((o) => `${o.current ? '▶' : '•'} ${o.label}: ${o.plan ? '**incluso nel piano** (usa i limiti d\'uso; da provare: non è detto che regga tante immagini)' : `≈ $${o.price.toFixed(3)}/immagine → **≈ $${o.usd.toFixed(2)}**${o.usdLight != null ? ` · leggera ≈ $${o.usdLight.toFixed(2)}` : ''}`}${o.current ? ' ← scelto' : ''}`).join('\n')}`);
    if (included.size) parts.push(`• Lavoro degli agenti con ${[...included].join(', ')}: **incluso nel piano**, consuma solo i limiti d'uso.`);
    if (metered.length) parts.push(`• ${metered.join(', ')} con chiave API Anthropic: a consumo (≈ $${(this.catalog.text?.anthropic?.models?.[0]?.usdPerTask ?? 0.4).toFixed(2)} stimati per task).`);
    const advice = [req.strategy?.images?.why, req.strategy?.advice].filter(Boolean).join(' ');
    if (advice) parts.push(`**Consiglio dello ${sName}:** ${advice}`);
    parts.push(`**Totale stimato: ≈ $${usd.toFixed(2)}**${usdLight != null ? ` (versione leggera: ≈ $${usdLight.toFixed(2)})` : ''}. Le immagini via API si pagano a parte rispetto agli abbonamenti; i prezzi reali dipendono dal listino del momento.`);
    parts.push(`Procedo? Rispondi **sì**${usdLight != null ? ', **leggera**' : ''} oppure **no**${options.length > 1 ? ', o scegli un altro generatore (es. «leggera con Nano Banana»)' : ''}. Puoi usare anche i pulsanti.`);
    return { usd, usdLight, options, ask, explicit, text: parts.join('\n\n') };
  }

  // risposta dell'utente al preventivo: approve | light | cancel
  async answerQuote(reqId, action, { choice, light } = {}) {
    const req = this.S.requests[reqId];
    if (!req || !req.quotePending) throw new Error('nessun preventivo in attesa per questa richiesta');
    if (choice && action !== 'cancel') {
      const o = (req.quote?.options || []).find((x) => x.id === choice);
      if (!o) throw new Error(`generatore non disponibile: ${choice}`);
      req.imageChoice = o.id;
    }
    if (light) action = 'light';
    this.setRequest(req, { quotePending: false, answeredBy: req.id });
    if (action === 'cancel') {
      this.setRequest(req, { status: 'CANCELLED' });
      this.chat('director', 'Va bene, non faccio niente. Nessun costo.', { agentId: 'director', requestId: req.id });
      return req;
    }
    if (action === 'light') req.avatarFrames = 'light';
    this.setRequest(req, { status: 'PLANNING', quoteApproved: true });
    this.startPlan(req, req.plan).catch((e) => this.fail(req, e));
    return req;
  }

  async directorPlan(req, director) {
    const agents = this.agents.list();
    const chat = this.S.chat.slice(-(this.config.chatContextMessages || 8) - 1, -1);
    const projectBrief = this.knowledge.read('PROJECT_STATE');
    const provider = await this.providers.resolve(director.provider);
    let plan = null, raw = null;
    if (provider.id !== 'mock') {
      const r = await provider.run({ agent: director, system: director.systemInstructions, prompt: directorPlanPrompt({ req, agents, chat, projectBrief, backlog: this.backlog.open(), running: Object.values(this.S.requests).filter((x) => x.id !== req.id && ['RUNNING', 'PLANNING'].includes(x.status)) }), images: (req.attachments || []).filter((a) => /^image\//.test(a.type)).map((a) => a.path), addDirs: req.attachments?.length ? [this.uploadsDir] : [], cwd: this.projectRoot, mode: 'plan', model: director.model, maxTurns: this.config.directorMaxTurns ?? 10, timeoutMs: (this.config.directorTimeoutMin ?? 6) * 60 * 1000, onEvent: (e) => this.onProviderEvent('director', null, e) });
      raw = r;
      if (r.ok) plan = extractJSON(r.text) || extractJSON(r.allText);
      if (!plan && r.ok && r.text) plan = { reply: r.text, tasks: [] };
      // l'AI c'è ma non ha risposto (tempo scaduto, limiti…): meglio chiedere che eseguire un piano a indovinare
      if (!r.ok && r.code !== 'USE_HEURISTIC') {
        this.events.emit('studio.warning', { text: `Regia: ${provider.id} non ha risposto (${truncate(r.error, 200)})` });
        req.planFailed = true;
        return { reply: `Non sono riuscita a pianificare la richiesta (${truncate(r.error, 160)}). Non ho avviato niente e non hai speso nulla: premi "Riprova" oppure riscrivimi la richiesta, magari divisa in pezzi più piccoli.`, needsUser: true, tasks: [] };
      }
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
    const sfxJob = has(/effett[oi] sonor|\bsuon[oi]\b|\bsfx\b|rumor[ei] d/) && !has(/integra|inserisci nel gioco|musica/) && this.agents.forKind('sfx');
    if (sfxJob) return { reply: `Ci pensa ${sfxJob.name}.`, tasks: [{ key: 's', agent: sfxJob.id, kind: 'sfx', title: 'Effetti sonori', instructions: text, dependsOn: [] }] };
    const paintJob = has(/ridiping|dipingi|dipinto|illustraz|stile|resa grafica|qualit/) && has(/ufficio|studio|sede|stanza/) && !has(/personagg|sprite|avatar/) && this.agents.forKind('office_paint');
    if (paintJob) return { reply: `Ci pensa ${paintJob.name}.`, tasks: [{ key: 'p', agent: paintJob.id, kind: 'office_paint', title: 'Ridipingere l\'ufficio', instructions: text, dependsOn: [] }] };
    const avatarsJob = has(/sprite|avatar|personagg/) && has(/colleg|agenti|studio|squadra|ufficio|tutti/) && this.agents.forKind('avatars');
    if (avatarsJob) return { reply: `Ci pensa ${avatarsJob.name}.`, tasks: [{ key: 'v', agent: avatarsJob.id, kind: 'avatars', title: 'Nuovi personaggi per la squadra', instructions: text, dependsOn: [] }] };
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
    out.backlog = (Array.isArray(plan.backlog) ? plan.backlog : []).slice(0, 20).filter((b) => b && b.title).map((b) => ({ title: clip(b.title, 160), agent: this.agents.get(b.agent) ? b.agent : null, priority: b.priority, details: String(b.details || b.instructions || '') }));
    out.backlogDone = (Array.isArray(plan.backlogRemove) ? plan.backlogRemove : []).map(String);
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const keys = new Set();
    for (const [i, t] of tasks.entries()) {
      let kind = TASK_KINDS[t.kind] ? t.kind : 'implement';
      let agent = this.agents.get(t.agent);
      if (!agent || agent.enabled === false || agent.id === 'director' || agent.id === 'strategist' || agent.id === 'release') agent = this.agents.forKind(kind);
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
    // personaggi dello Studio: UN solo task avatars (Cosetta ridisegna tutti insieme, con uno stile comune);
    // l'animazione nell'ufficio c'è già, quindi niente task di codice dello Studio "per animarli"
    const av = out.tasks.filter((t) => t.kind === 'avatars');
    if (av.length) {
      const drop = new Set(av.slice(1).map((t) => t.key));
      if (av.length > 1) av[0].instructions = av.map((t) => t.instructions).join('\n\n');
      for (const t of out.tasks) if (t.kind === 'studio_ui' && /anim|sprite|personagg|avatar|fotogramm/i.test(`${t.title} ${t.instructions}`)) drop.add(t.key);
      for (const t of out.tasks) t.dependsOn = t.dependsOn.map((k) => (drop.has(k) && av.some((a) => a.key === k) ? av[0].key : k));
      out.tasks = out.tasks.filter((t) => !drop.has(t.key));
      for (const k of drop) keys.delete(k);
    }
    for (const t of out.tasks) t.dependsOn = [...new Set(t.dependsOn.filter((k) => keys.has(k) && k !== t.key))];
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
      parentTaskId: def.parentTaskId || null, strategy: def.strategy || null, writes: WRITE_KINDS.includes(def.kind) && this.agents.get(def.agentId)?.writes !== false,
      createdAt: now(), log: [], result: null, repair: !!def.repair,
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
    const base = this.agents.get(t.agentId);
    // modello scelto dallo Stratega (i task nati dopo, come correzioni e nuovi test, usano la scelta per quel tipo)
    let s = t.strategy || req?.strategy?.byKind?.[t.kind] || null;
    // secondo tentativo dopo un errore, o giro di correzione dopo un test fallito: si sale di un gradino (sonnet → opus → fable)
    const LADDER = { haiku: 'sonnet', sonnet: 'opus', opus: 'fable' };
    if (s && s.provider === 'claude-code' && LADDER[s.model] && (t.attempt >= 1 || (t.kind === 'fix' && (t.loop || 0) >= 2))) s = { ...s, model: LADDER[s.model], why: 'sale di livello dopo un tentativo non riuscito' };
    const agent = s ? { ...base, provider: s.provider || base.provider, model: s.model ?? base.model } : base;
    const ctrl = new AbortController();
    this.setTask(t, { status: 'RUNNING', startedAt: now(), attempt: t.attempt + 1, usedModel: s ? this.modelLabel(s) : null }, `avviato (tentativo ${t.attempt + 1})${s ? ` · ${this.modelLabel(s)}` : ''}`);
    clearTimeout(this.idleTimers.get(agent.id));
    const status = t.kind === 'test' ? 'TESTING' : t.kind === 'analyze' ? 'THINKING' : 'WORKING';
    this.agents.setStatus(agent.id, status, { task: t, text: `inizio: ${t.title}`, semantic: 'agent.started_task' });
    const BADMODEL = /(unknown|invalid|not found|unsupported|does not exist|not available|non (valido|disponibile)).{0,40}model|model.{0,40}(not found|does not exist|invalid|unknown|unsupported|not available|non (valido|disponibile))/i;
    const exec = async () => {
      const res = await this.executeTask(t, req, agent, ctrl.signal);
      if (!res.ok && s?.model && agent !== base && BADMODEL.test(String(res.error || '')) && !ctrl.signal.aborted) {
        this.setTask(t, { usedModel: null }, `il modello ${s.model} non è disponibile: riprovo con quello predefinito dell'agente`);
        return this.executeTask(t, req, base, ctrl.signal);
      }
      return res;
    };
    const p = exec()
      .then((res) => this.onTaskResult(t, req, base, res))
      .catch((e) => this.onTaskResult(t, req, base, { ok: false, error: String(e?.stack || e) }))
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
    if (t.kind === 'avatars') return this.runAvatars(t, req, agent, signal);
    if (t.kind === 'office_paint') return this.runOfficePaint(t, req, agent, signal);
    if (t.kind === 'sfx') return this.runSfx(t, req, agent, signal);
    if (t.kind === 'studio_ui') return this.runStudioUI(t, req, agent, signal);
    if (t.kind === 'integrate') {
      const mr = await this.git.git(['merge', '--no-ff', '--no-commit', req.baseBranch], req.worktree, { allowFail: true });
      const conflicted = (await this.git.git(['diff', '--name-only', '--diff-filter=U'], req.worktree, { allowFail: true })).stdout.trim();
      if (!conflicted && t.repair) {
        // allineamento pulito, ma il Notaio ha trovato righe perse: lo sviluppo deve rimetterle comunque
        await this.git.commitAll(req.worktree, { agent, task: t, request: req, summary: `Allineato con ${req.baseBranch} (senza conflitti)` });
      } else if (!conflicted) {
        const c = await this.git.commitAll(req.worktree, { agent, task: t, request: req, summary: `Allineato con ${req.baseBranch} (senza conflitti)` });
        return { ok: true, result: { summary: `Allineato con ${req.baseBranch}: nessun conflitto da risolvere.`, commit: c, filesChanged: c?.files || [] } };
      }
      else t.instructions += `\n\nFile in conflitto:\n${conflicted}\n(esito dell'unione: ${truncate(mr.stdout + mr.stderr, 600)})`;
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
    const choice = await this.imageFor(agent, req);
    const provider = choice && !choice.plan ? choice.prov : null;
    const av = provider ? { ok: true } : { ok: false, reason: choice?.plan ? 'scelto il piano ChatGPT: le immagini le disegna Codex' : 'nessun provider immagini configurato (GPT Image o Nano Banana: vedi Impostazioni)' };
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
      const g = await provider.generate({ ...choice.opts, prompt: ir.prompt, size: entry.size, references: refs });
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

  // ─── Nuovi personaggi per gli agenti (Cosetta) ─────────────────────────────────────────────────────
  // Cosetta fa l'art direction (un prompt per agente, stile comune); le immagini le genera il provider immagini
  // (GPT Image / Nano Banana) oppure Cosetta stessa se lavora con Codex. Il primo ritratto fa da riferimento di stile
  // per gli altri. Si applicano subito come avatar; "Annulla ultimo arredo" torna ai personaggi di prima.
  async runAvatars(t, req, agent, signal) {
    const dir = ensureDir(path.join(this.dataDir, 'avatar-workspace', t.id));
    const team = this.agents.list().filter((a) => a.enabled !== false && (a.visible !== false || a.id === 'director'));
    const roster = team.map((a) => ({ id: a.id, name: a.name, role: a.role, description: a.description, look: a.avatar?.character || {} }));
    writeFileAtomic(path.join(dir, 'squadra.json'), JSON.stringify(roster, null, 2));
    const plan = AVATAR_FRAMES[req.avatarFrames || this.config.avatarFrames] || AVATAR_FRAMES.full;
    const frameList = Object.entries(plan).flatMap(([anim, frames]) => frames.map((desc, i) => ({ anim, i, desc })));
    const provider = await this.providers.resolve(agent.provider);
    const choice = await this.imageFor(agent, req);
    const imgOk = !!choice && !choice.plan;
    const imgProv = imgOk ? choice.prov : null;
    const selfGen = provider.id === 'codex';
    const refs = (req.attachments || []).filter((a) => /^image\//.test(a.type)).map((a) => a.path);
    const prompt = taskPrompt({ task: t, req, agent, deps: this.depsOf(t), contextList: '- squadra.json (in questa cartella): gli agenti, i loro ruoli e l\'aspetto attuale', qaCmd: null,
      extra: `## Nuovi personaggi animati per la squadra dello Studio
Devi disegnare (art direction) i personaggi degli agenti in squadra.json, che siedono nell'ufficio isometrico della Pro Loco.
Ogni personaggio è animato fotogramma per fotogramma: lo Studio genera prima il ritratto base, poi ogni fotogramma come
variante dello STESSO personaggio (stessa inquadratura, stessa scala). Formato: mezzo busto (dal petto in su), seduto alla scrivania, tre quarti
rivolto verso la SINISTRA di chi guarda (lo Studio lo specchia dove serve), pixel art pulita e dettagliata con contorno scuro e ombre a pochi toni, STESSO STILE per tutti, fondo
magenta pieno #FF00FF, immagine quadrata, figura centrata con spazio intorno (nei fotogrammi alza le braccia).
Ogni personaggio deve far capire il suo ruolo (oggetti, vestiti) e avere personalità (alla Ron Gilbert). Rispetta la
richiesta dell'utente${refs.length ? ' e le immagini di riferimento allegate' : ''}.
Fotogrammi che lo Studio genererà per ognuno: ${frameList.map((f) => `${f.anim}-${f.i + 1}`).join(', ')}.
${selfGen && !imgOk ? `Genera tu le immagini col tuo strumento: per ogni agente salva in questa cartella <id>-<fotogramma>.png (es. dev-idle-1.png, dev-typing-1.png …).\n` : ''}Nel JSON finale metti "avatars": [{"agent": "<id>", "prompt": "descrizione del personaggio in inglese, dettagliata"}], uno per ogni agente da ridisegnare: SOLO questi → ${[...this.avatarTargets(`${req.originalText || ''} ${req.text} ${t.instructions || ''}`, agent.id)].map((a) => a.id).join(', ')}, e "style": "descrizione dello stile comune in inglese".` });
    const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd: dir, mode: 'work', model: agent.model, signal, ...this.attachOpts(req), timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.code === 'PROVIDER_UNAVAILABLE' };
    const j = extractJSON(r.text) || extractJSON(r.allText) || {};
    const targets = new Set(this.avatarTargets(`${req.originalText || ''} ${req.text} ${t.instructions || ''}`, agent.id).map((a) => a.id));
    const list = (Array.isArray(j.avatars) ? j.avatars : []).filter((x) => this.agents.get(x.agent) && targets.has(x.agent));
    if (!list.length) return { ok: false, error: 'Cosetta non ha indicato nessun personaggio da ridisegnare (campo "avatars" vuoto)' };
    if (!imgOk && !selfGen) return { ok: false, blocked: true, error: 'Per generare i personaggi serve un generatore di immagini: metti OPENAI_API_KEY o GEMINI_API_KEY nel file .env (o fai lavorare Cosetta con Codex).' };
    this.office?.snapshot(this.agents);   // "Annulla ultimo arredo" torna ai personaggi di prima
    const done = [], failed = [];
    let styleRef = null;
    const style = j.style ? `${j.style}. ` : '';
    const fixed = 'Bust portrait from the chest up, seated at a desk, three-quarter view: body and face turned toward the viewer\'s LEFT (the desk edge runs diagonally down to the right), centered with empty space around, solid flat magenta (#FF00FF) background, no text, no frame.';
    for (const item of list) {
      if (signal?.aborted) break;
      const outDir = ensureDir(path.join(this.dataDir, 'avatars', `${item.agent}-${Date.now()}`));
      const rel = (f) => `/avatars/${path.basename(outDir)}/${f}`;
      const frames = {};
      let base = null, errors = 0;
      const own = (f) => { const p = path.join(dir, `${item.agent}-${f.anim}-${f.i + 1}.png`); return fs.existsSync(p) ? fs.readFileSync(p) : null; };
      const gen = async (f) => {
        let png = own(f);
        if (!png && imgOk) {
          const isBase = f.anim === 'idle' && f.i === 0;
          const p = isBase ? `${style}${item.prompt}. ${fixed}` : `The SAME character as in the first reference image, identical face, hair, clothes, colors, art style, framing and scale, on the same flat magenta (#FF00FF) background. Change only the pose/expression: ${f.desc}. ${fixed}`;
          const g = await imgProv.generate({ ...choice.opts, prompt: p, size: '1024x1024', references: isBase ? [...refs, ...(styleRef ? [styleRef] : [])] : [base, ...(styleRef && styleRef !== base ? [styleRef] : [])] });
          if (!g.ok) { errors++; if (errors === 1) failed.push(`${this.agentName(item.agent)}: ${g.error}`); return; }
          png = g.png;
        }
        if (!png) return;
        const name = `${f.anim}-${f.i + 1}.png`;
        fs.writeFileSync(path.join(outDir, name), png);
        (frames[f.anim] ??= [])[f.i] = rel(name);
        return path.join(outDir, name);
      };
      this.agents.activity(agent.id, `disegno ${this.agentName(item.agent)} (ritratto base)`, 'agent.editing', { file: `${item.agent}` });
      base = await gen(frameList[0]);
      if (!base) { if (!failed.some((x) => x.startsWith(this.agentName(item.agent)))) failed.push(`${this.agentName(item.agent)}: nessuna immagine`); continue; }
      styleRef ??= base;
      // gli altri fotogrammi, un po' in parallelo
      const rest = frameList.slice(1);
      for (let k = 0; k < rest.length; k += 3) {
        if (signal?.aborted) break;
        this.agents.activity(agent.id, `${this.agentName(item.agent)}: fotogrammi ${rest.slice(k, k + 3).map((f) => `${f.anim}-${f.i + 1}`).join(', ')}`, 'agent.editing');
        await Promise.all(rest.slice(k, k + 3).map(gen));
      }
      for (const a of Object.keys(frames)) frames[a] = frames[a].filter(Boolean);
      const a = this.agents.get(item.agent);
      this.agents.update(item.agent, { avatar: { ...(a.avatar || {}), type: 'frames', frames, fps: AVATAR_FPS, image: frames.idle[0], chroma: '#ff00ff', faces: 'left', flip: false, generated: { prompt: item.prompt, style: j.style || '', provider: imgOk ? choice.id : provider.id, task: t.id, at: now() } } });
      done.push(`${this.agentName(item.agent)} (${Object.values(frames).flat().length} fotogrammi)`);
    }
    if (!done.length) return { ok: false, error: `nessun personaggio generato: ${failed.join(' · ')}` };
    return { ok: true, result: { summary: `Nuovi personaggi animati: ${done.join(', ')}.${failed.length ? ` Problemi: ${failed.join(' · ')}` : ''}`, notes: 'Se non ti piacciono: "↶ Annulla ultimo arredo" nell\'ufficio riporta i personaggi di prima.', output: truncate(r.text, 3000), avatars: list.map((x) => x.agent), provider: provider.id } };
  }

  // ─── Ridipintura dell'ufficio (Cosetta) ──────────────────────────────────────────────────────────
  // Niente AI di testo (zero token): lo Studio fotografa la maquette della pianta attuale, il generatore di immagini la
  // ridipinge nello stile chiesto (testo della richiesta + immagini allegate) e il dipinto diventa lo sfondo.
  // Personaggi, schermi e luci restano vivi sopra. "↶ Annulla ultimo arredo" torna allo sfondo di prima.
  async runOfficePaint(t, req, agent, signal) {
    if (!this.office) return { ok: false, error: 'ufficio non disponibile' };
    const choice = await this.imageFor(agent, req);
    if (!choice || choice.plan) return { ok: false, blocked: true, error: 'Per ridipingere l\'ufficio serve un generatore di immagini via API (GPT Image o Nano Banana): mettine la chiave nel file .env.' };
    const dir = ensureDir(path.join(this.dataDir, 'office-paint'));
    const stamp = Date.now();
    this.agents.activity(agent.id, 'fotografo la maquette dell\'ufficio', 'agent.editing');
    let shot;
    try { shot = await (this.snapshotter || this.defaultSnapshotter.bind(this))({ layout: this.office.get(), out: path.join(dir, `maquette-${stamp}.png`) }); }
    catch (e) { return { ok: false, error: `maquette dell'ufficio non riuscita: ${e.message}` }; }
    if (signal?.aborted) return { ok: false, error: 'annullato' };
    const refs = (req.attachments || []).filter((a) => /^image\//.test(a.type)).map((a) => a.path);
    const wish = req.originalText ? `${req.originalText}\n${req.text}` : req.text;
    const prompt = `Repaint the FIRST image (an isometric blockout of an office, pixel-art placeholder) as a finished, high-quality illustration.
KEEP EXACTLY: the camera angle, the room shape and size, the position of the two walls, every window, desk, chair, shelf, rug, plant, sofa, coffee counter and piece of furniture — same places, same sizes, same count. The picture will be used as a background and animated characters will be placed on the chairs, so the layout must match the blockout precisely.
Do NOT add people, characters or animals. KEEP the existing wall signs exactly, including the banner that reads "PRO LOCO" (same letters) and the green chalkboard; do not add any other text. Keep the plain dark background outside the room.
The blockout is ONLY a guide for geometry: restyle it strongly — materials, lighting, shading, detail and atmosphere must follow the requested style (and the style reference images, if any), not the blocky placeholder look. The windows show a continuous landscape of an Italian mountain village (Abruzzo, Gran Sasso mountains, stone houses with terracotta roofs, a bell tower).
${refs.length ? 'Match the style, rendering quality, resolution and lighting of the other reference image(s).\n' : ''}What the user wants (may be in Italian): ${clip(wish, 1500)}`;
    this.office.snapshot(this.agents);   // per "Annulla"
    this.agents.activity(agent.id, `ridipingo l'ufficio (${choice.label})`, 'agent.editing');
    const g = await choice.prov.generate({ ...choice.opts, prompt, size: '1536x1024', references: [shot.file, ...refs] });
    if (!g.ok) return { ok: false, error: `generatore immagini: ${g.error}` };
    const name = `ufficio-${stamp}.png`;
    fs.writeFileSync(path.join(dir, name), g.png);
    this.office.setPaint({ url: `/office-paint/${name}`, maquette: `/office-paint/${path.basename(shot.file)}`, W: shot.W, H: shot.H, ox: shot.ox, oy: shot.oy, scale: shot.scale, hash: layoutHash(this.office.get()), provider: choice.id, at: now(), task: t.id });
    return { ok: true, result: { summary: `Ufficio ridipinto con ${choice.label}: ora è lo sfondo della sede (personaggi e luci restano animati sopra).`, notes: 'Se non ti piace: "↶ Annulla ultimo arredo" torna a prima; il pulsante 🎨 nell\'ufficio passa dal dipinto al disegno in codice. Se Arredo sposta i mobili, il dipinto va rifatto.', provider: choice.id } };
  }

  // ─── Effetti sonori (Rumore) ─────────────────────────────────────────────────────────────────
  // 1) Rumore (AI di testo, inclusa nel piano) traduce la richiesta in un elenco di suoni con prompt tecnici in inglese
  //    o preset jsfxr; 2) lo Studio dice quante generazioni ElevenLabs sta per fare (oltre i 10 suoni chiede l'ok);
  // 3) 3 varianti per suono, con la cache; 4) rifinitura (silenzi, volume per categoria, dissolvenze) in .ogg + .mp3;
  // 5) manifest con motore, prompt/parametri, varianti, piano e licenza. Niente tocca il gioco: i suoni sono bozze.
  normalizeSfxDesign(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice(0, 40).map((x, i) => {
      const engine = x.engine === 'jsfxr' ? 'jsfxr' : 'elevenlabs';
      let id = `sfx_${slug(String(x.id || x.name || `suono_${i + 1}`).replace(/^sfx_/, ''))}`;
      while (seen.has(id)) id += '_b';
      seen.add(id);
      const category = SFX_CATEGORIES.includes(x.category) ? x.category : engine === 'jsfxr' ? 'ui' : 'foley';
      let prompt = String(x.prompt || '').trim();
      if (engine === 'elevenlabs' && prompt && !/no music/i.test(prompt)) prompt += ', no music, no voice';
      const duration = x.duration == null || x.duration === '' ? null : Math.min(30, Math.max(0.5, Number(x.duration) || 0)) || null;
      return { id, label: String(x.label || x.name || id), category, engine, prompt, duration, loop: !!x.loop, influence: Math.min(1, Math.max(0, Number(x.influence ?? (x.loop ? 0.5 : 0.3)))), volume: Math.min(1, Math.max(0.05, Number(x.volume ?? 0.8))), stringId: x.stringId ? String(x.stringId) : null, preset: JSFXR_PRESETS.includes(x.preset) ? x.preset : 'blipSelect', variants: Math.min(3, Math.max(1, Number(x.variants) || 3)) };
    }).filter((x) => x.engine === 'jsfxr' || x.prompt);
  }

  async runSfx(t, req, agent, signal) {
    const el = this.providers.get('elevenlabs');
    if (!t.sfxDesign) {
      const provider = await this.providers.resolve(agent.provider);
      const prompt = taskPrompt({ task: t, req, agent, deps: this.depsOf(t), contextList: '- strings/it.json (testi del gioco: usa id coerenti con quelli esistenti)\n- docs/memoria/NARRATIVE_BIBLE.md (il mondo del gioco: borgo di montagna abruzzese)', qaCmd: null,
        extra: `## Effetti sonori: progetta l'elenco, NON generare nulla
Traduci la richiesta in un elenco di suoni. Per ognuno scegli il motore:
- "elevenlabs" per i suoni realistici del borgo (passi, porte, campane, fontana, vetri, animali, brusio, ambienti): scrivi un prompt TECNICO in inglese (materiale, azione, ambiente/acustica, distanza, durata) che finisca con "no music, no voice". Ambienti ciclici (vento, fontana, notte): "loop": true e durata 10-20 s.
- "jsfxr" per interfaccia e gameplay retro (click dei menu, pickup, salto, colpo, allarme, stelle): scegli un "preset" fra ${JSFXR_PRESETS.join(', ')}.
Categorie: ${SFX_CATEGORIES.join(', ')}. Id stabili e leggibili in italiano (es. vetro_rotto_01, passi_sampietrini_01); se servono più suoni dello stesso tipo da alternare (es. passi), fai id separati _01, _02, _03.
Ogni suono avrà 3 varianti da cui l'utente sceglie: non moltiplicare i suoni inutilmente.
Nel JSON finale metti "sounds": [{"id", "label" (italiano), "category", "engine", "prompt" (solo elevenlabs), "duration" (secondi o null), "loop", "influence" (0-1, 0.3 normale), "volume" (0-1 consigliato nel gioco), "preset" (solo jsfxr), "stringId" (se c'è un testo collegato)}].` });
      const r = await provider.run({ agent, system: agent.systemInstructions, prompt, cwd: this.projectRoot, mode: 'plan', model: agent.model, signal, timeoutMs: (this.config.taskTimeoutMin || 25) * 60 * 1000, onEvent: (e) => this.onProviderEvent(agent.id, t, e) });
      if (!r.ok) return { ok: false, error: r.error, blocked: r.code === 'PROVIDER_UNAVAILABLE' };
      const j = extractJSON(r.text) || extractJSON(r.allText) || {};
      const design = this.normalizeSfxDesign(j.sounds);
      if (!design.length) return { ok: false, error: 'Rumore non ha indicato nessun suono (campo "sounds" vuoto)' };
      this.setTask(t, { sfxDesign: design }, `progetto: ${design.length} suoni`);
    }
    const design = t.sfxDesign;
    const elSounds = design.filter((d) => d.engine === 'elevenlabs');
    const keyOf = (d, v) => this.sfx.cacheKey({ e: 'elevenlabs', text: d.prompt, duration: d.duration, influence: d.influence, loop: d.loop, model: el?.model, format: el?.format, v });
    const toGen = elSounds.flatMap((d) => Array.from({ length: d.variants }, (_, v) => ({ d, v }))).filter(({ d, v }) => !this.sfx.cached(keyOf(d, v)));
    const credits = toGen.reduce((s, { d }) => s + elevenCredits(d.duration), 0);
    if (toGen.length && !(await el?.available())?.ok) return { ok: false, blocked: true, error: 'Per i suoni realistici serve ELEVENLABS_API_KEY nel file .env dello Studio (i suoni jsfxr funzionano anche senza).' };
    const sub = elSounds.length && el ? await el.subscription() : null;
    if (design.length > (this.config.sfxConfirmOver ?? 10) && !t.sfxOk) {
      this.setTask(t, { sfxOk: true });
      return { ok: false, ask: true, error: `Rumore ha preparato ${design.length} suoni: ${toGen.length} generazioni ElevenLabs (≈ ${credits} crediti${sub?.ok && sub.limit ? `, te ne restano ${Math.max(0, sub.limit - sub.used)}` : ''}) e ${design.length - elSounds.length} suoni jsfxr (gratis). Sono più di 10 suoni: scrivi **riprova** per generarli o **ferma** per lasciar perdere.` };
    }
    if (sub?.ok && sub.limit && toGen.length && sub.limit - sub.used < credits) return { ok: false, ask: true, error: `Servono ≈ ${credits} crediti ElevenLabs ma te ne restano ${sub.limit - sub.used} (piano ${sub.tier}). Riduci la richiesta, aspetta il rinnovo o cambia piano; poi scrivi **riprova**.` };
    this.chat('agent', `🔊 Genero ${design.length} suoni: ${toGen.length} generazioni ElevenLabs${toGen.length ? ` (≈ ${credits} crediti${sub?.ok ? `, piano ${sub.tier}` : ''})` : ''}${elSounds.length * 3 - toGen.length > 0 ? `, ${elSounds.reduce((s, d) => s + d.variants, 0) - toGen.length} già in cache` : ''} e ${design.length - elSounds.length} con jsfxr (gratis).`, { agentId: agent.id, requestId: req.id, taskId: t.id, kind: 'agent-update' });
    const ff = await hasFfmpeg();
    const done = [], failed = [];
    let usedCredits = 0, gens = 0;
    const license = (d) => (d.engine === 'jsfxr' ? { engine: 'jsfxr', terms: 'jsfxr: Unlicense (pubblico dominio); il suono è tuo', commercial: true } : { engine: 'elevenlabs', model: el?.model, plan: sub?.ok ? sub.tier : 'sconosciuto (la chiave non ha il permesso Utente)', commercial: sub?.ok ? sub.commercial : null });
    for (const d of design) {
      if (signal?.aborted) break;
      this.agents.activity(agent.id, `${d.engine === 'jsfxr' ? 'sintetizzo' : 'genero'} ${d.id}`, 'agent.editing', { file: d.id });
      const dir = this.sfx.dirFor(d.category, d.id);
      const variants = [];
      const params = d.engine === 'jsfxr' ? await jsfxrVariants({ preset: d.preset, count: d.variants }) : [];
      for (let v = 0; v < d.variants; v++) {
        let raw, key;
        try {
          if (d.engine === 'jsfxr') {
            key = this.sfx.cacheKey({ e: 'jsfxr', p: params[v] });
            raw = this.sfx.cached(key) || this.sfx.putCache(key, await jsfxrRender(params[v]), 'wav');
          } else {
            key = keyOf(d, v);
            raw = this.sfx.cached(key);
            if (!raw) {
              const g = await el.sound({ text: d.prompt, duration: d.duration, influence: d.influence, loop: d.loop });
              if (!g.ok) { failed.push(`${d.id} v${v + 1}: ${g.error}`); if (/API (401|402|429)|quota|credit/i.test(g.error)) break; continue; }
              gens++; usedCredits += g.credits || elevenCredits(d.duration);
              raw = this.sfx.putCache(key, g.buf, g.ext);
            }
          }
          const pp = await postProcess(raw, path.join(dir, `v${v + 1}`), { category: d.category, loop: d.loop });
          variants.push({ n: v + 1, ogg: pp.files.ogg ? this.sfx.url(pp.files.ogg) : null, mp3: pp.files.mp3 ? this.sfx.url(pp.files.mp3) : null, raw: pp.processed ? null : this.sfx.url(Object.values(pp.files)[0]), processed: pp.processed, durationSec: pp.durationSec ?? null, lufs: pp.lufs ?? null, peak: pp.peak ?? null, cacheKey: key, ...(d.engine === 'jsfxr' ? { params: params[v] } : {}) });
        } catch (e) { failed.push(`${d.id} v${v + 1}: ${e.message}`); }
      }
      if (!variants.length) continue;
      this.sfx.upsert({ id: d.id, label: d.label, category: d.category, engine: d.engine, prompt: d.prompt || null, preset: d.engine === 'jsfxr' ? d.preset : null, duration: d.duration, loop: d.loop, influence: d.influence, volume: d.volume, stringId: d.stringId, loudnessTarget: undefined, variants, chosen: null, status: 'bozza', license: license(d), createdAt: now(), request: req.id, task: t.id });
      done.push(`${d.id} (${variants.length})`);
    }
    if (gens) this.costs.add('elevenlabs', { runs: gens, credits: usedCredits });
    if (!done.length) return { ok: false, error: `nessun suono generato: ${failed.slice(0, 4).join(' · ')}` };
    const freeWarn = sub?.ok && !sub.commercial ? `\n⚠️ Piano ElevenLabs "${sub.tier}": i suoni generati con questo piano non si possono usare in una release commerciale (serve almeno Starter). È segnato nel manifest.` : '';
    return { ok: true, result: { summary: `Suoni pronti come bozze (3 varianti ciascuno): ${done.join(', ')}.${failed.length ? ` Problemi: ${failed.slice(0, 3).join(' · ')}` : ''}${ff ? '' : ' ffmpeg non installato: i file sono grezzi (brew install ffmpeg).'}${freeWarn}`, notes: 'Le varianti sono in data/audio/sfx/ dello Studio; ascolto e scelta nel pannello Suoni (prossimo passo).', sounds: done, generations: gens, credits: usedCredits, provider: 'elevenlabs+jsfxr' } };
  }

  async defaultSnapshotter({ layout, out }) {
    const { officeSnapshot } = await import(path.join(this.studioDir, 'qa', 'office-snapshot.mjs'));
    return officeSnapshot({ webDir: path.join(this.studioDir, 'web'), layout, out });
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
      // credito o limiti d'uso esauriti: ritentare subito non serve (e non si ritenta a vuoto)
      const noCredit = /API (402|429)|no credits|credit balance|usage limit|quota|billing|insufficient_quota/i.test(res.error || '');
      if (res.ask) {   // non è un errore: l'agente chiede una conferma (es. un lotto grande di suoni) prima di proseguire
        this.setTask(t, { status: 'FAILED', finishedAt: now(), lastError: truncate(res.error, 2000) }, 'in attesa della tua conferma');
        this.agents.setStatus(agent.id, 'WAITING', { task: t, text: 'aspetto la tua conferma', semantic: 'agent.waiting' });
        this.escalate(req, res.error, false, t, { ask: true });
        return;
      }
      const canRetry = !res.blocked && !noCredit && t.attempt <= (this.config.maxTaskRetries ?? 1);
      if (canRetry) {
        this.setTask(t, { status: 'PENDING', lastError: truncate(res.error, 2000) }, `errore, riprovo: ${truncate(res.error, 300)}`);
        this.agents.setStatus(agent.id, 'ERROR', { task: t, text: `errore, riprovo: ${truncate(res.error, 160)}`, semantic: 'agent.failed' });
        return;
      }
      this.setTask(t, { status: 'FAILED', finishedAt: now(), lastError: truncate(res.error, 2000) }, `fallito: ${truncate(res.error, 300)}`);
      agent.runtime.stats.failed++;
      this.agents.setStatus(agent.id, res.blocked ? 'BLOCKED' : 'ERROR', { task: t, text: truncate(res.error, 200), semantic: res.blocked ? 'agent.blocked' : 'agent.failed' });
      let why = truncate(res.error, 500);
      // generatore di immagini senza credito: si dice cosa fare e con cosa si può riprovare subito
      if (/API (402|429)|credit|quota|billing|insufficient|exceeded/i.test(res.error || '') && ['avatars', 'art', 'office_paint'].includes(t.kind)) {
        const alt = (req.quote?.options || []).filter((o) => !o.current && !o.plan && !o.id.startsWith(String(req.imageChoice || '').split(':')[0])).map((o) => o.label);
        why += `\n\nIl generatore di immagini ha finito il credito (le API si pagano a parte rispetto agli abbonamenti). Ricarica il credito sul sito del fornitore e premi "Riprova"${alt.length ? `, oppure riprova subito con un altro generatore: ${alt.join(', ')}` : ''}.`;
      }
      this.escalate(req, `${agent.name} non ha completato "${t.title}": ${why}`, res.blocked);
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

  escalate(req, text, blocked, task, { ask = false } = {}) {
    // i task ancora in attesa di questa richiesta non partiranno
    for (const t of this.tasksOf(req.id)) if (t.status === 'PENDING') this.setTask(t, { status: 'CANCELLED' }, 'annullato: la richiesta è passata all\'utente');
    if (ask) {
      this.setRequest(req, { status: 'NEEDS_USER', escalation: text });
      this.chat('director', `❓ Serve il tuo ok su ${req.id}.\n${text}`, { agentId: 'director', requestId: req.id, kind: 'escalation' });
      this.agents.setStatus('director', 'WAITING', { task: { id: req.id, title: `Conferma: ${req.id}` }, text: 'aspetto il tuo ok', semantic: 'agent.waiting' });
      return;
    }
    this.setRequest(req, { status: 'NEEDS_USER', escalation: text });
    this.chat('director', `⚠️ Serve una tua decisione su ${req.id}.\n${text}\n\n${blocked ? 'Configura un provider AI (Impostazioni → Provider) e premi "Riprova".' : `Puoi: premere "Riprova" (rimette in coda i task non riusciti), scrivermi come procedere${req.branch ? ', oppure scartare il branch' : ''}.`}${req.branch ? ` Il lavoro fatto finora è nel branch ${req.branch}.` : ''}`, { agentId: 'director', requestId: req.id, kind: 'escalation' });
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
    const anyChange = diff.commits.length || sdiff?.commits.length || tasks.some((t) => ['office', 'avatars'].includes(t.kind) && t.status === 'DONE');
    const result = !anyChange && !tasks.some((t) => t.kind === 'test') ? 'NESSUNA MODIFICA' : (lastTest?.verdict === 'PASS' || !lastTest ? 'PASS' : 'FAIL');
    const facts = {
      request: req.text, result, branch: req.branch, baseBranch: req.baseBranch, baseCommit: req.baseCommit?.slice(0, 7),
      agents: Object.values(participants), tests, filesChanged: diff.files, commits: diff.commits.map((c) => `${c.short} ${c.author}: ${c.subject}`),
      summaries: tasks.filter((t) => t.status === 'DONE').map((t) => `${this.agentName(t.agentId)}: ${t.result?.summary || ''}`),
      fixLoops: tasks.filter((t) => t.kind === 'fix').length,
      studioCommits: sdiff ? sdiff.commits.map((c) => `${c.short} ${c.author}: ${c.subject}`) : [],
      studioFiles: sdiff ? sdiff.files : [],
      studioBranch: req.studio?.branch || null,
      officeChanges: tasks.filter((t) => ['office', 'avatars'].includes(t.kind) && t.status === 'DONE').map((t) => `${t.result?.summary || ''} ${t.result?.notes || ''}`.trim()),
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
    if (req.remergeAfterIntegrate && !req.merged) { req.remergeAfterIntegrate = false; this.chat('agent', `${req.id} è allineata e il QA ha riprovato: la rimetto in coda per l'unione che avevi già approvato.`, { agentId: this.notaio(), requestId: req.id, kind: 'agent-update' }); this.merge(req.id).catch((e) => this.chat('system', `Unione di ${req.id} non riuscita: ${e.message}`, { requestId: req.id })); }
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
  retry(reqId, { choice } = {}) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (choice) {
      if (!(req.quote?.options || []).some((o) => o.id === choice)) throw new Error(`generatore non disponibile: ${choice}`);
      req.imageChoice = choice;
    }
    if (req.planFailed && !req.taskIds.length) {
      this.setRequest(req, { status: 'PLANNING', planFailed: false, question: null, answeredBy: req.id });
      this.plan(req).catch((e) => this.fail(req, e));
      return req;
    }
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

  notaio() { return this.agents.get('release')?.enabled !== false && this.agents.get('release') ? 'release' : 'director'; }
  say(text, req, kind = 'agent-update') { this.chat('agent', text, { agentId: this.notaio(), requestId: req?.id, kind }); }

  // "Unisci": la richiesta entra nella coda del Notaio; le unioni passano una alla volta, in ordine di nascita
  async merge(reqId, { force = false } = {}) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    await this.syncMerged([req]).catch(() => {});
    if (req.merged) { this.setRequest(req, { mergeError: null }); return req; }
    // "Unisci comunque": hai visto l'elenco del Notaio e hai deciso tu. Conflitti e versione all'indietro fermano lo stesso.
    if (force) req.forceMerge = true;
    if (req.followedBy && this.S.requests[req.followedBy]?.sameBranch) throw new Error(`${req.id} è proseguita in ${this.lastOf(req).id} sullo stesso branch: unisci quella, contiene anche questo lavoro`);
    if (!(req.branch && req.report?.commits?.length) && !(req.studio?.branch && req.report?.studioCommits?.length)) throw new Error('niente da unire');
    const q = this.release.ledger.queue;
    if (!q.includes(req.id)) q.push(req.id);
    q.sort();
    this.setRequest(req, { mergeQueued: true, mergeError: null });
    const older = Object.values(this.S.requests).filter((r) => r.id < req.id && r.status === 'DONE' && !r.merged && !r.discarded && !q.includes(r.id) && r.report?.commits?.length);
    if (q.length > 1 || older.length) this.say(`${req.id} in coda per l'unione (posizione ${q.indexOf(req.id) + 1} di ${q.length}).${older.length ? ` Nota: ${older.map((r) => r.id).join(', ')} ${older.length > 1 ? 'sono' : 'è'} più vecchi e non ancora uniti: nessun problema se li unisci dopo, li controllo quando arrivano.` : ''}`, req);
    this.queueRun = (this.queueRun || Promise.resolve()).then(() => this.processMergeQueue()).catch(() => {});
    await this.queueRun;
    if (req.mergeError && !req.merged) { const e = req.mergeError; throw new Error(e); }
    return req;
  }

  async processMergeQueue() {
    const q = this.release.ledger.queue;
    while (q.length) {
      q.sort();
      const id = q[0];
      const req = this.S.requests[id];
      try { if (req && !req.merged) await this.mergeNow(req); }
      catch (e) { if (req) { this.setRequest(req, { mergeError: e.message }); this.say(`Non ho unito ${id}: ${e.message}`, req, 'escalation'); } }
      finally { q.splice(q.indexOf(id), 1); if (req) { req.forceMerge = false; this.setRequest(req, { mergeQueued: false }); } this.store.save(); }
    }
    if (this.agents.get('release')) this.agents.setStatus('release', 'IDLE', { task: null, text: 'coda vuota' });
  }

  // le versioni del branch prima di ogni allineamento: le loro novità devono sopravvivere alla soluzione dei conflitti
  rememberTip(req, tip) { if (tip && !(req.ownTips ||= []).includes(tip)) req.ownTips.push(tip); this.store.save(); }

  async mergeNow(req) {
    const lines = [];
    const N = 'release';
    if (req.branch && req.report?.commits?.length) {
      if (this.agents.get(N)) this.agents.setStatus(N, 'TESTING', { task: { id: req.id, title: `Prova l'unione di ${req.id}` }, text: 'prova generale in una copia a parte', semantic: 'agent.testing' });
      await this.cleanJunk(req).catch(() => {});
      let pf;
      try { pf = await this.release.preflight(req); }
      catch (e) { throw new Error(`prova generale non riuscita: ${e.message.slice(0, 300)}`); }
      if (pf.conflict) {
        this.say(`Prova generale di ${req.id}: tocca gli stessi punti di aggiornamenti già entrati (${pf.files.slice(0, 6).join(', ')}). Il tuo gioco non è stato toccato. La rimando allo sviluppo per allinearla; quando il QA l'ha riprovata la unisco io, senza che tu debba ripremere.`, req);
        req.remergeAfterIntegrate = true;
        this.rememberTip(req, pf.tip);
        this.integrate(req);
        return;
      }
      if (!pf.ok && req.forceMerge && !pf.versionIssue) {
        this.say(`${req.id}: unisco comunque, come hai deciso. Righe che nel risultato non ci sono più:\n${pf.missing.slice(0, 12).map((m) => `• ${m.file}: «${m.line}» (${m.side})`).join('\n')}`, req);
        pf.ok = true; pf.forced = true;
      }
      if (!pf.ok) {
        const list = pf.missing.slice(0, 12).map((m) => `• ${m.file}: «${m.line}» (${m.side})`).join('\n');
        if (!req.repairTried) {
          req.repairTried = true; req.remergeAfterIntegrate = true;
          this.rememberTip(req, pf.tip);
          this.say(`Fermata l'unione di ${req.id}: nel risultato andrebbero persi aggiornamenti.${pf.versionIssue ? `\n• ${pf.versionIssue}` : ''}\n${list}${pf.missing.length > 12 ? `\n… e altre ${pf.missing.length - 12} righe` : ''}\nLo sviluppo riporta le righe mancanti, poi riprovo.`, req);
          this.integrate(req, `ATTENZIONE: il Notaio ha verificato che unendo questa richiesta andrebbero PERSE queste righe (devono restare tutte nel risultato, salvo che siano davvero da sostituire — in quel caso spiegalo nel riepilogo):\n${list}${pf.versionIssue ? `\nInoltre: ${pf.versionIssue}: la versione non deve mai tornare indietro.` : ''}`);
          return;
        }
        this.setRequest(req, { mergeDecision: true });
        const markers = pf.missing.some((m) => m.side === 'segni di conflitto rimasti');
        throw new Error(`${markers ? 'nei file sono rimasti dei segni di conflitto (<<<<<<<): così il gioco non parte.' : `risolvendo i conflitti lo sviluppo ha tolto ${pf.missing.length === 1 ? 'una riga' : `${pf.missing.length} righe`} e non ${pf.missing.length === 1 ? 'l\'ha rimessa' : 'le ha rimesse'} nemmeno al secondo giro: forse ${pf.missing.length === 1 ? 'è stata sostituita' : 'sono state sostituite'} apposta.`}${pf.versionIssue ? ` Inoltre ${pf.versionIssue}.` : ''}\n**Cosa fare:** ${markers || pf.versionIssue ? '«Rimanda allo sviluppo».' : 'prova «Gioca questa versione»: se va bene, «Unisci comunque»; se manca qualcosa, «Rimanda allo sviluppo».'}\n_Dettagli tecnici:_\n${list}`);
      }
      const m = await this.git.merge(req);
      this.setRequest(req, { mergeCommit: m.mergeCommit });
      const files = (req.report?.filesChanged || []).map((f) => f.file || f).slice(0, 40);
      const e = this.release.record(req, { mergeCommit: m.mergeCommit, version: pf.version, files, checks: { conflitti: 0, righePerse: pf.forced ? pf.missing.length : 0, righeCambiate: pf.changed?.length || 0, decisione: pf.forced ? 'unita comunque' : '—', versione: pf.version || '—' } });
      const ch = pf.changed || [], dc = pf.docs || [];
      lines.push(`Gioco: unione n. ${e.n} — ${req.branch} in ${req.baseBranch} (commit ${m.mergeCommit.slice(0, 7)}${pf.version ? `, versione ${pf.version}` : ''}). Controlli: nessun conflitto, ${pf.forced ? `${pf.missing.length} righe tolte per tua decisione` : 'nessuna riga persa'}${ch.length ? `, ${ch.length} righe ritoccate (non perse)` : ''}. Per annullare: "Annulla unione".${dc.length ? `\nNei documenti ${dc.length === 1 ? 'una riga è stata riscritta o tolta' : `${dc.length} righe sono state riscritte o tolte`} durante gli allineamenti (non blocca): ${[...new Set(dc.map((d) => d.file))].slice(0, 4).join(', ')}.` : ''}${ch.length ? `\nRitoccate:\n${ch.slice(0, 6).map((c) => `• ${c.file}: «${c.line.slice(0, 80)}…» → «${c.now.slice(0, 80)}…»`).join('\n')}` : ''}`);
    }
    if (req.studio?.branch && req.report?.studioCommits?.length) {
      const m = await this.studioGit.merge(req.studio);
      req.studio.mergeCommit = m.mergeCommit;
      lines.push(`Studio: unito ${req.studio.branch} (commit ${m.mergeCommit.slice(0, 7)}). Riavvia lo Studio per vederlo: ./stop-studio.sh && ./start-studio.sh`);
    }
    req.forceMerge = false;
    this.setRequest(req, { merged: true, mergedAt: now(), mergeError: null, mergeDecision: false });
    this.say(lines.join('\n'), req, 'text');
  }

  // Unioni già fatte: se il branch di una richiesta è già tutto dentro il branch principale (unito a mano con git,
  // o da un'altra copia dello Studio) la richiesta risulta unita. Lo Studio guarda git, non solo il suo registro.
  async syncMerged(list = Object.values(this.S.requests)) {
    if (!this.gitOk) return;
    for (const r of list) {
      if (!r?.branch || r.merged || r.discarded || !r.report?.commits?.length) continue;
      if (r.followedBy && this.S.requests[r.followedBy]?.sameBranch) continue;   // si unisce il seguito, non lei
      const g = (args) => this.git.git(args, this.projectRoot, { allowFail: true });
      const tip = (await g(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`])).stdout.trim();
      if (!tip || tip === r.baseCommit) continue;
      const into = r.baseBranch || 'HEAD';
      if ((await g(['merge-base', '--is-ancestor', tip, into])).code !== 0) continue;
      const merges = (await g(['rev-list', '--merges', '--ancestry-path', `${tip}..${into}`])).stdout.trim().split('\n').filter(Boolean);
      const mergeCommit = merges.at(-1) || null;
      this.setRequest(r, { merged: true, mergedAt: now(), mergeCommit, mergeError: null, mergeDecision: false, mergedOutside: true });
      this.release.record(r, { mergeCommit, files: [], checks: { nota: 'unita fuori dallo Studio (già nel branch principale)' } });
      this.say(`${r.id} è già dentro ${r.baseBranch || 'il gioco'}${mergeCommit ? ` (commit ${mergeCommit.slice(0, 7)})` : ''}: la segno come unita.`, r, 'text');
    }
  }

  // i file di lavoro degli agenti finiti per errore nel branch (.shots/ ecc.) escono prima dell'unione
  async cleanJunk(req) {
    const wt = req.worktree;
    if (!wt || !fs.existsSync(wt)) return;
    return this.git.locked(wt, async () => {
      const g = (args) => this.git.git(args, wt, { allowFail: true });
      const tracked = (await g(['ls-files'])).stdout.split('\n').filter((f) => f && isJunk(f));
      if (!tracked.length) return;
      const inMain = new Set((await g(['ls-tree', '-r', '--name-only', req.baseBranch || 'HEAD'])).stdout.split('\n'));
      const rm = tracked.filter((f) => !inMain.has(f));
      if (!rm.length) return;
      await g(['rm', '--cached', '-q', '-r', '--', ...rm]);
      const hasUser = (await g(['config', 'user.name'])).stdout.trim();
      await g([...(hasUser ? [] : ['-c', 'user.name=Game Studio', '-c', 'user.email=studio@studio.local']), 'commit', '--no-verify', '-q', '--author', 'Notaio (Studio) <release@studio.local>', '-m', `[release] Tolgo dal branch ${rm.length} file di lavoro degli agenti (screenshot e script di prova)\n\nStudio-Agent: release\nStudio-Request: ${req.id}`]);
    });
  }

  // un seguito sullo stesso branch che si è chiuso senza lavoro (solo una risposta, o annullato) restituisce il
  // testimone: la richiesta di prima torna unibile
  releaseOrphans() {
    for (const r of Object.values(this.S.requests)) {
      const f = r.followedBy && this.S.requests[r.followedBy];
      if (f && f.sameBranch && ['ANSWERED', 'CANCELLED', 'FAILED'].includes(f.status) && !this.tasksOf(f.id).some((t) => t.result?.commit)) { r.followedBy = null; this.events.emit('request.updated', { request: r }); }
    }
  }

  // all'avvio: le unioni che avevi approvato e che si erano fermate si riprovano con i controlli attuali
  recheckStuck() {
    const ids = Object.values(this.S.requests).filter((r) => r.mergeDecision && !r.merged && !r.discarded && !r.followedBy).map((r) => r.id).sort();
    if (!ids.length) return;
    for (const id of ids) Object.assign(this.S.requests[id], { mergeDecision: false, mergeError: null, repairTried: false });
    this.store.save();
    this.say(`Riprovo con i controlli nuovi le unioni che avevi approvato e che si erano fermate: ${ids.join(', ')}. Una alla volta, in ordine; se serve allineare ci pensa lo sviluppo. Ti chiamo solo se resta qualcosa da decidere.`, this.S.requests[ids[0]]);
    for (const id of ids) this.merge(id).catch((e) => this.chat('system', `Unione di ${id} non riuscita: ${e.message}`, { requestId: id }));
  }

  // "Chiudi": una domanda rimasta appesa che non serve più
  closeQuestion(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (req.quotePending) return this.answerQuote(reqId, 'cancel');
    if (req.status !== 'NEEDS_USER') throw new Error(`${req.id} non aspetta niente`);
    this.setRequest(req, { status: 'ANSWERED', closedByUser: true });
    this.chat('system', `${req.id}: domanda chiusa.`, { requestId: req.id });
    return req;
  }

  // "Rimanda allo sviluppo": il Notaio ha trovato righe che mancano e tu vuoi che vengano rimesse
  repairMerge(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (req.merged) throw new Error('già unita');
    const list = String(req.mergeError || '').split('\n').filter((l) => l.startsWith('•')).join('\n');
    req.remergeAfterIntegrate = true;
    this.setRequest(req, { mergeError: null, mergeDecision: false });
    this.integrate(req, `L'utente ha deciso: queste righe vanno RIMESSE nel risultato (non sono da sostituire):\n${list}`);
    return req;
  }

  // Due richieste hanno toccato gli stessi file (tipico: versione e CHANGELOG). Lo sviluppo porta nel branch le novità
  // del branch principale, risolve i conflitti, il QA riprova; poi si può unire.
  integrate(req, extra = '') {
    const dev = this.agents.forKind('fix');
    const qa = this.agents.forKind('test');
    const t1 = this.createTask({ requestId: req.id, agentId: dev.id, kind: 'integrate', title: `Allinea con ${req.baseBranch} e risolvi i conflitti`, instructions: `Mentre lavoravamo a questa richiesta, nel branch ${req.baseBranch} sono entrate altre modifiche che toccano gli stessi file. Lo Studio ha avviato l'unione di ${req.baseBranch} in questo branch: risolvi i conflitti (cerca i segni <<<<<<< ======= >>>>>>>), tenendo TUTTE e due le modifiche. Regole: in src/version.js tieni la versione più alta e aumentala di una PATCH; in CHANGELOG.md tieni tutte le voci, la tua in cima con il nuovo numero. Poi controlla che non restino segni di conflitto.${extra ? `\n\n${extra}` : ''}`, dependsOn: [], repair: !!extra });
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
    const later = this.release.ledger.entries.filter((e) => e.kind === 'unione' && e.n > (this.release.ledger.entries.find((x) => x.requestId === req.id && x.kind === 'unione')?.n ?? Infinity)).map((e) => e.requestId);
    const pre = await this.release.revertPreflight(req);
    if (!pre.ok) throw new Error(`togliere ${req.id} romperebbe aggiornamenti entrati dopo${later.length ? ` (${later.join(', ')})` : ''} nei file ${pre.files.join(', ')}. Non ho toccato niente: chiedi alla Regia di togliere a mano le parti di ${req.id} che non vuoi.`);
    const r = await this.git.revertMerge(req);
    this.release.record(req, { kind: 'annullamento', mergeCommit: r.revertCommit, checks: { dopo: later.join(', ') || '—' } });
    this.setRequest(req, { merged: false, revertCommit: r.revertCommit });
    this.chat('system', `Unione di ${req.id} annullata (commit ${r.revertCommit.slice(0, 7)}).`, { requestId: req.id });
    return req;
  }

  async discard(reqId) {
    const req = this.S.requests[reqId];
    if (!req) throw new Error('richiesta sconosciuta');
    if (req.followedBy && this.S.requests[req.followedBy]?.sameBranch && !this.S.requests[req.followedBy].discarded) throw new Error(`${req.id} è proseguita in ${this.lastOf(req).id} sullo stesso branch: scarta quella`);
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
