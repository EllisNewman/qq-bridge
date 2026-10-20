// M1 原始归档回归测试：node scripts/test-archive-log.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createArchiveStore,
  buildBackfillEntries,
  scopeForKey,
  newConvId
} from '../src/archive-log.js';
import { atomicWriteJson, readJsonSafe } from '../src/state-io.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-archive-test-'));
const root = path.join(tmp, 'archive');
const metaPath = path.join(tmp, 'memory', 'meta.json');
const scope = 'private:928417857';
const bjNoon = Date.parse('2026-10-20T04:00:00Z');     // 北京 2026-10-20 12:00
const bjNextDay = Date.parse('2026-10-20T16:30:00Z');  // 北京 2026-10-21 00:30

try {
  console.log('[archive] scope / conv');
  ok('private key 解析', () => assert.deepEqual(scopeForKey('private:928417857'), { scope, qq: '928417857' }));
  ok('group key 返回 null', () => assert.equal(scopeForKey('group:123456'), null));
  ok('非法 key 返回 null', () => assert.equal(scopeForKey('private:abc'), null));
  ok('conv id 形如 c_xxx', () => assert.match(newConvId(), /^c_[0-9a-f]{16}$/));

  console.log('[archive] append / 按日切分');
  const store = createArchiveStore({ root, metaPath, warnBytes: 0 });
  const a = store.append(scope, { at: bjNoon, dir: 'in', from: '928417857', name: 'Ellis', text: '你好', msgSeq: 1 });
  const b = store.append(scope, { at: bjNoon + 1000, dir: 'out', name: '我', text: '在', event: 'message' });
  const c = store.append(scope, { at: bjNextDay, dir: 'in', from: '928417857', name: 'Ellis', text: '还在吗', msgSeq: 2 });
  ok('seq 单调递增', () => assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]));
  ok('同一 conv', () => assert.equal(a.conv, b.conv));
  ok('按 +08 日期切文件', () => {
    const files = fs.readdirSync(path.join(root, 'private_928417857')).filter((f) => f.endsWith('.jsonl')).sort();
    assert.deepEqual(files, ['2026-10-20.jsonl', '2026-10-21.jsonl']);
  });
  ok('flush 前 index 尚未写', () => assert.equal(fs.existsSync(path.join(root, 'private_928417857', 'index.json')), false));
  store.flushAll();
  ok('flush 后 index.json 存在', () => assert.equal(fs.existsSync(path.join(root, 'private_928417857', 'index.json')), true));
  ok('meta.json 存在', () => assert.equal(fs.existsSync(metaPath), true));

  console.log('[archive] stats / 权限');
  const stats = store.stats(scope);
  ok('stats 行数', () => assert.equal(stats.totalLines, 3));
  ok('stats 天数', () => assert.equal(stats.days, 2));
  ok('stats 首末日', () => assert.deepEqual([stats.oldestDay, stats.newestDay], ['2026-10-20', '2026-10-21']));
  ok('stats lastSeq', () => assert.equal(stats.lastSeq, 3));
  if (process.platform !== 'win32') {
    ok('归档文件 0600', () => {
      const mode = fs.statSync(path.join(root, 'private_928417857', '2026-10-20.jsonl')).mode & 0o777;
      assert.equal(mode, 0o600);
    });
    ok('目录 0700', () => {
      const mode = fs.statSync(path.join(root, 'private_928417857')).mode & 0o777;
      assert.equal(mode, 0o700);
    });
  }

  console.log('[archive] 崩溃恢复（不 flush 直接重开）');
  const store2 = createArchiveStore({ root, metaPath });
  const d = store2.append(scope, { at: bjNextDay + 1000, dir: 'in', text: '我回来了' });
  ok('从最后一行恢复 seq', () => assert.equal(d.seq, 4));

  console.log('[archive] readRange');
  ok('按 seq 区间', () => {
    const rows = store2.readRange(scope, { fromSeq: 2, toSeq: 3 });
    assert.deepEqual(rows.map((r) => r.seq), [2, 3]);
  });
  ok('按 conv 过滤', () => {
    const rows = store2.readRange(scope, { conv: a.conv });
    assert.ok(rows.length >= 3);
  });
  ok('limit 生效', () => assert.equal(store2.readRange(scope, { limit: 2 }).length, 2));

  console.log('[archive] 损坏行容错');
  fs.appendFileSync(path.join(root, 'private_928417857', '2026-10-21.jsonl'), '{not json}\n');
  ok('读取跳过损坏行', () => {
    const rows = store2.readRange(scope, {});
    assert.equal(rows.some((r) => r.text === '还在吗'), true);
  });

  console.log('[archive] 轮换 conv');
  const oldConv = store2.getMeta(scope).conv;
  const newConv = store2.rotateConv(scope);
  ok('conv 变化', () => assert.notEqual(newConv, oldConv));
  const e = store2.append(scope, { at: bjNextDay + 2000, dir: 'out', text: '新会话' });
  ok('新 conv 的 seq 从 1 开始', () => assert.equal(e.seq, 1));
  ok('resetCount 增加', () => assert.equal(store2.getMeta(scope).resetCount, 1));

  console.log('[archive] 回填映射');
  const bf = buildBackfillEntries([
    { isSelf: false, text: 'a', plain: 'a', time: bjNoon, seq: 5, messageId: 'm1', userId: '42', sender: 'Ellis', media: [{ kind: 'image', summary: '猫' }] },
    { isSelf: true, text: 'b', time: bjNoon + 1000 }
  ], { maxMessages: 10, selfUserId: '999' });
  ok('回填条数', () => assert.equal(bf.length, 2));
  ok('回填方向', () => assert.deepEqual(bf.map((x) => x.dir), ['in', 'out']));
  ok('回填 msgSeq/mid', () => {
    assert.equal(bf[0].msgSeq, 5);
    assert.equal(bf[0].mid, 'm1');
  });
  ok('回填 media', () => assert.deepEqual(bf[0].media, ['image:猫']));
  ok('回填 backfill 标记', () => assert.equal(bf.every((x) => x.backfill === true), true));
  ok('回填自方 from', () => assert.equal(bf[1].from, '999'));

  console.log('[archive] 永久保留（不删除）');
  ok('文件仍然存在', () => assert.equal(fs.existsSync(path.join(root, 'private_928417857', '2026-10-20.jsonl')), true));

  console.log('[state-io] 原子写/读');
  const jsonFile = path.join(tmp, 'x.json');
  atomicWriteJson(jsonFile, { a: 1 });
  ok('atomicWriteJson + readJsonSafe', () => assert.deepEqual(readJsonSafe(jsonFile, null), { a: 1 }));
  fs.writeFileSync(jsonFile, '\uFEFF{"b":2}', 'utf8');
  ok('BOM 容错', () => assert.deepEqual(readJsonSafe(jsonFile, null), { b: 2 }));
  ok('缺失文件 fallback', () => assert.equal(readJsonSafe(path.join(tmp, 'nope.json'), 'fallback'), 'fallback'));

  console.log(`\n[archive] 全部通过：${passed} 项`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
