// REGISTRO DELLE SPESE dello Studio: solo subtotali per provider (niente singole voci), mostrati sulla lavagna
// dell'ufficio. Le spese vere sono quelle a consumo (API immagini, API Anthropic); gli abbonamenti (Claude Code,
// Codex, Gemini CLI) sono "inclusi nel piano": qui si conta solo quante volte li usiamo.
import { now } from './util.js';

export const COST_LABELS = {
  'openai-image': 'GPT Image (OpenAI)', 'gemini-image': 'Nano Banana (Google)', anthropic: 'API Anthropic',
  'claude-code': 'Claude Code (piano Claude)', codex: 'Codex (piano ChatGPT)', gemini: 'Gemini CLI (account Google)',
};
export const COST_SHORT = { 'openai-image': 'GPT', 'gemini-image': 'GEMINI', anthropic: 'CLAUDE API', 'claude-code': 'CLAUDE', codex: 'CODEX', gemini: 'GEMINI CLI' };
export const INCLUDED_PROVIDERS = ['claude-code', 'codex', 'gemini'];

export class CostBook {
  constructor(store, events) { this.store = store; this.events = events; }
  get data() { return (this.store.data.costs ??= { since: now(), providers: {} }); }

  add(id, { usd = 0, images = 0, runs = 0 } = {}) {
    if (!id || id === 'mock') return;
    const p = (this.data.providers[id] ??= { usd: 0, images: 0, runs: 0 });
    p.usd = Math.round((p.usd + usd) * 10000) / 10000; p.images += images; p.runs += runs;
    this.data.updatedAt = now();
    this.store.save();
    this.events?.emit('costs.updated', { costs: this.summary() });
  }

  summary() {
    const d = this.data;
    const providers = Object.entries(d.providers).map(([id, p]) => ({ id, label: COST_LABELS[id] || id, short: COST_SHORT[id] || id.toUpperCase(), included: INCLUDED_PROVIDERS.includes(id), usd: Math.round(p.usd * 100) / 100, images: p.images, runs: p.runs }))
      .sort((a, b) => b.usd - a.usd || b.runs - a.runs);
    return { since: d.since, updatedAt: d.updatedAt || null, totalUsd: Math.round(providers.reduce((s, p) => s + (p.included ? 0 : p.usd), 0) * 100) / 100, providers };
  }

  reset() { this.store.data.costs = { since: now(), providers: {} }; this.store.save(); this.events?.emit('costs.updated', { costs: this.summary() }); return this.summary(); }
}
