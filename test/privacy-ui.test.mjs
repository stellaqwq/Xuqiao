import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {formatJobDetail} from '../src/web/job-detail.mjs';
import {temp,app,request} from './helpers.mjs';

const event=id=>({self_id:10000,user_id:10001,post_type:'message',message_type:'private',message_id:id,
  message:[{type:'text',data:{text:'sensitive original'}}],raw_message:'sensitive original'});

test('job details distinguish whitelist filtering, removed content, unrecorded content and non-text messages',()=>{
  const base={conversation:'test session',status:'ignored',reason:'user_not_allowed',event:event(1)};
  const filtered=formatJobDetail(base);assert.match(filtered,/不在回复白名单/);assert.match(filtered,/sensitive original/);
  const removed=formatJobDetail({...base,event:{content_retained:false,content_state:'redacted'}});
  assert.match(removed,/已脱敏清除，无法恢复/);assert.doesNotMatch(removed,/sensitive original/);
  const notStored=formatJobDetail({...base,event:{content_retained:false,content_state:'not_stored'}});assert.match(notStored,/正文未记录/);
  const noText=formatJobDetail({...base,reason:'no_text',event:{message:[{type:'image',data:{file:'fixture.png'}}]}});
  assert.match(noText,/原消息没有文本/);assert.match(noText,/仅含图片等非文本/);assert.doesNotMatch(noText,/（无文本）/);
  assert.match(formatJobDetail({...base,event:{content_retained:false}}),/旧记录未区分/);
});

test('redaction counts and content state survive restart without duplicating audit events or storing bodies in audit',async t=>{
  const path=join(await temp(t),'audit.sqlite');let store=new Store(path,{retainIgnoredContent:true});
  store.ingest(event(1),null,10);store.ingest(event(2),null,10);store.close();
  const notifications=[];store=new Store(path,{onRedaction:entry=>notifications.push(entry)});
  assert.equal(store.privacyStatus().total,2);assert.equal(store.privacyStatus().records[0].reason,'startup');
  assert.deepEqual(notifications,[{count:2,reason:'startup'}]);assert.equal(JSON.parse(store.get(1).event).content_state,'redacted');
  assert.equal(store.redactIgnored(),0);assert.equal(store.privacyStatus().records.length,1);
  assert.ok(!JSON.stringify(store.privacyStatus()).includes('sensitive original'));
  store.close();store=new Store(path);
  try{assert.equal(store.privacyStatus().total,2);assert.equal(store.privacyStatus().records.length,1);}finally{store.close();}
});

test('policy redaction writes its evidence atomically and new metadata-only ignores do not claim deletion',()=>{
  const store=new Store(':memory:');
  try{
    const untouched=store.ingest(event(1),null,10).id;
    assert.equal(JSON.parse(store.get(untouched).event).content_state,'not_stored');assert.equal(store.privacyStatus().total,0);
    const changed=store.ingest(event(2),'input',10).id;store.update(changed,'ignored',{reason:'policy_changed'});
    assert.equal(store.privacyStatus().total,1);assert.equal(JSON.parse(store.get(changed).event).content_state,'redacted');
    store.update(changed,'ignored',{reason:'policy_changed'});assert.equal(store.privacyStatus().total,1);
  }finally{store.close();}
});

test('failed audit insertion rolls back both bulk redaction and an ignored transition',()=>{
  const store=new Store(':memory:',{retainIgnoredContent:true});
  try{
    const ignored=store.ingest(event(1),null,10).id,ready=store.ingest(event(2),'input',10).id;
    store.update(ready,'ready',{reply:'pending reply'});store.retainIgnoredContent=false;
    store.db.exec("CREATE TRIGGER reject_privacy_audit BEFORE INSERT ON privacy_audit BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.throws(()=>store.redactIgnored(),/fixture failure/);
    assert.match(store.get(ignored).event,/sensitive original/);assert.equal(store.privacyStatus().total,0);
    assert.throws(()=>store.update(ready,'ignored',{reason:'policy_changed'}),/fixture failure/);
    assert.equal(store.get(ready).status,'ready');assert.equal(store.get(ready).reply,'pending reply');assert.equal(store.privacyStatus().total,0);
  }finally{store.close();}
});

test('admin status exposes durable redaction evidence and actual retention scopes; logs exclude removed body',async t=>{
  const bot=await app(t);const id=bot.store.ingest(event(1),'sensitive input',10).id;
  bot.store.update(id,'ignored',{reason:'policy_changed'});
  const status=await request(bot,'/admin/status');assert.equal(status.data.privacy.total,1);
  assert.equal(status.data.privacy.history_days,7);assert.equal(status.data.privacy.memory_limit,1000);
  assert.equal((await request(bot,'/admin/status',undefined,'onebot')).code,401);
  const logs=bot.telemetry.read().entries.filter(e=>e.kind==='log'&&e.event==='ignored_job_content_redacted');
  assert.equal(logs.length,1);assert.equal(logs[0].fields.count,1);assert.ok(!JSON.stringify(logs).includes('sensitive'));
});

test('worker records specific ignore reasons before omitting content',async t=>{
  const bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10002'});
  bot.worker.ingest(event(1));assert.equal(bot.store.get(1).reason,'user_not_allowed');
  assert.match(formatJobDetail({...bot.store.get(1),event:JSON.parse(bot.store.get(1).event)}),/不在回复白名单/);
});
