import { mkdir, writeFile, unlink, readdir, stat, utimes } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { deadline } from '../../errors.mjs';
import { readOwnedFile, safeName, acceptsFileName, MAX_ATTACHMENT_BYTES, attachmentError } from '../../attachments/files.mjs';

export class FileReceiver {
  constructor(root,options={}){this.root=root;this.directory=join(root,'file-inbox');this.maxBytes=Math.min(options.maxBytes||MAX_ATTACHMENT_BYTES,MAX_ATTACHMENT_BYTES);this.timeout=options.timeout||90000;this.retentionDays=options.retentionDays||7;this.pending=new Map();this.lastCleanup=0;}
  complete(info){this.pending.get(JSON.stringify([String(info?.msgId),String(info?.msgElementId)]))?.(info);}
  async receive(raw,element,service,signal) {
    const file=element.fileElement,name=safeName(file.fileName);
    if(!acceptsFileName(name))throw attachmentError('不支持此文件格式');
    const size=Number(file.fileSize);
    if(!Number.isSafeInteger(size)||size<1||size>this.maxBytes)throw attachmentError('文件为空或过大');
    const read=async path=>{
      if(typeof path!=='string'||!isAbsolute(path))throw attachmentError('文件尚未下载');
      const bytes=await readOwnedFile(this.root,path,this.maxBytes,signal);
      if(bytes.length!==size||/^[a-f0-9]{32}$/i.test(file.fileMd5||'')&&createHash('md5').update(bytes).digest('hex')!==file.fileMd5.toLowerCase())throw attachmentError('文件未下载完整');
      return bytes;
    };
    let bytes;try{bytes=await read(file.filePath);}catch{signal?.throwIfAborted();}
    if(!bytes){
      if(typeof service.downloadRichMedia!=='function')throw attachmentError('文件下载暂不可用');
      await mkdir(this.directory,{recursive:true});
      const key=JSON.stringify([String(raw.msgId),String(element.elementId)]),destination=join(this.directory,createHash('sha256').update(key).digest('hex')+'.download');
      let abort;
      const finished=new Promise((yes,no)=>{
        abort=()=>{this.pending.delete(key);no(attachmentError('文件下载已取消'));};
        this.pending.set(key,info=>{if(Number(info.fileErrCode)!==0)no(attachmentError('文件下载失败'));else yes(info.filePath||destination);});
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      });finished.catch(()=>{});
      try{
        signal?.throwIfAborted();
        const result=await service.downloadRichMedia({fileModelId:'0',downSourceType:0,downloadSourceType:0,triggerType:1,
          msgId:String(raw.msgId),chatType:Number(raw.chatType),peerUid:String(raw.peerUid),elementId:String(element.elementId),thumbSize:0,downloadType:1,filePath:destination});
        if(result?.result!==undefined&&Number(result.result)!==0)throw attachmentError('文件下载被拒绝');
        bytes=await read(await finished);
      }finally{abort?.();signal?.removeEventListener('abort',abort);await unlink(destination).catch(()=>{});}
    }
    const digest=createHash('sha256').update(bytes).digest('hex'),path=join(this.directory,digest+'.bin');
    await mkdir(this.directory,{recursive:true});
    try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;const existing=await readOwnedFile(this.directory,path,this.maxBytes,signal);if(!existing.equals(bytes))throw attachmentError('文件缓存损坏');}
    const now=new Date();await utimes(path,now,now);
    return path;
  }
  async prepare(raw,service,signal) {
    let count=0,total=0;
    const elements=[];
    for(const element of raw.elements||[]) {
      if(Number(element.elementType)!==3||!element.fileElement){elements.push(element);continue;}
      try{
        if(++count>4||(total+=Number(element.fileElement.fileSize)||0)>this.maxBytes)throw attachmentError('文件数量或总大小超过限制');
        const path=await deadline(inner=>this.receive(raw,element,service,inner),this.timeout,{signal});
        elements.push({...element,fileElement:{...element.fileElement,onebotFilePath:path}});
      }catch{signal?.throwIfAborted();elements.push({...element,fileElement:{...element.fileElement,onebotFileError:true}});}
    }
    await this.cleanup().catch(()=>{});
    return {...raw,elements};
  }
  async cleanup(){
    if(Date.now()-this.lastCleanup<3600000)return;this.lastCleanup=Date.now();
    let names;try{names=await readdir(this.directory);}catch{return;}
    for(const name of names){if(!/^[a-f0-9]{64}\.bin$/.test(name))continue;const path=join(this.directory,name),info=await stat(path);if(info.mtimeMs<Date.now()-this.retentionDays*86400000)await unlink(path);}
  }
}
