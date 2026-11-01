// M4 蒸馏纯逻辑测试：node scripts/test-memory-distill.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDistillPrompt,
  selectDistillWindow,
  parseDistillOutput,
  applyDistillOutput,
  buildHandoffPrompt,
  parseHandoffOutput,
  fallbackHandoff,
  renderDailyDigest
} from '../src/memory-distiller.js';
import { createMemoryStore } from '../src/memory-store.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-distill-test-'));
const scope = 'private:928417857';
const store = createMemoryStore({
  root: path.join(tmp, 'memory'),
  metaPath: path.join(tmp, 'memory', 'meta.json'),
  log: () => {}
});

const messages = [
  { seq: 1, dir: 'in', senderName: 'Ellis', text: '我不喜欢被叫客服', at: 1792496000000, conv: 'c_one' },
  { seq: 2, dir: 'out', senderName: 'Bot', text: '好，记住了', at: 1792496010000, conv: 'c_one' },
  { seq: 3, dir: 'in', senderName: 'Ellis', text: '周末想去动物园看白鲸', at: 1792496020000, conv: 'c_one' }
];

try {
  console.log('[distill] prompt');
  const prompt = buildDistillPrompt({
    scope,
    conv: 'c_one',
    fromSeq: 1,
    toSeq: 3,
    messages,
    facts: [{ id: 'f_old', kind: 'rule', subject: '', text: '不要叫客服', salience: 3 }],
    impressions: { Ellis: { traits: ['喜欢白米饭', '不喜欢客服'] } },
    rolling: '之前聊过吃的'
  });
  ok('含不可信消息边界', () => assert.ok(prompt.includes('<untrusted_messages>') && prompt.includes('</untrusted_messages>')));
  ok('含消息与 seq', () => assert.ok(prompt.includes('#1') && prompt.includes('不喜欢被叫客服')));
  ok('含已有 fact', () => assert.ok(prompt.includes('f_old') && prompt.includes('不要叫客服')));
  ok('含 impressions 线索', () => assert.ok(prompt.includes('喜欢白米饭')));
  ok('含 JSON 输出要求', () => assert.ok(prompt.includes('"facts"') && prompt.includes('"evidenceSeqs"')));

  console.log('[distill] 解析');
  const parsed = parseDistillOutput(`\`\`\`json
  {
    "facts": [
      {"kind":"rule","subject":"","text":"不要叫客服","keywords":["客服","称呼"],"confidence":0.9,"salience":4,"evidenceSeqs":[1],"supersedes":["f_old"]},
      {"kind":"event","subject":"Ellis","text":"周末去动物园看白鲸","keywords":["动物园","白鲸"],"confidence":0.7,"salience":2,"evidenceSeqs":[3]}
    ],
    "episodes": [{"summary":"聊了称呼和周末计划","participants":["Ellis"],"keywords":["周末"],"seqFrom":1,"seqTo":3}],
    "rolling": "最近聊了称呼与动物园",
    "drop": []
  }
  \`\`\``);
  ok('facts 数量', () => assert.equal(parsed.facts.length, 2));
  ok('事实字段', () => assert.equal(parsed.facts[0].confidence, 0.9));
  ok('episode', () => assert.equal(parsed.episodes.length, 1));

  ok('无 JSON 抛错', () => assert.throws(() => parseDistillOutput('我不确定'), /JSON/));
  ok('坏 JSON 抛错', () => assert.throws(() => parseDistillOutput('{"facts": [}'), /JSON/));

  console.log('[distill] 写入 memory store');
  // 先放一条旧 fact，验证 supersede
  const oldFact = store.addFact(scope, { kind: 'rule', text: '别叫客服', keywords: ['客服'] }, { source: 'operator' }).fact;
  parsed.facts[0].supersedes = [oldFact.id];
  const applied = applyDistillOutput(store, scope, parsed, { messages, conv: 'c_one', throughSeq: 3 });
  ok('新增 2 条', () => assert.equal(applied.added, 2));
  ok('episode 1 条', () => assert.equal(applied.episodes, 1));
  ok('水位推进', () => assert.equal(store.snapshot(scope).summarizedThroughSeq, 3));
  const facts = store.listFacts(scope);
  ok('证据来自消息', () => assert.equal(facts.find((f) => f.text.includes('白鲸')).evidence[0].seq, 3));
  ok('supersede 旧条', () => assert.equal(store.listFacts(scope, { status: 'all' }).find((f) => f.id === oldFact.id).status, 'superseded'));
  ok('rolling 写入', () => assert.ok(store.snapshot(scope).rolling.text.includes('称呼')));

  console.log('[distill] 无证据不写入');
  const before = store.listFacts(scope).length;
  const bad = applyDistillOutput(store, scope, { facts: [{ kind: 'event', text: '没有证据', evidenceSeqs: [999] }], episodes: [], rolling: '', drop: [] }, { messages, conv: 'c_one', throughSeq: 3 });
  ok('跳过无证据 fact', () => assert.equal(bad.added, 0));
  ok('错误记录', () => assert.ok(bad.errors.length >= 1));
  ok('不增加 fact', () => assert.equal(store.listFacts(scope).length, before));

  console.log('[distill] handoff');
  const hp = buildHandoffPrompt({ scope, messages });
  ok('handoff prompt 含边界', () => assert.ok(hp.includes('<untrusted_messages>')));
  ok('handoff JSON 解析', () => assert.equal(parseHandoffOutput('{"handoff":"正在聊周末去动物园"}'), '正在聊周末去动物园'));
  ok('handoff 纯文本回退', () => assert.ok(parseHandoffOutput('正在聊周末去动物园').includes('动物园')));
  ok('fallbackHandoff', () => assert.ok(fallbackHandoff(messages).includes('动物园')));

  console.log('[distill] 日终摘要');
  const md = renderDailyDigest({ day: '2026-10-20', scope, episodes: parsed.episodes, facts: facts.slice(0, 2) });
  ok('digest 标题', () => assert.ok(md.includes('# 2026-10-20')));
  ok('digest 事件', () => assert.ok(md.includes('## 事件')));
  ok('digest 结论', () => assert.ok(md.includes('## 结论')));


  ok('窗口不丢弃已选消息的尾部', () => {
    const all = Array.from({length:60}, (_,i) => ({seq:i+1,text:'长'.repeat(500)}));
    const selected = selectDistillWindow(all);
    const p = buildDistillPrompt({messages:selected});
    assert.equal(p.split('\n').filter(x => /^#\d+ /.test(x)).length, selected.length);
    assert.ok(selected.length < 60);
    assert.ok(buildDistillPrompt({messages:[{seq:1,text:'长'.repeat(13000)+'结尾'}]}).includes('结尾'));
  });
  ok('零置信度保留、无 schema 拒绝', () => {
    assert.equal(parseDistillOutput('{"facts":[{"text":"x","confidence":0}],"episodes":[]}').facts[0].confidence,0);
    assert.throws(() => parseDistillOutput('{}'));
  });
  ok('无效 episode 不推进水位、不写事实', () => {
    const before = JSON.stringify(store.snapshot(scope));
    const result = applyDistillOutput(store,scope,{facts:[],episodes:[{summary:'坏范围',seqFrom:99,seqTo:100}]},{messages,throughSeq:100});
    assert.equal(result.ok,false);
    assert.equal(JSON.stringify(store.snapshot(scope)),before);
  });
  ok('事务异常撤销全部内存修改', () => {
    const before = JSON.stringify(store.snapshot(scope));
    assert.throws(() => store.transaction(scope, () => {store.setRolling(scope,'错误');throw new Error('test');}));
    assert.equal(JSON.stringify(store.snapshot(scope)),before);
  });
  console.log(`\n[distill] 全部通过：${passed} 项`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
