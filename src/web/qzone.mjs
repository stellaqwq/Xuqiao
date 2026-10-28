export const qzonePanel = `
<section id="view-qzone" aria-label="QQ 空间" hidden>
  <div class="toolbar"><span class="tag" id="qzone-account">正在读取空间状态…</span><span id="qzone-mode" class="help-text"></span><span class="spacer"></span><button class="button" id="qzone-refresh">刷新空间记录</button></div>
  <p id="qzone-error" class="banner error" role="alert" hidden></p>
  <details class="panel qzone-credentials" id="qzone-credentials"><summary>空间登录凭据</summary><div class="panel-body">
    <p class="help-text">在浏览器登录 user.qzone.qq.com，从开发者工具“网络”中复制空间请求的 Cookie。需要 uin（或 p_uin）和 p_skey。凭据加密保存在本机，保存后立即生效。</p>
    <form id="qzone-session-form" autocomplete="off"><div class="field"><label for="qzone-cookie">QQ 空间 Cookie</label><input id="qzone-cookie" type="password" autocomplete="new-password" placeholder="粘贴 Cookie，保存后自动清空" required maxlength="16384"></div>
    <div class="field"><label for="qzone-token">qzonetoken（可选）</label><input id="qzone-token" type="password" autocomplete="new-password" maxlength="256" placeholder="留空时尝试从空间主页获取"></div>
    <div class="inline-actions"><button class="button" id="qzone-session-save" type="submit">保存空间凭据</button><button class="button" id="qzone-check" type="button">验证凭据</button><button class="button danger" id="qzone-clear" type="button">移除凭据</button></div></form>
  </div></details>
  <div class="panel qzone-compose"><div class="panel-head"><h2>写一条说说</h2><button class="text-button" id="qzone-new">新建草稿</button></div><div class="panel-body">
    <div class="field"><label for="qzone-prompt">主题与素材</label><textarea id="qzone-prompt" rows="3" maxlength="4000" placeholder="例如：用轻松的语气写周末心情，80 字以内，不编造出游经历。"></textarea><p class="help-text" id="qzone-ai-help">使用已保存的 AI 模型生成文案，生成后可继续修改。</p></div>
    <div class="inline-actions"><button class="button" id="qzone-generate">AI 生成草稿</button><span class="help-text" id="qzone-generation" role="status"></span></div>
    <div class="field"><label for="qzone-content">说说正文</label><textarea id="qzone-content" rows="7" maxlength="4000" placeholder="输入正文，或先用 AI 生成草稿。" aria-describedby="qzone-count"></textarea><p class="help-text" id="qzone-count">0 / 2000 字</p></div>
    <div class="qzone-publish-row"><div class="field"><label for="qzone-visibility">谁可以看</label><select id="qzone-visibility"><option value="private">仅自己</option><option value="friends">QQ 好友</option><option value="public">所有人</option></select></div><div class="inline-actions"><button class="button" id="qzone-save">保存草稿</button><button class="button primary" id="qzone-publish">发布到 QQ 空间</button></div></div>
    <p id="qzone-editor-state" class="help-text" role="status">正文会先保存为草稿，再按所选范围发布。</p>
  </div></div>
  <div class="panel"><div class="panel-head"><h2>草稿与发布记录</h2><span class="help-text">最近 50 条</span></div><div id="qzone-posts" class="qzone-posts"></div><div class="table-footer"><p id="qzone-retention">正在读取保留周期…</p><p>结果未知时请先在空间核对，再标记已发布或放弃。系统不会自动重发。</p></div></div>
</section>`;

export const qzoneStyles = String.raw`
.qzone-credentials{margin-bottom:20px}.qzone-credentials>summary{padding:18px 23px;cursor:pointer;font-weight:600}.qzone-credentials .help-text{margin-top:0}.qzone-credentials form{display:grid;gap:18px}.qzone-compose{margin-bottom:20px}.qzone-compose .panel-body{display:grid;gap:20px}.qzone-compose .field{min-width:0}.qzone-compose textarea{resize:vertical;line-height:1.7}.qzone-publish-row{display:flex;gap:20px;justify-content:space-between;align-items:end;flex-wrap:wrap}.qzone-publish-row .field{min-width:150px}.qzone-publish-row select{width:100%;padding:9px 12px}.qzone-post{padding:20px 23px;border-top:1px solid var(--line)}.qzone-post:first-child{border-top:0}.qzone-post-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.qzone-post-head time{color:var(--muted);font-size:12px}.qzone-post-content{white-space:pre-wrap;overflow-wrap:anywhere;max-width:75ch;margin:12px 0}.qzone-post .inline-actions{flex-wrap:wrap}.qzone-post .help-text{overflow-wrap:anywhere}.qzone-post a{color:var(--accent);text-underline-offset:3px}.qzone-posts .empty{padding:30px}
#confirm-body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}
@media(max-width:680px){.qzone-credentials>summary{padding:18px}.qzone-post{padding:18px}.qzone-publish-row{align-items:stretch}.qzone-publish-row .field{flex:1}.qzone-publish-row .inline-actions{width:100%;flex-wrap:wrap}.qzone-publish-row button{flex:1;min-height:44px}.qzone-credentials .inline-actions{flex-wrap:wrap}.qzone-compose select{font-size:16px;min-height:44px}}
`;

export const qzoneClient = String.raw`
let qzoneState=null,qzoneRows=[],qzoneSelected=null,qzoneBusy=false,qzoneLoading=false,qzoneDirty=false,qzoneGenerationId=null,qzoneContentVersion=0,qzoneSignature=null;
const qzoneLabels={generating:'正在生成',draft:'草稿',publishing:'正在发布',published:'已发布',failed:'失败',uncertain:'结果未知',discarded:'已放弃'};
const qzoneVisibility={private:'仅自己',friends:'QQ 好友',public:'所有人'};
const qzoneReasons={generation_failed:'AI 生成失败，请检查模型配置后重试。',generation_interrupted:'上次生成已中断，可重新生成。',publish_rejected:'发布被拒绝或凭据验证失败。请在浏览器检查空间登录、权限与验证，再保存草稿后重试。',publish_uncertain:'发布结果未知，请先去 QQ 空间核对。',process_stopped_during_publish:'发布过程中服务中断，请先去 QQ 空间核对。',manually_resolved:'已人工核对。'};
function qzoneButtons(){
  const selected=qzoneRows.find(r=>r.id===qzoneSelected?.id),locked=selected&&!['draft','failed'].includes(selected.status);
  $('qzone-generate').disabled=qzoneBusy||qzoneGenerationId!==null||!qzoneState?.ai_ready;
  $('qzone-save').disabled=qzoneBusy||!!locked;
  $('qzone-publish').disabled=qzoneBusy||!!locked||!qzoneState?.configured;
  $('qzone-new').disabled=qzoneBusy;
  for(const id of ['qzone-content','qzone-visibility'])$(id).disabled=qzoneBusy||!!locked;
  for(const id of ['qzone-session-save','qzone-check','qzone-clear'])$(id).disabled=qzoneBusy||!!qzoneState?.simulated;
  for(const button of $('qzone-posts').querySelectorAll('button'))button.disabled=qzoneBusy;
}
function renderQzone(){
  if(!qzoneState)return;
  $('qzone-account').textContent=qzoneState.configured?'空间账号：QQ '+qzoneState.account:'尚未设置空间凭据';
  $('qzone-mode').textContent=qzoneState.simulated?'演示模式：生成与发布均为模拟':qzoneState.credential_error?'凭据无法解密，请重新保存空间 Cookie。':'纯文字说说 · 使用独立空间凭据';
  $('qzone-ai-help').textContent=qzoneState.ai_ready?'使用已保存的模型生成文案，聊天自动回复可保持关闭。':'请先在全部设置中配置 AI 模型，保存后重启。';
  $('qzone-retention').textContent='草稿与已完成记录保留 '+qzoneState.retention_days+' 天；结果未知记录保留 '+qzoneState.uncertain_retention_days+' 天。';
  const signature=JSON.stringify(qzoneRows);
  if(signature===qzoneSignature){qzoneButtons();return;}
  qzoneSignature=signature;
  const box=$('qzone-posts');box.replaceChildren();
  if(!qzoneRows.length)empty(box,'还没有空间动态','输入主题生成第一份说说草稿，也可以直接填写正文。');
  for(const row of qzoneRows){
    const item=el('article','qzone-post'),head=el('div','qzone-post-head');
    head.append(el('strong','','#'+row.id),badge(qzoneLabels[row.status]||row.status,row.status==='published'?'ok':row.status==='failed'?'bad':row.status==='uncertain'?'warn':''),el('time','',dateTime(row.updated_at)),el('span','help-text',qzoneVisibility[row.visibility]));
    if(row.simulated)head.append(badge('模拟'));
    item.append(head,el('p','qzone-post-content',row.content||row.prompt));
    if(row.account)item.append(el('p','help-text','发布账号：QQ '+row.account));
    if(row.reason)item.append(el('p','help-text',qzoneReasons[row.reason]||'请核对这条记录。'));
    const actions=el('div','inline-actions');
    if(['draft','failed'].includes(row.status)){const edit=el('button','button small','载入草稿');edit.addEventListener('click',()=>selectQzone(row));actions.append(edit);}
    if(row.status==='uncertain')for(const [outcome,label] of [['published','已在空间确认发布'],['discard','放弃这条记录']]){const button=el('button','button small',label);button.addEventListener('click',()=>qzoneResolve(row,outcome));actions.append(button);}
    if(typeof row.url==='string'&&row.url.startsWith('https://user.qzone.qq.com/')){const link=el('a','','查看说说');link.href=row.url;link.target='_blank';link.rel='noopener noreferrer';actions.append(link);}
    item.append(actions);box.append(item);
  }
  qzoneButtons();
}
function qzoneEditor(){const n=Array.from($('qzone-content').value).length;$('qzone-count').textContent=n+' / 2000 字';$('qzone-editor-state').textContent=qzoneSelected?'当前草稿 #'+qzoneSelected.id+(qzoneDirty?' · 有未保存的修改':' · '+(qzoneLabels[qzoneRows.find(r=>r.id===qzoneSelected.id)?.status]||qzoneLabels[qzoneSelected.status])):'正文会先保存为草稿，再按所选范围发布。';qzoneButtons();}
async function selectQzone(row){if(qzoneBusy)return;if(qzoneDirty&&!await confirmAction('载入另一份草稿？','当前尚未保存的正文将被替换。'))return;qzoneSelected=row;$('qzone-content').value=row.content;$('qzone-visibility').value=row.visibility;$('qzone-prompt').value=row.prompt||'';qzoneDirty=false;qzoneContentVersion++;qzoneEditor();$('qzone-content').focus();}
async function loadQzone(){if(qzoneLoading)return;qzoneLoading=true;try{
  const [s,rows]=await Promise.all([api('/qzone/status'),api('/qzone/posts')]);qzoneState=s;qzoneRows=rows;
  if(qzoneGenerationId!==null){const row=rows.find(r=>r.id===qzoneGenerationId.id);if(row&&row.status!=='generating'){
    if(row.status==='draft'&&qzoneGenerationId.version===qzoneContentVersion){qzoneSelected=row;$('qzone-content').value=row.content;$('qzone-visibility').value=row.visibility;qzoneDirty=false;}
    $('qzone-generation').textContent=row.status==='draft'?'文案已生成并保存。':'生成失败，请检查模型后重试。';qzoneGenerationId=null;
  }}
  renderQzone();qzoneEditor();
}catch(error){problem('qzone-error',error);}finally{qzoneLoading=false;}}
async function qzoneRun(fn){if(qzoneBusy)return;qzoneBusy=true;problem('qzone-error',null);qzoneButtons();try{await fn();}catch(error){problem('qzone-error',error);}finally{qzoneBusy=false;await loadQzone();qzoneButtons();}}
async function saveQzoneDraft(){const row=await api('/qzone/draft',{content:$('qzone-content').value,visibility:$('qzone-visibility').value,...(qzoneSelected?{id:qzoneSelected.id,revision:qzoneSelected.revision}:{})});qzoneSelected=row;qzoneDirty=false;return row;}
$('qzone-content').addEventListener('input',()=>{qzoneDirty=true;qzoneContentVersion++;qzoneEditor();});$('qzone-visibility').addEventListener('change',()=>{qzoneDirty=true;qzoneContentVersion++;qzoneEditor();});
$('qzone-new').addEventListener('click',async()=>{if(qzoneDirty&&!await confirmAction('新建草稿？','当前尚未保存的正文将被清空。'))return;qzoneSelected=null;qzoneDirty=false;qzoneContentVersion++;$('qzone-content').value='';$('qzone-prompt').value='';$('qzone-visibility').value='private';qzoneEditor();$('qzone-prompt').focus();});
$('qzone-refresh').addEventListener('click',loadQzone);
$('qzone-session-form').addEventListener('submit',event=>{event.preventDefault();qzoneRun(async()=>{qzoneState=await api('/qzone/session',{cookie:$('qzone-cookie').value,token:$('qzone-token').value});$('qzone-cookie').value='';$('qzone-token').value='';notify('空间凭据已加密保存。');});});
$('qzone-check').addEventListener('click',()=>qzoneRun(async()=>{await api('/qzone/check',{});notify('空间凭据验证通过。');}));
$('qzone-clear').addEventListener('click',()=>qzoneRun(async()=>{if(!await confirmAction('移除空间凭据？','本机将无法发布新的说说，已有草稿和发布记录仍会保留。'))return;await api('/qzone/clear',{});$('qzone-cookie').value='';$('qzone-token').value='';notify('空间凭据已移除。');}));
$('qzone-generate').addEventListener('click',()=>qzoneRun(async()=>{if(qzoneDirty&&!await confirmAction('生成新的文案？','生成结果会载入正文。当前修改可先保存为草稿。'))return;const row=await api('/qzone/generate',{prompt:$('qzone-prompt').value,visibility:$('qzone-visibility').value});qzoneGenerationId={id:row.id,version:qzoneContentVersion};$('qzone-generation').textContent='正在生成文案，可继续编辑正文…';}));
$('qzone-save').addEventListener('click',()=>qzoneRun(async()=>{await saveQzoneDraft();notify('草稿已保存。');}));
$('qzone-publish').addEventListener('click',()=>qzoneRun(async()=>{
  const row=await saveQzoneDraft(),account=qzoneState.account;
  if(!await confirmAction(qzoneState.simulated?'模拟发布说说？':'发布这条说说？','QQ '+account+' · '+qzoneVisibility[row.visibility]+'\n\n'+row.content))return;
  const result=await api('/qzone/publish',{id:row.id,revision:row.revision,account});qzoneSelected=result;
  notify(result.status==='published'?(result.simulated?'模拟发布完成，未发送到真实空间。':'说说已发布。'):result.status==='uncertain'?'结果未知，请先在空间核对。':'发布未完成，请查看记录。',result.status!=='published');
}));
function qzoneResolve(row,outcome){return qzoneRun(async()=>{if(!await confirmAction('确认核对结果？',outcome==='published'?'请确认已在 QQ 空间看到这条说说。':'这条记录将被放弃，不会再次发布。'))return;await api('/qzone/resolve',{id:row.id,revision:row.revision,outcome});notify('核对结果已保存。');});}
window.addEventListener('beforeunload',event=>{if(qzoneDirty){event.preventDefault();event.returnValue='';}});
`;
