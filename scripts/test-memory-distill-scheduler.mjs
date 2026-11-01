import assert from 'node:assert/strict';
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
