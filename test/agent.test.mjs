import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { AgentState } from '../src/agent/state.mjs';
import { AgentRuntime, qzonePublishIntent } from '../src/agent/runtime.mjs';
import { AIClient } from '../src/ai.mjs';
import { normalizeTools, validateArguments } from '../src/agent/schema.mjs';
import { app, config, incoming, request, waitFor, temp } from './helpers.mjs';
import { pluginTemplate } from '../src/plugins/service.mjs';

const env = {AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'};
const call = (name,args={},id='call') => ({tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const event = (id=1,extra={}) => ({self_id:10000,user_id:10001,message_id:id,post_type:'message',message_type:'private',message:[{type:'text',data:{text:'记住我喜欢简洁回答'}}],...extra});
class Model extends AIClient {
  constructor(fn) {super(config('unused').ai);this.fn=fn;this.requests=[];}
  async completion(messages,signal,tools) {this.requests.push(structuredClone({messages,tools}));return this.fn(messages,signal,tools,this.requests.length);}
}
async function completed(bot,id) {return waitFor(()=>bot.store.get(id)?.status==='done'&&bot.store.get(id));}

test('QQ tasks use multiple tools, durable user memory and one ordinary reply without logging tool data',async t=>{
  const model = new Model((messages,signal,tools,n)=>{
    if(n===1)return call('memory_save',{key:'风格',value:'简洁回答'});
    if(n===2)return call('memory_search',{keyword:'风格'});
    assert.equal(JSON.parse(messages.at(-1).content).memories[0].value,'简洁回答');
    return {content:'记住了，会简洁回答。'};
  });
  const bot=await app(t,env,{ai:model}),sent=[];bot.adapter.on('outgoing',e=>sent.push(e));
  bot.adapter.driver.inject(incoming(80001,{message:'记住我喜欢简洁回答'}));
  await completed(bot,1);
  assert.equal(sent.length,1);assert.equal(replyBody(sent[0].message)[0].data.text,'记住了，会简洁回答。');
  assert.equal(model.requests.length,3);
  const detail=await request(bot,'/admin/jobs/1');
  assert.deepEqual(detail.data.agent_steps.filter(s=>s.kind==='tool').map(s=>s.name),['memory_save','memory_search']);
  assert.ok(detail.data.agent_steps.every(s=>s.state==='succeeded'));
  assert.ok(!JSON.stringify(bot.telemetry.read().entries.filter(e=>e.kind==='log')).includes('简洁回答'));
  assert.equal((await request(bot,'/admin/agent')).data.runs[0].state,'completed');
});

test('write tool receipts survive process recovery, reject changed payloads and never repeat ambiguous side effects',async t=>{
  const path=join(await temp(t),'state.sqlite');let store=new Store(path),state=new AgentState(store),writes=0;
  const job={id:1},tool={name:'external_write',effect:'write',invoke:async args=>{writes++;return {result:{ok:true,value:args.value}};}};
  await state.invoke(job,tool,{value:1});
  store.close();store=new Store(path);state=new AgentState(store);
  assert.deepEqual(await state.invoke(job,tool,{value:1}),{result:{ok:true,value:1}});
  assert.equal((await state.invoke(job,tool,{value:2})).result.ok,false);assert.equal(writes,1);
  const throwing={name:'other_write',effect:'write',invoke:async()=>{writes++;throw Error('private credentials');}};
  assert.equal((await state.invoke(job,throwing,{})).result.uncertain,true);
  assert.equal((await state.invoke(job,throwing,{})).result.uncertain,true);assert.equal(writes,2);
  store.db.prepare("INSERT INTO agent_receipts VALUES (2,'external_write','digest','running',NULL)").run();
  store.close();store=new Store(path);state=new AgentState(store);
  assert.equal(store.db.prepare('SELECT state FROM agent_receipts WHERE job_id=2').get().state,'uncertain');store.close();
});

test('personas restrict tools, append instructions and reset only the selected conversation history',async t=>{
  const model=new Model((messages,signal,tools)=>{
    assert.deepEqual(tools.map(t=>t.function.name),['current_time']);
    assert.ok(messages[0].content.includes('用一句话回答'));
    return {content:'你好。'};
  });
  const bot=await app(t,env,{ai:model});
  const row=bot.store.ingest(event(2),'hello',100);bot.store.update(row.id,'done');
  bot.store.db.prepare('INSERT INTO history(conversation,role,content,created_at) VALUES (?,?,?,?)').run('10000:private:10001','user','old',Date.now());
  const saved=await request(bot,'/admin/agent/persona',{name:'简洁',prompt:'用一句话回答',tools:['current_time']});
  const session='10000:private:10001';
  assert.equal((await request(bot,'/admin/agent/bind',{conversation:session,persona:saved.data.id})).code,200);
  assert.equal(bot.store.history(session,10).length,0);
  bot.adapter.driver.inject(incoming(80002));await completed(bot,2);
  assert.equal((await request(bot,'/admin/agent/persona',{...saved.data,prompt:'changed',revision:999})).code,409);
  assert.equal((await request(bot,'/admin/agent/persona/delete',{id:saved.data.id,revision:saved.data.revision})).code,200);
  assert.equal(bot.agent.state.persona(session),null);
});

test('group user memories and private conversations cannot read each other',async()=>{
  const store=new Store(':memory:'),cfg=config('unused',env),runtime=new AgentRuntime({store,config:cfg,log:()=>{}});
  try {
    const a=event(1,{message_type:'group',group_id:20001}),b={...a,user_id:10002};
    const ja={id:1,conversation:'10000:group:20001'},jb={id:2,conversation:'10000:group:20001'};
    const tool=runtime.tools(a,ja).tools.find(t=>t.name==='memory_save');
    await tool.invoke({key:'喜好',value:'蓝色'});
    assert.equal((await runtime.tools(b,jb).tools.find(t=>t.name==='memory_search').invoke({})).result.memories.length,0);
    assert.equal((await runtime.tools(event(),{id:3,conversation:'10000:private:10001'}).tools.find(t=>t.name==='memory_search').invoke({})).result.memories.length,0);
  } finally {store.close();}
});

test('custom plugin tools respect session scope, validate schema, execute in a bounded worker and survive export',async t=>{
  let exposed;
  const model=new Model((messages,signal,tools,n)=>{
    exposed=tools.find(t=>t.function.name.endsWith('_lookup_order'))?.function.name;
    if(n===1){assert.ok(exposed);return call(exposed,{order_id:'A01'});}
    assert.equal(JSON.parse(messages.at(-1).content).status,'已发货');return {content:'订单已发货。'};
  });
  const bot=await app(t,env,{ai:model});
  const definition={...structuredClone(pluginTemplate),trigger:'/never',scope:{...pluginTemplate.scope,private_users:['10001']},
    tools:[{name:'lookup_order',description:'查询订单',effect:'read',parameters:{type:'object',properties:{order_id:{type:'string',maxLength:20}},required:['order_id'],additionalProperties:false}}],
    source:'export default async function(){return null;} export async function invokeTool({arguments:args}){return {order_id:args.order_id,status:"已发货"};}'};
  let plugin=await bot.plugins.save({plugin:definition});plugin=await bot.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:true});
  assert.deepEqual(bot.plugins.get(plugin.id).tools,definition.tools);
  assert.equal(bot.plugins.agentTools(event(1,{user_id:10002})).length,0);
  bot.adapter.driver.inject(incoming(80003,{message:'查一下 A01 订单'}));await completed(bot,1);
  assert.equal(bot.store.get(1).reply,'订单已发货。');
  const tools=bot.plugins.agentTools(event());await bot.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:false});
  assert.equal((await tools[0].invoke({order_id:'A01'})).result.ok,false);
  const invalid=structuredClone(definition);invalid.tools[0].parameters.properties.order_id.pattern='.*';
  await assert.rejects(bot.plugins.save({plugin:invalid}),/Schema/);
  assert.throws(()=>validateArguments(definition.tools[0].parameters,{order_id:'A01',extra:true}));
});

test('Agent management and memories require the separate admin credential',async t=>{
  const bot=await app(t);
  for(const path of ['/admin/agent','/admin/agent/memories?conversation=10000:private:10001']){
    assert.equal((await request(bot,path,undefined,'onebot')).code,401);
    assert.equal((await request(bot,path,undefined,false)).code,401);
    assert.equal((await request(bot,path)).code,200);
  }
  assert.equal((await request(bot,'/admin/agent/persona',{name:'bad',prompt:'x'},'onebot')).code,401);
  assert.equal((await request(bot,'/admin/agent/memories?conversation=%25')).code,400);
});

test('web chat runs while QQ is offline, isolates sessions, persists history and never sends QQ messages',async t=>{
  const model=new Model((messages,signal,tools,n)=>{
    assert.ok(tools.every(t=>!t.function.name.startsWith('qzone')&&!t.function.name.startsWith('plugin_')));
    return n===1?call('memory_save',{key:'网页偏好',value:'简洁'}):{content:'网页回复'};
  });
  const bot=await app(t,env,{ai:model});let sends=0;bot.adapter.on('outgoing',()=>sends++);
  const original=bot.adapter.status.bind(bot.adapter);bot.adapter.status=()=>({...original(),online:false});bot.adapter.emit('state');
  const started=await request(bot,'/admin/agent/chat',{text:'记住我喜欢简洁回答'});
  assert.equal(started.code,200);await completed(bot,started.data.job_id);
  const history=await request(bot,'/admin/agent/chat?session='+started.data.session);
  assert.equal(history.data.jobs[0].reply,'网页回复');assert.equal(sends,0);
  assert.equal(bot.store.get(started.data.job_id).channel,'web');
  const other=await request(bot,'/admin/agent/chat',{text:'新会话'});await completed(bot,other.data.job_id);
  assert.notEqual(other.data.session,started.data.session);
  assert.equal(bot.agent.state.memories('web:'+other.data.session).length,0);
  assert.equal(bot.agent.state.memories('web:'+started.data.session).length,1);
  assert.equal((await request(bot,'/admin/agent/chat',{text:'x'},'onebot')).code,401);
  assert.equal((await request(bot,'/admin/agent/chat',{session:'bad',text:'x'})).code,400);
  assert.equal((await request(bot,'/admin/agent/chat?session=bad')).code,400);
});

test('Qzone writes are restricted to administrators in private chat and publish uses a stable job key',async()=>{
  const store=new Store(':memory:'),seen=[];
  const runtime=new AgentRuntime({store,config:config('unused',env),log:()=>{},qzone:{status:()=>({account:10000}),send:async p=>{seen.push(p);return {status:'published'};}}});
  try {
    const job={id:12,conversation:'10000:private:10001'};
    assert.ok(!runtime.tools(event(1,{user_id:10002}),job).tools.some(t=>t.name.startsWith('qzone')));
    assert.ok(!runtime.tools(event(1,{message_type:'group',group_id:20001}),job).tools.some(t=>t.name.startsWith('qzone')));
    assert.ok(!runtime.tools(event(),job).tools.some(t=>t.name==='qzone_publish'));
    const e=event(1,{message:[{type:'text',data:{text:'发布一条说说：你好'}}]});
    const tool=runtime.tools(e,job).tools.find(t=>t.name==='qzone_publish');
    const result=await runtime.state.invoke(job,tool,{content:'你好'});
    await runtime.state.invoke(job,tool,{content:'你好'});
    assert.equal(result.finish,true);assert.equal(seen.length,1);assert.equal(seen[0].request_id,'agent-job-12');assert.equal(seen[0].visibility,'private');
  } finally {store.close();}
});

test('Qzone publication capability is absent for negations, quoted requests and capability questions',()=>{
  for(const input of ['不要发布说说','如何发布空间说说','你能不能发布说说？','“发布说说”是什么意思','do not publish this'])assert.equal(qzonePublishIntent(input),false,input);
  for(const input of ['请帮我发布一条说说：你好','发到 QQ 空间：你好','发布空间说说：你好'])assert.equal(qzonePublishIntent(input),true,input);
});

test('model steps and tool calls are bounded and cancellation stops execution before a side effect',async()=>{
  let invoked=0;
  const model=new Model(()=>call('query'));
  const tools=[{type:'function',function:{name:'query',parameters:{type:'object',properties:{},additionalProperties:false}}}];
  await assert.rejects(model.reply('x',[],undefined,{tools,maxSteps:3,maxToolCalls:2,invokeTool:async()=>{invoked++;return {result:{ok:true}};}}));
  assert.equal(invoked,2);assert.equal(model.requests.length,3);
  const controller=new AbortController();controller.abort();
  await assert.rejects(model.reply('x',[],controller.signal,{tools,invokeTool:()=>{invoked++;}}));assert.equal(invoked,2);
  const batch=new Model(()=>({tool_calls:[...call('query').tool_calls,...call('bad',{},'second').tool_calls]}));
  await assert.rejects(batch.reply('x',[],undefined,{tools,invokeTool:()=>{invoked++;}}));assert.equal(invoked,2);
});

test('disabling Agent preserves the legacy AI and VoiceStudio options without adding Agent tools',async t=>{
  const model={reply:async(input,history,signal,options)=>{assert.equal(options.tools,undefined);assert.equal(options.onModelStep,undefined);return '传统回复';}};
  const bot=await app(t,{...env,AGENT_ENABLED:'false'},{ai:model});bot.adapter.driver.inject(incoming(80004));
  await completed(bot,1);assert.equal(bot.store.get(1).reply,'传统回复');assert.equal(bot.agent.snapshot().runs.length,0);
});

test('Agent retention removes orphan traces and receipts while preserving personas and unexpired memory',()=>{
  const store=new Store(':memory:'),state=new AgentState(store);
  try {
    state.begin({id:999},'default');state.step({id:999},'model','model')('succeeded');state.remember('scope','key','value');state.savePersona({name:'助手',prompt:'test'});
    state.cleanup(7);assert.equal(state.trace(999).length,0);assert.equal(state.personas().length,1);assert.equal(state.memories('scope').length,1);
    store.db.prepare('UPDATE agent_memories SET updated_at=0').run();state.cleanup(7);assert.equal(state.memories('scope').length,0);
  } finally {store.close();}
});

test('tool schemas reject unsupported constructs, duplicate names and unbounded structural depth',()=>{
  const tool={name:'test',description:'test',parameters:{type:'object',properties:{},additionalProperties:false}};
  assert.throws(()=>normalizeTools([tool,tool]));
  assert.throws(()=>normalizeTools([{...tool,parameters:{type:'object'}}]));
  assert.throws(()=>normalizeTools([{...tool,parameters:{...tool.parameters,oneOf:[]}}]));
  for(const [key,value] of [['AGENT_MAX_STEPS','25'],['AGENT_MAX_TOOL_CALLS','0'],['AGENT_TIMEOUT_MS','999'],['AGENT_ENABLED','yes']])assert.throws(()=>config('unused',{[key]:value}));
});
