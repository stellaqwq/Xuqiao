import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {loadConfig,environmentOf} from '../src/config.mjs';
import {GroupContext} from '../src/group-context.mjs';
import {ReplyWorker} from '../src/worker.mjs';
import {Store} from '../src/store.mjs';
import {conversation,isGroupUserBlocked} from '../src/messages.mjs';
import {formatJobDetail} from '../src/web/job-detail.mjs';
import {pluginTemplate} from '../src/plugins/service.mjs';
import {launchWorkspace} from '../scripts/launch.mjs';
import {app,config,temp,cleanup,incoming,waitFor} from './helpers.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001,20002',AI_STREAM_ENABLED:'false'};
const event=(id,user=10001,group=20001,text='群聊测试')=>({post_type:'message',message_type:'group',self_id:10000,
  user_id:user,group_id:group,message_id:id,message:[{type:'text',data:{text}}]});
const mention=text=>[{type:'at',data:{qq:'10000'}},{type:'text',data:{text}}];
const inject=(bot,id,user=10001,group=20001,message=mention('你好'))=>bot.adapter.driver.inject(incoming(id,{kind:'group',groupId:group,sender:{user_id:user},message}));
const row=(bot,id)=>bot.store.db.prepare("SELECT * FROM jobs WHERE json_extract(event,'$.message_id')=?").get(id);
const done=(bot,id,status='ignored')=>waitFor(()=>row(bot,id)?.status===status&&row(bot,id));

test('group rules validate QQ IDs, support multiline and wildcard, and never affect private or outgoing events',()=>{
  const base=config('unused');assert.equal(base.blockedGroupUsers.size,0);
  const c=loadConfig({...environmentOf(base),GROUP_BLOCKED_USERS:'20001:10001\n20001：10002，*:10003;20001:10001'});
  assert.deepEqual([...c.blockedGroupUsers.get('20001')],['10001','10002']);
  assert.equal(isGroupUserBlocked(event(1),c),true);assert.equal(isGroupUserBlocked(event(1,10001,20002),c),false);
  assert.equal(isGroupUserBlocked(event(1,10003,20002),c),true);
  assert.equal(isGroupUserBlocked({...event(1,10003),message_type:'private'},c),false);
  assert.equal(isGroupUserBlocked({...event(1,10003),post_type:'message_sent'},c),false);
  for(const value of ['10001','20001:0','0:10001','20001:-1','20001:01','20001:1e4','*:all','all:10001','20001:9007199254740992','9007199254740992:10001','20001:10001:10002']){
    assert.throws(()=>loadConfig({...environmentOf(base),GROUP_BLOCKED_USERS:value}),/GROUP_BLOCKED_USERS/);
  }
  assert.throws(()=>loadConfig({...environmentOf(base),GROUP_BLOCKED_USERS:Array(501).fill('20001:10001').join('\n')}),/500/);
});

test('settings persist multiline rules, reject invalid changes and apply or remove them through restart',async t=>{
  const directory=await temp(t),c=config(directory),path=join(directory,'.env');
  await writeFile(path,Object.entries(environmentOf(c)).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n'));
  const workspace=await launchWorkspace(c,{settingsPath:path});cleanup(t,()=>workspace.close());
  let snapshot=await workspace.app.settings.snapshot();
  assert.equal(snapshot.values.GROUP_BLOCKED_USERS,'');
  await assert.rejects(workspace.app.settings.save({GROUP_BLOCKED_USERS:'20001:not-QQ'},snapshot.revision),/群号:QQ号/);
  const rules='20001:10001\n*:10003';
  snapshot=await workspace.app.settings.save({GROUP_BLOCKED_USERS:rules},snapshot.revision);
  assert.ok(snapshot.pending.includes('GROUP_BLOCKED_USERS'));assert.equal(workspace.app.config.blockedGroupUsers.size,0);
  assert.equal(parseEnv(await readFile(path,'utf8')).GROUP_BLOCKED_USERS,rules);
  await workspace.restart();assert.equal(isGroupUserBlocked(event(1),workspace.app.config),true);
  snapshot=await workspace.app.settings.snapshot();assert.ok(!snapshot.pending.includes('GROUP_BLOCKED_USERS'));
  await workspace.app.settings.save({GROUP_BLOCKED_USERS:''},snapshot.revision);await workspace.restart();
  assert.equal(workspace.app.config.blockedGroupUsers.size,0);
});

test('blocked members cannot trigger ordinary AI even with mentions; other members, groups and private chats still work',async t=>{
  const seen=[],sent=[],bot=await app(t,{...env,GROUP_BLOCKED_USERS:'20001:10001\n*:10003'},
    {ai:{reply:async input=>{seen.push(input);return '允许的回复';}}});
  bot.adapter.on('outgoing',e=>sent.push(e));
  inject(bot,10);inject(bot,11,10003,20002);inject(bot,10);
  for(const id of [10,11]){
    const job=await done(bot,id);assert.equal(job.reason,'group_user_blocked');assert.equal(job.input,null);
    assert.match(formatJobDetail({...job,event:JSON.parse(job.event)}),/命中固定屏蔽规则/);
  }
  assert.equal(seen.length,0);assert.equal(sent.length,0);assert.equal(bot.store.list().length,2);
  assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_context_messages').get().n,0);
  inject(bot,12,10002);inject(bot,13,10001,20002);bot.adapter.driver.inject(incoming(14));
  await done(bot,12,'done');await done(bot,13,'done');await done(bot,14,'done');
  assert.equal(seen.length,3);assert.equal(sent.length,3);
});

test('blocking precedes script plugins and administrator commands even while AI is disabled',async t=>{
  const bot=await app(t,{GROUP_BLOCKED_USERS:'20001:10001,20001:10004'}),sent=[];
  bot.adapter.on('outgoing',e=>sent.push(e));
  let p=await bot.plugins.save({plugin:{...pluginTemplate,scope:{...pluginTemplate.scope,groups:['20001','20002'],require_at:false}}});
  await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  const session=conversation(event(1));bot.store.db.prepare('INSERT INTO history(conversation,role,content,created_at) VALUES (?,?,?,?)').run(session,'user','保留的历史',Date.now());
  inject(bot,20,10001,20001,'/ping');inject(bot,21,10001,20001,'/new');inject(bot,22,10004,20001,'/new');inject(bot,23,10001,20001,'/tools');
  for(const id of [20,21,22,23])assert.equal((await done(bot,id)).reason,'group_user_blocked');
  assert.equal(sent.length,0);assert.equal(bot.plugins.get(p.id).runs,0);assert.equal(bot.store.history(session,10).length,1);
  assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM plugin_receipts').get().n,0);
  inject(bot,24,10001,20002,'/ping');await done(bot,24);assert.equal(sent.length,1);assert.equal(bot.plugins.get(p.id).runs,1);
});

test('Chat Plus blocks attention, judgments, commands, background captions and old proactive anchors',async t=>{
  let aiCalls=0,judgments=0,images=0;
  const bot=await app(t,{...env,GROUP_BLOCKED_USERS:'20001:10001'},
    {ai:{reply:async()=>{aiCalls++;return '增强回复';}},groupChatDecisionAI:{reply:async()=>{judgments++;return '{"reply":true,"confidence":1}';}},
      groupChatImageAI:{reply:async()=>{images++;return '图片描述';}},groupChatRandom:()=>0});
  let p=await bot.plugins.install({kind:'group-chat-plus'});
  p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,scope:{...p.scope,groups:['20001']},config:{...p.config,
    initial_probability:1,quiet_hours_enabled:false,merge_window_ms:0,cooldown_seconds:0,proactive_enabled:true,
    caption_unmentioned_images:true,image_caption_enabled:true,proactive_min_user_messages:1,proactive_silence_seconds:60}}});
  p=await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  inject(bot,30,10001,20001,[{type:'image',data:{file:'base64://must-not-be-read'}}]);
  inject(bot,31,10001,20001,'/gcp_pause');inject(bot,32,10001,20001,'大家来讨论一下');
  for(const id of [30,31,32])assert.equal((await done(bot,id)).reason,'group_user_blocked');
  assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_state').get().n,0);
  assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n,0);
  assert.equal(aiCalls+judgments+images,0);assert.equal(bot.groupChatPlus.captionTasks.size,0);
  const state={users:{},activity:[Date.now()-120000],replies:[],paused:false,last_event:event(29),last_user:Date.now()-120000};
  bot.groupChatPlus.write(conversation(event(29)),p,state);assert.equal(bot.groupChatPlus.tick(),0);
  inject(bot,33,10002,20001,'大家来讨论一下');await done(bot,33,'done');assert.equal(aiCalls,1);assert.equal(judgments,1);
});

test('cached blocked messages and quoted text are excluded immediately and purged on context startup',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const c=config('unused',env),context=new GroupContext({store,config:c});
  context.observe(event(40,10001,20001,'旧的被屏蔽消息'));context.observe(event(41,10001,20002,'另一个群的消息'));
  const current={...event(42,10002),message:[{type:'reply',data:{id:'40'}},...mention('刚才说什么')]};context.observe(current);
  c.blockedGroupUsers.set('20001',new Set(['10001']));
  const prepared=context.prepare({channel:'qq'},current);
  assert.ok(!prepared.backgroundContent.includes('旧的被屏蔽消息'));assert.match(prepared.backgroundContent,/"unavailable":true/);
  new GroupContext({store,config:c});
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM group_context_messages WHERE message_id='40'").get().n,0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM group_context_messages WHERE message_id='41'").get().n,1);
});

test('recovered queued and ready replies to blocked members are ignored before generation or sending',async t=>{
  const c=config('unused',{...env,GROUP_BLOCKED_USERS:'20001:10001'}),store=new Store(':memory:');t.after(()=>store.close());
  const queued=store.ingest(event(50),'旧任务输入',100).id,ready=store.ingest(event(51),'旧任务输入',100).id;
  store.update(ready,'ready',{reply:'旧回复'});
  const worker=new ReplyWorker({config:c,store,log:()=>{},adapter:{status:()=>({online:true}),action:()=>assert.fail('blocked send')},ai:{reply:()=>assert.fail('blocked AI')}});
  assert.equal(await worker.step(),true);assert.equal(await worker.step(),true);
  for(const id of [queued,ready]){assert.equal(store.get(id).status,'ignored');assert.equal(store.get(id).reason,'group_user_blocked');}
});
