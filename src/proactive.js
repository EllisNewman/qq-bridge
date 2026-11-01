// M5 私聊主动发起 / 想法的纯判定逻辑，方便单测；bridge 只负责定时器与状态落盘。
import { tokenize } from './memory-store.js';
import { startOfDayMs } from './time.js';

export function thoughtOverlap(text, thoughtText) {
  const a = new Set(tokenize(text));
  const b = tokenize(thoughtText);
  if (!a.size || !b.length) return false;
  return b.some((x) => a.has(x));
}

export function pickSurfacedThoughts(thoughts, reason, now = Date.now()) {
  const list = (Array.isArray(thoughts) ? thoughts : [])
    .filter((x) => x && x.status === 'pending' && x.text && (!x.expiresAt || now < Number(x.expiresAt)))
    .filter((x) => !x.notBefore || now >= Number(x.notBefore));
  if (!list.length) return [];
  if (reason === 'thoughtDue') {
    return [...list].sort((a, b) => (Number(a.notBefore) || 0) - (Number(b.notBefore) || 0)).slice(0, 1);
  }
  return [...list]
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    .slice(0, 2);
}

export function nextQuietEndMs(at, start, end) {
  let target = startOfDayMs(at) + Number(end) * 3600000;
  if (target <= at) target += 86400000;
  return target;
}

/**
 * 私聊主动机会的闸门（不含概率）。返回 { allow, reason, day, resetDay, count }。
 */
export function evaluatePrivateProactive({ now, st, p = {}, quiet = {}, busy = false, isQuietHourFn, dayKeyFn }) {
  const isQuiet = typeof isQuietHourFn === 'function' ? isQuietHourFn : () => false;
  const keyOf = typeof dayKeyFn === 'function' ? dayKeyFn : () => '';
  if (quiet.hardBlock !== false && isQuiet(now, Number(quiet.start ?? 23), Number(quiet.end ?? 8))) {
    return { allow: false, reason: 'quiet', day: keyOf(now), resetDay: false, count: Number(st.proactiveCount) || 0 };
  }
  if (p.noProactiveIfUnread !== false && Array.isArray(st.unread) && st.unread.length > 0) {
    return { allow: false, reason: 'unread', day: keyOf(now), resetDay: false, count: Number(st.proactiveCount) || 0 };
  }
  const minGap = Math.max(0, Number(p.minGapMs ?? 90 * 60 * 1000));
  if (st.lastProactiveAt && now - Number(st.lastProactiveAt) < minGap) {
    return { allow: false, reason: 'gap', day: keyOf(now), resetDay: false, count: Number(st.proactiveCount) || 0 };
  }
  const cooldown = Math.max(0, Number(p.cooldownAfterAnyWakeMs ?? 30 * 60 * 1000));
  if (st.lastAnyWakeAt && now - Number(st.lastAnyWakeAt) < cooldown) {
    return { allow: false, reason: 'cooldown', day: keyOf(now), resetDay: false, count: Number(st.proactiveCount) || 0 };
  }
  const day = keyOf(now);
  const resetDay = st.proactiveDayKey !== day;
  const count = resetDay ? 0 : (Number(st.proactiveCount) || 0);
  const maxPerDay = Math.max(0, Number(p.maxPerDay ?? 6));
  if (count >= maxPerDay) return { allow: false, reason: 'quota', day, resetDay, count };
  const maxUnanswered = Math.max(1, Number(p.maxUnanswered) || 3);
  if ((Number(st.unansweredCount) || 0) >= maxUnanswered) {
    return { allow: false, reason: 'unanswered', day, resetDay, count };
  }
  const idleThreshold = Math.max(0, Number(p.idleThresholdMs ?? 15 * 60 * 1000));
  if (st.lastIncomingAt && now - Number(st.lastIncomingAt) < idleThreshold) {
    return { allow: false, reason: 'idle', day, resetDay, count };
  }
  if (busy) return { allow: false, reason: 'busy', day, resetDay, count };
  return { allow: true, reason: 'ok', day, resetDay, count };
}

/** 只算概率，不落盘；random 可注入用于测试。 */
export function privateProactiveProbability({ p = {}, st, now, random = Math.random }) {
  let prob = Number(p.probability);
  prob = Math.min(1, Math.max(0, Number.isFinite(prob) ? prob : 0.3));
  const pending = (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [])
    .filter((x) => x && x.status === 'pending' && (!x.expiresAt || now < Number(x.expiresAt)) && (!x.notBefore || now >= Number(x.notBefore)));
  if (pending.length) prob = Math.min(1, prob * (Number(p.thoughtBoost) || 1.4));
  if (st.lastAiReplyAt && now - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const aiCount = recent.filter((m) => m && m.isSelf && now - Number(m.time || 0) < 60 * 60 * 1000).length;
  if (aiCount >= 5) prob *= 0.3;
  return { prob, fire: random() < prob, pending: pending.length };
}
