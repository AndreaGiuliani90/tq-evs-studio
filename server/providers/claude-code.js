// Provider "claude-code": usa la CLI di Claude Code installata sul Mac (`claude -p`), con l'account già
// autenticato dall'utente. Nessuna chiave API da configurare. L'agente lavora davvero sui file della cartella
// (cwd = worktree della richiesta), con permessi limitati per ruolo.
import { spawn } from 'node:child_process';
import { which, run } from '../util.js';

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
const SAFE_BASH = ['Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(python3 tools/:*)', 'Bash(python3 -c:*)', 'Bash(wc:*)', 'Bash(head:*)', 'Bash(tail:*)'];
const FORBIDDEN_BASH = ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(git merge:*)', 'Bash(git worktree:*)', 'Bash(git branch:*)', 'Bash(git stash:*)', 'Bash(git clean:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)'];

export class ClaudeCodeProvider {
  constructor({ bin } = {}) {
    this.id = 'claude-code';
    this.kind = 'text';
    this.label = 'Claude Code (CLI locale)';
    this.bin = bin || process.env.CLAUDE_CODE_BIN || 'claude';
    this._avail = null;
  }

  async available() {
    if (this._avail) return this._avail;
    const p = which(this.bin);
    if (!p) return (this._avail = { ok: false, reason: `comando "${this.bin}" non trovato. Installa Claude Code (https://docs.claude.com/claude-code) oppure imposta CLAUDE_CODE_BIN in .env dello Studio` });
    const v = await run(p, ['--version'], { timeoutMs: 15000 });
    return (this._avail = { ok: true, path: p, version: (v.stdout || v.stderr).trim().split('\n')[0] });
  }

  buildArgs({ system, model, mode, extraAllowedTools = [], maxTurns }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (system) args.push('--append-system-prompt', system);
    if (model) args.push('--model', model);
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (mode === 'work') {
      args.push('--permission-mode', 'acceptEdits');
      args.push('--allowedTools', [...READ_TOOLS, ...WRITE_TOOLS, ...SAFE_BASH, ...extraAllowedTools].join(','));
      args.push('--disallowedTools', FORBIDDEN_BASH.join(','));
    } else {
      // plan / readonly / test: legge ma non scrive
      args.push('--permission-mode', 'default');
      args.push('--allowedTools', [...READ_TOOLS, ...(mode === 'plan' ? [] : ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)']), ...extraAllowedTools].join(','));
      args.push('--disallowedTools', [...WRITE_TOOLS, ...FORBIDDEN_BASH].join(','));
    }
    return args;
  }

  run(opts) {
    const { prompt, cwd, onEvent = () => {}, timeoutMs = 20 * 60 * 1000, signal } = opts;
    return new Promise(async (resolve) => {
      const av = await this.available();
      if (!av.ok) { resolve({ ok: false, error: av.reason, code: 'PROVIDER_UNAVAILABLE' }); return; }
      const args = this.buildArgs(opts);
      const env = { ...process.env };
      delete env.CLAUDECODE;   // evita il rifiuto "sessione annidata" se lo Studio è lanciato da Claude Code
      const t0 = Date.now();
      let child;
      try { child = spawn(av.path, args, { cwd, env }); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
      let buf = '', stderr = '', resultMsg = null, lastText = '';
      const texts = [];
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener?.('abort', abort);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'assistant' && m.message?.content) {
            for (const c of m.message.content) {
              if (c.type === 'text' && c.text) { lastText = c.text; texts.push(c.text); onEvent({ type: 'text', text: c.text }); }
              else if (c.type === 'thinking') onEvent({ type: 'thinking' });
              else if (c.type === 'tool_use') onEvent({ type: 'tool', tool: c.name, input: c.input });
            }
          } else if (m.type === 'result') resultMsg = m;
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { stderr += String(e.message || e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
        const text = resultMsg?.result ?? lastText ?? '';
        const ok = code === 0 && resultMsg && !resultMsg.is_error;
        resolve({
          ok: !!ok,
          text: text || texts.join('\n\n'),
          allText: texts.join('\n\n'),
          error: ok ? null : (resultMsg?.result || stderr.trim().slice(-1500) || `claude è uscito con codice ${code}`),
          costUsd: resultMsg?.total_cost_usd ?? null,
          durationMs: Date.now() - t0,
          turns: resultMsg?.num_turns ?? null,
        });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
