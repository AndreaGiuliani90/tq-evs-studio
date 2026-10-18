// PUBBLICAZIONE ONLINE: le versioni unite nel main del gioco restano sul tuo computer finché non vanno su GitHub;
// da lì il servizio Railway collegato al repository le mette online (deploy automatico ad ogni push sul ramo main).
// Lo Studio mostra cosa c'è online e cosa no, e pubblica quando decidi tu: tutto, o fino a una certa versione.
// Solo avanti veloce (git push senza --force): non si riscrive mai la storia su GitHub.
// Facoltativo, per vedere cosa gira DAVVERO online: nel .env dello Studio
//   STUDIO_BETA_URL=https://….up.railway.app   e la password della beta (BETA_PASSWORD, o BETA_USER/BETA_USERS)
import { now, clip } from './util.js';

const VERSION_RE = /VERSION\s*=\s*'([^']+)'/;

export class DeployDesk {
  constructor({ git, store, events, orch, config = {} }) {
    Object.assign(this, { git, store, events, orch, config });
    this.versionCache = new Map();
    this.running = null;
  }
  get remote() { return this.config.deployRemote || 'origin'; }
  get branch() { return this.config.deployBranch || 'main'; }
  get ledger() { return (this.store.data.deploys ??= []); }

  async g(args, opts = {}) { return this.git.git(args, this.git.root, { allowFail: true, ...opts }); }
  async versionAt(ref) {
    if (this.versionCache.has(ref)) return this.versionCache.get(ref);
    const r = await this.g(['show', `${ref}:src/version.js`]);
    const v = r.code === 0 ? (r.stdout.match(VERSION_RE) || [])[1] || null : null;
    if (/^[0-9a-f]{40}$/.test(ref)) this.versionCache.set(ref, v);
    return v;
  }

  // la versione che gira davvero sul server (se lo Studio sa dov'è e ha la password della beta)
  async liveVersion() {
    const url = process.env.STUDIO_BETA_URL;
    if (!url) return null;
    const users = String(process.env.BETA_USERS || '').split(',').map((p) => p.split(':')).filter((p) => p.length === 2);
    const user = process.env.BETA_USER || users[0]?.[0] || 'studio';
    const pass = process.env.BETA_PASSWORD || users[0]?.[1] || '';
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/src/version.js?ts=${Date.now()}`, { headers: pass ? { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { url, error: r.status === 401 ? 'password della beta non accettata (BETA_PASSWORD nel .env dello Studio)' : `il server risponde ${r.status}` };
      return { url, version: ((await r.text()).match(VERSION_RE) || [])[1] || null };
    } catch (e) { return { url, error: `non raggiungibile (${clip(e.message, 80)})` }; }
  }

  async status({ fetch = false } = {}) {
    const R = `${this.remote}/${this.branch}`;
    let fetchError = null;
    if (fetch) {
      const f = await this.g(['fetch', '--quiet', this.remote, this.branch], { timeoutMs: 60000 });
      if (f.code !== 0) fetchError = clip((f.stderr || f.stdout).trim(), 300) || 'git fetch non riuscito';
    }
    const url = (await this.g(['remote', 'get-url', this.remote])).stdout.trim() || null;
    const local = (await this.g(['rev-parse', this.branch])).stdout.trim() || null;
    const online = (await this.g(['rev-parse', '--verify', '--quiet', R])).stdout.trim() || null;
    if (!url) return { ok: false, error: `il gioco non ha un repository remoto «${this.remote}»: aggiungilo (git remote add ${this.remote} …) per pubblicare`, ledger: this.ledger.slice(-20).reverse() };
    if (!local) return { ok: false, error: `nel gioco non trovo il ramo «${this.branch}»`, ledger: this.ledger.slice(-20).reverse() };
    const ahead = online ? Number((await this.g(['rev-list', '--count', `${R}..${this.branch}`])).stdout.trim() || 0) : null;
    const behind = online ? Number((await this.g(['rev-list', '--count', `${this.branch}..${R}`])).stdout.trim() || 0) : null;
    // le tappe da pubblicare: i commit del main (prima linea: unioni dello Studio e commit diretti), con la versione
    const log = online ? (await this.g(['log', '--first-parent', '--format=%H%x09%h%x09%cI%x09%s', '-n', '120', `${R}..${this.branch}`])).stdout.split('\n').filter(Boolean) : [];
    const pending = [];
    for (const l of log) {
      const [hash, short, at, subject] = l.split('\t');
      pending.push({ hash, short, at, subject: clip(subject, 140), version: await this.versionAt(hash), request: (subject.match(/\bR-\d{4}\b/) || [])[0] || null });
    }
    // una riga per versione: la più recente di ogni numero di versione è il punto da cui pubblicare
    const seen = new Set();
    for (const p of pending) { p.versionHead = !!p.version && !seen.has(p.version); if (p.version) seen.add(p.version); }
    return {
      ok: true, remote: this.remote, branch: this.branch, url: url.replace(/\/\/[^@/]*@/, '//'), fetchError,
      local: { commit: local?.slice(0, 7), version: local ? await this.versionAt(local) : null },
      online: online ? { commit: online.slice(0, 7), version: await this.versionAt(online) } : null,
      ahead, behind, pending, running: this.running, live: await this.liveVersion(),
      ledger: this.ledger.slice(-20).reverse(),
    };
  }

  // pubblica fino a `commit` (di default tutto il main): git push <remote> <commit>:<branch>, solo avanti veloce
  async publish({ commit } = {}) {
    if (this.running) throw new Error(`c'è già una pubblicazione in corso (${this.running.version || this.running.commit})`);
    const R = `${this.remote}/${this.branch}`;
    await this.g(['fetch', '--quiet', this.remote, this.branch], { timeoutMs: 60000 });
    const target = (await this.g(['rev-parse', '--verify', '--quiet', `${commit || this.branch}^{commit}`])).stdout.trim();
    if (!target) throw new Error('versione sconosciuta');
    if ((await this.g(['merge-base', '--is-ancestor', target, this.branch])).code !== 0) throw new Error('quel punto non fa parte del main del gioco');
    const online = (await this.g(['rev-parse', '--verify', '--quiet', R])).stdout.trim();
    if (online && (await this.g(['merge-base', '--is-ancestor', online, target])).code !== 0) throw new Error(`su GitHub c'è qualcosa che nel main del gioco non c'è (forse un push da un altro computer): non sovrascrivo. Allinea il main (git pull) e riprova`);
    if (online === target) throw new Error('questa versione è già online');
    const version = await this.versionAt(target);
    const n = online ? Number((await this.g(['rev-list', '--count', `${online}..${target}`])).stdout.trim() || 0) : null;
    this.running = { commit: target.slice(0, 7), version, startedAt: now(), commits: n };
    this.events.emit('deploy.updated', { running: this.running });
    this.orch.chat('system', `Pubblico online la versione ${version || target.slice(0, 7)}${n ? ` (${n} commit)` : ''}: la mando su GitHub, poi Railway la mette in linea da solo.`);
    // in sottofondo: un primo push con tante immagini può durare minuti
    (async () => {
      const r = await this.git.locked(this.git.root, () => this.g(['push', '--porcelain', this.remote, `${target}:refs/heads/${this.branch}`], { timeoutMs: 20 * 60 * 1000 }));
      const ok = r.code === 0;
      const entry = { at: now(), version, commit: target.slice(0, 7), from: online ? online.slice(0, 7) : null, commits: n, ok, error: ok ? null : clip((r.stderr || r.stdout).trim(), 400) };
      this.ledger.push(entry); if (this.ledger.length > 200) this.ledger.splice(0, this.ledger.length - 200);
      this.running = null;
      this.store.save();
      this.events.emit('deploy.updated', { entry });
      this.orch.chat('system', ok
        ? `Versione ${version || entry.commit} pubblicata su GitHub. Railway la mette online in qualche minuto (lo vedi in «🚀 Online»).`
        : `Pubblicazione non riuscita: ${entry.error}`);
    })().catch((e) => { this.running = null; this.events.emit('deploy.updated', { error: e.message }); });
    return { started: true, version, commit: target.slice(0, 7), commits: n };
  }
}
