// Costruisce lo Studio (tutti i pezzi collegati) e il server HTTP. Usato da index.js e dai test.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { AgentRegistry } from './agents.js';
import { ProviderRegistry } from './providers/index.js';
import { GitService } from './git.js';
import { Knowledge } from './knowledge.js';
import { Orchestrator } from './orchestrator.js';
import { OfficeStore } from './office.js';
import { readJSON, writeFileAtomic, ensureDir } from './util.js';

export const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// il QA harness lanciato dagli agenti dentro un worktree trova qui Playwright
{ const pw = path.join(STUDIO_DIR, 'node_modules', 'playwright', 'index.mjs'); if (fs.existsSync(pw)) process.env.STUDIO_PLAYWRIGHT ??= pw; }

// Prima dello spostamento in un repository suo, lo Studio teneva i dati in <gioco>/.studio: li copia (una volta sola).
// Le copie di lavoro (worktree) restano dove sono: lo Studio le ritrova da git.
function migrateOldData(oldDir, dataDir) {
  if (!fs.existsSync(path.join(oldDir, 'state.json')) || fs.existsSync(path.join(dataDir, 'state.json'))) return;
  for (const name of ['state.json', 'events.jsonl', 'config.json', 'office.json', 'artifacts', 'avatars', 'memory']) {
    const src = path.join(oldDir, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dataDir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'MIGRATO_DA.txt'), `Dati copiati da ${oldDir} il ${new Date().toISOString()}\n`);
}

export async function createStudio({ projectRoot, dataDir, providers, qaRunner, configOverrides, studioRepo } = {}) {
  // cartella del gioco: STUDIO_PROJECT_ROOT (nel .env dello Studio) oppure la cartella tq-evs accanto allo Studio
  projectRoot = path.resolve(projectRoot || process.env.STUDIO_PROJECT_ROOT || path.join(STUDIO_DIR, '..', 'tq-evs'));
  if (!fs.existsSync(projectRoot)) throw new Error(`cartella del gioco non trovata: ${projectRoot}. Imposta STUDIO_PROJECT_ROOT nel file .env dello Studio.`);
  dataDir = path.resolve(dataDir || process.env.STUDIO_DATA_DIR || path.join(STUDIO_DIR, 'data'));
  ensureDir(dataDir);
  migrateOldData(path.join(projectRoot, '.studio'), dataDir);
  const configFile = path.join(dataDir, 'config.json');
  const defaults = readJSON(path.join(STUDIO_DIR, 'config', 'studio.default.json'), {});
  const config = { ...defaults, ...readJSON(configFile, {}), ...(configOverrides || {}) };
  delete config._nota; delete config._prezzi;
  const events = new EventBus({ file: path.join(dataDir, 'events.jsonl') });
  const store = new Store(dataDir);
  const agents = new AgentRegistry(store, events, path.join(STUDIO_DIR, 'config', 'agents.default.json'));
  providers = providers || new ProviderRegistry();
  const git = new GitService(projectRoot, { worktreesDir: path.join(dataDir, 'worktrees'), events });
  const knowledge = new Knowledge({ projectRoot, dataDir, events });
  const office = new OfficeStore({ studioDir: STUDIO_DIR, dataDir, events });
  // il repository dello Studio stesso (per le modifiche al programma fatte dal Responsabile dell'ufficio)
  const studioGit = studioRepo === false ? null : new GitService(studioRepo || STUDIO_DIR, { worktreesDir: path.join(dataDir, 'studio-worktrees'), events });
  const orch = new Orchestrator({ store, events, agents, providers, git, knowledge, config, studioDir: STUDIO_DIR, projectRoot, dataDir, qaRunner, office, studioGit });
  await orch.init();
  knowledge.regenerate(store.data);
  const saveConfig = (patch) => {
    const allowed = Object.keys(defaults).filter((k) => k !== '_nota');
    for (const k of allowed) if (k in patch) config[k] = patch[k];
    const cur = readJSON(configFile, {});
    for (const k of allowed) if (k in patch) cur[k] = patch[k];
    writeFileAtomic(configFile, JSON.stringify(cur, null, 2));
    return config;
  };
  return { projectRoot, dataDir, config, saveConfig, events, store, agents, providers, git, knowledge, orch, office };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2' };

function sendFile(res, file, root) {
  const f = path.resolve(file);
  if (!f.startsWith(path.resolve(root)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('non trovato'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req, limit = 12 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('richiesta troppo grande'); chunks.push(c); }
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

export function createServer(studio) {
  const { orch, agents, events, store, knowledge, git, providers, dataDir, projectRoot, office } = studio;
  const web = path.join(STUDIO_DIR, 'web');

  const snapshot = async () => ({
    agents: agents.list().map((a) => agents.public(a)),
    requests: Object.values(store.data.requests).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 100),
    tasks: Object.values(store.data.tasks).sort((a, b) => a.id.localeCompare(b.id)).slice(-400),
    chat: store.data.chat.slice(-300),
    config: studio.config,
    lastSeq: events.seq,
    projectRoot,
  });

  const routes = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, seq: events.seq })],
    ['GET', /^\/api\/state$/, snapshot],
    ['POST', /^\/api\/chat$/, async (m, b) => {
      // gli allegati devono essere file caricati in data/uploads (niente percorsi arbitrari)
      const up = path.join(dataDir, 'uploads');
      const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map((a) => {
        const f = path.resolve(up, String(a.id || ''), path.basename(String(a.name || '')));
        if (!f.startsWith(up + path.sep) || !fs.existsSync(f)) throw new Error(`allegato non trovato: ${a.name}`);
        return { id: a.id, name: path.basename(f), type: a.type || '', size: fs.statSync(f).size, path: f, url: `/uploads/${a.id}/${encodeURIComponent(path.basename(f))}` };
      });
      return { request: await orch.handleUserMessage(b.text, { attachments }) };
    }],
    ['POST', /^\/api\/uploads$/, async (m, b) => {
      const mm = String(b.dataUrl || '').match(/^data:([^;,]*)(;base64)?,(.*)$/s);
      if (!mm) throw new Error('file non valido');
      const buf = mm[2] ? Buffer.from(mm[3], 'base64') : Buffer.from(decodeURIComponent(mm[3]));
      if (buf.length > 40 * 1024 * 1024) throw new Error('file troppo grande (massimo 40 MB)');
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const name = (path.basename(String(b.name || 'file')).replace(/[^\w.\- ()àèéìòù]/gi, '_') || 'file').slice(0, 120);
      const dir = ensureDir(path.join(dataDir, 'uploads', id));
      fs.writeFileSync(path.join(dir, name), buf);
      return { id, name, type: b.type || mm[1] || '', size: buf.length, url: `/uploads/${id}/${encodeURIComponent(name)}` };
    }],
    ['GET', /^\/api\/agents$/, async () => agents.list().map((a) => agents.public(a))],
    ['POST', /^\/api\/agents$/, async (m, b) => agents.public(agents.create(b))],
    ['PUT', /^\/api\/agents\/([\w-]+)$/, async (m, b) => agents.public(agents.update(m[1], b))],
    ['POST', /^\/api\/agents\/([\w-]+)\/reset$/, async (m) => agents.public(agents.resetToDefault(m[1]))],
    ['POST', /^\/api\/agents\/([\w-]+)\/avatar$/, async (m, b) => {
      // b.dataUrl = "data:image/png;base64,..." → salvato in data/avatars e collegato all'avatar
      const mm = String(b.dataUrl || '').match(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,(.+)$/);
      if (!mm) throw new Error('immagine non valida (serve png/jpg/gif/webp/svg)');
      const ext = mm[1] === 'jpeg' ? 'jpg' : mm[1] === 'svg+xml' ? 'svg' : mm[1];
      const file = `${m[1]}-${Date.now()}.${ext}`;
      ensureDir(path.join(dataDir, 'avatars'));
      fs.writeFileSync(path.join(dataDir, 'avatars', file), Buffer.from(mm[2], 'base64'));
      const kind = b.kind === 'spritesheet' ? 'spritesheet' : 'image';
      const avatar = kind === 'spritesheet' ? { type: 'spritesheet', sprite: { url: `/avatars/${file}`, frameWidth: Number(b.frameWidth) || 32, frameHeight: Number(b.frameHeight) || 32, scale: Number(b.scale) || 3, animations: b.animations || {} } } : { type: 'image', image: `/avatars/${file}` };
      return agents.public(agents.update(m[1], { avatar }));
    }],
    ['GET', /^\/api\/tasks$/, async () => Object.values(store.data.tasks)],
    ['GET', /^\/api\/tasks\/([\w-]+)$/, async (m) => store.data.tasks[m[1]] || null],
    ['POST', /^\/api\/requests\/([\w-]+)\/retry$/, async (m) => orch.retry(m[1])],
    ['POST', /^\/api\/requests\/([\w-]+)\/cancel$/, async (m) => orch.cancel(m[1])],
    ['POST', /^\/api\/requests\/([\w-]+)\/quote$/, async (m, b) => orch.answerQuote(m[1], ['approve', 'light', 'cancel'].includes(b?.action) ? b.action : 'approve', { choice: b?.choice, light: !!b?.light })],
    ['POST', /^\/api\/requests\/([\w-]+)\/merge$/, async (m) => orch.merge(m[1])],
    ['POST', /^\/api\/requests\/([\w-]+)\/revert-merge$/, async (m) => orch.revertMerge(m[1])],
    ['POST', /^\/api\/requests\/([\w-]+)\/discard$/, async (m) => orch.discard(m[1])],
    ['GET', /^\/api\/requests\/([\w-]+)\/diff$/, async (m) => {
      const r = store.data.requests[m[1]];
      if (!r?.worktree || !fs.existsSync(r.worktree)) return { summary: null, diff: '' };
      return { summary: await git.diffSummary(r.worktree, r.baseCommit), diff: await git.diffText(r.worktree, r.baseCommit, 60000) };
    }],
    ['GET', /^\/api\/memory$/, async () => knowledge.list()],
    ['GET', /^\/api\/memory\/([A-Z_]+)$/, async (m) => {
      let content = knowledge.read(m[1]);
      if (m[1] === 'PROJECT_STATE') {
        // parte "viva": sempre allineata al repository reale
        const st = await git.status(); const log = await git.recentCommits(8);
        let version = '?'; try { version = (fs.readFileSync(path.join(projectRoot, 'src', 'version.js'), 'utf8').match(/VERSION\s*=\s*'([^']+)'/) || [])[1]; } catch { /* */ }
        content += `\n\n---\n## Stato vivo del repository (generato ora)\n- versione del gioco: ${version}\n- branch: ${st.branch} @ ${st.head} — ${st.clean ? 'pulito' : `${st.changes.length} modifiche non committate`}\n- ultimi commit:\n${log.map((c) => `  - ${c.short} ${c.subject} (${c.author}, ${c.when})`).join('\n')}\n`;
      }
      return { name: m[1], content };
    }],
    ['PUT', /^\/api\/memory\/([A-Z_]+)$/, async (m, b) => { knowledge.write(m[1], String(b.content ?? '')); return { ok: true }; }],
    ['GET', /^\/api\/git$/, async () => ({ available: await git.available(), status: await git.status(), commits: await git.recentCommits(15) })],
    ['GET', /^\/api\/office$/, async () => office.get()],
    ['PUT', /^\/api\/office$/, async (m, b) => { const errs = office.validate(b); if (errs.length) throw new Error(errs.join('; ')); office.snapshot(agents); office.save(b); return { ok: true }; }],
    ['POST', /^\/api\/office\/undo$/, async () => office.undo(agents)],
    ['GET', /^\/api\/providers$/, async () => providers.status()],
    ['POST', /^\/api\/providers\/([\w-]+)\/test$/, async (m, b) => {
      // prova di un provider immagini: genera un'immagine e la mette fra gli artefatti
      const p = providers.get(m[1]);
      if (!p || p.kind !== 'image') throw new Error('non è un provider immagini');
      const g = await p.generate({ prompt: String(b.prompt || 'pixel art test'), size: '1024x1024' });
      if (!g.ok) throw new Error(g.error);
      const dir = ensureDir(path.join(dataDir, 'artifacts', 'prove-immagini'));
      const name = `${m[1]}-${Date.now()}.png`;
      fs.writeFileSync(path.join(dir, name), g.png);
      return { url: `/artifacts/prove-immagini/${name}` };
    }],
    ['GET', /^\/api\/config$/, async () => studio.config],
    ['PUT', /^\/api\/config$/, async (m, b) => studio.saveConfig(b)],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const since = Number(url.searchParams.get('since') || req.headers['last-event-id'] || 0);
        const send = (e) => res.write(`id: ${e.seq}\nevent: studio\ndata: ${JSON.stringify(e)}\n\n`);
        for (const e of events.since(since)) send(e);
        const off = events.on(send);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      if (p.startsWith('/api/')) {
        for (const [method, re, fn] of routes) {
          const m = p.match(re);
          if (m && req.method === method) {
            const b = ['POST', 'PUT'].includes(method) ? await body(req, p === '/api/uploads' ? 60 * 1024 * 1024 : undefined) : {};
            return json(res, 200, await fn(m, b));
          }
        }
        return json(res, 404, { error: 'rotta sconosciuta' });
      }
      if (p.startsWith('/play/')) {
        // /play/main/… = cartella del gioco · /play/R-0001/… = worktree di quella richiesta
        const [, , which, ...rest] = p.split('/');
        const root = which === 'main' ? projectRoot : store.data.requests[which]?.worktree;
        if (!root) { res.writeHead(404); res.end('versione non disponibile'); return; }
        if (!rest.length) { res.writeHead(302, { Location: `/play/${which}/` }); res.end(); return; }
        return sendFile(res, path.join(root, rest.join('/') || 'index.html'), root);
      }
      if (p.startsWith('/artifacts/')) return sendFile(res, path.join(dataDir, p), path.join(dataDir, 'artifacts'));
      if (p.startsWith('/avatars/')) return sendFile(res, path.join(dataDir, p), path.join(dataDir, 'avatars'));
      if (p.startsWith('/uploads/')) return sendFile(res, path.join(dataDir, p), path.join(dataDir, 'uploads'));
      return sendFile(res, path.join(web, p === '/' ? 'index.html' : p), web);
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
  });
  return server;
}
