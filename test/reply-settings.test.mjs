import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {environmentOf,loadConfig} from '../src/config.mjs';
import {launchWorkspace} from '../scripts/launch.mjs';
import {pluginTemplate} from '../src/plugins/service.mjs';
import {app,config,temp,cleanup,incoming,waitFor} from './helpers.mjs';

function assertFormatting(messages,mention,quote){
  for(const event of messages){
    assert.equal(event.message.some(s=>s.type==='at'),event.message_type==='group'&&mention);
    assert.equal(event.message.some(s=>s.type==='reply'),quote);
    const at=event.message.find(s=>s.type==='at');if(at)assert.equal(at.data.qq,'10001');
  }
}
const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001',AI_GROUP_REQUIRE_AT:'false',AI_STREAM_ENABLED:'false'};
test('reply formatting defaults stay enabled and saved settings persist and apply through workspace restart',async t=>{
  const directory=await temp(t),settings=config(directory),path=join(directory,'.env');
  assert.deepEqual(settings.reply,{atSender:true,quoteMessage:true});
  assert.throws(()=>loadConfig({...environmentOf(settings),REPLY_AT_SENDER:'yes'}),/REPLY_AT_SENDER/);
  await writeFile(path,Object.entries(environmentOf(settings)).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n'));
  const workspace=await launchWorkspace(settings,{settingsPath:path});cleanup(t,()=>workspace.close());
  const before=await workspace.app.settings.snapshot();
  assert.equal(before.values.REPLY_AT_SENDER,'true');assert.equal(before.values.REPLY_QUOTE_MESSAGE,'true');
  const saved=await workspace.app.settings.save({REPLY_AT_SENDER:'false',REPLY_QUOTE_MESSAGE:'false'},before.revision);
  assert.ok(saved.pending.includes('REPLY_AT_SENDER'));assert.equal(workspace.app.config.reply.atSender,true);
  const persisted=parseEnv(await readFile(path,'utf8'));assert.equal(persisted.REPLY_AT_SENDER,'false');assert.equal(persisted.REPLY_QUOTE_MESSAGE,'false');
  await workspace.restart();assert.deepEqual(workspace.app.config.reply,{atSender:false,quoteMessage:false});
  assert.ok(!(await workspace.app.settings.snapshot()).pending.includes('REPLY_QUOTE_MESSAGE'));
});
test('ordinary AI private and group replies obey all four independent formatting combinations',async t=>{
  for(const mention of [false,true])for(const quote of [false,true]){
    const bot=await app(t,{...env,REPLY_AT_SENDER:String(mention),REPLY_QUOTE_MESSAGE:String(quote)},{ai:{reply:async()=> '模拟 AI 回复'}}),sent=[];
    bot.adapter.on('outgoing',e=>sent.push(e));bot.adapter.driver.inject(incoming(101));bot.adapter.driver.inject(incoming(102,{kind:'group',groupId:20001}));
    await waitFor(()=>sent.length===2&&bot.store.summary().done===2);assertFormatting(sent,mention,quote);await bot.close();
  }
});
test('message plugins and administrator command replies share the formatting settings',async t=>{
  for(const mention of [false,true])for(const quote of [false,true]){
    const bot=await app(t,{REPLY_AT_SENDER:String(mention),REPLY_QUOTE_MESSAGE:String(quote)}),sent=[];
    bot.adapter.on('outgoing',e=>sent.push(e));
    let p=await bot.plugins.save({plugin:{...pluginTemplate,trigger:'',source:"export default async ({text})=>text==='插件测试'?{reply:'模拟插件回复'}:null;",scope:{...pluginTemplate.scope,private_users:['10001'],groups:['20001'],require_at:false}}});
    await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
    bot.adapter.driver.inject(incoming(201,{message:'插件测试'}));bot.adapter.driver.inject(incoming(202,{kind:'group',groupId:20001,message:'插件测试'}));await waitFor(()=>sent.length===2);
    bot.adapter.driver.inject(incoming(203,{message:'/new'}));bot.adapter.driver.inject(incoming(204,{kind:'group',groupId:20001,message:'/new'}));await waitFor(()=>sent.length===4);
    assertFormatting(sent,mention,quote);await bot.close();
  }
});
test('Chat Plus automatic participation honors disabled mention and quote settings',async t=>{
  const bot=await app(t,{...env,REPLY_AT_SENDER:'false',REPLY_QUOTE_MESSAGE:'false'},{ai:{reply:async()=> '模拟增强回复'}}),sent=[];
  bot.adapter.on('outgoing',e=>sent.push(e));
  let p=await bot.plugins.install({kind:'group-chat-plus'});
  p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,scope:{...p.scope,groups:['20001']},config:{...p.config,attention_enabled:false,initial_probability:1,decision_ai_enabled:false,quiet_hours_enabled:false,merge_window_ms:0,proactive_enabled:false}}});
  await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  bot.adapter.driver.inject(incoming(301,{kind:'group',groupId:20001,message:'大家一起来讨论一下'}));await waitFor(()=>sent.length===1&&bot.store.summary().done===1);
  assertFormatting(sent,false,false);
});
