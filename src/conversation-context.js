// Bounded, session-scoped originals. Model previews are never the source of truth.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, readJsonSafe } from './state-io.js';

export const CONTEXT_LIMIT = 200;
export const ORIGINAL_MAX_CHARS = 64000;

export function createConversationContext(root, warn = () => {}) {
  const cache = new Map();
  // Receipts are intentionally process-local; after restart unread must be read again.
  const reads = new Map();
  function scope(key, token) {
    const id = crypto.createHash('sha256').update(`${key}\0${token}`).digest('hex');
    if (!cache.has(id)) {
      const file = path.join(root, `${id}.json`);
      const saved = readJsonSafe(file, null);
      cache.set(id, { file, entries: Array.isArray(saved?.entries) ? saved.entries
        .filter((m) => m && typeof m.contextRef === 'string' && typeof m.text === 'string').slice(-CONTEXT_LIMIT) : [] });
      if (cache.size > 32) cache.delete(cache.keys().next().value);
    }
    return cache.get(id);
  }
  return {
    append(key, token, entry) {
      const st = scope(key, token);
      const text = String(entry.text ?? '');
      const body = text.slice(0, ORIGINAL_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '');
      const stored = { ...entry, contextRef: `ctx_${crypto.randomUUID()}`, text: body,
        originalChars: text.length, originalTruncated: text.length > ORIGINAL_MAX_CHARS };
      st.entries.push(stored);
      st.entries = st.entries.slice(-CONTEXT_LIMIT);
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        atomicWriteJson(st.file, { version: 1, entries: st.entries });
      } catch (error) { warn(`[context] 原文持久化失败: ${error?.message ?? error}`); }
      return stored;
    },
    find(key, token, ref) {
      const entries = scope(key, token).entries;
      // Explicit internal refs, then real QQ ids, then legacy local incoming seqs.
      return entries.find((m) => m.contextRef === String(ref))
        ?? entries.find((m) => m.messageId && String(m.messageId) === String(ref))
        ?? entries.find((m) => Number.isSafeInteger(m.seq) && String(m.seq) === String(ref)) ?? null;
    },
    read(key, token, original, offset, end) {
      const id = `${key}\0${token}\0${original.contextRef}`;
      const ranges = [...(reads.get(id) ?? []), [offset, end]].sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      let through = 0;
      for (const [start, stop] of merged) {
        if (start > through) break;
        through = Math.max(through, stop);
      }
      reads.set(id, merged.slice(0, 128));
      if (reads.size > 6400) reads.delete(reads.keys().next().value);
      return through >= original.text.length && !original.originalTruncated;
    },
    quoted(key, token, text, selfOnly = false) {
      const match = /^\[引用 ([^：\n]+)：([\s\S]*?)\]/u.exec(String(text));
      if (!match || !match[2]) return null;
      const hits = scope(key, token).entries.filter((m) => (selfOnly ? m.isSelf : m.sender === match[1])
        && (m.text === match[2] || m.text.startsWith(match[2])));
      // Ambiguous quotes must never be presented as a definite link.
      return hits.length === 1 ? hits[0] : null;
    },
  };
}

// Extractive preview, not an LLM summary: keep the opening and ending, flag the gap.
export function contextPreview(entry, maxChars = 200) {
  const text = String(entry.text ?? '');
  if (text.length <= maxChars) return { ...entry, text };
  const head = Math.ceil(maxChars * 0.65);
  return { ...entry, text: `${text.slice(0, head).replace(/[\uD800-\uDBFF]$/, '')}…[中间省略]…${text.slice(-(maxChars - head)).replace(/^[\uDC00-\uDFFF]/, '')}`,
    textTruncated: true };
}

// Count exchanges rather than bubbles. Select each input before its response so
// the budget cannot retain four answers while silently dropping their question.
export function recentExchangeGroups(recent, unread, limit) {
  const pending = new Set(unread.map((m) => m.seq));
  const history = recent.filter((m) => !Number.isSafeInteger(m.seq) || !pending.has(m.seq));
  const groups = [];
  for (let i = history.length - 1; i >= 0 && groups.length < limit;) {
    const replies = [];
    while (i >= 0 && history[i].isSelf) replies.unshift(history[i--]);
    const input = i >= 0 ? history[i--] : null;
    const inputSeq = replies.find((m) => m.contextInputSeq > 0)?.contextInputSeq;
    const observedInput = inputSeq ? recent.find((m) => !m.isSelf && m.seq === inputSeq && !pending.has(m.seq)) : null;
    groups.push([observedInput ?? input, ...replies.slice(-4)].filter(Boolean));
  }
  return groups;
}

export function orderContextMessages(messages, history) {
  const identity = (m) => m.contextRef || (Number.isSafeInteger(m.seq) ? `seq:${m.seq}` : `${m.time}:${m.sender}:${m.text}`);
  const positions = new Map(history.map((m, index) => [identity(m), index]));
  return messages.sort((a, b) => {
    const left = positions.get(identity(a)), right = positions.get(identity(b));
    // Arrival order is authoritative, including messages with identical timestamps.
    if (left !== undefined && right !== undefined) return left - right;
    return (a.time || 0) - (b.time || 0);
  });
}
