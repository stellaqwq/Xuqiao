import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { launchWorkspace } from './launch.mjs';
import { config, incoming } from '../test/helpers.mjs';
import { png, gif } from '../test/image-fixture.mjs';

const output = resolve('.impeccable/review/memes'), temporaryRoot = resolve('dist/meme-web-qa');
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
  const size = (await send('Page.getLayoutMetrics')).cssContentSize;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
  await writeFile(join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
try {
  await writeFile(join(output, 'report.json'), JSON.stringify({ success: false, status: 'running' }));
  workspace = await launchWorkspace(config(data));
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

  await viewport(1440); await send('Page.navigate',{url:workspace.url+'#memes'});
  await wait('document.getElementById("meme-grid").textContent.includes("这里还没有表情")');
  await screenshot('empty-desktop'); checks.push('empty gallery and direct navigation');
  await click('meme-install'); await wait('document.getElementById("meme-plugin-status").textContent==="已停用"');
  assert.equal(workspace.app.plugins.findMeme().enabled,false);
  await value('meme-users','10001'); await value('meme-admins','10001'); await click('meme-settings-save');
  await wait('document.getElementById("meme-settings-state").textContent.includes("已保存")&&!document.getElementById("meme-settings-save").disabled');
  await click('meme-toggle'); await wait('document.getElementById("meme-plugin-status").textContent==="已启用"');
  assert.equal(await evaluate('document.getElementById("meme-collect").checked'),false);
  checks.push('native plugin install, scoped rules, default-off collection and enable');
  const fixture=join(data,'demo.png'); await writeFile(fixture,png(64,48));
  await value('meme-upload-category','happy');
  const doc=await send('DOM.getDocument'),fileNode=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#meme-files'});
  await send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[fixture]});
  await wait('document.querySelectorAll(".meme-item").length===1&&!document.getElementById("meme-upload").disabled');
  await send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[fixture]});
  await wait('!document.getElementById("meme-upload").disabled');
  assert.equal(workspace.app.memes.snapshot().total,1);
  for(let n=0;n<7;n++)await workspace.app.memes.upload({data:'base64://'+png(70+n*3,60+n*2).toString('base64'),name:'【模拟】情绪测试图 '+(n+1),category:['happy','sad','love'][n%3],tags:'模拟测试，情绪'});
  await workspace.app.memes.upload({data:'base64://'+gif.toString('base64'),name:'【模拟】待审核动图',category:'other',status:'pending'});
  await click('meme-refresh'); await wait('document.querySelectorAll(".meme-item").length===8');
  await wait('[...document.querySelectorAll(".meme-thumb img")].every(img=>img.complete&&img.naturalWidth>0)');
  await evaluate('document.getElementById("meme-settings").open=false'); await screenshot('desktop');
  for(const width of [1024,768,680,390,320]){await viewport(width);if(width===390||width===320)assert.ok(await evaluate('document.querySelector(".meme-thumb").getBoundingClientRect().top+24<innerHeight'),'first image visible at '+width);if(width===390)await screenshot('mobile');if(width===320)await screenshot('mobile-320');}
  checks.push('multi-upload path, content deduplication, authenticated image previews and responsive gallery');
  await viewport(1440); await evaluate('document.querySelector(".meme-thumb").click()');
  await wait('document.getElementById("meme-image-dialog").open');
  await value('meme-image-name','<script>window.memeXss=1</script>模拟表情');await value('meme-image-tags','开心，测试');
  await evaluate('document.getElementById("meme-image-form").requestSubmit()');
  await wait('!document.getElementById("meme-image-dialog").open');
  assert.equal(await evaluate('window.memeXss'),undefined);
  await value('meme-search','模拟表情');await wait('document.querySelectorAll(".meme-item").length===1');
  await value('meme-search','');await wait('document.querySelectorAll(".meme-item").length===8');
  await click('meme-select-all');await value('meme-target-category','happy');await click('meme-move');
  await wait('!document.getElementById("meme-move").disabled||document.getElementById("meme-selection").textContent==="已选 0 张"');
  assert.equal(workspace.app.memes.snapshot({category:'happy'}).total,8);
  checks.push('safe metadata editing, keyword search and batch move');
  await value('meme-status','pending');await evaluate('document.getElementById("meme-status").dispatchEvent(new Event("change"))');
  await wait('document.querySelectorAll(".meme-item").length===1');await screenshot('pending-desktop');
  await click('meme-select-all');await value('meme-target-category','happy');await click('meme-approve');
  await wait('document.getElementById("meme-grid").textContent.includes("暂无待审核")');
  assert.equal(workspace.app.memes.snapshot().total,9);checks.push('pending queue and explicit approval');
  await value('meme-status','approved');await evaluate('document.getElementById("meme-status").dispatchEvent(new Event("change"))');
  await wait('document.querySelectorAll(".meme-item").length===9');
  await value('meme-preview-text','你好 [[表情:开心]]');await evaluate('document.getElementById("meme-preview-form").requestSubmit()');
  await wait('!document.getElementById("meme-preview-image").hidden&&document.getElementById("meme-preview-image").naturalWidth>0');
  assert.equal(workspace.app.adapter.driver.messages.size,0);checks.push('category selection preview never sends');
  await click('meme-new-category');await value('meme-category-name','模拟新分类');await value('meme-category-description','测试，模拟');
  await evaluate('document.getElementById("meme-category-form").requestSubmit()');
  await wait('document.getElementById("meme-categories").textContent.includes("模拟新分类")');
  await evaluate('document.getElementById("meme-settings").open=true');await value('meme-groups','20001');
  const plugin=workspace.app.plugins.findMeme();await workspace.app.plugins.toggle({id:plugin.id,revision:plugin.revision,enabled:false});
  expectedHttpFailures.set('/memes/settings|409',1);await click('meme-settings-save');
  await wait('document.getElementById("meme-settings-error").textContent.includes("其他窗口")');
  assert.equal(await evaluate('document.activeElement.id'),'meme-settings-error');assert.equal(await evaluate('document.getElementById("meme-groups").value'),'20001');
  await viewport(390);await screenshot('settings-mobile');checks.push('category creation and settings conflict preserve focused draft');
  workspace.app.config.ai.enabled=true;
  await click('meme-settings-reload');await wait('document.getElementById("confirm-dialog").open');await click('confirm-ok');
  await wait('document.getElementById("meme-settings-state").textContent.includes("已保存")');
  await evaluate('document.getElementById("meme-ai").checked=false;document.getElementById("meme-ai").dispatchEvent(new Event("input",{bubbles:true}))');await click('meme-settings-save');
  await wait('!document.getElementById("meme-settings-save").disabled');
  await click('meme-toggle');await wait('document.getElementById("meme-plugin-hint").textContent.includes("AI 选图已关闭")');
  await viewport(1440);await screenshot('ai-selection-off-desktop');checks.push('project AI on and local image selection off have truthful header status');
  await viewport(390);
  const invalidFile=join(data,'not-an-image.svg');await writeFile(invalidFile,'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  expectedHttpFailures.set('/memes/upload|400',1);
  await send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[invalidFile]});
  await wait('document.getElementById("meme-error").textContent.includes("PNG")&&!document.getElementById("meme-upload").disabled');
  assert.equal(await evaluate('document.activeElement.id'),'meme-error');
  await screenshot('upload-error-mobile');checks.push('unsupported upload keeps a visible focused error after gallery refresh');
  assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(verifiedHttpFailures,2);
  const report={success:true,checks,javascriptOrCspErrors:errors.length,expectedHttpFailures:verifiedHttpFailures,screenshots:output};
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ success: false, error: error.message, errors, checks }, null, 2)); throw error;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([once(browser, 'exit'), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
  await workspace?.close();
  for (const path of [profile, data]) { assert.equal(dirname(path), temporaryRoot); await rm(path, { recursive: true, force: true }); }
}
