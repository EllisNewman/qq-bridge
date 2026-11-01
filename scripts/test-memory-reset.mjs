// M3 备份/重置/恢复回归测试：node scripts/test-memory-reset.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackup,
  pruneBackups,
  listBackups,
  restoreBackup,
  removeScopeFiles,
  listMemoryScopes,
  listArchiveScopes,
  isQqSessionCandidate
} from '../src/memory-reset.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reset-test-'));
const stateDir = path.join(tmp, 'state');
const scope = 'private:928417857';

function write(rel, text) {
  const full = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
}

try {
  write('sessions.json', JSON.stringify({ sessions: { [scope]: 'session-a' }, sessionPolicies: {} }));
  write('social-v2.json', JSON.stringify({ conversations: { [scope]: { recentMessages: [] } } }));
  write('memory/meta.json', JSON.stringify({ version: 1, scopes: { [scope]: { conv: 'c_one' } } }));
  write('memory/private_928417857.json', JSON.stringify({ version: 1, scope, facts: [] }));
  write('memory/private_111222333.json', JSON.stringify({ version: 1, scope: 'private:111222333', facts: [] }));
  write('archive/private_928417857/2026-10-20.jsonl', '{"at":1,"seq":1,"text":"hello"}\n');
  write('archive/private_928417857/index.json', '{"version":1}');
  write('archive/private_111222333/2026-10-20.jsonl', '{"at":2,"seq":1,"text":"other"}\n');

  console.log('[reset] 目录扫描');
  ok('listMemoryScopes', () => assert.deepEqual(listMemoryScopes(stateDir).sort(), ['private:111222333', scope].sort()));
  ok('listArchiveScopes', () => assert.deepEqual(listArchiveScopes(stateDir).sort(), ['private:111222333', scope].sort()));

  console.log('[reset] 备份');
  const now = Date.parse('2026-10-20T14:15:30Z'); // 北京 22:15:30
  const backup = createBackup({ stateDir, includeArchive: true, label: 'test', now, keep: 10 });
  ok('备份目录名是 +08 时间戳', () => assert.match(path.basename(backup.dir), /^20261020-221530$/));
  ok('manifest 存在', () => assert.equal(fs.existsSync(path.join(backup.dir, 'manifest.json')), true));
  ok('manifest 文件数', () => assert.ok(backup.manifest.files.length >= 6));
  ok('备份含 sessions/social/memory', () => {
    const names = backup.manifest.files.map((f) => f.path);
    assert.ok(names.includes('sessions.json'));
    assert.ok(names.includes('social-v2.json'));
    assert.ok(names.includes('memory/private_928417857.json'));
    assert.ok(names.includes('memory/meta.json'));
  });
  ok('includeArchive 备份 archive', () => {
    assert.ok(backup.manifest.files.some((f) => f.path.includes('archive/private_928417857/')));
    assert.ok(backup.manifest.counts.archive >= 2);
  });
  ok('manifest sha256', () => assert.match(backup.manifest.files[0].sha256, /^[0-9a-f]{64}$/));
  ok('listBackups 返回 manifest', () => {
    const list = listBackups(path.join(stateDir, 'backups'));
    assert.equal(list.length, 1);
    assert.equal(list[0].manifest.label, 'test');
  });

  console.log('[reset] 删除 scope 文件');
  const removed = removeScopeFiles({ stateDir, scope, includeLongTerm: true, includeArchive: true });
  ok('memoryRemoved', () => assert.equal(removed.memoryRemoved, true));
  ok('archiveRemoved', () => assert.equal(removed.archiveRemoved, true));
  ok('目标 memory 删除', () => assert.equal(fs.existsSync(path.join(stateDir, 'memory', 'private_928417857.json')), false));
  ok('目标 archive 删除', () => assert.equal(fs.existsSync(path.join(stateDir, 'archive', 'private_928417857')), false));
  ok('其他 scope 不受影响', () => assert.equal(fs.existsSync(path.join(stateDir, 'memory', 'private_111222333.json')), true));

  console.log('[reset] 恢复');
  const restored = restoreBackup(backup.dir, { stateDir });
  ok('恢复文件数', () => assert.ok(restored.restored.length >= 6));
  ok('memory 恢复', () => assert.equal(fs.existsSync(path.join(stateDir, 'memory', 'private_928417857.json')), true));
  ok('archive 恢复', () => {
    const file = path.join(stateDir, 'archive', 'private_928417857', '2026-10-20.jsonl');
    assert.equal(fs.existsSync(file), true);
    assert.ok(fs.readFileSync(file, 'utf8').includes('hello'));
  });

  console.log('[reset] 备份保留 10 份');
  const backupsDir = path.join(stateDir, 'backups');
  for (let i = 1; i <= 12; i += 1) {
    fs.mkdirSync(path.join(backupsDir, `202601${String(i).padStart(2, '0')}-000000`), { recursive: true });
  }
  const pruned = pruneBackups(backupsDir, 10);
  ok('清理了多余备份', () => assert.ok(pruned.length >= 3));
  ok('保留 10 份', () => assert.equal(listBackups(backupsDir).length, 10));

  console.log('[reset] 会话识别');
  const ctx = { sessionCwd: '/workspace', stateDir: '/opt/qq-bridge/state' };
  ok('qq-chat-v2 + sessionCwd', () => assert.equal(isQqSessionCandidate({ cwd: '/workspace', agentPreset: 'qq-chat-v2' }, ctx), true));
  ok('qq-chat + sessionCwd', () => assert.equal(isQqSessionCandidate({ cwd: '/workspace', agentPreset: 'qq-chat' }, ctx), true));
  ok('standard 不算 QQ 会话', () => assert.equal(isQqSessionCandidate({ cwd: '/workspace', agentPreset: 'standard' }, ctx), false));
  ok('state 目录下算 QQ 会话', () => assert.equal(isQqSessionCandidate({ cwd: '/opt/qq-bridge/state/slang-agent' }, ctx), true));
  ok('subagent 排除', () => assert.equal(isQqSessionCandidate({ cwd: '/workspace', agentPreset: 'qq-chat-v2', origin: 'subagent' }, ctx), false));
  ok('parentSessionId 排除', () => assert.equal(isQqSessionCandidate({ cwd: '/workspace', agentPreset: 'qq-chat-v2', parentSessionId: 'x' }, ctx), false));
  ok('cwd 为空排除', () => assert.equal(isQqSessionCandidate({ cwd: '', agentPreset: 'qq-chat-v2' }, ctx), false));


  ok('递归备份及精确恢复，保留非备份范围', () => {
    fs.mkdirSync(path.join(stateDir, 'memory/daily/private_928417857'), {recursive:true});
    fs.writeFileSync(path.join(stateDir, 'memory/daily/private_928417857/day.md'), 'digest');
    const b = createBackup({stateDir});
    fs.writeFileSync(path.join(stateDir, 'memory/new.json'), 'new');
    fs.writeFileSync(path.join(stateDir, 'config.json'), 'untouched');
    fs.rmSync(path.join(stateDir, 'memory/daily'), {recursive:true});
    restoreBackup(b.dir, {stateDir});
    assert.equal(fs.readFileSync(path.join(stateDir, 'memory/daily/private_928417857/day.md'), 'utf8'), 'digest');
    assert.equal(fs.existsSync(path.join(stateDir, 'memory/new.json')), false);
    assert.equal(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'), 'untouched');
  });
  ok('末尾文件损坏时不覆盖任何目标', () => {
    const b = createBackup({stateDir});
    fs.writeFileSync(path.join(stateDir, 'sessions.json'), 'current');
    fs.writeFileSync(path.join(b.dir, b.manifest.files.at(-1).path), 'corrupt');
    assert.throws(() => restoreBackup(b.dir, {stateDir}), /校验失败/);
    assert.equal(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'), 'current');
  });
  ok('拒绝嵌套路径穿越和缺失文件', () => {
    const b = createBackup({stateDir});
    const file = path.join(b.dir, 'manifest.json');
    const m = structuredClone(b.manifest);
    m.files[0].path = 'memory/../../escape';
    fs.writeFileSync(file, JSON.stringify(m));
    assert.throws(() => restoreBackup(b.dir, {stateDir}), /路径非法/);
    fs.writeFileSync(file, JSON.stringify(b.manifest));
    fs.rmSync(path.join(b.dir, b.manifest.files[0].path));
    assert.throws(() => restoreBackup(b.dir, {stateDir}));
  });
  ok('拒绝备份源符号链接', () => {
    const link = path.join(stateDir, 'memory/link');
    fs.symlinkSync(path.join(stateDir, 'config.json'), link);
    try { assert.throws(() => createBackup({stateDir}), /符号链接/); }
    finally { fs.unlinkSync(link); }
  });
  ok('恢复提交失败时回滚已替换的文件', () => {
    const b = createBackup({stateDir});
    fs.writeFileSync(path.join(stateDir, 'sessions.json'), 'before-failure');
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (src.includes('/new/social-v2.json')) throw new Error('injected failure');
      return rename(src, dst);
    };
    try { assert.throws(() => restoreBackup(b.dir, {stateDir}), /injected failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'), 'before-failure');
  });
  console.log(`\n[reset] 全部通过：${passed} 项`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
