import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConversationContext, contextPreview, recentExchangeGroups, orderContextMessages, CONTEXT_LIMIT, ORIGINAL_MAX_CHARS } from '../src/conversation-context.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('originals survive restart, isolate conversations and token generations, and bound retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-originals-'));
  try {
    const store = createConversationContext(root);
    const text = '头部。' + '长文中间的条件。'.repeat(500) + '最后一个条件。';
    const first = store.append('private:123', 'generation-1', { text, seq: 1 });
    assert.equal(createConversationContext(root).find('private:123', 'generation-1', first.contextRef).text, text);
    assert.equal(store.find('private:456', 'generation-1', first.contextRef), null);
    assert.equal(store.find('private:123', 'generation-2', first.contextRef), null);
    const preview = contextPreview(first);
    assert.equal(preview.textTruncated, true);
    assert.ok(preview.text.includes('最后一个条件'));
    assert.equal(store.read('private:123', 'generation-1', first, 100, text.length), false);
    assert.equal(store.read('private:123', 'generation-1', first, 0, 100), true);
    for (let i = 0; i < CONTEXT_LIMIT; i++) store.append('private:123', 'generation-1', { text: `new ${i}` });
    assert.equal(store.find('private:123', 'generation-1', first.contextRef), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ambiguous quoted text is not assigned an invented target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-quotes-'));
  try {
    const store = createConversationContext(root);
    const one = store.append('private:123', 'token', { text: '同一句话', isSelf: true });
    assert.equal(store.quoted('private:123', 'token', '[引用 我：同一句话]纠正', true).contextRef, one.contextRef);
    store.append('private:123', 'token', { text: '同一句话', isSelf: true });
    assert.equal(store.quoted('private:123', 'token', '[引用 我：同一句话]纠正', true), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one exchange retains the question preceding four reply bubbles', () => {
  const input = { seq: 19, text: '我去过武夷山，以此比较雁荡山的体验' };
  const replies = Array.from({ length: 4 }, (_, i) => ({ isSelf: true, text: `比较 ${i}`, contextInputSeq: 19 }));
  assert.deepEqual(recentExchangeGroups([input, ...replies], [], 1), [[input, ...replies]]);
});

test('same-millisecond messages keep arrival order after newest-first selection', () => {
  const messages = [{ seq: 1, text: '先说的前提', time: 1 }, { seq: 2, text: '后说的补充', time: 1 }];
  const selected = recentExchangeGroups(messages, [], 2).flat().map((m) => ({ ...m }));
  assert.deepEqual(orderContextMessages(selected, messages).map((m) => m.seq), [1, 2]);
});

test('oversized originals explicitly report missing content and never authorize full-read receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-overflow-'));
  try {
    const store = createConversationContext(root);
    const original = store.append('private:123', 'token', { text: 'x'.repeat(ORIGINAL_MAX_CHARS + 1), seq: 1 });
    assert.equal(original.text.length, ORIGINAL_MAX_CHARS);
    assert.equal(original.originalTruncated, true);
    assert.equal(store.read('private:123', 'token', original, 0, original.text.length), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function fixture(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: false }, wait: { minMs: 20, maxMs: 100, minQuietAfterNewMs: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'private:123', st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = async (route, query = '', { body, token = st.agentToken } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}?key=${key}${query}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify({ key, ...body }) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const append = (text, quoteSelf = false) => {
    h.appendSocialV2Message(key, 'fixture-user', text, text, quoteSelf, true, `id-${st.lastUnreadSeq + 1}`, [], '123');
    return st.unread.at(-1);
  };
  try { await run({ h, st, key, request, append }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('seq 94–107 replay retains original intent and quoted reply across a burst', async () => fixture(async ({ h, st, key, request, append }) => {
  append('别人组织去雁荡山，行程不用操心');
  append('我去过武夷山，比较两者的体验和配套');
  await request('unread');
  h.recordSentMessagesV2(key, ['地貌不同', '玩法不同', '配套不同', '想省心去武夷，想爬山去雁荡']);
  await request('mark-read', '', { body: {} });
  append('[引用 我：想省心去武夷，想爬山去雁荡]我不是说过已经去过武夷山了吗', true);
  const snapshot = h.buildWakeSnapshotV2(key);
  assert.ok(snapshot.messages[0].quoteRef);
  assert.ok(snapshot.recent.some((m) => m.text.includes('比较两者')));
  assert.ok(snapshot.recent.some((m) => m.text.includes('行程不用操心')));
  assert.ok(snapshot.recent.some((m) => m.text.includes('想省心')));
  assert.ok(JSON.stringify(snapshot).length <= 6000);
  assert.equal(st.unread.length, 1, 'building context must not acknowledge unread');
  assert.match(h.buildWakePromptV2(key, 'private'), /用户纠正时先更新理解/);
}));

test('long incoming originals paginate losslessly and require full coverage before cursor acknowledgment', async () => fixture(async ({ request, append, st }) => {
  const text = '头部条件。' + '中间重要约束。'.repeat(1000) + '尾部条件。';
  const msg = append(text);
  const unread = await request('unread');
  assert.equal(unread.data.messages[0].textTruncated, true);
  assert.equal(unread.data.readThroughSeq, 0);
  assert.equal((await request('mark-read', '', { body: { throughSeq: 1 } })).status, 400);
  let offset = 0, rebuilt = '';
  do {
    const page = await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=${offset}&limit=1000`);
    assert.equal(page.status, 200);
    rebuilt += page.data.info.text;
    offset = page.data.info.nextOffset;
    if (offset !== null) assert.equal(page.data.readThroughSeq, 0);
    else assert.equal(page.data.readThroughSeq, 1);
  } while (offset !== null);
  assert.equal(rebuilt, text);
  assert.equal((await request('mark-read', '', { body: { throughSeq: 1 } })).status, 200);
  assert.equal(st.unread.length, 0);
}));

test('outgoing originals retain the middle omitted by previews; guards and missing originals are explicit', async () => fixture(async ({ h, st, key, request, append }) => {
  append('请介绍景点'); await request('unread');
  const text = '开头。'.repeat(80) + '中间的精确数字197' + '结尾。'.repeat(80);
  h.recordSentMessagesV2(key, [text]);
  const msg = st.recentMessages.at(-1);
  assert.equal(msg.textTruncated, true);
  assert.ok(!msg.text.includes('197'));
  const page = await request('message-detail', `&full=true&messageId=${msg.contextRef}`);
  assert.equal(page.data.info.text, text);
  assert.equal((await request('message-detail', `&full=true&messageId=${msg.contextRef}`, { token: 'wrong' })).status, 403);
  assert.equal((await request('message-detail', '&full=true&messageId=ctx_missing')).data.found, false);
  assert.equal((await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=-1`)).status, 400);
  h.cfg.socialV2.tools.getMessageDetail = false;
  assert.equal((await request('message-detail', `&full=true&messageId=${msg.contextRef}`)).status, 403);
}));

test('out-of-order and Unicode pages require continuous coverage, and reset tokens cannot read old originals', async () => fixture(async ({ h, key, request, append }) => {
  const msg = append('甲😀乙' + '正文'.repeat(150));
  let page = await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=3&limit=4000`);
  assert.equal(page.data.readThroughSeq, 0);
  assert.equal((await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=2`)).status, 400);
  page = await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=0&limit=2`);
  assert.equal(page.data.info.text, '甲');
  assert.equal(page.data.info.nextOffset, 1);
  page = await request('message-detail', `&full=true&messageId=${msg.contextRef}&offset=1&limit=1`);
  assert.equal(page.data.info.text, '😀');
  assert.equal(page.data.readThroughSeq, 1);
  await h.ensureSession(key);
  h.retireSession(key);
  assert.equal((await request('message-detail', `&full=true&messageId=${msg.contextRef}`)).data.found, false);
}));

test('messages arriving via wait carry their preceding exchange without granting extra receipts', async () => fixture(async ({ h, key, request, append }) => {
  append('我已经去过武夷山'); await request('unread');
  h.recordSentMessagesV2(key, ['这里作为体验参照']);
  h.cfg.socialV2.wait.maxMs = 1000;
  const waiting = request('wait', '', { body: { timeoutMs: 600, quietMs: 0 } });
  const timer = setTimeout(() => append('那么雁荡山爬起来呢'), 30);
  try {
    const result = await waiting;
    assert.equal(result.data.newMessages.length, 1);
    assert.ok(result.data.recent.some((m) => m.text.includes('已经去过')));
    assert.equal(result.data.readThroughSeq, 2);
  } finally { clearTimeout(timer); }
}));
