// M3 记忆重置 / 备份 / 回滚的纯文件层。
//
// 这里只做「安全地复制、删除、恢复 state 文件」；会话停止/归档、social 状态清理
// 由 bridge.js 里的 performMemoryReset() 负责（它才有 api/state 的访问权）。
//
// 备份目录：state/backups/YYYYMMDD-HHmmss/
//   sessions.json
//   social-v2.json
//   retired-sessions.json（若有）
//   memory/meta.json + memory/private_*.json
//   archive/private_*（仅 includeArchive=true）
//   manifest.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dayKey, formatClock, formatDateTime } from './time.js';

const BACKUP_VERSION = 1;
export const DEFAULT_KEEP = 10;

function norm(p) {
  return path.normalize(String(p ?? '').replace(/\//g, path.sep));
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function fileStamp(nowMs) {
  return `${dayKey(nowMs).replace(/-/g, '')}-${formatClock(nowMs).replace(/:/g, '')}`;
}

function listPrivateFiles(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).sort();
  } catch {
    return [];
  }
}

/** private_928417857 -> private:928417857 */
function scopeFromFileName(name) {
  const m = /^private_(\d+)\.json$/.exec(name);
  return m ? `private:${m[1]}` : null;
}

function scopeFromDirName(name) {
  const m = /^private_(\d+)$/.exec(name);
  return m ? `private:${m[1]}` : null;
}

export function listMemoryScopes(stateDir) {
  return listPrivateFiles(path.join(stateDir, 'memory'), /^private_\d+\.json$/)
    .map(scopeFromFileName)
    .filter(Boolean);
}

export function listArchiveScopes(stateDir) {
  try {
    return fs.readdirSync(path.join(stateDir, 'archive'))
      .map(scopeFromDirName)
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function copyFileInto(stateDir, backupDir, rel, files) {
  const src = path.join(stateDir, rel);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(src).isSymbolicLink()) throw new Error("备份拒绝符号链接");
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  files.push({
    path: rel.split(path.sep).join('/'),
    size: fs.statSync(dst).size,
    sha256: sha256(dst)
  });
  return true;
}

function addArchiveFiles(stateDir, backupDir, files) {
  const archiveDir = path.join(stateDir, 'archive');
  if (!fs.existsSync(archiveDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("备份拒绝符号链接");
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = path.relative(stateDir, full);
        copyFileInto(stateDir, backupDir, rel, files);
        count += 1;
      }
    }
  };
  walk(archiveDir);
  return count;
}

/**
 * 创建备份并清理旧备份。
 * @param {{stateDir:string, includeArchive?:boolean, label?:string, keep?:number, now?:number}} opts
 */
export function createBackup(opts = {}) {
  const stateDir = opts.stateDir;
  if (!stateDir) throw new Error('stateDir is required');
  const includeArchive = opts.includeArchive === true;
  const keep = Math.max(1, Math.min(100, Number(opts.keep) || DEFAULT_KEEP));
  const now = Number(opts.now) || Date.now();
  const backupsDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

  const base = fileStamp(now);
  let dir = path.join(backupsDir, base);
  let suffix = 1;
  while (fs.existsSync(dir)) dir = path.join(backupsDir, `${base}-${suffix++}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files = [];
  for (const rel of ['sessions.json', 'social-v2.json', 'retired-sessions.json']) {
    copyFileInto(stateDir, dir, rel, files);
  }
  const memoryDir = path.join(stateDir, 'memory');
  const copyTree = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('备份拒绝符号链接');
      if (stat.isDirectory()) copyTree(full);
      else if (stat.isFile()) copyFileInto(stateDir, dirBackup, path.relative(stateDir, full), files);
    }
  };
  const dirBackup = dir;
  copyTree(memoryDir);
  const archiveFiles = includeArchive ? addArchiveFiles(stateDir, dir, files) : 0;

  const manifest = {
    version: BACKUP_VERSION,
    createdAt: now,
    createdAtCst: formatDateTime(now),
    label: String(opts.label ?? '').slice(0, 80),
    includeArchive,
    files,
    counts: {
      files: files.length,
      memory: files.filter((f) => f.path.startsWith('memory/')).length,
      archive: archiveFiles
    }
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  const pruned = pruneBackups(backupsDir, keep);
  return { dir, manifest, pruned };
}

/** 保留最近 keep 份（按目录名倒序，目录名是 UTC+8 时间戳）。 */
export function pruneBackups(backupsDir, keep = DEFAULT_KEEP) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse();
  } catch {
    return [];
  }
  const removed = dirs.slice(Math.max(1, keep));
  for (const name of removed) {
    try { fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true }); } catch {}
  }
  return removed;
}

export function listBackups(backupsDir) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse();
  } catch {
    return [];
  }
  return dirs.map((name) => {
    const dir = path.join(backupsDir, name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {}
    return { name, dir, manifest };
  });
}

/**
 * 恢复备份。调用方必须先停止 bridge（本函数不检查进程，只做文件复制）。
 * @param {string} backupDir
 * @param {{stateDir:string, overwrite?:boolean}} opts
 */
export function restoreBackup(backupDir, opts = {}) {
  const stateDir = path.resolve(opts.stateDir || '');
  if (!opts.stateDir) throw new Error('stateDir is required');
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== BACKUP_VERSION || !Array.isArray(manifest.files)) throw new Error('备份 manifest 无效');
  const roots = ['sessions.json', 'social-v2.json', 'retired-sessions.json', 'memory'];
  if (manifest.includeArchive === true) roots.push('archive');
  const rejectLinks = (base, rel) => {
    let current = path.resolve(base);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('恢复拒绝符号链接');
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('恢复拒绝符号链接');
    }
  };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const seen = new Set();
  // Validate every byte and path before modifying any destination.
  for (const entry of manifest.files) {
    const rel = String(entry.path || '');
    const parts = rel.split('/');
    if (!rel || rel.includes('\\') || parts.some(p => !p || p === '.' || p === '..') ||
        !roots.includes(parts[0]) || (parts.length > 1 && !['memory', 'archive'].includes(parts[0])) || seen.has(rel)) {
      throw new Error(`备份路径非法：${rel}`);
    }
    seen.add(rel);
    rejectLinks(backupDir, rel);
    rejectLinks(stateDir, rel);
    const src = path.join(backupDir, rel);
    if (!fs.statSync(src).isFile() || !entry.sha256 || sha256(src) !== entry.sha256) throw new Error(`备份文件校验失败：${rel}`);
  }
  for (const rel of roots) rejectLinks(stateDir, rel);
  if (opts.overwrite === false && roots.some(rel => fs.existsSync(path.join(stateDir, rel)))) throw new Error('目标已存在，拒绝部分恢复');
  const stage = fs.mkdtempSync(path.join(stateDir, '.restore-'));
  const installed = [], moved = [];
  let cleanup = true;
  try {
    for (const entry of manifest.files) {
      const dst = path.join(stage, 'new', entry.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(backupDir, entry.path), dst);
      fs.chmodSync(dst, 0o600);
    }
    fs.mkdirSync(path.join(stage, 'old'), { recursive: true });
    for (const rel of roots) {
      const dst = path.join(stateDir, rel);
      if (fs.existsSync(dst)) { fs.renameSync(dst, path.join(stage, 'old', rel)); moved.push(rel); }
      const src = path.join(stage, 'new', rel);
      if (fs.existsSync(src)) { fs.renameSync(src, dst); installed.push(rel); }
    }
  } catch (error) {
    cleanup = false;
    for (const rel of installed.reverse()) fs.rmSync(path.join(stateDir, rel), { recursive: true, force: true });
    for (const rel of moved.reverse()) fs.renameSync(path.join(stage, 'old', rel), path.join(stateDir, rel));
    cleanup = true;
    throw error;
  } finally { if (cleanup) fs.rmSync(stage, { recursive: true, force: true }); }
  return { restored: [...seen], skipped: [], manifest };
}

/**
 * 删除某个 private scope 的长期记忆文件 / 原始归档目录。
 * meta.json 不在这里删除（会话代际由 archiveStore.rotateConv 处理）。
 */
export function removeScopeFiles(opts = {}) {
  const { stateDir, scope } = opts;
  if (!stateDir || !scope) throw new Error('stateDir and scope are required');
  const m = /^private:(\d+)$/.exec(scope);
  if (!m) return { memoryRemoved: false, archiveRemoved: false };
  const qq = m[1];
  let memoryRemoved = false;
  let archiveRemoved = false;
  if (opts.includeLongTerm !== false) {
    const file = path.join(stateDir, 'memory', `private_${qq}.json`);
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(stateDir, 'memory', 'daily', `private_${qq}`), { recursive: true, force: true });
      memoryRemoved = true;
    } catch (error) { throw error; }
  }
  if (opts.includeArchive === true) {
    const dir = path.join(stateDir, 'archive', `private_${qq}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      archiveRemoved = true;
    } catch (error) { throw error; }
  }
  return { memoryRemoved, archiveRemoved };
}

/**
 * 判断一个 DSH 会话是否属于桥接创建的 QQ 会话。
 * 兼容两种部署：旧的 state/agents 目录，以及当前 cfg.sessionCwd + qq-chat* preset。
 */
export function isQqSessionCandidate(item, { sessionCwd, stateDir } = {}) {
  if (!item || item.origin === 'subagent' || item.parentSessionId) return false;
  const cwd = norm(item.cwd);
  if (!cwd) return false;
  const stateRoot = stateDir ? norm(path.resolve(stateDir)) : '';
  if (stateRoot) {
    const prefix = stateRoot.endsWith(path.sep) ? stateRoot : stateRoot + path.sep;
    const underState = process.platform === 'win32'
      ? cwd.toLowerCase().startsWith(prefix.toLowerCase())
      : cwd.startsWith(prefix);
    if (underState) return true;
  }
  if (sessionCwd && cwd === norm(sessionCwd) && /^qq-chat/.test(String(item.agentPreset ?? ''))) return true;
  return false;
}

export { sha256 };
