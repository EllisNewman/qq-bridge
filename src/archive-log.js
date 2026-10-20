// 私聊原始归档（M1）。
//
// 目标：把私聊里「用户看到的 / Agent 发出的」消息按 UTC+8 日期追加到
//   state/archive/private_<qq>/YYYY-MM-DD.jsonl
// 永久保留、只追加；蒸馏器（M4）只从这里读，因此不受 social-v2 的
// recentMessages=100 / 单条截断 200 字影响。
//
// 关键设计：
//   - `seq` 是**归档局部单调序号**（每个 conv 独立），不是 social-v2 的 unread seq；
//   - `msgSeq` 另外记录 social-v2 的 seq（仅入站，排障用）；
//   - `conv` 是会话代际 id，状态重置时轮换，避免 seq 复用；
//   - index.json 记录按天统计；meta.json 记录每个 scope 的 conv / archiveSeq / backfilledAt；
//   - 崩溃恢复：启动时用索引 + 最新文件最后一行校正 archiveSeq。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dayKey } from './time.js';
import { atomicWriteJson, readJsonSafe } from './state-io.js';

export const ARCHIVE_VERSION = 1;
const INDEX_FLUSH_EVERY = 50;
const MAX_TEXT = 2000;
const MAX_MEDIA = 8;

export function newConvId() {
  return `c_${crypto.randomBytes(8).toString('hex')}`;
}

/** 只接受 private:<正整数>；群聊返回 null。 */
export function scopeForKey(key) {
  const m = /^private:([1-9]\d*)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { scope: `private:${m[1]}`, qq: m[1] };
}

function clip(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  // 不留下孤立的高代理位（emoji 占两个码元）
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function parseLine(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function emptyIndex(scope) {
  return {
    version: ARCHIVE_VERSION,
    scope,
    days: [],
    totalBytes: 0,
    totalLines: 0,
    updatedAt: Date.now()
  };
}

function emptyMeta() {
  return { version: ARCHIVE_VERSION, scopes: {} };
}

/**
 * 把 social-v2 的 recentMessages 映射成回填条目。
 * 注意：这些文本在 social-v2 里已经被截到 200 字，回填保真度低于实时归档。
 */
export function buildBackfillEntries(recentMessages, options = {}) {
  const max = Math.max(1, Math.min(500, Number(options.maxMessages) || 100));
  const now = Number(options.now) || Date.now();
  const redact = typeof options.redact === 'function' ? options.redact : (s) => String(s ?? '');
  const selfUserId = options.selfUserId != null ? String(options.selfUserId) : '';
  const list = Array.isArray(recentMessages) ? recentMessages.slice(-max) : [];
  return list.map((m, i) => {
    const isSelf = !!m?.isSelf;
    const at = Number(m?.time ?? m?.at) || (now - (list.length - i) * 1000);
    const text = redact(m?.text ?? m?.plain ?? '');
    const plain = redact(m?.plain ?? m?.text ?? '');
    const media = (Array.isArray(m?.media) ? m.media : []).slice(0, MAX_MEDIA).map((x) => {
      const kind = String(x?.kind || 'media');
      const summary = x?.summary ? `:${clip(x.summary, 80)}` : '';
      return kind + summary;
    });
    return {
      at,
      dir: isSelf ? 'out' : 'in',
      from: isSelf ? selfUserId : String(m?.userId ?? ''),
      name: clip(m?.sender ?? (isSelf ? '我' : ''), 80),
      text,
      plain,
      media,
      event: (m?.kind === 'poke' || m?.poke) ? 'poke' : 'message',
      mid: m?.messageId != null ? String(m.messageId) : null,
      msgSeq: Number.isSafeInteger(m?.seq) ? m.seq : null,
      quote: null,
      backfill: true
    };
  });
}

/**
 * @param {{
 *   root: string,                 // state/archive
 *   metaPath?: string,            // state/memory/meta.json
 *   warnBytes?: number,
 *   log?: (...args:any[])=>void,
 *   now?: ()=>number
 * }} options
 */
export function createArchiveStore(options = {}) {
  const root = options.root;
  if (!root) throw new Error('archive root is required');
  const metaPath = options.metaPath || path.join(path.dirname(root), 'memory', 'meta.json');
  const warnBytes = Number(options.warnBytes) || 0;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const scopes = new Map(); // scope -> { scope, meta, index, dirty }
  let meta = (() => {
    const raw = readJsonSafe(metaPath, null);
    if (raw && typeof raw === 'object' && raw.scopes && typeof raw.scopes === 'object' && !Array.isArray(raw.scopes)) {
      return { version: ARCHIVE_VERSION, scopes: { ...raw.scopes } };
    }
    return emptyMeta();
  })();
  let metaDirty = false;

  function scopeDir(scope) {
    return path.join(root, scope.replace(':', '_'));
  }

  function indexPath(scope) {
    return path.join(scopeDir(scope), 'index.json');
  }

  function filePath(scope, day) {
    return path.join(scopeDir(scope), `${day}.jsonl`);
  }

  function listDayFiles(scope) {
    try {
      return fs.readdirSync(scopeDir(scope))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  function saveMeta() {
    if (!metaDirty) return;
    atomicWriteJson(metaPath, meta);
    metaDirty = false;
  }

  function rebuildIndex(scope) {
    const index = emptyIndex(scope);
    for (const file of listDayFiles(scope)) {
      const day = file.slice(0, 10);
      const full = path.join(scopeDir(scope), file);
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter(Boolean);
      const stats = {
        day,
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: lines.length,
        firstAt: 0,
        lastAt: 0,
        firstSeq: 0,
        lastSeq: 0,
        convs: []
      };
      const convs = new Set();
      for (const line of lines) {
        const e = parseLine(line);
        if (!e) continue;
        if (!stats.firstAt) stats.firstAt = Number(e.at) || 0;
        stats.lastAt = Number(e.at) || stats.lastAt;
        if (!stats.firstSeq) stats.firstSeq = Number(e.seq) || 0;
        stats.lastSeq = Number(e.seq) || stats.lastSeq;
        if (e.conv) convs.add(String(e.conv));
      }
      stats.convs = [...convs];
      index.days.push(stats);
      index.totalBytes += stats.bytes;
      index.totalLines += stats.lines;
    }
    index.updatedAt = now();
    return index;
  }

  function loadIndex(scope) {
    const raw = readJsonSafe(indexPath(scope), null);
    if (!raw || typeof raw !== 'object' || raw.version !== ARCHIVE_VERSION || !Array.isArray(raw.days)) return null;
    return {
      version: ARCHIVE_VERSION,
      scope,
      days: raw.days.filter((d) => d && typeof d === 'object'),
      totalBytes: Number(raw.totalBytes) || 0,
      totalLines: Number(raw.totalLines) || 0,
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function lastSeqOnDisk(scope) {
    const files = listDayFiles(scope);
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const full = path.join(scopeDir(scope), files[i]);
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const e = parseLine(lines[j]);
        if (e && Number.isSafeInteger(e.seq)) return e.seq;
      }
    }
    return 0;
  }

  function ensureScope(scope) {
    const existing = scopes.get(scope);
    if (existing) return existing;
    let entry = meta.scopes[scope];
    if (!entry || typeof entry !== 'object') {
      entry = {
        conv: newConvId(),
        archiveSeq: 0,
        backfilledAt: 0,
        resetCount: 0,
        updatedAt: now()
      };
      meta.scopes[scope] = entry;
      metaDirty = true;
    }
    if (!entry.conv) {
      entry.conv = newConvId();
      metaDirty = true;
    }
    const index = loadIndex(scope) || rebuildIndex(scope);
    const maxIndexSeq = index.days.reduce((m, d) => Math.max(m, Number(d.lastSeq) || 0), 0);
    const recovered = Math.max(Number(entry.archiveSeq) || 0, maxIndexSeq, lastSeqOnDisk(scope));
    if (recovered !== (Number(entry.archiveSeq) || 0)) {
      entry.archiveSeq = recovered;
      entry.updatedAt = now();
      metaDirty = true;
    }
    const st = { scope, meta: entry, index, dirty: 0, warned: false };
    scopes.set(scope, st);
    return st;
  }

  function touchDay(st, record, bytes) {
    const day = dayKey(record.at);
    let item = st.index.days.find((d) => d && d.day === day);
    if (!item) {
      item = {
        day,
        bytes: 0,
        lines: 0,
        firstAt: record.at,
        lastAt: record.at,
        firstSeq: record.seq,
        lastSeq: record.seq,
        convs: []
      };
      st.index.days.push(item);
      st.index.days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    }
    item.bytes += bytes;
    item.lines += 1;
    item.lastAt = record.at;
    item.lastSeq = record.seq;
    if (!item.convs.includes(record.conv)) item.convs.push(record.conv);
    st.index.totalBytes += bytes;
    st.index.totalLines += 1;
    st.index.updatedAt = now();
  }

  function maybeWarn(st) {
    if (!warnBytes || st.warned) return;
    if (st.index.totalBytes < warnBytes) return;
    st.warned = true;
    log(`[archive] ${st.scope} 归档体积 ${(st.index.totalBytes / 1048576).toFixed(1)}MB，超过告警阈值 ${(warnBytes / 1048576).toFixed(1)}MB（不会自动删除）`);
  }

  function append(scope, entry = {}) {
    const st = ensureScope(scope);
    const at = Number(entry.at) || now();
    const seq = (Number(st.meta.archiveSeq) || 0) + 1;
    st.meta.archiveSeq = seq;
    st.meta.updatedAt = now();
    metaDirty = true;
    const record = {
      at,
      conv: st.meta.conv,
      seq,
      msgSeq: Number.isSafeInteger(entry.msgSeq) ? entry.msgSeq : null,
      mid: entry.mid != null ? clip(entry.mid, 64) : null,
      dir: entry.dir === 'out' ? 'out' : 'in',
      from: entry.from != null ? clip(entry.from, 32) : '',
      name: clip(entry.name, 80),
      text: clip(entry.text, MAX_TEXT),
      plain: clip(entry.plain ?? entry.text, MAX_TEXT),
      media: Array.isArray(entry.media) ? entry.media.slice(0, MAX_MEDIA).map((m) => clip(m, 120)) : [],
      event: clip(entry.event || 'message', 24),
      quote: entry.quote != null ? clip(entry.quote, 64) : null,
      backfill: entry.backfill === true
    };
    const day = dayKey(at);
    const line = JSON.stringify(record) + '\n';
    fs.mkdirSync(scopeDir(scope), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath(scope, day), line, { encoding: 'utf8', mode: 0o600 });
    touchDay(st, record, Buffer.byteLength(line, 'utf8'));
    st.dirty += 1;
    if (st.dirty >= INDEX_FLUSH_EVERY) flush(scope);
    maybeWarn(st);
    return record;
  }

  function flush(scope) {
    const st = scopes.get(scope);
    if (!st) return;
    if (st.dirty > 0 || !fs.existsSync(indexPath(scope))) {
      atomicWriteJson(indexPath(scope), st.index);
      st.dirty = 0;
    }
    saveMeta();
  }

  function flushAll() {
    for (const scope of scopes.keys()) {
      try {
        flush(scope);
      } catch (error) {
        log(`[archive] flush 失败 ${scope}: ${error?.message ?? error}`);
      }
    }
    try {
      saveMeta();
    } catch (error) {
      log(`[archive] meta flush 失败: ${error?.message ?? error}`);
    }
  }

  function readRange(scope, range = {}) {
    const st = ensureScope(scope);
    const conv = range.conv ? String(range.conv) : null;
    const fromSeq = Number.isSafeInteger(range.fromSeq) ? range.fromSeq : 0;
    const toSeq = Number.isSafeInteger(range.toSeq) ? range.toSeq : Number.MAX_SAFE_INTEGER;
    const fromMs = Number(range.fromMs);
    const toMs = Number(range.toMs);
    const limit = Math.max(1, Math.min(10000, Number(range.limit) || 1000));
    const out = [];
    for (const file of listDayFiles(scope)) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(scopeDir(scope), file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        const e = parseLine(line);
        if (!e) continue;
        if (conv && e.conv !== conv) continue;
        if (Number(e.seq) < fromSeq || Number(e.seq) > toSeq) continue;
        if (Number.isFinite(fromMs) && Number(e.at) < fromMs) continue;
        if (Number.isFinite(toMs) && Number(e.at) > toMs) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    return out.slice(0, limit);
  }

  function stats(scope) {
    const st = ensureScope(scope);
    const days = st.index.days.map((d) => d.day);
    return {
      scope,
      conv: st.meta.conv,
      lastSeq: Number(st.meta.archiveSeq) || 0,
      backfilledAt: Number(st.meta.backfilledAt) || 0,
      resetCount: Number(st.meta.resetCount) || 0,
      totalBytes: st.index.totalBytes,
      totalLines: st.index.totalLines,
      days: st.index.days.length,
      oldestDay: days[0] || null,
      newestDay: days[days.length - 1] || null
    };
  }

  function getMeta(scope) {
    const st = ensureScope(scope);
    return { ...st.meta };
  }

  function markBackfilled(scope, at = now()) {
    const st = ensureScope(scope);
    st.meta.backfilledAt = Number(at) || now();
    st.meta.updatedAt = now();
    metaDirty = true;
    flush(scope);
  }

  /** 状态重置时轮换 conv：旧归档保留，新消息从 seq=1 开始。 */
  function rotateConv(scope) {
    const st = ensureScope(scope);
    st.meta.conv = newConvId();
    st.meta.archiveSeq = 0;
    st.meta.resetCount = (Number(st.meta.resetCount) || 0) + 1;
    st.meta.backfilledAt = 0;
    st.meta.updatedAt = now();
    metaDirty = true;
    flush(scope);
    return st.meta.conv;
  }

  return {
    root,
    metaPath,
    scopeForKey,
    scopeDir,
    filePath,
    ensureScope,
    append,
    readRange,
    stats,
    getMeta,
    markBackfilled,
    rotateConv,
    flush,
    flushAll,
    rebuildIndex
  };
}
