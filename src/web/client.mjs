import {configClient} from './config-ui.mjs';
import {groupChatClient} from './group-chat.mjs';
import {formatJobDetail} from './job-detail.mjs';
import {qzoneClient} from './qzone.mjs';
import {pluginsClient} from './plugins.mjs';
import {memesClient} from './memes.mjs';
import {agentClient} from './agent.mjs';
export const client = String.raw`
'use strict';
${formatJobDetail.toString()}
const $ = id => document.getElementById(id);
const base = location.pathname.replace(/\/$/, '');
const titles = {groupchat:['群聊增强 Chat Plus','设置机器人何时参与群聊，查看每个群的互动状态和上下文。'],agent:['Agent 管理','配置人格、会话记忆和工具，掌握机器人的执行过程。'],memes:['表情图库','整理喜欢的表情，让机器人按语境选图。'],plugins:['插件管理','编写自己的消息插件，设置触发范围并即时启用。'],qzone:['QQ 空间','用 AI 写说说，编辑草稿并发布到你的 QQ 空间。'],overview:['机器人运行概览','查看账号连接、回复状态与待处理任务，管理你的 QQ 机器人。'],monitor:['运行监控','查看收发消息、跟进回复任务，切换日志排查运行问题。'],settings:['全部设置','从模型到消息推送，在这里管理所有运行配置。']};
const monitorTabs=['messages','jobs','logs'];let monitorTab='messages';
const eventLabels = {group_chat_decision_failed:'群聊读空气请求失败',group_chat_decision_invalid:'群聊读空气输出无效',group_chat_decision_completed:'群聊读空气判断完成',group_chat_image_caption_failed:'群图片描述失败',agent_run_started:'Agent 开始执行',agent_run_completed:'Agent 生成完成',meme_uploaded:'表情已入库',meme_collected:'表情等待审核',meme_collection_failed:'表情收集失败',plugin_saved:'插件已保存',plugin_enabled:'插件已启用',plugin_disabled:'插件已停用',plugin_deleted:'插件已删除',plugin_reply_sent:'插件回复已发送',plugin_execution_failed:'插件执行失败',plugin_reply_failed:'插件回复发送失败',plugin_processing_failed:'插件处理异常',plugin_queue_full:'插件队列已满',qzone_draft_generated:'空间文案已生成',qzone_generation_failed:'空间文案生成失败',qzone_post_published:'空间说说已发布',qzone_publish_failed:'空间发布未完成',ignored_job_content_redacted:'忽略任务正文已脱敏',ai_job_queued:'消息已加入回复队列',ai_queue_full:'AI 任务队列已满',worker_iteration_failed:'任务调度失败',ai_generation_failed:'AI 生成失败',ai_reply_sent:'AI 回复已发送',ai_reply_send_failed:'AI 回复发送失败',service_started:'机器人服务已启动',qq_connection_changed:'QQ 连接状态变化',settings_saved:'配置已保存，等待重启',qq_driver_fault:'QQ 驱动发生异常',ai_generating:'正在生成回复',ai_failed:'AI 生成失败',job_done:'回复任务已完成',job_failed:'回复任务失败',reverse_ws_connected:'反向 WebSocket 已连接',webhook_delivery_failed:'Webhook 推送失败',webhook_queue_full:'Webhook 推送队列已满',event_persistence_failed:'消息持久化失败',retention_cleanup_failed:'历史数据清理失败',restart_failed:'新配置启动失败',reply_sent:'回复已发送',job_queued:'消息已加入回复队列',job_uncertain:'发送结果需要核对',generation_failed:'生成回复失败',send_failed:'发送回复失败'};
const statusLabels = {queued:'等待生成',generating:'正在生成',ready:'等待发送',sending:'正在发送',done:'已完成',ignored:'已忽略',failed:'失败',uncertain:'需要核对'};
let view='overview', group='ai', state=null, setting=null, draft={}, dirty=new Set(), settingsLoading=false, saving=false, restarting=false;
const messageRows=new Map(),openMessages=new Set();let privacyRevision=null;
const jobDetails=new Map();let openJobs=new Set();let cursor=0, entries=[], jobs=[], messagesPaused=null, logsPaused=null, messageCleared=0, logCleared=0;
let qrBusy=false, hasQr=false, expiry=0, autoRefresh=0, autoBlocked=false, pollBusy=false, jobsBusy=false, toastTimer;
let jobsReload=false,jobConversationsSignature='';
const time = value => new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
const dateTime = value => new Date(value).toLocaleString('zh-CN',{hour12:false});
function el(tag, cls, text) { const node=document.createElement(tag); if(cls) node.className=cls; if(text!==undefined) node.textContent=text; return node; }
function badge(text,tone=''){return el('span','tag '+tone,text);}
function notify(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').dataset.error=String(error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(path, params, signal){const timeout=AbortSignal.timeout(35000);const res=await fetch(base+path,{method:params===undefined?'GET':'POST',headers:params===undefined?{}:{'Content-Type':'application/json'},body:params===undefined?undefined:JSON.stringify(params),signal:signal?AbortSignal.any([signal,timeout]):timeout});const data=await res.json();if(!res.ok)throw new Error(data.message||'请求失败，请稍后重试。');return data;}
function problem(id,error){$(id).textContent=error?error.message||String(error):'';$(id).hidden=!error;}
function empty(container,title,description){container.replaceChildren();const box=el('div','empty');box.append(el('h3','',title),el('p','',description));container.append(box);}
const mobileMenu=matchMedia('(max-width:680px)');
function setMenu(open,restore=true){open=mobileMenu.matches&&open;$('sidebar').classList.toggle('open',open);$('sidebar').inert=mobileMenu.matches&&!open;$('sidebar').setAttribute('aria-hidden',String(mobileMenu.matches&&!open));$('shade').hidden=!open;$('shade').classList.toggle('open',open);$('menu').setAttribute('aria-expanded',String(open));if(open)$('sidebar').querySelector('[aria-current=page]').focus({preventScroll:true});else if(restore&&mobileMenu.matches)$('menu').focus({preventScroll:true});}
mobileMenu.addEventListener('change',()=>setMenu(false,false));setMenu(false,false);
function renderMonitor(){
  for(const name of monitorTabs){const selected=name===monitorTab,tab=$('monitor-tab-'+name);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$('view-'+name).hidden=!selected;}
  if(monitorTab==='messages')renderMessages();
  if(monitorTab==='logs')renderLogs();
  if(monitorTab==='jobs')void loadJobs();
}
function navigate(next, targetGroup, replace=false){
  const [page,tab]=next.split('/');
  if(monitorTabs.includes(page)){monitorTab=page;next='monitor';}
  else if(page==='monitor'){if(tab)monitorTab=monitorTabs.includes(tab)?tab:'messages';next='monitor';}
  if(!titles[next])next='overview';const previousView=view;view=next;document.documentElement.dataset.view=next;if(targetGroup)group=targetGroup;
  for(const name of Object.keys(titles))$('view-'+name).hidden=name!==next;
  document.querySelectorAll('[data-view]').forEach(button=>{if(button.dataset.view===next)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  $('breadcrumb').textContent=titles[next][0];$('page-title').textContent=titles[next][0];$('page-description').textContent=titles[next][1];$('manual-refresh').hidden=next!=='overview';
  const hash='#'+(next==='monitor'?'monitor/'+monitorTab:next);if(location.hash!==hash)history[replace?'replaceState':'pushState'](null,'',hash);
  if($('sidebar').classList.contains('open'))setMenu(false);
  if(next==='settings'){if(!setting)loadSettings();else renderSettings();}
  if(next==='monitor')renderMonitor();
  if(next==='qzone')loadQzone();if(next==='plugins')loadPlugins();if(next==='groupchat')loadGroupChat();if(next==='memes')loadMemes();if(next==='agent'){if(previousView!=='agent')agentSetTab('sessions');void loadAgent().then(loadAgentMemories);}agentSyncMode();
}
document.querySelectorAll('[data-monitor-tab]').forEach(button=>{
  button.addEventListener('click',()=>navigate('monitor/'+button.dataset.monitorTab));
  button.addEventListener('keydown',event=>{
    const index=monitorTabs.indexOf(button.dataset.monitorTab);let target;
    if(event.key==='ArrowRight')target=(index+1)%monitorTabs.length;
    else if(event.key==='ArrowLeft')target=(index+monitorTabs.length-1)%monitorTabs.length;
    else if(event.key==='Home')target=0;
    else if(event.key==='End')target=monitorTabs.length-1;
    else return;
    event.preventDefault();navigate('monitor/'+monitorTabs[target]);$('monitor-tab-'+monitorTabs[target]).focus({preventScroll:true});
  });
});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go,button.dataset.group)));
$('menu').addEventListener('click',()=>setMenu(!$('sidebar').classList.contains('open')));$('shade').addEventListener('click',()=>setMenu(false));$('nav-close').addEventListener('click',()=>setMenu(false));document.addEventListener('keydown',event=>{if(!$('sidebar').classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();setMenu(false);}if(event.key==='Tab'){const nodes=Array.from($('sidebar').querySelectorAll('a,button')).filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),undefined,true));
$('global-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();navigate('settings');$('setting-search').value=$('global-search').value;if(setting)renderFields();}});
function confirmAction(title,body){return new Promise(resolve=>{const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-body').textContent=body;let answered=false;const close=value=>{if(answered)return;answered=true;dialog.close();resolve(value);};$('confirm-ok').onclick=()=>close(true);$('confirm-cancel').onclick=()=>close(false);dialog.oncancel=()=>close(false);dialog.showModal();});}
function applyState(s){state=s;renderPrivacy(s.privacy);problem('service-error',null);$('demo').hidden=!s.simulated;$('connection').textContent=s.online?'已连接':'未连接';$('connection-wrap').dataset.tone=s.online?'ok':'';$('service-tag').textContent='运行中';$('service-tag').className='tag ok';$('backend-state').textContent='运行中';$('driver').textContent=s.driver==='kernel'?'QQNT 内核':s.driver==='demo'?'模拟驱动':s.driver||'—';$('account').textContent=s.account?'QQ '+s.account:'尚未登录 QQ';$('account-hint').textContent=s.simulated?'独立模拟账号':s.online?'账号已连接，正在监听消息':'扫码连接后开始监听消息';$('ai-status').textContent=s.ai_enabled?'已启用':'未启用';$('kernel-version').textContent=typeof s.version==='string'?s.version:s.version?JSON.stringify(s.version):s.driver==='demo'?'模拟环境':'未提供';$('checked').textContent=time(s.checked_at);$('endpoint').textContent=s.endpoint;const j=s.jobs||{};const pending=['queued','generating','ready','sending'].reduce((n,k)=>n+(j[k]||0),0);$('pending').textContent=String(pending);$('completed').textContent=String(j.done||0);$('uncertain').textContent=String(j.uncertain||0);$('queue-note').textContent=j.uncertain?'有发送结果未知的任务，请前往任务队列核对。':'任务统计来自当前数据库。';$('pipe-in').textContent=s.online?'QQ 已连接，持续监听':'等待连接 QQ';$('pipe-ai').textContent=s.ai_enabled?'按白名单规则生成回复':'尚未启用，点击配置';$('pipe-out').textContent=pending?pending+' 项任务处理中':'队列空闲';$('logout').hidden=!s.online||s.simulated;$('login-area').hidden=s.online;$('refresh').hidden=s.online||['authenticated','online'].includes(s.state);const label={waiting_scan:'等待手机 QQ 扫码',waiting_confirm:'请在手机上确认登录',authenticated:'账号已认证',expired:'二维码已过期',cancelled:'登录已取消',idle:'等待扫码登录',error:'登录遇到问题'};$('state').textContent=s.online?'已连接':label[s.state]||'等待扫码登录';if(s.online){hasQr=false;expiry=0;$('qr').hidden=true;problem('error',null);autoRefresh=0;}else if(s.state==='authenticated'){hasQr=false;$('qr').hidden=true;$('qr-placeholder').hidden=false;$('qr-placeholder').textContent='正在建立连接…';}if(s.expires_at)expiry=s.expires_at;updateSavebar();}
async function fetchState(){try{applyState(await api('/state'));}catch(error){$('connection').textContent='服务离线';$('connection-wrap').dataset.tone='bad';$('backend-state').textContent='连接失败';$('service-tag').textContent='不可用';$('service-tag').className='tag bad';problem('service-error',new Error('无法读取服务状态：'+error.message));}}
async function startQr(manual=true){if(qrBusy)return;qrBusy=true;if(manual){autoRefresh=0;autoBlocked=false;}problem('error',null);$('refresh').disabled=true;$('refresh').textContent='正在获取…';try{const value=await api('/qr',{});const source=value.qrcode||value.qr_code||value.image;if(source&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(source)){$('qr').src=source;$('qr').hidden=false;$('qr-placeholder').hidden=true;hasQr=true;expiry=value.expires_at||0;}else if(value.state!=='online')throw new Error('服务未返回可显示的二维码，请检查 QQ 驱动与运行日志。');await fetchState();}catch(error){problem('error',error);autoBlocked=true;}finally{qrBusy=false;$('refresh').disabled=false;$('refresh').textContent=hasQr?'刷新二维码':'获取二维码';}}
$('refresh').addEventListener('click',()=>startQr());$('manual-refresh').addEventListener('click',async()=>{const b=$('manual-refresh');b.disabled=true;await fetchState();b.disabled=false;});
$('logout').addEventListener('click',async()=>{if(!await confirmAction('退出 QQ 登录？','退出后会停止接收新消息；再次使用时需要重新扫码。'))return;$('logout').disabled=true;try{await api('/logout',{});hasQr=false;expiry=0;$('qr').hidden=true;$('qr-placeholder').hidden=false;await fetchState();notify('已退出登录。');}catch(error){notify(error.message,true);}finally{$('logout').disabled=false;}});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('endpoint').textContent);notify('接入地址已复制。');}catch{notify('无法访问剪贴板，请手动选择地址复制。',true);}});
setInterval(()=>{if(!expiry||!hasQr)return;const seconds=Math.max(0,Math.ceil((expiry-Date.now())/1000));$('qr-expiry').textContent=seconds?'二维码剩余 '+seconds+' 秒':'二维码已过期';if(!seconds&&!qrBusy&&!autoBlocked&&autoRefresh<3&&!document.hidden&&!state?.online){autoRefresh++;startQr(false);}if(!seconds&&autoRefresh>=3)$('qr-expiry').textContent='已停止自动刷新，请手动获取新二维码。';},1000);
function messageEntries(){const list=messagesPaused||entries;const type=$('message-type').value,direction=$('message-direction').value,search=$('message-search').value.trim().toLowerCase();return list.filter(e=>e.kind==='message'&&e.id>messageCleared&&['message','message_sent'].includes(e.event.post_type)&&(type==='all'||e.event.message_type===type)&&(direction==='all'||(e.event.post_type==='message_sent'?'out':'in')===direction)&&(!search||JSON.stringify(e.event).toLowerCase().includes(search))).slice().reverse();}
function logEntries(){const list=logsPaused||entries;const level=$('log-level').value,search=$('log-search').value.trim().toLowerCase();return list.filter(e=>e.kind==='log'&&e.id>logCleared&&(level==='all'||e.level===level)&&(!search||(JSON.stringify(e)+' '+(eventLabels[e.event]||'')).toLowerCase().includes(search))).slice().reverse();}
function renderMessages(){
  const list=messageEntries(),feed=$('message-feed');$('message-count').textContent=String(list.length);
  const retained=new Set((messagesPaused||entries).filter(e=>e.kind==='message').map(e=>e.id));
  for(const key of openMessages)if(!retained.has(key))openMessages.delete(key);
  if(!list.length){feed.replaceChildren();messageRows.clear();empty(feed,$('message-search').value||$('message-type').value!=='all'||$('message-direction').value!=='all'?'没有匹配的消息':'等待第一条消息','连接 QQ 后，收到与发出的消息会出现在这里。未触发 AI 的消息也会展示。');return;}
  if(feed.querySelector('.empty'))feed.replaceChildren();
  const visible=new Set();let anchor=feed.firstElementChild;
  for(const entry of list.slice(0,300)){
    visible.add(entry.id);let row=messageRows.get(entry.id);
    if(!row){
      const e=entry.event;row=el('article','message-row');row.dataset.message=String(entry.id);
      const meta=el('div','message-meta');meta.append(badge(e.post_type==='message_sent'?'发出':'收到',e.post_type==='message_sent'?'ok':''),el('strong','',e.sender?.nickname||'QQ '+e.user_id),badge(e.message_type==='group'?'群 '+e.group_id:'私聊'));
      if(e.target_id)meta.append(el('span','muted','→ '+e.target_id));const at=el('time','',time((e.time||0)*1000||entry.time));at.title=dateTime(entry.time);meta.append(at);
      const body=e.raw_message??(e.message||[]).map(s=>s.type==='text'?s.data?.text:'['+s.type+']').join('');
      const details=el('details'),summary=el('summary','','原始事件 · #'+(e.message_id??entry.id));details.open=openMessages.has(entry.id);
      details.addEventListener('toggle',()=>{if(details.open)openMessages.add(entry.id);else openMessages.delete(entry.id);});
      details.append(summary,el('pre','',JSON.stringify(e,null,2)));row.append(meta,el('p','message-content',body||'（空消息）'),details);messageRows.set(entry.id,row);
    }
    if(row!==anchor)feed.insertBefore(row,anchor);else anchor=anchor.nextElementSibling;
  }
  while(anchor){const next=anchor.nextElementSibling;anchor.remove();anchor=next;}
  for(const key of messageRows.keys())if(!visible.has(key))messageRows.delete(key);
}
function renderPrivacy(privacy){
  if(!privacy){$('job-retention').textContent='当前服务未提供正文保留状态，请重启机器人服务以读取实际策略。';return;}
  const revision=String(privacy.total)+':'+String(privacy.records?.[0]?.id||0);
  if(privacyRevision!==null&&privacyRevision!==revision){jobDetails.clear();if((view==='monitor'&&monitorTab==='jobs'))renderJobs();}
  privacyRevision=revision;
  $('memory-retention').textContent='页面内存：消息与日志合计最多 '+privacy.memory_limit+' 条运行事件；机器人服务进程退出后清空。暂停只冻结显示。';
  const disk='磁盘：任务、上下文与 OneBot 消息查询缓存按“消息与历史保留”设置保存，当前 '+privacy.history_days+' 天；关闭 AI 不会关闭查询缓存。';
  $('disk-retention').textContent=disk;$('log-retention').textContent='页面消息与日志共享 '+privacy.memory_limit+' 条进程内缓冲，服务退出后清空。'+disk;
  $('job-retention').textContent=(privacy.retain_ignored_content?'忽略任务正文当前保留，按 '+privacy.history_days+' 天清理。':'忽略任务正文当前不保留；已有正文脱敏后不可恢复。')+' OneBot 查询缓存独立保留 '+privacy.history_days+' 天，页面消息与日志共享 '+privacy.memory_limit+' 条内存缓冲。';
  const records=privacy.records||[];$('privacy-summary').textContent='正文脱敏记录 · 累计改写 '+privacy.total+' 条任务';$('privacy-records').replaceChildren();
  for(const record of records){const source={startup:'启动时应用保留策略',retention:'定期检查保留策略',policy_changed:'任务被忽略时应用保留策略'}[record.reason]||record.reason;$('privacy-records').append(el('li','privacy-record',dateTime(record.created_at)+' · 脱敏 '+record.count+' 条任务 · '+source));}
  if(!records.length)$('privacy-records').append(el('li','','暂无可查脱敏记录；旧版本未记录的操作无法追溯。'));
}
function renderLogs(){const list=logEntries();$('log-count').textContent=String(list.length);$('log-body').replaceChildren();$('log-empty').replaceChildren();if(!list.length){empty($('log-empty'),'没有匹配的日志','服务连接、回复生成与消息发送的运行事件会显示在这里。');return;}const fragment=document.createDocumentFragment();for(const entry of list.slice(0,500)){const row=el('tr'),at=el('td','nowrap',time(entry.time));at.title=dateTime(entry.time);const level=el('td');level.append(badge(entry.level.toUpperCase(),entry.level==='error'?'bad':entry.level==='warn'?'warn':''));const event=el('td','event-cell',eventLabels[entry.event]||entry.event);event.append(el('small','',entry.event));row.append(at,level,event,el('td','fields-cell',Object.entries(entry.fields||{}).map(([k,v])=>k+'='+String(v)).join(' · ')||'—'));fragment.append(row);}$('log-body').append(fragment);}
function renderRecent(){const container=$('recent-activity');const list=entries.filter(e=>e.kind==='log').slice(-4).reverse();if(!list.length)return;container.replaceChildren();for(const entry of list){const row=el('div','activity-row');row.append(el('time','',time(entry.time)),el('span','',eventLabels[entry.event]||entry.event),badge(entry.level.toUpperCase(),entry.level==='error'?'bad':entry.level==='warn'?'warn':''));container.append(row);}}
async function fetchTelemetry(){try{const value=await api('/telemetry?after='+cursor);if(value.cursor<cursor){entries=[];messageCleared=0;logCleared=0;cursor=0;messageRows.clear();openMessages.clear();renderMessages();renderLogs();renderRecent();return;}cursor=value.cursor;if(value.entries.length){entries.push(...value.entries);if(entries.length>1000)entries.splice(0,entries.length-1000);if((view==='monitor'&&monitorTab==='messages')&&!messagesPaused)renderMessages();if((view==='monitor'&&monitorTab==='logs')&&!logsPaused)renderLogs();renderRecent();}problem('message-error',null);problem('log-error',null);}catch(error){problem('message-error',error);problem('log-error',error);}}
for(const id of ['message-search','message-type','message-direction'])$(id).addEventListener('input',renderMessages);for(const id of ['log-search','log-level'])$(id).addEventListener('input',renderLogs);
$('pause-messages').addEventListener('click',()=>{messagesPaused=messagesPaused?null:entries.slice();$('pause-messages').textContent=messagesPaused?'继续显示':'暂停显示';$('message-live').classList.toggle('paused',!!messagesPaused);$('message-live').replaceChildren(el('i','dot'),document.createTextNode(messagesPaused?'已暂停显示':'正在监听'));renderMessages();});
$('pause-logs').addEventListener('click',()=>{logsPaused=logsPaused?null:entries.slice();$('pause-logs').textContent=logsPaused?'继续显示':'暂停显示';$('log-live').classList.toggle('paused',!!logsPaused);$('log-live').replaceChildren(el('i','dot'),document.createTextNode(logsPaused?'已暂停显示':'实时更新'));renderLogs();});
$('clear-messages').addEventListener('click',()=>{messageCleared=cursor;renderMessages();});$('clear-logs').addEventListener('click',()=>{logCleared=cursor;renderLogs();});
function download(name,data){const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=name+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-messages').addEventListener('click',()=>download('qq-messages',messageEntries()));$('export-logs').addEventListener('click',()=>download('qq-logs',logEntries()));
function jobConversationLabel(session){
  const [account,kind,target]=session.split(':');
  if(account==='web')return '网页试聊 · '+session.slice(4);
  if(['group','private'].includes(kind)&&target)return (kind==='group'?'群聊 ':'私聊 QQ ')+target+' · 机器人 '+account;
  return '会话 '+session;
}
function updateJobConversations(values){
  const select=$('job-conversation'),selected=select.value;
  const sessions=[...new Set([...values,...(selected?[selected]:[])])],signature=JSON.stringify(sessions);
  if(signature===jobConversationsSignature)return;
  jobConversationsSignature=signature;select.replaceChildren(el('option','','全部会话'));select.firstChild.value='';
  for(const session of sessions){const option=el('option','',jobConversationLabel(session));option.value=session;option.title=session;select.append(option);}
  select.value=selected;
}
async function loadJobs(){
  if(jobsBusy){jobsReload=true;return;}
  jobsBusy=true;const selected=$('job-conversation').value;
  try{
    const [next,sessions]=await Promise.all([api('/jobs'+(selected?'?conversation='+encodeURIComponent(selected):'')),api('/job-conversations')]);
    updateJobConversations(sessions);
    // A slow response from the previously selected conversation must not
    // overwrite the table after the user switches to another one.
    if(selected!==$('job-conversation').value)return;
    problem('job-error',null);const rangeText=(selected?'当前会话最新 50 项任务':'最新 50 项任务')+' · 自动更新';
    if($('job-range').textContent!==rangeText)$('job-range').textContent=rangeText;
    if(JSON.stringify(next)!==JSON.stringify(jobs)||!$('job-body').children.length){jobs=next;renderJobs();}
  }catch(error){if(selected===$('job-conversation').value){problem('job-error',error);$('job-range').textContent='读取失败，可刷新重试';if(!jobs.length){$('job-empty').replaceChildren();empty($('job-empty'),'任务读取失败','点击“刷新队列”重试。');}}}
  finally{jobsBusy=false;if(jobsReload){jobsReload=false;void loadJobs();}}
}
function renderJobs(){
  const old=$('job-body').querySelectorAll('details');
  if(old.length)openJobs=new Set(Array.from(old).filter(d=>d.open).map(d=>Number(d.closest('tr').dataset.job)));
  const keep=new Set(jobs.map(j=>j.id));for(const id of jobDetails.keys())if(!keep.has(id))jobDetails.delete(id);
  const filter=$('job-filter').value,pending=['queued','generating','ready','sending'];
  const list=jobs.filter(j=>filter==='all'||(filter==='pending'?pending.includes(j.status):j.status===filter));
  $('uncertain-help').hidden=!jobs.some(j=>j.status==='uncertain');$('job-body').replaceChildren();$('job-empty').replaceChildren();
  if(!list.length){empty($('job-empty'),$('job-conversation').value?'此会话暂无此类任务':'当前没有此类任务',$('job-conversation').value?'可切换任务状态或选择其他会话。':'收到消息后会建立任务记录。AI 关闭或范围外的消息会标为已忽略。');return;}
  for(const job of list){
    const row=el('tr'),status=el('td');row.dataset.job=String(job.id);row.dataset.conversation=job.conversation;
    status.append(badge(statusLabels[job.status]||job.status,job.status==='uncertain'?'warn':job.status==='failed'?'bad':job.status==='done'?'ok':''));
    const action=el('td','event-cell',job.reason||'—'),details=el('details'),summary=el('summary','','查看消息与回复'),body=el('pre','','正在读取…');
    details.append(summary,body);details.open=openJobs.has(job.id);
    const cached=jobDetails.get(job.id);if(cached&&cached.updated===job.updated_at)body.textContent=cached.text;
    details.addEventListener('toggle',async()=>{
      if(!details.open){openJobs.delete(job.id);return;}openJobs.add(job.id);
      const cached=jobDetails.get(job.id);if(cached&&cached.updated===job.updated_at){body.textContent=cached.text;return;}
      try{const d=await api('/job?id='+job.id);const text=formatJobDetail(d);jobDetails.set(job.id,{updated:job.updated_at,text});body.textContent=text;}catch(error){body.textContent=error.message;}
    });
    action.append(details);
    if(job.status==='uncertain'){
      const controls=el('div','inline-actions');
      for(const [value,label] of [['sent','已核实发送'],['discard','放弃任务']]){
        const button=el('button','button small',label);
        button.addEventListener('click',async()=>{
          if(!await confirmAction(label+'？',value==='sent'?'请确认已在 QQ 中看到这条回复。确认后会将任务记为完成。':'此任务将标记为失败，系统不会重新发送。'))return;
          button.disabled=true;
          try{await api('/resolve',{id:job.id,outcome:value});await loadJobs();await fetchState();notify('任务状态已更新。');}catch(error){notify(error.message,true);button.disabled=false;}
        });controls.append(button);
      }action.append(controls);
    }
    row.append(el('td','nowrap','#'+job.id),status,el('td','nowrap',job.attempts+' / '+job.send_attempts),el('td','nowrap',dateTime(job.updated_at)),action);$('job-body').append(row);
  }
}
$('job-conversation').addEventListener('change',()=>{
  jobs=[];jobDetails.clear();openJobs.clear();renderJobs();problem('job-error',null);
  $('job-empty').replaceChildren();empty($('job-empty'),'正在读取任务…','');$('job-range').textContent='正在读取所选会话…';void loadJobs();
});
$('job-filter').addEventListener('change',renderJobs);$('refresh-jobs').addEventListener('click',loadJobs);
async function loadSettings(){if(settingsLoading)return;settingsLoading=true;$('settings-loading').hidden=!!setting;try{const value=await api('/settings');setting=value;draft={...value.values};dirty.clear();problem('settings-error',null);$('settings-content').hidden=false;renderSettings();}catch(error){problem('settings-error',error);$('save-state').textContent='设置加载失败';}finally{settingsLoading=false;$('settings-loading').hidden=true;}}
function renderSettings(){if(!setting)return;$('settings-nav').replaceChildren();for(const g of setting.groups){const button=el('button','',g.title);button.setAttribute('aria-selected',String(group===g.id));button.addEventListener('click',()=>{group=g.id;$('setting-search').value='';renderSettings();});$('settings-nav').append(button);}renderFields();updateSavebar();}
function mark(key,value,explicitClear=false){draft[key]=value;const f=setting.fields.find(f=>f.key===key);if(f.type==='secret'){if(value!==''||explicitClear)dirty.add(key);else dirty.delete(key);}else if(value!==setting.values[key])dirty.add(key);else dirty.delete(key);problem('settings-error',null);updateSavebar();}
function renderFields(){if(!setting)return;$('read-models').hidden=group!=='ai';const search=$('setting-search').value.trim().toLowerCase(),g=setting.groups.find(g=>g.id===group)||setting.groups[0];$('settings-title').textContent=search?'搜索结果':g.title;$('settings-description').textContent=search?'在所有配置分组中查找。':g.description;const list=setting.fields.filter(f=>search?(f.key+' '+f.label+' '+f.help).toLowerCase().includes(search):f.group===group);$('fields').replaceChildren();if(!list.length){empty($('fields'),'没有匹配的设置','试试模型、Token、并发、目录等关键词。');return;}for(const f of list){const box=el('div','field'+(f.type==='textarea'||f.type==='ids'?' full':'')+(f.type==='boolean'?' boolean-field':'')),label=el('label','',f.label);label.htmlFor='field-'+f.key;label.append(el('span','field-key',f.key));let input;if(f.type==='textarea'||f.type==='ids'){input=el('textarea');input.rows=f.key==='AI_SYSTEM_PROMPT'?5:f.type==='ids'?2:3;}else{input=el('input');input.type=f.type==='boolean'?'checkbox':f.type==='secret'?'password':f.type==='number'?'number':'text';}if(f.key==='AI_MODEL')input.setAttribute('list','model-options');input.id='field-'+f.key;input.name=f.key;input.autocomplete='off';input.spellcheck=false;input.disabled=setting.locked.includes(f.key);if(f.type==='boolean'){input.checked=draft[f.key]==='true';label.prepend(input);box.append(label);}else{input.value=draft[f.key]||'';if(f.type==='secret')input.autocomplete='new-password';if(f.type==='number'){input.min=String(f.min??0);if(f.max!==undefined)input.max=String(f.max);input.step='1';}if(f.type==='secret')input.placeholder=setting.secrets[f.key]?'已设置 · 留空保留':'尚未设置';box.append(label,input);}input.setAttribute('aria-describedby','help-'+f.key);input.addEventListener('input',()=>mark(f.key,f.type==='boolean'?String(input.checked):input.value));const help=el('p','help',f.help+(setting.locked.includes(f.key)?' 此项由启动环境变量覆盖。':''));help.id='help-'+f.key;box.append(help);if(f.key==='RETAIN_IGNORED_JOB_CONTENT')box.append(el('p','privacy-warning','旧正文一旦脱敏就无法恢复。重新开启保留，只影响后续消息。'));if(f.type==='secret'){const controls=el('div','secret-controls'),show=el('button','','查看已有密钥'),generate=el('button','','生成随机密钥'),clear=el('button','','清空此项');for(const b of [show,generate,clear]){b.type='button';b.disabled=input.disabled;}show.addEventListener('click',async()=>{show.disabled=true;try{if(input.type==='text'){input.type='password';show.textContent='显示密钥';return;}if(!dirty.has(f.key)){input.value=(await api('/settings/reveal',{key:f.key})).value||'';}input.type='text';show.textContent='隐藏密钥';}catch(error){notify(error.message,true);}finally{show.disabled=false;}});generate.addEventListener('click',()=>{input.value=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');mark(f.key,input.value);});clear.addEventListener('click',()=>{input.value='';input.placeholder='保存后清空';mark(f.key,'',true);});controls.append(show);if(['ONEBOT_ACCESS_TOKEN','ADMIN_ACCESS_TOKEN','SESSION_KEY','REVERSE_WS_TOKEN','WEBHOOK_SECRET'].includes(f.key))controls.append(generate);controls.append(clear);box.append(controls);}$('fields').append(box);}}
function updateSavebar(){if(!setting)return;const count=dirty.size,pending=setting.pending.length;$('save-state').textContent=saving?'正在保存配置…':restarting?'正在重启服务…':count?'有 '+count+' 项未保存的修改':pending?'已保存，'+pending+' 项设置等待重启':'所有设置已保存';$('save-detail').textContent=setting.persistent?'配置保存在本机 .env，服务重启后生效':'本次运行使用临时配置；退出后不保留';$('save').disabled=!count||saving||restarting;$('restart').disabled=saving||restarting||!!count;$('restart').textContent=restarting?'正在重启…':'重启生效';$('restart').title=count?'请先保存或重新加载修改':state?.can_restart===false?'此服务由其他进程管理，点击查看重启说明':'';$('pending-banner').hidden=!pending;$('pending-banner').textContent=pending+' 项配置已保存，当前服务仍使用启动时的配置。'+(state?.can_restart===false?'此工作台复用了其他进程的服务，请在原服务窗口重新启动。':'点击底部“重启生效”应用配置。');}
$('read-models').addEventListener('click',async()=>{const button=$('read-models');button.disabled=true;button.textContent='正在连接…';try{const params={AI_BASE_URL:draft.AI_BASE_URL};if(dirty.has('AI_API_KEY'))params.AI_API_KEY=draft.AI_API_KEY;const result=await api('/models',params);$('model-options').replaceChildren(...result.models.map(id=>{const option=el('option');option.value=id;return option;}));notify('已读取 '+result.models.length+' 个模型，可在模型标识输入框中选择。');}catch(error){notify(error.message,true);}finally{button.disabled=false;button.textContent='读取可用模型';}});
$('setting-search').addEventListener('input',renderFields);$('settings-form').addEventListener('submit',event=>{event.preventDefault();$('save').click();});
$('save').addEventListener('click',async()=>{if(saving||!setting||!dirty.size)return;const invalid=$('settings-form').querySelector(':invalid');if(invalid){invalid.reportValidity();return;}saving=true;$('fields').inert=true;updateSavebar();try{const patch=Object.fromEntries([...dirty].map(key=>[key,draft[key]]));setting=await api('/settings',{revision:setting.revision,values:patch});draft={...setting.values};dirty.clear();renderSettings();notify('设置已保存。重启服务后生效。');}catch(error){const message=error.message.replace(/^Invalid (\w+)$/,'配置值超出允许范围：$1');problem('settings-error',new Error(message));const field=setting.fields.find(f=>message.includes(f.key));if(field){group=field.group;$('setting-search').value='';renderSettings();$('field-'+field.key)?.focus();}$('settings-error').scrollIntoView({block:'nearest',behavior:'auto'});}finally{saving=false;$('fields').inert=false;updateSavebar();}});
$('reload-settings').addEventListener('click',async()=>{if(saving)return;if(dirty.size&&!await confirmAction('放弃未保存的修改？','将重新读取当前已保存的配置。'))return;await loadSettings();});
$('restart').addEventListener('click',async()=>{if(restarting||dirty.size)return;if(state?.can_restart===false){notify('配置已保存。此服务由其他进程管理，请在原服务窗口停止并重新启动。',true);return;}if(!await confirmAction('重启机器人服务？','服务将安全停止并使用已保存的配置重新启动。期间暂时无法收发消息；Web 管理台会保持打开。'+(setting?.values.RETAIN_IGNORED_JOB_CONTENT==='false'?' 当前设置会脱敏既有 ignored 任务正文、输入和回复。此操作不可恢复，重新开启保留也无法恢复旧正文。':'')))return;restarting=true;updateSavebar();try{await api('/restart',{});hasQr=false;expiry=0;await fetchState();await loadSettings();notify('服务已重启，已应用保存的配置。');}catch(error){notify(error.message,true);await fetchState();}finally{restarting=false;updateSavebar();}});
$('export-settings').addEventListener('click',()=>{if(!setting)return;const values=Object.fromEntries(setting.fields.filter(f=>f.type!=='secret').map(f=>[f.key,draft[f.key]]));download('qq-settings',{schema:1,values});notify('已导出非密钥配置。');});$('import-settings').addEventListener('click',()=>{if(!saving)$('import-file').click();});
$('import-file').addEventListener('change',async()=>{const file=$('import-file').files[0];if(!file)return;try{if(file.size>262144)throw new Error('配置文件不能超过 256 KiB。');const data=JSON.parse(await file.text()),values=data.values;if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('请选择由本工作台导出的配置 JSON。');for(const [key,value] of Object.entries(values)){const f=setting.fields.find(f=>f.key===key);if(!f||typeof value!=='string')throw new Error('文件含未知配置项或无效值：'+key);}let count=0;for(const [key,value] of Object.entries(values)){const f=setting.fields.find(f=>f.key===key);if(f.type==='secret'||setting.locked.includes(key))continue;mark(key,value);count++;}renderSettings();notify('已导入 '+count+' 项配置，请检查后保存。');}catch(error){notify(error.message,true);}finally{$('import-file').value='';}});
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
async function poll(){if(pollBusy||restarting)return;pollBusy=true;try{await Promise.all([fetchState(),fetchTelemetry(),(view==='monitor'&&monitorTab==='jobs')?loadJobs():view==='qzone'?loadQzone():view==='agent'?loadAgent():Promise.resolve()]);}finally{pollBusy=false;}}
${qzoneClient}
${configClient}
${groupChatClient}
${pluginsClient}
${memesClient}
${agentClient}
navigate(location.hash.slice(1)||'overview',undefined,true);renderMessages();renderLogs();poll();setInterval(()=>{if(!document.hidden)poll();},1500);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
`;





