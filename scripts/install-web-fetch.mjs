import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { lockData } from '../src/data-lock.mjs';
import { PluginService } from '../src/plugins/service.mjs';
import { pythonWebFetchPlugin } from './python-web-fetch-plugin.mjs';
import { findPython } from '../examples/python-web-fetch-plugin.mjs';

export async function installPythonWebFetch(service, config, pythonPath) {
  const template=await pythonWebFetchPlugin();
  const old=(await service.list()).plugins.find(p=>p.name===template.name && p.tools?.some(t=>t.name==='fetch_webpage'));
  const previous=old?await service.get(old.id):null;
  const plugin={...template,config:{...template.config,...previous?.config,...(pythonPath?{python_path:pythonPath}:{})},
    scope:previous?.scope||{...template.scope,private_users:[...config.ai.allowedUsers],groups:[...config.ai.allowedGroups]}};
  let saved=await service.save({plugin,...(previous?{id:previous.id,revision:previous.revision}:{})});
  const scoped=plugin.scope.all_private||plugin.scope.all_groups||plugin.scope.private_users.length||plugin.scope.groups.length;
  if(!previous&&scoped)saved=await service.toggle({id:saved.id,revision:saved.revision,enabled:true});
  return {id:saved.id,name:saved.name,enabled:saved.enabled,scope:saved.scope,python_path:saved.config.python_path,
    tool:service.toolName?service.toolName(saved,saved.tools[0]):'plugin_'+saved.id.replaceAll('-','').slice(0,24)+'_fetch_webpage'};
}

async function main(){
  const config=loadConfig(),pythonArg=process.argv.indexOf('--python');
  if(pythonArg!==-1&&!process.argv[pythonArg+1])throw Error('--python 需要 Python 可执行文件路径。');
  const runtime=await findPython({python_path:pythonArg===-1?'':process.argv[pythonArg+1]});
  const probe=spawnSync(runtime.command,[...runtime.args,'-I','-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:3000,windowsHide:true});
  if(probe.status!==0||!probe.stdout?.trim())throw Error('未找到可运行的 Python 3；请使用 --python 指定 python.exe 的绝对路径。');
  const pythonPath=probe.stdout.trim();
  const base=`http://127.0.0.1:${config.port}`;
  async function call(path,params){
    const response=await fetch(base+path,{method:params?'POST':'GET',headers:{Authorization:`Bearer ${config.adminToken}`,'Content-Type':'application/json'},
      ...(params?{body:JSON.stringify(params)}:{}),signal:AbortSignal.timeout(12000)});
    const value=await response.json();if(!response.ok||value.status==='failed')throw Error('插件安装接口拒绝请求，请检查服务版本和管理员凭据。');
    return value;
  }
  let online=false;
  try{const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(1500)});online=response.ok;}catch{}
  if(online){
    const service={list:()=>call('/admin/plugins'),get:id=>call('/admin/plugins/detail?id='+encodeURIComponent(id)),
      save:params=>call('/admin/plugins/save',params),toggle:params=>call('/admin/plugins/toggle',params)};
    console.log(JSON.stringify({installed:true,mode:'online',...await installPythonWebFetch(service,config,pythonPath)}));return;
  }
  // Use the same exclusive runtime lock as the bot; never edit a live DB.
  const unlock=lockData(config.dataDir);let store,plugins;
  try{
    store=new Store(join(config.dataDir,'bot.sqlite'),{retainIgnoredContent:true});
    plugins=new PluginService({store,config,adapter:{},log:()=>{}});
    console.log(JSON.stringify({installed:true,mode:'offline',...await installPythonWebFetch(plugins,config,pythonPath)}));
  }finally{await plugins?.close();store?.close();unlock();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(()=>{console.error('网页插件安装失败。请确认 Python 路径、项目 .env 配置及机器人服务状态；服务运行中时通过管理接口安装，不要手工修改数据库。');process.exitCode=1;});
}
