import { fork } from 'node:child_process';
import { attachmentError } from './files.mjs';

export function extractText(bytes,kind,{maxChars=24000,maxPages=40,signal,timeout=20000}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=fork(new URL('./extract-worker.mjs',import.meta.url),[],{execArgv:['--max-old-space-size=192'],
      env:Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),
      serialization:'advanced',windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.kill();error?reject(error):resolve(result);};
    const abort=()=>finish(signal.reason);
    const timer=setTimeout(()=>finish(attachmentError('文件解析超时，请拆分文件后重试。')),timeout);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    worker.stdout.resume();worker.stderr.resume();
    worker.on('message',value=>finish(value.error?attachmentError(value.error):null,value));
    worker.on('error',()=>finish(attachmentError('文件解析未完成，请转为文本后重试。')));
    worker.on('exit',()=>{if(!settled)finish(attachmentError('文件解析未完成，请转为文本后重试。'));});
    if(!settled)worker.send({bytes,kind,maxChars,maxPages},error=>{if(error)finish(attachmentError('文件解析未完成，请重试。'));});
  });
}
