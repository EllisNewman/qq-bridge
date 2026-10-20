// M0 时间标准回归测试：node scripts/test-time.mjs
//
// 覆盖点：
//   - UTC+8 的 dayKey / hourOf（跨零点、前一天 UTC 晚上）
//   - 静默时段跨零点判断（23–8）
//   - 日志/提示词格式化
//   - startOfDayMs（当日 00:00 的 epoch ms）
//   - 时区切换后不依赖容器 TZ
import assert from 'node:assert/strict';
import {
  configureTime,
  timeConfig,
  dayKey,
  hourOf,
  minuteOf,
  monthKey,
  startOfDayMs,
  msSinceStartOfDay,
  formatClock,
  formatDate,
  formatDateTime,
  formatWithZone,
  parseTime,
  isQuietHour,
} from '../src/time.js';

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

console.log('[time] UTC+8 默认时区');

configureTime({ utcOffsetMinutes: 480, label: 'UTC+8' });
assert.deepEqual(timeConfig(), { utcOffsetMinutes: 480, label: 'UTC+8' });

// 北京时间 2026-10-20 23:30 == UTC 15:30
const t2330 = Date.parse('2026-10-20T15:30:00Z');
// 北京时间 2026-10-20 07:30 == UTC 前一天 23:30
const t0730 = Date.parse('2026-10-19T23:30:00Z');
// 北京时间 2026-10-21 00:00 == UTC 10-20 16:00
const t0000next = Date.parse('2026-10-20T16:00:00Z');
// 北京时间 2026-10-20 12:00 == UTC 04:00
const t1200 = Date.parse('2026-10-20T04:00:00Z');

ok('23:30 的 dayKey 是当天', () => assert.equal(dayKey(t2330), '2026-10-20'));
ok('23:30 的 hour 是 23', () => assert.equal(hourOf(t2330), 23));
ok('07:30 的 dayKey 是当天（不是 UTC 前一天）', () => assert.equal(dayKey(t0730), '2026-10-20'));
ok('07:30 的 hour 是 7', () => assert.equal(hourOf(t0730), 7));
ok('次日 00:00 的 dayKey 进位', () => assert.equal(dayKey(t0000next), '2026-10-21'));
ok('monthKey', () => assert.equal(monthKey(t2330), '2026-10'));

ok('静默 23–8：23:30 命中', () => assert.equal(isQuietHour(t2330, 23, 8), true));
ok('静默 23–8：07:30 命中', () => assert.equal(isQuietHour(t0730, 23, 8), true));
ok('静默 23–8：12:00 不命中', () => assert.equal(isQuietHour(t1200, 23, 8), false));
ok('静默 23–8：22:59 不命中', () => {
  assert.equal(isQuietHour(Date.parse('2026-10-20T14:59:00Z'), 23, 8), false);
});
ok('静默 23–8：08:00 不命中（右开区间）', () => {
  assert.equal(isQuietHour(Date.parse('2026-10-20T00:00:00Z'), 23, 8), false);
});
ok('start===end 视为无静默', () => assert.equal(isQuietHour(t2330, 8, 8), false));

ok('formatClock', () => assert.equal(formatClock(t2330), '23:30:00'));
ok('formatDate', () => assert.equal(formatDate(t2330), '2026-10-20'));
ok('formatDateTime 带日期', () => assert.equal(formatDateTime(t2330), '2026-10-20 23:30:00'));
ok('formatWithZone 带时区标签', () => assert.equal(formatWithZone(t2330), '2026-10-20 23:30:00（UTC+8）'));

ok('startOfDayMs == 前一日 UTC 16:00', () => assert.equal(startOfDayMs(t2330), Date.parse('2026-10-19T16:00:00Z')));
ok('msSinceStartOfDay 为 23.5 小时', () => assert.equal(msSinceStartOfDay(t2330), 23.5 * 3600 * 1000));
ok('minuteOf', () => assert.equal(minuteOf(t2330), 30));

ok('parseTime：数字原样返回', () => assert.equal(parseTime(t2330), t2330));
ok('parseTime：ISO 字符串', () => assert.equal(parseTime('2026-10-20T15:30:00Z'), t2330));
ok('parseTime：Date', () => assert.equal(parseTime(new Date(t2330)), t2330));
ok('parseTime：非法返回 NaN', () => assert.equal(Number.isNaN(parseTime('not-a-time')), true));
ok('非法 ms 的格式化返回占位', () => assert.equal(formatDateTime(NaN), '—'));

console.log('[time] 切换到 UTC 后行为随之变化（证明不依赖容器 TZ）');
configureTime({ utcOffsetMinutes: 0, label: 'UTC' });
ok('UTC 下 23:30 仍是 15:30', () => assert.equal(hourOf(t2330), 15));
ok('UTC 下 dayKey 不变', () => assert.equal(dayKey(t2330), '2026-10-20'));
ok('UTC 下 formatWithZone 标签变化', () => assert.equal(formatWithZone(t2330), '2026-10-20 15:30:00（UTC）'));
ok('UTC 下 15:30 不命中 23–8', () => assert.equal(isQuietHour(t2330, 23, 8), false));

console.log('[time] 偏移越界会被收敛');
configureTime({ utcOffsetMinutes: 9999 });
ok('offset 上限 840', () => assert.equal(timeConfig().utcOffsetMinutes, 840));
configureTime({ utcOffsetMinutes: -9999 });
ok('offset 下限 -720', () => assert.equal(timeConfig().utcOffsetMinutes, -720));
configureTime({ utcOffsetMinutes: 480, label: 'UTC+8' });

console.log(`\n[time] 全部通过：${passed} 项`);
