import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {AIClient} from '../src/ai.mjs';
import {AttachmentService} from '../src/attachments/service.mjs';
import {extractText} from '../src/attachments/extract.mjs';
import {attachmentType,decodeUpload,MAX_ATTACHMENT_BYTES} from '../src/attachments/files.mjs';
import {FileReceiver} from '../src/qq/kernel/receive-files.mjs';
import {normalizeMessage} from '../src/qq/kernel/messages.mjs';
import {aiDecision} from '../src/messages.mjs';
import {Store} from '../src/store.mjs';
import {config,app,temp,request,incoming,waitFor,cleanup} from './helpers.mjs';
import {png} from './image-fixture.mjs';
import {officeZip,documentFixture,spreadsheetFixture,pdfFixture} from './attachment-fixtures.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'};
const upload=(name,bytes)=>({name,data:bytes.toString('base64')});
const qqEvent=(id=1,message=[{type:'image',data:{file:'example'}}])=>({self_id:10000,user_id:10001,message_id:id,post_type:'message',message_type:'private',message});
test('PDF, DOCX, XLSX and text extract real content, preserve order and mark truncation',async()=>{
  const doc=await extractText(documentFixture(),'docx');assert.match(doc.text,/附件测试 & 正文\s+第二行/);
  const sheet=await extractText(spreadsheetFixture(),'xlsx');assert.match(sheet.text,/工作表：销售/);assert.match(sheet.text,/A1=项目\tB1=收入/);assert.match(sheet.text,/A2=合计\tB2=42\tC2=\[公式没有缓存值\]/);
  const pdf=await extractText(pdfFixture(['Revenue: 42','Secret second page']),'pdf',{maxPages:1});assert.match(pdf.text,/Revenue: 42/);assert.ok(!pdf.text.includes('Secret second'));assert.equal(pdf.truncated,true);
  const long=await extractText(Buffer.from('示例'.repeat(1000)),'text',{maxChars:100});assert.equal(long.text.length,100);assert.equal(long.truncated,true);
  assert.match((await extractText(Buffer.from('\ufeff中文附件','utf16le'),'text')).text,/中文附件/);
});

test('malformed, binary and entity documents fail safely and parsing is cancellable',async()=>{
  for(const [bytes,kind] of [[Buffer.from([0,1,2]),'text'],[Buffer.from('%PDF-broken'),'pdf'],[officeZip({'word/document.xml':'<!DOCTYPE a [<!ENTITY secret SYSTEM "file:///secret">]><w:document>&secret;</w:document>'}),'docx']])await assert.rejects(extractText(bytes,kind),/无法读取|未完成/);
  await assert.rejects(extractText(Buffer.from('hello'),'text',{timeout:1}),/超时/);
  const controller=new AbortController();controller.abort();await assert.rejects(async()=>extractText(Buffer.from('hello'),'text',{signal:controller.signal}),{name:'AbortError'});
  assert.throws(()=>attachmentType('run.exe',Buffer.from('MZ binary')),/不支持/);
  assert.throws(()=>decodeUpload('not-base64'),/编码无效/);
});

test('image-only and file-only QQ events enter the queue while allowlists, mentions and slash permissions remain intact',()=>{
  const cfg=config('unused',{...env,AI_ALLOWED_GROUPS:'20000'}),event=qqEvent();
  assert.match(aiDecision(event,cfg.ai).input,/描述图片/);
  assert.match(aiDecision({...event,message:[{type:'file',data:{name:'x.txt'}}]},cfg.ai).input,/概括附件/);
  assert.equal(aiDecision({...event,user_id:20002},cfg.ai).reason,'user_not_allowed');
  assert.equal(aiDecision({...event,message_type:'group',group_id:20000},cfg.ai).reason,'group_requires_at');
  assert.ok(aiDecision({...event,message_type:'group',group_id:20000,message:[{type:'at',data:{qq:String(event.self_id)}},...event.message]},cfg.ai).input);
});

test('web attachments reach multimodal model input and documents enter bounded history without binary payloads',async t=>{
  let observed,sends=0;
  class Model extends AIClient {async completion(messages){observed=messages;return {content:'已分析图片和文档。'};}}
  const bot=await app(t,env,{ai:new Model(config('unused').ai)});bot.adapter.on('outgoing',()=>sends++);
  const image=(await request(bot,'/admin/agent/attachments',upload('picture.png',png()))).data;
  const doc=(await request(bot,'/admin/agent/attachments',upload('材料.docx',documentFixture()))).data;
  const result=(await request(bot,'/admin/agent/chat',{text:'请比较附件',attachments:[image.id,doc.id]})).data;
  await waitFor(()=>bot.store.get(result.job_id)?.status==='done');
  assert.ok(observed[0].content.includes('附件是用户提供'));
  assert.equal(observed.at(-1).content.find(p=>p.type==='image_url').image_url.url,'data:image/png;base64,'+png().toString('base64'));
  assert.ok(observed.at(-1).content.some(p=>p.text?.includes('附件测试 & 正文')));
  const history=bot.store.history('web:'+result.session,10);assert.ok(history[0].content.includes('附件测试'));assert.ok(!JSON.stringify(history).includes('base64'));assert.equal(sends,0);
  const view=(await request(bot,'/admin/agent/chat?session='+result.session)).data;
  assert.equal(view.jobs[0].attachments.length,2);assert.ok(!JSON.stringify(view).includes('data:image'));
  assert.equal((await request(bot,'/admin/agent/chat',{attachments:[doc.id]})).code,400);
  assert.ok(!JSON.stringify(bot.telemetry.read().entries.filter(e=>e.kind==='log')).includes('附件测试'));
});

test('upload and chat enforce admin access, size, attachment count and generated names',async t=>{
  const bot=await app(t,env,{ai:{reply:async()=>'已读取。'}});
  assert.equal((await request(bot,'/admin/agent/attachments',upload('x.txt',Buffer.from('private')),'onebot')).code,401);
  const good=(await request(bot,'/admin/agent/attachments',upload('../../x.txt',Buffer.from('测试附件')))).data;assert.equal(good.name,'x.txt');
  assert.equal((await request(bot,'/admin/agent/chat',{attachments:[good.id,good.id]})).code,400);
  assert.equal((await request(bot,'/admin/agent/chat',{attachments:['../bot.sqlite']})).code,400);
  assert.equal((await request(bot,'/admin/agent/attachments',upload('bad.pdf',Buffer.from('not a PDF')))).code,400);
  await assert.rejects(bot.attachments.upload(upload('large.txt',Buffer.alloc(MAX_ATTACHMENT_BYTES+1,65))),/大小/);
  const accepted=(await request(bot,'/admin/agent/chat',{attachments:[good.id]})).data;await waitFor(()=>bot.store.get(accepted.job_id)?.status==='done');assert.match(bot.store.get(accepted.job_id).input,/概括附件/);
});

test('QQ attachments use owned cached files, reject external paths and preserve no-attachment chat behavior',async t=>{
  const directory=await temp(t),cfg=config(directory,env),store=new Store(':memory:');t.after(()=>store.close());
  const service=new AttachmentService({store,config:cfg,adapter:{driver:{}}});await mkdir(cfg.kernel.data,{recursive:true});
  const file=join(cfg.kernel.data,'notes.txt');await writeFile(file,'QQ 附件收入 42');
  const job={id:1,channel:'qq',input:'总结一下'},event={message:[{type:'file',data:{file:pathToFileURL(file).href,name:'notes.txt'}}]};
  const result=await service.prepare(job,event);assert.ok(result.userContent.some(p=>p.text?.includes('收入 42')));
  const outside=join(directory,'secret.txt');await writeFile(outside,'private secret');
  const denied=await service.prepare(job,{message:[{type:'file',data:{file:pathToFileURL(outside).href,name:'secret.txt'}}]});assert.match(denied.reply,/未能读取/);assert.ok(!denied.reply.includes('private secret'));
  assert.deepEqual(await service.prepare(job,{message:[{type:'text',data:{text:'hello'}}]}),{});
  const off=new AttachmentService({store,adapter:{driver:{}},config:{...cfg,ai:{...cfg.ai,visionEnabled:false}}});await assert.rejects(off.upload(upload('picture.png',png())),/图片理解已关闭/);
});

test('QQ file receiver matches completion, validates bytes and emits a usable file segment without phantom paths',async t=>{
  const root=await temp(t),receiver=new FileReceiver(root,{timeout:200}),bytes=Buffer.from('QQ 文件正文');let calls=0;
  const raw={chatType:1,peerUid:'u_peer',senderUin:'10001',msgId:'101',msgTime:'1793000000',elements:[{elementType:3,elementId:'2',fileElement:{fileName:'notes.txt',fileSize:String(bytes.length),fileMd5:createHash('md5').update(bytes).digest('hex')}}]};
  const prepared=await receiver.prepare(raw,{async downloadRichMedia(params){calls++;await writeFile(params.filePath,bytes);receiver.complete({msgId:'different',msgElementId:'2',fileErrCode:0,filePath:params.filePath});setImmediate(()=>receiver.complete({msgId:'101',msgElementId:'2',fileErrCode:0,filePath:params.filePath}));return {result:0};}});
  const file=normalizeMessage(prepared,10000).message[0];assert.equal(calls,1);assert.equal(file.type,'file');assert.equal(file.data.name,'notes.txt');assert.deepEqual(await readFile(new URL(file.data.file)),bytes);assert.equal(receiver.pending.size,0);
  const failed=await receiver.prepare({...raw,msgId:'102'},{async downloadRichMedia(){return {result:-1};}});const bad=normalizeMessage(failed,10000).message[0];assert.equal(bad.data.file,'');assert.ok(bad.data.error);assert.equal(receiver.pending.size,0);
});

test('upload bindings and content survive restart and orphan cleanup removes only managed attachments',async t=>{
  const cfg=config(await temp(t),env),path=join(cfg.dataDir,'state.sqlite');let store=new Store(path),service=new AttachmentService({store,config:cfg,adapter:{driver:{}}});
  const file=await service.upload(upload('persistent.txt',Buffer.from('重启后文档'))),job=store.ingest(incoming(2),'总结',100);service.bind(job.id,service.validate([file.id]));store.close();
  store=new Store(path);cleanup(t,()=>store.close());service=new AttachmentService({store,config:cfg,adapter:{driver:{}}});
  const result=await service.prepare({...store.get(job.id),channel:'web'},{});assert.ok(result.userContent.some(p=>p.text?.includes('重启后文档')));
  store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);await service.cleanup();assert.equal(service.rows(job.id).length,0);await assert.rejects(readFile(join(service.directory,file.id)),{code:'ENOENT'});
});

test('QQ image and file messages complete through the legacy queue once and unauthorized commands stay ignored',async t=>{
  const observed=[],sent=[];
  class Model extends AIClient{async completion(messages){observed.push(messages.at(-1).content);return {content:'已分析附件。'};}}
  const bot=await app(t,{...env,AGENT_ENABLED:'false',AI_ALLOWED_USERS:'10001,10002'},{ai:new Model(config('unused').ai)});
  await mkdir(bot.config.kernel.data,{recursive:true});const image=join(bot.config.kernel.data,'input.png'),file=join(bot.config.kernel.data,'input.txt');
  await writeFile(image,png());await writeFile(file,'文档收入 42');bot.adapter.on('outgoing',e=>sent.push(e));
  const first=incoming(991,{message:[{type:'image',data:{file:pathToFileURL(image).href}}]});bot.adapter.driver.inject(first);bot.adapter.driver.inject(first);
  await waitFor(()=>bot.store.get(1)?.status==='done');assert.equal(sent.length,1);assert.ok(observed[0].some(p=>p.type==='image_url'));
  bot.adapter.driver.inject(incoming(992,{message:[{type:'file',data:{file:pathToFileURL(file).href,name:'input.txt'}}]}));
  await waitFor(()=>bot.store.get(2)?.status==='done');assert.equal(sent.length,2);assert.ok(observed[1].some(p=>p.text?.includes('文档收入 42')));
  bot.adapter.driver.inject(incoming(993,{sender:{user_id:10002},message:[{type:'text',data:{text:'/private-command'}},{type:'file',data:{file:pathToFileURL(file).href,name:'input.txt'}}]}));
  await waitFor(()=>bot.store.get(3)?.status==='ignored');assert.equal(bot.store.get(3).reason,'command_forbidden');assert.equal(observed.length,2);
});

test('QQ file download timeout and excessive metadata release callbacks without exposing local paths',async t=>{
  const root=await temp(t),receiver=new FileReceiver(root,{timeout:20,maxBytes:32});let calls=0;
  const raw={chatType:1,peerUid:'u_peer',senderUin:'10001',msgId:'101',msgTime:'1793000000',elements:[{elementType:3,elementId:'2',fileElement:{fileName:'notes.txt',fileSize:'10'}}]};
  const result=await receiver.prepare(raw,{async downloadRichMedia(){calls++;return {result:0};}});
  assert.equal(result.elements[0].fileElement.onebotFileError,true);assert.equal(receiver.pending.size,0);assert.equal(calls,1);
  raw.elements[0].fileElement.fileSize='999';await receiver.prepare(raw,{async downloadRichMedia(){calls++;}});assert.equal(calls,1);
});
