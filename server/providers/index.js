// Astrazione dei provider AI. Ogni agente ha `provider` (testo/codice) e, se serve, `imageProvider`.
// "auto" = il primo disponibile fra: claude-code → anthropic → mock.
import { ClaudeCodeProvider } from './claude-code.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIImageProvider } from './openai-image.js';
import { CodexProvider } from './codex.js';
import { GeminiCliProvider } from './gemini-cli.js';
import { GeminiImageProvider } from './gemini-image.js';

export class MockProvider {
  constructor() { this.id = 'mock'; this.kind = 'text'; this.label = 'Nessun AI (modalità dimostrativa)'; }
  async available() { return { ok: true, note: 'sempre disponibile: non modifica file, serve solo per far girare lo Studio senza AI' }; }
  async run({ mode }) {
    if (mode === 'plan') return { ok: false, error: 'mock: pianificazione euristica', code: 'USE_HEURISTIC' };
    return { ok: false, error: 'Nessun provider AI configurato: installa Claude Code (comando `claude`) oppure metti ANTHROPIC_API_KEY in .env dello Studio', code: 'PROVIDER_UNAVAILABLE' };
  }
}

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.register(new ClaudeCodeProvider());
    this.register(new AnthropicProvider());
    this.register(new CodexProvider());
    this.register(new GeminiCliProvider());
    this.register(new GeminiImageProvider());
    this.register(new OpenAIImageProvider());
    this.register(new MockProvider());
    this.autoOrder = ['claude-code', 'anthropic', 'mock'];
  }

  register(p) { this.providers.set(p.id, p); return p; }

  // provider immagini: quello scelto per l'agente, oppure "auto" = il primo configurato fra GPT Image e Nano Banana
  async resolveImage(id = 'auto') {
    const order = id && id !== 'auto' ? [id, 'openai-image', 'gemini-image'] : ['openai-image', 'gemini-image'];
    for (const k of order) { const p = this.get(k); if (p && p.kind === 'image' && (await p.available()).ok) return p; }
    return this.get(id && id !== 'auto' ? id : 'openai-image') || null;
  }
  get(id) { return this.providers.get(id) || null; }

  async resolve(id = 'auto') {
    if (id && id !== 'auto') {
      const p = this.get(id);
      if (p) { const av = await p.available(); if (av.ok) return p; }
    }
    for (const k of this.autoOrder) {
      const p = this.get(k);
      if (p && (await p.available()).ok) return p;
    }
    return this.get('mock');
  }

  async status() {
    const out = [];
    for (const p of this.providers.values()) out.push({ id: p.id, kind: p.kind, label: p.label, ...(await p.available()) });
    return out;
  }
}
