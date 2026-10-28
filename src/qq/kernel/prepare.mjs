import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { bundleQQ, discoverQQ } from './runtime.mjs';
import { buildKernel } from './build.mjs';

async function exists(path) {
  try { await access(path); return true; }
  catch(error) { if(error.code==='ENOENT')return false; throw error; }
}
export async function prepareKernel(config, { source='', notify=()=>{}, discover=discoverQQ, bundle=bundleQQ,
  build=buildKernel, platform=process.platform, architecture=process.arch,
  fingerprint=async()=>createHash('sha256').update(await readFile(process.execPath)).digest('hex') } = {}) {
  if(config.driver!=='kernel')return { prepared:false, reason:'other_driver' };
  if(platform!=='win32'||architecture!=='x64')throw new Error('官方 QQ 内核需要 Windows x64。仅体验管理台请运行 npm run launch -- --demo。');
  if(!await exists(join(config.kernel.runtime,'runtime.json'))) {
    let installation;
    try { installation=discover(source); }
    catch(error) {
      if(source)throw error;
      throw new Error('首次启动尚未准备 QQ 官方运行时。\n'+
        '已安装 QQ：运行 npm run qq:prepare -- --from "你的 QQ.exe 完整路径"\n'+
        '未安装 QQ：安装 7-Zip 后运行 npm run qq:download -- --prepare --activate\n'+
        '完成后再次双击 start.cmd。仅体验界面可运行 npm run launch -- --demo。');
    }
    notify('首次启动：正在从本机 QQ 准备独立运行时，请稍候…');
    await bundle({source:installation.executable,destination:config.kernel.runtime});
  }
  let metadata;
  try { metadata=JSON.parse(await readFile(join(config.kernel.directory,'adapter.json'),'utf8')); }
  catch(error) { if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error; }
  const binaries=await Promise.all(['wrapper.node','QQNT.dll'].map(name=>exists(join(config.kernel.directory,name))));
  const stale=!metadata||metadata.schema!==1||metadata.runtime_root!==resolve(config.kernel.runtime)||
    metadata.host_sha256!==await fingerprint()||binaries.some(present=>!present);
  if(!stale)return {prepared:false,reason:'ready'};
  notify('正在为当前 Node.js 和项目目录生成 QQ 内核宿主…');
  try {
    const result=await build({runtimeDirectory:config.kernel.runtime,directory:config.kernel.directory});
    return {prepared:true,...result};
  } catch(error) {
    throw new Error('QQ 运行时准备失败：'+error.message+'\n请检查 QQ_RUNTIME_DIR；可运行 npm run qq:download -- --prepare --activate 重新准备。',{cause:error});
  }
}
