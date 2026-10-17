// UFFICIO DELLA STORIA (Enigma e Custode): la lavagna con le missioni del gioco, cosa sblocca cosa e i modi di risolverle.
// La fonte è un file del gioco, docs/memoria/STORIA.json, che tengono aggiornato gli agenti (Enigma, Custode, chi
// cambia missioni o soluzioni). Lo Studio lo legge dal gioco (o da una versione da provare), lo confronta con i flag
// che esistono davvero nei livelli e nel codice (cosa è già nel gioco e cosa è solo progetto) e dice se la lavagna è
// rimasta indietro rispetto ai livelli. Dall'ufficio si scrivono richieste che la cambiano (passano dalla Regia).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { clip } from './util.js';

export const STORIA_FILE = 'docs/memoria/STORIA.json';
export const STORIA_AGENTS = ['puzzle', 'lore'];

export const STORIA_SCHEMA = `## La lavagna della storia: ${STORIA_FILE}
È la mappa di tutte le missioni del gioco per l'Ufficio della Storia dello Studio (la legge l'utente, non il gioco).
Deve dire lo STATO ATTUALE: quello che c'è nei livelli e nel codice ("stato": "nel gioco" / "in parte"), più quello
progettato nei documenti ("progettata") o solo pensato ("idea"). JSON valido, testi in italiano, brevi e chiari.
{
  "aggiornata": { "gioco": "<versione di src/version.js>", "nota": "cosa è cambiato in questo aggiornamento" },
  "atti": [ { "id": "a1", "titolo": "Primo giorno" } ],                      // facoltativi: fasi della storia
  "missioni": [ {
    "id": "santino", "titolo": "…", "tipo": "principale | secondaria | lavoro | indagine | evento | finale",
    "atto": "a1", "rione": "…", "personaggi": ["npc_…"], "stato": "nel gioco | in parte | progettata | idea",
    "riassunto": "1-2 frasi", "obiettivo": "cosa deve ottenere il giocatore",
    "richiede": ["id missione", "flag:nome>=2", "testo libero"],              // cosa serve per aprirla
    "sottomissioni": [ { stessa forma di una missione, senza altre sottomissioni } ],
    "soluzioni": [ { "id": "…", "titolo": "Taglia la rete", "come": "cosa fa il giocatore",
      "etica": "alta | media | bassa", "esito": "cosa succede", "implica": ["conseguenze, anche lontane"],
      "sblocca": ["id missione"], "chiude": ["id missione"], "flag": ["nomi dei flag scritti"] } ],
    "flag": ["flag letti o scritti dalla missione"], "fonti": ["levels/level3.json", "docs/memoria/…md"]
  } ]
}
Ogni id usato in "richiede", "sblocca", "chiude" deve esistere fra le missioni (o sottomissioni). I finali sono
missioni di tipo "finale". Quando una richiesta cambia missioni, enigmi, soluzioni o cosa sblocca cosa, aggiorna
questo file nello stesso lavoro (e "aggiornata.gioco"), senza riscrivere le parti che non c'entrano.`;

const gitOut = (args, cwd) => new Promise((resolve) => {
  const c = spawn('git', args, { cwd }); const out = [];
  c.stdout.on('data', (d) => out.push(d)); c.on('close', (code) => resolve({ code, text: Buffer.concat(out).toString('utf8') })); c.on('error', () => resolve({ code: 1, text: '' }));
});

// i flag che esistono davvero: chiavi di "when", "set", "state", "soglia"… nei livelli, e st.set/get/add('…') nel codice
export function flagsOf(level, codeText = '') {
  const out = new Set();
  const take = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) out.add(k); else if (Array.isArray(o)) o.forEach(take); };
  const walk = (v, key) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (['when', 'set', 'state', 'requires', 'unless'].includes(k)) take(x);
      walk(x, k);
    }
  };
  walk(level);
  for (const m of codeText.matchAll(/\b(?:st|state|ws|world)\s*\.\s*(?:set|add|get|has)\(\s*['"`]([a-z][a-z0-9_]*)/gi)) out.add(m[1]);
  return out;
}

// controllo della lavagna: id doppi, rimandi a missioni che non ci sono
export function checkStoria(s) {
  const problems = [], ids = new Set();
  const all = [];
  for (const m of s?.missioni || []) { all.push(m); for (const x of m.sottomissioni || []) all.push(x); }
  for (const m of all) { if (!m.id) problems.push(`una missione senza id («${clip(m.titolo, 40)}»)`); else if (ids.has(m.id)) problems.push(`id doppio: ${m.id}`); else ids.add(m.id); }
  for (const m of all) {
    for (const r of m.richiede || []) if (typeof r === 'string' && /^[a-z0-9_]+$/.test(r) && !ids.has(r) && !/^flag:/.test(r)) problems.push(`${m.id} richiede «${r}», che non c'è`);
    for (const so of m.soluzioni || []) for (const k of ['sblocca', 'chiude']) for (const t of so[k] || []) if (!ids.has(t)) problems.push(`${m.id} › ${so.id || so.titolo}: ${k} «${t}», che non c'è`);
  }
  return { problems, ids: [...ids] };
}

export class StoriaOffice {
  constructor({ orch, store, agents, projectRoot }) { Object.assign(this, { orch, store, agents, projectRoot }); }
  get S() { return this.store.data; }

  // versioni da provare che hanno cambiato la lavagna
  drafts() {
    return Object.values(this.S.requests).filter((r) => r.worktree && fs.existsSync(r.worktree) && !r.merged && !r.discarded
      && (r.report?.filesChanged || []).some((f) => (f.file || f) === STORIA_FILE))
      .sort((a, b) => b.id.localeCompare(a.id)).map((r) => ({ id: r.id, text: clip(r.originalText || r.text, 70), status: r.status }));
  }

  // le richieste nate qui (o che hanno toccato la lavagna), le più recenti
  related() {
    return Object.values(this.S.requests).filter((r) => r.storia || (r.report?.filesChanged || []).some((f) => (f.file || f) === STORIA_FILE))
      .sort((a, b) => b.id.localeCompare(a.id)).slice(0, 12)
      .map((r) => ({ id: r.id, text: clip(r.storiaText || r.originalText || r.text, 90), status: r.status, merged: !!r.merged, discarded: !!r.discarded, node: r.storiaNode || null, at: r.updatedAt || r.createdAt }));
  }

  async scene(src = 'main') {
    let cwd = this.projectRoot, req = null;
    if (src && src !== 'main') {
      req = this.S.requests[src];
      if (!req?.worktree || !fs.existsSync(req.worktree)) throw new Error(`la versione ${src} non c'è più`);
      cwd = req.worktree;
    }
    const show = async (rel) => { const g = await gitOut(['show', `HEAD:${rel}`], cwd); return g.code === 0 ? g.text : null; };
    const raw = await show(STORIA_FILE);
    let storia = null, parseError = null;
    if (raw) { try { storia = JSON.parse(raw); } catch (e) { parseError = e.message; } }
    const version = ((await show('src/version.js')) || '').match(/VERSION\s*=\s*'([^']+)'/)?.[1] || null;
    // i flag del gioco: tutti i livelli dell'indice + il codice
    let levelsText = '';
    const idx = await show('levels/index.json');
    let files = [];
    try { files = (JSON.parse(idx || '{}').levels || []).map((l) => l.file || l.path || (l.id ? `levels/${l.id}.json` : null)).filter(Boolean); } catch { files = []; }
    if (!files.length) files = (await gitOut(['ls-tree', '--name-only', 'HEAD', 'levels/'], cwd)).text.split('\n').filter((f) => /\.json$/.test(f) && !/index\.json$/.test(f));
    const levels = [];
    for (const f of [...new Set(files)].slice(0, 12)) { const t = await show(f); if (t) { try { levels.push(JSON.parse(t)); } catch { /* livello illeggibile */ } } }
    levelsText = (await gitOut(['grep', '-h', '-o', '-E', "\\b(st|state|ws|world)\\s*\\.\\s*(set|add|get|has)\\(\\s*['\"`][a-z][a-z0-9_]*", 'HEAD', '--', 'src'], cwd)).text;
    const flags = flagsOf(levels, levelsText);
    const strings = JSON.parse((await show('strings/it.json')) || '{}');
    // la lavagna è rimasta indietro? commit sui livelli, sui testi e sui documenti di storia dopo il suo ultimo aggiornamento
    let stale = null;
    if (storia) {
      const last = (await gitOut(['log', '-1', '--format=%H', 'HEAD', '--', STORIA_FILE], cwd)).text.trim();
      if (last) {
        const after = (await gitOut(['log', '--format=%h %s', `${last}..HEAD`, '--', 'levels', 'strings', 'docs/memoria', 'src/systems/Vandalism.js', 'src/scenes/GameScene.js'], cwd)).text.split('\n').filter(Boolean);
        stale = { commits: after.length, recent: after.slice(0, 6) };
      }
    }
    const check = storia ? checkStoria(storia) : { problems: [], ids: [] };
    const names = {};
    const people = new Set();
    for (const m of storia?.missioni || []) for (const x of [m, ...(m.sottomissioni || [])]) for (const p of x.personaggi || []) people.add(p);
    for (const p of people) if (strings[p]) names[p] = strings[p];
    return {
      src: req ? req.id : 'main', play: req ? `/play/${req.id}/` : '/play/main/', version, storia, parseError, problems: check.problems,
      flags: [...flags], stale, names, drafts: this.drafts(), related: this.related(),
      agents: Object.fromEntries(STORIA_AGENTS.map((id) => [id, this.agents.get(id)]).filter(([, a]) => a).map(([id, a]) => [id, { id, name: a.name, role: a.role, avatar: a.avatar, status: a.runtime?.status }])),
    };
  }

  // una richiesta dall'ufficio: va alla Regia con il contesto (la missione scelta) e le regole della lavagna
  async prompt({ text, node, mode } = {}) {
    text = String(text || '').trim();
    const names = STORIA_AGENTS.map((id) => this.agents.get(id)?.name).filter(Boolean);
    const who = names.length ? names.join(' e ') : 'l\'Enigmista e il Custode';
    if (mode === 'rebuild') text = text || `Ricostruisci la lavagna della storia (${STORIA_FILE}) dallo stato attuale del gioco: leggi i livelli (levels/*.json: dialoghi, bersagli, lavori, eventi, traccia, uscita), strings/it.json e i documenti di storia (docs/memoria/TRACCIA_PRINCIPALE.md, PUZZLES.md, INDAGINE_*.md, NARRATIVE_BIBLE.md, docs/indagini/). Segna per ogni missione e soluzione se è nel gioco o solo progettata. Non cambiare il gioco: solo questo file.`;
    if (!text) throw new Error('scrivi cosa vuoi cambiare nella storia');
    const ctx = node?.id ? `\n\nRiferito alla lavagna della storia: ${node.kind === 'soluzione' ? 'soluzione' : 'missione'} «${clip(node.titolo || node.id, 80)}» (id ${node.id}${node.parent ? `, nella missione ${node.parent}` : ''}).` : '';
    const msg = `[Ufficio della Storia — per ${who}] ${text}${ctx}`;
    // niente smistamento automatico: dall'ufficio è sempre una richiesta nuova (lo schema della lavagna arriva ai task)
    const req = await this.orch.handleUserMessage(msg, { fresh: true, meta: { storia: true, storiaText: clip(text, 300), storiaNode: node?.id || null } });
    return { request: req?.id ? { id: req.id, status: req.status } : null };
  }
}
