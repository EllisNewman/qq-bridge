// Temporary state only. Never reads production config or connects to QQ/DSH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/memory-store.js';
import { acquireOfflineStateLock } from '../src/state-io.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cli-safety-'));
const scope = 'private:123';
const file = path.join(dir, 'memory/private_123.json');
const run = (...args) => spawnSync(process.execPath, ['scripts/memory-cli.mjs', ...args, '--key', scope,
  '--state-dir', dir], { cwd: root, encoding: 'utf8', timeout: 5000 });
try {
  const store = createMemoryStore({ root: path.join(dir, 'memory'), metaPath: path.join(dir, 'memory/meta.json') });
  const fact = store.addFact(scope, { text: 'bridge retained fact' }).fact;
  fs.writeFileSync(path.join(dir, 'memory/meta.json'), JSON.stringify({ scopes: { [scope]: { conv: 'c_new' } } }));
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify({ conversations: {
    [scope]: { memberImpressions: { user: { traits: ['喜欢白鲸'] } } }
  } }));
  fs.writeFileSync(path.join(dir, 'bridge.lock'), String(process.pid));
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [['add', '--text', 'must not be lost'], ['forget', '--id', fact.id],
    ['pin', '--id', fact.id], ['import-impressions', '--yes']]) {
    const r = run(...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /bridge.lock/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dir, 'memory-maintenance.lock')), false);
  }
  for (const args of [['list'], ['stats'], ['search', '--query', 'bridge'], ['export'],
    ['import-impressions', '--dry-run']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    // A conv mismatch previously caused even `stats` to save and overwrite state.
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  store.pin(scope, fact.id, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).facts.length, 1);
  fs.unlinkSync(path.join(dir, 'bridge.lock'));

  for (const lock of ['memory-restore.lock', 'memory-maintenance.lock']) {
    fs.writeFileSync(path.join(dir, lock), 'fixture');
    assert.equal(run('add', '--text', 'blocked').status, 1);
    assert.equal(fs.readFileSync(path.join(dir, lock), 'utf8'), 'fixture');
    fs.unlinkSync(path.join(dir, lock));
  }
  const release = acquireOfflineStateLock(dir);
  assert.throws(() => acquireOfflineStateLock(dir), /EEXIST/);
  release();
  assert.equal(run('add', '--text', 'offline fact').status, 0);
  assert.equal(run('add').status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'memory-maintenance.lock')), false, 'invalid args release lock');
  assert.ok(JSON.parse(fs.readFileSync(file)).facts.some(f => f.text === 'offline fact'));

  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    const result = write(target, ...args);
    if (target === path.join(dir, 'memory-maintenance.lock')) write(path.join(dir, 'bridge.lock'), 'fixture');
    return result;
  };
  try { assert.throws(() => acquireOfflineStateLock(dir), /bridge.lock/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(path.join(dir, 'memory-maintenance.lock')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.lock'), 'utf8'), 'fixture');
  console.log('PASS CLI single writer: online mutations refused, reads never save, offline writes and lock races');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const h = await bridgeHarness();
try {
  const stateDir = path.join(h.temp, 'state');
  const bridgeLock = path.join(stateDir, 'bridge.lock');
  const maintenanceLock = path.join(stateDir, 'memory-maintenance.lock');
  fs.unlinkSync(bridgeLock);
  fs.writeFileSync(maintenanceLock, 'fixture');
  assert.throws(() => h.acquireLock(), /维护/);
  assert.equal(fs.existsSync(bridgeLock), false);
  fs.unlinkSync(maintenanceLock);
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    const result = write(target, ...args);
    if (target === bridgeLock) write(maintenanceLock, 'fixture');
    return result;
  };
  try { assert.throws(() => h.acquireLock(), /维护/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(bridgeLock), false, 'startup rolls back own lock if offline writer raced');
  assert.equal(fs.readFileSync(maintenanceLock, 'utf8'), 'fixture');
  console.log('PASS bridge startup refuses maintenance, including lock acquisition races');
} finally { await h.close(); }
