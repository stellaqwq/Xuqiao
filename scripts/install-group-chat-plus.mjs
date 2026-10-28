import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig,environmentOf} from '../src/config.mjs';
import {Settings} from '../src/settings.mjs';
import {Store} from '../src/store.mjs';
import {lockData} from '../src/data-lock.mjs';
import {PluginService} from '../src/plugins/service.mjs';
import {groupChatTemplate} from '../src/group-chat-plus/config.mjs';

export async function installGroupChatPlus(service,groups){
  let plugin=await service.install({kind:'group-chat-plus'});
  const allowed=[...new Set([...plugin.scope.groups,...groups])];
  plugin=await service.save({id:plugin.id,revision:plugin.revision,plugin:{...plugin,
    scope:{...plugin.scope,private_users:[],all_private:false,groups:allowed,require_at:false}}});
  if(allowed.length&&!plugin.enabled)plugin=await service.toggle({id:plugin.id,revision:plugin.revision,enabled:true});
  return {id:plugin.id,name:plugin.name,enabled:plugin.enabled,groups:plugin.scope.groups,proactive_enabled:plugin.config.proactive_enabled};
}
async function main(){
  let config=loadConfig();const index=process.argv.indexOf('--groups'),groups=index===-1?[...config.ai.allowedGroups]:String(process.argv[index+1]||'').split(/[,，\s]+/).filter(Boolean);
  if(groups.some(id=>!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0))throw Error('群号无效。');
  const allowed=[...new Set([...config.ai.allowedGroups,...groups])],base='http://127.0.0.1:'+config.port;
  async function call(path,params){const r=await fetch(base+path,{method:params?'POST':'GET',headers:{Authorization:'Bearer '+config.adminToken,'Content-Type':'application/json'},
    ...(params?{body:JSON.stringify(params)}:{}),signal:AbortSignal.timeout(12000)});const value=await r.json();if(!r.ok||value.status==='failed')throw Error('管理员接口拒绝安装请求。');return value;}
  let online=false;try{online=(await fetch(base+'/healthz',{signal:AbortSignal.timeout(1500)})).ok;}catch{}
  const values={AI_ALLOWED_GROUPS:allowed.join(','),AI_GROUP_CONTEXT_ENABLED:'true'};
  if(online){
    const settings=await call('/admin/settings');await call('/admin/settings',{values,revision:settings.revision});
    const service={install:params=>call('/admin/plugins/install',params),save:params=>call('/admin/plugins/save',params),toggle:params=>call('/admin/plugins/toggle',params)};
    console.log(JSON.stringify({installed:true,mode:'online',restart_required:true,...await installGroupChatPlus(service,groups)}));return;
  }
  const unlock=lockData(config.dataDir);let store,plugins;
  try{
    const settings=new Settings(config,{path:resolve('.env')}),snapshot=await settings.snapshot();await settings.save(values,snapshot.revision);
    config=loadConfig({...environmentOf(config),...values});
    store=new Store(join(config.dataDir,'bot.sqlite'),{retainIgnoredContent:true});plugins=new PluginService({store,adapter:{},config,log:()=>{}});
    console.log(JSON.stringify({installed:true,mode:'offline',...await installGroupChatPlus(plugins,groups)}));
  }finally{await plugins?.close();store?.close();unlock();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('群聊增强安装失败，请检查群号、管理员凭据和机器人运行状态。');process.exitCode=1;});
