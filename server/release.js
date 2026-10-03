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
// Lavora solo con git: nessuna AI, nessun costo. I file di lavoro degli agenti (.shots/ ecc.) non contano e non entrano nel gioco.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, now } from './util.js';

const VERSION_RE = /VERSION\s*=\s*['"](\d+)\.(\d+)\.(\d+)['"]/;
const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const parseVer = (txt) => { const m = String(txt || '').match(VERSION_RE); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const verStr = (v) => (v ? v.join('.') : null);
// confronto delle righe: senza numeri di versione; somiglianza fra righe lunghe (parole in comune)
const SIMILAR_MIN = 60, SIMILAR_RATIO = 0.8;
const normLine = (l) => l.replace(/\bv?\d+\.\d+\.\d+\b/g, '#');
const words = (l) => new Set(normLine(l).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1));
const COMMENT_RE = /^(\/\/|\/\*|\*|#(?![#\w])|<!--)/;
const codeOnly = (l) => l.replace(/\s+\/\/(?!.*['"`]).*$/, '').trim();   // senza il commento in fondo alla riga
const contained = (a, b) => { if (!a.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / a.size; };
const similarity = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };

// file di lavoro degli agenti (screenshot di prova, script usa e getta): non sono parte del gioco
const JUNK_RE = /(^|\/)\.(shots|studio-scratch|tmp)\/|(^|\/)\.bbox\.py$|(^|\/)\.index_head\.json$/;
export const isJunk = (f) => JUNK_RE.test(String(f || ''));
const MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/;
// nomi di file nell'output di git diff: "b/x y.json\t" (con spazi) o "\"b/\303\250.json\"" (caratteri speciali)
function diffName(raw) {
  let n = raw.replace(/\t$/, '');
  if (n.startsWith('"')) { try { n = Buffer.from(JSON.parse(n).split('').map((c) => c.charCodeAt(0))).toString('utf8'); } catch { n = n.slice(1, -1); } }
  return n.startsWith('b/') ? n.slice(2) : null;
}

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
      if (line.startsWith('+++ ')) { file = diffName(line.slice(4)); if (file && isJunk(file)) file = null; continue; }
      if (!file || !line.startsWith('+') || line.startsWith('+++')) continue;
      const t = line.slice(1).trim();
      if (t.length < 4 || VERSION_RE.test(t) || MARKER_RE.test(t) || /^[{}()[\];,]+$/.test(t)) continue;
      (out[file] ??= new Set()).add(t);
    }
    return out;
  }

  // controllo "niente perso" su una copia di lavoro che contiene il risultato dell'unione.
  // Confronto riga per riga, ma non ottuso:
  //   - i numeri di versione non contano ("Stato attuale (v0.33.0)" → "(v0.33.1)", una voce del CHANGELOG rinumerata
  //     durante l'allineamento: è la stessa riga);
  //   - una riga lunga che nel risultato c'è ancora, ritoccata (stesse parole quasi tutte), è CAMBIATA, non persa:
  //     finisce tra gli avvisi, non blocca l'unione.
  // Restano bloccanti le righe che nel risultato non hanno nessuna corrispondente: quelle si perderebbero davvero.
  async lostCheck({ cwd, base, sides, withChanged = false }) {
    const missing = [], changed = [];
    const cache = new Map();
    const fileInfo = (f) => {
      if (!cache.has(f)) {
        const raw = fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim());
        cache.set(f, { have: new Set(raw), norm: new Set(raw.map(normLine)), long: raw.filter((l) => l.length >= SIMILAR_MIN).map((l) => ({ l, w: words(l) })) });
      }
      return cache.get(f);
    };
    for (const { label, ref } of sides) {
      const added = await this.addedLines(base, ref, cwd);
      for (const [file, lines] of Object.entries(added)) {
        const f = path.join(cwd, file);
        if (!fs.existsSync(f)) { missing.push({ side: label, file, line: '(file sparito)' }); continue; }
        const info = fileInfo(f);
        for (const l of lines) {
          if (info.have.has(l) || info.norm.has(normLine(l))) continue;
          const near = l.length >= SIMILAR_MIN ? info.long.find((x) => similarity(words(l), x.w) >= SIMILAR_RATIO) : null;
          if (near) { if (!changed.some((c) => c.file === file && c.line === l.slice(0, 140))) changed.push({ side: label, file, line: l.slice(0, 140), now: near.l.slice(0, 140) }); continue; }
          if (!missing.some((m) => m.file === file && m.line === l.slice(0, 140))) missing.push({ side: label, file, line: l.slice(0, 140) });
        }
      }
    }
    return withChanged ? { missing, changed } : missing;
  }

  // IL PUNTO DEBOLE SONO LE SOLUZIONI DEI CONFLITTI. Un'unione pulita di git tiene per costruzione le novità di
  // tutte e due le parti; quello che si può perdere è ciò che un agente ha tolto risolvendo un conflitto durante un
  // allineamento. Quindi: per ogni allineamento (commit di unione nel branch della richiesta) si controlla che le
  // novità delle due parti siano rimaste. Una riga tolta lì e non più tornata è PERSA; una riga cambiata DOPO,
  // con un commit normale, è una scelta dello sviluppo (non si segnala).
  async resolutionCheck({ cwd, base, tip }) {
    const missing = [], changed = [], docs = [];
    const g = (args) => this.git.git(args, cwd, { allowFail: true });
    const merges = (await g(['rev-list', '--merges', '--parents', `${base}..${tip}`])).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
    const finalInfo = new Map(), atInfo = new Map();
    const build = (raw) => ({ have: new Set(raw), norm: new Set(raw.map(normLine)), code: new Set(raw.map(codeOnly)), long: raw.filter((l) => l.length >= SIMILAR_MIN).map((l) => ({ l, w: words(l) })), all: raw.filter((l) => l.length >= 8).map((l) => ({ l, w: words(codeOnly(l)) })) });
    const finalOf = (file) => { if (!finalInfo.has(file)) { const f = path.join(cwd, file); finalInfo.set(file, fs.existsSync(f) ? build(fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim())) : null); } return finalInfo.get(file); };
    const atOf = async (ref, file) => { const k = `${ref}:${file}`; if (!atInfo.has(k)) { const r = await g(['show', k]); atInfo.set(k, r.code === 0 ? build(r.stdout.split('\n').map((l) => l.trim())) : null); } return atInfo.get(k); };
    const found = (info, l) => info && (info.have.has(l) || info.norm.has(normLine(l)) || (l !== codeOnly(l) && (info.have.has(codeOnly(l)) || info.code.has(codeOnly(l)))));
    const near = (info, l) => {
      if (!info) return null;
      if (l.length >= SIMILAR_MIN) { const x = info.long.find((y) => similarity(words(l), y.w) >= SIMILAR_RATIO); if (x) return x; }
      // due versioni fuse in una riga sola ("return [...back, ...(d.options)" + "return [...save, ...(d.options)" →
      // "return [...back, ...save, ...(d.options)"): tutte le parole della riga stanno in una riga del risultato
      const w = words(codeOnly(l));
      if (w.size >= 3) { const x = info.all.find((y) => contained(w, y.w) >= 0.9); if (x) return x; }
      return null;
    };
    for (const [m, p1, p2] of merges) {
      if (!p2) continue;
      const mb = (await g(['merge-base', p1, p2])).stdout.trim();
      if (!mb) continue;
      for (const [label, ref] of [['della richiesta', p1], ['già nel gioco', p2]]) {
        const added = await this.addedLines(mb, ref, cwd);
        for (const [file, lines] of Object.entries(added)) {
          const at = await atOf(m, file), fin = finalOf(file);
          if (!at && !fin) { if (!missing.some((x) => x.file === file && x.line === '(file sparito)')) missing.push({ side: label, file, line: '(file sparito)', at: m.slice(0, 7) }); continue; }
          const doc = /\.(md|txt)$/i.test(file);
          for (const l of lines) {
            if (!doc && COMMENT_RE.test(l)) continue;   // un commento spostato o riscritto non è un aggiornamento perso
            if (found(at, l) || found(fin, l)) continue;
            const n = near(at, l) || near(fin, l);
            const key = l.slice(0, 140);
            if (n) { if (!changed.some((c) => c.file === file && c.line === key)) changed.push({ side: label, file, line: key, now: n.l.slice(0, 140) }); continue; }
            // nei documenti (CHANGELOG, note, Bibbia) i testi vengono riscritti spesso: avviso visibile, non blocco
            if (doc) { if (!docs.some((x) => x.file === file && x.line === key)) docs.push({ side: label, file, line: key }); continue; }
            if (!missing.some((x) => x.file === file && x.line === key)) missing.push({ side: label, file, line: key, at: m.slice(0, 7) });
          }
        }
      }
    }
    return { missing, changed, docs, alignments: merges.length };
  }

  // segni di conflitto rimasti nei file toccati (<<<<<<< ======= >>>>>>>): il gioco non partirebbe
  async markers({ cwd, from, to }) {
    const files = (await this.git.git(['diff', '--name-only', from, to], cwd, { allowFail: true })).stdout.split('\n').filter((f) => f && !isJunk(f));
    const out = [];
    for (const file of files) {
      const f = path.join(cwd, file);
      if (!fs.existsSync(f) || fs.statSync(f).size > 2e6) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const i = lines.findIndex((l) => /^(<{7}|>{7}) /.test(l));
      if (i >= 0) out.push({ side: 'segni di conflitto rimasti', file, line: `riga ${i + 1}: ${lines[i].slice(0, 60)}` });
    }
    return out;
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
      const rc = await this.resolutionCheck({ cwd, base, tip });
      const missing = [...(await this.markers({ cwd, from: main, to: tip })), ...rc.missing], changed = rc.changed, docs = rc.docs;
      const vMain = await this.versionAt(main, cwd), vTip = await this.versionAt(tip, cwd);
      const vRes = fs.existsSync(path.join(cwd, 'src/version.js')) ? parseVer(fs.readFileSync(path.join(cwd, 'src/version.js'), 'utf8')) : null;
      const versionIssue = vRes && [vMain, vTip].some((v) => v && cmpVer(vRes, v) < 0) ? `la versione risultante ${verStr(vRes)} è più bassa di ${verStr([vMain, vTip].filter(Boolean).sort(cmpVer).at(-1))}` : null;
      return { ok: !missing.length && !versionIssue, conflict: false, missing, changed, docs, versionIssue, version: verStr(vRes), main, tip };
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
