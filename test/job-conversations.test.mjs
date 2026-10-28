import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {launchWorkspace} from '../scripts/launch.mjs';
import {app,config,temp,cleanup,request} from './helpers.mjs';

const event=(id,extra={})=>({post_type:'message',message_type:'group',self_id:10000,user_id:10001,group_id:20001,message_id:id,
  message:[{type:'text',data:{text:'sensitive fixture input'}}],...extra});
function seed(store){
  const old=store.ingest(event(1),'sensitive fixture input',1000).id;
  store.update(old,'ready',{reply:'sensitive fixture reply'});
  for(let id=2;id<=66;id++)store.ingest(event(id,{group_id:20002}),null,1000,'ai_disabled');
  store.ingest(event(67,{message_type:'private',user_id:20001}),null,1000,'ai_disabled');
  store.ingest(event(68,{self_id:20000}),null,1000,'ai_disabled');
  store.ingest(event(69,{self_id:0,user_id:0,message_type:'private'}),null,1000,'ai_disabled','test-web-session');
  return old;
}

test('store filters a complete conversation before the 50-job limit and keeps accounts, groups, private and web separate',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const old=seed(store);
  assert.equal(store.list().length,50);assert.ok(!store.list().some(row=>row.id===old));
  assert.deepEqual(store.list(50,'10000:group:20001').map(row=>row.id),[old]);
  assert.equal(store.list(50,'10000:group:20002').length,50);
  for(const session of ['10000:private:20001','20000:group:20001','web:test-web-session']){
    const rows=store.list(50,session);assert.equal(rows.length,1);assert.equal(rows[0].conversation,session);
  }
  assert.equal(store.list(50,'10000:group:20001\' OR 1=1 --').length,0);
  assert.deepEqual(store.list(50,'missing'),[]);
  assert.deepEqual(store.jobConversations(),['10000:group:20001','10000:group:20002','10000:private:20001','20000:group:20001','web:test-web-session']);
  const metadata=JSON.stringify([store.list(),store.list(50,'10000:group:20001'),store.jobConversations()]);
  assert.ok(!metadata.includes('sensitive fixture'));assert.ok(!metadata.includes('"event"'));assert.ok(!metadata.includes('"reply"'));
});

test('administrator task APIs filter exactly, enumerate older conversations and preserve authentication and content boundaries',async t=>{
  const bot=await app(t),old=seed(bot.store);
  for(const path of ['/admin/jobs?conversation=10000%3Agroup%3A20001','/admin/jobs/conversations']){
    assert.equal((await request(bot,path,undefined,'onebot')).code,401);assert.equal((await request(bot,path,undefined,false)).code,401);
  }
  const result=await request(bot,'/admin/jobs?conversation='+encodeURIComponent('10000:group:20001'));
  assert.equal(result.code,200);assert.deepEqual(result.data.map(row=>row.id),[old]);
  const conversations=await request(bot,'/admin/jobs/conversations');assert.equal(conversations.code,200);assert.ok(conversations.data.includes('10000:group:20001'));assert.ok(conversations.data.includes('web:test-web-session'));
  assert.equal((await request(bot,'/admin/jobs')).data.length,50);
  assert.equal((await request(bot,'/admin/jobs?conversation=missing')).data.length,0);
  for(const invalid of ['a'.repeat(257),'10000:group:20001\0'])assert.equal((await request(bot,'/admin/jobs?conversation='+encodeURIComponent(invalid))).code,400);
  assert.ok(!JSON.stringify(result.data).includes('sensitive fixture'));assert.ok(!JSON.stringify(conversations.data).includes('sensitive fixture'));
  assert.equal((await request(bot,'/admin/jobs/'+old)).data.reply,'sensitive fixture reply');
});

test('workspace forwards conversation filters and choices without exposing administrator credentials',async t=>{
  const workspace=await launchWorkspace(config(await temp(t)));cleanup(t,()=>workspace.close());const old=seed(workspace.app.store);
  const selected=await fetch(workspace.url+'/jobs?conversation='+encodeURIComponent('10000:group:20001'));
  assert.equal(selected.status,200);const data=await selected.json();assert.deepEqual(data.map(row=>row.id),[old]);
  const choices=await fetch(workspace.url+'/job-conversations');assert.equal(choices.status,200);const list=await choices.json();assert.ok(list.includes('10000:group:20001'));
  assert.ok(!JSON.stringify([data,list]).includes(workspace.app.config.adminToken));
  assert.equal((await (await fetch(workspace.url+'/jobs?conversation=missing')).json()).length,0);
});
