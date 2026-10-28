import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ReceiveRecords, isEmptyMessageRecord } from '../src/qq/kernel/receive-records.mjs';
import { normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { kernelHost } from './kernel-host-harness.mjs';
import { waitFor, withTestTimeout } from './helpers.mjs';

// Captured shape only. All IDs and message text below are synthetic.
const shell = extra => ({chatType:2,msgType:1,subMsgType:0,sendType:0,senderUid:'',senderUin:'0',
  peerUid:'20000',msgId:'1234567890123456789',msgTime:'1793000000',elements:[],...extra});
const complete = extra => shell({msgType:2,subMsgType:1,senderUid:'u_member',senderUin:'10001',
  elements:[{elementType:1,textElement:{content:'fixture'}}],...extra});

test('captured empty record is recognized while ordinary unidentified content remains a validation error', () => {
  assert.equal(isEmptyMessageRecord(shell()),true);
  for(const raw of [complete(),shell({elements:[{elementType:1,textElement:{content:'fixture'}}]}),
    shell({msgType:5}),shell({senderUid:'u_member'}),shell({senderUin:'10001'})])assert.equal(isEmptyMessageRecord(raw),false);
  assert.throws(()=>normalizeMessage(shell({elements:[{elementType:1,textElement:{content:'fixture'}}]}),10000),/no resolved sender/);
});

test('empty record reads back the matching native message exactly once',async()=>{
  const records=new ReceiveRecords();let reads=0;
  const raw=shell();assert.equal(records.observe(raw,true),true);
  const result=await records.prepare(raw,{async getMsgsByMsgId(peer,ids){
    reads++;assert.deepEqual(peer,{chatType:2,peerUid:'20000',guildId:''});assert.deepEqual(ids,[raw.msgId]);
    return {result:0,msgList:[complete()]};
  }});
  assert.equal(normalizeMessage(result,10000).sender.user_id,10001);
  records.published(result);
  assert.equal(records.observe(complete(),false),false);
  assert.equal(records.observe(complete(),true),false);
  assert.equal(await records.prepare(raw,{}),null);assert.equal(reads,1);
});

test('empty readback waits for a matching populated update without publishing an empty chat',async()=>{
  const pending=[],records=new ReceiveRecords({onPending:(_,status)=>pending.push(status)});
  const raw=shell();records.observe(raw,true);
  assert.equal(await records.prepare(raw,{getMsgsByMsgId:async()=>({msgList:[raw]})}),null);
  assert.deepEqual(pending,['empty']);assert.equal(records.observe(raw,true),false);
  assert.equal(records.observe(complete({msgId:'unrelated'}),false),false);
  assert.equal(records.observe(complete(),false),true);
  assert.equal(await records.prepare(complete(),{}).then(value=>value.senderUin),'10001');
  records.published(complete());assert.equal(records.observe(complete(),false),false);
});

test('readback cannot substitute another message, conversation or failed result',async()=>{
  for(const response of [{msgList:[complete({msgId:'other'})]},{msgList:[complete({peerUid:'30000'})]},
    {msgList:[complete({chatType:1})]},{result:1,msgList:[complete()]}]){
    const records=new ReceiveRecords(),raw=shell();records.observe(raw,true);
    assert.equal(await records.prepare(raw,{getMsgsByMsgId:async()=>response}),null);
    assert.equal(records.observe(complete(),false),true);
  }
});

test('readback timeout is bounded and session cancellation discards late native snapshots',async()=>{
  let release;const records=new ReceiveRecords({timeout:25}),raw=shell();records.observe(raw,true);
  assert.equal(await withTestTimeout(()=>records.prepare(raw,{getMsgsByMsgId:()=>new Promise(resolve=>{release=resolve;})}),500),null);
  release({msgList:[complete()]});await delay(10);assert.equal(records.records.values().next().value.published,false);
  const controller=new AbortController();records.clear();records.observe(raw,true);
  const pending=records.prepare(raw,{getMsgsByMsgId:()=>new Promise(resolve=>{release=resolve;})},controller.signal);
  const rejected=assert.rejects(pending,error=>error.name==='AbortError');
  controller.abort();await rejected;
});

test('partial-record watches are bounded, expire and are rebuilt if a queued record was evicted',async()=>{
  let now=0;const records=new ReceiveRecords({limit:2,ttl:30,now:()=>now});
  records.observe(shell({msgId:'1'}),true);records.observe(shell({msgId:'2'}),true);records.observe(shell({msgId:'3'}),true);
  assert.equal(records.records.size,2);assert.equal(records.observe(complete({msgId:'1'}),false),false);
  assert.equal(await records.prepare(shell({msgId:'1'}),{getMsgsByMsgId:async()=>({msgList:[]})}),null);
  assert.equal(records.records.size,2);assert.equal(records.observe(complete({msgId:'1'}),false),true);
  now=31;assert.equal(records.observe(complete({msgId:'1'}),false),false);assert.equal(records.records.size,0);
  assert.equal(records.observe(complete(),true),true);
});

test('real host does not publish an empty record but forwards its populated update once',async t=>{
  const host=await kernelHost(t);host.authenticate();await waitFor(()=>host.inspect().online);
  host.receive(shell());await delay(30);
  assert.equal(host.packets.some(packet=>packet.event==='message'),false);
  host.update(complete());host.update(complete());
  await waitFor(()=>host.packets.some(packet=>packet.event==='message'));await delay(20);
  const packets=host.packets.filter(packet=>packet.event==='message');assert.equal(packets.length,1);
  assert.equal(normalizeMessage(packets[0].data,10000).sender.user_id,10001);
});

test('a populated native snapshot and its concurrent update produce one host event',async t=>{
  let release;const host=await kernelHost(t,{getMessages:()=>new Promise(resolve=>{release=resolve;})});
  host.authenticate();await waitFor(()=>host.inspect().online);host.receive(shell());await waitFor(()=>release);
  host.update(complete());release({msgList:[complete()]});
  await waitFor(()=>host.packets.some(packet=>packet.event==='message'));await delay(30);
  assert.equal(host.packets.filter(packet=>packet.event==='message').length,1);
});

test('kicking the session during empty-record readback cannot publish its late result',async t=>{
  let release;const host=await kernelHost(t,{getMessages:()=>new Promise(resolve=>{release=resolve;})});
  host.authenticate();await waitFor(()=>host.inspect().online);host.receive(shell());await waitFor(()=>release);
  host.kick();release({msgList:[complete()]});host.update(complete());await delay(40);
  assert.equal(host.packets.some(packet=>packet.event==='message'),false);
});
