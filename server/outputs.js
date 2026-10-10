// I RISULTATI DA CONSEGNARE: quando chiedi un export o un file, nel rapporto compaiono pulsanti per scaricarlo
// (le cartelle come zip), aprirlo nel browser o mostrarlo nel Finder.
// Cosa conta come "da consegnare": quello che gli agenti dichiarano in "outputs", più le cartelle di export
// (export/, out/, deliverables/ …) toccate dalla richiesta.
export const OUT_DIRS = ['export', 'exports', 'out', 'output', 'outputs', 'deliverables', 'consegne', 'download', 'downloads'];
const clean = (p) => String(p || '').trim().replace(/^\.?\/+/, '').replace(/\\/g, '/');
export const safeRel = (p) => { const c = clean(p); return c && !c.split('/').includes('..') ? c : null; };

export function detectOutputs(files = [], declared = []) {
  const names = files.map((f) => clean(f?.file ?? f)).filter(Boolean);
  const out = new Map();
  const add = (p, kind) => {
    p = safeRel(p); if (!p) return;
    const dir = kind === 'dir' || p.endsWith('/') || !names.includes(p);
    const key = dir ? p.replace(/\/?$/, '/') : p;
    if ([...out.keys()].some((k) => k.endsWith('/') && key.startsWith(k) && k !== key)) return;   // già dentro una cartella elencata
    for (const k of [...out.keys()]) if (key.endsWith('/') && k.startsWith(key) && k !== key) out.delete(k);
    out.set(key, { path: key, kind: dir ? 'dir' : 'file', count: dir ? names.filter((n) => n.startsWith(key)).length : 1 });
  };
  for (const d of declared) add(d?.path ?? d, d?.kind);
  for (const n of names) {
    const parts = n.split('/');
    if (parts.length >= 2 && OUT_DIRS.includes(parts[0].toLowerCase())) add(parts.length > 2 ? `${parts[0]}/${parts[1]}/` : n);
  }
  return [...out.values()].filter((o) => o.kind === 'file' || o.count > 0 || declared.length).slice(0, 12);
}
