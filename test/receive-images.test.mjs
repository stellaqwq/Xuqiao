import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ImageReceiver } from '../src/qq/kernel/receive-images.mjs';
import { ImageDelivery } from '../src/qq/image-delivery.mjs';
import { normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { app, config, temp, request, wsClient } from './helpers.mjs';
import { png } from './image-fixture.mjs';

function raw(sourcePath='') {
  return {chatType:1,peerUid:'u_target',senderUin:'10001',msgId:'123456789',msgTime:'1792910000',
    elements:[{elementType:2,elementId:'77',picElement:{sourcePath,md5HexStr:createHash('md5').update(png()).digest('hex'),fileSize:String(png().length)}}]};
}

test('received SDK path is downloaded before image metadata is published',async t=>{
  const directory=await temp(t),receiver=new ImageReceiver(directory,{timeout:500});let calls=0,download;
  const service={async downloadRichMedia(params){
    calls++;download=params;assert.equal(params.downloadType,1);assert.equal(params.elementId,'77');
    await writeFile(params.filePath,png());
    receiver.complete({msgId:'different',msgElementId:'77',fileErrCode:0,filePath:params.filePath});
    setImmediate(()=>receiver.complete({msgId:params.msgId,msgElementId:params.elementId,fileErrCode:0,filePath:params.filePath}));
    return {result:0};
  }};
  const result=await receiver.prepare(raw(join(directory,'not-downloaded.png')),service);
  const file=result.elements[0].picElement.onebotImageFile;
  assert.equal(calls,1);assert.match(file,/^[a-f0-9]{32}\.png$/);
  assert.deepEqual(await readFile(join(directory,'media-inbox',file)),png());
  assert.equal(receiver.pending.size,0);assert.equal(receiver.cache.active.size,0);
  assert.deepEqual(await readFile(download.filePath),png());
});

test('already downloaded images are validated and missing/failed downloads never emit phantom paths',async t=>{
  const directory=await temp(t),source=join(directory,'available.png');await writeFile(source,png());
  const receiver=new ImageReceiver(directory,{timeout:500});
  const ready=await receiver.prepare(raw(source),{});assert.ok(ready.elements[0].picElement.onebotImageFile);
  const failed=await receiver.prepare(raw(),{downloadRichMedia:async()=>({result:-1})});
  const normalized=normalizeMessage(failed,10000);
  assert.equal(normalized.message[0].type,'text');assert.ok(!JSON.stringify(normalized).includes('file:'));
  assert.equal(receiver.pending.size,0);
});

test('SDK image re-encoding cannot cause a false checksum rejection; cache hash describes actual bytes',async t=>{
  const receiver=new ImageReceiver(await temp(t),{timeout:500}),input=raw();
  input.elements[0].picElement.md5HexStr='f'.repeat(32);
  const result=await receiver.prepare(input,{async downloadRichMedia(params){
    await writeFile(params.filePath,png());
    receiver.complete({msgId:params.msgId,msgElementId:params.elementId,fileErrCode:0,filePath:params.filePath});
    return {result:0};
  }});
  assert.equal(result.elements[0].picElement.onebotImageFile,createHash('md5').update(png()).digest('hex')+'.png');
  assert.equal(receiver.pending.size,0);
});

test('receive download timeout cancels pending callbacks and releases the queue',async t=>{
  const receiver=new ImageReceiver(await temp(t),{timeout:25});
  const input=raw();input.elements.push({elementType:1,textElement:{content:'caption'}});
  const result=await receiver.prepare(input,{downloadRichMedia:async()=>({result:0})});
  const message=normalizeMessage(result,10000).message;
  assert.equal(message[0].type,'text');assert.equal(message[1].data.text,'caption');
  assert.equal(receiver.pending.size,0);
});

test('AstrBot image event supplies a fetchable URL and get_image uses the same validated bytes',async t=>{
  const directory=await temp(t),cfg=config(directory,{QQ_ACCOUNT:'10000'});
  const receiver=new ImageReceiver(cfg.kernel.data,cfg.media);await mkdir(cfg.kernel.data,{recursive:true});
  const source=join(cfg.kernel.data,'received.png');await writeFile(source,png());
  class ImageDriver extends QQDriver {
    constructor(){super({account:10000});this.images=new ImageDelivery(cfg,()=>this.account);}
    get mode(){return 'kernel';}async connect(){this.online=true;}
    async invoke(command,params){if(command==='image.get')return this.images.info(params.file);throw Error('unexpected action');}
  }
  const driver=new ImageDriver(),bot=await app(t,{}, {driver}),client=await wsClient(t,bot);
  const prepared=await receiver.prepare(raw(source),{});
  driver.emit('message',{...normalizeMessage(prepared,10000,()=>0,file=>driver.images.describe(file)),id:90});
  const event=await client.receive(e=>e.message_id===90),segment=event.message[0];
  assert.equal(segment.type,'image');assert.ok(!segment.data.file.startsWith('file:'));
  assert.ok(!segment.data.url.includes(cfg.token));assert.ok(!segment.data.url.includes(cfg.adminToken));
  const image=await fetch(segment.data.url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),png());
  const info=await request(bot,'/get_image',{file:segment.data.file});assert.equal(info.data.retcode,0);assert.equal(info.data.data.size,png().length);assert.equal(info.data.data.url,segment.data.url);
  assert.equal((await fetch(segment.data.url.replace(/key=.*/,'key='+'0'.repeat(64)))).status,404);
  const url=new URL(segment.data.url);url.search='';assert.equal((await fetch(url)).status,404);
  assert.equal((await request(bot,'/get_image',{file:'../bot.sqlite'})).data.retcode,1404);
  const file=join(cfg.kernel.data,'media-inbox',segment.data.file),past=new Date(Date.now()-9*86400000);await utimes(file,past,past);
  receiver.cache.lastCleanup=0;await receiver.cache.cleanup();assert.equal((await fetch(segment.data.url)).status,404);
});

test('media URL configuration accepts reachable origins but rejects credentials and URL injection',async t=>{
  const directory=await temp(t);
  assert.equal(config(directory,{MEDIA_BASE_URL:'http://192.0.2.10:5700/'}).media.baseUrl,'http://192.0.2.10:5700');
  for(const value of ['file:///D:/','http://user:secret@localhost/','http://localhost/prefix','http://localhost/?access_token=abc'])
    assert.throws(()=>config(directory,{MEDIA_BASE_URL:value}));
});
