// Prova rapida dell'interfaccia dello Studio (serve lo Studio acceso):
//   node qa/ui-smoke.mjs [screenshot.png] [url]
import { chromium } from 'playwright';
const out = process.argv[2] || 'studio-ui.png';
const url = process.argv[3] || 'http://localhost:4173/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url);
await p.waitForSelector('.desk', { timeout: 10000 });
await p.waitForTimeout(800);
const desks = await p.$$eval('.desk .name', (n) => n.map((x) => x.textContent));
await p.click('.desk'); await p.waitForSelector('#agent-form');
await p.keyboard.press('Escape');
await p.screenshot({ path: out });
await b.close();
console.log(JSON.stringify({ ok: errs.length === 0 && desks.length > 0, desks, errors: errs, screenshot: out }));
process.exit(errs.length ? 1 : 0);
