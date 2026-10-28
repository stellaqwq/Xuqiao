import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile,writeFile,mkdir,stat,utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decode } from 'silk-wasm';
import { readAudio,encodeAudio,VoiceCache } from '../src/qq/kernel/audio.mjs';
import { wavToPCM,silkInfo } from '../src/qq/kernel/audio-codec.mjs';
import { prepareKernelElements,validateKernelMessage } from '../src/qq/kernel/elements.mjs';
import { sendKernelMessage } from '../src/qq/kernel/send.mjs';
import { SendTracker,normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { KernelDriver } from '../src/qq/kernel-driver.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { app,temp,cleanup,request,wsClient } from './helpers.mjs';
import { wav } from './audio-fixture.mjs';

const record=source=>[{type:'record',data:{file:source}}];

test('PCM and float WAVs downmix and resample to bounded 24 kHz mono PCM',()=>{
  for(const options of [{},{rate:44100,channels:2},{rate:48000,channels:2,bits:32,float:true},{bits:8},{bits:24},{bits:32},{bits:64,float:true}]){
    const result=wavToPCM(wav(options));assert.equal(result.pcm.length,5760);
    assert.equal(result.waveAmplitudes.length,32);assert.ok(result.waveAmplitudes.some(n=>n>0));
  }
  const tiny=wavToPCM(wav({seconds:.001}));assert.equal(tiny.pcm.length,960);
});

test('malformed WAV headers, unsupported codecs, NaN samples and excessive duration fail before encoding',()=>{
  const truncated=wav().subarray(0,100),compressed=wav(),wrongAlign=wav(),nan=wav({bits:32,float:true});
  compressed.writeUInt16LE(6,20);wrongAlign.writeUInt16LE(99,32);nan.writeFloatLE(NaN,44);
  for(const bytes of [Buffer.from('not audio'),truncated,compressed,wrongAlign,nan])assert.throws(()=>wavToPCM(bytes),e=>e.code===1400);
  assert.throws(()=>wavToPCM(wav(),.01),e=>e.code===1400);
});

test('real WASM encoding creates decodable Tencent SILK with truthful duration',async()=>{
  const voice=await encodeAudio(wav());assert.equal(voice.bytes[0],2);assert.equal(voice.durationMs,120);assert.equal(voice.duration,1);
  assert.deepEqual(silkInfo(voice.bytes),{durationMs:120,duration:1});
  const decoded=await decode(voice.bytes,24000);assert.ok(decoded.duration>=120&&decoded.duration<=180);assert.ok(decoded.data.length>0);
  assert.deepEqual((await encodeAudio(voice.bytes)).bytes,voice.bytes);
  assert.deepEqual((await encodeAudio(voice.bytes.subarray(1))).bytes,voice.bytes);
  assert.throws(()=>silkInfo(voice.bytes.subarray(0,voice.bytes.length-1)),e=>e.code===1400);
  assert.throws(()=>silkInfo(voice.bytes,.02),e=>e.code===1400);
});

test('voice input supports paths, file URLs, data URLs and GPT-SoVITS URL-safe base64',async t=>{
  const bytes=wav(),path=join(await temp(t),'语音.wav');await writeFile(path,bytes);
  for(const source of [path,pathToFileURL(path).href,'base64://'+bytes.toString('base64'),'base64://'+bytes.toString('base64url'),'data:audio/wav;base64,'+bytes.toString('base64')])assert.deepEqual(await readAudio(source),bytes);
  for(const source of ['relative.wav','file://remote/audio.wav','base64://%%%','base64://A','data:image/png;base64,AAAA'])await assert.rejects(readAudio(source),e=>e.code===1400);
  await assert.rejects(readAudio(path,{maxBytes:10}),e=>e.code===1400);
  await assert.rejects(readAudio(path+'-missing'),/not found/);
});

test('HTTP audio follows bounded redirects, rejects excess bodies and obeys cancellation',async t=>{
  const bytes=wav(),server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/wave'});res.end();}
    else if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();}
    else if(req.url==='/slow')res.writeHead(200);
    else{res.setHeader('Content-Type','audio/wav');res.end(bytes);}
  });server.listen(0,'127.0.0.1');await once(server,'listening');cleanup(t,()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual(await readAudio(base+'/redirect'),bytes);
  await assert.rejects(readAudio(base+'/loop'),/redirects/);
  await assert.rejects(readAudio(base+'/wave',{maxBytes:10}),e=>e.code===1400);
  await assert.rejects(readAudio(base+'/slow',{signal:AbortSignal.timeout(25)}));
  await assert.rejects(readAudio('http://user:password@127.0.0.1/voice'),e=>e.code===1400);
});

test('cancelling an encoder terminates its worker without caching or submitting audio',async()=>{
  const controller=new AbortController();const pending=encodeAudio(wav({seconds:1}),controller.signal);controller.abort();
  await assert.rejects(pending,e=>e.code===1502&&!e.uncertain);
});

test('normalizing a SILK header cannot bypass the configured output byte limit',async t=>{
  const encoded=await encodeAudio(wav()),raw=encoded.bytes.subarray(1);
  const cache=new VoiceCache(join(await temp(t),'media-voice'),{maxBytes:raw.length});
  await assert.rejects(cache.acquire('base64://'+raw.toString('base64')),e=>e.code===1400);
  assert.equal(cache.active.size,0);
});

test('voice cache stages element type 4 inside QQ data and retains leased files during cleanup',async t=>{
  const root=await temp(t),directory=join(root,'media-voice'),cache=new VoiceCache(directory,{retentionDays:1});
  const voice=await cache.acquire('base64://'+wav().toString('base64'));
  const destination=join(root,'accounts','ptt',voice.md5+'.silk');
  const path=await cache.stage(voice,{getRichMediaFilePathForGuild:async options=>{assert.equal(options.elementType,4);return destination;}});
  assert.equal(path,destination);assert.deepEqual(await readFile(path),voice.bytes);
  await assert.rejects(cache.stage(voice,{getRichMediaFilePathForGuild:async()=>join(root,'..','external.silk')}),e=>e.code===1501);
  const old=new Date(Date.now()-3*86400000);await utimes(voice.path,old,old);cache.lastCleanup=0;await cache.cleanup();await stat(voice.path);
  voice.release();cache.lastCleanup=0;await cache.cleanup();await assert.rejects(stat(voice.path),{code:'ENOENT'});
});

test('voice records must be sent alone and invalid combinations do not read files',async()=>{
  for(const message of [[...record('missing'),{type:'text',data:{text:'mixed'}}],[...record('one'),...record('two')]])assert.throws(()=>validateKernelMessage(message),e=>e.code===1400);
  await assert.rejects(prepareKernelElements(record('missing'),null),/voice cache/);
});

test('SDK voice submission holds the cache until a matching terminal acknowledgement',async t=>{
  const cache=new VoiceCache(join(await temp(t),'media-voice')),tracker=new SendTracker(1000);cleanup(t,()=>tracker.close());let calls=0;
  const service={generateMsgUniqueId:()=> '88',sendMsg:async(id,peer,elements)=>{
    calls++;const voice=elements[0].pttElement;assert.equal(elements[0].elementType,4);assert.equal(voice.formatType,1);assert.equal(voice.voiceType,1);assert.ok(cache.active.size);assert.equal(voice.duration,1);
    setImmediate(()=>tracker.update({...peer,msgId:id,sendStatus:2,elements}));return {result:0};
  }};
  const result=await sendKernelMessage({session:{},msgService:service,self:{uin:'10000',uid:'u_self'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,voiceCache:cache},
    {kind:'private',target:10001,message:record('base64://'+wav().toString('base64'))});
  assert.equal(calls,1);assert.equal(cache.active.size,0);
  const message=normalizeMessage(result.raw,10000);assert.equal(message.message[0].type,'record');assert.equal(message.message[0].data.duration,1);
});

test('voice submission with no confirmation stays uncertain and is never retried',async t=>{
  const cache=new VoiceCache(join(await temp(t),'media-voice')),tracker=new SendTracker(25);let calls=0;
  await assert.rejects(sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=> '89',sendMsg:async()=>{calls++;return {result:0};}},self:{uin:'10000'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,voiceCache:cache},
    {kind:'private',target:10001,message:record('base64://'+wav().toString('base64'))}),e=>e.uncertain&&e.code===1502);
  assert.equal(calls,1);assert.equal(cache.active.size,0);assert.equal(tracker.pending.size,0);
});

test('group voice sends use the group peer and require the same terminal confirmation',async t=>{
  const cache=new VoiceCache(join(await temp(t),'media-voice')),tracker=new SendTracker(1000);cleanup(t,()=>tracker.close());
  const result=await sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=> '90',sendMsg:async(id,peer,elements)=>{
    assert.equal(peer.chatType,2);assert.equal(peer.peerUid,'20001');assert.equal(elements[0].elementType,4);
    setImmediate(()=>tracker.update({...peer,msgId:id,sendStatus:2,elements}));return {result:0};
  }},self:{uin:'10000'},contacts:new Map(),learn:()=>{},tracker,voiceCache:cache},{kind:'group',target:20001,message:record('base64://'+wav().toString('base64'))});
  assert.equal(normalizeMessage(result.raw,10000).groupId,20001);
});

test('AstrBot-style record messages work over HTTP and WS without retaining audio payloads in telemetry',async t=>{
  const cache=new VoiceCache(join(await temp(t),'media-voice')),tracker=new SendTracker(1000);cleanup(t,()=>tracker.close());let count=0;
  class VoiceDriver extends QQDriver {
    get mode(){return 'kernel';}get capabilities(){return ['message.send','media.record'];}async connect(){this.online=true;}
    async invoke(command,params){if(command!=='message.send')throw Error('Unsupported fixture');const result=await sendKernelMessage({session:{},msgService:{generateMsgUniqueId:()=>String(++count),sendMsg:async(id,peer,elements)=>{setImmediate(()=>tracker.update({...peer,msgId:id,sendStatus:2,elements}));return {result:0};}},self:{uin:'10000'},contacts:new Map([[10001,{uid:'u_target'}]]),learn:()=>{},tracker,voiceCache:cache},params);return {message_id:Number(result.raw.msgId)};}
  }
  const bot=await app(t,{}, {driver:new VoiceDriver({account:10000})});assert.equal((await request(bot,'/can_send_record')).data.data.yes,true);
  const message=record('base64://'+wav().toString('base64url'));
  assert.equal((await request(bot,'/send_private_msg',{user_id:10001,message})).data.retcode,0);
  const client=await wsClient(t,bot,'/api');client.ws.send(JSON.stringify({action:'send_private_msg',params:{user_id:10001,message},echo:{seq:43}}));
  assert.equal((await client.receive(packet=>packet.echo?.seq===43)).retcode,0);
  assert.ok(!JSON.stringify(bot.telemetry.read()).includes(message[0].data.file));
  const descriptor=Object.getOwnPropertyDescriptor(KernelDriver.prototype,'capabilities');assert.ok(descriptor.get.call({}).includes('media.record'));
});

test('telemetry removes base64 and data audio from both segments and raw CQ strings',()=>{
  for(const source of ['base64://AAAA','data:audio/wav;base64,AAAA','data:application/octet-stream;base64,AAAA']){
    const telemetry=new Telemetry();telemetry.message({message:record(source),raw_message:'[CQ:record,file='+source+']'});assert.ok(!JSON.stringify(telemetry.read()).includes(source));
  }
});
