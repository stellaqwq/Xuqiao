import {groupChatSchema} from '../src/group-chat-plus/schema.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { launchWorkspace } from './launch.mjs';
import { config, incoming } from '../test/helpers.mjs';
import { pluginTemplate } from '../src/plugins/service.mjs';

const output = resolve('.impeccable/review/group-chat'), temporaryRoot = resolve('dist/group-chat-web-qa');
await mkdir(output, { recursive: true }); await mkdir(temporaryRoot, { recursive: true });
const profile = await mkdtemp(join(temporaryRoot, 'chrome-')), data = await mkdtemp(join(temporaryRoot, 'demo-'));
let workspace, browser, socket, sequence = 0;
const pending = new Map(), errors = [], checks = [];
const expectedHttpFailures = new Map();
let verifiedHttpFailures = 0;
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 12000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
  throw Error('UI condition: ' + expression);
}
const click = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').click()');
const value = (id, value) => evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
async function viewport(width) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 681 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 681 });
  await evaluate('window.scrollTo(0,0)'); await delay(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'no overflow ' + width);
}
async function screenshot(name) {
  await evaluate('window.scrollTo(0,0);document.getElementById("toast").hidden=true');
  await delay(220);
  const size = (await send('Page.getLayoutMetrics')).cssContentSize;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
  await writeFile(join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
try {
  await writeFile(join(output, 'report.json'), JSON.stringify({ success: false, status: 'running' }));
  workspace = await launchWorkspace(config(data,{AI_ENABLED:'true',AI_MODEL:'fixture',AI_ALLOWED_GROUPS:'20001,20002'}));
  browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => errors.push(error.message));
  let port;
  for (let n = 0; n < 100; n++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
  assert.ok(port, 'Chrome available');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  socket.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry;
      const key = [...expectedHttpFailures.keys()].find(key => {
        const [path, code] = key.split('|');
        return entry.source === 'network' && entry.url?.endsWith(path) && entry.text.includes('status of ' + code) && expectedHttpFailures.get(key) > 0;
      });
      if (key) { expectedHttpFailures.set(key, expectedHttpFailures.get(key) - 1); verifiedHttpFailures++; }
      else errors.push(entry);
    }
  });
  await once(socket, 'open'); await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await viewport(1440);await send('Page.navigate',{url:workspace.url+'#groupchat'});
  await wait('!document.getElementById("gcp-empty").hidden');
  await click('gcp-install');await wait('!document.getElementById("gcp-pane-config").hidden&&document.querySelectorAll("#gcp-config-fields [data-key]").length==='+Object.keys(groupChatSchema).length);
  assert.equal(workspace.app.plugins.findGroupChat().enabled,false);

  assert.equal(await evaluate('document.getElementById("gcp-config-decision_reasoning_effort").value'),'none');
  assert.equal(await evaluate('document.getElementById("gcp-config-image_caption_reasoning_effort").value'),'none');
  await evaluate('[...document.querySelectorAll("#gcp-config-fields .config-nav button")].find(b=>b.textContent==="AI 读空气").click()');
  await value('gcp-config-decision_max_output_tokens','1024');await screenshot('aux-model-settings-desktop');
  await value('gcp-scope-groups','20001, 20002');await value('gcp-config-initial_probability','0');await click('gcp-save');
  await wait('!document.getElementById("gcp-save").disabled&&document.getElementById("gcp-config-state").textContent==="保存后即时生效"');
  assert.deepEqual(workspace.app.plugins.findGroupChat().scope.groups,['20001','20002']);assert.equal(workspace.app.plugins.findGroupChat().config.decision_max_output_tokens,1024);await evaluate('[...document.querySelectorAll("#gcp-config-fields .config-nav button")].find(b=>b.textContent==="参与概率").click()');
  await screenshot('config-desktop');checks.push('built-in installation defaults disabled; all configuration controls save real configuration with group scope');
  await value('gcp-config-search','主动聊天');assert.ok(await evaluate('[...document.querySelectorAll("#gcp-config-fields .config-field:not([hidden])")].length>0'));await value('gcp-config-search','');
  await click('gcp-toggle');await wait('document.getElementById("gcp-enabled").textContent==="插件已启用"');
  workspace.app.adapter.driver.inject(incoming(801,{kind:'group',groupId:20001,message:'【模拟群聊】哈哈，今天真开心',sender:{user_id:10001,nickname:'演示用户'}}));
  workspace.app.adapter.driver.inject(incoming(802,{kind:'group',groupId:20002,message:'【模拟群聊】另一个群的上下文'}));
  const p=workspace.app.plugins.findGroupChat();
  for(const group of ['20001','20002'])workspace.app.store.db.prepare('INSERT INTO group_chat_images VALUES (?,?,?,?,?,?)').run(group.padStart(64,'a'),p.id,'10000:group:'+group,'fixture-vision','【模拟图片描述】群 '+group+' <img src=x onerror="window.gcpUnsafe=1">',Date.now());
  await click('gcp-refresh');await click('gcp-tab-status');await wait('document.querySelectorAll("#gcp-groups tr").length===2');await screenshot('status-desktop');
  await click('gcp-tab-group');await wait('!document.getElementById("gcp-group-detail").hidden');
  const override=await evaluate('(()=>{const node=document.querySelector(\'[data-override="initial_probability"]\');node.checked=true;node.dispatchEvent(new Event("change"));return node.getAttribute("aria-label");})()');assert.ok(override.includes('基础参与概率'));
  await value('gcp-group-initial_probability','0.25');await click('gcp-overrides-save');await wait('document.getElementById("gcp-override-state").textContent.startsWith("1 项覆盖")');
  assert.equal(workspace.app.groupChatPlus.settings(p,'10000:group:20001').initial_probability,0.25);
  assert.equal(workspace.app.groupChatPlus.settings(p,'10000:group:20002').initial_probability,0);
  await click('gcp-pause');await wait('document.getElementById("gcp-pause").textContent==="恢复当前群"');
  await value('gcp-probability','0.4');await click('gcp-probability-save');await wait('!document.getElementById("gcp-probability-save").disabled');assert.equal(workspace.app.groupChatPlus.read('10000:group:20001',p).probability,0.4);
  await value('gcp-probability','');await click('gcp-probability-save');await wait('!document.getElementById("gcp-probability-save").disabled');assert.equal(workspace.app.groupChatPlus.read('10000:group:20001',p).probability,undefined);
  assert.equal(await evaluate('document.querySelectorAll("#gcp-members tr").length'),1);await screenshot('group-desktop');
  await click('gcp-tab-cache');assert.ok(await evaluate('document.getElementById("gcp-history").textContent.includes("哈哈")'));assert.equal(await evaluate('window.gcpUnsafe'),undefined);assert.equal(await evaluate('document.querySelectorAll("#gcp-images img").length'),0);await screenshot('cache-desktop');
  checks.push('per-group overrides, attention and mood, pause, probability inheritance, scoped context and escaped image descriptions');
  for(const width of [1440,1024,768,680,390,320]){
    await viewport(width);
    for(const tab of ['status','config','group','cache']){await click('gcp-tab-'+tab);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'layout '+tab+' '+width);if(width===320||width===390)await screenshot(tab+'-'+width);}
  }
  await viewport(1440);await click('gcp-tab-config');await value('gcp-config-initial_probability','0.12');await click('gcp-refresh');assert.equal(await evaluate('document.getElementById("gcp-config-initial_probability").value'),'0.12');
  await click('gcp-tab-group');assert.equal(await evaluate('document.getElementById("gcp-group-initial_probability").value'),'0.25');await click('gcp-tab-config');await click('gcp-save');await wait('!document.getElementById("gcp-save").disabled&&document.getElementById("gcp-config-state").textContent==="保存后即时生效"');
  assert.equal(workspace.app.groupChatPlus.settings(workspace.app.plugins.findGroupChat(),'10000:group:20002').initial_probability,0.12);
  await click('gcp-tab-group');await click('gcp-inherit-all');await click('gcp-overrides-save');await wait('document.getElementById("gcp-override-state").textContent.startsWith("0 项覆盖")');assert.equal(workspace.app.groupChatPlus.settings(workspace.app.plugins.findGroupChat(),'10000:group:20001').initial_probability,0.12);
  await click('gcp-tab-cache');await click('gcp-clear-images');await wait('document.getElementById("confirm-dialog").open');await click('confirm-ok');await wait('document.getElementById("gcp-image-count").textContent==="0 条"');assert.equal(workspace.app.store.db.prepare('SELECT count(*) AS n FROM group_chat_images').get().n,1);
  checks.push('six viewport layouts, draft preservation across refresh and tabs, global inheritance and isolated cache clearing');
  await evaluate('document.querySelector(\'[data-view="plugins"]\').click()');await wait('document.querySelector(".plugin-row")');
  const current=workspace.app.plugins.findGroupChat(),revision=current.revision;
  await evaluate('[...document.querySelectorAll(".plugin-row button")].find(b=>b.textContent==="重载").click()');await wait('document.getElementById("toast").textContent.includes("已重载")');assert.equal(workspace.app.plugins.findGroupChat().revision,revision+1);assert.equal(workspace.app.plugins.findGroupChat().enabled,true);
  await evaluate('[...document.querySelectorAll(".plugin-row button")].find(b=>b.textContent==="查看行为").click()');await wait('document.getElementById("plugin-behaviors-body").textContent.includes("/gcp_status")');
  await click('plugin-create');await wait('!document.getElementById("plugin-editor").hidden');await value('plugin-name','【模拟】配置表单插件');await value('plugin-users','10001');
  await value('plugin-schema',JSON.stringify({command:{type:'string',default:'/ping',description:'指令',group:'基础'},response:{type:'text',default:'pong',description:'回答',group:'基础'},ratio:{type:'float',default:0.5,description:'概率',slider:{min:0,max:1}}}));await click('plugin-schema-apply');await wait('document.getElementById("plugin-field-ratio")');
  await value('plugin-field-command','/custom');await value('plugin-field-response','<img src=x onerror="window.gcpUnsafe=1">');await click('plugin-save');await wait('!document.getElementById("plugin-save").disabled&&document.querySelectorAll(".plugin-row").length===2');
  const script=workspace.app.plugins.rows().find(x=>x.kind==='script');assert.equal(script.config.command,'/custom');assert.equal(script.config.ratio,0.5);assert.ok(script.config_schema.command);
  await value('plugin-test-text','/custom');await click('plugin-test-run');await wait('document.getElementById("plugin-test-result").textContent.includes("<img")');
  assert.equal(await evaluate('window.gcpUnsafe'),undefined);
  const updatePath=join(data,'update.plugin.json');await writeFile(updatePath,JSON.stringify({...script,version:'2.0.0',config:{command:'/replacement',response:'new default',new_setting:'new default'}}));
  await evaluate('[...document.querySelectorAll(\'.plugin-row[data-plugin="'+script.id+'"] button\')].find(b=>b.textContent==="从文件更新").click()');
  const doc=await send('DOM.getDocument'),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#plugin-file'});await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[updatePath]});
  await wait('document.getElementById("plugin-version").value==="2.0.0"');assert.equal(await evaluate('document.getElementById("plugin-field-command").value'),'/custom');await click('plugin-save');await wait('!document.getElementById("plugin-save").disabled&&document.getElementById("plugin-save-state").textContent.includes("已保存")');
  assert.equal(workspace.app.plugins.get(script.id).version,'2.0.0');assert.deepEqual(workspace.app.plugins.get(script.id).scope,script.scope);assert.equal(workspace.app.plugins.get(script.id).config.new_setting,'new default');
  await screenshot('plugin-schema-desktop');await viewport(320);await screenshot('plugin-schema-mobile');
  checks.push('hot reload, behavior inspection, custom schema form, safe preview and file update retaining existing config and scope');
  assert.equal(errors.length,0,JSON.stringify(errors));const report={success:true,checks,javascriptOrCspErrors:errors.length,viewports:[1440,1024,768,680,390,320],screenshots:output};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ success: false, error: error.message, errors, checks }, null, 2)); throw error;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([once(browser, 'exit'), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
  await workspace?.close();
  for (const path of [profile, data]) { assert.equal(dirname(path), temporaryRoot); await rm(path, { recursive: true, force: true }); }
}
