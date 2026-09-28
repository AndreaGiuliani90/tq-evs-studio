#!/usr/bin/env node
// Avvio dello Studio: node server/index.js  (di solito tramite ./start-studio.sh)
import path from 'node:path';
import { loadEnvFile } from './env.js';
import { createStudio, createServer, STUDIO_DIR } from './app.js';

loadEnvFile(path.join(STUDIO_DIR, '.env'));

const studio = await createStudio();
const port = Number(process.env.STUDIO_PORT || studio.config.port || 4173);
const host = process.env.STUDIO_HOST || '127.0.0.1';
const server = createServer(studio);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n✘ La porta ${port} è già occupata. Forse lo Studio è già acceso: apri http://localhost:${port}\n  Oppure scegli un'altra porta: STUDIO_PORT=4180 ./start-studio.sh\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(port, host, async () => {
  const prov = await studio.providers.status();
  const text = prov.filter((p) => p.kind === 'text' && p.id !== 'mock');
  console.log(`\n  GAME STUDIO acceso →  http://localhost:${port}\n`);
  console.log(`  Progetto: ${studio.projectRoot}`);
  console.log(`  Dati dello Studio: ${studio.dataDir}`);
  for (const p of prov) console.log(`  Provider ${p.id.padEnd(13)} ${p.ok ? '✔' : '·'} ${p.ok ? (p.version || p.model || p.note || '') : p.reason}`);
  if (!text.some((p) => p.ok)) console.log('\n  ⚠ Nessun provider AI disponibile: lo Studio parte, ma gli agenti non possono lavorare.\n    Installa Claude Code (comando `claude`) oppure metti ANTHROPIC_API_KEY in .env dello Studio');
  console.log('\n  Per spegnere: Ctrl+C (oppure ./stop-studio.sh)\n');
});

const shutdown = () => { studio.store.flush(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
