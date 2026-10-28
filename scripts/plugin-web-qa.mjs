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

const output = resolve('.impeccable/review/plugins'), temporaryRoot = resolve('dist/plugin-web-qa');
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
  await viewport(1440); await send('Page.navigate', { url: workspace.url + '#plugins' });
  await wait('document.getElementById("plugin-list").textContent.includes("还没有安装插件")');
  await screenshot('empty-desktop'); checks.push('empty state and direct hash navigation');
  await click('plugin-create'); await wait('!document.getElementById("plugin-editor").hidden');
  await click('plugin-test-run'); await wait('document.getElementById("plugin-test-result").textContent.includes("模拟测试完成")');
  assert.ok((await evaluate('document.getElementById("plugin-test-result").textContent')).includes('不在触发范围'));
  assert.equal(workspace.app.store.list().length, 0);
  await value('plugin-users', '10001'); await value('plugin-name', '指令回复 · 模拟示例');
  assert.ok((await evaluate('document.getElementById("plugin-save-state").textContent')).includes('保存后默认停用'));
  await value('plugin-config', '{ invalid'); await click('plugin-save');
  await wait('document.getElementById("plugin-editor-error").textContent.includes("JSON")');
  assert.equal(await evaluate('document.activeElement.id'), 'plugin-editor-error');
  await value('plugin-config', JSON.stringify({ command: '/ping', response: 'pong！插件运行正常。' }, null, 2));
  await click('plugin-save'); await wait('document.querySelectorAll(".plugin-row").length===1&&!document.getElementById("plugin-save").disabled');
  assert.equal(workspace.app.plugins.rows()[0].enabled, false);
  await evaluate('document.querySelector(".plugin-row .inline-actions button:nth-child(2)").click()');
  await wait('document.querySelector(".plugin-row-title").textContent.includes("已启用")');
  workspace.app.adapter.driver.inject(incoming(2026102701, { message: '/ping' }));
  for (let n = 0; n < 100 && workspace.app.plugins.tasks.size; n++) await delay(50);
  assert.equal(workspace.app.store.list()[0].reason, 'plugin_handled');
  await click('plugin-reload'); await wait('document.getElementById("plugin-list").textContent.includes("执行 1 次")');
  checks.push('JSON errors, save, enable and live command reply');
  // Preview must show code output as text, including hostile markup.
  await value('plugin-config', JSON.stringify({ command: '/ping', response: '<img src=x onerror="window.pluginXss=1">' }));
  await click('plugin-test-run'); await wait('document.getElementById("plugin-test-result").textContent.includes("<img")');
  assert.equal(await evaluate('window.pluginXss'), undefined);
  assert.equal(await evaluate('document.getElementById("plugin-test-result").querySelectorAll("img").length'), 0);
  await value('plugin-config', JSON.stringify({ command: '/ping', response: 'pong！插件运行正常。' }, null, 2));
  await click('plugin-test-run'); await wait('document.getElementById("plugin-test-result").textContent.includes("测试会话匹配")');
  await screenshot('desktop');
  for (const width of [1024, 768, 680, 390, 320]) {
    await viewport(width);
    if (width === 390) await screenshot('mobile');
    if (width === 320) await screenshot('mobile-320');
  }
  checks.push('escaped preview, matching scope, responsive layout at 1440/1024/768/680/390/320');
  await viewport(1440);
  await value('plugin-source', 'export default () => { while(true){} }');
  expectedHttpFailures.set('/plugins/test|400', 1);
  await value('plugin-timeout', '150'); await click('plugin-test-run');
  await wait('document.getElementById("plugin-test-result").textContent.includes("超时")');
  await value('plugin-source', pluginTemplate.source); await value('plugin-timeout', '3000');
  await click('plugin-save'); await wait('!document.getElementById("plugin-save").disabled&&document.getElementById("plugin-save-state").textContent.includes("已保存")');
  // Emulate a stale editor in a second window, preserving its draft on failure.
  const current = workspace.app.plugins.rows()[0];
  await workspace.app.plugins.toggle({ id: current.id, revision: current.revision, enabled: false });
  expectedHttpFailures.set('/plugins/save|409', 1);
  await value('plugin-description', '这是未保存的草稿'); await click('plugin-save');
  await wait('document.getElementById("plugin-editor-error").textContent.includes("其他窗口")');
  assert.equal(await evaluate('document.activeElement.id'), 'plugin-editor-error');
  assert.equal(await evaluate('document.getElementById("plugin-description").value'), '这是未保存的草稿');
  await screenshot('conflict-desktop'); checks.push('timeout recovery and conflict preserves draft');
  await click('plugin-create'); await wait('document.getElementById("confirm-dialog").open');
  await click('confirm-cancel'); assert.equal(await evaluate('document.getElementById("plugin-description").value'), '这是未保存的草稿');
  await click('plugin-create'); await wait('document.getElementById("confirm-dialog").open'); await click('confirm-ok');
  await wait('document.getElementById("plugin-editor-title").textContent==="新建插件"');
  checks.push('unsaved draft confirmation and cancel');
  const fixture = join(data, 'import.json'); await writeFile(fixture, JSON.stringify({ ...pluginTemplate, name: '导入插件 · 模拟示例' }));
  // Clear the newly created draft through its confirmation before import.
  const doc = await send('DOM.getDocument'), node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#plugin-file' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [fixture] });
  await wait('document.getElementById("confirm-dialog").open'); await click('confirm-ok');
  await wait('document.getElementById("plugin-name").value.includes("导入插件")');
  await click('plugin-save'); await wait('document.querySelectorAll(".plugin-row").length===2');
  assert.equal(workspace.app.plugins.rows().filter(p => p.enabled).length, 0);
  await evaluate('document.querySelector(".plugin-row .inline-actions button:nth-child(3)").click()');
  await wait('document.getElementById("confirm-dialog").open'); await click('confirm-ok');
  await wait('document.querySelectorAll(".plugin-row").length===1');
  await evaluate('document.querySelector(".plugin-row .inline-actions button").click()');
  await wait('!document.getElementById("plugin-editor").hidden&&!document.getElementById("plugin-save").disabled');
  await value('plugin-description', '已停用插件的模拟草稿');
  assert.ok((await evaluate('document.getElementById("plugin-save-state").textContent')).includes('保存后仍停用'));
  await value('plugin-config', '{invalid'); await viewport(390); await click('plugin-save');
  await wait('document.getElementById("plugin-editor-error").textContent.includes("JSON")');
  assert.equal(await evaluate('document.activeElement.id'), 'plugin-editor-error');
  assert.equal(await evaluate('(()=>{const r=document.getElementById("plugin-editor-error").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()'), true);
  await screenshot('validation-mobile'); checks.push('mobile inline validation visible and focused; default-disabled draft copy');
  await value('plugin-config', JSON.stringify(pluginTemplate.config));
  await click('plugin-save'); await wait('!document.getElementById("plugin-save").disabled&&document.getElementById("plugin-save-state").textContent.includes("已保存")');
  await viewport(1440);
  await value('plugin-search', '不存在的插件'); await wait('document.getElementById("plugin-list").textContent.includes("没有匹配")');
  await value('plugin-search', ''); checks.push('import defaults to disabled, deletion, search');
  await click('plugin-close'); await viewport(1440); await screenshot('list-desktop');
  await viewport(390); await screenshot('list-mobile');

  // Saved VoiceStudio profiles: use explicit fixtures, never the user's TTS.
  await viewport(1440);
  let voiceMode = 'normal', pendingVoiceLookup;
  const voiceRequests = [], fixtureVoices = [{ voice_id: 'alloy', name: 'Alias is not a saved voice', type: 'openai_alias' },
    { voice_id: 'saved-fy', name: 'fy · 模拟音色', type: 'profile', language: 'Auto' },
    { voice_id: 'saved-other', name: '<img src=x onerror="window.voiceXss=1">', type: 'profile' }];
  workspace.app.voicestudio.voices = async draft => {
    voiceRequests.push(draft.config.base_url);
    if (voiceMode === 'failure') throw Object.assign(new Error('模拟 VoiceStudio 暂不可用'), { status: 503 });
    if (voiceMode === 'pending') return new Promise(resolve => { pendingVoiceLookup = resolve; });
    return { voices: voiceMode === 'empty' ? [] : fixtureVoices, total: voiceMode === 'empty' ? 0 : 2, engines: [] };
  };
  const voiceOriginal = await workspace.app.plugins.install({ kind: 'voicestudio' });
  await workspace.app.plugins.save({ id: voiceOriginal.id, revision: voiceOriginal.revision, plugin: { ...voiceOriginal, name: '本地 VoiceStudio · 模拟示例', scope: { ...voiceOriginal.scope, private_users: ['10001'] } } });
  await click('plugin-reload'); await wait('document.querySelectorAll(".plugin-row").length===2');
  await evaluate('void openPlugin(' + JSON.stringify(voiceOriginal.id) + ')');
  await wait('document.getElementById("plugin-voice-select").querySelector(\'option[value="saved-fy"]\')&&!document.getElementById("plugin-voice-select").disabled');
  assert.equal(await evaluate('document.getElementById("plugin-voice-settings").hidden'), false);
  assert.equal(await evaluate('document.getElementById("plugin-voice-output").hidden'), false);
  assert.equal(await evaluate('document.getElementById("plugin-voice-probability").value'), '0');
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").value'), 'default');
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").querySelector(\'option[value="alloy"]\')'), null);
  assert.equal(await evaluate('window.voiceXss'), undefined);
  assert.equal(await evaluate('document.getElementById("plugin-save-state").textContent.includes("未保存")'), false);
  await evaluate('document.getElementById("plugin-voice-select").value="saved-fy";document.getElementById("plugin-voice-select").dispatchEvent(new Event("change",{bubbles:true}))');
  assert.equal(await evaluate('JSON.parse(document.getElementById("plugin-config").value).voice'), 'saved-fy');
  await value('plugin-voice-probability','35');assert.equal(await evaluate('JSON.parse(document.getElementById("plugin-config").value).reply_probability'),.35);
  await value('plugin-voice-probability','101');assert.equal(await evaluate('document.getElementById("plugin-voice-probability").checkValidity()'),false);await value('plugin-voice-probability','35');
  await click('plugin-save'); await wait('!document.getElementById("plugin-save").disabled&&!document.getElementById("plugin-voice-select").disabled');
  assert.equal(workspace.app.plugins.get(voiceOriginal.id).config.voice, 'saved-fy');
  assert.equal(workspace.app.plugins.get(voiceOriginal.id).enabled, false);
  assert.equal(workspace.app.plugins.get(voiceOriginal.id).config.reply_probability,.35);
  await evaluate('void openPlugin('+JSON.stringify(voiceOriginal.id)+')');await wait('document.getElementById("plugin-voice-probability").value==="35"&&!document.getElementById("plugin-save").disabled');
  const probabilityConfig=await evaluate('JSON.parse(document.getElementById("plugin-config").value)');await value('plugin-config',JSON.stringify({...probabilityConfig,reply_probability:.625},null,2));assert.equal(await evaluate('document.getElementById("plugin-voice-probability").value'),'62.5');
  await click('plugin-save');await wait('!document.getElementById("plugin-save").disabled');assert.equal(workspace.app.plugins.get(voiceOriginal.id).config.reply_probability,.625);
  checks.push('voice probability defaults to zero, validates percent, syncs JSON, persists and reloads');
  const draft = await evaluate('JSON.parse(document.getElementById("plugin-config").value)');
  await value('plugin-config', JSON.stringify({ ...draft, voice: 'saved-other' }, null, 2));
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").value'), 'saved-other');
  await value('plugin-config', JSON.stringify({ ...draft, base_url: 'http://127.0.0.1:3901' }, null, 2));
  await click('plugin-voices-refresh'); await wait('!document.getElementById("plugin-voices-refresh").disabled');
  assert.equal(voiceRequests.at(-1), 'http://127.0.0.1:3901');
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").value'), 'saved-fy');
  checks.push('saved voice profiles load, exclude aliases, escape names, sync JSON and persist without enabling the plugin');

  voiceMode = 'failure'; expectedHttpFailures.set('/voicestudio/voices|502', 1);
  await click('plugin-voices-refresh'); await wait('!document.getElementById("plugin-voices-error").hidden&&!document.getElementById("plugin-voices-refresh").disabled');
  assert.equal(await evaluate('JSON.parse(document.getElementById("plugin-config").value).voice'), 'saved-fy');
  voiceMode = 'empty'; await click('plugin-voices-refresh'); await wait('document.getElementById("plugin-voices-status").textContent.includes("尚无")');
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").value'), 'saved-fy');
  voiceMode = 'normal'; await click('plugin-voices-refresh'); await wait('document.getElementById("plugin-voice-select").querySelector(\'option[value="saved-other"]\')&&!document.getElementById("plugin-voices-refresh").disabled');
  checks.push('failed or empty voice queries preserve the selected default and allow refresh recovery');
  for (const width of [1440, 390, 320]) {
    await viewport(width);
    await evaluate('document.getElementById("plugin-voice-settings").scrollIntoView({block:"center"})');
    const geometry = await evaluate('(()=>{const s=document.getElementById("plugin-voice-select"),r=s.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,label:document.querySelector(\'label[for="plugin-voice-select"]\')?.textContent};})()');
    assert.ok(geometry.label.includes('已保存音色')); assert.ok(geometry.left >= 0 && geometry.right <= width);
    if (width < 681) assert.ok(geometry.height >= 44);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(output, 'voice-picker-' + width + '.png'), Buffer.from(shot.data, 'base64'));
  }
  checks.push('saved voice picker is labeled and fits desktop, 390 and 320 pixel layouts');
  for(const width of [1440,390,320]){await viewport(width);await evaluate('document.getElementById("plugin-voice-probability").scrollIntoView({block:"center"});document.getElementById("toast").hidden=true');const geometry=await evaluate('(()=>{const e=document.getElementById("plugin-voice-probability"),r=e.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,label:document.querySelector(\'label[for="plugin-voice-probability"]\').textContent,value:e.value};})()');assert.ok(geometry.label.includes('语音输出概率'));assert.equal(geometry.value,'62.5');assert.ok(geometry.left>=0&&geometry.right<=width);if(width<681)assert.ok(geometry.height>=44);const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,'voice-probability-'+width+'.png'),Buffer.from(shot.data,'base64'));}
  checks.push('voice probability field is labeled and usable at desktop, 390 and 320 pixels');

  await viewport(1440); voiceMode = 'pending'; pendingVoiceLookup = null;
  await click('plugin-voices-refresh'); for (let n = 0; n < 100 && !pendingVoiceLookup; n++) await delay(20); assert.ok(pendingVoiceLookup);
  const changed = await evaluate('JSON.parse(document.getElementById("plugin-config").value)');
  await value('plugin-config', JSON.stringify({ ...changed, base_url: 'http://127.0.0.1:3902' }, null, 2));
  pendingVoiceLookup({ voices: [{ voice_id: 'stale-voice', name: '旧服务音色', type: 'profile' }], total: 1 });
  await delay(150);
  assert.equal(await evaluate('document.getElementById("plugin-voice-select").querySelector(\'option[value="stale-voice"]\')'), null);
  assert.ok((await evaluate('document.getElementById("plugin-voices-status").textContent')).includes('服务配置已变更'));
  voiceMode = 'normal'; await click('plugin-voices-refresh'); await wait('!document.getElementById("plugin-voices-refresh").disabled');
  await click('plugin-save'); await wait('!document.getElementById("plugin-save").disabled&&!document.getElementById("plugin-voices-refresh").disabled');
  voiceMode = 'pending'; pendingVoiceLookup = null; await click('plugin-voices-refresh');
  for (let n = 0; n < 100 && !pendingVoiceLookup; n++) await delay(20); assert.ok(pendingVoiceLookup);
  const script = workspace.app.plugins.rows().find(p => p.kind === 'script');
  await evaluate('void openPlugin(' + JSON.stringify(script.id) + ')'); await wait('document.getElementById("plugin-voice-settings").hidden&&!document.getElementById("plugin-save").disabled');
  pendingVoiceLookup({ voices: fixtureVoices, total: 2 }); await delay(150);
  assert.equal(await evaluate('pluginDraftKind'), 'script'); assert.equal(await evaluate('JSON.parse(document.getElementById("plugin-config").value).command'), '/ping');
  checks.push('late voice responses cannot overwrite a different service or editor');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(verifiedHttpFailures, 3, 'intentional timeout, conflict and voice lookup failure were observed');
  const report = { success: true, checks, javascriptOrCspErrors: errors.length, expectedHttpFailures: verifiedHttpFailures, screenshots: output };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ success: false, error: error.message, errors, checks }, null, 2)); throw error;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([once(browser, 'exit'), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
  await workspace?.close();
  for (const path of [profile, data]) { assert.equal(dirname(path), temporaryRoot); await rm(path, { recursive: true, force: true }); }
}
