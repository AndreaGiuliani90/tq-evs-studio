// EFFETTI SONORI (Rumore): due motori, una cache, la rifinitura con ffmpeg e il manifest.
//
//   ElevenLabs Sound Effects v2  → suoni realistici del borgo (passi, porte, campane, ambienti in loop)
//   jsfxr (locale, gratis)       → interfaccia e gameplay retro; i parametri si salvano, così si rigenera o si modifica
//
// Tutto il lavoro sta nello Studio in data/audio/ (fuori da git: il repository dello Studio è pubblico):
//   data/audio/cache/<hash>.*            generazioni grezze (prompt + parametri identici → non si rigenera)
//   data/audio/sfx/<categoria>/<id>/vN.* varianti rifinite (.ogg + .mp3)
//   data/audio/sfx_manifest.json         un record per suono: motore, prompt/parametri, varianti, scelta, stato, licenza
// Nel gioco vanno solo i suoni approvati (con il task di integrazione, su un branch: l'unione la decide l'utente).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, ensureDir, writeFileAtomic, readJSON, now } from './util.js';

export const SFX_CATEGORIES = ['ambient', 'foley', 'ui', 'gameplay', 'vandalismo'];
// volume percepito (LUFS integrati) per categoria: stessi valori dentro la categoria, così nessun suono "salta fuori"
export const SFX_LOUDNESS = { ambient: -26, foley: -19, ui: -20, gameplay: -17, vandalismo: -16 };
export const JSFXR_PRESETS = ['pickupCoin', 'laserShoot', 'explosion', 'powerUp', 'hitHurt', 'jump', 'blipSelect', 'click', 'synth', 'tone', 'random'];
// crediti ElevenLabs per generazione (stima prudente: durata automatica ≈ 200 crediti, a durata fissa ~40 al secondo)
export function elevenCredits(duration) { return duration ? Math.max(40, Math.round(duration * 40)) : 200; }

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 20);
export const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'suono';

// ── ElevenLabs ─────────────────────────────────────────────────────────────────────────────────
export class ElevenLabsSfx {
  constructor({ apiKey, fetchImpl, model } = {}) {
    this.id = 'elevenlabs'; this.kind = 'audio'; this.label = 'ElevenLabs Sound Effects';
    this.apiKey = apiKey ?? process.env.ELEVENLABS_API_KEY ?? '';
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.model = model || process.env.ELEVENLABS_SFX_MODEL || 'eleven_text_to_sound_v2';
    this.format = process.env.ELEVENLABS_SFX_FORMAT || 'mp3_44100_128';
  }
  async available() { return this.apiKey ? { ok: true, model: this.model } : { ok: false, reason: 'ELEVENLABS_API_KEY non impostata nel file .env dello Studio' }; }

  // piano e crediti (serve il permesso "Utente" sulla chiave; se manca, si va avanti senza)
  async subscription() {
    try {
      const r = await this.fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': this.apiKey } });
      if (!r.ok) return { ok: false, error: `API ${r.status}` };
      const j = await r.json();
      const tier = String(j.tier || 'sconosciuto');
      return { ok: true, tier, used: j.character_count ?? null, limit: j.character_limit ?? null, commercial: !/^free$/i.test(tier) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async sound({ text, duration = null, influence = 0.3, loop = false }) {
    if (!this.apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY non impostata', code: 'PROVIDER_UNAVAILABLE' };
    const body = { text, model_id: this.model, loop: !!loop, prompt_influence: influence };
    if (duration) body.duration_seconds = Math.min(30, Math.max(0.5, Number(duration)));
    try {
      const r = await this.fetch(`https://api.elevenlabs.io/v1/sound-generation?output_format=${encodeURIComponent(this.format)}`, {
        method: 'POST', headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body),
      });
      if (!r.ok) { let msg = ''; try { const j = await r.json(); msg = j?.detail?.message || j?.detail?.status || JSON.stringify(j).slice(0, 300); } catch { /* niente */ } return { ok: false, error: `API ${r.status}: ${msg}` }; }
      const buf = Buffer.from(await r.arrayBuffer());
      const cost = Number(r.headers?.get?.('character-cost')) || null;
      return { ok: true, buf, ext: 'mp3', credits: cost };
    } catch (e) { return { ok: false, error: `rete: ${e.message}` }; }
  }
}

// ── jsfxr ──────────────────────────────────────────────────────────────────────────────────────
let jsfxrMod = null;
async function jsfxr() { if (!jsfxrMod) { const m = await import('jsfxr'); jsfxrMod = m.default?.Params ? m.default : m.jsfxr?.Params ? m.jsfxr : m; } return jsfxrMod; }

// tre varianti: il preset (o i parametri dati) + due mutazioni leggere. I parametri restano nel manifest.
export async function jsfxrVariants({ preset = 'blipSelect', params = null, count = 3 }) {
  const { Params } = await jsfxr();
  const base = new Params();
  if (params) base.fromJSON(params); else base[JSFXR_PRESETS.includes(preset) ? preset : 'blipSelect']();
  base.sample_size = 16; base.sound_vol = 0.5;
  const out = [JSON.parse(JSON.stringify(base))];
  for (let i = 1; i < count; i++) { const p = new Params(); p.fromJSON(out[0]); p.mutate(); p.sample_size = 16; p.sound_vol = 0.5; out.push(JSON.parse(JSON.stringify(p))); }
  return out.map((p) => { delete p.oldParams; return p; });
}
export async function jsfxrRender(params) {
  const { sfxr, Params } = await jsfxr();
  const p = new Params(); p.fromJSON(params); p.sample_size = 16;
  return Buffer.from(sfxr.toWave(p).wav);
}

// ── rifinitura con ffmpeg ────────────────────────────────────────────────────────────────────────
let ffmpegOk = null;
export async function hasFfmpeg() { ffmpegOk ??= (await run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 15000 }).catch(() => ({ code: 1 }))).code === 0; return ffmpegOk; }

async function measure(file) {
  // loudness integrata (LUFS); per i suoni brevissimi (< 0,4 s) la misura EBU non esiste: si usa il volume medio
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { timeoutMs: 60000 });
  const m = (r.stderr || '').match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
  let lufs = null, peak = null;
  if (m) { try { const j = JSON.parse(m[0]); lufs = Number(j.input_i); peak = Number(j.input_tp); } catch { /* niente */ } }
  if (!Number.isFinite(lufs) || lufs < -69) {
    const v = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 60000 });
    const mean = Number((v.stderr.match(/mean_volume:\s*(-?[\d.]+)/) || [])[1]), max = Number((v.stderr.match(/max_volume:\s*(-?[\d.]+)/) || [])[1]);
    if (Number.isFinite(mean)) { lufs = mean - 3; peak = Number.isFinite(max) ? max : peak; }   // il volume medio RMS è ~3 dB sopra i LUFS
  }
  return Number.isFinite(lufs) ? { lufs: Math.round(lufs * 10) / 10, peak: Number.isFinite(peak) ? Math.round(peak * 10) / 10 : null } : null;
}
async function durationOf(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], { timeoutMs: 20000 });
  return Number(String(r.stdout).trim()) || null;
}

// taglio dei silenzi (non sui loop), stesso volume percepito per categoria (guadagno lineare + limitatore), dissolvenze
// brevi (non sui loop: la giunzione deve restare continua), esportazione .ogg + .mp3
export async function postProcess(input, outBase, { category = 'foley', loop = false } = {}) {
  ensureDir(path.dirname(outBase));
  if (!(await hasFfmpeg())) {
    const ext = path.extname(input);
    fs.copyFileSync(input, `${outBase}${ext}`);
    return { processed: false, files: { [ext.slice(1)]: `${outBase}${ext}` }, note: 'ffmpeg non installato: suono grezzo' };
  }
  const target = SFX_LOUDNESS[category] ?? -19;
  const trimmed = `${outBase}.tmp.wav`;
  const trim = loop ? 'anull' : 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse';
  let r = await run('ffmpeg', ['-hide_banner', '-y', '-i', input, '-af', trim, '-ar', '44100', trimmed], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`ffmpeg (taglio): ${(r.stderr || '').slice(-300)}`);
  const m = await measure(trimmed);
  const gain = m && Number.isFinite(m.lufs) ? Math.max(-30, Math.min(24, target - m.lufs)) : 0;
  const dur = await durationOf(trimmed);
  const fades = loop || !dur ? '' : `,afade=t=in:d=0.005,afade=t=out:st=${Math.max(0, dur - 0.03).toFixed(3)}:d=0.03`;
  const files = { ogg: `${outBase}.ogg`, mp3: `${outBase}.mp3` };
  const encode = async (g) => {
    const chain = `volume=${g.toFixed(2)}dB,alimiter=limit=0.89:level=false${fades}`;
    let e = await run('ffmpeg', ['-hide_banner', '-y', '-i', trimmed, '-af', chain, '-c:a', 'libvorbis', '-q:a', '5', files.ogg], { timeoutMs: 60000 });
    if (e.code !== 0) throw new Error(`ffmpeg (ogg): ${(e.stderr || '').slice(-300)}`);
    e = await run('ffmpeg', ['-hide_banner', '-y', '-i', trimmed, '-af', chain, '-c:a', 'libmp3lame', '-q:a', '3', files.mp3], { timeoutMs: 60000 });
    if (e.code !== 0) throw new Error(`ffmpeg (mp3): ${(e.stderr || '').slice(-300)}`);
    return measure(files.ogg);
  };
  let after = await encode(gain);
  // i suoni brevi e secchi (clic) perdono volume nel limitatore e nelle dissolvenze: una seconda passata corregge
  if (after && Number.isFinite(after.lufs) && Math.abs(target - after.lufs) > 1) {
    const g2 = Math.max(-30, Math.min(30, gain + (target - after.lufs)));
    if (Math.abs(g2 - gain) > 0.3) after = await encode(g2);
  }
  try { fs.unlinkSync(trimmed); } catch { /* pazienza */ }
  return { processed: true, files, durationSec: await durationOf(files.ogg), lufs: after?.lufs ?? null, peak: after?.peak ?? null, target };
}

// ── archivio: cache + manifest ─────────────────────────────────────────────────────────────────
export class SfxStore {
  constructor(dataDir) {
    this.root = ensureDir(path.join(dataDir, 'audio'));
    this.cacheDir = ensureDir(path.join(this.root, 'cache'));
    this.file = path.join(this.root, 'sfx_manifest.json');
  }
  manifest() { return readJSON(this.file, { version: 1, sounds: {} }); }
  save(m) { m.updatedAt = now(); writeFileAtomic(this.file, JSON.stringify(m, null, 2)); }
  get(id) { return this.manifest().sounds[id] || null; }
  upsert(entry) { const m = this.manifest(); m.sounds[entry.id] = { ...(m.sounds[entry.id] || {}), ...entry, updatedAt: now() }; this.save(m); return m.sounds[entry.id]; }

  // cache: stessa richiesta → stesso file, niente nuova generazione (e niente crediti)
  cacheKey(o) { return hash(o); }
  cached(key) { const f = fs.readdirSync(this.cacheDir).find((x) => x.startsWith(`${key}.`)); return f ? path.join(this.cacheDir, f) : null; }
  putCache(key, buf, ext) { const f = path.join(this.cacheDir, `${key}.${ext}`); fs.writeFileSync(f, buf); return f; }
  dirFor(category, id) { return ensureDir(path.join(this.root, 'sfx', SFX_CATEGORIES.includes(category) ? category : 'foley', id)); }
  url(file) { return `/audio/${path.relative(this.root, file).split(path.sep).map(encodeURIComponent).join('/')}`; }
}
