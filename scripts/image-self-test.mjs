import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { png } from '../test/image-fixture.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2);
if(args.length!==1||args[0]!=='--send') {
  console.log('此命令会向已运行机器人的登录账号自己发送一张真实测试图片。确认后使用：npm run image:selftest -- --send');
}else{
  try{
    process.chdir(root);
    const config=loadConfig({...parseEnv(await readFile(join(root,'.env'),'utf8')),...process.env});
    const host=['0.0.0.0','localhost'].includes(config.host)?'127.0.0.1':config.host==='::'?'[::1]':config.host;
    const base='http://'+host+':'+config.port;
    async function request(path,payload,admin=false){
      const response=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers:{Authorization:'Bearer '+(admin?config.adminToken:config.token),'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(config.media.timeout+5000)});
      const value=await response.json();if(!response.ok||value.status==='failed')throw new Error(value.message||'HTTP '+response.status);return value.data??value;
    }
    const status=await request('/admin/status',undefined,true);
    if(status.driver!=='kernel'||!status.online)throw new Error('请先启动官方内核驱动并登录 QQ。');
    if(!status.capabilities?.includes('media.image'))throw new Error('当前进程仍是旧版，请先更新并重新启动机器人。');
    const identity=await request('/get_login_info'),account=identity.user_id;
    if(!Number.isSafeInteger(account)||account<=0||account!==status.account)throw new Error('无法确认机器人自身 QQ 号，未发送消息。');
    const bytes=png(320,180);
    const result=await request('/send_private_msg',{user_id:account,message:[{type:'image',data:{file:'base64://'+bytes.toString('base64'),summary:'絮桥 Xuqiao 图片发送验收'}}]});
    const stored=await request('/get_msg',{message_id:result.message_id});
    if(!stored.message.some(segment=>segment.type==='image'))throw new Error('发送已确认，但消息缓存未保留图片段。');
    const report={success:true,self_only:true,confirmed:true,message_id:result.message_id,format:'png',source:'base64',width:320,height:180,version:status.kernel?.version,checked_at:new Date().toISOString()};
    await mkdir(resolve('dist'),{recursive:true});await writeFile(resolve('dist/image-self-test.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  }catch(error){console.error('图片实机测试失败：'+error.message);process.exitCode=1;}
}
