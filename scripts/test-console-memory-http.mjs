import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness();
const server=h.startConsoleServer();
if(!server.listening) await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
async function call(route,body,headers={'x-console-token':'fixture-console-token'}){
 const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
try {
 h.getSocialV2State('private:123');h.getSocialV2State('group:456');
 for(const endpoint of ['/api/memory/scopes','/api/metrics','/api/memory/backups']){
  assert.equal((await call(endpoint,undefined,{})).status,401);
  assert.equal((await call(endpoint,undefined,{'x-console-token':'fixture-console-token','x-agent-token':h.getSocialV2State('private:123').agentToken})).status,403);
 }
 let result=await call('/api/memory/fact',{key:'private:123',kind:'rule',text:'<script>测试</script>'});
 assert.equal(result.data.ok,true);const id=result.data.fact.id;
 assert.equal((await call('/api/memory/pin',{key:'private:123',id,pinned:true})).data.ok,true);
 result=await call('/api/memory/scopes');assert.deepEqual(result.data.scopes.map(x=>x.key),['private:123']);assert.equal(result.data.totals.facts,1);
 result=await call('/api/metrics');assert.equal(result.data.memory.facts,1);
 assert.equal((await call('/api/memory/scope?key=group:456')).status,400);
 result=await call('/api/memory/import-impressions',{key:'private:123',dryRun:true});assert.equal(result.data.imported,0);
 result=await call('/api/memory/backup',{});assert.equal(result.status,200);
 assert.equal(fs.existsSync(path.join(result.data.dir,'manifest.json')),true);
 assert.equal((await call('/api/memory/backups')).data.backups.length,1);
 assert.equal((await call('/api/memory/restore',{})).status,409);
 assert.equal((await call('/api/memory/forget',{key:'private:123',id})).data.ok,true);
 assert.equal((await call('/api/metrics')).data.memory.facts,0);
 console.log('PASS M6 HTTP: permissions, private scopes, fact/pin/retract, metrics, preview, backup and offline restore');
}finally{await new Promise(r=>server.close(r));await h.close();}
