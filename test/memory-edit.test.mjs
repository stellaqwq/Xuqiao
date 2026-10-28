import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {AgentState} from '../src/agent/state.mjs';
import {AgentRuntime} from '../src/agent/runtime.mjs';
import {launchWorkspace} from '../scripts/launch.mjs';
import {app,config,temp,cleanup,request} from './helpers.mjs';

const session='10000:group:20001',scope=session+':user:10001';
function setup(t){const store=new Store(':memory:');t.after(()=>store.close());return {store,state:new AgentState(store)};}
const find=(state,where=session,key='风格')=>state.listMemories(where).find(m=>m.key===key&&m.scope===(where===session?scope:where));

test('manual editing can rename and change a memory while preserving group member, account and session boundaries',t=>{
  const {state}=setup(t),others=[session+':user:10002','10000:group:20002:user:10001','20000:group:20001:user:10001','10000:private:10001','web:00000000-0000-0000-0000-000000000001'];
  state.remember(scope,'风格','简洁');for(const other of others)state.remember(other,'风格','其他记忆');
  const original=find(state),saved=state.editMemory({...original,newKey:'回答偏好',value:'请分段回答。\n保留关键事实。'});
  assert.equal(saved.scope,scope);assert.equal(saved.key,'回答偏好');assert.equal(state.memories(scope).length,1);assert.equal(state.memories(scope)[0].value,'请分段回答。\n保留关键事实。');
  assert.notEqual(saved.revision,original.revision);assert.ok(saved.updated_at>original.updated_at);
  for(const other of others)assert.equal(state.memories(other)[0].value,'其他记忆');
  assert.equal(state.listMemories(session).length,2);
});

test('stale edits, occupied names and deleted entries cannot overwrite or recreate memories',t=>{
  const {state,store}=setup(t);state.remember(scope,'风格','原内容');state.remember(scope,'另一个名称','保留内容');
  const original=find(state);
  assert.throws(()=>state.editMemory({...original,newKey:'另一个名称',value:'尝试覆盖'}),e=>e.status===409);
  assert.equal(find(state).value,'原内容');assert.equal(find(state,session,'另一个名称').value,'保留内容');
  state.remember(scope,'风格','模型刚刚更新');assert.throws(()=>state.editMemory({...original,value:'旧窗口内容'}),e=>e.status===409);
  const newer=find(state);state.forget(scope,'风格');assert.throws(()=>state.editMemory({...newer,value:'不能恢复'}),e=>e.status===404);
  assert.equal(state.memories(scope).length,1);
  state.remember(scope,'风格','相同内容');state.remember(session+':user:10002','风格','相同内容');store.db.prepare('UPDATE agent_memories SET updated_at=100').run();
  const tied=find(state);assert.throws(()=>state.editMemory({...tied,scope:session+':user:10002',value:'篡改作用域'}),e=>e.status===409);
});

test('memory editing validates fields and works at the 50-memory quota without adding a record',t=>{
  const {state}=setup(t);state.remember(scope,'风格','原内容');const original=find(state);
  for(const patch of [{newKey:''},{newKey:' '},{newKey:'a'.repeat(61)},{value:''},{value:' '},{value:'a'.repeat(501)},{revision:'bad'},{scope:'%'},{key:'missing'}]){
    assert.throws(()=>state.editMemory({...original,...patch}),e=>[400,404].includes(e.status));
  }
  for(const bad of [null,[],true,'bad'])assert.throws(()=>state.editMemory(bad),e=>e.status===400);
  for(let n=1;n<50;n++)state.remember(scope,'条目'+n,'内容');
  state.editMemory({...original,newKey:'重命名',value:'更新内容'});assert.equal(state.memories(scope).length,50);
  assert.throws(()=>state.remember(scope,'新增条目','超出上限'),/已满/);
});

test('saved edits survive reopening the database and are immediately available to the existing model memory tool',async t=>{
  const path=join(await temp(t),'memories.sqlite');let store=new Store(path),state=new AgentState(store);
  state.remember(scope,'风格','旧内容');state.editMemory({...find(state),value:'新内容\n<img src=x onerror=alert(1)>'});store.close();
  store=new Store(path);cleanup(t,()=>store.close());const runtime=new AgentRuntime({store,config:config('unused'),log:()=>{}});
  const event={self_id:10000,user_id:10001,group_id:20001,message_type:'group'},job={id:1,conversation:session};
  const result=await runtime.tools(event,job).tools.find(tool=>tool.name==='memory_search').invoke({keyword:'新内容'});
  assert.equal(result.result.memories[0].value,'新内容\n<img src=x onerror=alert(1)>');
});

test('memory updates require the separate administrator credential and return safe conflicts without logging contents',async t=>{
  const bot=await app(t);bot.agent.state.remember(scope,'风格','原内容');
  const list=await request(bot,'/admin/agent/memories?conversation='+session),memory=list.data[0];assert.match(memory.revision,/^[a-f0-9]{64}$/);
  const patch={...memory,newKey:'新名称',value:'private edited memory fixture'};
  for(const token of [false,'onebot'])assert.equal((await request(bot,'/admin/agent/memory/update',patch,token)).code,401);
  const saved=await request(bot,'/admin/agent/memory/update',patch);assert.equal(saved.code,200);assert.equal(saved.data.key,'新名称');
  assert.equal((await request(bot,'/admin/agent/memory/update',patch)).code,404);
  const conflict=await request(bot,'/admin/agent/memory/update',{...saved.data,value:'另一个窗口'});assert.equal(conflict.code,200);
  assert.equal((await request(bot,'/admin/agent/memory/update',{...saved.data,value:'过期草稿'})).code,409);
  assert.equal((await request(bot,'/admin/agent/memory/update',{...saved.data,scope:'invalid'})).code,400);
  assert.ok(!JSON.stringify((await request(bot,'/admin/telemetry')).data).includes('private edited memory fixture'));
});

test('workspace proxies memory edits, preserves origin checks and forwards version conflicts',async t=>{
  const workspace=await launchWorkspace(config(await temp(t)));cleanup(t,()=>workspace.close());workspace.app.agent.state.remember(scope,'风格','旧内容');
  const origin=new URL(workspace.url).origin;
  const memories=await (await fetch(workspace.url+'/agent/memories?conversation='+session)).json(),patch={...memories[0],value:'网页修改的记忆'};
  const save=(data,from=origin)=>fetch(workspace.url+'/agent/memory/update',{method:'POST',headers:{Origin:from,'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await save(patch,'https://example.com')).status,403);
  const response=await save(patch);assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.value,'网页修改的记忆');assert.ok(!JSON.stringify(saved).includes(workspace.app.config.adminToken));
  assert.equal((await save(patch)).status,409);assert.equal(workspace.app.agent.state.memories(scope)[0].value,'网页修改的记忆');
});
