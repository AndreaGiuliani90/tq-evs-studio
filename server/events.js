// Bus degli eventi: ogni attività degli agenti diventa un evento.
// - in memoria (ultimi N, per chi si collega dopo)
// - su disco (data/events.jsonl, per la cronologia)
// - in diretta al frontend via SSE (/api/events)
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, now } from './util.js';

export const EVENT_TYPES = [
  'agent.status', 'agent.started_task', 'agent.thinking', 'agent.editing', 'agent.testing', 'agent.waiting',
  'agent.completed', 'agent.failed', 'agent.blocked', 'agent.activity', 'agent.updated',
  'task.created', 'task.updated', 'request.created', 'request.updated', 'chat.message',
  'git.commit', 'git.merge', 'git.discard', 'memory.updated', 'studio.warning', 'asset.created',
];

export class EventBus {
  constructor({ file, keep = 500 } = {}) {
    this.file = file;
    this.keep = keep;
    this.seq = 0;
    this.recent = [];
    this.listeners = new Set();
    if (file) {
      ensureDir(path.dirname(file));
      // riprende la numerazione dall'ultimo evento salvato
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        for (const l of lines.slice(-keep)) { try { const e = JSON.parse(l); this.recent.push(e); this.seq = Math.max(this.seq, e.seq || 0); } catch { /* riga rotta */ } }
      } catch { /* primo avvio */ }
    }
  }

  emit(type, data = {}) {
    const ev = { seq: ++this.seq, type, ts: now(), ...data };
    this.recent.push(ev);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    if (this.file) { try { fs.appendFileSync(this.file, JSON.stringify(ev) + '\n'); } catch { /* disco pieno: pazienza */ } }
    for (const fn of this.listeners) { try { fn(ev); } catch { /* un listener rotto non ferma gli altri */ } }
    return ev;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  since(seq = 0) { return this.recent.filter((e) => e.seq > seq); }
}
