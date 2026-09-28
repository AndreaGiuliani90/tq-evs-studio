// Stato persistente dello Studio (data/state.json): agenti, richieste, task, chat.
// Un solo file JSON, scritto in modo atomico e con un piccolo ritardo per raggruppare le modifiche.
import path from 'node:path';
import { readJSON, writeFileAtomic, now } from './util.js';

const EMPTY = () => ({ schema: 1, createdAt: now(), counters: { task: 0, request: 0, msg: 0 }, agents: {}, requests: {}, tasks: {}, chat: [] });

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = Object.assign(EMPTY(), readJSON(this.file, {}));
    this.timer = null;
  }

  nextId(kind, prefix) {
    this.data.counters[kind] = (this.data.counters[kind] || 0) + 1;
    return `${prefix}-${String(this.data.counters[kind]).padStart(4, '0')}`;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // la chat non cresce all'infinito nel file di stato
    if (this.data.chat.length > 2000) this.data.chat = this.data.chat.slice(-2000);
    this.data.savedAt = now();
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}
