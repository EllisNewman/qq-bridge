// 私聊原始归档导出/查看：node scripts/archive-export.mjs --key private:928417857 [--day 2026-10-20] [--limit 50] [--json]
//
// 默认从仓库根目录的 state/archive 读取；可用 QQ_ARCHIVE_ROOT 覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { createArchiveStore, scopeForKey } from '../src/archive-log.js';
import { formatDateTime, parseTime } from '../src/time.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const key = arg('--key');
if (!key) {
  console.error('用法: node scripts/archive-export.mjs --key private:<QQ> [--day YYYY-MM-DD] [--limit 50] [--json]');
  process.exit(2);
}
const info = scopeForKey(key);
if (!info) {
  console.error('只支持 private:<QQ>（群聊没有记忆归档）');
  process.exit(2);
}
const root = process.env.QQ_ARCHIVE_ROOT || path.resolve(process.cwd(), 'state', 'archive');
const metaPath = process.env.QQ_ARCHIVE_META || path.resolve(process.cwd(), 'state', 'memory', 'meta.json');
const store = createArchiveStore({ root, metaPath });
const day = arg('--day');
const limit = Math.max(1, Math.min(10000, Number(arg('--limit', '50')) || 50));
const asJson = process.argv.includes('--json');

const stats = store.stats(info.scope);
console.error(`[archive] ${info.scope} conv=${stats.conv} lines=${stats.totalLines} bytes=${stats.totalBytes} days=${stats.days} ${stats.oldestDay || '-'}..${stats.newestDay || '-'}`);

const rows = day
  ? (() => {
      const file = store.filePath(info.scope, day);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    })()
  : store.readRange(info.scope, { limit });

for (const row of rows) {
  if (asJson) {
    console.log(JSON.stringify(row));
    continue;
  }
  const who = row.dir === 'out' ? '我' : (row.name || row.from || '对方');
  const when = formatDateTime(parseTime(row.at));
  const flag = row.backfill ? '[回填]' : '';
  console.log(`${when} ${flag}[${row.event}] ${who}: ${row.text}`);
}
console.error(`[archive] 输出 ${rows.length} 条`);
