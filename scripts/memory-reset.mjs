// M3 记忆重置 / 备份 / 恢复 CLI（操作者用）。
//
// 重置：通过 bridge 控制台 HTTP 执行（bridge 必须已启动），这样才走单写者、会停/归档 DSH 会话。
//   node scripts/memory-reset.mjs --scope private --dry-run
//   node scripts/memory-reset.mjs --scope private --include-long-term
//   node scripts/memory-reset.mjs --scope session --key private:928417857 --keep-long-term
//
// 备份/恢复：直接操作 state 文件；恢复前必须停 bridge。
//   node scripts/memory-reset.mjs --backup
//   node scripts/memory-reset.mjs --list-backups
//   node scripts/memory-reset.mjs --restore state/backups/20261020-221530
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, listBackups, restoreBackup } from '../src/memory-reset.js';
import { readJsonSafe } from '../src/state-io.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(name) {
  return process.argv.includes(name);
}

const stateDir = path.resolve(arg('--state-dir', path.join(process.cwd(), 'state')));
const port = Number(arg('--port', '3100')) || 3100;

function print(data) {
  if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function consoleToken() {
  const fromState = (() => {
    try { return fs.readFileSync(path.join(stateDir, 'console-token'), 'utf8').trim(); } catch { return ''; }
  })();
  if (fromState) return fromState;
  const cfg = readJsonSafe(path.join(stateDir, '..', 'config.json'), null);
  return String(cfg?.consoleToken ?? '').trim();
}

async function resetViaHttp() {
  const token = consoleToken();
  if (!token) {
    console.error('找不到 console token（state/console-token 或 config.json 的 consoleToken）；请确认 --state-dir 正确。');
    process.exit(2);
  }
  const body = {
    scope: arg('--scope', 'private'),
    key: arg('--key'),
    includeLongTerm: !has('--keep-long-term'),
    includeArchive: has('--include-archive'),
    allowGroup: has('--allow-group'),
    dryRun: has('--dry-run')
  };
  const res = await fetch(`http://127.0.0.1:${port}/api/memory/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  print(data);
  if (!res.ok || data.ok === false) process.exit(1);
}

try {
  if (has('--list-backups')) {
    print(listBackups(path.join(stateDir, 'backups')));
  } else if (has('--backup')) {
    if (fs.existsSync(path.join(stateDir, 'bridge.lock'))) throw new Error('离线备份前请停止 bridge；在线备份由记忆重置流程创建');
    const result = createBackup({
      stateDir,
      includeArchive: has('--include-archive'),
      label: 'cli'
    });
    print({ ok: true, dir: result.dir, manifest: result.manifest, pruned: result.pruned });
  } else if (arg('--restore')) {
    const dir = path.resolve(arg('--restore'));
    const lock = path.join(stateDir, 'bridge.lock');
    if (fs.existsSync(lock)) {
      console.error(`检测到 ${lock}：请先停止 bridge（docker compose stop qq-bridge），确认退出后再运行；残留锁需确认服务已停止后手动清理。`);
      process.exit(2);
    }
    let fd;
    try {
      fd = fs.openSync(path.join(stateDir, 'memory-restore.lock'), 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      const result = restoreBackup(dir, { stateDir });
      print({ ok: true, restored: result.restored.length, skipped: result.skipped, backup: path.basename(dir) });
    } finally {
      if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(path.join(stateDir, 'memory-restore.lock')); }
    }
  } else {
    // 默认：通过 HTTP 重置
    await resetViaHttp();
  }
} catch (error) {
  console.error(`执行失败：${error?.message ?? error}`);
  process.exit(1);
}
