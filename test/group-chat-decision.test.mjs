import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {formatJobDetail} from '../src/web/job-detail.mjs';
import {app,incoming,waitFor,request,cleanup} from './helpers.mjs';

async function setup(t,judge,extra={}){
  let generated=0;const bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_GROUPS:'20001',AI_REASONING_EFFORT:'high'},
    {ai:{reply:async()=>{generated++;return '不应生成的回复';}},...(judge?{groupChatDecisionAI:{reply:judge}}:{})});
  let p=await bot.plugins.install({kind:'group-chat-plus'});
  p=await bot.plugins.save({id:p.id,revision:p.revision,plugin:{...p,scope:{...p.scope,groups:['20001']},
    config:{...p.config,initial_probability:1,attention_enabled:false,cooldown_seconds:0,merge_window_ms:0,quiet_hours_enabled:false,proactive_enabled:false,...extra}}});
  await bot.plugins.toggle({id:p.id,revision:p.revision,enabled:true});
  return {bot,generated:()=>generated};
}
async function ignored(bot,id){
  bot.adapter.driver.inject(incoming(id,{kind:'group',groupId:20001,message:'群成员之间正在讨论的话题'}));
  const row=await waitFor(()=>{const r=bot.store.db.prepare("SELECT * FROM jobs WHERE json_extract(event,'$.message_id')=?").get(id);return r?.status==='ignored'&&r;});
  const response=await request(bot,'/admin/jobs/'+row.id);assert.equal(response.code,200);return response.data;
}
test('AI silence saves its brief reason, confidence and threshold in admin task details without sending a reply',async t=>{
  let judged=0;const {bot,generated}=await setup(t,async()=>{judged++;return JSON.stringify({reply:false,confidence:0.94,reason:'成员正在相互交流，机器人暂时没有需要补充的信息。'});}),sent=[];
  bot.adapter.on('outgoing',e=>sent.push(e));
  const job=await ignored(bot,7101);assert.equal(job.reason,'group_chat_silent');assert.equal(generated(),0);assert.equal(judged,1);assert.equal(sent.length,0);
  assert.equal(job.group_chat_decision.outcome,'declined');assert.equal(job.group_chat_decision.confidence,0.94);assert.equal(job.group_chat_decision.threshold,0.5);
  assert.equal(job.event.content_retained,false);assert.equal(job.reply,null);
  const text=formatJobDetail(job);assert.match(text,/AI 读空气：不适合参与/);assert.match(text,/机器人暂时没有需要补充的信息/);assert.match(text,/判断置信度：0.94/);
  assert.equal((await request(bot,'/admin/jobs/'+job.id,undefined,'onebot')).code,401);
  assert.ok(!JSON.stringify(bot.telemetry.read()).includes('机器人暂时没有需要补充的信息'));
  const settings=bot.config;await bot.close();const next=await createApp(settings,{log:()=>{},groupChatDecisionAI:{reply:async()=>{throw Error('must not rejudge');}}});cleanup(t,()=>next.close());
  const restored=(await request(next,'/admin/jobs/'+job.id)).data;assert.deepEqual(restored.group_chat_decision,job.group_chat_decision);assert.equal(restored.reply,null);
});
test('low confidence keeps the model explanation while distinguishing the participation threshold',async t=>{
  const {bot,generated}=await setup(t,async()=>JSON.stringify({reply:true,confidence:0.4,reason:'可以提供一点补充，但把握不大。'}),{decision_confidence_threshold:0.8});
  const job=await ignored(bot,7102);assert.equal(generated(),0);assert.equal(job.group_chat_decision.outcome,'low_confidence');
  assert.match(formatJobDetail(job),/置信度不足/);assert.match(formatJobDetail(job),/参与门槛 0.8/);assert.match(formatJobDetail(job),/把握不大/);
});
test('missing reasons, invalid output and provider failures have distinct bounded diagnostics without retaining raw failures',async t=>{
  const fixtures=[
    {reply:async()=>'```json\n{"reply":false,"confidence":0.9}\n```',outcome:'declined',text:/未提供简短判断理由/},
    {reply:async()=>'invalid private provider payload',outcome:'invalid',text:/判断输出格式无效/},
    {reply:async()=>JSON.stringify({reply:'false',confidence:0.9,reason:'must not retain invalid rationale'}),outcome:'invalid',text:/判断输出格式无效/},
    {reply:async()=>{throw Error('private provider credential');},outcome:'error',text:/判断请求失败或超时/}
  ];
  for(let i=0;i<fixtures.length;i++){
    const fixture=fixtures[i],{bot,generated}=await setup(t,fixture.reply),job=await ignored(bot,7200+i);
    assert.equal(generated(),0);assert.equal(job.group_chat_decision.outcome,fixture.outcome);assert.match(formatJobDetail(job),fixture.text);
    assert.doesNotMatch(JSON.stringify(job.group_chat_decision),/private provider|must not retain/);await bot.close();
  }
  const {bot}=await setup(t,async()=>JSON.stringify({reply:false,confidence:0.9,reason:'\u0000'+('简短理由'.repeat(150))}));
  const job=await ignored(bot,7300);assert.equal(Array.from(job.group_chat_decision.reason).length,300);assert.ok(!job.group_chat_decision.reason.includes('\u0000'));
});
test('legacy silent tasks show the missing explanation explicitly and keep the original reply display',()=>{
  const text=formatJobDetail({conversation:'10000:group:20001',reason:'group_chat_silent',status:'ignored',event:{content_retained:false,content_state:'redacted'}});
  assert.match(text,/未保存判断理由/);assert.match(text,/正文已脱敏/);assert.doesNotMatch(text,/undefined/);
});

test('auxiliary requests explicitly disable thinking, preserve main reasoning and retain safe token-limit diagnostics',async t=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{
    if(!String(url).endsWith('/chat/completions'))return original(url,options);
    requests.push(JSON.parse(options.body));
    const data={choices:[{index:0,delta:{reasoning_content:'private hidden reasoning'},finish_reason:'length'}],usage:{prompt_tokens:80,completion_tokens:512,completion_tokens_details:{reasoning_tokens:512}}};
    return new Response('data: '+JSON.stringify(data)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const {bot,generated}=await setup(t,null),job=await ignored(bot,7400);
  assert.equal(generated(),0);assert.equal(requests[0].reasoning_effort,'none');assert.equal(requests[0].max_tokens,512);assert.equal(requests[0].stream_options.include_usage,true);
  assert.equal(bot.config.ai.reasoningEffort,'high');assert.equal(job.group_chat_decision.diagnostic.reason,'ai_reasoning_only');
  assert.equal(job.group_chat_decision.diagnostic.reasoning_tokens,512);assert.match(formatJobDetail(job),/达到输出 Token 上限/);assert.match(formatJobDetail(job),/思考 512/);
  assert.doesNotMatch(JSON.stringify(job),/private hidden reasoning/);
  const p=bot.plugins.findGroupChat(),c=bot.groupChatPlus.settings(p,'10000:group:20001');
  await assert.rejects(bot.groupChatPlus.client(c,'image').reply('测试图片描述',[]));assert.equal(requests[1].reasoning_effort,'none');assert.equal(requests[1].max_tokens,2048);
  await assert.rejects(bot.groupChatPlus.client({...c,decision_reasoning_effort:'',decision_max_output_tokens:4096},'decision').reply('测试判断',[]));
  assert.equal(Object.hasOwn(requests[2],'reasoning_effort'),false);assert.equal(requests[2].max_tokens,4096);
});
