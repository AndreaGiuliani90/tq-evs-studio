import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProviderRegistry } from '../server/providers/index.js';
import { createStudio } from '../server/app.js';

export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Un piccolo "gioco" finto in un repository git temporaneo
export function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fixture-'));
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  w('index.html', '<script src="vendor/phaser.min.js"></script><script type="module" src="src/main.js"></script>');
  w('src/main.js', "import { VERSION } from './version.js';\nconsole.log(VERSION);\n");
  w('src/version.js', "export const VERSION = '0.1.0';\n");
  w('CHANGELOG.md', '# changelog\n\n## 0.1.0 — inizio\n');
  w('levels/index.json', JSON.stringify({ strings: [], levels: [] }));
  w('docs/memoria/PROJECT_STATE.md', '# PROJECT_STATE\nGioco di prova.\n');
  w('docs/memoria/KNOWN_ISSUES.md', '# KNOWN_ISSUES\n');
  w('docs/memoria/ARCHITECTURE.md', '# ARCHITECTURE\n');
  w('.gitignore', '.studio-data/\n');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.name', 'Utente Test');
  sh(root, 'config', 'user.email', 'utente@test.local');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'primo commit');
  return root;
}

// Provider finto: la funzione `handler(opts)` decide cosa fare (anche scrivere file nella cwd)
export class ScriptedProvider {
  constructor(id, handler) { this.id = id; this.kind = 'text'; this.label = id; this.handler = handler; this.calls = []; }
  async available() { return { ok: true }; }
  async run(opts) {
    this.calls.push(opts);
    opts.onEvent?.({ type: 'text', text: 'ci penso' });
    const r = await this.handler(opts, this.calls.length);
    return { ok: true, costUsd: 0, durationMs: 1, allText: r.text, ...r };
  }
}

export function registryWith(...ps) {
  const reg = new ProviderRegistry();
  // niente provider veri nei test
  reg.providers.delete('claude-code'); reg.providers.delete('anthropic');
  for (const p of ps) reg.register(p);
  reg.autoOrder = [ps[0]?.id || 'mock', 'mock'];
  return reg;
}

// QA harness finto: FAIL se un file del worktree contiene la parola BUG
export function fakeQaRunner(args) {
  const root = args[args.indexOf('--root') + 1];
  let bad = false;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/BUG/.test(fs.readFileSync(p, 'utf8'))) bad = true; } };
  walk(path.join(root, 'src'));
  const rep = { verdict: bad ? 'FAIL' : 'PASS', static: { ok: !bad, checks: [{ name: 'niente BUG nei sorgenti', ok: !bad, detail: bad ? 'trovato BUG' : '' }] }, browser: { available: false, ok: true, note: 'finto' } };
  return Promise.resolve({ code: bad ? 1 : 0, stdout: JSON.stringify(rep), stderr: '' });
}

export async function studioFor(root, providers, extra = {}) {
  return createStudio({ projectRoot: root, dataDir: path.join(root, '.studio-data'), providers, qaRunner: fakeQaRunner, configOverrides: { directorProseReport: false, ...extra } });
}

export async function waitFor(fn, ms = 8000, label = 'condizione') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timeout in attesa di: ${label}`);
}

export const planJSON = (tasks, reply = 'ok') => ({ text: '```json\n' + JSON.stringify({ reply, tasks }) + '\n```' });
