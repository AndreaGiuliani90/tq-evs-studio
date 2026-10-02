// IL NOTAIO DELLE UNIONI: si occupa che gli aggiornamenti entrino nel gioco in ordine e che non se ne perda nessuno.
//
//   - coda: le unioni approvate entrano UNA alla volta, nell'ordine in cui le richieste sono nate (se ne approvi
//     più d'una insieme non importa l'ordine dei clic);
//   - prova generale: ogni unione si prova prima in una copia a parte del gioco; se ci sono conflitti la
//     richiesta torna allo sviluppo per allinearsi (e al QA), il tuo gioco non viene toccato;
//   - niente perso: prima di unire controlla, riga per riga, che nel risultato ci siano sia le novità della
//     richiesta sia tutte quelle entrate nel gioco nel frattempo (le soluzioni dei conflitti sono il punto
//     debole); versione (src/version.js) mai all'indietro e CHANGELOG con tutte le voci;
//   - annullare un'unione: si prova prima; se toglierla romperebbe aggiornamenti arrivati dopo, si ferma e lo dice;
//   - registro: ogni unione con numero, data, commit, versione e esito dei controlli.
// Lavora solo con git: nessuna AI, nessun costo.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, now } from './util.js';

const VERSION_RE = /VERSION\s*=\s*['"](\d+)\.(\d+)\.(\d+)['"]/;
const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const parseVer = (txt) => { const m = String(txt || '').match(VERSION_RE); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const verStr = (v) => (v ? v.join('.') : null);

export class ReleaseDesk {
  constructor({ git, store, events, dataDir }) {
    Object.assign(this, { git, store, events });
    this.scratch = path.join(dataDir, 'worktrees', '_notaio');
    this.queueRun = Promise.resolve();
  }
  get ledger() { return (this.store.data.releases ??= { n: 0, entries: [], queue: [] }); }

  // righe aggiunte da base a ref (per file), escluse quelle vuote/troppo corte e la riga della versione
  async addedLines(base, ref, cwd) {
    const d = await this.git.git(['diff', '-U0', '--no-color', '--no-renames', `${base}`, `${ref}`], cwd, { allowFail: true });
    const out = {}; let file = null;
    for (const line of d.stdout.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
      if (!file || !line.startsWith('+') || line.startsWith('+++')) continue;
      const t = line.slice(1).trim();
      if (t.length < 4 || VERSION_RE.test(t) || /^[{}()[\];,]+$/.test(t)) continue;
      (out[file] ??= new Set()).add(t);
    }
    return out;
  }

  // controllo "niente perso" su una copia di lavoro che contiene il risultato dell'unione
  async lostCheck({ cwd, base, sides }) {
    const missing = [];
    for (const { label, ref } of sides) {
      const added = await this.addedLines(base, ref, cwd);
      for (const [file, lines] of Object.entries(added)) {
        const f = path.join(cwd, file);
        if (!fs.existsSync(f)) { missing.push({ side: label, file, line: '(file sparito)' }); continue; }
        const have = new Set(fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()));
        for (const l of lines) if (!have.has(l)) missing.push({ side: label, file, line: l.slice(0, 140) });
      }
    }
    return missing;
  }

  async versionAt(ref, cwd) { const r = await this.git.git(['show', `${ref}:src/version.js`], cwd, { allowFail: true }); return r.code === 0 ? parseVer(r.stdout) : null; }

  async withScratch(fn) {
    return this.git.locked(this.scratch, async () => {
      ensureDir(path.dirname(this.scratch));
      await this.git.git(['worktree', 'remove', '--force', this.scratch], this.git.root, { allowFail: true });
      await this.git.git(['worktree', 'prune'], this.git.root, { allowFail: true });
      await this.git.git(['worktree', 'add', '--detach', this.scratch, 'HEAD'], this.git.root);
      try { return await fn(this.scratch); }
      finally {
        await this.git.git(['merge', '--abort'], this.scratch, { allowFail: true });
        await this.git.git(['worktree', 'remove', '--force', this.scratch], this.git.root, { allowFail: true });
      }
    });
  }

  // prova generale dell'unione: conflitti? righe perse? versione?
  async preflight(req) {
    return this.withScratch(async (cwd) => {
      const main = (await this.git.git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
      const tip = (await this.git.git(['rev-parse', req.branch], cwd)).stdout.trim();
      const base = req.baseCommit || (await this.git.git(['merge-base', main, tip], cwd)).stdout.trim();
      const m = await this.git.git(['merge', '--no-ff', '--no-commit', tip], cwd, { allowFail: true });
      const conflicted = (await this.git.git(['diff', '--name-only', '--diff-filter=U'], cwd, { allowFail: true })).stdout.split('\n').filter(Boolean);
      if (m.code !== 0 || conflicted.length) return { ok: false, conflict: true, files: conflicted, main, tip };
      const missing = await this.lostCheck({ cwd, base, sides: [{ label: `già nel gioco`, ref: main }, { label: req.id, ref: tip }, ...(req.ownTips || []).map((ref) => ({ label: `${req.id} prima dell'allineamento`, ref }))] });
      const vMain = await this.versionAt(main, cwd), vTip = await this.versionAt(tip, cwd);
      const vRes = fs.existsSync(path.join(cwd, 'src/version.js')) ? parseVer(fs.readFileSync(path.join(cwd, 'src/version.js'), 'utf8')) : null;
      const versionIssue = vRes && [vMain, vTip].some((v) => v && cmpVer(vRes, v) < 0) ? `la versione risultante ${verStr(vRes)} è più bassa di ${verStr([vMain, vTip].filter(Boolean).sort(cmpVer).at(-1))}` : null;
      return { ok: !missing.length && !versionIssue, conflict: false, missing, versionIssue, version: verStr(vRes), main, tip };
    });
  }

  async revertPreflight(req) {
    return this.withScratch(async (cwd) => {
      const r = await this.git.git(['revert', '-m', '1', '--no-commit', req.mergeCommit], cwd, { allowFail: true });
      const conflicted = (await this.git.git(['diff', '--name-only', '--diff-filter=U'], cwd, { allowFail: true })).stdout.split('\n').filter(Boolean);
      await this.git.git(['revert', '--abort'], cwd, { allowFail: true });
      return { ok: r.code === 0 && !conflicted.length, files: conflicted };
    });
  }

  record(req, info) {
    const L = this.ledger;
    const e = { n: ++L.n, requestId: req.id, title: String(req.text || '').split('\n')[0].slice(0, 100), at: now(), mergeCommit: info.mergeCommit || null, version: info.version || null, files: info.files || [], checks: info.checks || {}, kind: info.kind || 'unione' };
    L.entries.push(e);
    this.store.save();
    this.events?.emit('releases.updated', { releases: this.summary() });
    return e;
  }
  summary() { const L = this.ledger; return { entries: [...L.entries].reverse().slice(0, 60), queue: L.queue }; }
}
