// Registro degli agenti. L'identità (nome, ruolo, avatar, istruzioni) è DATO modificabile;
// il codice usa solo id stabili e capacità.
import fs from 'node:fs';
import { now } from './util.js';

export const STATUSES = ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'TESTING', 'BLOCKED', 'DONE', 'ERROR'];

// campi che l'utente può modificare dall'interfaccia
export const EDITABLE = ['name', 'role', 'description', 'systemInstructions', 'capabilities', 'kinds', 'enabled', 'visible', 'provider', 'model', 'imageProvider', 'contextDocs', 'avatar', 'writes', 'dismissed'];

// Stati → animazione dell'avatar (default; ogni avatar può sovrascriverli in avatar.animations)
export const DEFAULT_ANIMATIONS = {
  IDLE: 'idle', THINKING: 'writing-notes', WORKING: 'typing', WAITING: 'waiting', TESTING: 'playing',
  BLOCKED: 'question', DONE: 'celebrate', ERROR: 'error',
};

function runtime() {
  return { status: 'IDLE', currentTaskId: null, currentTaskTitle: null, lastActivity: null, history: [], stats: { done: 0, failed: 0 } };
}

export class AgentRegistry {
  constructor(store, events, defaultsFile) {
    this.store = store;
    this.events = events;
    this.defaultsFile = defaultsFile;
    this.defaults = JSON.parse(fs.readFileSync(defaultsFile, 'utf8')).agents;
    const agents = store.data.agents;
    for (const d of this.defaults) {
      if (!agents[d.id]) agents[d.id] = { ...structuredClone(d), runtime: runtime(), createdAt: now() };
    }
    for (const a of Object.values(agents)) {
      a.runtime = { ...runtime(), ...(a.runtime || {}) };
      // aggiornamento: gli agenti predefiniti ricevono il personaggio pixel art (se l'avatar non è stato personalizzato)
      const def = this.defaults.find((d) => d.id === a.id);
      if (def?.avatar?.character && !a.avatar?.character) {
        const untouched = !a.avatar || (a.avatar.type === 'emoji' && a.avatar.emoji === def.avatar.emoji);
        a.avatar = { ...(a.avatar || {}), character: structuredClone(def.avatar.character), ...(untouched ? { type: 'pixel' } : {}) };
      }
      // nuovi tipi di task dei predefiniti (es. Cosetta: "avatars") si aggiungono senza toccare le personalizzazioni
      for (const k of def?.kinds || []) if (!(a.kinds || []).includes(k)) a.kinds = [...(a.kinds || []), k];
      // personaggio predefinito ridisegnato (lookVersion più alta): si aggiorna, a meno che l'utente non l'abbia personalizzato
      if (def?.avatar?.character && !a.avatar?.userEdited && (a.avatar?.lookVersion || 0) < (def.avatar.lookVersion || 0)) {
        a.avatar = { ...(a.avatar || {}), type: a.avatar?.type === 'emoji' || !a.avatar?.type ? 'pixel' : a.avatar.type, character: structuredClone(def.avatar.character), lookVersion: def.avatar.lookVersion };
      }
      // dopo un riavvio nessuno sta lavorando davvero: il scheduler rimette in coda i task interrotti
      if (!['IDLE', 'ERROR', 'BLOCKED'].includes(a.runtime.status)) { a.runtime.status = 'IDLE'; a.runtime.currentTaskId = null; a.runtime.currentTaskTitle = null; }
    }
    store.save();
  }

  list({ includeHidden = true } = {}) { return Object.values(this.store.data.agents).filter((a) => includeHidden || a.visible !== false); }
  get(id) { return this.store.data.agents[id] || null; }

  // trova l'agente per un tipo di task / capacità (prima per "kinds", poi per capacità)
  forKind(kind) {
    const on = this.list().filter((a) => a.enabled !== false && a.id !== 'director');
    return on.find((a) => (a.kinds || []).includes(kind)) || on.find((a) => (a.capabilities || []).includes(kind)) || null;
  }

  update(id, patch) {
    const a = this.get(id);
    if (!a) throw new Error(`agente sconosciuto: ${id}`);
    for (const k of EDITABLE) if (k in patch) a[k] = patch[k];
    if (patch.avatar) a.avatar = { ...(a.avatar || {}), ...patch.avatar, userEdited: patch.avatar.userEdited ?? true };
    a.updatedAt = now();
    this.store.save();
    this.events.emit('agent.updated', { agentId: id, agent: this.public(a) });
    return a;
  }

  create(def) {
    const id = String(def.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id || this.get(id)) throw new Error('id mancante o già usato');
    const a = { id, name: def.name || id, role: def.role || '', description: def.description || '', visible: true, enabled: true, capabilities: def.capabilities || [], kinds: def.kinds || [], provider: 'auto', model: '', writes: !!def.writes, contextDocs: def.contextDocs || ['PROJECT_STATE'], systemInstructions: def.systemInstructions || '', avatar: def.avatar || { type: 'emoji', emoji: '🙂', color: '#cccccc' }, runtime: runtime(), createdAt: now() };
    this.store.data.agents[id] = a;
    this.store.save();
    this.events.emit('agent.updated', { agentId: id, agent: this.public(a) });
    return a;
  }

  resetToDefault(id) {
    const d = this.defaults.find((x) => x.id === id);
    if (!d) throw new Error('nessun predefinito per questo agente');
    const a = this.get(id);
    const keep = a?.runtime || runtime();
    this.store.data.agents[id] = { ...structuredClone(d), runtime: keep, createdAt: a?.createdAt || now(), updatedAt: now() };
    this.store.save();
    this.events.emit('agent.updated', { agentId: id, agent: this.public(this.get(id)) });
    return this.get(id);
  }

  // Cambio di stato + evento. `semantic` è l'evento "parlante" (agent.editing, agent.testing, ...)
  setStatus(id, status, { task, text, semantic, detail } = {}) {
    const a = this.get(id);
    if (!a) return;
    if (!STATUSES.includes(status)) status = 'IDLE';
    const r = a.runtime;
    const changed = r.status !== status || (task && r.currentTaskId !== task.id);
    r.status = status;
    if (task !== undefined) { r.currentTaskId = task ? task.id : null; r.currentTaskTitle = task ? task.title : null; }
    r.lastActivity = now();
    if (text) {
      r.history.push({ ts: now(), status, taskId: task?.id ?? r.currentTaskId, text: String(text).slice(0, 400) });
      if (r.history.length > 150) r.history.splice(0, r.history.length - 150);
    }
    this.store.save();
    const payload = { agentId: id, status, taskId: r.currentTaskId, taskTitle: r.currentTaskTitle, text, detail };
    if (changed) this.events.emit('agent.status', payload);
    if (semantic) this.events.emit(semantic, payload);
  }

  activity(id, text, semantic = 'agent.activity', detail) {
    const a = this.get(id);
    if (!a) return;
    a.runtime.history.push({ ts: now(), status: a.runtime.status, taskId: a.runtime.currentTaskId, text: String(text).slice(0, 400) });
    if (a.runtime.history.length > 150) a.runtime.history.splice(0, a.runtime.history.length - 150);
    a.runtime.lastActivity = now();
    this.store.save();
    this.events.emit(semantic, { agentId: id, status: a.runtime.status, taskId: a.runtime.currentTaskId, text, detail });
  }

  public(a) {
    return { ...a, animations: { ...DEFAULT_ANIMATIONS, ...(a.avatar?.animations || {}) } };
  }
}
