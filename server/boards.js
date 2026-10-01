// LE LAVAGNE dell'ufficio (oltre a quella delle spese, in costs.js):
//   - DA FARE: le attività concordate con la squadra quando chiedi di "programmare le prossime task". Non partono da
//     sole: le avvii tu (pulsante o «avvia B-3» in chat); quando la richiesta finisce l'attività si spunta da sola.
//   - SQUADRA: chi lavora di più e chi lavora meglio, calcolato dai task fatti (niente voti a sentimento).
import { now } from './util.js';

export const PRIORITIES = ['alta', 'media', 'bassa'];

export class Backlog {
  constructor(store, events) { this.store = store; this.events = events; }
  get data() { return (this.store.data.backlog ??= { seq: 0, items: [] }); }
  list() { return this.data.items; }
  open() { return this.data.items.filter((i) => i.status !== 'fatto' && i.status !== 'scartato'); }
  get(id) { return this.data.items.find((i) => i.id === String(id).toUpperCase()) || null; }
  emit() { this.store.save(); this.events?.emit('backlog.updated', { backlog: this.summary() }); }

  add({ title, agent = null, priority = 'media', details = '', source = null }) {
    title = String(title || '').trim().slice(0, 160);
    if (!title) throw new Error('attività senza titolo');
    const it = { id: `B-${++this.data.seq}`, title, agent: agent || null, priority: PRIORITIES.includes(priority) ? priority : 'media', details: String(details || '').slice(0, 1500), status: 'da fare', createdAt: now(), source, requestId: null };
    this.data.items.push(it);
    this.emit();
    return it;
  }
  update(id, patch) {
    const it = this.get(id); if (!it) throw new Error(`attività sconosciuta: ${id}`);
    for (const k of ['title', 'priority', 'details', 'agent', 'status', 'requestId']) if (k in patch) it[k] = patch[k];
    if (!PRIORITIES.includes(it.priority)) it.priority = 'media';
    it.updatedAt = now();
    if (it.status === 'fatto') it.doneAt ??= now();
    this.emit();
    return it;
  }
  remove(id) { const it = this.get(id); if (!it) throw new Error(`attività sconosciuta: ${id}`); return this.update(id, { status: 'scartato' }); }

  // una richiesta collegata è finita: l'attività si spunta (o torna "da fare" se la richiesta è stata fermata)
  onRequest(req) {
    const it = this.data.items.find((i) => i.requestId === req.id);
    if (!it) return;
    if (req.status === 'DONE' && it.status !== 'fatto') this.update(it.id, { status: 'fatto' });
    else if (['CANCELLED', 'FAILED'].includes(req.status) && it.status === 'in corso') this.update(it.id, { status: 'da fare', requestId: null });
  }

  summary() {
    const order = { 'in corso': 0, 'da fare': 1 }, pr = { alta: 0, media: 1, bassa: 2 };
    const open = this.open().sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || pr[a.priority] - pr[b.priority] || a.createdAt.localeCompare(b.createdAt));
    const done = this.data.items.filter((i) => i.status === 'fatto').sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 10);
    return { open, done, counts: { open: open.length, doing: open.filter((i) => i.status === 'in corso').length, done: this.data.items.filter((i) => i.status === 'fatto').length } };
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
