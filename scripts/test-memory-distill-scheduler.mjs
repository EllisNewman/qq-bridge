import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const h = await bridgeHarness();
try {
 h.getSocialV2State('private:123');
 h.setReady(false);
 let timer;
 await Promise.race([h.enqueueDistill(() => h.runDailyDistill()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('daily deadlock')),1000);})]).finally(()=>clearTimeout(timer));
 assert.equal(await h.enqueueDistill(()=>42),42);
 h.cfg.memory.enabled=false;
 assert.equal(await h.distillScopeNow('private:123'),null);
 console.log('PASS daily queue drains; memory disabled skips distillation');
} finally {await h.close();}

// Restart with a retained archive from a much larger previous generation.
const old = await bridgeHarness();
const key = 'private:123';
const files = {};
let conv;
try {
 for(let i=0;i<100;i++) old.archiveStore.append(key,{at:Date.UTC(2026,9,20),text:'旧代际消息'});
 old.archiveStore.flushAll();
 old.memoryStore.setSummarizedThroughSeq(key,100);
 conv=old.archiveStore.rotateConv(key);
 for(const rel of ['archive/private_123/index.json','archive/private_123/2026-10-20.jsonl','memory/meta.json','memory/private_123.json']) {
  files['state/'+rel]=fs.readFileSync(path.join(old.temp,'state',rel),'utf8');
 }
} finally {await old.close();}
const restarted=await bridgeHarness({files});
try {
 restarted.cfg.memory.distill.enabled=true;
 restarted.setPresets(['standard','qq-chat','qq-chat-v2','qq-memory']);
 const first=restarted.archiveStore.append(key,{text:'重启后的新消息'});
 assert.equal(first.conv,conv);assert.equal(first.seq,1);
 let evidenceSeq=1;
 restarted.api.sessions.prompt=async({sessionId,content})=>{
  assert.ok(content[0].text.includes(`#${evidenceSeq} `));
  assert.ok(!content[0].text.includes('旧代际消息'));
  const waiter=restarted.learnerWaiters.get(sessionId)?.shift();
  assert.ok(waiter,'completion listener is registered before prompt');
  clearTimeout(waiter.timer);
  restarted.learnerWaiters.delete(sessionId);
  waiter.resolve(JSON.stringify({facts:[{text:'新消息事实',kind:'event',confidence:0.9,evidenceSeqs:[evidenceSeq]}],
   episodes:[],rolling:'新代际摘要',drop:[]}));
  return {result:{ok:true,value:{}}};
 };
 let result=await restarted.enqueueDistill(()=>restarted.distillScopeNow(key));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.toSeq,1);
 assert.equal(restarted.memoryStore.stats(key).summarizedThroughSeq,1);
 assert.equal(restarted.memoryStore.listFacts(key)[0].evidence[0].conv,conv);
 // Previously affected versions (or failed writes) can already have seq gaps.
 restarted.archiveStore.ensureScope(key).meta.archiveSeq=200;
 evidenceSeq=restarted.archiveStore.append(key,{text:'已有空洞之后的新消息'}).seq;
 result=await restarted.enqueueDistill(()=>restarted.distillScopeNow(key));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.toSeq,201);
 assert.equal(restarted.memoryStore.stats(key).summarizedThroughSeq,201);
 console.log('PASS retained archive reset/restart distills new conv; existing seq gaps do not stall windows');
} finally {await restarted.close();}
