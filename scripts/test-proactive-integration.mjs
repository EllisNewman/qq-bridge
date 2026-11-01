import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const h = await bridgeHarness();
const key='private:123';
const thought=(id,text)=>({id,text,status:'pending',createdAt:Date.now(),notBefore:0,expiresAt:Date.now()+3600000,attempts:0,priority:3});
try {
 h.setMode('reserved2');
 h.cfg.socialV2.proactive={enabled:true,quietHours:{start:0,end:0,hardBlock:true},minGapMs:0,cooldownAfterAnyWakeMs:0,idleThresholdMs:0,maxPerDay:6};
 const st=h.getSocialV2State(key);
 st.pendingThoughts=[thought('t_first','动物园白鲸'),thought('t_second','登山杖爬山')];
 h.surfaceThoughtsForKey(key,'proactiveCheck');
 assert.equal(h.consumeSurfacedThoughts(key,['记得带登山杖爬山']),true);
 assert.equal(st.pendingThoughts.length,1);
 assert.equal(st.thoughtHistory.at(-1).id,'t_second');
 h.finishSurfacedThoughts(key,true);
 assert.equal(st.pendingThoughts[0].attempts,1);
 for(let i=0;i<2;i++){st.pendingThoughts[0].notBefore=0;h.surfaceThoughtsForKey(key,'proactiveCheck');h.finishSurfacedThoughts(key,true);}
 assert.equal(st.pendingThoughts.length,0);
 assert.equal(st.thoughtHistory.at(-1).status,'dropped');
 st.lastWakeReason='proactiveCheck';st.lastAnyWakeAt=1234;st.unansweredCount=0;
 h.recordSentMessagesV2(key,['问候']);h.recordSentMessagesV2(key,['再问候']);
 assert.equal(st.unansweredCount,1);
 h.appendSocialV2Message(key,'用户','回复','回复',false,true,'100');
 assert.equal(st.unansweredCount,0);
 st.unansweredCount=2;h.appendSocialV2Poke(key,{sender:'用户',userId:'123',targetIsSelf:true});assert.equal(st.unansweredCount,0);
 st.unread=[];st.proactiveDayKey=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());st.proactiveCount=6;
 st.pendingThoughts=[thought('t_due','到点提醒')];
 const before=h.calls.prompts.length;h.runThoughtDueV2(key);await new Promise(r=>setTimeout(r,20));assert.equal(h.calls.prompts.length,before);
 st.pendingThoughts=[{...thought('t_expired','过期'),expiresAt:1}];h.scheduleThoughtDueV2(key);assert.equal(st.pendingThoughts.length,0);assert.equal(st.thoughtHistory.at(-1).reason,'expired');
 console.log('PASS M5 integration: all surfaced thoughts, unrelated sends, retry/drop, unanswered bursts/replies/pokes, due quota, expiry history');
} finally {await h.close();}
