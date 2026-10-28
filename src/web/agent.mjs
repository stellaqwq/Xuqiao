export { agentPanel, agentStyles } from './agent-ui.mjs';

export const agentClient = String.raw`
let agentTab='sessions',agentReturnView='overview';
const agentEmptyState=$('agent-chat-feed').firstElementChild.cloneNode(true);
let agentSnapshot=null,agentLoading=false,agentEditing=null,agentDirty=false,agentSaving=false,agentSession='',agentMemoryTicket=0,agentBindingDirty=false;
let agentMemoryEdit=null;
let agentChatSession='',agentChatBusy=false,agentChatPending=false,agentChatSignature='';
let agentChatStream=null,agentChatStreamSession='';
function agentWatchChat(){
  if(agentChatStreamSession===agentChatSession&&agentChatStream)return;
  agentChatStream?.close();agentChatStream=null;agentChatStreamSession=agentChatSession;
  if(!agentChatSession||!window.EventSource)return;
  const session=agentChatSession,source=new EventSource(location.pathname.replace(/\/$/,'')+'/agent/chat/stream?session='+encodeURIComponent(session));agentChatStream=source;
  source.onmessage=event=>{if(session!==agentChatSession)return;try{agentRenderChat(JSON.parse(event.data));}catch{}};
}
window.addEventListener('pagehide',()=>{agentChatStream?.close();agentChatStream=null;});
let agentChatUploading=false;const agentChatAttachments=[];
const agentFileSize=value=>value>=1048576?(value/1048576).toFixed(1)+' MiB':Math.max(1,Math.ceil(value/1024))+' KiB';
function agentRenderAttachments(){const box=$('agent-attachments');box.replaceChildren();box.hidden=!agentChatAttachments.length;for(const file of agentChatAttachments){const row=el('div','agent-attachment'),info=el('div','agent-attachment-info'),name=el('strong','',file.name);name.title=file.name;info.append(name,el('small','',(file.kind==='image'?'图片':'文件')+' · '+agentFileSize(file.size)));if(file.preview){const image=el('img');image.src=file.preview;image.alt='待发送图片：'+file.name;row.append(image);}const remove=el('button','button small','移除');remove.type='button';remove.disabled=agentChatUploading||agentChatBusy;remove.setAttribute('aria-label','移除附件 '+file.name);remove.addEventListener('click',()=>{agentChatAttachments.splice(agentChatAttachments.indexOf(file),1);agentRenderAttachments();$('agent-attach').focus();});row.append(info,remove);box.append(row);}$('agent-attach').disabled=agentChatUploading||agentChatBusy;$('agent-chat-send').disabled=agentChatPending||agentChatBusy||agentChatUploading;const max=agentSnapshot?.attachments?.max_bytes||10485760;$('agent-attachment-limit').textContent=(agentChatAttachments.length?agentChatAttachments.length+'/4 个 · '+agentFileSize(agentChatAttachments.reduce((n,f)=>n+f.size,0))+' / ':'最多 4 个附件 · 合计 ')+agentFileSize(max);}
async function agentAddFiles(files){if(agentChatUploading||agentChatBusy)return;files=Array.from(files);if(!files.length)return;const max=agentSnapshot?.attachments?.max_bytes||10485760;if(files.length+agentChatAttachments.length>4){$('agent-chat-state').textContent='每条消息最多 4 个附件，请分批添加。';return;}if(files.reduce((n,f)=>n+f.size,0)+agentChatAttachments.reduce((n,f)=>n+f.size,0)>max){$('agent-chat-state').textContent='附件总大小不能超过 '+agentFileSize(max)+'，请分批发送。';return;}agentChatUploading=true;agentRenderAttachments();$('agent-chat-state').textContent='正在上传附件…';try{for(const file of files){if(!file.size)throw Error('“'+file.name+'”为空，请选择有内容的文件。');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取附件失败，请重新选择。'));reader.readAsDataURL(file);});const saved=await api('/agent/attachments',{name:file.name,data});agentChatAttachments.push({...saved,preview:saved.kind==='image'?'data:'+saved.mime+';base64,'+data.slice(data.indexOf(',')+1):''});}$('agent-chat-state').textContent='附件已准备好，可以添加问题后发送。';}catch(error){$('agent-chat-state').textContent=error.message;}finally{agentChatUploading=false;$('agent-attachment-input').value='';agentRenderAttachments();}}
$('agent-attach').addEventListener('click',()=>$('agent-attachment-input').click());$('agent-attachment-input').addEventListener('change',event=>{const files=Array.from(event.target.files);event.target.value='';void agentAddFiles(files);});
for(const name of ['dragenter','dragover'])$('agent-chat-form').addEventListener(name,event=>{if(!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;event.preventDefault();$('agent-chat-form').dataset.drag='true';});
$('agent-chat-form').addEventListener('dragleave',event=>{if(!$('agent-chat-form').contains(event.relatedTarget))delete $('agent-chat-form').dataset.drag;});$('agent-chat-form').addEventListener('drop',event=>{delete $('agent-chat-form').dataset.drag;if(!event.dataTransfer?.files.length)return;event.preventDefault();void agentAddFiles(event.dataTransfer.files);});
$('agent-chat-input').addEventListener('paste',event=>{if(!event.clipboardData?.files.length)return;event.preventDefault();void agentAddFiles(event.clipboardData.files);});
try{agentChatSession=localStorage.getItem('qq-agent-web-session')||'';}catch{}
const agentRunStates={running:'执行中',completed:'生成完成',failed:'生成失败',interrupted:'执行已中断'};
const agentStepStates={running:'执行中',succeeded:'成功',cached:'复用既有结果',failed:'失败',uncertain:'结果未知',interrupted:'已中断'};
function agentOptions(node,items,first){const value=node.value;node.replaceChildren();const option=el('option','',first);option.value='';node.append(option);for(const item of items){const opt=el('option','',item.label);opt.value=item.id;node.append(opt);}if([...node.options].some(o=>o.value===value))node.value=value;}
function agentEdit(id){agentEditing=agentSnapshot?.personas.find(p=>p.id===id)||null;$('agent-persona-select').value=agentEditing?.id||'';$('agent-persona-name').value=agentEditing?.name||'';$('agent-persona-prompt').value=agentEditing?.prompt||'';$('agent-persona-tools').value=agentEditing?.tools==null?'*':agentEditing.tools.join(', ');agentDirty=false;$('agent-persona-state').textContent='';$('agent-delete-persona').disabled=!agentEditing;}
function renderAgent(){
  if(!agentSnapshot)return;const s=agentSnapshot;$('agent-chat-model').textContent=s.model||'尚未配置模型';agentRenderAttachments();
  $('agent-status').textContent=(!s.ai_enabled?'AI 尚未启用 · 请先设置模型和回复白名单':!s.enabled?'Agent 已关闭 · 当前使用传统 AI 回复':'Agent 已启用 · '+s.model)+' · 最多 '+s.max_steps+' 次模型请求 / '+s.max_tool_calls+' 次工具调用';
  agentOptions($('agent-session'),s.sessions.map(x=>({id:x.conversation,label:(x.conversation.startsWith('web:')?'网页试聊 · '+x.conversation.slice(-8):(x.conversation.split(':')[1]==='group'?'群聊 · ':'私聊 · QQ ')+x.conversation.split(':')[2])+' · '+x.jobs+' 条任务'})),'选择会话');
  if(!agentSession&&s.sessions.length)agentSession=s.sessions[0].conversation;$('agent-session').value=agentSession;
  agentOptions($('agent-binding'),s.personas.map(p=>({id:p.id,label:p.name})),'默认人格 · 使用 AI 系统提示词');
  const session=s.sessions.find(x=>x.conversation===agentSession);if(!agentBindingDirty)$('agent-binding').value=session?.persona||'';
  $('agent-bind').disabled=!session;$('agent-reset').disabled=!session;
  agentOptions($('agent-persona-select'),s.personas.map(p=>({id:p.id,label:p.name})),'新建人格');
  if(!agentDirty&&!agentSaving)agentEdit(agentEditing?.id||'');
  $('agent-tool-list').replaceChildren();for(const tool of s.tools){const row=el('div','agent-tool');row.append(el('code','',tool.name),badge(tool.source+(tool.enabled===false?' · 已停用':'')),el('p','',tool.description));$('agent-tool-list').append(row);}
  const runs=$('agent-runs'),old=new Set([...runs.querySelectorAll('details[open]')].map(d=>d.dataset.run));runs.replaceChildren();
  if(!s.runs.length)empty(runs,'等待第一条任务','连接 QQ、启用 AI 并设置回复范围后，即可在 QQ 中自然描述任务。');
  for(const run of s.runs){const details=el('details','agent-run');details.dataset.run=String(run.job_id);const summary=el('summary');summary.append(el('strong','','#'+run.job_id+' · '+run.persona),badge(agentRunStates[run.state]||run.state,run.state==='failed'?'bad':run.state==='completed'?'ok':''),el('span','muted',dateTime(run.updated_at)),el('span','muted','回复：'+(statusLabels[run.job_status]||run.job_status)));const body=el('div');details.append(summary,body);const load=async()=>{body.replaceChildren(el('p','help-text','正在读取执行过程…'));try{const job=await api('/job?id='+run.job_id);body.replaceChildren();const list=el('ol','agent-trace');for(const step of job.agent_steps||[]){const item=el('li');item.append(document.createTextNode((step.kind==='tool'?'工具 · ':'')+step.name+' · '+(agentStepStates[step.state]||step.state)+' '),el('small','',step.duration_ms+' ms'));list.append(item);}body.append(list,el('pre','',formatJobDetail({...job,agent_steps:[]})));}catch(error){body.replaceChildren(el('p','stream-error',error.message));}};details.addEventListener('toggle',()=>{if(details.open)void load();});runs.append(details);if(old.has(details.dataset.run))details.open=true;}
}
async function loadAgent(){if(agentLoading||agentSaving)return;agentLoading=true;try{const next=await api('/agent');problem('agent-error',null);if(JSON.stringify(next)!==JSON.stringify(agentSnapshot)){agentSnapshot=next;renderAgent();if(agentSession)await loadAgentMemories(true);}await loadAgentChat();}catch(error){problem('agent-error',error);}finally{agentLoading=false;}}
function editAgentMemory(memory,row){
  if(agentMemoryEdit)return;
  const draft={...memory,dirty:false,saving:false};agentMemoryEdit=draft;++agentMemoryTicket;
  $('agent-session').disabled=true;for(const button of $('agent-memories').querySelectorAll('button'))button.disabled=true;
  const form=el('form','agent-memory-editor'),name=el('input'),value=el('textarea'),nameLabel=el('label','','记忆名称（最多 60 字符）'),valueLabel=el('label','','记忆内容（最多 500 字符）');
  form.setAttribute('aria-label','编辑已保存的记忆');name.id='agent-memory-name';name.maxLength=60;name.required=true;name.value=memory.key;nameLabel.htmlFor=name.id;
  value.id='agent-memory-value';value.maxLength=500;value.required=true;value.rows=5;value.value=memory.value;valueLabel.htmlFor=value.id;
  const actions=el('div','agent-memory-actions'),save=el('button','button primary','保存记忆'),cancel=el('button','button','取消'),state=el('p','help-text');
  save.id='agent-memory-save';save.type='submit';save.disabled=true;cancel.id='agent-memory-cancel';cancel.type='button';state.id='agent-memory-state';state.setAttribute('role','status');
  form.addEventListener('input',()=>{draft.dirty=name.value!==memory.key||value.value!==memory.value;save.disabled=!draft.dirty;state.textContent=draft.dirty?'有未保存的修改':'';state.className='help-text';});
  cancel.addEventListener('click',()=>{if(draft.saving)return;agentMemoryEdit=null;$('agent-session').disabled=false;void loadAgentMemories();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(draft.saving||!draft.dirty)return;
    if(!name.value.trim()||!value.value.trim()){state.className='stream-error';state.textContent='记忆名称和内容不能为空。';return;}
    draft.saving=true;for(const control of form.elements)control.disabled=true;state.className='help-text';state.textContent='正在保存…';
    try{
      await api('/agent/memory/update',{scope:memory.scope,key:memory.key,newKey:name.value,value:value.value,revision:memory.revision});
      agentMemoryEdit=null;$('agent-session').disabled=false;await loadAgentMemories();notify('记忆已保存，后续任务使用更新后的内容。');
    }catch(error){state.className='stream-error';state.textContent=error.message;}
    finally{draft.saving=false;if(agentMemoryEdit===draft){for(const control of form.elements)control.disabled=false;save.disabled=!draft.dirty;}}
  });
  actions.append(cancel,save);form.append(nameLabel,name,valueLabel,value,el('small','','保存后用于后续任务。保存或取消后可切换会话。'),state,actions);
  row.replaceChildren(el('strong','','编辑记忆'),el('small','',memory.scope.includes(':user:')?'QQ '+memory.scope.split(':user:')[1]:'当前会话'),form);name.focus();
}
async function loadAgentMemories(quiet=false){
  if(agentMemoryEdit)return;
  const ticket=++agentMemoryTicket,box=$('agent-memories'),session=agentSession;
  if(!session){box.replaceChildren(el('p','help-text','开始网页试聊或收到 QQ 消息后，即可查看会话记忆。'));return;}
  if(!quiet)box.replaceChildren(el('p','help-text','正在读取记忆…'));
  try{
    const items=await api('/agent/memories?conversation='+encodeURIComponent(session));
    if(ticket!==agentMemoryTicket||session!==agentSession||agentMemoryEdit)return;
    box.replaceChildren();if(!items.length)box.append(el('p','help-text','尚无记忆。可以在 QQ 中说“记住我喜欢简洁回答”。'));
    for(const memory of items){
      const row=el('div','agent-memory'),actions=el('div','agent-memory-actions'),edit=el('button','button small','编辑'),remove=el('button','button small','删除');
      row.dataset.scope=memory.scope;row.dataset.key=memory.key;edit.dataset.action='edit';remove.dataset.action='delete';
      edit.addEventListener('click',()=>editAgentMemory(memory,row));
      remove.addEventListener('click',async()=>{
        if(agentMemoryEdit||!await confirmAction('删除这条记忆？','删除后无法恢复，不影响会话上下文。'))return;
        remove.disabled=true;try{await api('/agent/forget',{scope:memory.scope,key:memory.key});await loadAgentMemories();}catch(error){notify(error.message,true);remove.disabled=false;}
      });
      actions.append(edit,remove);row.append(el('strong','',memory.key),actions,el('p','',memory.value),el('small','',(memory.scope.includes(':user:')?'QQ '+memory.scope.split(':user:')[1]:'当前会话')+' · '+dateTime(memory.updated_at)));box.append(row);
    }
  }catch(error){if(ticket===agentMemoryTicket&&!agentMemoryEdit)box.replaceChildren(el('p','stream-error',error.message));}
}
$('agent-binding').addEventListener('change',()=>{agentBindingDirty=true;});
$('agent-session').addEventListener('change',()=>{if(agentMemoryEdit){$('agent-session').value=agentSession;return;}agentBindingDirty=false;agentSession=$('agent-session').value;const row=agentSnapshot?.sessions.find(s=>s.conversation===agentSession);$('agent-binding').value=row?.persona||'';$('agent-bind').disabled=!row;$('agent-reset').disabled=!row;void loadAgentMemories();});
$('agent-refresh').addEventListener('click',async()=>{await loadAgent();await loadAgentMemories();});
$('agent-bind').addEventListener('click',async()=>{if(!agentSession||!await confirmAction('应用人格并清空上下文？','后续消息将使用所选人格。已保存记忆继续保留。'))return;try{await api('/agent/bind',{conversation:agentSession,persona:$('agent-binding').value});agentBindingDirty=false;await loadAgent();notify('会话人格已更新。');}catch(error){notify(error.message,true);}});
$('agent-reset').addEventListener('click',async()=>{if(!agentSession||!await confirmAction('清空会话上下文？','此前的聊天不再提供给模型。已保存记忆继续保留。'))return;try{await api('/agent/reset',{conversation:agentSession});notify('会话上下文已清空。');}catch(error){notify(error.message,true);}});
async function agentSwitch(id){if(agentDirty&&!await confirmAction('放弃未保存的人格修改？','当前编辑内容尚未保存。')){$('agent-persona-select').value=agentEditing?.id||'';return;}agentEdit(id);}
$('agent-persona-select').addEventListener('change',()=>void agentSwitch($('agent-persona-select').value));$('agent-new-persona').addEventListener('click',()=>void agentSwitch(''));
$('agent-persona-form').addEventListener('input',()=>{agentDirty=true;$('agent-persona-state').textContent='有未保存的修改';});
$('agent-persona-form').addEventListener('submit',async event=>{event.preventDefault();if(agentSaving)return;agentSaving=true;for(const node of $('agent-persona-form').elements)node.disabled=true;try{const names=$('agent-persona-tools').value.trim();const saved=await api('/agent/persona',{id:agentEditing?.id,revision:agentEditing?.revision,name:$('agent-persona-name').value,prompt:$('agent-persona-prompt').value,tools:names==='*'?null:names.split(/[,，\s]+/).filter(Boolean)});agentDirty=false;agentEditing=saved;agentSaving=false;await loadAgent();$('agent-persona-state').textContent='人格已保存，绑定后用于后续任务';}catch(error){notify(error.message,true);}finally{agentSaving=false;for(const node of $('agent-persona-form').elements)node.disabled=false;$('agent-delete-persona').disabled=!agentEditing;}});
$('agent-delete-persona').addEventListener('click',async()=>{if(!agentEditing||!await confirmAction('删除人格？','绑定该人格的会话将恢复默认人格，并清空短期上下文。'))return;try{await api('/agent/persona/delete',{id:agentEditing.id,revision:agentEditing.revision});agentDirty=false;agentEditing=null;await loadAgent();notify('人格已删除。');}catch(error){notify(error.message,true);}});
window.addEventListener('beforeunload',event=>{if(agentDirty||agentMemoryEdit?.dirty){event.preventDefault();event.returnValue='';}});
function agentRenderChat(result){
  if(result.session!==agentChatSession)return;
  const signature=JSON.stringify(result);if(signature===agentChatSignature)return;agentChatSignature=signature;
  const feed=$('agent-chat-feed'),scroll=feed.scrollTop,follow=feed.scrollHeight-scroll-feed.clientHeight<60;
  feed.replaceChildren();if(!result.jobs.length)feed.append(agentEmptyState.cloneNode(true));
  agentChatPending=result.jobs.some(j=>['queued','generating','ready','sending'].includes(j.status));
  for(const job of result.jobs){
    const fallback=job.reason==='ai_reply_empty_after_filter'?'回复只包含表情，过滤后没有可显示的正文。':
      ['failed','ignored','uncertain'].includes(job.status)?'任务未完成：'+(job.reason||job.status):'正在处理…';
    for(const [label,text] of [['你',job.input||'消息正文未保留。'],['Agent',job.reply||fallback]]){
      const row=el('article','agent-chat-message');row.dataset.role=label==='你'?'user':'assistant';
      row.append(el('strong','',label),el('p','',text));
      if(label==='你'&&job.attachments?.length){const names=el('div','agent-chat-files');for(const file of job.attachments)names.append(el('span','',file.name+' · '+agentFileSize(file.size)));row.append(names);}
      if(label==='Agent'&&['failed','uncertain'].includes(job.status)&&job.reply)row.append(el('small','help-text','回复已中断：'+(job.reason||job.status)));
      feed.append(row);
    }
  }
  feed.scrollTop=follow?feed.scrollHeight:scroll;
  if(!agentChatUploading&&!agentChatAttachments.length)$('agent-chat-state').textContent=agentChatPending?'Agent 正在生成回复…':'';
  $('agent-chat-send').disabled=agentChatPending||agentChatBusy||agentChatUploading;
}
async function loadAgentChat(){agentWatchChat();if(!agentChatSession)return;const session=agentChatSession;try{const result=await api('/agent/chat?session='+encodeURIComponent(session));if(session===agentChatSession)agentRenderChat(result);}catch(error){$('agent-chat-state').textContent=error.message;}}
$('agent-chat-form').addEventListener('submit',async event=>{event.preventDefault();if(agentChatBusy||agentChatPending||agentChatUploading)return;if(!$('agent-chat-input').value.trim()&&!agentChatAttachments.length){$('agent-chat-state').textContent='请输入消息或添加图片、文件。';return;}agentChatBusy=true;agentRenderAttachments();$('agent-chat-state').textContent='正在提交任务…';try{const result=await api('/agent/chat',{session:agentChatSession||undefined,text:$('agent-chat-input').value,attachments:agentChatAttachments.map(file=>file.id)});if(!agentChatSession&&!agentMemoryEdit){agentSession='web:'+result.session;agentBindingDirty=false;}agentChatSession=result.session;try{localStorage.setItem('qq-agent-web-session',agentChatSession);}catch{}$('agent-chat-input').value='';agentChatAttachments.length=0;agentChatBusy=false;agentRenderAttachments();await loadAgentChat();await loadAgent();}catch(error){$('agent-chat-state').textContent=error.message;}finally{agentChatBusy=false;agentRenderAttachments();}});
$('agent-chat-new').addEventListener('click',()=>{if(agentChatBusy||agentChatUploading)return;agentChatSession='';agentWatchChat();agentChatSignature='';agentChatPending=false;agentChatAttachments.length=0;agentRenderAttachments();try{localStorage.removeItem('qq-agent-web-session');}catch{}$('agent-chat-feed').replaceChildren(agentEmptyState.cloneNode(true));$('agent-chat-state').textContent='';$('agent-chat-send').disabled=false;});

function agentSyncMode(){const active=view==='agent'&&agentTab==='chat';$('test-chat-entry').setAttribute('aria-pressed',String(active));$('test-chat-entry').setAttribute('aria-label',active?'返回机器人管理':'切换到测试对话');$('test-chat-entry').querySelector('span').textContent=active?'返回管理':'测试对话';}
function agentSetTab(name){if(!['sessions','personas','activity','chat'].includes(name))return;agentTab=name;for(const pane of document.querySelectorAll('[data-agent-pane]'))pane.hidden=pane.dataset.agentPane!==name;for(const tab of document.querySelectorAll('[data-agent-tab]')){const selected=tab.dataset.agentTab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}document.querySelector('.agent-tabs').hidden=name==='chat';agentSyncMode();}
for(const tab of document.querySelectorAll('[data-agent-tab]')){tab.addEventListener('click',()=>agentSetTab(tab.dataset.agentTab));tab.addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('[data-agent-tab]')];let index=tabs.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();tabs[index].click();tabs[index].focus();});}
for(const button of document.querySelectorAll('[data-agent-open]'))button.addEventListener('click',()=>agentSetTab(button.dataset.agentOpen));
$('test-chat-entry').addEventListener('click',()=>{if(view==='agent'&&agentTab==='chat'){agentSetTab('sessions');navigate(agentReturnView);}else{agentReturnView=view;navigate('agent');agentSetTab('chat');$('agent-chat-input').focus({preventScroll:true});}});
$('agent-chat-feed').addEventListener('click',event=>{const button=event.target.closest('[data-agent-prompt]');if(!button)return;$('agent-chat-input').value=button.dataset.agentPrompt;$('agent-chat-input').focus();});
$('agent-chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('agent-chat-send').disabled&&($('agent-chat-input').value.trim()||agentChatAttachments.length))$('agent-chat-form').requestSubmit();}});
`;
