import test from 'node:test';
import assert from 'node:assert/strict';
import { app, incoming, waitFor, replyBody, cleanup } from './helpers.mjs';

const current='10000:private:10001';
function seed(bot,session=current,text='旧对话') {
  const insert=bot.store.db.prepare('INSERT INTO history(conversation,role,content,created_at) VALUES (?,?,?,?)');
  insert.run(session,'user',text,Date.now());insert.run(session,'assistant','旧回答',Date.now());
}
async function received(bot,id,message='/new',extra={}) {
  bot.adapter.driver.inject(incoming(id,{message,...extra}));
  return waitFor(()=>bot.store.db.prepare("SELECT * FROM jobs WHERE json_extract(event,'$.message_id')=?").get(id));
}
function outgoing(bot) { const sent=[];bot.adapter.on('outgoing',event=>sent.push(event));return sent; }
const body=event=>replyBody(event.message).filter(s=>s.type==='text').map(s=>s.data.text).join('');

test('/new works without plugins, AI or Agent and starts an empty first conversation',async t=>{
  for(const agent of ['true','false']){
    const bot=await app(t,{AI_ENABLED:'false',AGENT_ENABLED:agent},{ai:{reply:()=>assert.fail('command must not call AI')}}),sent=outgoing(bot);
    assert.equal(bot.plugins.rows().length,0);
    const job=await received(bot,100);
    assert.equal(job.status,'ignored');assert.equal(sent.length,1);assert.match(body(sent[0]),/已开启新对话/);
    assert.deepEqual(sent[0].message[0],{type:'reply',data:{id:'100'}});assert.ok(!sent[0].message.some(s=>s.type==='at'));
    assert.deepEqual(bot.store.history(current,10),[]);
  }
});

test('/new clears only the current context, preserves persona and memory, and gives the next model request empty history',async t=>{
  const histories=[];
  const bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'},{ai:{reply:async(_input,history)=>{histories.push(history);return '普通回答';}}});
  await received(bot,200,'旧问题');await waitFor(()=>bot.store.summary().done===1);
  const persona=bot.agent.state.savePersona({name:'简洁助手',prompt:'简洁回答。'});
  bot.agent.state.bind({conversation:current,persona:persona.id});seed(bot);
  bot.agent.state.remember(current,'偏好','简洁');
  seed(bot,'10000:private:10002','其他好友');seed(bot,'10000:group:20001','群聊历史');seed(bot,'web:other','网页历史');
  const sent=outgoing(bot);await received(bot,201,' \n/new\t');
  assert.equal(histories.length,1);assert.equal(bot.store.history(current,10).length,0);assert.match(body(sent[0]),/已开启新对话/);
  assert.equal(bot.agent.state.persona(current).id,persona.id);assert.equal(bot.agent.state.memories(current)[0].value,'简洁');
  for(const session of ['10000:private:10002','10000:group:20001','web:other'])assert.equal(bot.store.history(session,10).length,2);
  await received(bot,202,'新的问题');await waitFor(()=>bot.store.summary().done===2);
  assert.deepEqual(histories[1],[]);assert.equal(bot.store.history(current,10)[0].content,'新的问题');
});

test('group /new resets the shared group context and quotes and mentions the administrator',async t=>{
  const bot=await app(t),sent=outgoing(bot);seed(bot,'10000:group:20001');seed(bot,'10000:group:20002');seed(bot);
  bot.agent.state.remember('10000:group:20001:user:10002','偏好','蓝色');
  await received(bot,300,'/new',{kind:'group',groupId:20001});
  assert.equal(bot.store.history('10000:group:20001',10).length,0);assert.equal(bot.store.history('10000:group:20002',10).length,2);assert.equal(bot.store.history(current,10).length,2);
  assert.equal(bot.agent.state.memories('10000:group:20001:user:10002')[0].value,'蓝色');
  assert.equal(sent.length,1);assert.equal(sent[0].group_id,20001);assert.deepEqual(sent[0].message[0],{type:'reply',data:{id:'300'}});
  assert.equal(sent[0].message.find(s=>s.type==='at').data.qq,'10001');
});

test('non-admins, group owners and an empty admin list cannot reset history or invoke the model',async t=>{
  for(const admins of ['10001','']){
    const bot=await app(t,{BOT_ADMIN_IDS:admins,AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10002',AI_ALLOWED_GROUPS:'20001',AI_GROUP_REQUIRE_AT:'false'},
      {ai:{reply:()=>assert.fail('unauthorized command reached AI')}}),sent=outgoing(bot);
    seed(bot,'10000:private:10002');seed(bot,'10000:group:20001');seed(bot,'10000:group:20002');
    for(const [id,extra] of [[400,{sender:{user_id:10002}}],[401,{kind:'group',groupId:20001,sender:{user_id:10002,role:'owner'}}],
      [402,{kind:'group',groupId:20002,sender:{user_id:10002,role:'admin'}}]]){
      assert.equal((await received(bot,id,'/new',extra)).reason,'command_forbidden');
    }
    assert.equal(sent.length,2);assert.ok(sent.every(event=>body(event).includes('仅聊天管理员')));
    for(const session of ['10000:private:10002','10000:group:20001','10000:group:20002'])assert.equal(bot.store.history(session,10).length,2);
  }
});

test('pending, active and uncertain tasks prevent clearing context until resolved',async t=>{
  const bot=await app(t),sent=outgoing(bot);seed(bot);
  const prior=bot.store.ingest({post_type:'message',message_type:'private',self_id:10000,user_id:10001,message_id:499,message:'pending'},'pending',100);
  for(const [index,status] of ['queued','generating','ready','sending','uncertain'].entries()){
    bot.store.update(prior.id,status,{reply:'待处理回答'});
    await received(bot,500+index);
    assert.equal(bot.store.history(current,10).length,2);assert.equal(bot.store.get(prior.id).status,status);
    assert.match(body(sent.at(-1)),/处理完成后再发送 \/new/);
  }
  bot.store.update(prior.id,'failed');await received(bot,510);
  assert.equal(bot.store.history(current,10).length,0);assert.match(body(sent.at(-1)),/已开启新对话/);
});

test('duplicate /new events cannot clear the next conversation again',async t=>{
  const bot=await app(t),sent=outgoing(bot);seed(bot);await received(bot,600);seed(bot,current,'新对话');
  bot.adapter.driver.inject(incoming(600,{message:'/new'}));await received(bot,601,'/tools');
  assert.equal(sent.length,2);assert.equal(bot.store.history(current,10)[0].content,'新对话');assert.match(body(sent.at(-1)),/\/new：/);
});

test('/new runs before custom plugins and only the exact command resets the conversation',async t=>{
  const inputs=[],bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'},
    {ai:{reply:async input=>{inputs.push(input);return '普通聊天';}}}),sent=outgoing(bot);
  const plugin=await bot.plugins.save({plugin:{name:'指令测试',trigger:'/',priority:100,scope:{all_private:true},source:'export default()=>({reply:"自定义插件"})'}});
  await bot.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:true});seed(bot);await received(bot,700);
  assert.match(body(sent[0]),/已开启新对话/);assert.equal(bot.plugins.get(plugin.id).runs,0);assert.equal(inputs.length,0);
  let saved=bot.plugins.get(plugin.id);await bot.plugins.toggle({id:saved.id,revision:saved.revision,enabled:false});
  for(const [index,input] of ['/new topic','/newer','请说明 /new','/NEW'].entries()){
    await received(bot,710+index,input);await waitFor(()=>bot.store.summary().done===index+1);
  }
  assert.deepEqual(inputs,['/new topic','/newer','请说明 /new','/NEW']);assert.equal(bot.store.history(current,10).length,8);
});

test('an in-flight reply cannot put old context back after a successful /new',async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});cleanup(t,()=>release());
  const histories=[],bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'},{ai:{reply:async(input,history)=>{
    histories.push(history);if(input==='慢问题')await held;return '回答';
  }}}),sent=outgoing(bot);
  seed(bot);await received(bot,800,'慢问题');await waitFor(()=>bot.store.get(1)?.status==='generating');
  await received(bot,801);assert.match(body(sent.at(-1)),/处理完成后/);assert.equal(bot.store.history(current,10).length,2);
  release();await waitFor(()=>bot.store.get(1).status==='done');await received(bot,802);
  assert.match(body(sent.at(-1)),/已开启新对话/);assert.equal(bot.store.history(current,10).length,0);
  await received(bot,803,'新问题');await waitFor(()=>bot.store.summary().done===2);assert.deepEqual(histories.at(-1),[]);
});
