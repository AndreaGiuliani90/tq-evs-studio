// Provider "gemini": la CLI Gemini di Google (`gemini -p`), col tuo account Google (primo avvio: `gemini`, poi login)
// oppure con GEMINI_API_KEY. Lavora sui file della cartella di lavoro come Claude Code e Codex.
//   install: npm i -g @google/gemini-cli
import { spawn } from 'node:child_process';
import { which, run, extractJSON } from '../util.js';

export class GeminiCliProvider {
  constructor({ bin } = {}) {
    this.id = 'gemini';
    this.kind = 'text';
    this.label = 'Google Gemini (CLI locale)';
    this.bin = bin || process.env.GEMINI_BIN || 'gemini';
    this._avail = null;
  }

  async available() {
    if (this._avail) return this._avail;
    const p = which(this.bin);
    if (!p) return (this._avail = { ok: false, reason: `comando "${this.bin}" non trovato. Per usare Gemini: npm i -g @google/gemini-cli, poi lancia una volta \`gemini\` e fai il login (oppure GEMINI_API_KEY nel .env)` });
    const v = await run(p, ['--version'], { timeoutMs: 15000 });
    return (this._avail = { ok: true, path: p, version: `gemini-cli ${(v.stdout || v.stderr).trim().split('\n').pop()}` });
  }

  buildArgs({ mode, model, addDirs = [] }) {
    const args = ['-p', 'Esegui le istruzioni ricevute qui sopra.', '--output-format', 'json', '--skip-trust', '--approval-mode', mode === 'work' ? 'auto_edit' : 'plan'];
    if (model) args.push('-m', model);
    for (const d of addDirs) args.push('--include-directories', d);
    return args;
  }

  run(opts) {
    const { prompt, system, cwd, onEvent = () => {}, timeoutMs = 20 * 60 * 1000, signal } = opts;
    return new Promise(async (resolve) => {
      const av = await this.available();
      if (!av.ok) { resolve({ ok: false, error: av.reason, code: 'PROVIDER_UNAVAILABLE' }); return; }
      const t0 = Date.now();
      let child;
      try { child = spawn(av.path, this.buildArgs(opts), { cwd, env: process.env }); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
      let out = '', err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener?.('abort', abort);
      onEvent({ type: 'thinking' });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { err += String(e.message || e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
        // --output-format json: { response, stats, error }
        let j = null; try { j = JSON.parse(out); } catch { j = extractJSON(out); }
        const text = j?.response ?? out.trim();
        const edited = Object.keys(j?.stats?.files || {}).length ? j.stats.files : null;
        if (edited) for (const f of Object.keys(edited)) onEvent({ type: 'tool', tool: 'Edit', input: { file_path: f } });
        if (text) onEvent({ type: 'text', text: String(text).slice(0, 300) });
        const ok = code === 0 && !j?.error;
        resolve({ ok, text, allText: text, error: ok ? null : (j?.error?.message || err.trim().slice(-1500) || `gemini è uscito con codice ${code}`), durationMs: Date.now() - t0 });
      });
      child.stdin.write(system ? `# Istruzioni di ruolo\n${system}\n\n${prompt}` : prompt);
      child.stdin.end();
    });
  }
}
