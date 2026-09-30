// L'UFFICIO come dati + il lavoro del Responsabile dell'ufficio.
//   - layout: config/office.default.json, personalizzato in data/office.json
//   - ogni modifica del Responsabile passa da una cartella di lavoro (data/office-workspace/<task>/), viene
//     controllata e poi applicata; la versione precedente finisce in data/office-history/ (pulsante "Annulla")
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeFileAtomic, ensureDir, now } from './util.js';

export const STATION_KINDS = ['pc', 'tv', 'typewriter', 'easel', 'drafting', 'audio', 'library', 'puzzle', 'manager', 'table'];
export const DECOR_TYPES = ['window', 'banner', 'noticeboard', 'map', 'clock', 'lantern', 'bookcase', 'shelf', 'frame', 'rug', 'plant', 'tallplant', 'floorlamp', 'crates', 'sideboard', 'bench', 'costboard', 'coffee', 'watercooler', 'sofa', 'armchair', 'coffeetable', 'arcade', 'chesstable'];
const LOOK_FIELDS = ['skin', 'hair', 'eyes', 'shirt', 'accColor', 'hairStyle', 'outfit', 'facial', 'accessory'];

export class OfficeStore {
  constructor({ studioDir, dataDir, events }) {
    this.defFile = path.join(studioDir, 'config', 'office.default.json');
    this.file = path.join(dataDir, 'office.json');
    this.historyDir = path.join(dataDir, 'office-history');
    this.wsRoot = path.join(dataDir, 'office-workspace');
    this.paintFile = path.join(dataDir, 'office-paint.json');
    this.paintDir = path.join(dataDir, 'office-paint');
    this.events = events;
    this.migrate();
  }

  // una pianta nuova dello Studio (layoutVersion più alta) sostituisce l'ufficio personalizzato, che resta nella
  // cronologia: "↶ Annulla ultimo arredo" lo riporta com'era
  migrate() {
    const def = readJSON(this.defFile, {}), own = readJSON(this.file, null);
    if (!own || (own.layoutVersion || 1) >= (def.layoutVersion || 1)) return;
    ensureDir(this.historyDir);
    writeFileAtomic(path.join(this.historyDir, `${Date.now()}.json`), JSON.stringify({ at: now(), note: `ufficio prima della pianta v${def.layoutVersion}`, office: own, avatars: {} }, null, 2));
    fs.renameSync(this.file, `${this.file}.v${own.layoutVersion || 1}.bak`);
    this.migrated = true;
  }

  get() {
    const def = readJSON(this.defFile, {});
    const own = readJSON(this.file, null);
    const o = own ? { ...def, ...own, room: { ...def.room, ...(own.room || {}) } } : def;
    // la lavagna delle spese c'è sempre (anche negli uffici personalizzati prima che esistesse)
    if (Array.isArray(o.decor) && !o.decor.some((d) => d.type === 'costboard')) {
      const board = (def.decor || []).find((d) => d.type === 'costboard') || { type: 'costboard', wall: 'L', at: 7.1, w: 2.2 };
      o.decor = [...o.decor.filter((d) => !(d.type === 'frame' && d.wall === board.wall && d.at >= board.at - 0.3 && d.at < board.at + (board.w || 2.2))), board];
    }
    return o;
  }

  validate(o) {
    const errs = [];
    if (!o || typeof o !== 'object') return ['il file non è un oggetto JSON'];
    const r = o.room || {};
    if (!(r.w >= 6 && r.w <= 32 && r.d >= 6 && r.d <= 32)) errs.push('room.w e room.d devono stare fra 6 e 32');
    if (!Array.isArray(o.stations)) errs.push('stations deve essere un elenco');
    if (!Array.isArray(o.decor)) errs.push('decor deve essere un elenco');
    for (const s of o.stations || []) {
      if (!STATION_KINDS.includes(s.kind)) errs.push(`postazione di tipo sconosciuto: ${s.kind}`);
      if (s.kind === 'table' ? !(Number.isFinite(s.x) && Number.isFinite(s.y)) : !(['R', 'L'].includes(s.wall) && Number.isFinite(s.at))) errs.push(`postazione ${s.agent || '?'}: coordinate mancanti`);
    }
    for (const d of o.decor || []) if (!DECOR_TYPES.includes(d.type)) errs.push(`arredo di tipo sconosciuto: ${d.type}`);
    return errs;
  }

  // sfondo dipinto dell'ufficio (ridipintura di Cosetta): immagine + dove sta la stanza nell'immagine + impronta della pianta
  paint() { return readJSON(this.paintFile, null); }
  setPaint(p) { if (p) writeFileAtomic(this.paintFile, JSON.stringify(p, null, 2)); else if (fs.existsSync(this.paintFile)) fs.renameSync(this.paintFile, `${this.paintFile}.tolto`); this.events?.emit('office.updated', {}); }

  snapshot(agents) {
    ensureDir(this.historyDir);
    const f = path.join(this.historyDir, `${Date.now()}.json`);
    const avatars = Object.fromEntries(agents.list().map((a) => [a.id, a.avatar]));
    writeFileAtomic(f, JSON.stringify({ at: now(), office: this.get(), avatars, paint: this.paint() }, null, 2));
    return f;
  }

  // ciò che si salva è l'ufficio scelto: vale come "pianta attuale" (non verrà sostituito da una migrazione)
  save(o) {
    const v = readJSON(this.defFile, {}).layoutVersion || 1;
    writeFileAtomic(this.file, JSON.stringify({ ...o, layoutVersion: Math.max(o.layoutVersion || 1, v) }, null, 2));
    this.events?.emit('office.updated', {});
  }

  undo(agents) {
    if (!fs.existsSync(this.historyDir)) throw new Error('nessuna modifica da annullare');
    const files = fs.readdirSync(this.historyDir).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) throw new Error('nessuna modifica da annullare');
    const last = path.join(this.historyDir, files.at(-1));
    const snap = readJSON(last, null);
    if (!snap) throw new Error('copia di sicurezza illeggibile');
    this.save(snap.office);
    if ('paint' in snap) { if (snap.paint) writeFileAtomic(this.paintFile, JSON.stringify(snap.paint, null, 2)); else if (fs.existsSync(this.paintFile)) fs.renameSync(this.paintFile, `${this.paintFile}.tolto`); }
    for (const [id, av] of Object.entries(snap.avatars || {})) if (agents.get(id)) agents.update(id, { avatar: { ...av, userEdited: av?.userEdited ?? false } });
    fs.renameSync(last, `${last}.annullata`);
    return { restoredFrom: snap.at };
  }

  // cartella di lavoro per un task del Responsabile: l'ufficio, gli aspetti degli agenti e la guida
  prepareWorkspace(taskId, agents) {
    const dir = ensureDir(path.join(this.wsRoot, taskId));
    writeFileAtomic(path.join(dir, 'office.json'), JSON.stringify(this.get(), null, 2));
    const looks = agents.list().map((a) => ({ id: a.id, name: a.name, role: a.role, avatar: { type: a.avatar?.type, color: a.avatar?.color, character: a.avatar?.character || {} } }));
    writeFileAtomic(path.join(dir, 'agents-look.json'), JSON.stringify(looks, null, 2));
    writeFileAtomic(path.join(dir, 'GUIDA_UFFICIO.md'), GUIDE);
    return dir;
  }

  // controlla e applica quello che il Responsabile ha scritto nella cartella di lavoro
  apply(dir, agents) {
    const office = readJSON(path.join(dir, 'office.json'), undefined);
    if (office === undefined) throw new Error('office.json non è JSON valido');
    const errs = this.validate(office);
    if (errs.length) throw new Error(`office.json non valido: ${errs.join('; ')}`);
    const looks = readJSON(path.join(dir, 'agents-look.json'), []);
    const before = JSON.stringify(this.get());
    const changedAvatars = [];
    this.snapshot(agents);
    if (JSON.stringify(office) !== before) this.save(office);
    for (const l of Array.isArray(looks) ? looks : []) {
      const a = agents.get(l.id); if (!a || !l.avatar) continue;
      const ch = Object.fromEntries(Object.entries(l.avatar.character || {}).filter(([k]) => LOOK_FIELDS.includes(k)));
      const next = { ...(a.avatar || {}), character: { ...(a.avatar?.character || {}), ...ch } };
      if (l.avatar.color) next.color = l.avatar.color;
      if (l.avatar.type && ['pixel', 'emoji', 'image', 'spritesheet'].includes(l.avatar.type)) next.type = l.avatar.type;
      if (JSON.stringify(next) !== JSON.stringify(a.avatar)) { agents.update(a.id, { avatar: next }); changedAvatars.push(a.id); }
    }
    return { officeChanged: JSON.stringify(office) !== before, changedAvatars };
  }
}

export const GUIDE = `# GUIDA DELL'UFFICIO (per il Responsabile dell'ufficio)

Nella cartella trovi due file da modificare. Lo Studio li controlla e li applica quando hai finito; la versione
precedente resta salvata (l'utente può annullare con un clic).

## office.json — la stanza
- \`room\`: { w, d, wallH } — larghezza lungo la parete destra (x), profondità lungo la parete sinistra (y), altezza
  pareti in pixel. w e d fra 6 e 32 (la stanza grande è 24×20: lo Studio adatta la tela e si può zoomare).
- Coordinate: il pavimento è una griglia di caselle isometriche. x cresce lungo la parete **destra (R)**, y lungo la
  parete **sinistra (L)**. L'angolo in fondo è (0,0); la parte vicina a chi guarda ha x e y grandi.
- \`stations\` — le postazioni degli agenti (una per agente, campo \`agent\` = id):
  - a parete: { agent, wall: "R"|"L", at: posizione lungo la parete, b0: distanza dalla parete (0 = contro il muro),
    kind }. Una postazione occupa circa 3 caselle lungo la parete e 2,5 di profondità.
  - tavolo: { agent, kind: "table", x, y } (la Regia).
  - kind: ${STATION_KINDS.join(', ')}
  - \`spare: true\` = postazione libera per nuovi agenti.
- \`decor\` — arredi. A parete ({ type, wall, at, w?, … }) oppure a pavimento ({ type, x, y, … }):
  - window { w } · banner { w, text (MAIUSCOLO, lettere A-Z 0-9) } · noticeboard { w, title } · map { w } · clock ·
    lantern · costboard { w } (la lavagna delle spese: il contenuto lo scrive lo Studio) · bookcase { w, h } · shelf { w, z } · frame { w, z, h, picture: "borgo"|"foto"|"tq" }
  - rug { x, y, w, d } · plant { x, y, size } · tallplant { x, y, size } · floorlamp { x, y } · crates { x, y } ·
    sideboard { x, y } · bench { x, y }
  - angolo relax: coffee { x, y } (bancone con macchinetta del caffè) · watercooler { x, y } · sofa { x, y, w, rot: 0|1, color } ·
    armchair { x, y, rot, color } · coffeetable { x, y } · arcade { x, y, color } · chesstable { x, y } (scacchiera)
    rot = lato dello schienale: 0 verso la parete destra, 1 verso la sinistra, 2 e 3 verso chi guarda. Divano e poltrone
    vanno rivolti verso il tavolino, non contro il muro. Chi è libero va a sedersi lì da solo (pause: caffè, telefono, scacchi).
- Evita sovrapposizioni: lascia almeno mezza casella fra i mobili; niente fuori dalla stanza.

## agents-look.json — l'aspetto dei personaggi
Per ogni agente puoi cambiare \`avatar.color\` (colore di riferimento) e \`avatar.character\`:
- skin, hair, eyes, shirt, accColor: colori "#rrggbb"
- hairStyle: short | spiky | long | bob | ponytail | bun | curly | bald
- outfit: tee | shirt | hoodie | sweater | apron | labcoat | vest
- facial: none | beard | moustache | stubble
- accessory: none | glasses | headphones | beret | cap | headband | earrings
Non cambiare id, nome o ruolo degli agenti (quelli li decide l'utente).

## Stile
Pixel art calda e accogliente ("cozy"), sede della Pro Loco di un borgo italiano: legno, cotto, lanterne, piante,
bacheche con locandine, cassette di birra. Colori armonizzati: pochi accenti saturi.
`;
