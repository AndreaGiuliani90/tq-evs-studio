// Memoria di progetto strutturata (non la cronologia della chat).
// Documenti curati, versionati con git: docs/memoria/<NOME>.md
//   PROJECT_STATE · ARCHITECTURE · GAME_DESIGN · NARRATIVE_BIBLE · PUZZLES · DECISIONS · KNOWN_ISSUES · ASSETS
// Documenti generati dallo stato dello Studio (non versionati): .docs/memoria/TASKS.md · AGENT_ACTIVITY.md
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './util.js';

export const CURATED = ['PROJECT_STATE', 'ARCHITECTURE', 'GAME_DESIGN', 'NARRATIVE_BIBLE', 'PUZZLES', 'DECISIONS', 'KNOWN_ISSUES', 'ASSETS'];
export const GENERATED = ['TASKS', 'AGENT_ACTIVITY'];

export class Knowledge {
  constructor({ projectRoot, dataDir, events }) {
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.events = events;
  }

  rel(name) { return `docs/memoria/${name}.md`; }
  file(name, root = this.projectRoot) {
    if (GENERATED.includes(name)) return path.join(this.dataDir, 'memory', `${name}.md`);
    return path.join(root, 'docs', 'memoria', `${name}.md`);
  }

  list(root = this.projectRoot) {
    return [...CURATED, ...GENERATED].map((name) => {
      const f = this.file(name, root);
      let st = null; try { st = fs.statSync(f); } catch { /* manca */ }
      return { name, path: GENERATED.includes(name) ? `.docs/memoria/${name}.md` : this.rel(name), generated: GENERATED.includes(name), exists: !!st, bytes: st?.size ?? 0, updatedAt: st?.mtime ?? null };
    });
  }

  read(name, root = this.projectRoot) {
    if (![...CURATED, ...GENERATED].includes(name)) throw new Error(`documento sconosciuto: ${name}`);
    try { return fs.readFileSync(this.file(name, root), 'utf8'); } catch { return ''; }
  }

  write(name, content, root = this.projectRoot) {
    if (!CURATED.includes(name)) throw new Error('si possono modificare solo i documenti curati');
    writeFileAtomic(this.file(name, root), content);
    this.events?.emit('memory.updated', { name });
  }

  // Contesto per un agente: solo i documenti pertinenti al suo ruolo (percorsi + estratto)
  contextFor(agent, root, { inline = false, maxPerDoc = 6000 } = {}) {
    const docs = (agent.contextDocs || []).filter((n) => CURATED.includes(n));
    if (!inline) return docs.map((n) => `- ${this.rel(n)}`).join('\n');
    return docs.map((n) => {
      const t = this.read(n, root);
      return `### ${n} (${this.rel(n)})\n${t.length > maxPerDoc ? t.slice(0, maxPerDoc) + '\n…[troncato]' : t}`;
    }).join('\n\n');
  }

  // Rigenera TASKS.md e AGENT_ACTIVITY.md dallo stato
  regenerate(state) {
    const tasks = Object.values(state.tasks).sort((a, b) => a.id.localeCompare(b.id));
    const reqs = Object.values(state.requests).sort((a, b) => b.id.localeCompare(a.id));
    const L = ['# TASKS (generato dallo Studio — non modificare a mano)', ''];
    for (const r of reqs.slice(0, 40)) {
      L.push(`## ${r.id} — ${r.status} — ${String(r.text).slice(0, 90)}`);
      if (r.branch) L.push(`branch: \`${r.branch}\``);
      for (const t of tasks.filter((x) => x.requestId === r.id)) L.push(`- [${t.status}] ${t.id} (${t.agentId}, ${t.kind}) ${t.title}${t.dependsOn?.length ? ` ← ${t.dependsOn.join(', ')}` : ''}${t.result?.verdict ? ` · ${t.result.verdict}` : ''}${t.result?.commit ? ` · ${t.result.commit.short}` : ''}`);
      L.push('');
    }
    writeFileAtomic(this.file('TASKS'), L.join('\n'));
    const A = ['# AGENT_ACTIVITY (generato dallo Studio)', ''];
    for (const a of Object.values(state.agents)) {
      A.push(`## ${a.name} (${a.id}) — ${a.role} — ${a.runtime?.status}`);
      for (const h of (a.runtime?.history || []).slice(-15)) A.push(`- ${h.ts} [${h.status}] ${h.taskId || ''} ${h.text}`);
      A.push('');
    }
    writeFileAtomic(this.file('AGENT_ACTIVITY'), A.join('\n'));
  }
}
