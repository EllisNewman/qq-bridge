import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { atomicWriteJson } from '../src/state-io.js';

const key = 'private:123';
const success = value => ({ result: { ok: true, value } });
const denied = () => ({ result: { ok: false, error: { code: 'fixture/denied', message: 'injected archive failure' } } });
async function test(name, fn, options) {
  const h = await bridgeHarness(options);
  h.cfg.memory.distill.enabled = false;
  h.api.sessions.list = async () => success({ items: [] });
  h.api.pageSession = async () => success({ messages: [] });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body = {}, headers = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try { await fn(h, call, base); console.log(`PASS ${name}`); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}
async function seed(h, target = key) {
  const sid = await h.ensureSession(target);
  const st = h.getSocialV2State(target);
  st.recentMessages.push({ text: '明天去动物园看白鲸', isSelf: false });
  const fact = h.memoryStore.addFact(target, { text: '喜欢白鲸' }).fact;
  h.archiveStore.append(target, { text: '此前消息' });
  return { sid, st, fact, token: st.agentToken, conv: h.archiveStore.getMeta(target).conv };
}
function assertPreserved(h, original) {
  assert.equal(h.state.sessions[key], original.sid);
  assert.equal(h.getSocialV2State(key), original.st);
  assert.equal(original.st.agentToken, original.token);
  assert.equal(h.memoryStore.listFacts(key)[0].id, original.fact.id);
  assert.equal(h.archiveStore.getMeta(key).conv, original.conv);
}
function assertBackup(h, dir, sid) {
  assert.ok(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'))).sessions[key], sid);
  assert.ok(fs.existsSync(path.join(dir, 'memory/private_123.json')));
}

const routes = [
  ['/api/memory/reset', { scope: 'session', key }],
  ['/api/session/reset', { key }],
  ['/api/socialV2/reset', {}],
  ['/api/workspace/reset', {}]
];
for (const [route, body] of routes) {
  for (const failure of ['stop-throw', 'stop-envelope', 'archive-envelope']) {
    await test(`${route} preserves state on ${failure}`, async (h, call) => {
      const original = await seed(h);
      if (failure === 'stop-throw') h.api.stopSessionWork = async () => { throw new Error('injected stop failure'); };
      if (failure === 'stop-envelope') h.api.stopSessionWork = async () => denied();
      if (failure === 'archive-envelope') h.api.workspace.archiveSession = async () => denied();
      const result = await call(route, body);
      assert.equal(result.status, 503, JSON.stringify(result));
      assert.equal(result.data.ok, false);
      assert.ok(result.data.errors.length);
      assertPreserved(h, original);
      assertBackup(h, result.data.backupDir, original.sid);
      if (failure.startsWith('stop-')) assert.equal(h.calls.archived.length, 0, 'do not archive after failed stop');
    });
  }
}
for (const [route, body] of routes.slice(1)) {
  await test(`${route} backs up before control, retains long-term memory and writes handoff`, async (h, call) => {
    const original = await seed(h);
    const stop = h.api.stopSessionWork;
    h.api.stopSessionWork = async sid => {
      assert.ok(fs.readdirSync(path.join(h.temp, 'state/backups')).length, 'backup must precede stop');
      return stop(sid);
    };
    const result = await call(route, body);
    assert.equal(result.status, 200, JSON.stringify(result));
    assertBackup(h, result.data.backupDir, original.sid);
    assert.equal(h.state.sessions[key], undefined);
    assert.equal(h.memoryStore.listFacts(key)[0].id, original.fact.id);
    assert.equal(h.archiveStore.getMeta(key).conv, original.conv);
    assert.match(h.memoryStore.snapshot(key).handoff.text, /动物园/);
    assert.notEqual(h.getSocialV2State(key).agentToken, original.token);
  });
}
for (const route of ['/api/socialV2/reset', '/api/workspace/reset']) {
  await test(`${route} retains all local mappings on partial remote failure`, async (h, call) => {
    const original = await seed(h);
    const group = await h.ensureSession('group:456');
    h.api.workspace.archiveSession = async ({ sessionId }) => sessionId === group ? denied() : success({});
    const result = await call(route);
    assert.equal(result.status, 503);
    assertPreserved(h, original);
    assert.equal(h.state.sessions['group:456'], group);
  });
}
await test('memory reset retains per-scope partial-success reporting', async (h, call) => {
  const original = await seed(h);
  h.cfg.allow.private.push('124');
  const other = await seed(h, 'private:124');
  h.api.workspace.archiveSession = async ({ sessionId }) => sessionId === original.sid ? denied() : success({});
  const result = await call('/api/memory/reset', { scope: 'private' });
  assert.equal(result.status, 503);
  assertPreserved(h, original);
  assert.equal(h.state.sessions['private:124'], undefined);
  assert.equal(h.memoryStore.stats('private:124').active, 0);
  assert.notEqual(h.archiveStore.getMeta('private:124').conv, other.conv);
  assert.deepEqual(result.data.archived, [other.sid]);
});
for (const command of ['/reset', '/new']) {
  for (const fail of [true, false]) {
    await test(`QQ ${command}: ${fail ? 'failure preserves state' : 'success is backed up'}`, async h => {
      const original = await seed(h);
      if (fail) h.api.workspace.archiveSession = async () => denied();
      await h.handleIncoming('private', 123, { user_id: 123, message_id: 9001,
        message: [{ type: 'text', data: { text: command } }] }, h.cfg);
      if (fail) { assertPreserved(h, original); assert.match(h.calls.sent.at(-1).text, /重置失败/); }
      else { assert.equal(h.state.sessions[key], undefined); assert.match(h.calls.sent.at(-1).text, /已重置会话/); }
      const backups = fs.readdirSync(path.join(h.temp, 'state/backups'));
      assertBackup(h, path.join(h.temp, 'state/backups', backups[0]), original.sid);
    });
  }
}
await test('reset blocks agent actions and defers inbound messages until commit', async (h, call, base) => {
  h.setMode('reserved2');
  const original = await seed(h);
  h.socialV2.paused = true;
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.api.stopSessionWork = async () => { entered(); await gate; return { removed: 0 }; };
  const resetting = call('/api/session/reset', { key });
  await enteredPromise;
  try {
    await assert.rejects(h.ensureSession(key), /重置/);
    const deniedResponse = await fetch(base + '/api/socialV2/state?key=' + key, {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': original.token }
    });
    assert.equal(deniedResponse.status, 403);
    let received = false;
    const incoming = h.handleIncoming('private', 123, { user_id: 123, message_id: 9002,
      message: [{ type: 'text', data: { text: '重置期间的新消息' } }] }, h.cfg).then(() => { received = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received, false);
    release();
    assert.equal((await resetting).status, 200);
    await incoming;
    assert.ok(h.getSocialV2State(key).unread.some(message => message.text.includes('重置期间的新消息')));
  } finally { release(); await resetting; }
});
await test('queued context reset cannot clear a replacement session', async h => {
  await seed(h);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocking = h.enqueueDistill(() => gate);
  const resetting = h.resetContextSession(key, 'fixture-queued-reset');
  h.state.sessions[key] = 'replacement-session';
  release();
  await blocking;
  await assert.rejects(resetting, error => error.statusCode === 409);
  assert.equal(h.state.sessions[key], 'replacement-session');
  assert.equal(h.memoryStore.stats(key).active, 1);
  assert.equal(h.calls.cancelled.length, 0);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/backups')), false);
});
let failWrites = false;
await test('failed backup prevents all remote and local clearing', async (h, call) => {
  const original = await seed(h);
  const link = path.join(h.temp, 'state/memory/fixture-link');
  fs.symlinkSync(path.join(h.temp, 'state/sessions.json'), link);
  const result = await call('/api/session/reset', { key });
  assert.equal(result.status, 500);
  assertPreserved(h, original);
  assert.equal(h.calls.cancelled.length, 0);
  assert.equal(h.calls.archived.length, 0);
});
await test('failed state flush prevents backup and remote actions', async (h, call) => {
  const original = await seed(h);
  failWrites = true;
  const result = await call('/api/session/reset', { key });
  assert.equal(result.status, 500);
  assertPreserved(h, original);
  assert.equal(h.calls.cancelled.length, 0);
  assert.equal(h.calls.archived.length, 0);
  assert.equal(fs.existsSync(path.join(h.temp, 'state/backups')), false);
  failWrites = false;
}, { globals: { atomicWriteJson: (file, value) => {
  if (failWrites && file.endsWith('social-v2.json')) throw new Error('injected state flush failure');
  return atomicWriteJson(file, value);
} } });
