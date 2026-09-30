// Foto della maquette dell'ufficio (stanza + mobili, niente personaggi) con il Chromium di Playwright.
// Le pagine si servono da web/ senza server: così funziona anche mentre lo Studio sta lavorando.
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

export async function officeSnapshot({ webDir, layout, out, scale = 2 }) {
  const { chromium } = await import('playwright');
  let browser;
  for (const opts of [{ channel: 'chromium' }, {}, { channel: 'chrome' }]) { try { browser = await chromium.launch(opts); break; } catch { /* prossimo */ } }
  if (!browser) throw new Error('Chromium di Playwright non disponibile (npx playwright install chromium)');
  try {
    const page = await browser.newPage();
    await page.route('http://studio.local/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/api/office') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(layout) });
      const f = path.join(webDir, path.normalize(u.pathname).replace(/^([/\\])+/, ''));
      if (!f.startsWith(webDir) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    });
    await page.goto(`http://studio.local/office-snapshot.html?scale=${scale}`);
    await page.waitForFunction(() => window.__shot, null, { timeout: 30000 });
    const shot = await page.evaluate(() => window.__shot);
    if (shot.error) throw new Error(`maquette: ${shot.error}`);
    fs.writeFileSync(out, Buffer.from(shot.dataURL.split(',')[1], 'base64'));
    delete shot.dataURL;
    return { file: out, ...shot };
  } finally { await browser.close(); }
}
