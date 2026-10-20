// M2 长期记忆 CLI（操作者用；Agent 用 qq_memory_* 工具，不使用本脚本）。
//
// 用法：
//   node scripts/memory-cli.mjs list    --key private:928417857 [--status active|all] [--json]
//   node scripts/memory-cli.mjs stats   --key private:928417857
//   node scripts/memory-cli.mjs add     --key private:928417857 --text "..." [--kind person] [--subject Ellis] [--keywords "白米饭,榨菜"] [--salience 3] [--confidence 0.8] [--pinned]
//   node scripts/memory-cli.mjs forget  --key private:928417857 --id f_xxx
//   node scripts/memory-cli.mjs pin     --key private:928417857 --id f_xxx [--unpin]
//   node scripts/memory-cli.mjs search  --key private:928417857 --query "白米饭"
//   node scripts/memory-cli.mjs export  --key private:928417857
//   node scripts/memory-cli.mjs import-impressions --key private:928417857 [--dry-run] [--yes]
import path from 'node:path';
import { createMemoryStore, scopeForKey } from '../src/memory-store.js';
import { readJsonSafe } from '../src/state-io.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(name) {
  return process.argv.includes(name);
}
function num(name, fallback) {
  const raw = arg(name, '');
  if (raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'list';
const key = arg('--key');
const stateDir = path.resolve(arg('--state-dir', path.join(process.cwd(), 'state')));
const asJson = has('--json');

if (!key) {
  console.error('缺少 --key private:<QQ>');
  process.exit(2);
}
const info = scopeForKey(key);
if (!info) {
  console.error('只支持 private:<QQ>（群聊没有长期记忆库）');
  process.exit(2);
}
const store = createMemoryStore({
  root: path.join(stateDir, 'memory'),
  metaPath: path.join(stateDir, 'memory', 'meta.json'),
  log: (line) => console.error(line)
});

function print(data) {
  if (typeof data === 'string') {
    console.log(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

try {
  if (command === 'list') {
    const status = arg('--status', 'active');
    const limit = num('--limit', 50);
    const facts = store.listFacts(info.scope, { status, limit });
    if (asJson) {
      print(facts);
    } else {
      print(`[${info.scope}] ${facts.length} 条（status=${status}）`);
      for (const f of facts) {
        const flags = [f.pinned ? 'PIN' : '', f.status !== 'active' ? f.status : ''].filter(Boolean).join(',');
        print(`${f.id} [${f.kind}] ${f.subject ? f.subject + '：' : ''}${f.text}${flags ? ` (${flags})` : ''}`);
      }
    }
  } else if (command === 'stats') {
    print(store.stats(info.scope));
  } else if (command === 'add') {
    const text = arg('--text');
    if (!text) {
      console.error('add 需要 --text');
      process.exit(2);
    }
    const keywords = arg('--keywords')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const supersedes = arg('--supersedes')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const result = store.addFact(info.scope, {
      kind: arg('--kind', 'person'),
      subject: arg('--subject'),
      text,
      keywords,
      confidence: num('--confidence', 0.7),
      salience: num('--salience', 3),
      pinned: has('--pinned'),
      supersedes
    }, { source: 'operator' });
    if (!result) {
      console.error('新增失败（text 为空、记忆文件只读，或字段非法）');
      process.exit(1);
    }
    print({ ok: true, updated: result.updated, fact: result.fact });
  } else if (command === 'forget') {
    const id = arg('--id');
    if (!id) {
      console.error('forget 需要 --id');
      process.exit(2);
    }
    print({ ok: store.retract(info.scope, id) });
  } else if (command === 'pin') {
    const id = arg('--id');
    if (!id) {
      console.error('pin 需要 --id');
      process.exit(2);
    }
    print({ ok: store.pin(info.scope, id, !has('--unpin')) });
  } else if (command === 'search') {
    const query = arg('--query');
    if (!query) {
      console.error('search 需要 --query');
      process.exit(2);
    }
    print(store.search(info.scope, query, num('--limit', 10)));
  } else if (command === 'export') {
    print(store.formatForGetPrompt(info.scope, num('--max-chars', 4000)));
  } else if (command === 'import-impressions') {
    const socialPath = path.join(stateDir, 'social-v2.json');
    const social = readJsonSafe(socialPath, null);
    const st = social?.conversations?.[info.scope];
    if (!st) {
      console.error(`找不到 ${socialPath} 里的 ${info.scope}`);
      process.exit(1);
    }
    const dryRun = has('--dry-run') || !has('--yes');
    const result = store.importImpressions(info.scope, st.memberImpressions, { dryRun });
    if (asJson) {
      print(result);
    } else {
      console.log(`候选 ${result.candidates.length} 条${dryRun ? '（dry-run，不写盘）' : `，已导入 ${result.imported} 条`}`);
      for (const c of result.candidates) console.log(`- ${c.subject}：${c.text}`);
      if (dryRun) console.log('\n确认无误后加 --yes 执行写入。');
    }
  } else {
    console.error(`未知命令：${command}`);
    process.exit(2);
  }
} catch (error) {
  console.error(`执行失败：${error?.message ?? error}`);
  process.exit(1);
}
