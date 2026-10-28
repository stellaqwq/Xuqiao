import test from 'node:test';
import assert from 'node:assert/strict';
import {app,request,cleanup,temp,config,incoming} from './helpers.mjs';
import {pluginTemplate} from '../src/plugins/service.mjs';
import {createApp} from '../src/app.mjs';
import {groupChatSchema} from '../src/group-chat-plus/schema.mjs';
import {groupChatTemplate} from '../src/group-chat-plus/config.mjs';
import {normalizeConfigSchema,applyConfigSchema} from '../src/plugins/config-schema.mjs';

const schema={enabled:{type:'bool',default:true},count:{type:'int',default:2,slider:{min:1,max:5}},tags:{type:'list',default:[]},mode:{type:'string',options:['brief','full'],default:'brief'},nested:{type:'object',items:{prompt:{type:'text',default:'你好'}}}};
test('AstrBot-style schemas apply nested defaults and constraints without discarding legacy config',()=>{
  const normalized=normalizeConfigSchema(schema),result=applyConfigSchema(normalized,{legacy:'kept',nested:{prompt:'custom'}});
  assert.deepEqual(result,{legacy:'kept',enabled:true,count:2,tags:[],mode:'brief',nested:{prompt:'custom'}});
  for(const value of [{count:1.5},{count:9},{tags:[1]},{enabled:'true'},{mode:'unknown'},{nested:null}])assert.throws(()=>applyConfigSchema(normalized,value));
  assert.throws(()=>normalizeConfigSchema({x:{type:'file'}}));
  assert.throws(()=>normalizeConfigSchema(JSON.parse('{"__proto__":{"type":"string"}}')));
  assert.throws(()=>applyConfigSchema(normalized,JSON.parse('{"constructor":{}}')));
  assert.deepEqual(Object.keys(groupChatSchema).sort(),Object.keys(groupChatTemplate.config).sort());
});
test('plugin schema persistence, failed saves and reload preserve enabled scope and configuration atomically',async t=>{
  const bot=await app(t);let p=await bot.plugins.save({plugin:{...pluginTemplate,config_schema:schema,config:{},scope:{...pluginTemplate.scope,private_users:['10001']}}});
  assert.equal(p.config.nested.prompt,'你好');assert.equal(p.config.count,2);
  p=await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  const previous=structuredClone(p);
  assert.equal((await request(bot,'/admin/plugins/reload',{id:p.id,revision:p.revision},'onebot')).code,401);
  p=(await request(bot,'/admin/plugins/reload',{id:p.id,revision:p.revision})).data;
  assert.equal(p.enabled,true);assert.equal(p.revision,previous.revision+1);assert.deepEqual(p.scope,previous.scope);assert.deepEqual(p.config,previous.config);
  assert.equal((await request(bot,'/admin/plugins/reload',{id:p.id,revision:previous.revision})).code,409);
  await assert.rejects(bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,config:{count:8}}}),/范围/);
  assert.deepEqual(bot.plugins.get(p.id).config,p.config);
  assert.ok(!Object.hasOwn(bot.plugins.list().plugins[0],'config_schema'));
});
async function setup(t){const dir=await temp(t),settings=config(dir,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_GROUPS:'20001,20002'}),bot=await createApp(settings,{log:()=>{}});cleanup(t,()=>bot.close());let p=await bot.plugins.install({kind:'group-chat-plus'});p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,scope:{...p.scope,groups:['20001','20002']}}});p=await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});return {bot,p,settings};}
const action=(bot,p,params)=>request(bot,'/admin/plugins/groupchat/action',{revision:p.revision,group:'20001',...params});
test('group administration is authenticated and isolates groups, probability, pause and image cache actions',async t=>{
  const {bot,p}=await setup(t);
  assert.equal((await request(bot,'/admin/plugins/groupchat',undefined,'onebot')).code,401);
  assert.equal((await request(bot,'/admin/plugins/groupchat?group=99999')).code,403);
  assert.equal((await action(bot,p,{action:'pause',group:'../../data'})).code,400);
  assert.equal((await action(bot,p,{action:'pause'})).code,200);assert.equal(bot.groupChatPlus.read('10000:group:20001',p).paused,true);
  assert.equal(bot.groupChatPlus.read('10000:group:20002',p).paused,false);
  await action(bot,p,{action:'probability',value:0.4});assert.equal(bot.groupChatPlus.read('10000:group:20001',p).probability,0.4);
  assert.equal((await action(bot,p,{action:'probability',value:1.1})).code,400);
  await action(bot,p,{action:'probability',value:null});assert.equal(bot.groupChatPlus.read('10000:group:20001',p).probability,undefined);
  for(const group of ['20001','20002'])bot.store.db.prepare('INSERT INTO group_chat_images VALUES (?,?,?,?,?,?)').run(group.padStart(64,'a'),p.id,'10000:group:'+group,'fixture','描述 '+group,Date.now());
  await action(bot,p,{action:'clear_images'});assert.equal(bot.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n,1);
  const report=(await request(bot,'/admin/plugins/groupchat?group=20002')).data;assert.equal(report.detail.images[0].caption,'描述 20002');assert.equal(report.groups.length,2);
});
test('group overrides inherit global defaults, reject conflicts, invalidate queued grants and survive conversation reset and restart',async t=>{
  const {bot,p,settings}=await setup(t),session='10000:group:20001';
  let res=await action(bot,p,{action:'overrides',override_revision:0,config:{initial_probability:0.33,happy_style:'轻松一点。'}});assert.equal(res.code,200);
  assert.equal(bot.groupChatPlus.settings(p,session).initial_probability,0.33);assert.equal(bot.groupChatPlus.settings(p,'10000:group:20002').initial_probability,0.06);
  assert.equal((await action(bot,p,{action:'overrides',override_revision:0,config:{}})).code,409);
  assert.equal((await action(bot,p,{action:'overrides',override_revision:1,config:{not_supported:true}})).code,400);
  const event={post_type:'message',message_type:'group',message_id:888,user_id:10001,self_id:10000,group_id:20001,message:[{type:'text',data:{text:'hello'}}]},job=bot.store.ingest(event,'old grant',100);bot.store.update(job.id,'uncertain');
  bot.store.db.prepare('INSERT INTO group_chat_jobs VALUES (?,?,?,?,?,?,?)').run(job.id,p.id,p.revision,'ambient',JSON.stringify({settings_revision:0}),1,Date.now());
  assert.equal(bot.groupChatPlus.scopedRoute(bot.store.get(job.id),{...event,self_id:10000}),null);
  assert.equal((await action(bot,p,{action:'reset'})).code,409);bot.store.update(job.id,'failed');
  assert.equal((await action(bot,p,{action:'reset'})).code,200);assert.equal(bot.groupChatPlus.settings(p,session).initial_probability,0.33);
  await bot.close();const next=await createApp(settings,{log:()=>{}});cleanup(t,()=>next.close());
  assert.equal(next.groupChatPlus.settings(p,session).happy_style,'轻松一点。');
  res=await action(next,p,{action:'overrides',override_revision:1,config:{}});assert.equal(res.code,200);assert.equal(next.groupChatPlus.settings(p,session).initial_probability,0.06);
});

test('a new member message releases the unanswered proactive limit even after the old response window',async t=>{
  const {bot,p}=await setup(t),session='10000:group:20001',runtime=bot.groupChatPlus,state=runtime.read(session,p);
  state.last_reply=Date.now()-600000;state.last_proactive=state.last_reply;state.unanswered_proactive=5;runtime.write(session,p,state);
  runtime.observe({post_type:'message',message_type:'group',self_id:10000,group_id:20001,user_id:10001,message_id:999,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'群里又有新话题了'}}]});
  assert.equal(runtime.read(session,p).unanswered_proactive,0);
});

test('per-group cache retention cannot delete another group with a longer retention window',async t=>{
  const {bot,p}=await setup(t);
  await action(bot,p,{action:'overrides',override_revision:0,config:{image_cache_days:1}});
  await action(bot,p,{group:'20002',action:'overrides',override_revision:0,config:{image_cache_days:30}});
  for(const group of ['20001','20002'])bot.store.db.prepare('INSERT INTO group_chat_images VALUES (?,?,?,?,?,?)').run(group.padStart(64,'b'),p.id,'10000:group:'+group,'fixture','旧描述',Date.now()-10*86400000);
  bot.groupChatPlus.cleanup();const rows=bot.store.db.prepare('SELECT conversation FROM group_chat_images').all();assert.deepEqual(rows.map(row=>row.conversation),['10000:group:20002']);
});
