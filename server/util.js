import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const now = () => new Date().toISOString();

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

// Scrittura atomica: file temporaneo + rename (niente JSON a metà se il processo muore)
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function slug(s, max = 32) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'x';
}

export function truncate(s, n = 4000) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…[troncato: ${s.length - n} caratteri]` : s;
}

// Esegue un comando e raccoglie l'output (senza shell: niente problemi di quoting)
export function run(cmd, args, { cwd, env, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { cwd, env: env || process.env }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); return; }
    const timer = setTimeout(() => { if (!done) { child.kill('SIGTERM'); err += `\n[timeout dopo ${timeoutMs}ms]`; } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e.message || e); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
    if (input != null) { child.stdin.write(input); }
    child.stdin.end();
  });
}

// Estrae l'ultimo blocco JSON da un testo (```json … ``` oppure l'ultimo {...} bilanciato)
export function extractJSON(text) {
  if (!text) return null;
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const f of fences.reverse()) { try { return JSON.parse(f); } catch { /* prova il prossimo */ } }
  const s = String(text);
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (s[i] === '}') depth++;
      else if (s[i] === '{') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, end + 1)); } catch { break; } } }
    }
  }
  return null;
}

export function which(bin) {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* avanti */ }
  }
  return null;
}

// taglio corto per titoli ed etichette
export function clip(s, n = 80) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
