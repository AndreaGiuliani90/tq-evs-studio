#!/usr/bin/env node
// QA HARNESS del gioco (usato da Tizia e dai test dello Studio).
//
//   node qa/game-test.mjs                              # (cartella gioco: STUDIO_PROJECT_ROOT oppure ../tq-evs)
//   node qa/game-test.mjs --root /percorso/gioco --json --out /tmp/shots
//   node qa/game-test.mjs --levels level2 --steps '[{"action":"key","key":"KeyD","ms":800},{"action":"screenshot","name":"dopo"}]'
//   node qa/game-test.mjs --no-browser          # solo controlli statici (niente Playwright)
//
// Esce con codice 0 se tutto è PASS, 1 se qualcosa è FAIL. Con --json stampa il rapporto completo su stdout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const a = { root: path.resolve(process.env.STUDIO_PROJECT_ROOT || path.join(HERE, '..', '..', 'tq-evs')), json: false, out: null, levels: 'all', steps: null, browser: true, timeoutMs: 25000, settleMs: 2500 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--root') a.root = path.resolve(v());
    else if (k === '--json') a.json = true;
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--levels') a.levels = v();
    else if (k === '--steps') a.steps = v();
    else if (k === '--steps-file') a.steps = fs.readFileSync(v(), 'utf8');
    else if (k === '--no-browser') a.browser = false;
    else if (k === '--settle') a.settleMs = Number(v());
  }
  return a;
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

// ─── Controlli statici ────────────────────────────────────────────────────────────────────────────
export function staticChecks(root) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const rel = (p) => path.relative(root, p);

  // 1. sintassi di tutti i moduli JS del gioco
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tqevs-syntax-'));
  const jsFiles = walk(path.join(root, 'src'), (p) => p.endsWith('.js'));
  const bad = [];
  for (const f of jsFiles) {
    const copy = path.join(tmp, rel(f).replace(/[\\/]/g, '__') + '.mjs');
    fs.copyFileSync(f, copy);
    const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${rel(f)}: ${(r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ')}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  add(`sintassi JS (${jsFiles.length} file)`, bad.length === 0, bad.join('\n'));

  // 2. JSON validi (livelli, stringhe, manifest)
  const jsonFiles = [
    ...walk(path.join(root, 'levels'), (p) => p.endsWith('.json')),
    ...walk(path.join(root, 'strings'), (p) => p.endsWith('.json')),
  ];
  const badJson = [];
  for (const f of jsonFiles) { try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { badJson.push(`${rel(f)}: ${e.message}`); } }
  add(`JSON validi (${jsonFiles.length} file)`, badJson.length === 0, badJson.join('\n'));

  // 3. indice dei livelli coerente
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'levels', 'index.json'), 'utf8'));
    const missing = [...(idx.levels || []).map((l) => l.file), ...(idx.strings || [])].filter((f) => !fs.existsSync(path.join(root, f)));
    add('levels/index.json: file referenziati esistono', missing.length === 0, missing.join(', '));
  } catch (e) { add('levels/index.json leggibile', false, e.message); }

  // 4. versione (regola del progetto: src/version.js + CHANGELOG.md)
  try {
    const v = (fs.readFileSync(path.join(root, 'src', 'version.js'), 'utf8').match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
    add('src/version.js ha una versione MAJOR.MINOR.PATCH', /^\d+\.\d+\.\d+$/.test(v || ''), v || 'non trovata');
    const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    add(`CHANGELOG.md documenta la versione ${v}`, cl.includes(`## ${v}`), '');
  } catch (e) { add('versione/CHANGELOG leggibili', false, e.message); }

  // 5. index.html carica Phaser e main.js
  try {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    add('index.html carica phaser e src/main.js', html.includes('phaser') && html.includes('src/main.js'), '');
  } catch (e) { add('index.html presente', false, e.message); }

  return { ok: checks.every((c) => c.ok), checks };
}

// ─── Server statico senza cache ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.m4a': 'audio/mp4' };
export function serveStatic(root, port = 0) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; } catch { /* prova l'installazione dello Studio */ }
  // lanciato da una copia di lavoro (worktree) senza node_modules: usa il Playwright dello Studio acceso
  const alt = process.env.STUDIO_PLAYWRIGHT;
  if (alt) { try { return (await import(pathToFileURL(alt).href)).chromium; } catch { /* niente */ } }
  return null;
}

async function launch(chromium) {
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
  // 1) Chromium "nuovo headless" di Playwright (screenshot più affidabili con WebGL), 2) headless shell, 3) Google Chrome installato
  let first;
  for (const channel of ['chromium', undefined, 'chrome']) {
    try { return await chromium.launch({ args, ...(channel ? { channel } : {}) }); } catch (e) { first ??= e; }
  }
  throw first;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Prova nel browser ────────────────────────────────────────────────────────────────────────────
export async function browserChecks(root, opts = {}) {
  const chromium = await loadPlaywright();
  if (!chromium) return { available: false, ok: true, note: 'Playwright non installato: eseguire `cd studio && npm install && npx playwright install chromium`' };
  const outDir = opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'tqevs-shots-'));
  fs.mkdirSync(outDir, { recursive: true });
  const { srv, url } = await serveStatic(root);
  let browser;
  const report = { available: true, ok: true, url, errors: [], warnings: [], levels: [], steps: [], screenshots: [] };
  try {
    browser = await launch(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => report.errors.push({ type: 'pageerror', text: String(e.message || e).slice(0, 500) }));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error') {
        // rumori del browser headless, non del gioco
        if (/favicon|AudioContext|autoplay|WebGL|GPU stall|Failed to load resource/i.test(t)) report.warnings.push(t.slice(0, 300));
        else report.errors.push({ type: 'console.error', text: t.slice(0, 500) });
      } else if (m.type() === 'warning') report.warnings.push(t.slice(0, 300));
    });
    page.on('response', (r) => { if (r.status() >= 400) report.errors.push({ type: 'http', text: `${r.status()} ${r.url().replace(url, '/')}` }); });
    const shot = async (name) => {
      const f = path.join(outDir, `${name.replace(/[^a-z0-9_-]/gi, '_')}.png`);
      try { await page.screenshot({ path: f, timeout: 45000 }); }
      catch {
        // ripiego: copia del canvas subito dopo un frame (WebGL software può essere lento)
        const d = await page.evaluate(() => new Promise((r) => window.game.events.once('postrender', () => r(window.game.canvas.toDataURL('image/png'))))).catch(() => null);
        if (!d) { report.warnings.push(`screenshot ${name} non riuscito`); return null; }
        fs.writeFileSync(f, Buffer.from(d.split(',')[1], 'base64'));
      }
      report.screenshots.push(f); return f;
    };

    await page.goto(url, { waitUntil: 'load' });
    await page.bringToFront().catch(() => {});
    const menuOk = await page.waitForFunction(() => window.game && window.game.scene && window.game.scene.isActive('Menu'), null, { timeout: opts.timeoutMs || 25000 }).then(() => true).catch(() => false);
    report.menu = { ok: menuOk };
    await wait(500);
    await shot('00_menu');
    if (!menuOk) { report.ok = false; report.menu.detail = 'la scena Menu non è partita entro il tempo limite'; }

    const idx = JSON.parse(fs.readFileSync(path.join(root, 'levels', 'index.json'), 'utf8'));
    let ids = (idx.levels || []).map((l) => l.id);
    if (opts.levels && opts.levels !== 'all') ids = opts.levels.split(',').filter((x) => ids.includes(x));

    const startLevel = async (id) => {
      const before = report.errors.length;
      await page.evaluate((levelKey) => {
        const g = window.game;
        for (const s of g.scene.getScenes(true)) if (s.scene.key !== 'Menu') g.scene.stop(s.scene.key);
        const m = g.scene.getScene('Menu');
        (m && g.scene.isActive('Menu') ? m.scene : g.scene).start('Game', { levelKey, resume: false });
      }, id);
      const ok = await page.waitForFunction(() => window.game.scene.isActive('Game'), null, { timeout: 20000 }).then(() => true).catch(() => false);
      await wait(opts.settleMs ?? 2500);
      return { ok, newErrors: report.errors.slice(before) };
    };
    const playerPos = () => page.evaluate(() => { const p = window.game.scene.getScene('Game')?.player; return p && typeof p.x === 'number' ? { x: Math.round(p.x), y: Math.round(p.y) } : null; });

    if (menuOk && !opts.steps) {
      for (const id of ids) {
        const errBefore = report.errors.length;
        const r = await startLevel(id);
        const lv = { id, started: r.ok, hud: await page.evaluate(() => window.game.scene.isActive('Hud')) };
        // prova di movimento: tiene premuto D poi S
        await page.mouse.move(640, 600);
        const p0 = await playerPos();
        await page.keyboard.down('KeyD'); await wait(700); await page.keyboard.up('KeyD');
        await page.keyboard.down('KeyS'); await wait(500); await page.keyboard.up('KeyS');
        await wait(200);
        const p1 = await playerPos();
        lv.player = { before: p0, after: p1, moved: !!(p0 && p1 && (p0.x !== p1.x || p0.y !== p1.y)) };
        lv.screenshot = await shot(`level_${id}`);
        const errs = report.errors.slice(errBefore);
        lv.errors = errs;
        lv.ok = r.ok && errs.length === 0;
        report.levels.push(lv);
        // torna al menu senza passare dal prompt di salvataggio
        await page.evaluate(() => { const g = window.game, gs = g.scene.getScene('Game'); if (gs.exitToMenu) gs.exitToMenu(); else { g.scene.stop('Hud'); gs.scene.start('Menu'); } });
        await page.waitForFunction(() => window.game.scene.isActive('Menu'), null, { timeout: 15000 }).catch(() => {});
        await wait(600);
      }
    }

    // scenario personalizzato (Tizia): elenco di passi
    if (menuOk && opts.steps) {
      let steps;
      try { steps = typeof opts.steps === 'string' ? JSON.parse(opts.steps) : opts.steps; } catch (e) { steps = []; report.steps.push({ action: 'parse', ok: false, detail: e.message }); }
      for (const [i, st] of steps.entries()) {
        const rec = { i, ...st, ok: true };
        try {
          if (st.action === 'startLevel') { const r = await startLevel(st.id); rec.ok = r.ok; }
          else if (st.action === 'key') { await page.keyboard.down(st.key); await wait(st.ms ?? 150); await page.keyboard.up(st.key); }
          else if (st.action === 'press') { await page.keyboard.press(st.key); }
          else if (st.action === 'wait') { await wait(st.ms ?? 500); }
          else if (st.action === 'click') { await page.mouse.click(st.x, st.y); }
          else if (st.action === 'screenshot') { rec.file = await shot(st.name || `step_${i}`); }
          else if (st.action === 'eval') {
            rec.value = await page.evaluate(new Function(`return (async () => { ${st.js.includes('return') ? st.js : 'return (' + st.js + ')'} })()`));
            if ('expect' in st) rec.ok = JSON.stringify(rec.value) === JSON.stringify(st.expect);
            if (st.truthy) rec.ok = !!rec.value;
          } else { rec.ok = false; rec.detail = 'azione sconosciuta'; }
        } catch (e) { rec.ok = false; rec.detail = String(e.message || e).slice(0, 400); }
        report.steps.push(rec);
      }
    }

    report.ok = report.ok && menuOk && report.errors.length === 0 && report.levels.every((l) => l.ok) && report.steps.every((s) => s.ok);
  } catch (e) {
    report.ok = false; report.fatal = String(e.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.close();
  }
  return report;
}

export async function runGameTests(opts) {
  const t0 = Date.now();
  const st = staticChecks(opts.root);
  const br = opts.browser === false ? { available: false, ok: true, note: 'saltato (--no-browser)' } : await browserChecks(opts.root, opts);
  return { verdict: st.ok && br.ok ? 'PASS' : 'FAIL', root: opts.root, durationMs: Date.now() - t0, static: st, browser: br };
}

export function summarize(r) {
  const L = [`VERDETTO: ${r.verdict}  (${Math.round(r.durationMs / 100) / 10}s)`, 'Controlli statici:'];
  for (const c of r.static.checks) L.push(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.ok || !c.detail ? '' : '\n      ' + c.detail.replace(/\n/g, '\n      ')}`);
  const b = r.browser;
  if (!b.available) L.push(`Browser: non disponibile — ${b.note}`);
  else {
    L.push(`Browser: menu ${b.menu?.ok ? '✔' : '✘'}`);
    for (const l of b.levels) L.push(`  ${l.ok ? '✔' : '✘'} livello ${l.id}: avviato=${l.started} hud=${l.hud} movimento(info)=${l.player?.moved}`);
    for (const s of b.steps) L.push(`  ${s.ok ? '✔' : '✘'} passo ${s.i} ${s.action}${s.value !== undefined ? ' → ' + JSON.stringify(s.value).slice(0, 200) : ''}${s.detail ? ' (' + s.detail + ')' : ''}`);
    for (const e of b.errors.slice(0, 15)) L.push(`  ERRORE ${e.type}: ${e.text}`);
    if (b.fatal) L.push(`  FATALE: ${b.fatal}`);
    if (b.screenshots.length) L.push(`Screenshot: ${b.screenshots.join(', ')}`);
  }
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const r = await runGameTests(opts);
  console.log(opts.json ? JSON.stringify(r, null, 2) : summarize(r));
  process.exit(r.verdict === 'PASS' ? 0 : 1);
}
