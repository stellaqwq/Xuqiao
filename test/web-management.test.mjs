import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { launchWorkspace } from '../scripts/launch.mjs';
import { Settings, fields } from '../src/settings.mjs';
import { environmentOf, loadConfig } from '../src/config.mjs';
import { createServer } from 'node:http';
import { Telemetry } from '../src/telemetry.mjs';
import { app, temp, config, cleanup, request, incoming } from './helpers.mjs';

test('web schema covers every runtime environment variable and example setting', async () => {
  const code=await readFile(new URL('../src/config.mjs',import.meta.url),'utf8');
  const names=[...code.matchAll(/(?:env\.|(?:number|bool)\(env, ')([A-Z][A-Z0-9_]+)/g)].map(m=>m[1]);
  const example=parseEnv(await readFile(new URL('../.env.example',import.meta.url),'utf8'));
  for(const name of [...names,...Object.keys(example)]) assert.ok(fields.some(f=>f.key===name),'Missing '+name);
});

test('configuration is validated atomically, persists multiline values, rejects stale saves, and masks credentials', async t => {
  const directory=await temp(t), c=config(directory), path=join(directory,'.env');
  await writeFile(path,Object.entries(environmentOf(c)).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n'));
  const settings=new Settings(c,{path});
  const before=await settings.snapshot(), original=await readFile(path,'utf8');
  assert.ok(!JSON.stringify(before).includes(c.adminToken));
  await assert.rejects(settings.save({AI_ENABLED:'true'},before.revision),/allowlist/);
  assert.equal(await readFile(path,'utf8'),original);
  await assert.rejects(settings.save({PORT:'1.5'},before.revision),/整数/);
  await assert.rejects(settings.save({UNRECOGNIZED:'x'},before.revision),/未知/);
  const prompt='你好，"助手"\n第二行：$x # literal \\n';
  const saved=await settings.save({AI_SYSTEM_PROMPT:prompt,AI_API_KEY:'provider-secret-with-#-and-$'},before.revision);
  assert.equal(parseEnv(await readFile(path,'utf8')).AI_SYSTEM_PROMPT,prompt);
  assert.ok(saved.pending.includes('AI_SYSTEM_PROMPT'));
  assert.equal(saved.values.AI_API_KEY,'');
  assert.equal(saved.secrets.AI_API_KEY,true);
  await assert.rejects(settings.save({AI_MODEL:'stale'},before.revision),/其他窗口/);
  assert.equal((await settings.reveal('AI_API_KEY')).value,'provider-secret-with-#-and-$');
  await settings.save({AI_API_KEY:''},saved.revision);
  assert.equal((await settings.snapshot()).secrets.AI_API_KEY,false);
  const mixed='Use "quotes", don\'t remove `code` or newlines.\n第二行。';
  const current=await settings.snapshot();
  await settings.save({AI_SYSTEM_PROMPT:mixed},current.revision);
  assert.equal((await settings.snapshot()).values.AI_SYSTEM_PROMPT,mixed);
  assert.equal(loadConfig(parseEnv(await readFile(path,'utf8'))).ai.systemPrompt,mixed);
});

test('model discovery uses stored credentials, returns model IDs and rejects non-HTTP URLs', async t => {
  let auth;
  const server=createServer((req,res)=>{auth=req.headers.authorization;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'local-model'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup(t,()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const settings=new Settings(config(await temp(t),{AI_API_KEY:'stored-test-key',AI_BASE_URL:'http://127.0.0.1:'+server.address().port+'/v1'}));
  assert.deepEqual((await settings.models({})).models,['local-model']);
  assert.equal(auth,'Bearer stored-test-key');
  await assert.rejects(settings.models({AI_BASE_URL:'file:///x'}),/HTTP/);
  const snapshot=await settings.snapshot();
  const locked=new Settings(config(await temp(t)),{lockedKeys:['PORT']});
  await assert.rejects(locked.save({PORT:'1234'},(await locked.snapshot()).revision),/覆盖/);
  assert.ok(snapshot.secrets.AI_API_KEY);
});

test('settings and message history require administrator authentication, and logs exclude bodies and secrets', async t => {
  const bot=await app(t);
  assert.equal((await request(bot,'/admin/settings',undefined,'onebot')).code,401);
  assert.equal((await request(bot,'/admin/telemetry',undefined,false)).code,401);
  bot.adapter.driver.inject(incoming(991,{message:'sensitive incoming content'}));
  await bot.adapter.action('send_private_msg',{user_id:10001,message:'outgoing test content'});
  const {data}=await request(bot,'/admin/telemetry');
  assert.ok(data.entries.some(e=>e.kind==='message'&&e.event.raw_message==='sensitive incoming content'));
  assert.ok(data.entries.some(e=>e.kind==='message'&&e.event.post_type==='message_sent'&&e.event.target_id===10001));
  const logs=JSON.stringify(data.entries.filter(e=>e.kind==='log'));
  assert.ok(!logs.includes('sensitive incoming content'));
  assert.ok(!logs.includes(bot.config.adminToken));
  const after=await request(bot,'/admin/telemetry?after='+data.cursor);
  assert.equal(after.data.entries.length,0);
});

test('workspace settings enforce origin, preserve token isolation and apply changed ports and credentials without closing the page', async t => {
  const c=config(await temp(t)), workspace=await launchWorkspace(c);
  cleanup(t,()=>workspace.close());
  const origin=new URL(workspace.url).origin;
  const get=async path=>(await fetch(workspace.url+path)).json();
  const post=(path,data,from=origin)=>fetch(workspace.url+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json'},body:JSON.stringify(data)});
  let snapshot=await get('/settings');
  assert.equal(snapshot.persistent,false);
  assert.equal((await post('/settings',{revision:snapshot.revision,values:{AI_MODEL:'test'}},'https://example.com')).status,403);
  assert.equal((await post('/settings/reveal',{key:'ADMIN_ACCESS_TOKEN'},'https://example.com')).status,403);
  const admin=randomBytes(32).toString('hex');
  const response=await post('/settings',{revision:snapshot.revision,values:{ADMIN_ACCESS_TOKEN:admin,AI_MODEL:'new-model',PORT:'0'}});
  assert.equal(response.status,200);
  assert.ok(!JSON.stringify(await response.json()).includes(admin));
  const old=workspace.app;
  assert.equal((await post('/restart',{})).status,200);
  assert.notEqual(workspace.app,old);
  assert.equal(workspace.app.config.adminToken,admin);
  assert.equal(workspace.app.config.ai.model,'new-model');
  snapshot=await get('/settings');
  assert.equal(snapshot.pending.length,0);
  assert.equal((await get('/state')).online,true);
  assert.equal((await fetch(workspace.url)).status,200);
});

test('failed restart restores previous service and keeps saved settings pending', async t => {
  const workspace=await launchWorkspace(config(await temp(t)));
  cleanup(t,()=>workspace.close());
  const before=await workspace.app.settings.snapshot();
  await workspace.app.settings.save({QQ_DRIVER:'missing-driver-for-rollback-test.mjs'},before.revision);
  await assert.rejects(workspace.restart(),/已恢复/);
  assert.equal(workspace.app.config.driver,'demo');
  assert.equal(workspace.app.adapter.status().online,true);
  // In-memory settings survive rollback as well as file-based settings.
  assert.ok((await workspace.app.settings.snapshot()).pending.includes('QQ_DRIVER'));
  assert.equal((await (await fetch(workspace.url+'/state')).json()).online,true);
  assert.ok((await (await fetch(workspace.url+'/settings')).json()).pending.includes('QQ_DRIVER'));
});

test('telemetry history has a fixed bound and deduplicates driver echoes', () => {
  const telemetry=new Telemetry(5);
  for(let n=0;n<10;n++)telemetry.add('log',{event:'test',level:'info'});
  assert.equal(telemetry.read().entries.length,5);
  assert.equal(telemetry.read().oldest,6);
  const event={self_id:1,message_id:123,post_type:'message_sent'};
  telemetry.message(event);telemetry.message(event);
  assert.equal(telemetry.read().entries.filter(e=>e.kind==='message').length,1);
});
