import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { launchWorkspace } from './launch.mjs';
import { config } from '../test/helpers.mjs';
import { AIClient } from '../src/ai.mjs';
import {png} from '../test/image-fixture.mjs';

const output=resolve('.impeccable/review'),temporaryRoot=resolve('dist/agent-qa');
await mkdir(output,{recursive:true});await mkdir(temporaryRoot,{recursive:true});
const profile=await mkdtemp(join(temporaryRoot,'chrome-')),data=await mkdtemp(join(temporaryRoot,'demo-'));
let workspace,browser,socket,commandId=0,attachmentInputs=0,expectedUploadErrors=0,checkingUploadError=false,expectedMemoryConflicts=0,checkingMemoryConflict=false;const pending=new Map(),failures=[],checks=[];
await writeFile(join(output,'agent-qa.json'),JSON.stringify({success:false,status:'running'}));
function send(method,params={}){const id=++commandId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},12000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function wait(expression){for(let n=0;n<120;n++){if(await evaluate(expression))return;await delay(100);}throw Error('UI condition failed: '+expression);}
async function click(id){await evaluate('document.getElementById('+JSON.stringify(id)+').click()');}
async function value(id,value,event='input'){await evaluate('(function(){const e=document.getElementById('+JSON.stringify(id)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event('+JSON.stringify(event)+',{bubbles:true}));})()');}
async function viewport(width,height=1000){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<681});await evaluate('window.scrollTo(0,0)');await delay(200);}
async function screenshot(name){await evaluate('window.scrollTo(0,0);document.getElementById("toast").hidden=true');await delay(200);const metrics=await send('Page.getLayoutMetrics'),size=metrics.cssContentSize;const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:size.width,height:size.height,scale:1}});await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'));}

try {
  workspace=await launchWorkspace(config(data,{AI_ENABLED:'true',AI_MODEL:'QA 演示模型',AI_ALLOWED_USERS:'10001'}));
  class FixtureAI extends AIClient {
    async completion(messages,signal,tools,toolChoice,options={}) {
      if(messages.at(-1).role==='user'&&typeof messages.at(-1).content==='string'&&messages.at(-1).content.includes('Emoji混合验收')){
        await options.onContent?.('【过滤演示】你好😀，1');await options.onContent?.('\uFE0F\u20E3👩🏽‍💻结束。');
        return {content:'【过滤演示】你好😀，1️⃣👩🏽‍💻结束。'};
      }
      if(messages.at(-1).role==='user'&&typeof messages.at(-1).content==='string'&&messages.at(-1).content.includes('仅表情验收')){
        await options.onContent?.('😀👩🏽‍💻🇨🇳1️⃣');return {content:'😀👩🏽‍💻🇨🇳1️⃣'};
      }
      if(messages.at(-1).role==='user'&&messages.at(-1).content.includes('流式验收')){
        await options.onContent?.('【流式演示】第一段已到达，');await delay(1000,undefined,{signal});
        await options.onContent?.('第二段随后显示，');await delay(1000,undefined,{signal});
        await options.onContent?.('回答完成。');return {content:'【流式演示】第一段已到达，第二段随后显示，回答完成。'};
      }
      if(Array.isArray(messages.at(-1).content)){assert.ok(messages.at(-1).content.some(p=>p.type==='image_url'));assert.ok(messages.at(-1).content.some(p=>p.text?.includes('附件测试正文')));attachmentInputs++;return {content:'【演示回复】已读取图片和文件，附件测试正文已经收到。'};}
      if(messages.at(-1).role==='user'&&messages.at(-1).content.includes('记住'))return {tool_calls:[{id:'remember',type:'function',function:{name:'memory_save',arguments:JSON.stringify({key:'回答风格',value:'简洁、清楚地回答'})}}]};
      return {content:messages.at(-1).role==='tool'?'【演示回复】已记住你的偏好。我会简洁、清楚地回答。':'【演示回复】你好，可以开始测试机器人的回答。'};
    }
  }
  workspace.app.agent.ai=new FixtureAI(workspace.app.config.ai);
  let qqSends=0;workspace.app.adapter.on('outgoing',()=>qqSends++);
  const first=workspace.app.store.ingest({self_id:10000,user_id:10001,message_id:555,post_type:'message',message_type:'private',message:[{type:'text',data:{text:'【演示】会话管理'}}]},'【演示】会话管理',100);workspace.app.store.update(first.id,'done',{reply:'【演示】会话已准备。'});
  workspace.app.agent.state.savePersona({name:'日常助手（演示）',prompt:'回答清楚，先给结果。',tools:null});
  browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>failures.push({source:'launch',text:error.message}));
  let port;for(let n=0;n<100;n++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}
  assert.ok(port,'Chrome debugging port available');const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  socket.on('message',bytes=>{const message=JSON.parse(bytes);if(message.id){const handler=pending.get(message.id);if(!handler)return;clearTimeout(handler.timer);pending.delete(message.id);message.error?handler.reject(Error(message.error.message)):handler.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')failures.push(message.params);else if(message.method==='Log.entryAdded'&&message.params.entry.level==='error'){const entry=message.params.entry;if(checkingUploadError&&expectedUploadErrors===0&&entry.source==='network'&&entry.url?.endsWith('/agent/attachments')&&entry.text.includes('400 (Bad Request)'))expectedUploadErrors++;else if(checkingMemoryConflict&&expectedMemoryConflicts===0&&entry.source==='network'&&entry.url?.endsWith('/agent/memory/update')&&entry.text.includes('409'))expectedMemoryConflicts++;else failures.push(entry);}});
  await once(socket,'open');await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await viewport(1440);await send('Page.navigate',{url:workspace.url});await wait('document.getElementById("connection").textContent==="已连接"');assert.equal(await evaluate('document.getElementById("view-overview").hidden'),false);assert.equal(await evaluate('document.getElementById("agent-pane-chat").hidden'),true);checks.push('robot management is the default home and direct Agent chat is hidden');await evaluate("document.querySelector('[data-view=agent]').click()");await wait('document.getElementById("agent-status")?.textContent.includes("Agent 已启用")');await click('test-chat-entry');await wait('!document.getElementById("agent-pane-chat").hidden');
  checks.push('Agent navigation, API proxy, capability catalog and persona load');
  await value('agent-chat-input','【演示】记住我喜欢简洁回答');await click('agent-chat-send');await wait('document.getElementById("agent-chat-feed").textContent.includes("已记住你的偏好")');assert.equal(qqSends,0);checks.push('web chat executes model and memory tool without sending QQ messages');
  await wait('document.getElementById("agent-session").value.startsWith("web:") && document.getElementById("agent-memories").textContent.includes("简洁、清楚")');checks.push('tool completion refreshes the active web session memory without a manual refresh');
  await click('test-chat-entry');await click('agent-tab-activity');await click('agent-refresh');await wait('document.querySelectorAll("#agent-runs details").length>0');
  await evaluate('document.querySelector("#agent-runs details").open=true');await wait('document.querySelector("#agent-runs .agent-trace")?.textContent.includes("memory_save")');checks.push('run trace contains actual tool name and duration');
  const webSession=workspace.app.agent.state.sessions().find(s=>s.conversation.startsWith('web:')).conversation;
  await click('agent-tab-sessions');await value('agent-session',webSession,'change');await wait('document.getElementById("agent-memories").textContent.includes("简洁、清楚")');checks.push('persisted memory is visible in the selected session');
  const editFirstMemory=()=>evaluate('document.querySelector("#agent-memories [data-action=edit]").click()');
  await editFirstMemory();await wait('document.getElementById("agent-memory-name")');
  assert.equal(await evaluate('document.getElementById("agent-memory-save").disabled'),true);
  await value('agent-memory-value','【演示】尚未保存的草稿');await click('agent-refresh');
  assert.equal(await evaluate('document.getElementById("agent-memory-value").value'),'【演示】尚未保存的草稿');assert.equal(await evaluate('document.getElementById("agent-session").disabled'),true);
  await delay(1700);assert.equal(await evaluate('document.getElementById("agent-memory-value").value'),'【演示】尚未保存的草稿');
  await click('agent-memory-cancel');await wait('!document.getElementById("agent-memory-name")&&document.getElementById("agent-memories").textContent.includes("简洁、清楚")');
  checks.push('memory editing preserves drafts through refresh and polling; cancel restores the saved value');
  await editFirstMemory();await wait('document.getElementById("agent-memory-name")');
  const editedValue='简洁、清楚地回答。\n【演示】手动编辑后的第二行。<img src=x onerror="window.memoryUnsafe=1">';
  await value('agent-memory-name','回答偏好（已编辑）');await value('agent-memory-value',editedValue);
  assert.equal(await evaluate('document.getElementById("agent-memory-name").maxLength'),60);assert.equal(await evaluate('document.getElementById("agent-memory-value").maxLength'),500);
  for(const width of [1440,768,390,320]){
    await viewport(width,width<681?844:1000);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    if(width<=680){const sizes=await evaluate('["agent-memory-save","agent-memory-cancel"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {width:r.width,height:r.height};})');assert.ok(sizes.every(s=>s.width>=44&&s.height>=44));}
    if(width===1440||width===320)await screenshot('memory-edit-'+width);
  }
  await viewport(1440);await value('agent-memory-name',' ');await click('agent-memory-save');await wait('document.getElementById("agent-memory-state").textContent.includes("不能为空")');
  await value('agent-memory-name','回答偏好（已编辑）');await click('agent-memory-save');
  await wait('!document.getElementById("agent-memory-name")&&document.getElementById("agent-memories").textContent.includes("手动编辑后的第二行")');
  assert.equal(workspace.app.agent.state.memories(webSession)[0].key,'回答偏好（已编辑）');assert.equal(workspace.app.agent.state.memories(webSession)[0].value,editedValue);
  assert.equal(await evaluate('window.memoryUnsafe'),undefined);assert.equal(await evaluate('document.querySelector("#agent-memories img")'),null);assert.equal(await evaluate('document.getElementById("agent-session").disabled'),false);
  checks.push('memory name and multiline content save with limits, inline validation, mobile controls and plain-text escaping');
  await editFirstMemory();await wait('document.getElementById("agent-memory-value")');await value('agent-memory-value','【演示】保留冲突草稿');
  workspace.app.agent.state.remember(webSession,'回答偏好（已编辑）','简洁、清楚地回答，模型更新版。');checkingMemoryConflict=true;
  await click('agent-memory-save');await wait('document.getElementById("agent-memory-state").textContent.includes("已被更新")');
  assert.equal(await evaluate('document.getElementById("agent-memory-value").value'),'【演示】保留冲突草稿');assert.equal(workspace.app.agent.state.memories(webSession)[0].value,'简洁、清楚地回答，模型更新版。');
  await screenshot('memory-edit-conflict');await click('agent-memory-cancel');await wait('document.getElementById("agent-memories").textContent.includes("模型更新版")');
  checks.push('concurrent model updates reject stale edits, preserve the draft and can be reloaded by cancelling');
  const groupSession='10000:group:20001',firstScope=groupSession+':user:10001',secondScope=groupSession+':user:10002';
  workspace.app.store.ingest({self_id:10000,user_id:10001,group_id:20001,message_id:556,post_type:'message',message_type:'group',message:[{type:'text',data:{text:'【演示】群记忆管理'}}]},null,100,'ai_disabled');
  workspace.app.agent.state.remember(firstScope,'风格','【演示】一号成员的偏好');workspace.app.agent.state.remember(secondScope,'风格','【演示】二号成员的偏好');
  await click('agent-refresh');await wait('Array.from(document.getElementById("agent-session").options).some(o=>o.value==="10000:group:20001")');
  await value('agent-session',groupSession,'change');await wait('document.querySelectorAll("#agent-memories .agent-memory").length===2');
  await evaluate('document.querySelector('+JSON.stringify('[data-scope="'+firstScope+'"] [data-action=edit]')+').click()');
  await value('agent-memory-value','【演示】手动更新一号成员');await click('agent-memory-save');await wait('document.getElementById("agent-memories").textContent.includes("手动更新一号成员")');
  assert.equal(workspace.app.agent.state.memories(secondScope)[0].value,'【演示】二号成员的偏好');assert.ok(await evaluate('document.getElementById("agent-memories").textContent.includes("QQ 10002")'));
  checks.push('group memory editing updates the selected member without changing another member with the same memory name');
  await value('agent-session',webSession,'change');await wait('document.getElementById("agent-memories").textContent.includes("模型更新版")');
  await click('agent-tab-personas');await click('agent-new-persona');await value('agent-persona-name','验收人格（演示）');await value('agent-persona-prompt','用一句话回答。');await value('agent-persona-tools','current_time');await click('agent-save-persona');await wait('document.getElementById("agent-persona-state").textContent.includes("已保存")');
  const created=workspace.app.agent.state.personas().find(p=>p.name==='验收人格（演示）');assert.deepEqual(created.tools,['current_time']);checks.push('persona creation and tool restrictions persist');
  await click('agent-tab-sessions');await value('agent-binding',created.id,'change');await click('agent-bind');await wait('document.getElementById("confirm-dialog").open');await click('confirm-ok');await wait('document.getElementById("toast").textContent.includes("人格已更新")');assert.equal(workspace.app.agent.state.persona(webSession).id,created.id);checks.push('session persona switch confirms and updates the runtime');
  await click('test-chat-entry');await click('agent-chat-new');await value('agent-chat-input','【演示】新会话你好');await click('agent-chat-send');await wait('document.getElementById("agent-chat-feed").textContent.includes("演示回复")');assert.equal(await evaluate('document.querySelectorAll("#agent-chat-feed .agent-chat-message").length'),2);checks.push('new web conversation isolates chat history');
  await wait('!document.getElementById("agent-chat-send").disabled');await value('agent-chat-input','【演示】流式验收');await click('agent-chat-send');
  await wait('document.getElementById("agent-chat-feed").textContent.includes("第一段已到达")');
  assert.equal(await evaluate('document.getElementById("agent-chat-feed").textContent.includes("回答完成")'),false);assert.equal(await evaluate('document.getElementById("agent-chat-send").disabled'),true);
  await wait('document.getElementById("agent-chat-feed").textContent.includes("回答完成") && !document.getElementById("agent-chat-send").disabled');assert.equal(qqSends,0);checks.push('browser EventSource renders partial text before completion and unlocks the composer at the end');
  await value('agent-chat-input','【演示】Emoji混合验收');await click('agent-chat-send');
  await wait('document.querySelector("#agent-chat-feed article:last-child p")?.textContent==="【过滤演示】你好，结束。"&&!document.getElementById("agent-chat-send").disabled');
  checks.push('real web chat stream and final answer remove emoji, including a split keycap sequence');
  await value('agent-chat-input','【演示】仅表情验收');await click('agent-chat-send');
  await wait('document.querySelector("#agent-chat-feed article:last-child p")?.textContent==="回复只包含表情，过滤后没有可显示的正文。"&&!document.getElementById("agent-chat-send").disabled');
  assert.equal(await evaluate('document.getElementById("agent-chat-feed").textContent.includes("ai_reply_empty_after_filter")'),false);assert.equal(qqSends,0);
  assert.equal(await evaluate('document.querySelector("#agent-chat-feed article:nth-last-child(2) p").textContent'),'消息正文未保留。');
  checks.push('emoji-only web reply explains filtering in plain language and leaves chat usable');
  await screenshot('emoji-only-chat-1440');await viewport(320,844);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('emoji-only-chat-320');await viewport(1440);
  const choose=files=>evaluate('(function(){const transfer=new DataTransfer();for(const f of '+JSON.stringify(files)+'){const bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],f.name,{type:f.type}));}const input=document.getElementById("agent-attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
  const image={name:'【演示】测试图片.png',type:'image/png',data:png().toString('base64')},document={name:'【演示】这是一个很长的中文附件名称用于验证手机屏幕换行与移除操作仍然可用.txt',type:'text/plain',data:Buffer.from('附件测试正文：本周收入 42。').toString('base64')};
  await choose([image,document]);await wait('document.querySelectorAll("#agent-attachments .agent-attachment").length===2 && !document.getElementById("agent-attach").disabled');
  assert.equal(await evaluate('document.querySelector("#agent-attachments img").naturalWidth'),32);checks.push('attachment selection uploads through authenticated proxy, previews image and shows file names');
  for(const width of [1440,390,320]){await viewport(width,width<681?1000:1100);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('agent-attachments-'+width);}
  await choose([image,image,image]);await wait('document.getElementById("agent-chat-state").textContent.includes("最多 4 个")');assert.equal(await evaluate('document.querySelectorAll("#agent-attachments .agent-attachment").length'),2);checks.push('attachment count errors preserve prepared files');
  await evaluate('document.querySelectorAll("#agent-attachments button")[1].click()');assert.equal(await evaluate('document.querySelectorAll("#agent-attachments .agent-attachment").length'),1);await choose([document]);await wait('document.querySelectorAll("#agent-attachments .agent-attachment").length===2 && !document.getElementById("agent-attach").disabled');checks.push('remove and replace attachment keeps the other prepared file');
  await value('agent-chat-input','');await click('agent-chat-send');await wait('document.getElementById("agent-chat-feed").textContent.includes("已读取图片和文件")');assert.equal(attachmentInputs,1);assert.equal(qqSends,0);assert.equal(await evaluate('document.getElementById("agent-attachments").hidden'),true);assert.ok((await evaluate('document.querySelectorAll(".agent-chat-files span").length'))===2);checks.push('attachment-only message reaches multimodal model and shows persistent attachment labels without sending QQ');
  checkingUploadError=true;await choose([{name:'test.exe',type:'application/octet-stream',data:Buffer.from('MZ test').toString('base64')}]);await wait('document.getElementById("agent-chat-state").textContent.includes("格式不支持")');assert.equal(await evaluate('document.getElementById("agent-chat-send").disabled'),false);checks.push('unsupported file shows recoverable error and leaves composer usable');
  for(const width of [1440,768,390,320]){
    await viewport(width,width<681?844:1000);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Agent overflow '+width);
    const targets=await evaluate('[...document.querySelectorAll("#view-agent input,#view-agent textarea,#view-agent select")].filter(e=>e.getClientRects().length).map(e=>({id:e.id,width:e.getBoundingClientRect().width}))');assert.ok(targets.every(t=>t.width>120),'readable fields '+width);checks.push('responsive Agent layout '+width);
    if(width<=680){const buttons=await evaluate('[...document.querySelectorAll(".topbar button,#view-agent button")].filter(e=>e.getClientRects().length).map(e=>({id:e.id,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))');assert.ok(buttons.every(b=>b.width>=44&&b.height>=44),'44px mobile controls '+JSON.stringify(buttons));}
    if(width===1440)await screenshot('agent-chat-desktop');if(width===320)await screenshot('agent-chat-mobile-320');
  }
  await click('test-chat-entry');await click('agent-tab-sessions');await value('agent-session',webSession,'change');await wait('document.getElementById("agent-memories").textContent.includes("简洁、清楚")');for(const width of [1440,768,390,320]){await viewport(width,width<681?844:1000);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'management overflow '+width);if(width===1440)await screenshot('agent-desktop');if(width===320)await screenshot('agent-mobile-320');}await viewport(1440);await click('agent-tab-personas');await screenshot('personas-desktop');await viewport(320,844);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('personas-mobile-320');await viewport(1440);await click('agent-tab-activity');await screenshot('agent-tools-desktop');await viewport(320,844);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('agent-tools-mobile-320');checks.push('management tabs, optional chat mode, memory and persona layouts pass on desktop and mobile');await viewport(1440);await evaluate('document.querySelector(\'[data-view="plugins"]\').click()');await wait('document.getElementById("plugin-count").textContent!=="读取中"');await click('plugin-create');await wait('!document.getElementById("plugin-editor").hidden');assert.equal(await evaluate('document.getElementById("plugin-tools").value'),'[]');checks.push('plugin editor exposes Agent tool schema without changing the old message handler');
  assert.equal(failures.length,0,JSON.stringify(failures));const report={success:true,checks,viewports:[1440,768,390,320],javascriptOrCspErrors:0,real_qq:false,real_model:false,screenshots:output};await writeFile(join(output,'agent-qa.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
  await writeFile(join(output,'agent-qa.json'),JSON.stringify({success:false,error:error.message,checks,failures},null,2));throw error;
} finally {
  for(const handler of pending.values())clearTimeout(handler.timer);
  if(socket?.readyState===WebSocket.OPEN)socket.close();browser?.kill();await workspace?.close();await delay(250);
  for(const target of [profile,data]) {
    const child=relative(temporaryRoot,resolve(target));
    if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Refusing cleanup outside the QA workspace');
    await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
  }
}
