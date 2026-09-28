// Provider "codex": la CLI Codex di OpenAI (`codex exec`), con il tuo account ChatGPT (login una volta: `codex login`)
// oppure con una chiave API OpenAI. Lavora sui file della cartella di lavoro come Claude Code.
//   install: npm i -g @openai/codex      login: codex login
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, run } from '../util.js';

export class CodexProvider {
  constructor({ bin } = {}) {
    this.id = 'codex';
    this.kind = 'text';
    this.label = 'ChatGPT / Codex (CLI locale)';
    this.bin = bin || process.env.CODEX_BIN || 'codex';
    this._avail = null;
  }

  async available() {
    if (this._avail) return this._avail;
    const p = which(this.bin);
    if (!p) return (this._avail = { ok: false, reason: `comando "${this.bin}" non trovato. Per usare ChatGPT: npm i -g @openai/codex e poi codex login (oppure CODEX_BIN nel .env)` });
    const v = await run(p, ['--version'], { timeoutMs: 15000 });
    // login: `codex login status` esce con 0 se autenticato (le versioni vecchie non hanno il comando: si prova lo stesso)
    const st = await run(p, ['login', 'status'], { timeoutMs: 15000 });
    if (st.code !== 0 && /not logged in|non.*autenticat|login/i.test(st.stdout + st.stderr) && !process.env.OPENAI_API_KEY) {
      return (this._avail = { ok: false, reason: 'Codex è installato ma non hai fatto il login: lancia `codex login` nel Terminale (account ChatGPT)' });
    }
    return (this._avail = { ok: true, path: p, version: (v.stdout || v.stderr).trim().split('\n')[0] });
  }

  buildArgs({ mode, model, cwd, lastFile, addDirs = [], images = [] }) {
    const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', cwd, '-o', lastFile];
    for (const d of addDirs) args.push('--add-dir', d);
    for (const i of images.slice(0, 8)) args.push('-i', i);
    args.push('--sandbox', mode === 'work' ? 'workspace-write' : 'read-only');
    if (model) args.push('--model', model);
    args.push('-');   // prompt da stdin
    return args;
  }

  run(opts) {
    const { prompt, system, cwd, onEvent = () => {}, timeoutMs = 20 * 60 * 1000, signal } = opts;
    return new Promise(async (resolve) => {
      const av = await this.available();
      if (!av.ok) { resolve({ ok: false, error: av.reason, code: 'PROVIDER_UNAVAILABLE' }); return; }
      const lastFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-')), 'last.txt');
      const t0 = Date.now();
      let child;
      try { child = spawn(av.path, this.buildArgs({ ...opts, lastFile }), { cwd, env: process.env }); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
      let buf = '', stderr = '', failed = null, lastText = '', lastErr = '';
      const texts = [];
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener?.('abort', abort);
      const handle = (m) => {
        const it = m.item || m.msg || {};
        const ty = it.type || it.item_type || '';
        if (m.type === 'item.started' || m.type === 'item.completed') {
          if (ty === 'agent_message' || ty === 'assistant_message') { if (m.type === 'item.completed' && it.text) { lastText = it.text; texts.push(it.text); onEvent({ type: 'text', text: it.text }); } }
          else if (ty === 'reasoning') onEvent({ type: 'thinking' });
          else if (ty === 'command_execution' && m.type === 'item.started') onEvent({ type: 'tool', tool: 'Bash', input: { command: it.command } });
          else if (ty === 'file_change') for (const c of it.changes || []) onEvent({ type: 'tool', tool: 'Edit', input: { file_path: c.path } });
        } else if (m.type === 'turn.failed') failed = m.error?.message || m.message || 'errore di Codex';
        else if (m.type === 'error') lastErr = m.message || lastErr;   // spesso solo avvisi ("Reconnecting…"): contano se poi fallisce
      };
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { handle(JSON.parse(line)); } catch { /* riga non JSON */ } }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { stderr += String(e.message || e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
        let finalText = '';
        try { finalText = fs.readFileSync(lastFile, 'utf8').trim(); } catch { /* niente */ }
        const text = finalText || lastText;
        const ok = code === 0 && !failed;
        resolve({ ok, text, allText: texts.join('\n\n') || text, error: ok ? null : (failed || lastErr || stderr.trim().slice(-1500) || `codex è uscito con codice ${code}`), durationMs: Date.now() - t0 });
      });
      // Codex non ha un "system prompt" separato in exec: le istruzioni di ruolo vanno in testa
      child.stdin.write(system ? `# Istruzioni di ruolo\n${system}\n\n${prompt}` : prompt);
      child.stdin.end();
    });
  }
}
