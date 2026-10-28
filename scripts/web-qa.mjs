import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { launchWorkspace } from './launch.mjs';
import { config, incoming } from '../test/helpers.mjs';

const output=resolve('.impeccable/review'), temporaryRoot=resolve('dist/web-qa');
await mkdir(output,{recursive:true});await mkdir(temporaryRoot,{recursive:true});
await writeFile(join(output,'web-qa.json'),JSON.stringify({success:false,status:'running'}));
const profile=await mkdtemp(join(temporaryRoot,'chrome-')),data=await mkdtemp(join(temporaryRoot,'demo-'));
let workspace,browser,socket,commandId=0;const pending=new Map(),failures=[],checks=[],layoutMetrics=[],contrastMetrics=[];
function send(method,params={}){const id=++commandId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},12000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function wait(expression){for(let n=0;n<120;n++){if(await evaluate(expression))return;await delay(100);}throw Error('UI condition failed: '+expression);}
async function click(id){await evaluate('document.getElementById('+JSON.stringify(id)+').click()');}
async function value(id,value){await evaluate('(function(){const e=document.getElementById('+JSON.stringify(id)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));})()');}
async function navigate(view){
  if(['messages','jobs','logs'].includes(view)){
    if(await evaluate('document.getElementById("view-monitor").hidden'))await evaluate('document.querySelector(\'[data-view="monitor"]\').click()');
    await click('monitor-tab-'+view);
    await wait('!document.getElementById("view-monitor").hidden&&!document.getElementById("view-'+view+'").hidden');
  }else{await evaluate('document.querySelector(\'[data-view="'+view+'"]\').click()');await wait('!document.getElementById("view-'+view+'").hidden');}
}
async function viewport(width,height=1000){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<681});await evaluate('window.scrollTo(0,0)');await delay(260);}
async function noOverflow(name){assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,name);checks.push(name);}
async function screenshot(name){await evaluate('window.scrollTo(0,0);document.getElementById("toast").hidden=true');await delay(260);const metrics=await send('Page.getLayoutMetrics'),size=metrics.cssContentSize;const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:size.width,height:size.height,scale:1}});await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'));}
try{
  workspace=await launchWorkspace(config(data,{AI_API_KEY:'web-qa-fixture-key'}));
  workspace.app.adapter.driver.inject(incoming(20261025,{message:'【演示消息】你好，助手已经连接了吗？',sender:{user_id:10001,nickname:'演示用户'}}));
  workspace.app.adapter.driver.inject(incoming(20261026,{kind:'group',groupId:20001,message:'【演示群聊】请帮忙整理一下今天的待办。',sender:{user_id:10002,nickname:'演示群成员'}}));
  await workspace.app.adapter.action('send_private_msg',{user_id:10001,message:'【演示回复】你好，连接正常。这是一条用于验收消息监听的模拟回复。'});
  workspace.app.telemetry.add('log',{level:'warn',event:'ai_reply_send_failed',fields:{job:2,state:'uncertain'}});
  const uncertain=workspace.app.store.list()[0];workspace.app.store.update(uncertain.id,'uncertain',{reply:'DEMO delivery review'});

  // Explicit synthetic fixtures cover each distinct task-content state.
  const fixtureEvent=id=>({self_id:10000,user_id:10001,message_id:id,post_type:'message',message_type:'private',message:[{type:'text',data:{text:'【演示原文】白名单外的内容'}}],raw_message:'【演示原文】白名单外的内容'});
  const fixtureStore=workspace.app.store;
  const redactedFixture=fixtureStore.ingest(fixtureEvent(98001),'【演示】已删除输入',100).id;
  fixtureStore.update(redactedFixture,'ignored',{reason:'policy_changed'});
  fixtureStore.retainIgnoredContent=true;
  const filteredFixture=fixtureStore.ingest(fixtureEvent(98002),null,100,'user_not_allowed').id;
  const noTextFixture=fixtureStore.ingest({...fixtureEvent(98003),message:[{type:'image',data:{file:'synthetic-image'}}],raw_message:'[CQ:image]'},null,100,'no_text').id;
  fixtureStore.retainIgnoredContent=false;
  const notStoredFixture=fixtureStore.ingest(fixtureEvent(98004),null,100,'ai_disabled').id;
  const blockedFixture=fixtureStore.ingest({...fixtureEvent(98007),message_type:'group',group_id:20001},null,100,'group_user_blocked').id;
  const emojiFixture=fixtureStore.ingest(fixtureEvent(98008),null,100,'ai_reply_empty_after_filter').id;
  const decisionFixture=fixtureStore.ingest({...fixtureEvent(98005),message_type:'group',group_id:20001},'【演示】读空气候选',100).id;
  fixtureStore.db.prepare('INSERT INTO group_chat_jobs VALUES (?,?,?,?,?,?,?)').run(decisionFixture,'web-qa-fixture',1,'ambient',JSON.stringify({decision:{outcome:'declined',model_reply:false,confidence:0.94,threshold:0.5,reason:'【演示】成员正在互相交谈，机器人没有必要插话。<img src=x onerror="window.judgmentUnsafe=1">'}}),0,Date.now());
  fixtureStore.update(decisionFixture,'ignored',{reason:'group_chat_silent'});
  const decisionFailureFixture=fixtureStore.ingest({...fixtureEvent(98006),message_type:'group',group_id:20001},'【演示】没有判断正文',100).id;
  fixtureStore.db.prepare('INSERT INTO group_chat_jobs VALUES (?,?,?,?,?,?,?)').run(decisionFailureFixture,'web-qa-fixture',1,'ambient',JSON.stringify({decision:{outcome:'error',reason:'模型已达到输出 Token 上限，未返回最终判断正文。',diagnostic:{reason:'ai_reasoning_only',finish_reason:'length',prompt_tokens:658,completion_tokens:512,reasoning_tokens:512,duration_ms:12742,timeout_ms:60000}}}),0,Date.now());
  fixtureStore.update(decisionFailureFixture,'ignored',{reason:'group_chat_silent'});


  browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>failures.push({source:'launch',text:error.message}));
  let port;for(let n=0;n<100;n++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}
  assert.ok(port,'Chrome debugging port available');const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  socket.on('message',bytes=>{const message=JSON.parse(bytes);if(message.id){const handler=pending.get(message.id);if(!handler)return;clearTimeout(handler.timer);pending.delete(message.id);if(message.error)handler.reject(Error(message.error.message));else handler.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')failures.push(message.params);else if(message.method==='Log.entryAdded'&&message.params.entry.level==='error')failures.push(message.params.entry);});
  await once(socket,'open');await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await viewport(1440);await send('Page.navigate',{url:workspace.url});await wait('document.getElementById("connection")?.textContent==="已连接"');
  assert.equal(await evaluate('document.querySelectorAll(".nav [data-view=monitor]").length'),1);
  assert.equal(await evaluate('document.querySelectorAll(".nav [data-view=messages],.nav [data-view=jobs],.nav [data-view=logs]").length'),0);
  await navigate('monitor');
  async function monitorSelected(tab){
    await wait('!document.getElementById("view-monitor").hidden&&document.getElementById("monitor-tab-'+tab+'").getAttribute("aria-selected")==="true"');
    assert.equal(await evaluate('document.querySelectorAll("#view-monitor [role=tabpanel]:not([hidden])").length'),1);
    assert.equal(await evaluate('[...document.querySelectorAll("#view-monitor [role=tab]")].filter(tab=>tab.tabIndex===0).length'),1);
    assert.equal(await evaluate('location.hash'),'#monitor/'+tab);
    assert.equal(await evaluate('document.querySelector(".nav [aria-current=page]").dataset.view'),'monitor');
    assert.equal(await evaluate('document.getElementById("page-title").textContent'),'运行监控');
  }
  await monitorSelected('messages');
  await evaluate('document.getElementById("monitor-tab-messages").focus()');
  for(const [key,tab] of [['ArrowRight','jobs'],['End','logs'],['ArrowRight','messages'],['ArrowLeft','logs'],['Home','messages']]){
    await send('Input.dispatchKeyEvent',{type:'keyDown',key});await send('Input.dispatchKeyEvent',{type:'keyUp',key});
    await monitorSelected(tab);assert.equal(await evaluate('document.activeElement.id'),'monitor-tab-'+tab);
  }
  checks.push('one monitoring navigation entry, exclusive ARIA panels and keyboard tab switching');
  for(const tab of ['jobs','logs','messages']){await evaluate('location.hash='+JSON.stringify(tab));await monitorSelected(tab);}
  await navigate('jobs');await send('Page.reload');await wait('document.getElementById("connection")?.textContent==="已连接"');await monitorSelected('jobs');
  await navigate('messages');await navigate('jobs');await navigate('logs');
  await evaluate('history.back()');await monitorSelected('jobs');await evaluate('history.forward()');await monitorSelected('logs');
  await click('test-chat-entry');await click('test-chat-entry');await monitorSelected('logs');
  for(const tab of ['messages','jobs','logs']){await navigate('overview');await evaluate('document.querySelector(\'[data-go="'+tab+'"]\').click()');await monitorSelected(tab);}
  checks.push('legacy links, reload, browser history, overview shortcuts and return from test chat select the correct monitoring tab');
  await navigate('overview');
  if(process.argv.includes('--measure')){
    const measurements=[];
    for(const width of [1440,390,320]){
      await viewport(width,width<681?844:1000);await navigate('overview');
      const overview=await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.pipeline button')];const list=document.getElementById('recent-activity'),last=list.lastElementChild;return {width:innerWidth,steps:buttons.map(b=>({width:b.getBoundingClientRect().width,iconY:b.querySelector('.step-mark').getBoundingClientRect().y,status:b.querySelector('small').textContent,statusHeight:b.querySelector('small').getBoundingClientRect().height})),activityGap:last?list.closest('.panel').getBoundingClientRect().bottom-last.getBoundingClientRect().bottom:0};})()`);
      await navigate('messages');const filters=await evaluate(`['message-type','message-direction'].map(id=>({id,width:document.getElementById(id).getBoundingClientRect().width}))`);
      measurements.push({...overview,filters});
    }
    await writeFile(join(output,'ui-baseline.json'),JSON.stringify(measurements,null,2));
    console.log(JSON.stringify({baseline:measurements}));
    await viewport(1440);await navigate('overview');
  }

  function contrast(a,b){const luminance=s=>{const c=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
  for(const width of [1440,1024,768,680,390,320]){
    await viewport(width,width<681?844:1000);await navigate('overview');
    if(width<=680){const control=await evaluate('(()=>{const b=document.querySelector(".page-head>.button");return {width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,client:b.clientWidth,scroll:b.scrollWidth};})()');assert.ok(control.width>=44&&control.height>=44&&control.scroll<=control.client,'mobile refresh has a complete 44px target without clipped text '+JSON.stringify(control));checks.push('mobile refresh target and text fit '+width);}
    const layout=await evaluate("(()=>{const b=[...document.querySelectorAll('.pipeline button')],list=document.getElementById('recent-activity');return {width:innerWidth,steps:b.map(e=>({width:e.getBoundingClientRect().width,iconY:e.querySelector('.step-mark').getBoundingClientRect().y,statusHeight:e.querySelector('small').getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(e.querySelector('small')).lineHeight)})),activityGap:list.closest('.panel').getBoundingClientRect().bottom-list.lastElementChild.getBoundingClientRect().bottom};})()");
    if(width<=680){assert.ok(layout.steps.every(s=>s.width>=240),'readable mobile steps '+width);assert.ok(layout.steps.every(s=>s.statusHeight<=s.lineHeight+1),'status text fits without a dangling character '+width);}
    else {
      assert.ok(Math.max(...layout.steps.map(s=>s.iconY))-Math.min(...layout.steps.map(s=>s.iconY))<=1,'desktop icon alignment '+width);
      const arrows=await evaluate("[...document.querySelectorAll('.pipeline>svg')].map(e=>e.getBoundingClientRect().y+e.getBoundingClientRect().height/2)");
      assert.ok(arrows.every(y=>Math.abs(y-layout.steps[0].iconY-14.5)<=1),'flow arrows share icon centers '+width);
    }
    assert.ok(layout.activityGap<=20,'recent activity follows content '+width);
    if(width===320)await screenshot('mobile-320');
    await navigate('messages');
    const filters=await evaluate("['message-type','message-direction'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=s.font;return {id,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,available:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-24,required:Math.max(...[...e.options].map(o=>ctx.measureText(o.text).width)),label:e.closest('label')?.textContent};})");
    for(const filter of filters){assert.ok(filter.width>=120,'filter cannot collapse '+filter.id+' '+width);assert.ok(filter.available>=filter.required-1,'all option text fits '+filter.id+' '+width);assert.ok(filter.label,'visible filter label');if(width<=680)assert.ok(filter.height>=44,'mobile filter target');}
    const monitorTargets=await evaluate('[...document.querySelectorAll("#view-monitor .monitor-tabs button")].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,visible:e.getClientRects().length>0}))');
    assert.ok(monitorTargets.every(t=>t.visible&&t.width>=44&&t.height>=44),'all monitoring tabs are visible and usable '+width);
    await noOverflow('monitoring messages '+width);
    if(width===320)await screenshot('messages-mobile-320');
    for(const tab of ['jobs','logs']){await navigate(tab);await noOverflow('monitoring '+tab+' '+width);if(width===320)await screenshot(tab+'-mobile-320');}
    layoutMetrics.push({...layout,filters});checks.push('flow, filters and activity geometry '+width);
    await navigate('settings');await wait('document.getElementById("field-AI_MODEL")');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    const colors=await evaluate("(()=>{const e=document.getElementById('field-AI_MODEL');e.focus();const s=getComputedStyle(e);return {border:s.borderTopColor,focus:s.outlineColor,outline:s.outlineStyle,background:s.backgroundColor,focused:document.activeElement===e,visible:e.matches(':focus-visible')};})()");
    const ratios={width,border:contrast(colors.border,colors.background),focus:contrast(colors.focus,colors.background),colors};
    assert.ok(ratios.border>=3,'field boundary contrast '+JSON.stringify(ratios));assert.ok(ratios.focus>=3&&colors.outline==='solid','focus ring contrast '+JSON.stringify(ratios));contrastMetrics.push(ratios);
  }
  checks.push('field boundaries and keyboard focus contrast');
  await viewport(1440);await navigate('overview');
  const darkFocus=await evaluate("(()=>{const e=document.querySelector('.sidebar .nav button');e.focus();return {focus:getComputedStyle(e).outlineColor,background:getComputedStyle(document.querySelector('.sidebar')).backgroundColor};})()");
  assert.ok(contrast(darkFocus.focus,darkFocus.background)>=3,'focus is visible on the dark navigation rail');checks.push('keyboard focus contrast on dark sidebar');
  await viewport(1440);await navigate('overview');
  assert.equal(await evaluate('document.getElementById("demo").hidden'),false);await wait('document.querySelector(".activity-row")');await noOverflow('desktop overview');await screenshot('desktop');
  await navigate('messages');await wait('document.querySelectorAll(".message-row").length===3');await screenshot('messages-desktop');await value('message-search','待办');assert.equal(await evaluate('document.querySelectorAll(".message-row").length'),1);await value('message-search','');await value('message-direction','out');assert.equal(await evaluate('document.querySelectorAll(".message-row").length'),1);await value('message-direction','all');
  await click('pause-messages');await value('message-type','group');await navigate('logs');await value('log-search','ai_reply');await click('pause-logs');await navigate('messages');
  assert.equal(await evaluate('document.getElementById("message-type").value'),'group');assert.equal(await evaluate('document.getElementById("pause-messages").textContent'),'继续显示');
  await navigate('logs');assert.equal(await evaluate('document.getElementById("log-search").value'),'ai_reply');assert.equal(await evaluate('document.getElementById("pause-logs").textContent'),'继续显示');
  await click('pause-logs');await value('log-search','');await navigate('messages');await value('message-type','all');
  checks.push('monitoring tabs preserve independent message and log filters and pause states');
  workspace.app.adapter.driver.inject(incoming(20261027,{message:'<script>window.unsafe=1</script>【演示】这是文本。'}));await delay(1700);assert.equal(await evaluate('document.querySelectorAll(".message-row").length'),3);await click('pause-messages');assert.equal(await evaluate('document.querySelectorAll(".message-row").length'),4);assert.equal(await evaluate('window.unsafe'),undefined);checks.push('message filtering, pause, resume and escaped content');

  const expanded=await evaluate("(()=>{const row=document.querySelector('.message-row');row.querySelector('details').open=true;row.querySelector('summary').focus();return row.dataset.message;})()");
  workspace.app.adapter.driver.inject(incoming(20261028,{message:'【演示】用于验证原始事件展开状态的新消息。'}));
  await wait('document.querySelectorAll(".message-row").length===5');
  assert.equal(await evaluate('document.querySelector(\'.message-row[data-message="'+expanded+'"] details\').open'),true);
  assert.equal(await evaluate('document.activeElement.closest(".message-row")?.dataset.message'),expanded);
  await value('message-type','group');await value('message-type','all');
  assert.equal(await evaluate('document.querySelector(\'.message-row[data-message="'+expanded+'"] details\').open'),true);
  checks.push('raw event expansion survives new messages and filtering; keyboard focus survives insertion');
  await navigate('jobs');await navigate('messages');assert.equal(await evaluate('document.querySelector(\'.message-row[data-message="'+expanded+'"] details\').open'),true);checks.push('raw message details stay expanded across monitoring tabs');
  await navigate('logs');await wait('document.querySelectorAll("#log-body tr").length>0');await value('log-level','warn');await screenshot('logs-desktop');assert.equal(await evaluate('document.querySelectorAll("#log-body tr").length'),1);await value('log-level','all');checks.push('log filtering');
  await navigate('jobs');await wait('document.querySelectorAll("#job-body tr").length>0');await evaluate('document.querySelector("#job-body details").open=true');await wait('document.querySelector("#job-body details pre").textContent.includes("会话：")');await delay(1700);assert.equal(await evaluate('document.querySelector("#job-body details").open'),true);await screenshot('jobs-desktop');assert.equal(await evaluate('document.getElementById("uncertain-help").hidden'),false);await evaluate('Array.from(document.querySelectorAll("#job-body button")).find(b=>b.textContent==="放弃任务").click()');await wait('document.getElementById("confirm-dialog").open');await click('confirm-ok');await wait('document.getElementById("uncertain-help").hidden');checks.push('uncertain job resolution and persistent details');

  async function taskText(id){await evaluate('document.querySelector(\'tr[data-job="'+id+'"] details\').open=true');await wait('document.querySelector(\'tr[data-job="'+id+'"] pre\').textContent.includes("会话：")');return evaluate('document.querySelector(\'tr[data-job="'+id+'"] pre\').textContent');}

  const judgmentText=await taskText(decisionFixture);assert.ok(judgmentText.includes('AI 读空气：不适合参与')&&judgmentText.includes('机器人没有必要插话')&&judgmentText.includes('判断置信度：0.94'));
  assert.equal(await evaluate('window.judgmentUnsafe'),undefined);assert.equal(await evaluate('document.querySelector(\'tr[data-job="'+decisionFixture+'"] pre img\')'),null);

  const failureText=await taskText(decisionFailureFixture);assert.ok(failureText.includes('仅有思考内容，没有判断正文')&&failureText.includes('思考 512')&&failureText.includes('12742 ms')&&failureText.includes('length'));await screenshot('decision-error-desktop');
  await screenshot('decision-job-desktop');checks.push('silent AI decision reason and confidence are visible in task details and rendered only as text');
  const filteredText=await taskText(filteredFixture);assert.ok(filteredText.includes('不在回复白名单')&&filteredText.includes('【演示原文】'));
  assert.ok((await taskText(redactedFixture)).includes('正文已脱敏清除，无法恢复'));
  assert.ok((await taskText(noTextFixture)).includes('原消息没有文本，仅含图片等非文本内容'));
  assert.ok((await taskText(notStoredFixture)).includes('正文未记录，仅保留防重信息'));
  assert.ok((await taskText(blockedFixture)).includes('群聊发送人命中固定屏蔽规则'));checks.push('blocked group member has a clear ignored-task reason');
  assert.ok((await taskText(emojiFixture)).includes('AI 回复过滤 Emoji 后无可发送正文'));checks.push('emoji-only reply explains why no message was sent');
  fixtureStore.redactIgnored('retention');
  await wait('document.querySelector(\'tr[data-job="'+filteredFixture+'"] pre\').textContent.includes("正文已脱敏清除")');
  await evaluate('document.getElementById("privacy-audit").open=true');
  assert.ok(await evaluate('document.getElementById("privacy-records").textContent.includes("脱敏")'));
  await screenshot('privacy-jobs-desktop');checks.push('four task content states and live redaction cache invalidation');checks.push('persistent privacy audit is visible with count and time');
  // A quiet conversation remains selectable even after many newer jobs elsewhere.
  for(let n=0;n<60;n++)fixtureStore.ingest({...fixtureEvent(99000+n),message_type:'group',group_id:30002},null,1000,'ai_disabled');
  fixtureStore.ingest({...fixtureEvent(99100),self_id:20000,message_type:'group',group_id:20001},null,1000,'ai_disabled');
  fixtureStore.ingest({...fixtureEvent(99101),self_id:0,user_id:0},null,1000,'ai_disabled','qa-task-session');
  await click('refresh-jobs');await wait('document.querySelectorAll("#job-body tr").length===50&&document.querySelectorAll("#job-conversation option").length>=6');
  assert.equal(await evaluate(`!!document.querySelector('tr[data-job="${decisionFixture}"]')`),false);
  const selectJobSession=async session=>evaluate('(function(){const s=document.getElementById("job-conversation");s.value='+JSON.stringify(session)+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  const scopedRows='document.querySelectorAll("#job-body tr").length>0&&[...document.querySelectorAll("#job-body tr")].every(row=>row.dataset.conversation==="10000:group:20001")';
  await selectJobSession('10000:group:20001');await wait(scopedRows);
  assert.ok(await evaluate(`!!document.querySelector('tr[data-job="${decisionFixture}"]')`));
  assert.ok((await taskText(decisionFixture)).includes('会话：10000:group:20001'));
  const choices=await evaluate('[...document.getElementById("job-conversation").options].map(o=>({value:o.value,label:o.textContent}))');
  assert.ok(choices.some(o=>o.value==='20000:group:20001'&&o.label.includes('机器人 20000')));
  assert.ok(choices.some(o=>o.value==='10000:private:10001'&&o.label.includes('私聊 QQ')));assert.ok(choices.some(o=>o.value==='web:qa-task-session'&&o.label.includes('网页试聊')));
  checks.push('conversation choices include quiet groups, private and web sessions, and distinguish bot accounts before the 50-job limit');
  await evaluate('document.getElementById("job-conversation").focus()');await delay(1700);
  assert.equal(await evaluate('document.activeElement.id'),'job-conversation');assert.equal(await evaluate('document.getElementById("job-conversation").value'),'10000:group:20001');
  for(const width of [1440,1024,768,680,390,320]){
    await viewport(width,width<681?844:1000);await noOverflow('conversation task filter '+width);
    if(width<=680){const bounds=await evaluate('["job-conversation","job-filter"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {width:r.width,height:r.height};})');assert.ok(bounds.every(r=>r.width>=120&&r.height>=44));}
    if(width===1440||width===320)await screenshot('jobs-conversation-'+width);
  }
  await viewport(1440);await evaluate('document.getElementById("job-filter").value="done";document.getElementById("job-filter").dispatchEvent(new Event("change"))');
  assert.ok(await evaluate('document.getElementById("job-empty").textContent.includes("此会话暂无此类任务")'));
  await evaluate('document.getElementById("job-filter").value="ignored";document.getElementById("job-filter").dispatchEvent(new Event("change"))');await wait(scopedRows);
  await navigate('logs');await navigate('jobs');await wait(scopedRows);assert.equal(await evaluate('document.getElementById("job-filter").value'),'ignored');
  const liveTask=fixtureStore.ingest({...fixtureEvent(99102),message_type:'group',group_id:20001},null,1000,'ai_disabled').id;
  await wait(`document.querySelector('tr[data-job="${liveTask}"]')`);
  assert.equal(await evaluate(scopedRows),true);checks.push('conversation and status filters combine, survive monitor tabs and polling, and receive new matching jobs without losing focus');
  await wait('!jobsBusy');
  await evaluate('window.qaOriginalFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.qaOriginalFetch(...args);if(String(args[0]).includes("conversation=10000%3Aprivate%3A10001"))await new Promise(resolve=>{window.qaReleaseJobs=resolve;});return response;}');
  await selectJobSession('10000:private:10001');await wait('typeof window.qaReleaseJobs==="function"');await selectJobSession('10000:group:20001');
  await evaluate('window.qaCrossSession=false;window.qaJobObserver=new MutationObserver(()=>{if([...document.querySelectorAll("#job-body tr")].some(row=>row.dataset.conversation!=="10000:group:20001"))window.qaCrossSession=true;});window.qaJobObserver.observe(document.getElementById("job-body"),{childList:true});window.qaReleaseJobs();');
  await wait(scopedRows+'&&!jobsBusy');assert.equal(await evaluate('window.qaCrossSession'),false);
  await evaluate('window.qaJobObserver.disconnect();window.fetch=window.qaOriginalFetch;delete window.qaReleaseJobs;');checks.push('late responses cannot replace the newly selected conversation');
  await evaluate('window.qaOriginalFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes("/jobs?conversation=")?Promise.reject(Error("演示连接失败")):window.qaOriginalFetch(...args);');
  await selectJobSession('20000:group:20001');await wait('!document.getElementById("job-error").hidden&&document.getElementById("job-empty").textContent.includes("任务读取失败")');
  await evaluate('window.fetch=window.qaOriginalFetch');await click('refresh-jobs');await wait('document.getElementById("job-error").hidden&&document.querySelectorAll("#job-body tr").length===1');
  checks.push('task filter shows recoverable load errors and retains the selected conversation when retrying');
  await selectJobSession('');await evaluate('document.getElementById("job-filter").value="all";document.getElementById("job-filter").dispatchEvent(new Event("change"))');
  await wait('document.querySelectorAll("#job-body tr").length===50&&!jobsBusy');
  await navigate('settings');await wait('document.getElementById("field-AI_MODEL")');await value('field-AI_API_KEY','changed-fixture-key');await value('field-AI_API_KEY','');assert.equal(await evaluate('document.getElementById("save").disabled'),true);assert.equal(workspace.app.config.ai.apiKey,'web-qa-fixture-key');checks.push('blank secret input preserves stored value');
  assert.equal(await evaluate('document.getElementById("field-REPLY_AT_SENDER").checked'),true);
  assert.equal(await evaluate('document.getElementById("field-REPLY_QUOTE_MESSAGE").checked'),true);
  await click('field-REPLY_AT_SENDER');await click('field-REPLY_QUOTE_MESSAGE');await value('setting-search','回复时');
  assert.ok(await evaluate('document.querySelectorAll("#fields .field").length>=2&&document.getElementById("field-REPLY_AT_SENDER")&&document.getElementById("field-REPLY_QUOTE_MESSAGE")'));
  assert.ok(await evaluate('document.getElementById("help-REPLY_AT_SENDER").textContent.includes("不改变")'));
  for(const width of [1440,390,320]){
    await viewport(width,width<681?844:1000);await noOverflow('reply formatting settings '+width);
    const targets=await evaluate('[...document.querySelectorAll("#fields .boolean-field label")].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))');
    if(width<=680)assert.ok(targets.every(t=>t.width>=44&&t.height>=44),'reply setting touch targets');
    await screenshot('reply-settings-'+width);
  }
  await viewport(1440);await value('setting-search','');
  checks.push('reply mention and quote settings default enabled, independently toggle, search and fit desktop/mobile');
  await value('setting-search','Emoji');await wait('document.getElementById("field-AI_STRIP_EMOJI")');
  assert.equal(await evaluate('document.getElementById("field-AI_STRIP_EMOJI").checked'),true);
  assert.ok(await evaluate('document.getElementById("help-AI_STRIP_EMOJI").textContent.includes("过滤后无正文则不发送")'));
  for(const width of [1440,390,320]){
    await viewport(width,width<681?844:1000);await noOverflow('emoji filter settings '+width);await screenshot('emoji-filter-'+width);
  }
  await click('field-AI_STRIP_EMOJI');checks.push('emoji filter defaults enabled, is searchable and can be disabled');
  await value('setting-search','固定屏蔽');await wait('document.getElementById("field-GROUP_BLOCKED_USERS")');
  assert.equal(await evaluate('document.getElementById("field-GROUP_BLOCKED_USERS").tagName'), 'TEXTAREA');
  assert.equal(await evaluate('document.getElementById("field-GROUP_BLOCKED_USERS").value'), '');
  assert.ok(await evaluate('document.getElementById("help-GROUP_BLOCKED_USERS").textContent.includes("私聊不受影响")'));
  await value('field-GROUP_BLOCKED_USERS','20001:10001\n*:10003');
  for(const width of [1440,390,320]){
    await viewport(width,width<681?844:1000);await noOverflow('group member block settings '+width);
    await screenshot('group-member-block-'+width);
  }
  checks.push('persistent member-block rules are searchable and editable on desktop and mobile');
  await viewport(1440);await value('setting-search','');
await value('field-AI_MODEL','web-qa-model');await value('field-AI_SYSTEM_PROMPT','【验收配置】请简洁地回答。\n支持多行提示词。');await click('save');await wait('document.getElementById("save-state").textContent.includes("等待重启")');assert.equal(workspace.app.config.ai.model,'');await screenshot('settings-desktop');
  await click('restart');await wait('document.getElementById("confirm-dialog").open');assert.ok(await evaluate('document.getElementById("confirm-body").textContent.includes("不可恢复")'));checks.push('restart warns redaction cannot be reversed by re-enabling retention');await click('confirm-ok');await wait('document.getElementById("save-state").textContent==="所有设置已保存"');assert.equal(workspace.app.config.ai.model,'web-qa-model');assert.deepEqual(workspace.app.config.reply,{atSender:false,quoteMessage:false});checks.push('save and apply restart, including both reply formatting settings');
  assert.deepEqual([...workspace.app.config.blockedGroupUsers.get('20001')],['10001']);
  assert.deepEqual([...workspace.app.config.blockedGroupUsers.get('*')],['10003']);checks.push('member-block rules apply after saving and restarting');
  assert.equal(workspace.app.config.ai.stripEmoji,false);checks.push('emoji filter switch saves and applies through restart');
  await value('setting-search','BOT_ADMIN_IDS');await wait('document.getElementById("field-BOT_ADMIN_IDS")');
  assert.equal(await evaluate('document.querySelector(\'label[for="field-BOT_ADMIN_IDS"]\').textContent.includes("聊天管理员 QQ ID")'),true);
  assert.equal(await evaluate('document.getElementById("help-BOT_ADMIN_IDS").textContent.includes("留空禁用全部")'),true);
  await value('field-BOT_ADMIN_IDS','10001,10002');await click('save');
  await wait('document.getElementById("save").disabled&&document.getElementById("save-state").textContent.includes("等待重启")');
  assert.equal((await workspace.app.settings.environment()).BOT_ADMIN_IDS,'10001,10002');
  for(const width of [1440,390,320]){await viewport(width,width<681?844:1000);await noOverflow('chat admin setting '+width);await screenshot('chat-admin-'+width);}
  checks.push('chat administrator field label, fail-closed help, save and responsive layout');
  await viewport(1440);await value('setting-search','TOKEN');assert.ok(await evaluate('document.querySelectorAll("#fields .field").length>=4'));await value('setting-search','');
  await evaluate('Array.from(document.querySelectorAll("#settings-nav button")).find(b=>b.textContent==="OneBot 与推送").click()');await wait('document.getElementById("field-ONEBOT_ACCESS_TOKEN")');assert.equal(await evaluate('document.getElementById("field-ONEBOT_ACCESS_TOKEN").value'),'');await evaluate('document.getElementById("field-ONEBOT_ACCESS_TOKEN").closest(".field").querySelector(".secret-controls button").click()');await wait('document.getElementById("field-ONEBOT_ACCESS_TOKEN").type==="text"');assert.equal(await evaluate('document.getElementById("field-ONEBOT_ACCESS_TOKEN").value'),workspace.app.config.token);assert.equal(await evaluate('document.getElementById("save").disabled'),true);checks.push('secret reveal without dirtying configuration');

  await evaluate('Array.from(document.querySelectorAll("#settings-nav button")).find(b=>b.textContent==="数据与保留").click()');
  assert.ok(await evaluate('document.getElementById("help-RETAIN_IGNORED_JOB_CONTENT").textContent.includes("重新开启此开关也无法恢复")'));
  await screenshot('privacy-settings-desktop');checks.push('irreversible field help and memory/disk retention cross-references');
  await navigate('messages');assert.ok(await evaluate('document.getElementById("disk-retention").textContent.includes("7 天")&&document.getElementById("memory-retention").textContent.includes("1000")'));
  await navigate('settings');
  for(const width of [1440,1024,768,680,390,320]){await viewport(width,width<681?844:1000);for(const title of ['AI 与回复','Agent 执行','回复范围','QQ 与运行时','OneBot 与推送','队列与发送','数据与保留','实验驱动']){await evaluate('Array.from(document.querySelectorAll("#settings-nav button")).find(b=>b.textContent==='+JSON.stringify(title)+').click()');await noOverflow('settings '+title+' '+width);}if(width===390){await evaluate('document.querySelector("#settings-nav button").click()');await screenshot('settings-mobile');}}
  await viewport(390,844);await navigate('messages');await noOverflow('mobile messages');await screenshot('messages-mobile');await navigate('overview');await screenshot('mobile');assert.equal(await evaluate('document.getElementById("sidebar").inert'),true);await click('menu');assert.equal(await evaluate('document.getElementById("sidebar").classList.contains("open")'),true);await click('shade');checks.push('mobile navigation');
  await viewport(1440);await navigate('qzone');await wait('document.getElementById("qzone-account").textContent.includes("10000")');
  assert.ok(await evaluate('document.getElementById("qzone-mode").textContent.includes("模拟")'));
  assert.equal(await evaluate('document.getElementById("qzone-visibility").value'),'private');
  await value('qzone-prompt','写一条平静的周末心情');await click('qzone-generate');
  await wait('document.getElementById("qzone-content").value.includes("演示文案")');
  await wait('!document.getElementById("qzone-publish").disabled');await screenshot('qzone-desktop');await evaluate('document.getElementById("qzone-credentials").open=true');await screenshot('qzone-credentials-desktop');
  await evaluate('document.querySelector("#qzone-posts button").focus()');await evaluate('loadQzone()');
  assert.equal(await evaluate('document.activeElement.textContent'),'载入草稿');
  await value('qzone-content','【演示】这是经过编辑的说说。<img src=x onerror="window.qzoneUnsafe=1">');
  await click('qzone-save');await wait('document.getElementById("qzone-editor-state").textContent.includes("草稿")&&!document.getElementById("qzone-save").disabled');
  await click('qzone-publish');await wait('document.getElementById("confirm-dialog").open');
  assert.ok(await evaluate('document.getElementById("confirm-body").textContent.includes("QQ 10000 · 仅自己")'));
  await click('confirm-ok');await wait('document.getElementById("qzone-posts").textContent.includes("已发布")');
  assert.equal(workspace.app.qzone.list().filter(row=>row.status==='published').length,1);
  assert.equal(await evaluate('window.qzoneUnsafe'),undefined);
  await click('qzone-new');await value('qzone-content','【演示】这是一条等待核对结果的说说。');await click('qzone-save');
  await wait('!document.getElementById("qzone-save").disabled');
  const uncertainPost=workspace.app.qzone.list()[0];workspace.app.qzone.change(uncertainPost.id,'uncertain',{reason:'publish_uncertain',account:10000});
  await click('qzone-refresh');await wait('document.getElementById("qzone-posts").textContent.includes("结果未知")');
  await evaluate('[...document.querySelectorAll("#qzone-posts button")].find(b=>b.textContent==="已在空间确认发布").click()');
  await wait('document.getElementById("confirm-dialog").open');await click('confirm-ok');
  await wait('!document.getElementById("qzone-posts").textContent.includes("结果未知")');
  checks.push('Qzone AI draft, content edit, explicit publish confirmation, simulation, escaping and uncertain reconciliation');
  for(const width of [1440,768,390,320]){await viewport(width,width<681?844:1000);await noOverflow('Qzone layout '+width);if(width===320)await screenshot('qzone-mobile-320');}
  await viewport(1440);await navigate('overview');

  const original=workspace.app.adapter.status.bind(workspace.app.adapter);workspace.app.adapter.status=()=>({...original(),online:false});let loginCalls=0;workspace.app.adapter.login=async command=>{if(command==='start')loginCalls++;return {state:command==='poll'?'waiting_confirm':'waiting_scan',handle:'synthetic-only',expires_at:Date.now()+90000,...(command==='start'?{qrcode:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='}:{})};};await wait('document.getElementById("connection").textContent==="未连接"');assert.equal(loginCalls,0);await viewport(1440);await screenshot('login-desktop');await viewport(390,844);await screenshot('login-mobile');await click('refresh');await wait('!document.getElementById("qr").hidden');assert.equal(loginCalls,1);await wait('document.getElementById("state").textContent==="请在手机上确认登录"');await viewport(390,844);await noOverflow('mobile QR login');checks.push('manual QR login and polling');
  assert.equal(failures.length,0,JSON.stringify(failures));const report={success:true,checks:checks.length,viewports:[1440,1024,768,680,390,320],javascriptOrCspErrors:0,details:checks,layoutMetrics,contrastMetrics,screenshots:output};await writeFile(join(output,'web-qa.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
  await writeFile(join(output,'web-qa.json'),JSON.stringify({success:false,error:error.message,checks:checks.length,layoutMetrics,contrastMetrics},null,2));throw error;
}finally{
  for(const handler of pending.values())clearTimeout(handler.timer);
  if(socket?.readyState===WebSocket.OPEN){await send('Browser.close').catch(()=>{});socket.close();}
  if(browser&&browser.exitCode===null){await Promise.race([once(browser,'exit'),delay(3000)]);if(browser.exitCode===null)browser.kill();}
  await workspace?.close();
  for(const path of [profile,data]){assert.equal(dirname(path),temporaryRoot);await rm(path,{recursive:true,force:true});}
}
