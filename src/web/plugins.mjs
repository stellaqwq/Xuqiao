export const pluginsPanel = String.raw`
<section id="view-plugins" aria-label="插件管理" hidden>
  <div class="toolbar"><input id="plugin-search" type="search" placeholder="搜索插件名称、说明…" aria-label="搜索插件"><select id="plugin-filter" aria-label="插件状态"><option value="all">全部插件</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><span class="spacer"></span><button class="button" id="plugin-reload">刷新列表</button><button class="button" id="plugin-import">导入插件</button><input id="plugin-file" type="file" accept=".json,application/json" hidden><button class="button" data-go="memes">表情插件与图库</button><button class="button primary" id="plugin-create">新建插件</button></div>
  <div class="toolbar"><label class="filter-control"><span>内置插件</span><select id="plugin-builtin-kind"><option value="group-chat-plus">群聊增强 Chat Plus</option><option value="voicestudio">VoiceStudio</option><option value="meme-manager">表情包管理器</option></select></label><button id="plugin-builtin-install" class="button">安装或打开</button><span class="help-text">已有插件保留配置；首次安装默认停用。</span></div>
  <div id="plugin-behaviors" class="panel" hidden><div class="panel-head"><h2 id="plugin-behaviors-title">插件行为</h2><button id="plugin-behaviors-close" class="button small">收起</button></div><div class="panel-body" id="plugin-behaviors-body"></div></div>
  <p id="plugin-error" class="banner error" role="alert" hidden></p>
  <div class="panel"><div class="panel-head"><h2>本地插件 <span id="plugin-count" class="muted">读取中</span></h2><span class="tag">保存与启停即时生效</span></div><div id="plugin-list" aria-live="polite"><div class="empty"><p>正在读取插件…</p></div></div><div class="table-footer"><p>按优先级从高到低执行；已回复或返回 handled: true 后停止后续插件与 AI。未处理的消息继续进入原有 AI 回复规则。</p></div></div>
  <div class="plugin-trust"><strong>仅运行可信代码</strong><p>插件是 JavaScript 模块，拥有本机 Node.js 的文件与网络权限。独立线程和执行时限用于处理卡死与异常，不是权限沙箱。导入后请先检查代码和配置。</p></div>
  <div class="panel plugin-editor" id="plugin-editor" hidden>
    <div class="panel-head"><h2 id="plugin-editor-title">新建插件</h2><button class="button small" id="plugin-close">收起编辑器</button></div>
    <form id="plugin-form" class="plugin-form" autocomplete="off">
      <div class="plugin-fields"><label>插件名称<input id="plugin-name" required maxlength="80"></label><label>版本<input id="plugin-version" required maxlength="40"></label><label class="plugin-full">说明<input id="plugin-description" maxlength="500"></label><label>触发前缀<input id="plugin-trigger" maxlength="80" placeholder="留空时检查范围内的每条消息"><small>先按前缀筛选，再执行代码。</small></label><label>优先级<input id="plugin-priority" type="number" min="-100" max="100" required><small>-100 至 100；数字越大越先执行。</small></label><label>执行时限（毫秒）<input id="plugin-timeout" type="number" min="100" max="10000" required><small>包含模块加载，超时会终止线程。</small></label></div>
      <div class="plugin-fields"><label>作者<input id="plugin-author" maxlength="100"></label><label>仓库地址<input id="plugin-repository" maxlength="300" placeholder="https://github.com/…"></label></div>
      <fieldset class="plugin-scope"><legend>允许触发的会话</legend><p class="help-text">插件范围独立于 AI 白名单。启用前至少指定一个好友或群聊。</p><div class="plugin-fields"><label>好友 QQ 号<input id="plugin-users" placeholder="多个号码用逗号分隔"><small>只处理这些好友的私聊。</small></label><label>群号<input id="plugin-groups" placeholder="多个号码用逗号分隔"><small>只处理这些群的消息。</small></label></div><div class="plugin-checks"><label><input id="plugin-all-private" type="checkbox">允许所有私聊</label><label><input id="plugin-all-groups" type="checkbox">允许所有群聊</label><label><input id="plugin-require-at" type="checkbox">群聊需要 @机器人</label></div></fieldset>
      <fieldset class="plugin-scope" id="plugin-voice-settings" hidden><legend>默认音色</legend><p class="help-text">从 VoiceStudio 已保存的音色中选择。保存插件后，手动朗读和未指定其他声音的模型调用会使用该音色。</p><div class="plugin-voice-controls"><label for="plugin-voice-select">已保存音色<select id="plugin-voice-select" aria-describedby="plugin-voices-status"></select></label><button class="button" id="plugin-voices-refresh" type="button">刷新音色</button></div><p class="help-text" id="plugin-voices-status" role="status"></p><p id="plugin-voices-error" class="banner error" role="alert" hidden></p></fieldset>
      <div class="plugin-voice-probability" id="plugin-voice-output" hidden><label for="plugin-voice-probability">语音输出概率（%）<input id="plugin-voice-probability" type="number" min="0" max="100" step="any" inputmode="decimal" value="0" required aria-describedby="plugin-voice-probability-help"></label><p class="help-text" id="plugin-voice-probability-help">普通 AI 文字回复生成后按此概率转为语音。0% 关闭自动转换，100% 每次尝试；使用上方默认音色。超长、明确只要文字或转换失败时保留文字。明确要求语音的请求不受概率限制。保存插件后生效。</p></div>
      <div id="plugin-config-fields" class="plugin-config-form" hidden></div><button id="plugin-config-raw-toggle" class="text-button" type="button" hidden>编辑原始 JSON 配置</button>
      <div class="plugin-code-grid"><label>JavaScript 代码<textarea id="plugin-source" class="plugin-code" rows="13" required spellcheck="false" autocapitalize="off" aria-describedby="plugin-code-help"></textarea><small id="plugin-code-help">默认导出 async 函数，接收 { text, event, config }。返回 { reply: '文本' } 发送纯文本；返回 null 继续后续插件与 AI。每次调用均为新线程。</small></label><label>自定义配置（JSON 对象）<textarea id="plugin-config" class="plugin-code" rows="13" required spellcheck="false" autocapitalize="off"></textarea><small>代码通过 config 读取。配置以明文保存，插件导出会包含完整配置，请勿分享含密钥的文件。</small></label></div>
      <details id="plugin-schema-editor" class="config-raw"><summary>配置表单定义（AstrBot 风格 Schema）</summary><p class="help-text">描述每项配置的 type、description、hint、default、group。支持 string / text / bool / int / float / list / object，以及 options、slider 和 secret。</p><textarea id="plugin-schema" class="plugin-code" rows="7" spellcheck="false" aria-label="插件配置表单定义"></textarea><button id="plugin-schema-apply" class="button small" type="button">应用表单定义</button></details>
      <p id="plugin-editor-error" class="banner error" role="alert" tabindex="-1" hidden></p>
      <label class="plugin-tool-editor" id="plugin-tools-label">Agent 工具定义（JSON 数组）<textarea id="plugin-tools" class="plugin-code" rows="5" spellcheck="false" aria-describedby="plugin-tools-help"></textarea><small id="plugin-tools-help">留空数组 [] 仅处理消息。每个工具包含 name、description、parameters 和 effect（read 或 write），代码需额外导出 invokeTool({ tool, arguments, event, config })。参数使用有限 JSON Schema；工具会话范围沿用插件，工具调用不受消息前缀限制。</small></label><div class="plugin-save"><p id="plugin-save-state" role="status">新插件保存后默认停用。</p><div class="inline-actions"><button class="button" id="plugin-export" type="button">导出当前草稿</button><button class="button primary" id="plugin-save" type="submit">保存插件</button></div></div>
    </form>
    <div class="plugin-test"><h3>模拟测试</h3><p class="help-text">执行当前草稿代码并预览返回值，不通过机器人发送 QQ 消息。文件与网络操作仍由代码本身决定。</p><div class="plugin-test-fields"><label>会话类型<select id="plugin-test-type"><option value="private">私聊</option><option value="group">群聊（含 @机器人）</option></select></label><label>好友 QQ 号<input id="plugin-test-user" value="10001" inputmode="numeric"></label><label>群号<input id="plugin-test-group" value="20001" inputmode="numeric"></label><label class="plugin-test-message">测试消息<input id="plugin-test-text" value="/ping" maxlength="8000"></label><button class="button" id="plugin-test-run">运行测试</button></div><pre id="plugin-test-result" role="status" hidden></pre></div>
  </div>
</section>`;

export const pluginsStyles = String.raw`
.plugin-voice-probability{display:grid;grid-template-columns:minmax(160px,.45fr) minmax(0,1fr);gap:18px 24px;align-items:center;padding:18px 0 24px}.plugin-voice-probability .help-text{max-width:70ch}@media(max-width:680px){.plugin-voice-probability{grid-template-columns:minmax(0,1fr);gap:10px}.plugin-voice-probability input{font-size:16px;min-height:44px}}
.plugin-voice-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px;margin:14px 0 10px}.plugin-form select{min-width:0;width:100%;max-width:100%;border:1px solid var(--field-line);background:var(--surface);color:var(--ink);padding:9px 11px;font:inherit;font-weight:400;min-height:39px;text-overflow:ellipsis}.plugin-voice-controls .button{min-height:39px}#plugin-voices-status{margin-top:10px}#plugin-voices-error{margin-top:12px}
@media(max-width:680px){.plugin-voice-controls{grid-template-columns:minmax(0,1fr)}.plugin-voice-controls .button,.plugin-form select{min-height:44px}}
.plugin-tool-editor{margin-top:24px}.plugin-row{padding:19px 23px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 22px;align-items:center}.plugin-row+.plugin-row{border-top:1px solid var(--line)}.plugin-row-title{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-bottom:5px}.plugin-row-title h3,.plugin-row p{overflow-wrap:anywhere}.plugin-row p{font-size:12px;color:var(--muted)}.plugin-row .plugin-last-error{color:var(--bad);margin-top:7px}.plugin-row-meta{display:flex;gap:5px 14px;flex-wrap:wrap;margin-top:9px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.plugin-trust{margin:19px 0 24px;font-size:12px;color:var(--muted);max-width:85ch}.plugin-trust strong{font-weight:600;color:var(--ink)}.plugin-trust p{margin-top:4px}.plugin-editor{margin-top:24px;scroll-margin-top:20px}.plugin-form{padding:23px}.plugin-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:17px 24px}.plugin-form label,.plugin-test-fields label{display:grid;gap:7px;min-width:0;font-size:12px;font-weight:600}.plugin-form input:not([type=checkbox]),.plugin-form textarea,.plugin-test-fields input,.plugin-test-fields select{min-width:0;width:100%;border:1px solid var(--field-line);background:var(--surface);color:var(--ink);padding:9px 11px;font-weight:400;min-height:39px}.plugin-form small{font-weight:400;font-size:11px;color:var(--muted)}.plugin-full{grid-column:1/-1}.plugin-scope{border:0;border-top:1px solid var(--line);padding:18px 0 0;margin:27px 0 24px;min-width:0}.plugin-scope legend{padding:0 12px 0 0;font-size:14px;font-weight:650}.plugin-scope>.help-text{margin-bottom:15px}.plugin-checks{display:flex;gap:12px 22px;flex-wrap:wrap;margin-top:16px}.plugin-checks label{display:flex;align-items:center;gap:8px;font-weight:400;min-height:32px}.plugin-checks input{accent-color:var(--accent);width:16px;height:16px}.plugin-code-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:24px}.plugin-code-grid.native{grid-template-columns:minmax(0,1fr)}.plugin-code-grid textarea{font:12px/1.75 var(--mono);resize:vertical;tab-size:2;white-space:pre;overflow:auto}.plugin-save{border-top:1px solid var(--line);margin-top:24px;padding-top:20px;display:flex;align-items:center;justify-content:space-between;gap:15px}.plugin-save p{color:var(--muted);font-size:12px}.plugin-test{padding:22px 23px;border-top:1px solid var(--line)}.plugin-test>.help-text{margin:7px 0 18px}.plugin-test-fields{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:16px;align-items:end}.plugin-test-message{grid-column:1/3}.plugin-test pre{padding:14px;background:var(--surface-muted);border-radius:7px;max-height:260px;overflow:auto;white-space:pre-wrap}.plugin-test pre[data-error=true]{background:var(--bad-bg);color:var(--bad)}
@media(max-width:1100px){.plugin-code-grid{grid-template-columns:minmax(0,1fr)}.plugin-row{grid-template-columns:minmax(0,1fr)}.plugin-row .inline-actions{justify-content:flex-start}}
@media(max-width:680px){.plugin-fields,.plugin-test-fields{grid-template-columns:minmax(0,1fr)}.plugin-test-message,.plugin-full{grid-column:auto}.plugin-form,.plugin-test{padding:18px}.plugin-row{padding:18px}.plugin-save{align-items:flex-start;flex-direction:column}.plugin-checks{flex-direction:column;gap:6px}.plugin-checks label{min-height:44px}.plugin-test-fields .button{min-height:44px}.plugin-editor>.panel-head{padding:16px 18px}.plugin-save .inline-actions{width:100%}.plugin-save .button{flex:1}}
`;

export const pluginsClient = String.raw`
let pluginDraftKind='script',pluginLoadTask=null,pluginConfigForm=null,pluginPackageUpdate=null;
let pluginSnapshot=null,pluginEditing=null,pluginDirty=false,pluginBusy=false,pluginLoading=false;
let pluginVoiceProfiles=[],pluginVoiceSignature=null,pluginVoicesLoading=false,pluginVoiceRequest=0,pluginVoiceController=null;
function renderPluginConfigFields(){
  const root=$('plugin-config-fields');let schema;
  try{schema=JSON.parse($('plugin-schema').value||'{}');const config=pluginReadConfig();pluginConfigForm=null;
    const available=schema&&typeof schema==='object'&&!Array.isArray(schema)&&Object.keys(schema).length>0;
    root.hidden=!available;$('plugin-config-raw-toggle').hidden=!available;$('plugin-config').closest('label').hidden=available;
    if(available)pluginConfigForm=mountConfigFields(root,schema,config,()=>{$('plugin-config').value=JSON.stringify(pluginConfigForm.value(),null,2);},'plugin-field');
    else root.replaceChildren();
  }catch(error){pluginConfigForm=null;root.hidden=true;$('plugin-config').closest('label').hidden=false;pluginEditorProblem(error);}
}
async function openPluginBehaviors(id){
  try{const p=await api('/plugins/detail?id='+encodeURIComponent(id)),body=$('plugin-behaviors-body');body.replaceChildren();$('plugin-behaviors-title').textContent=p.name+' · 行为与工具';
    body.append(el('p','help-text',(p.author?'作者 '+p.author+' · ':'')+'版本 '+p.version+' · '+(p.enabled?'已启用':'已停用')));
    if(p.repository)body.append(el('p','help-text','仓库：'+p.repository));
    const descriptions=p.kind==='group-chat-plus'?['群聊消息观察、AI 读空气、消息合并与回复过滤','后台主动聊天、图片描述缓存','管理员指令：/gcp_status /gcp_pause /gcp_resume /gcp_probability /gcp_reset_here /gcp_reset /gcp_clear_image_cache']:p.kind==='voicestudio'?['语音生成与转发工具；普通回复语音概率转换']:p.kind==='meme-manager'?['表情分类、选图与图片回复']:['消息处理：'+(p.trigger?'前缀 '+p.trigger:'允许范围内的每条消息')];
    for(const description of descriptions)body.append(el('p','',description));
    for(const tool of p.tools||[]){const detail=el('details'),summary=el('summary','',tool.name+' · '+(tool.effect==='write'?'写入操作':'只读工具'));detail.append(summary,el('p','',tool.description),el('pre','',JSON.stringify(tool.parameters,null,2)));body.append(detail);}
    if(!(p.tools||[]).length)body.append(el('p','help-text','此插件没有单独注册 Agent 函数工具。'));
    $('plugin-behaviors').hidden=false;$('plugin-behaviors').scrollIntoView({block:'start'});
  }catch(error){problem('plugin-error',error);}
}
$('plugin-behaviors-close').onclick=()=>$('plugin-behaviors').hidden=true;
$('plugin-config-raw-toggle').onclick=()=>{const label=$('plugin-config').closest('label');label.hidden=!label.hidden;};
$('plugin-schema-apply').onclick=()=>{renderPluginConfigFields();pluginDirty=true;$('plugin-save-state').textContent=pluginDraftStatus();};
$('plugin-builtin-install').onclick=async()=>{if(pluginBusy||!await discardPluginDraft())return;pluginSetBusy(true);try{const p=await api('/plugins/install',{kind:$('plugin-builtin-kind').value});fillPlugin(p);await loadPlugins();if(p.kind==='group-chat-plus')navigate('groupchat');else $('plugin-editor').scrollIntoView({block:'start'});}catch(error){problem('plugin-error',error);}finally{pluginSetBusy(false);}};
function pluginEditorProblem(error){problem('plugin-editor-error',error);if(error)$('plugin-editor-error').focus();}
function pluginDraftStatus(){return '有未保存的修改 · '+(!pluginEditing?'保存后默认停用':pluginEditing.enabled?'保存后即时更新':'保存后仍停用');}
function pluginReadConfig(){let config;try{config=JSON.parse($('plugin-config').value);}catch{throw new Error('自定义配置不是有效 JSON，请检查引号和逗号。');}if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('自定义配置必须是 JSON 对象。');return config;}
function pluginVoiceConnection(config){return JSON.stringify([config.base_url||'http://127.0.0.1:3900',config.api_key||'']);}
function pluginVoiceControls(){
  $('plugin-voice-probability').disabled=pluginBusy||pluginDraftKind!=='voicestudio';
  $('plugin-voices-refresh').disabled=pluginBusy||pluginVoicesLoading;
  $('plugin-voice-select').disabled=pluginBusy||pluginVoicesLoading;
  $('plugin-voices-refresh').textContent=pluginVoicesLoading?'正在读取…':'刷新音色';
  $('plugin-voice-settings').setAttribute('aria-busy',String(pluginVoicesLoading));
}
function pluginRenderVoices(config){
  const select=$('plugin-voice-select'),current=typeof config.voice==='string'&&config.voice.trim()?config.voice.trim():'default';select.replaceChildren();
  const add=(id,label)=>{const option=el('option','',label);option.value=id;select.append(option);};
  add('default','引擎默认音色（default）');
  for(const voice of pluginVoiceProfiles)if(voice.voice_id!=='default')add(voice.voice_id,(voice.name||voice.voice_id)+' · '+voice.voice_id+(voice.language?' · '+voice.language:''));
  if(current!=='default'&&!pluginVoiceProfiles.some(v=>v.voice_id===current))add(current,'当前配置：'+current+'（未在已读取音色中）');
  select.value=current;
}
function resetPluginVoices(config){
  pluginVoiceController?.abort();pluginVoiceController=null;
  pluginVoiceRequest++;pluginVoiceProfiles=[];pluginVoiceSignature=null;pluginVoicesLoading=false;
  $('plugin-voice-settings').hidden=pluginDraftKind!=='voicestudio';problem('plugin-voices-error',null);
  $('plugin-voice-output').hidden=pluginDraftKind!=='voicestudio';pluginRenderVoiceProbability(config);
  pluginRenderVoices(config);$('plugin-voices-status').textContent='读取当前配置服务中的已保存音色，不合成或发送语音。';pluginVoiceControls();
}
async function loadPluginVoices(){
  if(pluginDraftKind!=='voicestudio'||pluginVoicesLoading)return;
  let config;try{config=pluginReadConfig();}catch(error){problem('plugin-voices-error',error);return;}
  pluginVoiceController?.abort();const controller=new AbortController();pluginVoiceController=controller;
  const ticket=++pluginVoiceRequest,signature=pluginVoiceConnection(config);pluginVoiceSignature=signature;pluginVoicesLoading=true;pluginVoiceControls();problem('plugin-voices-error',null);$('plugin-voices-status').textContent='正在读取 VoiceStudio 已保存音色…';
  try{
    const result=await api('/voicestudio/voices',{config},controller.signal);
    if(ticket!==pluginVoiceRequest||pluginDraftKind!=='voicestudio')return;
    const current=pluginReadConfig();if(pluginVoiceConnection(current)!==signature){$('plugin-voices-status').textContent='服务配置已变更，请刷新已保存音色。';return;}
    if(!Array.isArray(result.voices))throw new Error('音色列表格式不兼容，请检查 VoiceStudio 服务。');
    const seen=new Set();pluginVoiceProfiles=result.voices.filter(v=>v?.type==='profile'&&typeof v.voice_id==='string'&&v.voice_id.trim()&&!seen.has(v.voice_id)&&(seen.add(v.voice_id),true));
    pluginVoiceSignature=signature;pluginRenderVoices(current);
    $('plugin-voices-status').textContent=pluginVoiceProfiles.length?'已读取 '+pluginVoiceProfiles.length+' 个已保存音色'+(result.total>pluginVoiceProfiles.length?'（显示前 '+pluginVoiceProfiles.length+' 个）':'')+'。选择后点击“保存插件”生效。':'VoiceStudio 尚无已保存音色。请先在 VoiceStudio 保存音色，再刷新；当前配置保留。';
  }catch(error){if(ticket===pluginVoiceRequest){problem('plugin-voices-error',error);$('plugin-voices-status').textContent='读取失败，当前音色配置保留。检查服务地址和 API Key 后重试。';}}
  finally{if(ticket===pluginVoiceRequest){pluginVoiceController=null;pluginVoicesLoading=false;pluginVoiceControls();}}
}
function syncPluginVoiceConfig(){
  if(pluginDraftKind!=='voicestudio')return;let config;try{config=pluginReadConfig();}catch{return;}
  if(pluginVoiceSignature&&pluginVoiceConnection(config)!==pluginVoiceSignature){pluginVoiceRequest++;pluginVoiceController?.abort();pluginVoiceController=null;pluginVoicesLoading=false;pluginVoiceProfiles=[];pluginVoiceSignature=null;problem('plugin-voices-error',null);$('plugin-voices-status').textContent='服务配置已变更，请刷新已保存音色。';pluginVoiceControls();}
  pluginRenderVoices(config);pluginRenderVoiceProbability(config);
}
function pluginRenderVoiceProbability(config){const input=$('plugin-voice-probability');const value=config.reply_probability??0;input.value=typeof value==='number'&&Number.isFinite(value)?String(Number((value*100).toFixed(8))):'';input.setCustomValidity('');}
$('plugin-voice-probability').addEventListener('input',()=>{const input=$('plugin-voice-probability'),value=input.valueAsNumber;if(!Number.isFinite(value)||value<0||value>100){input.setCustomValidity('请输入 0 至 100 的语音输出概率。');return;}input.setCustomValidity('');try{const config=pluginReadConfig();config.reply_probability=value/100;$('plugin-config').value=JSON.stringify(config,null,2);$('plugin-config').dispatchEvent(new Event('input',{bubbles:true}));}catch(error){pluginEditorProblem(error);}});
function pluginPack(){
  if(!$('plugin-form').reportValidity())throw new Error('请补全插件名称、版本、代码及数值设置。');
  const config=pluginConfigForm?pluginConfigForm.read():pluginReadConfig();
  const ids=id=>$(id).value.split(/[,，\s]+/).filter(Boolean);
  return {schema:1,kind:pluginDraftKind,name:$('plugin-name').value,description:$('plugin-description').value,version:$('plugin-version').value,
    trigger:$('plugin-trigger').value,priority:Number($('plugin-priority').value),timeout_ms:Number($('plugin-timeout').value),source:$('plugin-source').value,config,config_schema:JSON.parse($('plugin-schema').value||'{}'),author:$('plugin-author').value,repository:$('plugin-repository').value,tools:pluginDraftKind==='script'?JSON.parse($('plugin-tools').value||'[]'):[],
    scope:{private_users:ids('plugin-users'),groups:ids('plugin-groups'),all_private:$('plugin-all-private').checked,all_groups:$('plugin-all-groups').checked,require_at:$('plugin-require-at').checked}};
}
function pluginSetBusy(busy){pluginBusy=busy;for(const id of ['plugin-save','plugin-test-run','plugin-create','plugin-import','plugin-export','plugin-close','plugin-reload'])$(id).disabled=busy;for(const node of $('plugin-list').querySelectorAll('button'))node.disabled=busy;for(const node of $('plugin-form').elements)node.disabled=busy;pluginVoiceControls();}
function renderPlugins(){
  if(!pluginSnapshot)return;
  const all=pluginSnapshot.plugins,query=$('plugin-search').value.trim().toLowerCase(),filter=$('plugin-filter').value;
  $('plugin-count').textContent=all.length+' / '+pluginSnapshot.limit+' · '+all.filter(p=>p.enabled).length+' 个启用';
  const list=all.filter(p=>(filter==='all'||p.enabled===(filter==='enabled'))&&(!query||(p.name+' '+p.description).toLowerCase().includes(query)));
  const root=$('plugin-list');root.replaceChildren();
  if(!list.length){empty(root,all.length?'没有匹配的插件':'还没有安装插件',all.length?'试试其他名称或状态。':'点击“新建插件”使用指令回复模板，或导入已有的插件 JSON。');return;}
  for(const p of list){
    const row=el('article','plugin-row'),body=el('div'),title=el('div','plugin-row-title');title.append(el('h3','',p.name),badge(p.enabled?'已启用':'已停用',p.enabled?'ok':''),badge('v'+p.version));body.append(title,el('p','',p.description||'未填写说明'));
    const s=p.scope,scope=(s.all_private?'全部私聊':s.private_users.length+' 个好友')+' · '+(s.all_groups?'全部群聊':s.groups.length+' 个群')+(s.require_at?' · 群聊需 @':'');
    const meta=el('div','plugin-row-meta');for(const text of [scope,'优先级 '+p.priority,'执行 '+p.runs+' 次 / 失败 '+p.failures+' 次',p.last_run?'最近执行 '+dateTime(p.last_run):'尚未执行'])meta.append(el('span','',text));body.append(meta);
    if(p.last_error)body.append(el('p','plugin-last-error',p.last_error));
    const actions=el('div','inline-actions'),edit=el('button','button small','编辑'),toggle=el('button','button small',p.enabled?'停用':'启用'),remove=el('button','button small danger','删除');
    for(const button of [edit,toggle,remove]){button.type='button';button.disabled=pluginBusy;button.setAttribute('aria-label',button.textContent+'插件 '+p.name);}
    edit.onclick=()=>openPlugin(p.id);toggle.onclick=()=>changePlugin('/plugins/toggle',{id:p.id,revision:p.revision,enabled:!p.enabled});
    remove.onclick=async()=>{if(await confirmAction('删除插件“'+p.name+'”？','删除后会停止该插件并移除代码与配置。需要保留时，请先在编辑器导出。'))await changePlugin('/plugins/delete',{id:p.id,revision:p.revision});};
    const reload=el('button','button small','重载'),behaviors=el('button','button small','查看行为'),update=el('button','button small','从文件更新');
    for(const button of [reload,behaviors,update]){button.type='button';button.disabled=pluginBusy;}
    reload.onclick=()=>changePlugin('/plugins/reload',{id:p.id,revision:p.revision});
    behaviors.onclick=()=>openPluginBehaviors(p.id);
    update.onclick=()=>{pluginPackageUpdate=p.id;$('plugin-file').click();};
    actions.append(edit,toggle,remove,reload,behaviors,update);
    if(p.kind==='group-chat-plus'){const manage=el('button','button small','管理面板');manage.onclick=()=>navigate('groupchat');actions.append(manage);}
    row.dataset.plugin=p.id;row.append(body,actions);root.append(row);
  }
}
async function loadPlugins(){if(pluginLoadTask)return pluginLoadTask;pluginLoading=true;pluginLoadTask=(async()=>{try{pluginSnapshot=await api('/plugins');problem('plugin-error',null);renderPlugins();}catch(error){problem('plugin-error',new Error('无法加载插件：'+error.message));}finally{pluginLoading=false;pluginLoadTask=null;}})();return pluginLoadTask;}
async function discardPluginDraft(){return !pluginDirty||await confirmAction('放弃未保存的插件修改？','当前草稿尚未保存。继续后会被替换。');}
function fillPlugin(p){
  pluginDraftKind=p.kind||'script';$('plugin-source').closest('label').hidden=pluginDraftKind!=='script';$('plugin-source').closest('.plugin-code-grid').classList.toggle('native',pluginDraftKind!=='script');
  pluginEditing=p.id?p:null;pluginDirty=false;$('plugin-editor').hidden=false;$('plugin-editor-title').textContent=p.id?'编辑插件 · '+p.name:'新建插件';
  for(const [id,key] of [['name','name'],['version','version'],['description','description'],['trigger','trigger'],['priority','priority'],['timeout','timeout_ms'],['source','source']])$('plugin-'+id).value=p[key]??'';
  $('plugin-config').value=JSON.stringify(p.config??{},null,2);$('plugin-tools').value=JSON.stringify(p.tools||[],null,2);$('plugin-tools-label').hidden=pluginDraftKind!=='script';const scope=p.scope||{};
  $('plugin-author').value=p.author||'';$('plugin-repository').value=p.repository||'';$('plugin-schema').value=JSON.stringify(p.config_schema||{},null,2);$('plugin-schema-editor').hidden=pluginDraftKind!=='script';renderPluginConfigFields();
  $('plugin-users').value=(scope.private_users||[]).join(', ');$('plugin-groups').value=(scope.groups||[]).join(', ');
  for(const [id,key] of [['all-private','all_private'],['all-groups','all_groups'],['require-at','require_at']])$('plugin-'+id).checked=scope[key]===true;
  $('plugin-save-state').textContent=p.id?'已保存 · '+(p.enabled?'正在启用，保存后即时更新':'已停用'):'新插件保存后默认停用。';$('plugin-test-result').hidden=true;pluginEditorProblem(null);
  resetPluginVoices(p.config||{});if(pluginDraftKind==='voicestudio')void loadPluginVoices();
}
async function openPlugin(id){if(pluginBusy||!await discardPluginDraft())return;pluginSetBusy(true);try{const p=await api('/plugins/detail?id='+encodeURIComponent(id));fillPlugin(p);$('plugin-editor').scrollIntoView({block:'start',behavior:'auto'});$('plugin-name').focus({preventScroll:true});}catch(error){problem('plugin-error',error);}finally{pluginSetBusy(false);}}
async function changePlugin(path,params){if(pluginBusy)return;pluginSetBusy(true);try{const result=await api(path,params);if(pluginEditing?.id===params.id){if(path==='/plugins/delete'){$('plugin-editor').hidden=true;pluginEditing=null;pluginDirty=false;}else{pluginEditing={...pluginEditing,enabled:result.enabled,revision:result.revision};if(!pluginDirty)$('plugin-save-state').textContent=result.enabled?'已保存 · 正在启用':'已保存 · 已停用';}}await loadPlugins();notify(path==='/plugins/reload'?'插件已重载，配置与启停状态保留。':path==='/plugins/delete'?'插件已删除。':params.enabled?'插件已启用，即时生效。':'插件已停用。');}catch(error){problem('plugin-error',error);}finally{pluginSetBusy(false);}}
$('plugin-create').onclick=async()=>{if(pluginBusy||!await discardPluginDraft())return;if(!pluginSnapshot)await loadPlugins();if(!pluginSnapshot)return;fillPlugin(structuredClone(pluginSnapshot.template));pluginDirty=true;$('plugin-editor').scrollIntoView({block:'start',behavior:'auto'});$('plugin-name').focus({preventScroll:true});};
$('plugin-close').onclick=()=>{$('plugin-editor').hidden=true;pluginVoiceRequest++;pluginVoiceController?.abort();pluginVoiceController=null;pluginVoicesLoading=false;pluginVoiceControls();};
$('plugin-form').addEventListener('input',()=>{pluginDirty=true;$('plugin-save-state').textContent=pluginDraftStatus();});
$('plugin-config').addEventListener('input',syncPluginVoiceConfig);
$('plugin-config').addEventListener('input',()=>{try{if(Object.keys(JSON.parse($('plugin-schema').value||'{}')).length)renderPluginConfigFields();}catch(error){pluginEditorProblem(error);}});
$('plugin-voices-refresh').onclick=()=>{if(!pluginBusy)void loadPluginVoices();};
$('plugin-voice-select').addEventListener('change',()=>{if(pluginBusy||pluginVoicesLoading)return;try{const config=pluginReadConfig();config.voice=$('plugin-voice-select').value;$('plugin-config').value=JSON.stringify(config,null,2);$('plugin-config').dispatchEvent(new Event('input',{bubbles:true}));problem('plugin-voices-error',null);}catch(error){problem('plugin-voices-error',error);}});
$('plugin-form').addEventListener('submit',async event=>{event.preventDefault();if(pluginBusy)return;let pack;try{pack=pluginPack();}catch(error){pluginEditorProblem(error);return;}pluginSetBusy(true);problem('plugin-error',null);pluginEditorProblem(null);try{const saved=await api('/plugins/save',{id:pluginEditing?.id,revision:pluginEditing?.revision,plugin:pack});fillPlugin(saved);await loadPlugins();notify(saved.enabled?'插件已保存并生效。':'插件已保存。确认会话范围后可启用。');}catch(error){pluginEditorProblem(error);}finally{pluginSetBusy(false);}});
$('plugin-test-run').onclick=async()=>{if(pluginBusy)return;let pack;try{pack=pluginPack();}catch(error){pluginEditorProblem(error);return;}pluginSetBusy(true);const result=$('plugin-test-result');result.hidden=false;result.dataset.error='false';result.textContent='正在执行当前草稿…';try{const value=await api('/plugins/test',{plugin:pack,text:$('plugin-test-text').value,message_type:$('plugin-test-type').value,user_id:$('plugin-test-user').value,group_id:$('plugin-test-group').value});result.textContent='模拟测试完成 · '+value.duration_ms+' ms\n'+(value.scope_matches?'测试会话匹配当前触发范围。':'测试会话不在触发范围内或前缀不匹配；实际消息不会执行此插件。')+'\n'+(value.handled?'此消息由插件处理。':'未处理，将继续后续插件与 AI。')+'\n\n回复预览：\n'+(value.reply||(value.message?'包含 '+value.message.length+' 个文本或图片消息段。':'（无回复）'));}catch(error){result.dataset.error='true';result.textContent=error.message;}finally{pluginSetBusy(false);}};
$('plugin-export').onclick=()=>{try{download('qq-plugin',pluginPack());notify('已导出代码与完整配置；分享前请检查密钥。');}catch(error){pluginEditorProblem(error);}};
$('plugin-import').onclick=()=>{pluginPackageUpdate=null;$('plugin-file').click();};
$('plugin-file').addEventListener('change',async()=>{
  const file=$('plugin-file').files[0];if(!file)return;
  try{
    if(file.size>262144)throw new Error('插件文件不能超过 256 KiB。');if(!await discardPluginDraft())return;
    const data=JSON.parse(await file.text());if(data.schema!==1||typeof data.source!=='string'||typeof data.name!=='string'||!data.scope||!data.config)throw new Error('请选择本项目的 JavaScript 插件 JSON；AstrBot Python 插件需要其运行时。');
    if(pluginPackageUpdate){const old=await api('/plugins/detail?id='+encodeURIComponent(pluginPackageUpdate));if((data.kind||'script')!==old.kind)throw new Error('更新包与原插件类型不同。');fillPlugin({...data,id:old.id,revision:old.revision,enabled:old.enabled,scope:old.scope,config:{...data.config,...old.config}});}
    else fillPlugin({...data,id:undefined});
    pluginDirty=true;$('plugin-save-state').textContent=pluginPackageUpdate?'已载入更新草稿 · 保留原会话范围、配置与启停状态，保存后生效':'已导入草稿 · 检查代码后保存，默认停用';$('plugin-editor').scrollIntoView({block:'start',behavior:'auto'});notify('已载入插件草稿，请检查后保存。');
  }catch(error){problem('plugin-error',error);}finally{$('plugin-file').value='';pluginPackageUpdate=null;}
});
$('plugin-reload').onclick=()=>loadPlugins();$('plugin-search').addEventListener('input',renderPlugins);$('plugin-filter').addEventListener('change',renderPlugins);
window.addEventListener('beforeunload',event=>{if(pluginDirty){event.preventDefault();event.returnValue='';}});
`;
