import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient, describeAIFailure } from '../src/ai.mjs';
import { Store } from '../src/store.mjs';
import { ReplyWorker } from '../src/worker.mjs';
import { BotError } from '../src/errors.mjs';
import { replyMessage } from '../src/messages.mjs';
import { prepareKernelElements, validateKernelMessage } from '../src/qq/kernel/elements.mjs';
import { normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { config, withTestTimeout } from './helpers.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001',AI_GROUP_REQUIRE_AT:'false',AI_STREAM_CHUNK_CHARS:'40'};
const event=(id=1,group=false)=>({post_type:'message',message_type:group?'group':'private',message_id:id,self_id:10000,user_id:10001,...(group?{group_id:20001}:{}),message:'question'});
const frame=(delta,finish=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\r\n\r\n';
function response(text,{split=7,done=true}={}) {
  const bytes=Buffer.from(text+(done?'data: [DONE]\r\n\r\n':''));
  return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=split)controller.enqueue(bytes.subarray(i,i+split));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
}
function fixture(t,{group=false,ai,send,environment={}}={}) {
  const store=new Store(':memory:'),cfg=config('unused',{...env,...environment}),sent=[];
  t.after(()=>store.close());
  const worker=new ReplyWorker({store,config:cfg,ai:ai||new AIClient(cfg.ai),log:()=>{},
    adapter:{status:()=>({online:true}),action:async (name,params)=>{await send?.(name,params);sent.push(params.message);return {message_id:sent.length};}}});
  worker.ingest(event(1,group));return {store,cfg,sent,worker};
}
function fetchFixture(t,handler){const original=globalThis.fetch;globalThis.fetch=handler;t.after(()=>{globalThis.fetch=original;});}
const text=message=>message.filter(s=>s.type==='text'&&s.data.text!==' ').map(s=>s.data.text).join('');

test('SSE handles byte-split Chinese, CRLF, comments, usage and never publishes reasoning',async t=>{
  const deltas=[];let request;
  fetchFixture(t,async (_,options)=>{request=JSON.parse(options.body);return response(': keepalive\r\n\r\n'+frame({reasoning_content:'private thoughts'})+frame({content:'你好，😀'})+frame({content:'世界。'},'stop')+'data: '+JSON.stringify({choices:[],usage:{completion_tokens:12}})+'\r\n\r\n',{split:1});});
  const reply=await new AIClient(config('unused').ai).reply('question',[],undefined,{onDelta:(delta)=>deltas.push(delta)});
  assert.equal(request.stream,true);assert.equal(reply,'你好，😀世界。');assert.equal(deltas.join(''),reply);assert.ok(!JSON.stringify(deltas).includes('private'));
});

test('streamed tool argument fragments are assembled and validated before one execution',async t=>{
  let requests=0,tools=0;const deltas=[];
  fetchFixture(t,async()=>++requests===1?response(frame({tool_calls:[{index:0,id:'c1',function:{name:'lookup',arguments:'{"key":'}}]})+frame({tool_calls:[{index:0,function:{arguments:'"中文"}'}}]},'tool_calls')):response(frame({content:'查到了。'},'stop')));
  const reply=await new AIClient(config('unused').ai).reply('question',[],undefined,{tools:[{type:'function',function:{name:'lookup'}}],onDelta:d=>deltas.push(d),invokeTool:async(name,args)=>{assert.equal(name,'lookup');assert.deepEqual(args,{key:'中文'});tools++;return {result:{ok:true}};}});
  assert.equal(reply,'查到了。');assert.equal(tools,1);assert.equal(deltas.join(''),reply);
});

test('streamed reasoning-only length errors retain safe usage and bounded retry diagnostics',async t=>{
  fetchFixture(t,async()=>response(frame({reasoning:'secret'},'length')+'data: '+JSON.stringify({choices:[],usage:{completion_tokens:8,completion_tokens_details:{reasoning_tokens:8}}})+'\n\n'));
  await assert.rejects(new AIClient(config('unused').ai).reply('question',[]),error=>error.retryable&&describeAIFailure(error).reason==='ai_reasoning_only'&&describeAIFailure(error).reasoning_tokens===8);
});

test('QQ sends a quoted partial reply before the provider finishes, with mentions only in groups',async t=>{
  for(const group of [false,true]){
    let release;const held=new Promise(resolve=>{release=resolve;});let first;
    const firstSent=new Promise(resolve=>{first=resolve;});
    const a='第一段已经生成，可以先阅读这部分。'.repeat(4),b='最后一段内容。';
    const ai={async reply(_input,_history,_signal,options){await options.onDelta(a,a);await held;await options.onDelta(b,a+b);return a+b;}};
    const {worker,store,sent}=fixture(t,{group,ai,send:()=>first()});
    const pending=worker.step();await withTestTimeout(()=>firstSent);
    assert.equal(store.get(1).status,'generating');assert.ok(sent.length||store.db.prepare('SELECT count(*) AS n FROM reply_stream_parts').get().n);
    release();await pending;await worker.step();assert.equal(store.get(1).status,'done');
    assert.equal(sent.map(text).join(''),a+b);assert.ok(sent.length>1);
    for(const message of sent){assert.deepEqual(message[0],{type:'reply',data:{id:'1'}});assert.equal(message.some(s=>s.type==='at'),group);if(group)assert.equal(message.find(s=>s.type==='at').data.qq,'10001');}
    assert.equal(store.history(store.get(1).conversation,10).at(-1).content,a+b);
  }
});

test('reply formatting switches apply independently to every streamed chunk and the final tail',async t=>{
  for(const group of [false,true])for(const [mention,quote] of [[true,false],[false,true],[false,false]]){
    const a='这段内容会在生成完成前先发出去。'.repeat(5),b='最终补充。';
    const ai={async reply(_input,_history,_signal,options){await options.onDelta(a,a);return a+b;}};
    const {worker,store,sent}=fixture(t,{group,ai,environment:{REPLY_AT_SENDER:String(mention),REPLY_QUOTE_MESSAGE:String(quote)}});
    await worker.step();await worker.step();assert.equal(store.get(1).status,'done');assert.ok(sent.length>1);
    assert.equal(sent.map(text).join(''),a+b);
    for(const message of sent){assert.equal(message.some(s=>s.type==='at'),group&&mention);assert.equal(message.some(s=>s.type==='reply'),quote);}
  }
});

test('provider failure after confirmed chunks never retries or duplicates delivered text',async t=>{
  let generations=0;
  const ai={async reply(_input,_history,_signal,options){generations++;const body='已发送的段落。'.repeat(10);await options.onDelta(body,body);throw new BotError('fixture interruption',1500,{retryable:true});}};
  const {worker,store,sent}=fixture(t,{ai});await worker.step();const count=sent.length;await worker.step();
  assert.equal(store.get(1).status,'failed');assert.equal(store.get(1).reason,'stream_interrupted');assert.equal(generations,1);assert.equal(sent.length,count);assert.ok(count>0);
});

test('unknown chunk delivery is retained for manual review and is never resent',async t=>{
  const ai={async reply(_a,_b,_c,options){const body='不确定是否送达。'.repeat(10);await options.onDelta(body,body);return body;}};
  const {worker,store}=fixture(t,{ai,send:()=>{throw new BotError('unknown',1502,{uncertain:true});}});await worker.step();await worker.step();
  assert.equal(store.get(1).status,'uncertain');assert.equal(store.get(1).reason,'stream_delivery_unknown');
  assert.equal(store.db.prepare('SELECT status FROM reply_stream_parts').get().status,'uncertain');
});

test('recovery does not regenerate a partial QQ reply and preserves unsent generations for retry',t=>{
  const {store}=fixture(t);store.update(1,'generating',{reply:'partial'});store.recover();assert.equal(store.get(1).status,'queued');
  store.update(1,'generating');const part=store.beginStreamPart(1,'partial');store.recover();assert.equal(store.get(1).status,'uncertain');
  store.endStreamPart(1,part,'sent',123);store.update(1,'generating');store.recover();assert.equal(store.get(1).status,'failed');
});

test('reply receipts let a resumed ready job send only the unsent tail once',async t=>{
  const {worker,store,sent}=fixture(t);const part=store.beginStreamPart(1,'前半段。');store.endStreamPart(1,part,'sent',10);store.update(1,'ready',{reply:'前半段。后半段。'});
  await worker.step();assert.equal(sent.length,1);assert.equal(text(sent[0]),'后半段。');assert.equal(store.get(1).status,'done');
});

test('meme markers are held across deltas and clean streamed prefixes survive media planning',async t=>{
  const body='完整的普通正文。'.repeat(10),marker='[[表情:开心]]';
  const ai={async reply(_a,_b,_c,options){await options.onDelta(body+'[',body+'[');await options.onDelta(marker.slice(1),body+marker);return body+marker;}};
  const {worker,store,sent}=fixture(t,{ai});worker.memes={prompt:()=>'',planReply:reply=>reply.replace(marker,''),messageForJob:job=>[{type:'text',data:{text:job.reply}},{type:'image',data:{file:'fixture'}}],sent:()=>{}};
  await worker.step();await worker.step();assert.equal(store.get(1).status,'done');assert.equal(sent.map(text).join(''),body);assert.ok(!JSON.stringify(sent).includes('[[表情'));assert.ok(sent.at(-1).some(s=>s.type==='image'));
});

test('stream cancellation, missing terminal frames, invalid frames and size limits fail safely',async t=>{
  for(const [result,reason] of [[()=>response(frame({content:'partial'}),{done:false}),'ai_response_interrupted'],[()=>response('data: invalid\n\n'),'ai_invalid_stream'],[()=>response('data: '+JSON.stringify({error:{message:'private'}})+'\n\n'),'ai_stream_error'],[()=>response('data: '+JSON.stringify({padding:'x'.repeat(2*1024*1024)})+'\n\n',{split:65536}),'ai_response_too_large']]){
    fetchFixture(t,async()=>result());await assert.rejects(new AIClient(config('unused').ai).reply('question',[]),error=>describeAIFailure(error).reason===reason&&!error.message.includes('private'));
  }
  fetchFixture(t,async(_,options)=>new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from(frame({content:'partial'})));options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}}));
  const controller=new AbortController(),pending=new AIClient(config('unused').ai).reply('question',[],controller.signal);setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,error=>describeAIFailure(error).reason==='ai_cancelled'&&!error.retryable);
});

test('kernel produces native reply and mention elements and preserves the source IDs',async()=>{
  const source={msgId:'987654321098765432',msgSeq:'42',clientSeq:'8',senderUin:'10001'};
  const message=replyMessage(event(22,true),[{type:'text',data:{text:'回答。'}}]);validateKernelMessage(message);
  const prepared=await prepareKernelElements(message,null,undefined,null,null,{kind:'group',reply:source,resolveMention:async qq=>({uid:'u_contact',nickname:'发送者'})});
  assert.equal(prepared.elements[0].elementType,7);assert.equal(prepared.elements[0].replyElement.replayMsgId,source.msgId);assert.equal(prepared.elements[0].replyElement.replayMsgSeq,'42');
  assert.equal(prepared.elements[1].textElement.atNtUid,'u_contact');assert.equal(prepared.elements[1].textElement.atType,2);
  const normalized=normalizeMessage({chatType:2,peerUid:'20001',senderUin:'10000',msgId:'999',msgTime:'1700000000',elements:prepared.elements},10000,()=>10001,undefined,()=>22);
  assert.deepEqual(normalized.message[0],{type:'reply',data:{id:'22'}});assert.equal(normalized.message.find(s=>s.type==='at').data.qq,'10001');
  await assert.rejects(prepareKernelElements([{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'hello'}}],null,undefined,null,null,{kind:'private'}),error=>error.code===1400);
});

test('streaming is configurable and JSON-only compatible services still return normal replies',async t=>{
  let request;fetchFixture(t,async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'完整回复。'}}]}));});
  const ai=new AIClient(config('unused',{AI_STREAM_ENABLED:'false'}).ai);assert.equal(await ai.reply('question',[]),'完整回复。');assert.equal(request.stream,false);
  assert.throws(()=>config('unused',{AI_STREAM_CHUNK_CHARS:'0'}),/AI_STREAM_CHUNK_CHARS/);
});
