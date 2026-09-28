// Integrazione Git "prudente".
// Regole:
//  - lo Studio NON tocca mai la cartella di lavoro dell'utente durante i task: ogni richiesta lavora in un
//    git worktree separato (.studio/worktrees/<richiesta>) su un branch suo (studio/<richiesta>-<slug>);
//  - ogni task che cambia file produce un commit attribuito all'agente (autore + trailer Studio-Agent);
//  - l'unione nel branch principale avviene solo su comando e solo se la cartella dell'utente è pulita;
//  - ogni unione è un merge --no-ff: si annulla con un solo revert.
import fs from 'node:fs';
import path from 'node:path';
import { run, slug, ensureDir } from './util.js';

export class GitService {
  constructor(root, { worktreesDir, events } = {}) {
    this.root = root;
    this.worktreesDir = worktreesDir || path.join(root, '.studio', 'worktrees');
    this.events = events;
  }

  // Le operazioni che scrivono sul repository (commit, checkout, merge…) sulla stessa cartella vanno in fila:
  // due commit contemporanei nello stesso worktree litigherebbero per .git/index.lock
  locked(cwd, fn) {
    this.locks ??= new Map();
    const key = path.resolve(cwd);
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  async git(args, cwd = this.root, opts = {}) {
    const r = await run('git', args, { cwd, timeoutMs: opts.timeoutMs || 120000 });
    if (r.code !== 0 && !opts.allowFail) {
      const e = new Error(`git ${args.join(' ')} → ${r.stderr.trim() || r.stdout.trim()}`);
      e.result = r; throw e;
    }
    return r;
  }

  async available() {
    const r = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.root });
    if (r.code !== 0 || r.stdout.trim() !== 'true') return false;
    const h = await run('git', ['rev-parse', 'HEAD'], { cwd: this.root });
    return h.code === 0;
  }

  async status(cwd = this.root) {
    const [b, h, s] = await Promise.all([
      this.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { allowFail: true }),
      this.git(['rev-parse', '--short', 'HEAD'], cwd, { allowFail: true }),
      this.git(['status', '--porcelain'], cwd, { allowFail: true }),
    ]);
    const lines = s.stdout.split('\n').filter(Boolean);
    const tracked = lines.filter((l) => !l.startsWith('??'));
    return { branch: b.stdout.trim(), head: h.stdout.trim(), changes: lines, trackedChanges: tracked, clean: lines.length === 0, trackedClean: tracked.length === 0 };
  }

  async ensureWorktree(req) {
    if (req.worktree && fs.existsSync(req.worktree)) return req;
    const st = await this.status();
    const baseCommit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const branch = req.branch || `studio/${req.id.toLowerCase()}-${slug(req.text, 28)}`;
    const wt = path.join(this.worktreesDir, req.id);
    ensureDir(this.worktreesDir);
    const exists = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], this.root, { allowFail: true })).code === 0;
    await this.git(['worktree', 'prune'], this.root, { allowFail: true });
    if (exists) {
      // il branch è già aperto in un'altra copia di lavoro (es. la vecchia cartella dati): si riusa quella
      const list = (await this.git(['worktree', 'list', '--porcelain'], this.root, { allowFail: true })).stdout.split('\n\n');
      const other = list.map((b) => ({ path: (b.match(/^worktree (.+)$/m) || [])[1], br: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] })).find((w) => w.br === branch && w.path && fs.existsSync(w.path));
      if (other) { Object.assign(req, { branch, worktree: other.path }); return req; }
      await this.git(['worktree', 'add', wt, branch]);
    }
    else await this.git(['worktree', 'add', '-b', branch, wt, baseCommit]);
    Object.assign(req, { branch, worktree: wt });
    if (!req.baseCommit) Object.assign(req, { baseBranch: st.branch, baseCommit, baseDirty: !st.trackedClean });
    return req;
  }

  async changedFiles(cwd) {
    const s = await this.git(['status', '--porcelain', '-uall'], cwd, { allowFail: true });
    return s.stdout.split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() }));
  }

  commitAll(cwd, info) { return this.locked(cwd, () => this._commitAll(cwd, info)); }

  async _commitAll(cwd, { agent, task, request, summary }) {
    const files = await this.changedFiles(cwd);
    if (!files.length) return null;
    await this.git(['add', '-A'], cwd);
    const who = `${agent.name} (Studio)`;
    const email = `${agent.id}@studio.local`;
    const msg = [
      `[${agent.id}] ${task.title}`.slice(0, 120),
      '',
      (summary || '').slice(0, 2000),
      '',
      `Studio-Agent: ${agent.id}`,
      `Studio-Agent-Name: ${agent.name}`,
      `Studio-Task: ${task.id}`,
      `Studio-Request: ${request.id}`,
    ].join('\n');
    // autore = agente; committer = utente se configurato, altrimenti lo Studio
    const hasUser = (await this.git(['config', 'user.name'], cwd, { allowFail: true })).stdout.trim();
    const cfg = hasUser ? [] : ['-c', 'user.name=Game Studio', '-c', 'user.email=studio@studio.local'];
    await this.git([...cfg, 'commit', '--no-verify', '-q', '--author', `${who} <${email}>`, '-m', msg], cwd);
    const hash = (await this.git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
    this.events?.emit('git.commit', { agentId: agent.id, taskId: task.id, requestId: request.id, commit: hash, files: files.map((f) => f.file) });
    return { hash, short: hash.slice(0, 7), files: files.map((f) => f.file) };
  }

  // Annulla modifiche non committate (usato quando chi non dovrebbe scrivere — es. QA — ha toccato file)
  revertUncommitted(cwd) { return this.locked(cwd, () => this._revertUncommitted(cwd)); }

  async _revertUncommitted(cwd) {
    const files = await this.changedFiles(cwd);
    if (!files.length) return [];
    await this.git(['checkout', '--', '.'], cwd, { allowFail: true });
    await this.git(['clean', '-fd'], cwd, { allowFail: true });
    return files.map((f) => f.file);
  }

  async diffSummary(cwd, base) {
    const [stat, names, log] = await Promise.all([
      this.git(['diff', '--stat', `${base}..HEAD`], cwd, { allowFail: true }),
      this.git(['diff', '--name-status', `${base}..HEAD`], cwd, { allowFail: true }),
      this.git(['log', '--format=%H%x09%an%x09%s', `${base}..HEAD`], cwd, { allowFail: true }),
    ]);
    return {
      stat: stat.stdout.trim(),
      files: names.stdout.split('\n').filter(Boolean).map((l) => { const [code, ...f] = l.split('\t'); return { code, file: f.pop() }; }),
      commits: log.stdout.split('\n').filter(Boolean).map((l) => { const [hash, author, subject] = l.split('\t'); return { hash, short: hash.slice(0, 7), author, subject }; }),
    };
  }

  async diffText(cwd, base, max = 12000) {
    const d = await this.git(['diff', `${base}..HEAD`], cwd, { allowFail: true });
    const t = d.stdout;
    return t.length > max ? t.slice(0, max) + `\n…[diff troncato, ${t.length} caratteri]` : t;
  }

  // Unisce il branch della richiesta nel branch dell'utente (solo se la sua cartella è pulita)
  merge(req) { return this.locked(this.root, () => this._merge(req)); }

  async _merge(req) {
    if (!req.branch) throw new Error('questa richiesta non ha un branch');
    const st = await this.status();
    if (!st.trackedClean) throw new Error(`La cartella del gioco ha modifiche non salvate (${st.trackedChanges.length} file). Fai commit o metti da parte le tue modifiche, poi riprova: lo Studio non sovrascrive mai il tuo lavoro.`);
    if (req.baseBranch && st.branch !== req.baseBranch) throw new Error(`Sei sul branch "${st.branch}", ma la richiesta è partita da "${req.baseBranch}". Torna su "${req.baseBranch}" (git switch ${req.baseBranch}) e riprova.`);
    const r = await this.git(['merge', '--no-ff', '--no-edit', '-m', `Studio: unisce ${req.id} — ${String(req.text).slice(0, 60)}\n\nStudio-Request: ${req.id}`, req.branch], this.root, { allowFail: true });
    if (r.code !== 0) {
      await this.git(['merge', '--abort'], this.root, { allowFail: true });
      throw new Error(`Unione non riuscita (conflitto?). Nulla è stato cambiato. Dettagli: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    const mergeCommit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    this.events?.emit('git.merge', { requestId: req.id, branch: req.branch, commit: mergeCommit });
    return { mergeCommit };
  }

  async revertMerge(req) {
    if (!req.mergeCommit) throw new Error('nessuna unione da annullare');
    const st = await this.status();
    if (!st.trackedClean) throw new Error('La cartella del gioco ha modifiche non salvate: salvale prima di annullare.');
    await this.git(['revert', '-m', '1', '--no-edit', req.mergeCommit]);
    return { revertCommit: (await this.git(['rev-parse', 'HEAD'])).stdout.trim() };
  }

  async removeWorktree(req, { deleteBranch = false } = {}) {
    if (req.worktree && fs.existsSync(req.worktree)) await this.git(['worktree', 'remove', '--force', req.worktree], this.root, { allowFail: true });
    await this.git(['worktree', 'prune'], this.root, { allowFail: true });
    if (deleteBranch && req.branch) await this.git(['branch', '-D', req.branch], this.root, { allowFail: true });
    this.events?.emit('git.discard', { requestId: req.id, branch: req.branch, deleted: deleteBranch });
  }

  async recentCommits(n = 10, cwd = this.root) {
    const r = await this.git(['log', `-${n}`, '--format=%h%x09%an%x09%ar%x09%s'], cwd, { allowFail: true });
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [short, author, when, subject] = l.split('\t'); return { short, author, when, subject }; });
  }
}
