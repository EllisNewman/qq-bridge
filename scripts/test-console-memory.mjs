// M6 控制台记忆页 / 后端路由的静态契约测试（不需要启动 bridge）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

ok('导航有记忆页', () => assert.ok(html.includes('data-view="memory"')));
ok('页面段落存在', () => assert.ok(html.includes('id="section-memory"')));
ok('consolePages 有 memory', () => assert.ok(/memory:\s*\['记忆与备份'/.test(html)));
ok('scope 选择器', () => assert.ok(html.includes('id="memoryScope"')));
ok('facts 容器', () => assert.ok(html.includes('id="memoryFacts"')));
ok('备份容器', () => assert.ok(html.includes('id="memoryBackups"')));
ok('加载函数', () => assert.ok(html.includes('function loadMemoryPage')));
ok('后端 scopes 路由', () => assert.ok(bridge.includes("'/api/memory/scopes'")));
ok('后端 metrics 路由', () => assert.ok(bridge.includes("'/api/metrics'")));
ok('后端 backup 路由', () => assert.ok(bridge.includes("'/api/memory/backup'")));

console.log(`\n[console] 全部通过：${passed} 项`);
