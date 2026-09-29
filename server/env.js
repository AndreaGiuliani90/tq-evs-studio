// Carica .env dello Studio (se c'è) senza dipendenze. Le variabili già presenti nell'ambiente vincono.
import fs from 'node:fs';

export function loadEnvFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const c = line.match(/^\s*#\s*((?:OPENAI|GEMINI|ANTHROPIC)_API_KEY)\s*=\s*(\S{20,})/);
    if (c && !/\.\.\.$/.test(c[2]) && !process.env[c[1]]) console.log(`  ⚠ Nel file .env la riga ${c[1]} ha un # davanti: è disattivata. Togli il # (e lo spazio) e riavvia lo Studio.`);
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return out;
}
