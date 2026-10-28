import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app, request, cleanup, waitFor } from './helpers.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';

const env={AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'};
async function snapshots(t,url,headers={}) {
  const controller=new AbortController();cleanup(t,()=>controller.abort());
  const response=await fetch(url,{headers,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  return async predicate=>{
    while(true){
      let end;
      while((end=buffer.indexOf('\n\n'))!==-1){
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(!frame.startsWith('data: '))continue;
        const result=JSON.parse(frame.slice(6));if(predicate(result))return result;
      }
      const chunk=await reader.read();if(chunk.done)throw Error('Stream ended before expected snapshot');
      buffer+=decoder.decode(chunk.value,{stream:true});
    }
  };
}

test('authenticated web SSE exposes partial text before completion, isolates sessions and never sends QQ',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});cleanup(t,()=>release());
  const ai={async reply(_input,_history,signal,options){await options.onDelta('实时正文。','实时正文。');await Promise.race([hold,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);signal.throwIfAborted();return '实时正文。完整结尾。';}};
  const bot=await app(t,env,{ai}),session=randomUUID(),other=randomUUID();let sends=0;bot.adapter.on('outgoing',()=>sends++);
  const url=`http://127.0.0.1:${bot.address.port}/admin/agent/chat/stream?session=${session}`;
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${bot.config.token}`}})).status,401);
  assert.equal((await fetch(url+'&access_token='+bot.config.adminToken)).status,401);
  assert.equal((await fetch(url.replace(session,'bad'),{headers:{Authorization:`Bearer ${bot.config.adminToken}`}})).status,400);
  const next=await snapshots(t,url,{Authorization:`Bearer ${bot.config.adminToken}`});await next(value=>value.jobs.length===0);
  const task=await request(bot,'/admin/agent/chat',{session,text:'test'});
  const partial=await next(value=>value.jobs.some(job=>job.status==='generating'&&job.reply==='实时正文。'));
  assert.equal(partial.jobs[0].id,task.data.job_id);assert.equal(sends,0);
  assert.deepEqual(bot.agent.chatHistory(other).jobs,[]);
  release();const final=await next(value=>value.jobs.some(job=>job.status==='done'));
  assert.equal(final.jobs[0].reply,'实时正文。完整结尾。');assert.equal(sends,0);
});

test('workspace forwards SSE without exposing credentials and releases backend listeners on disconnect',async t=>{
  const bot=await app(t,env),session=randomUUID();
  const page=await createLoginServer({backend:`http://127.0.0.1:${bot.address.port}`,token:bot.config.adminToken});cleanup(t,()=>page.close());
  const controller=new AbortController(),url=page.url+'/agent/chat/stream?session='+session;
  const response=await fetch(url,{signal:controller.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),first=await reader.read(),data=Buffer.from(first.value).toString('utf8');
  assert.match(data,/data: /);assert.match(data,new RegExp(session));assert.ok(!data.includes(bot.config.adminToken));
  assert.ok(bot.store.listenerCount('stream')>0);controller.abort();await waitFor(()=>bot.store.listenerCount('stream')===0);
  assert.equal((await fetch(page.url+'/agent/chat/stream?session=bad')).status,400);
});

test('backend shutdown closes a live SSE proxy without writing a second set of response headers',async t=>{
  const bot=await app(t,env),session=randomUUID();
  const page=await createLoginServer({backend:`http://127.0.0.1:${bot.address.port}`,token:bot.config.adminToken});cleanup(t,()=>page.close());
  const controller=new AbortController();cleanup(t,()=>controller.abort());
  const response=await fetch(page.url+'/agent/chat/stream?session='+session,{signal:controller.signal});
  const reader=response.body.getReader();assert.equal((await reader.read()).done,false);
  await bot.close();const result=await reader.read().catch(()=>({done:true}));assert.equal(result.done,true);
});
