import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {filterAIReply} from '../src/reply-filter.mjs';
import {loadConfig,environmentOf} from '../src/config.mjs';
import {Settings} from '../src/settings.mjs';
import {Store} from '../src/store.mjs';
import {ReplyWorker} from '../src/worker.mjs';
import {VoiceStudioService,voiceStudioTemplate} from '../src/voicestudio/service.mjs';
import {formatJobDetail} from '../src/web/job-detail.mjs';
import {app,config,temp,cleanup,incoming,waitFor,replyBody,request} from './helpers.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001',AI_GROUP_REQUIRE_AT:'false',AI_STREAM_CHUNK_CHARS:'40'};
const groupEvent={post_type:'message',message_type:'group',self_id:10000,user_id:10001,group_id:20001,message_id:1,message:'问题😀'};
const emojis=['😀','😂','🥹','❤️','☀','☀️','☀︎','✅','⚠️','☕','🎉','👍🏽','👨‍👩‍👧‍👦','👩🏽‍💻','🏳️‍🌈','🏴‍☠️','🇨🇳','🇦','1️⃣','2⃣','#️⃣','*️⃣','🦰','🏽',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'];
const body=messages=>messages.flatMap(replyBody).filter(s=>s.type==='text').map(s=>s.data.text).join('');
function fixture(t,{environment={},ai,group=true}={}){
  const c=config('unused',{...env,...environment}),store=new Store(':memory:'),sent=[];t.after(()=>store.close());
  const event={...groupEvent,...(!group?{message_type:'private'}:{})};store.ingest(event,'问题😀',100);
  const worker=new ReplyWorker({store,config:c,log:()=>{},ai,adapter:{status:()=>({online:true}),action:async(_name,params)=>{sent.push(params.message);return {message_id:100+sent.length};}}});
  return {c,store,sent,worker};
}

test('emoji filtering removes full sequences and text-style emoji while preserving ordinary text, digits and code',()=>{
  const c=config('unused');assert.equal(c.ai.stripEmoji,true);
  for(const value of emojis)assert.equal(filterAIReply(value,c),'',value);
  const plain='你好，世界！English é e\u0301 𠀀\n# 标题\n1. 0123456789\n* 列表\nconst x = 10 * 2; // # comment\n± × ÷ = < > ∑ ∞ π √ → ←\nक्\u200Dष [[表情:开心]]';
  assert.equal(filterAIReply(plain,c),plain);
  assert.equal(filterAIReply('你好😀世界👍🏽！',c),'你好世界！');
  c.ai.stripEmoji=false;assert.equal(filterAIReply(emojis.join(''),c),emojis.join(''));
  assert.throws(()=>config('unused',{AI_STRIP_EMOJI:'yes'}),/AI_STRIP_EMOJI/);
});

test('partial filtering never retracts published text even when every UTF-16 code unit splits an emoji',()=>{
  const c=config('unused'),text='第一段。'+emojis.join('正常字')+'1️⃣ #️⃣ *️⃣ 𠀀 123终。';
  for(const size of [1,2,3,5,8]){
    let previous='';
    for(let end=size;end<text.length;end+=size){
      const partial=filterAIReply(text.slice(0,end),c,{partial:true});assert.ok(partial.startsWith(previous),'published prefix changed');
      assert.equal(partial,partial.toWellFormed());previous=partial;
    }
    assert.ok(filterAIReply(text,c).startsWith(previous));
  }
  assert.equal(filterAIReply('实时正文。',c,{partial:true}),'实时正文。');
  assert.equal(filterAIReply('结果1',c,{partial:true}),'结果');
  assert.equal(filterAIReply('结果1️⃣',c,{partial:true}),'结果');
  assert.equal(filterAIReply('结果123',c),'结果123');
});

test('QQ streaming filters before receipts, web snapshots and sending; final tail and history agree for groups and private chats',async t=>{
  const raw='甲'.repeat(39)+'1️⃣👩🏽‍💻'+('第一段😀。'+emojis.join('')+'数字123 * #，𠀀。').repeat(4),clean=filterAIReply(raw,config('unused'));
  for(const group of [true,false]){
    let observedInput;
    const f=fixture(t,{group,ai:{reply:async(input,_history,_signal,options)=>{
      observedInput=input;
      for(let end=1;end<=raw.length;end++)await options.onDelta(raw.slice(end-1,end),raw.slice(0,end));
      assert.ok(f.sent.length>0,'a reply must be sent before generation finishes');return raw;
    }}});
    const snapshots=[];f.store.on('stream',item=>snapshots.push(item.text));
    await f.worker.step();assert.equal(f.store.get(1).reply,clean);await f.worker.step();
    assert.equal(f.store.get(1).status,'done');assert.equal(body(f.sent),clean);assert.equal(observedInput,'问题😀');
    for(const snapshot of snapshots){assert.ok(clean.startsWith(snapshot));assert.equal(snapshot,snapshot.toWellFormed());}
    assert.equal(f.store.history('10000:'+(group?'group:20001':'private:10001'),10).at(-1).content,clean);
    assert.ok(f.store.streamedPrefix(1).length>0);assert.ok(clean.startsWith(f.store.streamedPrefix(1)));
  }
});

test('disabling the switch preserves emoji in streamed and final replies',async t=>{
  const raw=('保留😀1️⃣👩🏽‍💻。').repeat(12);
  const {worker,store,sent}=fixture(t,{environment:{AI_STRIP_EMOJI:'false'},ai:{reply:async(_a,_b,_c,options)=>{await options.onDelta(raw,raw);return raw;}}});
  await worker.step();await worker.step();assert.equal(body(sent),raw);assert.equal(store.get(1).reply,raw);
});

test('emoji-only replies produce an explicit ignored task and never send an empty mention, quote or speech request',async t=>{
  for(const stream of ['true','false']){
    const raw=emojis.join(' '),f=fixture(t,{environment:{AI_STREAM_ENABLED:stream},ai:{reply:async(_a,_b,_c,options)=>{await options.onDelta?.(raw,raw);return raw;}}});
    f.worker.voicestudio={buffersReply:()=>false,cachedReply:()=>null,prompt:()=>'',options:()=>({}),maybeSpeakReply:()=>assert.fail('empty TTS')};
    await f.worker.step();assert.equal(f.store.get(1).status,'ignored');assert.equal(f.store.get(1).reason,'ai_reply_empty_after_filter');assert.equal(f.sent.length,0);
    assert.match(formatJobDetail({...f.store.get(1),event:JSON.parse(f.store.get(1).event)}),/过滤 Emoji 后无可发送正文/);
  }
});

test('recovered replies filter unsent text without changing confirmed stream receipts',async t=>{
  for(const prefix of ['', '已发送😀。']){
    const {worker,store,sent}=fixture(t,{ai:{reply:()=>assert.fail('ready job regenerated')}});
    if(prefix){const part=store.beginStreamPart(1,prefix);store.endStreamPart(1,part,'sent',99);}
    store.update(1,'ready',{reply:prefix+'新😀回复❤️。'});await worker.step();
    assert.equal(store.get(1).status,'done');assert.equal(body(sent),'新回复。');assert.equal(store.get(1).reply,prefix+'新回复。');assert.equal(store.streamedPrefix(1),prefix);
  }
  const {worker,store,sent}=fixture(t);store.update(1,'ready',{reply:'😀'});await worker.step();assert.equal(sent.length,0);assert.equal(store.get(1).reason,'ai_reply_empty_after_filter');
});

test('AI speech tool text is filtered before synthesis, and emoji-only arguments never create a synthesis plan',async t=>{
  const c=config(await temp(t),env),store=new Store(':memory:');t.after(()=>store.close());
  const speech=new VoiceStudioService({store,config:c,log:()=>{}});cleanup(t,()=>speech.close());
  const plugin={...voiceStudioTemplate,enabled:true},calls=[];
  speech.synthesize=async(_plugin,args)=>{calls.push(args);return {file:'fixture.wav',bytes:100};};
  for(let id=1;id<=3;id++)store.ingest({...groupEvent,message_id:id},'语音问题',100);
  assert.equal((await speech.prepareSpeech(plugin,store.get(1),{text:'你好😀👩🏽‍💻1️⃣，数字123。'})).reply,'你好，数字123。');
  assert.equal(calls[0].text,'你好，数字123。');
  assert.equal((await speech.prepareSpeech(plugin,store.get(2),{text:'😀 👍🏽'})).reply,'');assert.equal(calls.length,1);assert.equal(speech.plan(2),undefined);
  await assert.rejects(speech.prepareSpeech(plugin,store.get(3),{}));assert.equal(calls.length,1);
});

test('the new switch defaults on and persists through settings validation and configuration reload',async t=>{
  const directory=await temp(t),c=config(directory),path=join(directory,'.env');
  await writeFile(path,Object.entries(environmentOf(c)).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n'));
  const settings=new Settings(c,{path}),before=await settings.snapshot();assert.equal(before.values.AI_STRIP_EMOJI,'true');
  const saved=await settings.save({AI_STRIP_EMOJI:'false'},before.revision);assert.ok(saved.pending.includes('AI_STRIP_EMOJI'));assert.equal(c.ai.stripEmoji,true);
  assert.equal(loadConfig(parseEnv(await readFile(path,'utf8'))).ai.stripEmoji,false);
});

test('Agent, Chat Plus and web chat all store filtered answers while original input remains intact',async t=>{
  const seen=[],bot=await app(t,{...env,AI_STREAM_ENABLED:'false'},{ai:{reply:async(input)=>{seen.push(input);return '收到😀，结果1️⃣是123。';}}});
  let p=await bot.plugins.install({kind:'group-chat-plus'});
  p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,scope:{...p.scope,groups:['20001']},config:{...p.config,quiet_hours_enabled:false,merge_window_ms:0,decision_ai_enabled:false,proactive_enabled:false}}});
  await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  const sent=[];bot.adapter.on('outgoing',e=>sent.push(e.message));
  bot.adapter.driver.inject(incoming(10,{message:'问题😀'}));
  bot.adapter.driver.inject(incoming(11,{kind:'group',groupId:20001,message:[{type:'at',data:{qq:'10000'}},{type:'text',data:{text:'问题😀'}}]}));
  await waitFor(()=>bot.store.summary().done===2);assert.equal(body(sent),'收到，结果是123。收到，结果是123。');assert.ok(seen.every(input=>input.includes('问题😀')));
  const web=await request(bot,'/admin/agent/chat',{text:'网页问题😀'});assert.equal(web.code,200);
  await waitFor(()=>bot.store.get(web.data.job_id)?.status==='done');assert.equal(bot.store.get(web.data.job_id).reply,'收到，结果是123。');assert.equal(sent.length,2);
});
