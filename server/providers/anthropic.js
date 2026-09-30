// Provider "anthropic": API Messages di Anthropic con una piccola serie di strumenti sui file
// (leggere, cercare, scrivere) confinati nella cartella di lavoro. Serve ANTHROPIC_API_KEY in .env dello Studio.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.anthropic.com/v1/messages';

function safe(cwd, p) {
  const f = path.resolve(cwd, p || '.');
  if (f !== cwd && !f.startsWith(cwd + path.sep)) throw new Error('percorso fuori dalla cartella di lavoro');
  if (f.split(path.sep).includes('.git')) throw new Error('la cartella .git non si tocca');
  return f;
}

function listFiles(dir, base, out, depth) {
  if (depth > 6 || out.length > 800) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.studio') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out, depth + 1); else out.push(path.relative(base, p));
  }
}

export const FILE_TOOLS = {
  list_files: {
    schema: { name: 'list_files', description: 'Elenca i file (ricorsivo) sotto una cartella relativa.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    run: (cwd, i) => { const out = []; listFiles(safe(cwd, i.path), cwd, out, 0); return out.join('\n'); },
  },
  read_file: {
    schema: { name: 'read_file', description: 'Legge un file di testo (percorso relativo).', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    run: (cwd, i) => { const t = fs.readFileSync(safe(cwd, i.path), 'utf8'); return t.length > 60000 ? t.slice(0, 60000) + '\n…[troncato]' : t; },
  },
  search: {
    schema: { name: 'search', description: 'Cerca una regex nei file .js/.json/.md; restituisce file:riga: testo.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    run: (cwd, i) => {
      const re = new RegExp(i.pattern, 'i'); const files = []; listFiles(safe(cwd, i.path), cwd, files, 0);
      const hits = [];
      for (const f of files.filter((x) => /\.(js|json|md|html|py)$/.test(x))) {
        const lines = fs.readFileSync(path.join(cwd, f), 'utf8').split('\n');
        lines.forEach((l, n) => { if (hits.length < 200 && re.test(l)) hits.push(`${f}:${n + 1}: ${l.slice(0, 200)}`); });
      }
      return hits.join('\n') || '(nessun risultato)';
    },
  },
  write_file: {
    write: true,
    schema: { name: 'write_file', description: 'Crea o sovrascrive un file di testo.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    run: (cwd, i) => { const f = safe(cwd, i.path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, i.content); return 'ok'; },
  },
  replace_in_file: {
    write: true,
    schema: { name: 'replace_in_file', description: 'Sostituisce UNA occorrenza esatta di old con new in un file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
    run: (cwd, i) => {
      const f = safe(cwd, i.path); const t = fs.readFileSync(f, 'utf8');
      const n = t.split(i.old).length - 1;
      if (n !== 1) throw new Error(`il testo da sostituire compare ${n} volte (deve essere 1)`);
      fs.writeFileSync(f, t.replace(i.old, () => i.new)); return 'ok';
    },
  },
};

export class AnthropicProvider {
  constructor({ apiKey, model, fetchImpl } = {}) {
    this.id = 'anthropic';
    this.kind = 'text';
    this.label = 'Anthropic API';
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async available() {
    return this.apiKey ? { ok: true, model: this.model } : { ok: false, reason: 'ANTHROPIC_API_KEY non impostata in .env dello Studio' };
  }

  async run({ system, prompt, cwd, mode, model, onEvent = () => {}, maxIterations = 40, extraTools = {} }) {
    if (!this.apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY non impostata', code: 'PROVIDER_UNAVAILABLE' };
    const t0 = Date.now();
    const tools = Object.fromEntries(Object.entries({ ...FILE_TOOLS, ...extraTools }).filter(([, t]) => mode === 'work' || !t.write));
    const messages = [{ role: 'user', content: prompt }];
    const texts = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (let it = 0; it < maxIterations; it++) {
      let res;
      try {
        const r = await this.fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: model || this.model, max_tokens: 8000, system, messages, tools: cwd ? Object.values(tools).map((t) => t.schema) : undefined }),
        });
        res = await r.json();
        usage.input_tokens += res?.usage?.input_tokens || 0; usage.output_tokens += res?.usage?.output_tokens || 0;
        if (!r.ok) return { ok: false, error: `API ${r.status}: ${res?.error?.message || JSON.stringify(res).slice(0, 300)}`, durationMs: Date.now() - t0 };
      } catch (e) { return { ok: false, error: `rete: ${e.message}`, durationMs: Date.now() - t0 }; }
      messages.push({ role: 'assistant', content: res.content });
      const uses = [];
      for (const c of res.content || []) {
        if (c.type === 'text') { texts.push(c.text); onEvent({ type: 'text', text: c.text }); }
        if (c.type === 'tool_use') uses.push(c);
      }
      if (res.stop_reason !== 'tool_use' || !uses.length) return { ok: true, usage, model: model || this.model, text: texts[texts.length - 1] || '', allText: texts.join('\n\n'), durationMs: Date.now() - t0 };
      const results = [];
      for (const u of uses) {
        onEvent({ type: 'tool', tool: u.name, input: u.input });
        let content, is_error = false;
        try { const t = tools[u.name]; if (!t) throw new Error('strumento non disponibile'); content = String(await t.run(cwd, u.input || {})); }
        catch (e) { content = `ERRORE: ${e.message}`; is_error = true; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content, is_error });
      }
      messages.push({ role: 'user', content: results });
    }
    return { ok: false, usage, error: 'troppi passaggi (limite iterazioni)', text: texts.join('\n\n'), durationMs: Date.now() - t0 };
  }
}
