// Pubblicazione online: stato rispetto a GitHub (qui un repository "remoto" finto), pubblica fino a una versione, mai --force
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixtureRepo, ScriptedProvider, registryWith, studioFor, sh, waitFor } from './helpers.js';

const bump = (root, v, msg) => { fs.writeFileSync(path.join(root, 'src/version.js'), `export const VERSION = '${v}';\n`); sh(root, 'commit', '-qam', msg); };

test('deploy: cosa manca online, pubblica fino a una versione e poi tutto; non sovrascrive GitHub', async () => {
  const root = makeFixtureRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-remote-'));
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', bare);
  sh(root, 'push', '-q', 'origin', 'main');
  bump(root, '0.2.0', 'Studio: unisce R-0001 — prima');
  const mid = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'commit', '-q', '--allow-empty', '-m', 'ritocco senza versione nuova');
  bump(root, '0.3.0', 'Studio: unisce R-0002 — seconda');
  const st = await studioFor(root, registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));

  let d = await st.deploy.status({ fetch: true });
  assert.equal(d.ok, true);
  assert.equal(d.local.version, '0.3.0');
  assert.equal(d.online.version, '0.1.0');
  assert.equal(d.ahead, 3);
  assert.deepEqual(d.pending.filter((p) => p.versionHead).map((p) => p.version), ['0.3.0', '0.2.0']);
  assert.equal(d.pending.find((p) => p.version === '0.3.0').request, 'R-0002');

  // fino alla 0.2.0 (il commit più recente con quel numero)
  const head020 = d.pending.find((p) => p.version === '0.2.0' && p.versionHead).hash;
  const r = await st.deploy.publish({ commit: head020 });
  assert.equal(r.version, '0.2.0');
  await waitFor(() => !st.deploy.running, 20000, 'push');
  assert.equal(sh(bare, 'rev-parse', 'main'), head020);
  assert.notEqual(head020, mid);
  d = await st.deploy.status();
  assert.equal(d.online.version, '0.2.0');
  assert.equal(d.ahead, 1);
  assert.equal(d.ledger[0].ok, true);
  assert.ok(st.store.data.chat.some((m) => /pubblicata su GitHub/.test(m.text)));

  // tutto
  await st.deploy.publish();
  await waitFor(() => !st.deploy.running, 20000, 'push 2');
  assert.equal((await st.deploy.status()).ahead, 0);
  await assert.rejects(st.deploy.publish(), /già online/);

  // qualcuno ha spinto su GitHub da un altro computer: niente sovrascritture
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-other-'));
  sh(other, 'clone', '-q', bare, '.'); sh(other, 'config', 'user.email', 'x@x'); sh(other, 'config', 'user.name', 'x');
  fs.writeFileSync(path.join(other, 'altro.txt'), 'x'); sh(other, 'add', '-A'); sh(other, 'commit', '-qm', 'altrove'); sh(other, 'push', '-q', 'origin', 'main');
  bump(root, '0.4.0', 'locale');
  await assert.rejects(st.deploy.publish(), /non sovrascrivo/);
  d = await st.deploy.status({ fetch: true });
  assert.equal(d.behind, 1);
});

test('deploy: senza repository remoto lo dice', async () => {
  const st = await studioFor(makeFixtureRepo(), registryWith(new ScriptedProvider('mock', () => ({ text: 'ok' }))));
  const d = await st.deploy.status();
  assert.equal(d.ok, false);
  assert.match(d.error, /repository remoto/);
});
