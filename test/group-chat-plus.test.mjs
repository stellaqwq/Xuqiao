import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {groupChatConfig,quiet,moodOf} from '../src/group-chat-plus/config.mjs';
import {BotError} from '../src/errors.mjs';
import {AIClient} from '../src/ai.mjs';
import {app,config,incoming,waitFor,request,cleanup} from './helpers.mjs';
import {png} from './image-fixture.mjs';
import {installGroupChatPlus} from '../scripts/install-group-chat-plus.mjs';
import {createApp} from '../src/app.mjs';
import {temp} from './helpers.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001,20002',AI_STREAM_CHUNK_CHARS:'40'};
const mention=text=>[{type:'at',data:{qq:'10000'}},{type:'text',data:{text}}];
const inject=(bot,id,message,extra={})=>bot.adapter.driver.inject(incoming(id,{kind:'group',groupId:20001,message,...extra}));
const row=(bot,id)=>bot.store.db.prepare("SELECT * FROM jobs WHERE json_extract(event,'$.message_id')=? ORDER BY id DESC LIMIT 1").get(id);
async function done(bot,id,status='done'){return waitFor(()=>row(bot,id)?.status===status&&row(bot,id));}
async function install(bot,extra={}){
  let p=await bot.plugins.install({kind:'group-chat-plus'});p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,
    config:{...p.config,quiet_hours_enabled:false,merge_window_ms:0,cooldown_seconds:0,max_replies_per_minute:60,initial_probability:1,proactive_enabled:false,...extra},
    scope:{...p.scope,groups:['20001']}}});return bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
}
async function setup(t,extra={},overrides={}){
  const seen=[],sent=[],bot=await app(t,env,{ai:{reply:async(input,history,signal,options)=>{seen.push({input,history,options});return '回答'+seen.length;}},
    groupChatDecisionAI:{reply:async()=>'{"reply":true,"confidence":0.9}'},...overrides});
  bot.adapter.on('outgoing',e=>sent.push(e));const plugin=await install(bot,extra);return {bot,seen,sent,plugin};
}

test('built-in installation is idempotent, scoped, validated, simulated and protected by admin APIs',async t=>{
  const {bot,plugin}=await setup(t);assert.equal((await bot.plugins.install({kind:'group-chat-plus'})).id,plugin.id);
  assert.equal((await request(bot,'/admin/plugins/install',{kind:'group-chat-plus'},'onebot')).code,401);
  assert.ok((await request(bot,'/admin/plugins')).data.builtins.some(p=>p.kind==='group-chat-plus'));
  const preview=await bot.plugins.test({plugin,text:'hello',message_type:'group',group_id:20001,user_id:10001});assert.match(preview.reply,/模拟/);
  await assert.rejects(bot.plugins.save({plugin:{...plugin,name:'重复插件'}}),/已安装/);
  for(const patch of [{initial_probability:2},{quiet_start:'25:00'},{proactive_max_per_day:0},{timezone:'invalid'},{unknown:true}])assert.throws(()=>groupChatConfig(patch));
  await assert.rejects(bot.plugins.save({id:plugin.id,revision:plugin.revision,plugin:{...plugin,scope:{...plugin.scope,all_private:true}}}),/只能配置群聊/);
});

test('unmentioned messages pass probability plus AI judgment once and reply through the existing queue with the real sender',async t=>{
  let judgments=0;const {bot,seen,sent}=await setup(t,{}, {groupChatDecisionAI:{reply:async()=>{judgments++;return '{"reply":true,"confidence":1}';}}});
  inject(bot,100,'这个问题大家怎么看',{sender:{user_id:10002,nickname:'小红'}});inject(bot,100,'这个问题大家怎么看',{sender:{user_id:10002,nickname:'小红'}});
  const job=await done(bot,100);assert.equal(judgments,1);assert.equal(seen.length,1);assert.equal(sent.length,1);
  assert.equal(sent[0].message.find(s=>s.type==='at').data.qq,'10002');assert.equal(sent[0].message[0].data.id,'100');assert.equal(bot.groupChatPlus.route(job).approved,1);
});

test('mention, bot reply and trigger words bypass probability while blacklists and mentions of others stay silent',async t=>{
  let judgments=0;const {bot,seen}=await setup(t,{initial_probability:0,trigger_keywords:['小助手'],blacklist_users:['10003'],blacklist_keywords:['忽略这条']},
    {groupChatRandom:()=>1,groupChatDecisionAI:{reply:async()=>{judgments++;return '{}';}}});
  inject(bot,200,'普通消息');await done(bot,200,'ignored');inject(bot,201,mention('你好'));await done(bot,201);
  inject(bot,202,'小助手来一下');await done(bot,202);
  inject(bot,203,mention('忽略这条'));await done(bot,203,'ignored');inject(bot,204,mention('你好'),{sender:{user_id:10003}});await done(bot,204,'ignored');
  inject(bot,205,[{type:'at',data:{qq:'10009'}},{type:'text',data:{text:'这事你来'}}]);await done(bot,205,'ignored');
  assert.equal(seen.length,2);assert.equal(judgments,0);
  inject(bot,206,'其他群消息',{groupId:20002});await done(bot,206,'ignored');assert.equal(seen.length,2);
});

test('AI silence, malformed judgment and provider failure never fall back to an unintended ordinary reply',async t=>{
  for(const answer of ['{"reply":false,"confidence":1}','{"reply":"true","confidence":1}','not-json',null]){
    const {bot,seen,sent}=await setup(t,{}, {groupChatDecisionAI:{reply:async()=>{if(answer===null)throw Error('private provider detail');return answer;}}});
    inject(bot,300,'讨论一个话题');const job=await done(bot,300,'ignored');assert.equal(job.reason,'group_chat_silent');assert.equal(seen.length,0);assert.equal(sent.length,0);
  }
});

test('Smart merging and empty mentions preserve the anchor and include bounded follow-up messages',async t=>{
  for(const empty of [false,true]){
    const {bot,seen,sent}=await setup(t,{merge_window_ms:120,empty_at_wait_ms:120,max_batch_messages:3});
    inject(bot,400,empty?[{type:'at',data:{qq:'10000'}}]:mention('我们准备去哪'));inject(bot,401,'补充一下：去公园',{sender:{user_id:10002}});inject(bot,402,'下午三点出发');
    const job=await done(bot,400);await done(bot,401,'ignored');await done(bot,402,'ignored');
    assert.equal(seen.length,1);assert.equal(bot.groupChatPlus.route(job).data.members.length,3);assert.match(seen[0].options.backgroundContent,/公园/);assert.match(seen[0].options.backgroundContent,/三点/);
    assert.equal(sent[0].message[0].data.id,'400');assert.equal(sent[0].message.find(s=>s.type==='at').data.qq,'10001');
  }
});

test('attention decays, negation does not create a happy mood and quiet hours support midnight boundaries',async t=>{
  let clock=Date.now();const {bot,seen,plugin}=await setup(t,{}, {groupChatNow:()=>clock});
  assert.equal(moodOf('我不开心'),'neutral');assert.equal(moodOf('有点难过'),'sad');
  inject(bot,500,mention('今天很难过'));await done(bot,500);assert.match(seen[0].options.systemPromptSuffix,/体贴/);
  const c=groupChatConfig(plugin.config),state=bot.groupChatPlus.read('10000:group:20001',plugin),user=state.users['10001'];
  const initial=bot.groupChatPlus.attention(user,c);clock+=c.attention_half_life_seconds*1000;assert.ok(Math.abs(bot.groupChatPlus.attention(user,c)-initial/2)<0.001);
  const q=groupChatConfig({quiet_hours_enabled:true,timezone:'Asia/Shanghai'});assert.equal(quiet(q,Date.parse('2026-10-28T16:00:00Z')),true);assert.equal(quiet(q,Date.parse('2026-10-28T04:00:00Z')),false);
});

test('cooldown and reply density limit ambient participation but direct mentions can continue a conversation',async t=>{
  const {bot,seen}=await setup(t,{cooldown_seconds:60,max_replies_per_minute:1});
  inject(bot,600,mention('先回复'));await done(bot,600);inject(bot,601,'继续说一个话题');await done(bot,601,'ignored');assert.equal(seen.length,1);
  inject(bot,602,mention('我还有个问题'));await done(bot,602);assert.equal(seen.length,2);
});

test('judgment is persisted and generation retry does not reroll its probability or call the judge twice',async t=>{
  let judgments=0,models=0;
  const {bot}=await setup(t,{}, {ai:{reply:async()=>{if(++models===1)throw new BotError('retry',1500,{retryable:true});return '成功';}},
    groupChatDecisionAI:{reply:async()=>{judgments++;return '{"reply":true,"confidence":1}';}}});
  inject(bot,700,'需要讨论的问题');await waitFor(()=>row(bot,700)?.reason==='ai_generation_failed');
  bot.store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=?').run(row(bot,700).id);bot.worker.wake();await done(bot,700);
  assert.equal(judgments,1);assert.equal(models,2);
});

test('duplicate and blocked output are filtered before any QQ text or voice is emitted',async t=>{
  const {bot,sent}=await setup(t,{output_block_words:['禁止内容']},{ai:{reply:async(input,_history,_signal,options)=>{
    const reply=input.includes('过滤')?'禁止内容'.repeat(30):'同一条回答';await options.onDelta?.(reply,reply);return reply;
  }}});
  inject(bot,800,mention('先说一句'));await done(bot,800);inject(bot,801,mention('再说一句'));assert.equal((await done(bot,801,'ignored')).reason,'group_chat_reply_filtered');
  inject(bot,802,mention('过滤这句'));await done(bot,802,'ignored');assert.equal(sent.length,1);
});

test('turning duplicate filtering off preserves incremental QQ streaming for automatically admitted messages',async t=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const a='这是一段正在生成的回答。'.repeat(8),b='最终结尾';const {bot,sent}=await setup(t,{duplicate_filter:false},{ai:{reply:async(_a,_b,signal,options)=>{
    await options.onDelta(a,a);await Promise.race([held,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);signal.throwIfAborted();return a+b;
  }}});cleanup(t,()=>release());
  inject(bot,900,'普通群聊问题');await waitFor(()=>sent.length>0);assert.equal(row(bot,900).status,'generating');release();await done(bot,900);assert.ok(sent.length>1);
});

test('image captions use a real multimodal input once, cache only text and remain scoped to the group and model',async t=>{
  let captions=0;const {bot,seen,plugin}=await setup(t,{}, {groupChatImageAI:{reply:async(_i,_h,_s,options)=>{captions++;assert.ok(options.userContent.some(p=>p.type==='image_url'));return '图片中有一只蓝色小鸟。';}}});
  await mkdir(bot.config.kernel.data,{recursive:true});const file=join(bot.config.kernel.data,'bird.png');await writeFile(file,png());
  const message=[...mention('看看这张图'),{type:'image',data:{file:pathToFileURL(file).href}}];
  inject(bot,1000,message);await done(bot,1000);inject(bot,1001,message);await done(bot,1001);assert.equal(captions,1);
  assert.ok(seen.every(x=>x.options.userContent.some(p=>p.text?.includes('蓝色小鸟'))));assert.ok(seen.every(x=>!x.options.userContent.some(p=>p.type==='image_url')));
  const cache=bot.store.db.prepare('SELECT * FROM group_chat_images').all();assert.equal(cache.length,1);assert.ok(!JSON.stringify(cache).includes('base64'));
  inject(bot,1002,'/gcp_clear_image_cache');await done(bot,1002,'ignored');assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n,0);
});

test('clearing image cache cancels an unfinished background caption so it cannot repopulate the cache',async t=>{
  let release,started=false;const held=new Promise(resolve=>{release=resolve;});
  const {bot}=await setup(t,{initial_probability:0,attention_enabled:false},{groupChatImageAI:{reply:async()=>{started=true;await held;return '不应在清理后重新写回的描述';}}});
  const tasks=bot.groupChatPlus;await mkdir(bot.config.kernel.data,{recursive:true});const file=join(bot.config.kernel.data,'pending.png');await writeFile(file,png());
  inject(bot,1090,[{type:'image',data:{file:pathToFileURL(file).href}}]);await waitFor(()=>started);
  try{inject(bot,1091,'/gcp_clear_image_cache');await done(bot,1091,'ignored');}
  finally{release();}
  await Promise.allSettled([...tasks.captionTasks,...tasks.images.values()]);
  assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n,0);
});

test('administrator commands pause, resume, report and reset state while non-admins cannot change it',async t=>{
  const {bot,seen,plugin}=await setup(t);
  inject(bot,1100,'/gcp_pause');await done(bot,1100,'ignored');inject(bot,1101,mention('暂停时不回复'));await done(bot,1101,'ignored');assert.equal(seen.length,0);
  inject(bot,1102,'/gcp_resume',{sender:{user_id:10002}});await done(bot,1102,'ignored');assert.equal(bot.groupChatPlus.read('10000:group:20001',plugin).paused,true);
  inject(bot,1103,'/gcp_resume');await done(bot,1103,'ignored');inject(bot,1104,mention('恢复回复'));await done(bot,1104);assert.equal(seen.length,1);
  inject(bot,1105,'/gcp_probability 0.25');await done(bot,1105,'ignored');assert.equal(bot.groupChatPlus.read('10000:group:20001',plugin).probability,0.25);
  inject(bot,1106,'/gcp_status');await done(bot,1106,'ignored');inject(bot,1107,'/new');await done(bot,1107,'ignored');
  assert.equal(Object.keys(bot.groupChatPlus.read('10000:group:20001',plugin).users).length,0);assert.equal(bot.store.history('10000:group:20001',10).length,0);
});

test('editing or disabling the plugin cancels queued delivery and revokes a previous automatic reply grant',async t=>{
  const {bot,sent,plugin}=await setup(t,{typing_delay_ms:800});inject(bot,1200,mention('稍后发送'));await done(bot,1200,'ready');
  await bot.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:false});await done(bot,1200,'ignored');assert.equal(sent.length,0);
});

test('proactive scheduling respects activity, silence, daily limits and sends no fake mention or quotation',async t=>{
  let clock=Date.now();const {bot,seen,sent,plugin}=await setup(t,{initial_probability:0,attention_enabled:false,proactive_enabled:true,
    proactive_silence_seconds:10,proactive_cooldown_seconds:10,proactive_check_seconds:5,proactive_min_user_messages:2,proactive_activity_window_seconds:120,proactive_probability:1,proactive_max_per_day:1},
    {groupChatNow:()=>clock});
  inject(bot,1300,'第一句');await done(bot,1300,'ignored');inject(bot,1301,'第二句');await done(bot,1301,'ignored');assert.equal(bot.groupChatPlus.tick(),0);
  clock+=11000;assert.equal(bot.groupChatPlus.tick(),1);assert.equal(bot.groupChatPlus.tick(),0);
  await waitFor(()=>bot.store.summary().done===1);assert.equal(seen.length,1);assert.equal(seen[0].options.proactive,true);
  assert.ok(!sent[0].message.some(s=>['at','reply'].includes(s.type)));assert.ok(!seen[0].options.tools.some(t=>['memory_save','memory_forget'].includes(t.function.name)));
  clock+=60000;assert.equal(bot.groupChatPlus.tick(),0);assert.equal(bot.groupChatPlus.read('10000:group:20001',plugin).proactive_count,1);
});

test('unmentioned images can be captioned in the background without creating a reply',async t=>{
  let captions=0;const {bot,seen,sent}=await setup(t,{initial_probability:0,attention_enabled:false},
    {groupChatImageAI:{reply:async()=>{captions++;return '一只橘猫在窗台上。';}}});
  await mkdir(bot.config.kernel.data,{recursive:true});const file=join(bot.config.kernel.data,'cat.png');await writeFile(file,png());
  inject(bot,1400,[{type:'image',data:{file:pathToFileURL(file).href}}]);await done(bot,1400,'ignored');
  await waitFor(()=>bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n===1);assert.equal(captions,1);assert.equal(sent.length,0);
  inject(bot,1401,mention('刚才图片是什么'));await done(bot,1401);assert.match(seen[0].options.backgroundContent,/橘猫/);
});

test('blacklisted background is omitted and explicit mention-only plugin scope disables automatic participation',async t=>{
  const {bot,seen,plugin}=await setup(t,{blacklist_users:['10003'],blacklist_keywords:['过滤词']});
  inject(bot,1500,'这是黑名单用户的消息',{sender:{user_id:10003}});await done(bot,1500,'ignored');inject(bot,1501,'过滤词里的内容');await done(bot,1501,'ignored');
  inject(bot,1502,mention('正常问题'));await done(bot,1502);assert.ok(!seen[0].options.backgroundContent.includes('黑名单用户'));assert.ok(!seen[0].options.backgroundContent.includes('过滤词'));
  await bot.plugins.save({id:plugin.id,revision:plugin.revision,plugin:{...plugin,scope:{...plugin.scope,require_at:true}}});
  inject(bot,1503,'普通消息');await done(bot,1503,'ignored');assert.equal(seen.length,1);
});

test('proactive scheduling stays silent while offline, paused, busy or in quiet hours',async t=>{
  let clock=Date.parse('2026-10-28T04:00:00Z');const {bot,plugin}=await setup(t,{initial_probability:0,attention_enabled:false,proactive_enabled:true,
    proactive_silence_seconds:10,proactive_min_user_messages:1,proactive_activity_window_seconds:86400,proactive_probability:1,proactive_check_seconds:5}, {groupChatNow:()=>clock});
  inject(bot,1600,'白天的消息');await done(bot,1600,'ignored');clock+=20000;
  bot.adapter.driver.online=false;assert.equal(bot.groupChatPlus.tick(),0);bot.adapter.driver.online=true;
  let state=bot.groupChatPlus.read('10000:group:20001',plugin);state.paused=true;bot.groupChatPlus.write('10000:group:20001',plugin,state);assert.equal(bot.groupChatPlus.tick(),0);
  state.paused=false;bot.groupChatPlus.write('10000:group:20001',plugin,state);
  const task=bot.store.ingest({post_type:'message',message_type:'group',message_id:1601,self_id:10000,user_id:10001,group_id:20001,message:'待核对'},'pending',100);bot.store.update(task.id,'uncertain',{reply:'pending'});
  assert.equal(bot.groupChatPlus.tick(),0);bot.store.update(task.id,'failed');
  const updated=await bot.plugins.save({id:plugin.id,revision:plugin.revision,plugin:{...plugin,config:{...plugin.config,quiet_hours_enabled:true}}});
  clock=Date.parse('2026-10-28T16:00:00Z');assert.equal(bot.groupChatPlus.tick(),0);assert.equal(updated.enabled,true);
});

test('approved routed jobs and runtime attention survive an actual app restart without a second judgment',async t=>{
  const cfg=config(await temp(t),env);let judgments=0,generations=0;
  const overrides={log:()=>{},groupChatDecisionAI:{reply:async()=>{judgments++;return '{"reply":true,"confidence":1}';}},
    ai:{reply:async()=>{generations++;throw new BotError('retry',1500,{retryable:true});}}};
  let bot=await createApp(cfg,overrides);const plugin=await install(bot);
  inject(bot,1700,'可恢复的普通消息');await waitFor(()=>row(bot,1700)?.reason==='ai_generation_failed');await bot.close();
  bot=await createApp(cfg,{...overrides,ai:{reply:async()=>{generations++;return '恢复后的回答';}}});cleanup(t,()=>bot.close());
  bot.store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=?').run(row(bot,1700).id);bot.worker.wake();await done(bot,1700);
  assert.equal(judgments,1);assert.equal(generations,2);assert.ok(bot.groupChatPlus.read('10000:group:20001',plugin).users['10001']);
});

test('installer merges explicit group scope and preserves advanced configuration on reinstallation',async t=>{
  const bot=await app(t,env);let result=await installGroupChatPlus(bot.plugins,['20001']);assert.equal(result.enabled,true);assert.deepEqual(result.groups,['20001']);
  let p=bot.plugins.get(result.id);p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,config:{...p.config,initial_probability:0.13}}});
  result=await installGroupChatPlus(bot.plugins,['20002']);assert.equal(result.id,p.id);assert.deepEqual(result.groups,['20001','20002']);assert.equal(bot.plugins.get(p.id).config.initial_probability,0.13);
});
