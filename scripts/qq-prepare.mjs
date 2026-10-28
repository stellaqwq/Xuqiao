import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { initializeEnv } from './init.mjs';
import { loadConfig } from '../src/config.mjs';
import { prepareKernel } from '../src/qq/kernel/prepare.mjs';

try {
  const root=fileURLToPath(new URL('..',import.meta.url)); process.chdir(root);
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--from'&&!args[1].startsWith('--')))throw new Error('用法：npm run qq:prepare [-- --from "QQ.exe 完整路径"]');
  initializeEnv(root);
  const env={...parseEnv(await readFile(join(root,'.env'),'utf8')),...process.env};
  const config=loadConfig(env);
  if(config.driver!=='kernel')throw new Error('当前 QQ_DRIVER 不是 kernel，无需准备官方内核。');
  const result=await prepareKernel(config,{source:args[1]||'',notify:line=>console.log(line)});
  console.log(result.prepared?'QQ 内核运行时已准备完成，可以双击 start.cmd 启动。':'QQ 内核宿主已就绪，可以双击 start.cmd 启动。');
}catch(error){console.error(error.message);process.exitCode=1;}
