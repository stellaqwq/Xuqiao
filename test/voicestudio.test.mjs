import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AIClient } from '../src/ai.mjs';
import { createApp } from '../src/app.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';
import { voiceStudioTemplate, voiceStudioConfig, voiceStudioIntent } from '../src/voicestudio/service.mjs';
import { app, config, temp, cleanup, request, incoming, waitFor } from './helpers.mjs';
import { wav } from './audio-fixture.mjs';

async function service(t, options = {}) {
  const calls = [], modelRequests = []; let speechCalls = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.url === '/chat/completions') {
      modelRequests.push(body);
      if (options.requireForced && body.tool_choice !== 'required') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '没有语音功能。' } }] })); return;
      }
      const call = modelRequests.length === 1 && body.tool_choice === 'auto' ? { id: 'list', type: 'function', function: { name: 'voicestudio_list_voices', arguments: '{}' } } :
        { id: 'speak', type: 'function', function: { name: 'voicestudio_speak', arguments: JSON.stringify({ text: '你好，这是语音测试。', voice: 'fixture-voice', speed: .9, language: 'zh' }) } };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] })); return;
    }
    if (req.url === '/v1/audio/voices') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ voices: options.voices || [{ voice_id: 'fixture-voice', name: '测试音色', type: 'profile', language: 'zh' }], engines: [{ id: 'fixture', available: true }] })); return;
    }
    if (req.url === '/v1/audio/speech') {
      speechCalls++; calls.push({ body, auth: req.headers.authorization });
      if (options.delay) await delay(options.delay);
      res.statusCode = options.status || 200; res.setHeader('Content-Type', 'audio/wav'); res.end(options.invalid ? 'private provider body / not audio' : wav()); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: 'http://127.0.0.1:' + server.address().port, calls, modelRequests, get speechCalls() { return speechCalls; } };
}
async function install(bot, url) {
  const original = await bot.plugins.install({ kind: 'voicestudio' });
  const saved = await bot.plugins.save({ id: original.id, revision: original.revision, plugin: { ...original,
    config: { ...original.config, base_url: url, api_key: 'fixture-api-key' }, scope: { ...original.scope, private_users: ['10001'] } } });
  return bot.plugins.toggle({ id: saved.id, revision: saved.revision, enabled: true });
}
const event = id => ({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10001, message_id: id, message: [{ type: 'text', data: { text: '请用语音回复' } }] });

test('VoiceStudio config and install validate settings, preserve default disable and normalize /v1', async t => {
  const bot = await app(t);
  const row = await bot.plugins.install({ kind: 'voicestudio' });
  assert.equal(row.enabled, false); assert.equal((await bot.plugins.install({ kind: 'voicestudio' })).id, row.id);
  assert.equal(row.config.reply_probability, 0);
  for (const reply_probability of [-.01,1.01,'0.5',null,NaN,Infinity]) assert.throws(() => voiceStudioConfig({reply_probability}),/概率/);
  assert.equal(voiceStudioConfig({reply_probability:.375}).reply_probability,.375);
  assert.equal(voiceStudioConfig({ base_url: 'http://127.0.0.1:3900/v1/' }).base_url, 'http://127.0.0.1:3900');
  for (const config of [{ base_url: 'file:///a' }, { base_url: 'http://user:pass@localhost' }, { api_key: 'a\nb' }, { speed: 0 }, { timeout_seconds: 0 }, { ai_tools: 'yes' }]) assert.throws(() => voiceStudioConfig(config));
  await assert.rejects(bot.plugins.save({ plugin: voiceStudioTemplate }), /已安装/);
  const preview = await bot.plugins.test({ plugin: row, text: '/vs_say hello' });
  assert.match(preview.reply, /不调用合成/);
});

async function probability(bot,plugin,value,extra={}) {
  return bot.plugins.save({id:plugin.id,revision:plugin.revision,plugin:{...plugin,config:{...plugin.config,reply_probability:value,...extra}}});
}
const automaticAI={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001,10002'};
const finished=(bot,id)=>waitFor(()=>bot.store.get(id)?.status==='done');

test('100 percent converts a completed ordinary model reply once using the saved voice without requiring model tools',async t=>{
  const local=await service(t);let generations=0;
  const bot=await app(t,automaticAI,{ai:{reply:async()=>{generations++;return '晚上好 [[表情：开心]]';}}});
  const plugin=await install(bot,local.url);await probability(bot,plugin,1,{voice:'saved-fy',ai_tools:false});
  const sent=[];bot.adapter.on('outgoing',value=>sent.push(value));bot.adapter.driver.inject(incoming(91001,{message:'晚上好'}));await finished(bot,1);
  assert.equal(generations,1);assert.equal(local.speechCalls,1);assert.equal(local.calls[0].body.input,'晚上好');assert.equal(local.calls[0].body.voice,'saved-fy');
  assert.equal(sent.length,1);assert.equal(sent[0].message.length,1);assert.equal(replyBody(sent[0].message)[0].type,'record');assert.equal(bot.store.get(1).reply,'晚上好');
  await bot.voicestudio.maybeSpeakReply(bot.store.get(1),event(91001),'替换正文');assert.equal(local.speechCalls,1);
});

test('zero and fractional probabilities preserve ordinary text and use a strict per-reply threshold',async t=>{
  const local=await service(t),bot=await app(t,automaticAI,{ai:{reply:async()=> '普通文字回复'}});
  let plugin=await install(bot,local.url);const sent=[];bot.adapter.on('outgoing',value=>sent.push(value));
  bot.adapter.driver.inject(incoming(91002));await finished(bot,1);assert.equal(replyBody(sent[0].message)[0].type,'text');assert.equal(local.speechCalls,0);
  plugin=await probability(bot,plugin,.4);const rolls=[.399,.4];let randomCalls=0;bot.voicestudio.random=()=>{randomCalls++;return rolls.shift();};
  bot.adapter.driver.inject(incoming(91003));await finished(bot,2);bot.adapter.driver.inject(incoming(91004));await finished(bot,3);
  assert.deepEqual(sent.map(e=>replyBody(e.message)[0].type),['text','record','text']);assert.equal(randomCalls,2);assert.equal(local.speechCalls,1);
});

test('automatic speech obeys plugin scope, explicit text requests, length limits and the web channel',async t=>{
  const local=await service(t),bot=await app(t,automaticAI,{ai:{reply:async()=> '完整的模型文字回复'}});
  let plugin=await install(bot,local.url);plugin=await probability(bot,plugin,1);const sent=[];bot.adapter.on('outgoing',value=>sent.push(value));
  bot.adapter.driver.inject(incoming(91005,{sender:{user_id:10002}}));await finished(bot,1);
  bot.adapter.driver.inject(incoming(91006,{message:'请只用文字回复，不要发语音'}));await finished(bot,2);
  plugin=await probability(bot,plugin,1,{max_text_chars:3});bot.adapter.driver.inject(incoming(91007));await finished(bot,3);
  assert.equal(local.speechCalls,0);assert.equal(sent.length,3);assert.ok(sent.every(e=>replyBody(e.message)[0].type==='text'&&replyBody(e.message)[0].data.text==='完整的模型文字回复'));
  plugin=await probability(bot,plugin,1,{max_text_chars:1000});const web=await request(bot,'/admin/agent/chat',{text:'网页测试'});await finished(bot,web.data.job_id);assert.equal(local.speechCalls,0);assert.equal(sent.length,3);
  await bot.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:false});bot.adapter.driver.inject(incoming(91008));await finished(bot,5);assert.equal(local.speechCalls,0);
});

test('a failed automatic conversion delivers the complete original text without replacing it with a TTS error or retrying synthesis',async t=>{
  const local=await service(t,{status:503}),bot=await app(t,automaticAI,{ai:{reply:async()=> '模型的完整回答'}});
  const plugin=await install(bot,local.url);await probability(bot,plugin,1);const sent=[];bot.adapter.on('outgoing',e=>sent.push(e));
  bot.adapter.driver.inject(incoming(91009));await finished(bot,1);
  assert.equal(local.speechCalls,1);assert.equal(replyBody(sent[0].message)[0].type,'text');assert.equal(replyBody(sent[0].message)[0].data.text,'模型的完整回答');assert.equal(bot.store.get(1).reply,'模型的完整回答');
  assert.equal(bot.voicestudio.cachedReply(bot.store.get(1)),'模型的完整回答');
  await bot.voicestudio.maybeSpeakReply(bot.store.get(1),event(91009),'不要重复合成');assert.equal(local.speechCalls,1);
});

test('a missed probability decision and its original reply survive restart even after the probability changes',async t=>{
  const local=await service(t),cfg=config(await temp(t),automaticAI);let modelCalls=0,bot=await createApp(cfg,{log:()=>{},ai:{reply:async()=>{modelCalls++;return '不得重新生成';}}});
  cleanup(t,()=>bot.close());let plugin=await install(bot,local.url);plugin=await probability(bot,plugin,.4);bot.voicestudio.random=()=>.5;
  const e={...event(91010),message:[{type:'text',data:{text:'你好'}}]};const row=bot.store.ingest(e,'你好',100);bot.store.update(row.id,'generating');
  assert.equal(await bot.voicestudio.maybeSpeakReply(bot.store.get(row.id),e,'已生成的原始文字'),'已生成的原始文字');
  await probability(bot,plugin,1);await bot.close();bot=await createApp(cfg,{log:()=>{},ai:{reply:async()=>{modelCalls++;return '不得重新生成';}}});
  const sent=[];bot.adapter.on('outgoing',e=>sent.push(e));await finished(bot,row.id);
  assert.equal(modelCalls,0);assert.equal(local.speechCalls,0);assert.equal(replyBody(sent[0].message)[0].data.text,'已生成的原始文字');
});

test('shutdown during automatic synthesis recovers the original text and never submits TTS or QQ twice',async t=>{
  const local=await service(t,{delay:200}),cfg=config(await temp(t),automaticAI);let generations=0;
  const overrides={log:()=>{},ai:{reply:async()=>{generations++;return '中断后保留原文字';}}};let bot=await createApp(cfg,overrides);cleanup(t,()=>bot.close());
  const plugin=await install(bot,local.url);await probability(bot,plugin,1);let sends=0;bot.adapter.on('outgoing',()=>sends++);
  bot.adapter.driver.inject(incoming(91011));await waitFor(()=>local.speechCalls===1);await bot.close();
  bot=await createApp(cfg,overrides);bot.adapter.on('outgoing',()=>sends++);await finished(bot,1);
  assert.equal(generations,1);assert.equal(local.speechCalls,1);assert.equal(sends,1);assert.equal(bot.store.get(1).reply,'中断后保留原文字');
});

test('model can list voices then invoke speech and sends exactly one standalone QQ record', async t => {
  const local = await service(t);
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture-model', AI_ALLOWED_USERS: '10001', AI_BASE_URL: local.url });
  await install(bot, local.url);
  const sent = []; bot.adapter.on('outgoing', value => sent.push(value));
  bot.adapter.driver.inject(incoming(9001, { message: '晚上好' }));
  await waitFor(() => bot.store.list().some(row => row.status === 'done'));
  assert.equal(local.modelRequests.length, 2); assert.equal(local.speechCalls, 1); assert.equal(sent.length, 1);
  assert.ok(local.modelRequests[0].tools.some(t => t.function.name === 'voicestudio_list_voices'));
  assert.ok(local.modelRequests[0].tools.some(t => t.function.name === 'voicestudio_speak'));
  assert.equal(local.modelRequests[1].messages.at(-1).role, 'tool');
  assert.match(local.modelRequests[0].messages[0].content, /当前会话已启用本地 VoiceStudio/);
  assert.equal(local.calls[0].body.response_format, 'wav'); assert.equal(local.calls[0].body.voice, 'fixture-voice');
  assert.equal(local.calls[0].auth, 'Bearer fixture-api-key'); assert.equal(sent[0].message.length, 1); assert.equal(replyBody(sent[0].message)[0].type, 'record');
  const logs = JSON.stringify(bot.telemetry.read().entries.filter(row => row.kind === 'log'));
  assert.ok(!logs.includes('fixture-api-key')); assert.ok(!logs.includes('你好，这是语音测试'));
});

test('speech cache survives restart and does not synthesize again for a recovered generation', async t => {
  const local = await service(t), cfg = config(await temp(t)); let bot = await createApp(cfg, { log: () => {} }); cleanup(t, () => bot.close());
  await install(bot, local.url); const e = event(9002), result = bot.store.ingest(e, 'hello', 100);
  bot.store.update(result.id, 'generating');
  const options = bot.voicestudio.options(e, bot.store.get(result.id));
  assert.equal((await options.invokeTool('voicestudio_speak', { text: 'cached voice' })).finish, true);
  const original = await bot.voicestudio.messageForJob(bot.store.get(result.id), e);
  await bot.close(); bot = await createApp(cfg, { log: () => {} });
  const job = bot.store.get(result.id); assert.equal(bot.voicestudio.cachedReply(job), 'cached voice');
  assert.deepEqual(await bot.voicestudio.messageForJob(job, e), original); assert.equal(local.speechCalls, 1);
});

test('an explicit voice request uses one required tool despite stale refusals and emits one record', async t => {
  const local = await service(t, { requireForced: true });
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture-model', AI_ALLOWED_USERS: '10001', AI_BASE_URL: local.url });
  await install(bot, local.url);
  const insert = bot.store.db.prepare('INSERT INTO history(conversation,role,content,created_at) VALUES (?,?,?,?)');
  insert.run('10000:private:10001', 'user', '能调用语音吗', Date.now());
  insert.run('10000:private:10001', 'assistant', '没有语音功能。', Date.now());
  const sent = []; bot.adapter.on('outgoing', value => sent.push(value));
  bot.adapter.driver.inject(incoming(9010, { message: '请用语音说：你好' }));
  await waitFor(() => bot.store.list().some(row => row.status === 'done'));
  assert.equal(local.modelRequests.length, 1); assert.equal(local.speechCalls, 1); assert.equal(sent.length, 1);
  const first = local.modelRequests[0];
  assert.equal(first.tool_choice, 'required'); assert.equal(first.tools.length, 1);
  assert.equal(first.tools[0].function.name, 'voicestudio_speak');
  assert.ok(first.messages.some(m => m.role === 'assistant' && m.content === '没有语音功能。'), 'routing preserves stored context');
  assert.equal(first.messages.filter(m => m.role === 'system').length, 1, 'local Qwen requires a single initial system message');
  assert.equal(sent[0].message.length, 1); assert.equal(replyBody(sent[0].message)[0].type, 'record');
});

test('voice routing distinguishes speech requests, capability queries, ordinary chat, quotes and negative requests', async t => {
  for (const input of ['用语音说：晚上好', '请用语音回复我', '能不能用语音说你好', '帮我朗读这句话', '请发一条语音', 'please reply by voice']) assert.equal(voiceStudioIntent(input), 'voicestudio_speak', input);
  for (const input of ['能调用语音吗', '你能发语音吗', '可以用语音吗', 'voicestudio_list_voices用这个试试', '查一下有哪些音色', '你现在能调用哪些工具']) assert.equal(voiceStudioIntent(input), null, input);
  for (const input of ['你好', '不要用语音说话', '请别用语音回复', '不用朗读', '语音识别是什么', '帮我解释怎么用语音', '“用语音说你好”是什么意思', '`voicestudio_list_voices` 是什么', '别人让我用语音说你好']) assert.equal(voiceStudioIntent(input), null, input);
  const bot = await app(t), local = await service(t); await install(bot, local.url);
  const e = { ...event(9011), message: [{ type: 'text', data: { text: '能调用语音吗' } }] };
  assert.equal(bot.voicestudio.options(e, {}).requiredTool, undefined);
  assert.equal(bot.voicestudio.options({ ...e, user_id: 10002 }, {}).requiredTool, undefined);
  assert.equal(local.speechCalls, 0, 'capability detection never synthesizes on its own');
});

test('ignored required tools and unexpected function choices fail explicitly without invoking synthesis', async () => {
  const original = globalThis.fetch; let invoked = 0;
  const ai = new AIClient(config('unused').ai), tools = [{ type: 'function', function: { name: 'voice', parameters: { type: 'object' } } }];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '没有语音功能。' } }] }));
    await assert.rejects(ai.reply('test', [], undefined, { tools, requiredTool: 'voice', invokeTool: async () => { invoked++; } }), e => e.message === 'AI did not call the required tool');
    await assert.rejects(ai.reply('test', [], undefined, { tools, requiredTool: 'unknown', invokeTool: async () => { invoked++; } }));
    assert.equal(invoked, 0);
  } finally { globalThis.fetch = original; }
});

test('ordinary capability questions stay in AI chat without triggering native tool explanations or voice queries', async t => {
  const local = await service(t); let modelCalls = 0;
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'fixture', AI_ALLOWED_USERS: '10001' }, { ai: { reply: async () => { modelCalls++; return '正常聊天'; } } });
  await install(bot, local.url);
  let queries = 0; bot.voicestudio.voices = async () => { queries++; throw Error('Should not query'); };
  const sent = []; bot.adapter.on('outgoing', value => sent.push(value));
  bot.adapter.driver.inject(incoming(9012, { message: '能调用语音吗' }));
  await waitFor(() => sent.length === 1);
  assert.equal(replyBody(sent[0].message)[0].data.text, '正常聊天');
  assert.equal(modelCalls, 1); assert.equal(queries, 0); assert.equal(local.speechCalls, 0);
  await waitFor(() => bot.store.list()[0].status === 'done');
});

test('failed synthesis yields a safe text response and is never repeated for the same job', async t => {
  const local = await service(t, { status: 503 }), bot = await app(t); await install(bot, local.url);
  const e = event(9003), row = bot.store.ingest(e, 'test', 100); bot.store.update(row.id, 'generating');
  const tools = bot.voicestudio.options(e, bot.store.get(row.id));
  const outcome = await tools.invokeTool('voicestudio_speak', { text: 'sensitive text' });
  assert.match(outcome.reply, /HTTP 503/); assert.ok(!outcome.reply.includes('sensitive'));
  await tools.invokeTool('voicestudio_speak', { text: 'again' }); assert.equal(local.speechCalls, 1);
  assert.equal(await bot.voicestudio.messageForJob(bot.store.get(row.id), e), null);
});

test('invalid returned audio is rejected and cancellation while queued prevents a second synthesis', async t => {
  const invalid = await service(t, { invalid: true }), bot = await app(t);
  const plugin = await install(bot, invalid.url);
  await assert.rejects(bot.voicestudio.synthesize(plugin, { text: 'test' }), /不是可发送/);
  const slow = await service(t, { delay: 150 });
  const selected = { ...plugin, config: { ...plugin.config, base_url: slow.url } };
  const first = bot.voicestudio.synthesize(selected, { text: 'first' });
  await waitFor(() => slow.speechCalls === 1);
  const controller = new AbortController();
  const second = bot.voicestudio.synthesize(selected, { text: 'second' }, controller.signal); controller.abort();
  await assert.rejects(second, /取消|超时/); await first;
  assert.equal(slow.speechCalls, 1);
});

test('unknown tools, malformed JSON and excessive tool loops are bounded without executing arbitrary calls', async () => {
  const original = globalThis.fetch; let calls = 0;
  const cfg = config('unused').ai;
  const tool = { type: 'function', function: { name: 'safe', parameters: { type: 'object' } } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'unsafe', arguments: '{}' } }] } }] }));
    await assert.rejects(new AIClient(cfg).reply('test', [], undefined, { tools: [tool], invokeTool: async () => { calls++; } })); assert.equal(calls, 0);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'safe', arguments: '{}' } }] } }] }));
    await assert.rejects(new AIClient(cfg).reply('test', [], undefined, { tools: [tool], invokeTool: async () => { calls++; return { result: { ok: true } }; } })); assert.equal(calls, 4);
  } finally { globalThis.fetch = original; }
});

test('direct commands support standalone speech and scope controls protect model tools', async t => {
  const local = await service(t), bot = await app(t), plugin = await install(bot, local.url);
  const sent = []; bot.adapter.on('outgoing', value => sent.push(value));
  bot.adapter.driver.inject(incoming(9004, { message: '/vs_say 你好 voice' }));
  await waitFor(() => sent.length === 1); assert.equal(replyBody(sent[0].message)[0].type, 'record');
  assert.equal(bot.voicestudio.options({ ...event(9005), user_id: 10002 }, {}).tools, undefined);
  assert.equal(bot.voicestudio.prompt({ ...event(9005), user_id: 10002 }), '');
  await bot.plugins.toggle({ id: plugin.id, revision: plugin.revision, enabled: false });
  assert.equal(bot.voicestudio.options(event(9005), {}).tools, undefined);
  assert.equal(bot.voicestudio.prompt(event(9005)), '');
  assert.equal((await request(bot, '/admin/voicestudio/voices', undefined, 'onebot')).code, 401);
});

test('saved voice selection is used for omitted and default model arguments while explicit voice overrides remain available', async t => {
  const local = await service(t), bot = await app(t), original = await install(bot, local.url);
  const plugin = await bot.plugins.save({ id: original.id, revision: original.revision, plugin: { ...original, config: { ...original.config, voice: 'saved-fy' } } });
  for (const voice of [undefined, 'default', 'explicit-other']) await bot.voicestudio.synthesize(plugin, { text: 'test', voice });
  assert.deepEqual(local.calls.map(v => v.body.voice), ['saved-fy', 'saved-fy', 'explicit-other']);
  const manual = await bot.voicestudio.handle(plugin, { ...event(9020), message: [{ type: 'text', data: { text: '/vs_say 你好' } }] });
  assert.equal(manual.message[0].type, 'record'); assert.equal(local.calls.at(-1).body.voice, 'saved-fy');
  assert.match(bot.voicestudio.prompt(event(9021)), /saved-fy/);
});

test('draft saved-voice lookup filters before pagination, preserves plugin settings and protects admin and origin boundaries', async t => {
  const voices = [...Array.from({ length: 55 }, (_, i) => ({ voice_id: 'alias-' + i, name: 'Alias', type: 'openai_alias' })),
    { voice_id: 'saved-fy', name: 'fy', type: 'profile' }, { voice_id: 'saved-other', name: '另一个声音', type: 'profile' }];
  const local = await service(t, { voices }), bot = await app(t), plugin = await install(bot, local.url);
  const draft = { ...plugin.config, base_url: local.url + '/v1', voice: 'saved-fy', speed: .8 };
  assert.equal((await request(bot, '/admin/voicestudio/voices', { config: draft }, 'onebot')).code, 401);
  const result = await request(bot, '/admin/voicestudio/voices', { config: draft });
  assert.equal(result.code, 200); assert.equal(result.data.total, 2);
  assert.deepEqual(result.data.voices.map(v => v.voice_id), ['saved-fy', 'saved-other']);
  assert.equal(bot.plugins.get(plugin.id).revision, plugin.revision); assert.equal(bot.plugins.get(plugin.id).config.voice, 'default');
  assert.equal((await request(bot, '/admin/voicestudio/voices', { config: { base_url: 'file:///private' } })).code, 400);
  assert.equal((await request(bot, '/admin/voicestudio/voices', { config: [] })).code, 400);
  const page = await createLoginServer({ backend: 'http://127.0.0.1:' + bot.address.port, token: bot.config.adminToken }); cleanup(t, () => page.close());
  const post = origin => fetch(page.url + '/voicestudio/voices', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }) });
  assert.equal((await post('https://example.com')).status, 403);
  const proxied = await post(new URL(page.url).origin); assert.equal(proxied.status, 200); assert.equal((await proxied.json()).total, 2);
  assert.equal(local.speechCalls, 0);
});
