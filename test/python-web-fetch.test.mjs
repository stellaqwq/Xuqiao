import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { PluginService } from '../src/plugins/service.mjs';
import { AIClient } from '../src/ai.mjs';
import { pythonWebFetchPlugin } from '../scripts/python-web-fetch-plugin.mjs';
import { installPythonWebFetch } from '../scripts/install-web-fetch.mjs';
import { findPython } from '../examples/python-web-fetch-plugin.mjs';
import { app, cleanup, config, incoming, waitFor } from './helpers.mjs';

const html='<!doctype html><html><head><title>中文测试 &amp; 网页</title><style>hidden-css</style></head><body><h1>标题</h1><p>真实正文，包含 emoji 😀。</p><script>private-script</script><p>下一段内容。</p><a href="/next">下一页</a><a href="javascript:alert(1)">脚本链接</a></body></html>';
async function setup(t){
  const runtime=await findPython({python_path:process.env.WEBFETCH_PYTHON||''});
  const probe=spawnSync(runtime.command,[...runtime.args,'-I','-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:3000,windowsHide:true});
  assert.equal(probe.status,0,'Python 3 is required; set WEBFETCH_PYTHON to its executable path.');
  const plugin=await pythonWebFetchPlugin();plugin.config.python_path=probe.stdout.trim();plugin.config.use_proxy=false;
  const store=new Store(':memory:'),service=new PluginService({store,config:config('unused'),log:()=>{},adapter:{}});
  cleanup(t,async()=>{await service.close();store.close();});
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/redirect'){res.writeHead(302,{Location:'/html'});res.end();return;}
    if(path==='/bad-redirect'){res.writeHead(302,{Location:'file:///C:/private.txt'});res.end();return;}
    if(path==='/loop'){res.writeHead(302,{Location:'/loop?i='+Math.random()});res.end();return;}
    if(path==='/slow'){setTimeout(()=>{if(!res.destroyed){res.setHeader('Content-Type','text/plain');res.end('late');}},1200).unref();return;}
    if(path==='/forbidden'){res.writeHead(403);res.end('sensitive provider body');return;}
    if(path==='/binary'){res.setHeader('Content-Type','application/octet-stream');res.end('binary');return;}
    if(path==='/large'){res.setHeader('Content-Type','text/plain');res.setHeader('Content-Length',20000);res.end('x'.repeat(20000));return;}
    if(path==='/bomb'){res.writeHead(200,{'Content-Type':'text/html','Content-Encoding':'gzip'});res.end(gzipSync('x'.repeat(20000)));return;}
    if(path==='/gbk'){res.setHeader('Content-Type','text/html');res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'),Buffer.from('d6d0cec4','hex'),Buffer.from('</p>')]));return;}
    if(path==='/json'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end('{"answer":"中文数据"}');return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...(path==='/gzip'?{'Content-Encoding':'gzip'}:{})});
    res.end(path==='/gzip'?gzipSync(html):html);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');cleanup(t,()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  return {plugin,service,base,fetch:(path,args={},cfg={})=>service.run({...plugin,config:{...plugin.config,...cfg}},
    {post_type:'message',message_type:'private',self_id:10000,user_id:10001,message:[]},'tool',{tool:'fetch_webpage',arguments:{url:base+path,...args}})};
}

test('portable plugin embeds Python, validates in the existing runner and never consumes ordinary messages',async t=>{
  const {plugin,service}=await setup(t);assert.ok(Buffer.byteLength(plugin.source)<49152);assert.ok(!plugin.source.includes('__PYTHON_WEB_FETCH_SOURCE_BASE64__'));
  assert.equal(await service.run(plugin,null,'validate'),null);
  const result=await service.run(plugin,{message:[{type:'text',data:{text:'hello'}}]},'message');assert.equal(result.handled,false);
  const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));assert.ok(packageJson.files.includes('examples/**/*.py'));
});

test('real Python fetch extracts Chinese title, visible paragraphs, emoji and absolute links',async t=>{
  const {fetch,base}=await setup(t),result=await fetch('/html');
  assert.equal(result.ok,true);assert.equal(result.title,'中文测试 & 网页');assert.match(result.text,/真实正文，包含 emoji 😀/);assert.match(result.text,/下一段内容/);
  assert.ok(!result.text.includes('private-script'));assert.ok(!result.text.includes('hidden-css'));assert.equal(result.links[0].url,base+'/next');assert.equal(result.links.length,1);
});

test('redirects, gzip, declared legacy Chinese encoding and JSON text are supported',async t=>{
  const {fetch,base}=await setup(t);
  assert.equal((await fetch('/redirect')).url,base+'/html');assert.equal((await fetch('/gzip')).title,'中文测试 & 网页');
  const chinese=await fetch('/gbk');assert.equal(chinese.ok,true);assert.equal(chinese.text,'中文');
  const json=await fetch('/json');assert.equal(json.ok,true);assert.match(json.text,/中文数据/);
});

test('download and decompression limits, unsupported binaries and HTTP errors return bounded safe results',async t=>{
  const {fetch}=await setup(t);
  for(const path of ['/large','/bomb']){const result=await fetch(path,{}, {max_bytes:1024});assert.equal(result.ok,false);assert.equal(result.error,'response_too_large');}
  assert.equal((await fetch('/binary')).error,'unsupported_content_type');
  const denied=await fetch('/forbidden');assert.equal(denied.error,'http_error');assert.equal(denied.status,403);assert.ok(!JSON.stringify(denied).includes('sensitive'));
});

test('model parameters cannot open local files, execute Python code or follow a non-HTTP redirect',async t=>{
  const {fetch}=await setup(t);
  for(const url of ['file:///C:/private.txt','ftp://example.com/a','https://user:pass@example.com/','not-a-url']){
    const result=await fetch('/html',{url});assert.equal(result.ok,false);assert.equal(result.error,'invalid_url');
  }
  assert.equal((await fetch('/bad-redirect')).ok,false);assert.equal((await fetch('/loop')).ok,false);
});

test('deadlines terminate slow requests before the plugin worker timeout and output limits respect codepoints',async t=>{
  const {fetch}=await setup(t);const started=Date.now();
  const result=await fetch('/slow',{}, {timeout_ms:500});assert.equal(result.ok,false);assert.equal(result.error,'timeout');assert.ok(Date.now()-started<2500);
  const limited=await fetch('/html',{max_chars:100,max_links:0});assert.equal(limited.links.length,0);assert.ok(Array.from(limited.text).length<=100);
});

test('installer uses AI allowlists, enables a new tool and preserves existing scope and configuration on updates',async t=>{
  const {service,plugin}=await setup(t),cfg=config('unused',{AI_ALLOWED_USERS:'10001',AI_ALLOWED_GROUPS:'20001'});
  const result=await installPythonWebFetch(service,cfg,plugin.config.python_path);assert.equal(result.enabled,true);assert.deepEqual(result.scope.private_users,['10001']);assert.deepEqual(result.scope.groups,['20001']);
  let saved=service.get(result.id);saved=await service.save({id:saved.id,revision:saved.revision,plugin:{...saved,config:{...saved.config,max_chars:2345},scope:{...saved.scope,groups:[]}}});
  await service.toggle({id:saved.id,revision:saved.revision,enabled:false});
  const updated=await installPythonWebFetch(service,cfg);assert.equal(updated.id,result.id);assert.equal(updated.enabled,false);assert.deepEqual(updated.scope.groups,[]);assert.equal(service.get(result.id).config.max_chars,2345);assert.equal(service.rows().length,1);
});

test('Agent model calls the installed Python tool, reads its result and completes a normal QQ reply',async t=>{
  const {base,plugin}=await setup(t);let calls=0;
  class Model extends AIClient {
    async completion(messages,_signal,tools){
      calls++;
      if(messages.at(-1).role==='user'){
        const tool=tools.find(t=>t.function.name.endsWith('_fetch_webpage'));assert.ok(tool);
        return {tool_calls:[{id:'fetch1',type:'function',function:{name:tool.function.name,arguments:JSON.stringify({url:base+'/html'})}}]};
      }
      const result=JSON.parse(messages.at(-1).content);assert.equal(result.ok,true);assert.match(result.text,/真实正文/);
      return {content:'网页标题是“'+result.title+'”，正文已成功读取。'};
    }
  }
  const bot=await app(t,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_USERS:'10001'},{ai:new Model(config('unused').ai)});
  await installPythonWebFetch(bot.plugins,bot.config,plugin.config.python_path);
  bot.adapter.driver.inject(incoming(99201,{message:'请读取 '+base+'/html'}));await waitFor(()=>bot.store.get(1)?.status==='done');
  assert.equal(calls,2);assert.match(bot.store.get(1).reply,/中文测试 & 网页/);assert.ok(bot.agent.state.trace(1).some(step=>step.name.endsWith('_fetch_webpage')&&step.state==='succeeded'));
});
