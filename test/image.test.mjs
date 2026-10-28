import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { imageInfo, readImage, ImageCache } from '../src/qq/kernel/image.mjs';
import { prepareKernelElements } from '../src/qq/kernel/elements.mjs';
import { SendTracker, normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { sendKernelMessage } from '../src/qq/kernel/send.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { loadConfig } from '../src/config.mjs';
import { app, config, temp, cleanup, request, waitFor, wsClient } from './helpers.mjs';
import { png, gif, pngWithComment } from './image-fixture.mjs';

test('image inputs preserve PNG/GIF bytes from base64, data URLs, local paths and file URLs',async t=>{
  const bytes=png(),path=join(await temp(t),'image with spaces.png');await writeFile(path,bytes);
  for(const source of [path,pathToFileURL(path).href,'base64://'+bytes.toString('base64'),'data:image/png;base64,'+bytes.toString('base64')]){
    const image=await readImage(source);assert.deepEqual(image.bytes,bytes);assert.equal(image.width,32);assert.equal(image.height,24);assert.equal(image.format,'png');
  }
  const image=await readImage('base64://'+gif.toString('base64'));assert.equal(image.format,'gif');assert.deepEqual(image.bytes,gif);
});
test('image dimensions reject truncated/oversized files and parse bounded JPEG and WebP headers',()=>{
  assert.throws(()=>imageInfo(Buffer.from('not an image')),/unsupported image/);
  const giant=png();giant.writeUInt32BE(50000,16);assert.throws(()=>imageInfo(giant),/unsupported image/);
  const jpeg=Buffer.from([255,216,255,192,0,11,8,0,12,0,16,1,1,17,0,255,217]);
  assert.deepEqual(imageInfo(jpeg),{format:'jpg',width:16,height:12});
  const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBPVP8X',8);webp.writeUInt32LE(10,16);webp.writeUIntLE(15,24,3);webp.writeUIntLE(11,27,3);
  assert.deepEqual(imageInfo(webp),{format:'webp',width:16,height:12});assert.throws(()=>imageInfo(webp.subarray(0,29)),/unsupported image/);
});
test('image validation rejects malformed base64, missing host files, credentials and excessive byte sizes',async t=>{
  await assert.rejects(readImage('base64://not!base64'),/Invalid base64/);
  await assert.rejects(readImage('base64://'+png().toString('base64'),{maxBytes:8}),/too large|exceeds/);
  await assert.rejects(readImage('file://remote-host/share.png'),/Network file/);
  await assert.rejects(readImage('http://user:password@127.0.0.1/x'),/without credentials/);
  await assert.rejects(readImage(join(await temp(t),'missing.png')),/enable base64/);
  const text=join(await temp(t),'.env');await writeFile(text,'not an image');await assert.rejects(readImage(text),/unsupported image/);
});
test('URL downloads follow bounded redirects, cap chunked responses and obey cancellation',async t=>{
  const bytes=png();
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/image'});res.end();}
    else if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();}
    else if(req.url==='/large'){res.write(bytes);res.end(bytes);}
    else if(req.url==='/slow'){res.writeHead(200);res.write(bytes.subarray(0,8));}
    else{res.writeHead(200,{'Content-Type':'image/png'});res.end(bytes);}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));cleanup(t,()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual((await readImage(base+'/redirect')).bytes,bytes);
  await assert.rejects(readImage(base+'/loop'),/redirects/);
  await assert.rejects(readImage(base+'/large',{maxBytes:bytes.length+1}),/exceeds/);
  const controller=new AbortController(),pending=readImage(base+'/slow',{signal:controller.signal});setTimeout(()=>controller.abort(),20);await assert.rejects(pending,/abort/i);
});
test('media cache deduplicates concurrent writes, holds active images and cleans only expired owned files',async t=>{
  const cache=new ImageCache(await temp(t),{retentionDays:1}),source='base64://'+png().toString('base64');
  const images=await Promise.all(Array.from({length:5},()=>cache.acquire(source)));
  assert.equal(new Set(images.map(i=>i.path)).size,1);assert.equal(cache.active.get(images[0].path),5);
  const old=new Date(Date.now()-3*86400000);await utimes(images[0].path,old,old);await cache.cleanup();await stat(images[0].path);
  images.forEach(i=>i.release());assert.equal(cache.active.size,0);
  cache.lastCleanup=0;await cache.cleanup();await assert.rejects(stat(images[0].path),{code:'ENOENT'});
});
test('SDK media staging uses its managed directory and refuses paths outside kernel data',async t=>{
  const directory=await temp(t),cache=new ImageCache(join(directory,'media-outbox'));
  const image=await cache.acquire('base64://'+png().toString('base64'));
  const destination=join(directory,'sdk-pictures',image.md5+'.png');let query;
  const service={getRichMediaFilePathForGuild(params){query=params;return destination;}};
  assert.deepEqual(await Promise.all([cache.stage(image,service),cache.stage(image,service)]),[destination,destination]);
  assert.deepEqual(await readFile(destination),image.bytes);
  assert.equal(query.needCreate,true);assert.equal(query.elementType,2);assert.equal(query.md5HexStr,image.md5);
  await Promise.all([cache.stage(image,service),cache.stage(image,service)]);
  await assert.rejects(cache.stage(image,{getRichMediaFilePathForGuild:()=>join(directory,'..','outside.png')}),error=>error.code===1501);
  await assert.rejects(cache.stage(image,{getRichMediaFilePathForGuild:()=>''}),error=>error.code===1501);
  image.release();
});

test('mixed messages preserve ordering and reject unsupported segments before any file access',async t=>{
  const cache=new ImageCache(await temp(t));
  const prepared=await prepareKernelElements([{type:'text',data:{text:'before'}},{type:'image',data:{file:'base64://'+gif.toString('base64'),summary:'test sticker'}},{type:'text',data:{text:'after'}}],cache);
  assert.deepEqual(prepared.elements.map(e=>e.elementType),[1,2,1]);const pic=prepared.elements[1].picElement;assert.equal(pic.picType,2000);assert.equal(pic.picSubType,1);assert.equal(pic.fileSize,String(gif.length));assert.equal(pic.md5HexStr,createHash('md5').update(gif).digest('hex'));assert.deepEqual(await readFile(pic.sourcePath),gif);prepared.release();
  await assert.rejects(prepareKernelElements([{type:'image',data:{file:'file:///missing.png'}},{type:'record',data:{file:'x'}}],cache),error=>error.code===1400);
});
test('SDK image submission keeps cache leased until matching terminal acknowledgement and does not fabricate delivery',async t=>{
  const directory=await temp(t),destination=join(directory,'sdk-pictures','confirmed.png');
  const cache=new ImageCache(join(directory,'media-outbox')),tracker=new SendTracker(500);cleanup(t,()=>tracker.close());let call;
  const service={getRichMediaFilePathForGuild:()=>destination,generateMsgUniqueId:()=> '123456789',async sendMsg(id,peer,elements){call={id,peer,elements};return {result:0};}};
  const pending=sendKernelMessage({session:{},msgService:service,self:{uin:'10000',uid:'u_self'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,imageCache:cache,mediaTimeout:500},{kind:'private',target:10001,message:[{type:'image',data:{file:'base64://'+png().toString('base64')}}]});
  let done=false;pending.then(()=>{done=true;});await waitFor(()=>call);assert.equal(done,false);assert.equal(cache.active.size,1);
  assert.equal(call.elements[0].picElement.sourcePath,destination);assert.deepEqual(await readFile(destination),png());
  tracker.update({...call.peer,msgId:call.id,sendStatus:2,elements:call.elements});const result=await pending;assert.equal(result.raw.msgId,call.id);assert.equal(cache.active.size,0);
  const received=normalizeMessage(result.raw,10000);assert.equal(received.message[0].type,'image');assert.ok(received.message[0].data.file.startsWith('file:'));
});
test('missing image acknowledgement remains uncertain and releases leases without resending',async t=>{
  const cache=new ImageCache(await temp(t)),tracker=new SendTracker(25);let calls=0;
  await assert.rejects(sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=> '88',sendMsg:async()=>{calls++;return {result:0};}},self:{uin:'10000',uid:'u_self'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,imageCache:cache},{kind:'private',target:10001,message:[{type:'image',data:{file:'base64://'+png().toString('base64')}}]}),error=>error.uncertain===true);
  assert.equal(calls,1);assert.equal(cache.active.size,0);assert.equal(tracker.pending.size,0);
});

test('missing native submission result stays uncertain and is never retried',async t=>{
  const tracker=new SendTracker(25);let calls=0;
  await assert.rejects(sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=> '89',sendMsg:async()=>{calls++;}},self:{uin:'10000'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker},{kind:'private',target:10001,message:[{type:'text',data:{text:'test'}}]}),error=>error.code===1502&&error.uncertain===true);
  assert.equal(calls,1);assert.equal(tracker.pending.size,0);
});
test('OneBot WebSocket accepts AstrBot-style image payloads larger than the old 1 MiB limit and preserves echo',async t=>{
  const directory=await temp(t),cache=new ImageCache(directory),tracker=new SendTracker(500);cleanup(t,()=>tracker.close());let count=0;
  class ImageDriver extends QQDriver {
    get mode(){return 'kernel';}get capabilities(){return ['message.send','media.image'];}async connect(){this.online=true;}
    async invoke(command,params){if(command==='message.send'){
      const result=await sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=>String(++count),sendMsg:async(id,peer,elements)=>{setImmediate(()=>tracker.update({...peer,msgId:id,sendStatus:2,elements}));return {result:0};}},self:{uin:'10000',uid:'u_self'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,imageCache:cache},params);
      return {message_id:Number(result.raw.msgId)};
    }throw Error('unsupported test action');}
  }
  const driver=new ImageDriver({account:10000}),bot=await app(t,{}, {driver});
  assert.equal((await request(bot,'/can_send_image')).data.data.yes,true);
  const large=pngWithComment(png(),850000);
  const client=await wsClient(t,bot,'/api');const frame={action:'send_private_msg',params:{user_id:10001,message:[{type:'image',data:{file:'base64://'+large.toString('base64')}}]},echo:{seq:5}};
  assert.ok(Buffer.byteLength(JSON.stringify(frame))>1024*1024);client.ws.send(JSON.stringify(frame));
  const response=await client.receive(message=>message.echo?.seq===5);assert.equal(response.retcode,0);assert.equal(response.data.message_id,1);
  assert.ok(!JSON.stringify(bot.telemetry.read()).includes(large.toString('base64').slice(0,100)));
});
test('new media settings reject invalid limits and admin telemetry never retains base64 payloads',async t=>{
  const c=config(await temp(t));
  for(const env of [{MEDIA_MAX_BYTES:'0'},{MEDIA_TIMEOUT_MS:'999'},{MEDIA_CACHE_DAYS:'0'},{ONEBOT_MAX_REQUEST_BYTES:'1'}])assert.throws(()=>loadConfig({...Object.fromEntries([['ONEBOT_ACCESS_TOKEN',c.token],['ADMIN_ACCESS_TOKEN',c.adminToken],['SESSION_KEY',c.sessionKey]]),...env}));
  const telemetry=new Telemetry(),source='base64://'+png().toString('base64');telemetry.message({post_type:'message_sent',message_id:1,message:[{type:'image',data:{file:source}}],raw_message:source});assert.ok(!JSON.stringify(telemetry.read()).includes(source));
});
