import { mkdir, realpath, unlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { ImageCache } from './image.mjs';
import { BotError, deadline } from '../../errors.mjs';

// Download completion is independent of message delivery. Never publish an SDK
// sourcePath until the bytes actually exist and have passed image validation.
export class ImageReceiver {
  constructor(dataDir, options = {}) {
    this.root=resolve(dataDir);this.timeout=options.timeout||90000;
    this.cache=new ImageCache(join(this.root,'media-inbox'),options);
    this.pending=new Map();
  }
  complete(info) {
    this.pending.get(JSON.stringify([String(info?.msgId),String(info?.msgElementId)]))?.(info);
  }
  async local(source,signal) {
    if(typeof source!=='string'||!isAbsolute(source))throw new BotError('QQ image file is not available',1404);
    const root=await realpath(this.root),path=await realpath(source),part=relative(root,path);
    if(!part||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw new BotError('QQ image is outside kernel data',1404);
    return this.cache.acquire(path,{signal});
  }
  async image(raw,element,service,signal) {
    const pic=element.picElement;
    try {
      const image=await this.local(pic.sourcePath,signal);
      if(/^[a-f0-9]{32}$/i.test(pic.md5HexStr||'')&&image.md5!==pic.md5HexStr.toLowerCase()){
        image.release();throw new BotError('QQ original image is not downloaded yet',1404);
      }
      return image;
    }
    catch(error) { signal?.throwIfAborted();if(!['ENOENT',1404].includes(error.code))throw error; }
    if(typeof service?.downloadRichMedia!=='function'||!element.elementId)throw new BotError('QQ image download is unavailable',1404);
    const key=JSON.stringify([String(raw.msgId),String(element.elementId)]);
    if(this.pending.has(key))throw new BotError('QQ image download is already in progress',1503);
    const folder=join(this.root,'media-downloads');await mkdir(folder,{recursive:true});
    const part=typeof pic.sourcePath==='string'&&isAbsolute(pic.sourcePath)?relative(this.root,resolve(pic.sourcePath)):null;
    const sdkPath=part&&part!=='..'&&!part.startsWith('..\\')&&!part.startsWith('../')&&!isAbsolute(part)?resolve(pic.sourcePath):null;
    const destination=sdkPath||join(folder,createHash('sha256').update(JSON.stringify([raw.chatType,raw.peerUid,key])).digest('hex')+'.download');
    let abort,settled=false;
    const finished=new Promise((yes,no)=>{
      const finish=(error,value)=>{if(settled)return;settled=true;this.pending.delete(key);signal?.removeEventListener('abort',abort);error?no(error):yes(value);};
      abort=()=>finish(new BotError('QQ image download cancelled',1502));
      this.pending.set(key,info=>{
        if(Number(info.fileErrCode)!==0){
          console.error(JSON.stringify({event:'image_download_rejected',nativeCode:Number.isSafeInteger(Number(info.fileErrCode))?Number(info.fileErrCode):null}));
          finish(new BotError('QQ image download failed',1500));return;
        }
        finish(null,typeof info.filePath==='string'&&info.filePath?info.filePath:destination);
      });
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });finished.catch(()=>{});
    try {
      signal?.throwIfAborted();
      const accepted=await service.downloadRichMedia({fileModelId:'0',downSourceType:0,downloadSourceType:0,triggerType:1,
        msgId:String(raw.msgId),chatType:Number(raw.chatType),peerUid:String(raw.peerUid),
        elementId:String(element.elementId),thumbSize:0,downloadType:1,filePath:destination});
      if(accepted?.result!==undefined&&Number(accepted.result)!==0){
        console.error(JSON.stringify({event:'image_download_submission_rejected',nativeCode:Number(accepted.result),
          reason:String(accepted.errMsg||'').replace(/\d{5,}/g,'[number]').replace(/[\r\n]/g,' ').slice(0,200)}));
        throw new BotError('QQ rejected image download',1500);
      }
      const image=await this.local(await finished,signal);
      // SDK metadata can describe a pre-compression image. Delivery identity is
      // the matched SDK callback; cache integrity uses the actual downloaded bytes.
      return image;
    } finally {
      abort?.();
      // Only remove our exact temporary output; SDK-owned account files stay intact.
      if(settled&&!sdkPath)await unlink(destination).catch(()=>{});
    }
  }
  async prepare(raw,service,signal) {
    const elements=[];let total=0,count=0;
    try{return await deadline(async operationSignal=>{
      for(const element of raw.elements||[]) {
        if(Number(element.elementType)!==2||!element.picElement){elements.push(element);continue;}
        try {
          if(++count>20)throw new BotError('Too many received images',1400);
          const image=await this.image(raw,element,service,operationSignal);
          try {
            total+=image.bytes.length;if(total>this.cache.maxBytes)throw new BotError('Received images exceed MEDIA_MAX_BYTES',1400);
            elements.push({...element,picElement:{...element.picElement,onebotImageFile:basename(image.path),
              picWidth:image.width,picHeight:image.height,fileSize:String(image.bytes.length)}});
          } finally {image.release();}
        } catch(error) {
          operationSignal.throwIfAborted();
          elements.push({...element,picElement:{...element.picElement,onebotImageError:true}});
          console.error(JSON.stringify({event:'image_receive_failed',code:error instanceof BotError?error.code:1500,
            reason:error instanceof BotError?error.message:typeof error.code==='string'?error.code:'SDK download exception'}));
        }
      }
      await this.cache.cleanup().catch(()=>{});
      return {...raw,elements};
    },this.timeout,{signal});}
    catch(error){
      if(signal?.aborted||error.code!==1502)throw error;
      // Keep text and completed images if a later image times out. An absent
      // file must never masquerade as a ready image in AstrBot.
      return {...raw,elements:(raw.elements||[]).map((element,index)=>elements[index]||
        (Number(element.elementType)===2?{...element,picElement:{...element.picElement,onebotImageError:true}}:element))};
    }
  }
}
