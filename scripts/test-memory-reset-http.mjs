import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const h = await bridgeHarness();
const server = h.startConsoleServer();
if (!server.listening) await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(route, body = {}, extra = {}) {
  const r = await fetch(base + route, {method:'POST', headers:{'content-type':'application/json','x-console-token':'fixture-console-token', ...extra}, body:JSON.stringify(body)});
  return {status:r.status, data:await r.json()};
}
try {
  const sid = await h.ensureSession('private:123');
  h.cfg.memory.enabled = false;
  assert.equal((await call('/api/memory/distill', {key:'private:123'})).status, 403);
  h.cfg.memory.enabled = true;
  let result = await call('/api/memory/reset', {scope:'session',key:'private:123',dryRun:true});
  assert.equal(result.data.dryRun, true);
  assert.equal(h.state.sessions['private:123'], sid);
  assert.equal(result.data.backupDir, null);
  result = await call('/api/memory/restore');
  assert.equal(result.status, 409);
  const stop = h.api.stopSessionWork;
  h.api.stopSessionWork = async () => {throw new Error('injected stop failure');};
  result = await call('/api/memory/reset', {scope:'session',key:'private:123'});
  assert.equal(result.status, 503);
  assert.equal(h.state.sessions['private:123'], sid);
  assert.ok(result.data.backupDir);
  h.api.stopSessionWork = stop;
  const list = h.api.sessions.list;
  h.api.sessions.list = async () => {throw new Error('offline');};
  result = await call('/api/workspace/reset');
  assert.equal(result.status, 503);
  assert.equal(h.state.sessions['private:123'], sid);
  h.api.sessions.list = list;
  result = await call('/api/memory/reset', {scope:'session',key:'private:123'});
  assert.equal(result.status, 200);
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.ok(h.calls.cancelled.includes(sid));
  assert.ok(h.calls.archived.includes(sid));
  console.log('PASS M3 HTTP: dry-run, offline, stop failure, backup, reset and restore refusal');
} finally {
  await new Promise(r => server.close(r));
  await h.close();
}
