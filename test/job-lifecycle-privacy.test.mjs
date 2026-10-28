import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ReplyWorker } from '../src/worker.mjs';
import { config, temp, cleanup, waitFor, app } from './helpers.mjs';

const event=id=>({self_id:10000,user_id:10001,post_type:'message',message_type:'private',message_id:id,
  message:[{type:'text',data:{text:'private body '+id}}],raw_message:'private body '+id,sender:{nickname:'private name'},extra:{secret:'private attachment'}});

for(const mode of ['disabled','offline'])test(mode+' workers expire waiting jobs without another message or reconnect',async t=>{
  const cfg=config('unused',{AI_ENABLED:mode==='disabled'?'false':'true',AI_MODEL:'test',AI_ALLOWED_USERS:'10001',JOB_MAX_AGE_MS:'1000'});
  const store=new Store(':memory:');let calls=0;
  const adapter=Object.assign(new EventEmitter(),{status:()=>({online:mode!=='offline'}),action:async()=>{calls++;}});
  const worker=new ReplyWorker({config:cfg,store,adapter,ai:{reply:async()=>{calls++;return 'reply';}},log:()=>{}});
  cleanup(t,async()=>{await worker.close();store.close();});
  const queued=store.ingest(event(1),'question',10).id,ready=store.ingest(event(2),'question',10).id;
  store.update(ready,'ready',{reply:'saved answer',nextAt:Date.now()+3600000});
  const unknown=store.ingest(event(3),'question',10).id;store.update(unknown,'uncertain',{reply:'possibly sent'});
  worker.start();await waitFor(()=>worker.waiters.size===cfg.ai.concurrency);
  const originalBody=store.get(queued).event;
  await delay(1600);
  for(const id of [queued,ready]){assert.equal(store.get(id).status,'failed');assert.equal(store.get(id).reason,'expired');}
  assert.equal(store.get(unknown).status,'uncertain');assert.equal(store.get(queued).event,originalBody);
  assert.equal(calls,0);assert.equal(store.nextExpiryTime(cfg.jobMaxAge),null);
  assert.equal(store.summary().queued||0,0);assert.equal(store.summary().ready||0,0);
});

test('expiration frees capacity before admission but preserves in-flight and unknown delivery',async t=>{
  let now=100000;t.mock.method(Date,'now',()=>now);
  const cfg=config('unused',{AI_ENABLED:'true',AI_MODEL:'test',AI_ALLOWED_USERS:'10001',JOB_MAX_AGE_MS:'1000',MAX_PENDING_JOBS:'1'});
  const store=new Store(':memory:');cleanup(t,()=>store.close());
  const worker=new ReplyWorker({config:cfg,store,adapter:{status:()=>({online:false})},ai:{},log:()=>{}});
  worker.ingest(event(1));now+=1000;worker.ingest(event(2));
  assert.equal(store.get(1).status,'failed');assert.equal(store.get(2).status,'queued');
  for(const [id,state]of [[3,'generating'],[4,'sending'],[5,'uncertain']]){
    store.ingest(event(id),'question',100);store.update(id,state);
  }
  now+=2000;store.expirePending(1000);
  assert.equal(store.get(3).status,'generating');assert.equal(store.get(4).status,'sending');assert.equal(store.get(5).status,'uncertain');
});

test('ignored jobs retain deduplication identity without text, nested fields or overflow input',()=>{
  const store=new Store(':memory:');
  try{
    for(let id=1;id<=13;id++){
      const result=store.ingest(event(id),null,100);
      assert.equal(result.status,'ignored');const row=store.get(result.id),saved=JSON.parse(row.event);
      assert.equal(saved.content_retained,false);assert.equal(saved.message_id,id);
      assert.equal(saved.message,undefined);assert.equal(saved.raw_message,undefined);assert.equal(saved.sender,undefined);assert.equal(saved.extra,undefined);
      assert.equal(row.input,null);assert.equal(row.reply,null);assert.ok(!row.event.includes('private body'));assert.ok(!row.event.includes('private attachment'));
      assert.equal(store.ingest(event(id),null,100).inserted,false);
    }
    store.ingest(event(14),'allowed body',1);
    const overflow=store.ingest(event(15),'overflow body must not persist',1);
    assert.equal(overflow.status,'ignored');assert.equal(store.get(overflow.id).reason,'queue_full');assert.equal(store.get(overflow.id).input,null);
  }finally{store.close();}
});

test('ignored content opt-in preserves full records and opting out redacts old rows without losing deduplication',async t=>{
  const path=join(await temp(t),'jobs.sqlite');let store=new Store(path,{retainIgnoredContent:true});
  const first=store.ingest(event(1),'overflow body',0).id;
  store.update(first,'ignored',{reply:'generated private reply'});
  const old=store.get(first);assert.deepEqual(JSON.parse(old.event),event(1));assert.equal(old.input,'overflow body');assert.equal(old.reply,'generated private reply');
  const forged=store.ingest({...event(9),content_retained:false},null,10).id;
  store.close();store=new Store(path,{retainIgnoredContent:false});
  try{
    const current=store.get(first);
    assert.equal(current.event_key,old.event_key);assert.equal(current.conversation,old.conversation);
    assert.equal(current.created_at,old.created_at);assert.equal(current.updated_at,old.updated_at);assert.equal(current.reason,old.reason);
    assert.equal(current.input,null);assert.equal(current.reply,null);assert.equal(JSON.parse(current.event).content_retained,false);
    assert.equal(store.ingest(event(1),null,100).inserted,false);assert.equal(store.redactIgnored(),0);
    assert.equal(JSON.parse(store.get(forged).event).message,undefined);
    const active=store.ingest(event(2),'active body',10).id;store.update(active,'ready',{reply:'active reply'});
    store.update(active,'ignored',{reason:'policy_changed'});
    assert.equal(store.get(active).input,null);assert.equal(store.get(active).reply,null);assert.ok(!store.get(active).event.includes('private body'));
  }finally{store.close();}
});

test('application privacy setting controls ignored jobs while live OneBot events remain complete',async t=>{
  for(const retain of [false,true]){
    const bot=await app(t,{RETAIN_IGNORED_JOB_CONTENT:String(retain)});
    assert.equal(bot.worker.ingest(event(1)),true);
    const saved=JSON.parse(bot.store.get(1).event);
    assert.equal(!!saved.message,retain);
    assert.equal(event(1).message[0].data.text,'private body 1');
  }
});
