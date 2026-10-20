// 统一时间标准（M0）。
//
// 两条规则，所有新老代码都应遵守：
//   1) 存储/比较：epoch 毫秒（UTC）。ISO 字符串只作为旧数据兼容输入。
//   2) 展示/判定：配置时区（默认 UTC+8），不依赖容器的 TZ 环境变量。
//
// 为什么不用 `toLocaleString()` / `getHours()`：
//   容器默认是 UTC，`getHours()` 拿到的是 UTC 小时。旧代码用它判断「23:00–08:00
//   静默时段」，实际覆盖的是北京时间 07:00–16:00 —— 昼夜完全反了。日志与提示词
//   也因此比本地时间少 8 小时。这里用固定偏移做算术，不依赖 ICU、没有 DST 问题。
//
// 中国没有夏令时，固定偏移足够。若将来需要任意 IANA 时区，再在这里加 Intl 分支。

const DEFAULT_OFFSET_MIN = 480; // UTC+8
const MIN_OFFSET_MIN = -12 * 60;
const MAX_OFFSET_MIN = 14 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

let offsetMin = DEFAULT_OFFSET_MIN;
let zoneLabel = 'UTC+8';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatOffsetLabel(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function toShifted(ms) {
  return new Date(Number(ms) + offsetMin * 60 * 1000);
}

function isFiniteMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms);
}

/**
 * 配置时区。utcOffsetMinutes 会被收敛到 [-720, 840]；label 为空时按偏移生成。
 * @param {{ utcOffsetMinutes?: number, label?: string }} [options]
 * @returns {{ utcOffsetMinutes: number, label: string }}
 */
export function configureTime(options = {}) {
  const rawOffset = Number(options?.utcOffsetMinutes);
  if (Number.isFinite(rawOffset)) {
    offsetMin = Math.min(MAX_OFFSET_MIN, Math.max(MIN_OFFSET_MIN, Math.round(rawOffset)));
  }
  const rawLabel = String(options?.label ?? '').trim();
  zoneLabel = rawLabel || formatOffsetLabel(offsetMin);
  return { utcOffsetMinutes: offsetMin, label: zoneLabel };
}

export function timeConfig() {
  return { utcOffsetMinutes: offsetMin, label: zoneLabel };
}

export function timezoneLabel() {
  return zoneLabel;
}

export function nowMs() {
  return Date.now();
}

/** 0–23，配置时区的小时。 */
export function hourOf(ms = Date.now()) {
  if (!isFiniteMs(ms)) return NaN;
  return toShifted(ms).getUTCHours();
}

/** 0–59，配置时区的分钟。 */
export function minuteOf(ms = Date.now()) {
  if (!isFiniteMs(ms)) return NaN;
  return toShifted(ms).getUTCMinutes();
}

/** "YYYY-MM-DD"（配置时区）。 */
export function dayKey(ms = Date.now()) {
  if (!isFiniteMs(ms)) return '—';
  const d = toShifted(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "YYYY-MM"（配置时区）。 */
export function monthKey(ms = Date.now()) {
  if (!isFiniteMs(ms)) return '—';
  const d = toShifted(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * 配置时区当日 00:00 对应的 epoch ms。
 * 例：UTC+8 的 2026-10-20 00:00 == Date.parse('2026-10-19T16:00:00Z')。
 */
export function startOfDayMs(ms = Date.now()) {
  if (!isFiniteMs(ms)) return NaN;
  const d = toShifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offsetMin * 60 * 1000;
}

/** "HH:mm:ss"（配置时区）。 */
export function formatClock(ms = Date.now()) {
  if (!isFiniteMs(ms)) return '—';
  const d = toShifted(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "YYYY-MM-DD"（配置时区）。 */
export function formatDate(ms = Date.now()) {
  return dayKey(ms);
}

/** "YYYY-MM-DD HH:mm:ss"（配置时区）。 */
export function formatDateTime(ms = Date.now()) {
  if (!isFiniteMs(ms)) return '—';
  const d = toShifted(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "YYYY-MM-DD HH:mm:ss（UTC+8）" */
export function formatWithZone(ms = Date.now()) {
  if (!isFiniteMs(ms)) return '—';
  return `${formatDateTime(ms)}（${zoneLabel}）`;
}

/**
 * 把 number / ISO 字符串 / Date 统一成 epoch ms；无法解析返回 NaN。
 * 注意：不带时区的字符串按运行环境本地时区解析，旧数据里不要这么写。
 */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/**
 * 是否落在静默时段。start/end 为 0–23 的小时；支持跨零点（23 → 8）。
 * start === end 视为"没有静默时段"。
 */
export function isQuietHour(ms, start, end) {
  const hour = hourOf(ms);
  if (!Number.isFinite(hour)) return false;
  const s = Math.round(Number(start));
  const e = Math.round(Number(end));
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const from = ((s % 24) + 24) % 24;
  const to = ((e % 24) + 24) % 24;
  if (from === to) return false;
  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/** 当天已经过去的毫秒数（用于每日预算/重置判断）。 */
export function msSinceStartOfDay(ms = Date.now()) {
  const start = startOfDayMs(ms);
  return Number.isFinite(start) ? ms - start : NaN;
}

export { DAY_MS };
