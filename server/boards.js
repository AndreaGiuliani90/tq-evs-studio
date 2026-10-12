// LE LAVAGNE dell'ufficio (oltre a quella delle spese, in costs.js):
//   - DA FARE: le attività concordate con la squadra quando chiedi di "programmare le prossime task". Non partono da
//     sole: le avvii tu (pulsante o «avvia B-3» in chat); quando la richiesta finisce l'attività si spunta da sola.
//   - SQUADRA: chi lavora di più e chi lavora meglio, calcolato dai task fatti (niente voti a sentimento).
import { now } from './util.js';

export const PRIORITIES = ['alta', 'media', 'bassa'];

export const DEFAULT_LANE = 'Generale';
export const LEGACY_LANE = 'Da organizzare';   // attività nate prima dei rami: restano indipendenti

// RAMI E DIPENDENZE. Un ramo è un filone di lavoro: nello stesso ramo le attività vanno in fila (ognuna parte dal
// risultato della precedente, sullo stesso branch); rami diversi lavorano in parallelo su branch separati e il Notaio
// li unisce al gioco uno alla volta. "after" = dipendenze da attività di ALTRI rami: quelle devono essere già
// entrate nel gioco (unite), così la nuova parte da un gioco che le contiene.
export class Backlog {
  constructor(store, events) { this.store = store; this.events = events; }
  get data() { return (this.store.data.backlog ??= { seq: 0, items: [] }); }
  get requests() { return this.store.data.requests || {}; }
  list() { return this.data.items; }
  open() { return this.data.items.filter((i) => i.status !== 'fatto' && i.status !== 'scartato'); }
  get(id) { return this.data.items.find((i) => i.id === String(id).toUpperCase()) || null; }
  emit() { this.store.save(); this.events?.emit('backlog.updated', { backlog: this.summary() }); }

  add({ title, agent = null, priority = 'media', details = '', source = null, lane = null, after = [] }) {
    title = String(title || '').trim().slice(0, 160);
    if (!title) throw new Error('attività senza titolo');
    const it = { id: `B-${++this.data.seq}`, title, agent: agent || null, priority: PRIORITIES.includes(priority) ? priority : 'media', details: String(details || '').slice(0, 1500), status: 'da fare', createdAt: now(), source, requestId: null, lane: String(lane || '').trim().slice(0, 40) || DEFAULT_LANE, after: [] };
    this.data.items.push(it);
    it.after = this.cleanAfter(it, after);
    this.emit();
    return it;
  }
  cleanAfter(it, after) {
    const ids = (Array.isArray(after) ? after : String(after || '').split(/[\s,;]+/)).map((x) => String(x).toUpperCase().trim()).filter((x) => /^B-\d+$/.test(x) && x !== it.id && this.get(x));
    // niente cicli: una dipendenza che (anche indirettamente) dipende da questa attività viene scartata
    return [...new Set(ids)].filter((d) => !this.dependsOn(d, it.id));
  }
  dependsOn(a, b, seen = new Set()) {
    if (a === b) return true; if (seen.has(a)) return false; seen.add(a);
    const it = this.get(a); if (!it) return false;
    return this.depsOf(it).some((d) => this.dependsOn(d.id, b, seen));
  }
  update(id, patch) {
    const it = this.get(id); if (!it) throw new Error(`attività sconosciuta: ${id}`);
    for (const k of ['title', 'priority', 'details', 'agent', 'status', 'requestId', 'waitingAnswer']) if (k in patch) it[k] = patch[k];
    if (patch.status === 'da fare' && patch.requestId === null) { it.waitingAnswer = null; it.doneAt = null; }
    if ('lane' in patch) it.lane = String(patch.lane || '').trim().slice(0, 40) || DEFAULT_LANE;
    if ('after' in patch) it.after = this.cleanAfter(it, patch.after);
    if (!PRIORITIES.includes(it.priority)) it.priority = 'media';
    it.updatedAt = now();
    if (it.status === 'fatto') it.doneAt ??= now();
    this.emit();
    return it;
  }
  remove(id) { const it = this.get(id); if (!it) throw new Error(`attività sconosciuta: ${id}`); return this.update(id, { status: 'scartato' }); }

  // una richiesta collegata (o il suo ultimo seguito sullo stesso branch) è finita:
  //   - DONE → l'attività si spunta;
  //   - fermata o fallita → torna "da fare";
  //   - la Regia ha risposto con una domanda (nessun lavoro) → torna "da fare" ma ricorda che aspetta una tua
  //     risposta: così non blocca il ramo e la lavagna lo dice.
  onRequest(req) {
    for (const it of this.data.items.filter((i) => i.requestId && (i.requestId === req.id || this.reqOf(i)?.id === req.id))) {
      if (req.status === 'DONE' && it.status !== 'fatto') this.update(it.id, { status: 'fatto', waitingAnswer: null });
      else if (['CANCELLED', 'FAILED'].includes(req.status) && it.status === 'in corso') this.update(it.id, { status: 'da fare', requestId: null, waitingAnswer: null });
      else if (req.status === 'ANSWERED' && it.status === 'in corso' && this.reqOf(it)?.id === req.id) this.update(it.id, { status: 'da fare', waitingAnswer: req.id });
    }
  }
  // all'avvio: attività rimaste "in corso" o "fatte" senza corrispondere più alle loro richieste
  reconcile() {
    for (const it of this.data.items) {
      if (it.status !== 'in corso' || !it.requestId) continue;
      const r = this.reqOf(it);
      if (r && ['DONE', 'CANCELLED', 'FAILED', 'ANSWERED'].includes(r.status)) this.onRequest(r);
    }
  }

  laneOf(it) { return it.lane || LEGACY_LANE; }
  // l'attività prima di questa nello stesso ramo (le scartate non contano)
  prevInLane(it) {
    if (!it.lane) return null;
    const same = this.data.items.filter((x) => this.laneOf(x) === this.laneOf(it) && x.status !== 'scartato');
    const i = same.indexOf(it);
    return i > 0 ? same[i - 1] : null;
  }
  depsOf(it) { const p = this.prevInLane(it); return [...(p ? [p] : []), ...(it.after || []).map((d) => this.get(d)).filter((d) => d && d.status !== 'scartato' && d !== p)]; }
  // la richiesta che contiene davvero il lavoro di un'attività (seguendo i seguiti sullo stesso branch)
  reqOf(it) { let r = it.requestId && this.requests[it.requestId]; const seen = new Set(); while (r?.followedBy && this.requests[r.followedBy] && !seen.has(r.id)) { seen.add(r.id); r = this.requests[r.followedBy]; } return r || null; }
  merged(it) { const r = it.requestId && this.requests[it.requestId]; return !!(r && (r.merged || this.reqOf(it)?.merged)); }

  // si può avviare? e come: "nuovo" = branch nuovo dal gioco attuale; "seguito" = continua il branch dell'attività
  // precedente del ramo (finita ma non ancora unita), così parte dal suo risultato e alla fine si unisce una volta sola
  canStart(it) {
    if (it.status !== 'da fare') return { ok: false, why: it.status === 'in corso' ? 'è già in corso' : it.status === 'fatto' ? 'è già fatta' : 'è stata tolta' };
    const lane = this.laneOf(it);
    const busy = it.lane && this.data.items.find((x) => x !== it && this.laneOf(x) === lane && x.status === 'in corso');
    if (busy) return { ok: false, why: `nel ramo «${lane}» è in corso ${busy.id}: si parte quando finisce`, waitFor: busy.id };
    const prev = this.prevInLane(it);
    if (prev && prev.status !== 'fatto') return { ok: false, why: `prima va fatta ${prev.id} (stesso ramo)`, waitFor: prev.id };
    for (const d of (it.after || []).map((x) => this.get(x)).filter((d) => d && d.status !== 'scartato' && d !== prev)) {
      if (d.status !== 'fatto') return { ok: false, why: `aspetta ${d.id} (ramo «${this.laneOf(d)}»)`, waitFor: d.id };
      if (!this.merged(d)) return { ok: false, why: `aspetta che ${d.id} entri nel gioco: unisci ${this.reqOf(d)?.id || d.requestId || d.id}`, waitFor: d.id, needsMerge: this.reqOf(d)?.id || null };
    }
    const pr = prev && this.reqOf(prev);
    if (pr && pr.branch && !pr.merged && !pr.discarded && pr.status === 'DONE') return { ok: true, mode: 'seguito', from: pr.id };
    return { ok: true, mode: 'nuovo' };
  }

  graph() {
    const items = this.data.items.filter((i) => i.status !== 'scartato');
    const lanes = [...new Set(items.map((i) => this.laneOf(i)))];
    return {
      lanes,
      nodes: items.map((i) => {
        const r = i.requestId && this.requests[i.requestId], last = this.reqOf(i);
        const c = this.canStart(i);
        return { id: i.id, title: i.title, details: i.details, agent: i.agent, priority: i.priority, status: i.status, lane: this.laneOf(i), after: i.after || [], deps: this.depsOf(i).map((d) => d.id), requestId: i.requestId, lastRequestId: last?.id || null, merged: this.merged(i), requestStatus: last?.status || r?.status || null, waitingAnswer: i.waitingAnswer || null, canStart: c.ok, why: c.why || null, mode: c.mode || null, from: c.from || null, needsMerge: c.needsMerge || null };
      }),
    };
  }

  summary() {
    const order = { 'in corso': 0, 'da fare': 1 }, pr = { alta: 0, media: 1, bassa: 2 };
    const open = this.open().sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || pr[a.priority] - pr[b.priority] || a.createdAt.localeCompare(b.createdAt));
    const done = this.data.items.filter((i) => i.status === 'fatto').sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 10);
    const graph = this.graph();
    return { open, done, graph, counts: { open: open.length, doing: open.filter((i) => i.status === 'in corso').length, done: this.data.items.filter((i) => i.status === 'fatto').length, ready: graph.nodes.filter((n) => n.canStart).length } };
  }
}

// ── performance della squadra ────────────────────────────────────────────────────────────────────
// lavoro  = task completati (e tempo passato a lavorare)
// qualità = quanto del lavoro va bene al primo colpo: completati / (completati + falliti + rifacimenti chiesti dal QA)
//           Per il QA un test che trova bug è lavoro ben fatto, non un fallimento.
export function teamPerformance(tasks, agents) {
  const by = {};
  const A = (id) => (by[id] ??= { done: 0, failed: 0, rework: 0, retries: 0, minutes: 0, bugsFound: 0 });
  const all = Object.values(tasks);
  const byId = Object.fromEntries(all.map((t) => [t.id, t]));
  for (const t of all) {
    if (!t.agentId) continue;
    const a = A(t.agentId);
    if (t.attempt > 1) a.retries += t.attempt - 1;
    const testFail = t.kind === 'test' && t.result?.verdict === 'FAIL';
    if (t.status === 'DONE' || testFail) {
      a.done++;
      if (t.startedAt && t.finishedAt) a.minutes += Math.max(0, (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 60000);
    } else if (t.status === 'FAILED' && !t.superseded && !/conferma/.test(t.lastError || '')) a.failed++;
    if (testFail) {
      a.bugsFound += (t.result?.bugs || []).length || 1;
      // il lavoro testato va rifatto: conta come rifacimento per chi l'aveva scritto
      const seen = new Set();
      const walk = (id) => { const d = byId[id]; if (!d || seen.has(id)) return; seen.add(id); if (d.kind !== 'test') { A(d.agentId).rework++; } else d.dependsOn?.forEach(walk); };
      t.dependsOn?.forEach(walk);
    }
  }
  const rows = agents.filter((a) => a.enabled !== false || by[a.id]).map((a) => {
    const s = by[a.id] || A(a.id);
    const tries = s.done + s.failed + s.rework;
    return { id: a.id, name: a.name, role: a.role, enabled: a.enabled !== false, ...s, minutes: Math.round(s.minutes), quality: tries ? Math.round((100 * s.done) / tries) : null, avgMin: s.done ? Math.round((s.minutes / s.done) * 10) / 10 : null };
  });
  const active = rows.filter((r) => r.done + r.failed > 0);
  const most = [...active].sort((a, b) => b.done - a.done || b.minutes - a.minutes)[0] || null;
  const best = [...active].filter((r) => r.done + r.failed + r.rework >= 3).sort((a, b) => b.quality - a.quality || b.done - a.done)[0] || null;
  return { rows: rows.sort((a, b) => b.done - a.done || (b.quality ?? -1) - (a.quality ?? -1)), most: most?.id || null, best: best?.id || null, totals: { done: active.reduce((s, r) => s + r.done, 0), minutes: active.reduce((s, r) => s + r.minutes, 0) } };
}
