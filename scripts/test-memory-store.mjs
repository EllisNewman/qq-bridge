// M2 长期记忆库回归测试：node scripts/test-memory-store.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore, tokenize } from '../src/memory-store.js';
import { atomicWriteJson } from '../src/state-io.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
const root = path.join(tmp, 'memory');
const metaPath = path.join(root, 'meta.json');
const scope = 'private:928417857';
let clock = 1_792_496_000_000;

function writeMeta(conv) {
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  atomicWriteJson(metaPath, { version: 1, scopes: { [scope]: { conv, archiveSeq: 19, backfilledAt: 1, resetCount: 0 } } });
}
function newStore(maxActiveFacts = 3) {
  return createMemoryStore({
    root,
    metaPath,
    maxActiveFacts,
    log: () => {},
    now: () => clock
  });
}

try {
  writeMeta('c_one');
  const store = newStore(3);

  console.log('[memory] scope / 基础新增');
  ok('私聊 scope 路径', () => assert.match(store.filePath(scope), /private_928417857\.json$/));
  const r1 = store.addFact(scope, {
    kind: 'person', subject: 'Ellis', text: '喜欢用白米饭配榨菜调侃',
    keywords: ['白米饭', '榨菜'], confidence: 0.8, salience: 3
  });
  ok('新增 fact', () => assert.equal(r1.fact.status, 'active'));
  ok('source 默认 operator', () => assert.equal(r1.fact.source, 'operator'));
  ok('文件已落盘', () => assert.equal(fs.existsSync(store.filePath(scope)), true));

  console.log('[memory] 去重 / supersede / retract / pin');
  const dup = store.addFact(scope, {
    kind: 'person', subject: 'Ellis', text: '喜欢用白米饭配榨菜调侃',
    keywords: ['米饭'], confidence: 0.9, salience: 4
  });
  ok('同文本去重不新增', () => {
    assert.equal(dup.updated, true);
    assert.equal(store.listFacts(scope).length, 1);
  });
  ok('去重时取更高 confidence/salience', () => {
    assert.equal(dup.fact.confidence, 0.9);
    assert.equal(dup.fact.salience, 4);
  });
  const r2 = store.addFact(scope, {
    kind: 'preference', subject: 'Ellis', text: '不喜欢被叫客服',
    keywords: ['客服'], confidence: 0.7, salience: 3,
    supersedes: [r1.fact.id]
  });
  ok('supersede 旧条目', () => assert.equal(store.listFacts(scope, { status: 'all' }).find((f) => f.id === r1.fact.id).status, 'superseded'));
  ok('新条目 active', () => assert.equal(r2.fact.status, 'active'));
  ok('pin', () => {
    assert.equal(store.pin(scope, r2.fact.id, true), true);
    assert.equal(store.listFacts(scope).find((f) => f.id === r2.fact.id).pinned, true);
  });
  ok('retract', () => {
    const r3 = store.addFact(scope, { kind: 'event', text: '临时事件', keywords: ['临时'] });
    assert.equal(store.retract(scope, r3.fact.id), true);
    assert.equal(store.listFacts(scope).some((f) => f.id === r3.fact.id), false);
  });

  console.log('[memory] 容量 / archived');
  const s2 = newStore(2);
  s2.addFact(scope, { kind: 'event', text: '事实A', keywords: ['A'], salience: 1 });
  s2.addFact(scope, { kind: 'event', text: '事实B', keywords: ['B'], salience: 2 });
  s2.addFact(scope, { kind: 'event', text: '事实C', keywords: ['C'], salience: 3 });
  const st2 = s2.stats(scope);
  ok('超容量进入 archived', () => assert.ok(st2.archived >= 1));
  ok('pinned 不被淘汰', () => assert.ok(s2.listFacts(scope).some((f) => f.pinned)));

  console.log('[memory] 检索');
  const s3 = newStore(20);
  s3.addFact(scope, { kind: 'person', subject: 'Ellis', text: '喜欢白米饭', keywords: ['白米饭'] });
  s3.addFact(scope, { kind: 'event', text: '周末去了动物园', keywords: ['动物园'] });
  const hits = s3.search(scope, '白米饭', 10);
  ok('关键词命中', () => assert.equal(hits.facts[0].subject, 'Ellis'));
  ok('无关查询不命中', () => assert.equal(s3.search(scope, '量子力学').facts.length, 0));
  ok('tokenize 中文 2-4 字', () => assert.ok(tokenize('白米饭').includes('白米')));

  console.log('[memory] 注入选择 / 预算 / 冷却');
  const s4 = newStore(20);
  const pinned = s4.addFact(scope, { kind: 'rule', text: '不要叫我客服', keywords: ['客服'], pinned: true, salience: 5 }).fact;
  const recalled = s4.addFact(scope, { kind: 'preference', text: '喜欢吃白米饭', keywords: ['白米饭'], salience: 3 }).fact;
  const inj1 = s4.selectForInjection(scope, { messageText: '今晚吃白米饭吗', maxChars: 800, nowMs: clock, cooldownMs: 1800_000 });
  ok('注入包含置顶', () => assert.ok(inj1.text.includes('不要叫我客服')));
  ok('注入包含命中', () => assert.ok(inj1.text.includes('喜欢吃白米饭')));
  ok('usedFactIds 记录', () => assert.ok(inj1.usedFactIds.includes(recalled.id)));
  const inj2 = s4.selectForInjection(scope, { messageText: '今晚吃白米饭吗', maxChars: 800, nowMs: clock + 1000, cooldownMs: 1800_000 });
  ok('冷却内不重复召回', () => assert.equal(inj2.text.includes('喜欢吃白米饭'), false));
  ok('置顶不受冷却影响', () => assert.ok(inj2.text.includes('不要叫我客服')));
  ok('预算裁剪', () => {
    const small = s4.selectForInjection(scope, { messageText: '白米饭', maxChars: 100, nowMs: clock + 2000, cooldownMs: 0 });
    assert.ok(small.text.length <= 100);
  });
  console.log('[memory] 仅普通事实时也注入');
  const sRecent = newStore(20);
  sRecent.addFact('private:444555', { kind: 'event', text: '普通事实', keywords: ['普通'] });
  const injRecent = sRecent.selectForInjection('private:444555', { messageText: '', maxChars: 800, nowMs: clock, cooldownMs: 0 });
  ok('无置顶/无召回时仍注入普通事实', () => assert.ok(injRecent.text.includes('普通事实')));

  ok('bootstrap 带 handoff', () => {
    const doc = s4.load(scope);
    doc.handoff = { fromSessionId: 'session-x', text: '之前聊到白米饭', createdAt: clock };
    const boot = s4.selectForInjection(scope, { isBootstrap: true, maxChars: 800, nowMs: clock + 3000, cooldownMs: 0 });
    assert.ok(boot.text.includes('上一段会话交接'));
  });

  console.log('[memory] qq_get_prompt 文本');
  ok('formatForGetPrompt', () => {
    const text = s4.formatForGetPrompt(scope, 2000);
    assert.ok(text.includes('长期记忆'));
    assert.ok(text.includes('不要叫我客服'));
  });

  console.log('[memory] 显式导入 memberImpressions');
  const s5 = newStore(20);
  const importScope = 'private:111222333';
  const dry = s5.importImpressions(importScope, { Ellis: { traits: ['叫我 Ellis', '喜欢白米饭'], lastSeenAt: clock } }, { dryRun: true });
  ok('dry-run 不落盘', () => assert.equal(fs.existsSync(s5.filePath(importScope)), false));
  ok('dry-run 候选', () => assert.equal(dry.candidates.length, 1));
  const imp = s5.importImpressions(importScope, { Ellis: { traits: ['叫我 Ellis', '喜欢白米饭'], lastSeenAt: clock } });
  ok('实际导入', () => assert.equal(imp.imported, 1));
  ok('source=migration', () => assert.equal(s5.listFacts(importScope)[0].source, 'migration'));
  ok('migratedFrom 记录', () => assert.equal(s5.load(importScope).migratedFrom, 'memberImpressions'));

  console.log('[memory] 损坏文件只读');
  fs.writeFileSync(s5.filePath(scope), '{broken json', 'utf8');
  const s6 = newStore(20);
  const before = fs.readFileSync(s5.filePath(scope), 'utf8');
  ok('readOnly 标记', () => assert.equal(s6.stats(scope).readOnly, true));
  ok('只读时拒绝写入', () => assert.equal(s6.addFact(scope, { kind: 'event', text: 'x' }), null));
  ok('不覆盖原文件', () => assert.equal(fs.readFileSync(s5.filePath(scope), 'utf8'), before));

  console.log('[memory] conv 变化');
  writeMeta('c_one');
  const s7 = newStore(20);
  s7.load(scope);
  // 写一个带水位和 fact 的有效文件
  const doc = s7.load(scope);
  doc.summarizedThroughSeq = 19;
  doc.facts = [];
  doc.archivedFacts = [];
  doc.facts.push({
    id: 'f_keep', kind: 'person', subject: 'Ellis', text: '保留的事实', keywords: ['保留'],
    evidence: [], confidence: 0.8, salience: 3, pinned: false, status: 'active',
    validFrom: clock, validTo: null, supersededBy: null,
    lastInjectedSeq: 0, lastInjectedAt: 0, lastUsedAt: 0, useCount: 0,
    source: 'operator', createdAt: clock, updatedAt: clock
  });
  atomicWriteJson(s7.filePath(scope), doc);
  writeMeta('c_two');
  const s8 = newStore(20);
  const after = s8.load(scope);
  ok('conv 同步', () => assert.equal(after.conv, 'c_two'));
  ok('水位归零', () => assert.equal(after.summarizedThroughSeq, 0));
  ok('facts 保留', () => assert.equal(after.facts.some((f) => f.text === '保留的事实'), true));

  console.log(`\n[memory] 全部通过：${passed} 项`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
