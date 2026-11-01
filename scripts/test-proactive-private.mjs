// M5 私聊主动发起 / 想法纯逻辑测试：node scripts/test-proactive-private.mjs
import assert from 'node:assert/strict';
import {
  evaluatePrivateProactive,
  privateProactiveProbability,
  pickSurfacedThoughts,
  thoughtOverlap,
  nextQuietEndMs
} from '../src/proactive.js';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

const now = Date.parse('2026-10-20T22:00:00+08:00');
const day = '2026-10-20';
const p = {
  probability: 0.3,
  thoughtBoost: 1.4,
  maxPerDay: 6,
  minGapMs: 90 * 60 * 1000,
  cooldownAfterAnyWakeMs: 30 * 60 * 1000,
  idleThresholdMs: 15 * 60 * 1000,
  maxUnanswered: 3,
  noProactiveIfUnread: true
};
const quiet = { start: 23, end: 8, hardBlock: true };
const base = () => ({
  unread: [],
  lastProactiveAt: 0,
  lastAnyWakeAt: 0,
  lastIncomingAt: now - 20 * 60 * 1000,
  proactiveDayKey: day,
  proactiveCount: 0,
  unansweredCount: 0,
  pendingThoughts: [],
  recentMessages: []
});
const evalNow = (st, extra = {}) => evaluatePrivateProactive({
  now, st, p, quiet,
  busy: false,
  isQuietHourFn: () => false,
  dayKeyFn: () => day,
  ...extra
});

try {
  console.log('[proactive] 闸门');
  ok('允许', () => assert.equal(evalNow(base()).allow, true));
  ok('静默硬阻断', () => assert.equal(evalNow(base(), { isQuietHourFn: () => true }).reason, 'quiet'));
  ok('未读阻断', () => assert.equal(evalNow({ ...base(), unread: [{}] }).reason, 'unread'));
  ok('最小间隔', () => assert.equal(evalNow({ ...base(), lastProactiveAt: now - 10 * 60 * 1000 }).reason, 'gap'));
  ok('任意唤醒冷却', () => assert.equal(evalNow({ ...base(), lastAnyWakeAt: now - 5 * 60 * 1000 }).reason, 'cooldown'));
  ok('每日上限', () => assert.equal(evalNow({ ...base(), proactiveCount: 6 }).reason, 'quota'));
  ok('跨天重置', () => {
    const r = evalNow({ ...base(), proactiveDayKey: 'old', proactiveCount: 6 });
    assert.equal(r.allow, true);
    assert.equal(r.resetDay, true);
    assert.equal(r.count, 0);
  });
  ok('未回复上限', () => assert.equal(evalNow({ ...base(), unansweredCount: 3 }).reason, 'unanswered'));
  ok('空闲不足', () => assert.equal(evalNow({ ...base(), lastIncomingAt: now - 5 * 60 * 1000 }).reason, 'idle'));
  ok('忙', () => assert.equal(evalNow(base(), { busy: true }).reason, 'busy'));

  console.log('[proactive] 概率');
  ok('基础概率命中', () => assert.equal(privateProactiveProbability({ p, st: base(), now, random: () => 0.2 }).fire, true));
  ok('基础概率不中', () => assert.equal(privateProactiveProbability({ p, st: base(), now, random: () => 0.9 }).fire, false));
  ok('有想法提升', () => {
    const st = { ...base(), pendingThoughts: [{ status: 'pending', text: '想问那家店' }] };
    assert.ok(privateProactiveProbability({ p, st, now, random: () => 0.35 }).prob > 0.3);
  });
  ok('刚说过降权', () => {
    const st = { ...base(), lastAiReplyAt: now - 5 * 60 * 1000 };
    assert.ok(privateProactiveProbability({ p, st, now }).prob < 0.3);
  });
  ok('1h 内 5 条降权', () => {
    const st = { ...base(), recentMessages: Array.from({ length: 5 }, () => ({ isSelf: true, time: now - 60000 })) };
    assert.ok(privateProactiveProbability({ p, st, now }).prob < 0.3);
  });

  console.log('[thought] 选择');
  const thoughts = [
    { id: 't_a', text: 'A', status: 'pending', priority: 2, createdAt: 1, notBefore: 0 },
    { id: 't_b', text: 'B', status: 'pending', priority: 4, createdAt: 2, notBefore: 0 },
    { id: 't_c', text: 'C', status: 'pending', priority: 5, createdAt: 3, notBefore: now - 1000 },
    { id: 't_d', text: 'D', status: 'used', priority: 5, createdAt: 4, notBefore: 0 }
  ];
  ok('proactive 取优先级最高 2 条', () => {
    const r = pickSurfacedThoughts(thoughts, 'proactiveCheck', now);
    assert.deepEqual(r.map((x) => x.id), ['t_c', 't_b']);
  });
  ok('thoughtDue 取最早到点', () => {
    const r = pickSurfacedThoughts(thoughts, 'thoughtDue', now);
    assert.equal(r[0].id, 't_a');
  });
  ok('未到点不选', () => {
    const r = pickSurfacedThoughts([{ id: 't_x', text: 'X', status: 'pending', notBefore: now + 10000 }], 'proactiveCheck', now);
    assert.equal(r.length, 0);
  });

  console.log('[thought] overlap');
  ok('同义命中', () => assert.equal(thoughtOverlap('明天再问你那家店', '想问问他那家店最后去了没'), true));
  ok('无关不命中', () => assert.equal(thoughtOverlap('嗯', '想问问他那家店最后去了没'), false));

  console.log('[thought] 静默结束时间');
  ok('23:30 -> 次日 08:00', () => {
    const at = Date.parse('2026-10-20T23:30:00+08:00');
    assert.equal(nextQuietEndMs(at, 23, 8), Date.parse('2026-10-21T08:00:00+08:00'));
  });

  ok('显式零间隔与零冷却生效', () => {
    const st = {...base(),lastProactiveAt:now-1,lastAnyWakeAt:now-1,lastIncomingAt:now-1};
    assert.equal(evaluatePrivateProactive({now,st,p:{...p,minGapMs:0,cooldownAfterAnyWakeMs:0,idleThresholdMs:0},quiet,isQuietHourFn:()=>false,dayKeyFn:()=>day}).allow,true);
  });
  ok('每日额度为零关闭主动', () => {
    assert.equal(evaluatePrivateProactive({now,st:base(),p:{...p,maxPerDay:0},quiet,isQuietHourFn:()=>false,dayKeyFn:()=>day}).reason,'quota');
  });
  console.log(`\n[proactive] 全部通过：${passed} 项`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
