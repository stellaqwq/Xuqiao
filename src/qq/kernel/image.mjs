import { open, mkdir, writeFile, readdir, stat, unlink, realpath, utimes } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BotError } from '../../errors.mjs';

export const DEFAULT_IMAGE_BYTES = 10 * 1024 * 1024;
const invalid = () => new BotError('Invalid or unsupported image; use PNG, JPEG, GIF or WebP', 1400);
function dimensions(format,width,height) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>32768||height>32768||width*height>100000000)throw invalid();
  return { format, width, height };
}
// Read dimensions from bounded container headers; no untrusted codecs execute
// in the main process. The SDK remains responsible for decoding and uploading.
export function imageInfo(bytes) {
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR')
    return dimensions('png',bytes.readUInt32BE(16),bytes.readUInt32BE(20));
  if(bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return dimensions('gif',bytes.readUInt16LE(6),bytes.readUInt16LE(8));
  if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216) {
    let p=2;
    while(p+4<=bytes.length) {
      if(bytes[p++]!==255)throw invalid();while(p<bytes.length&&bytes[p]===255)p++;
      const marker=bytes[p++];if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(p+2>bytes.length)break;const length=bytes.readUInt16BE(p);
      if(length<2||p+length>bytes.length)throw invalid();
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if(length<8)throw invalid();return dimensions('jpg',bytes.readUInt16BE(p+5),bytes.readUInt16BE(p+3));
      }
      p+=length;
    }
  }
  if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length) {
    const kind=bytes.toString('ascii',12,16),length=bytes.readUInt32LE(16);
    if(20+length>bytes.length)throw invalid();
    if(kind==='VP8X'&&length>=10)return dimensions('webp',1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3));
    if(kind==='VP8L'&&length>=5&&bytes[20]===47) {
      const bits=bytes.readUInt32LE(21);return dimensions('webp',(bits&16383)+1,((bits>>>14)&16383)+1);
    }
    if(kind==='VP8 '&&length>=10&&bytes.subarray(23,26).equals(Buffer.from([157,1,42])))return dimensions('webp',bytes.readUInt16LE(26)&16383,bytes.readUInt16LE(28)&16383);
  }
  throw invalid();
}
function base64(value,maxBytes) {
  const text=value.replace(/[\t\r\n ]/g,'');
  if(text.length>4*Math.ceil(maxBytes/3))throw new BotError('Image exceeds MEDIA_MAX_BYTES',1400);
  if(!text||text.length%4===1||!/^[A-Za-z0-9+/]+={0,2}$/.test(text))throw new BotError('Invalid base64 image',1400);
  const bytes=Buffer.from(text,'base64');
  if(bytes.toString('base64').replace(/=+$/,'')!==text.replace(/=+$/,''))throw new BotError('Invalid base64 image',1400);
  return bytes;
}
async function localBytes(path,maxBytes,signal) {
  let handle;
  try {
    handle=await open(path,'r');const info=await handle.stat();
    if(!info.isFile()||info.size<1||info.size>maxBytes)throw new BotError('Image is not a regular file or exceeds MEDIA_MAX_BYTES',1400);
    const bytes=Buffer.alloc(info.size);let offset=0;
    while(offset<bytes.length) { signal?.throwIfAborted();const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw invalid();offset+=result.bytesRead; }
    return bytes;
  }catch(error) {
    if(error.code==='ENOENT')throw new BotError('Image file not found on the QQ bot host; enable base64 image sending in AstrBot',1400);
    throw error;
  }finally{await handle?.close();}
}
async function remoteBytes(value,maxBytes,signal) {
  let url=new URL(value),response;
  for(let redirects=0;redirects<=3;redirects++) {
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new BotError('Image URL must be HTTP(S) without credentials',1400);
    response=await fetch(url,{signal,redirect:'manual',headers:{Accept:'image/*'}});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location||redirects===3)throw new BotError('Too many image URL redirects',1400);
      const next=new URL(location,url);if(url.protocol==='https:'&&next.protocol==='http:')throw new BotError('Image redirect cannot downgrade HTTPS',1400);url=next;continue;
    }
    break;
  }
  if(!response.ok){await response.body?.cancel();throw new BotError('Image download failed (HTTP '+response.status+')',1400);}
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new BotError('Image exceeds MEDIA_MAX_BYTES',1400);}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new BotError('Image exceeds MEDIA_MAX_BYTES',1400);chunks.push(chunk);}
  return Buffer.concat(chunks,size);
}
export async function readImage(source,{maxBytes=DEFAULT_IMAGE_BYTES,signal}={}) {
  signal?.throwIfAborted();
  if(typeof source!=='string'||!source||source.length>4*Math.ceil(maxBytes/3)+128)throw new BotError('Invalid image file source or image too large',1400);
  let bytes;
  if(source.startsWith('base64://'))bytes=base64(source.slice(9),maxBytes);
  else if(/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source))bytes=base64(source.slice(source.indexOf(',')+1),maxBytes);
  else if(/^https?:\/\//i.test(source))bytes=await remoteBytes(source,maxBytes,signal);
  else {
    let path=source;
    if(/^file:/i.test(source)) {
      const url=new URL(source);if(url.hostname&&url.hostname!=='localhost')throw new BotError('Network file URLs are unsupported; send image as base64',1400);
      path=fileURLToPath(url);
    }else if(!isAbsolute(source))throw new BotError('Image must use an absolute local path, file URL, HTTP(S) URL or base64',1400);
    bytes=await localBytes(path,maxBytes,signal);
  }
  signal?.throwIfAborted();if(!bytes.length||bytes.length>maxBytes)throw new BotError('Image is empty or exceeds MEDIA_MAX_BYTES',1400);
  return { bytes,...imageInfo(bytes),md5:createHash('md5').update(bytes).digest('hex') };
}
export class ImageCache {
  constructor(directory,{maxBytes=DEFAULT_IMAGE_BYTES,retentionDays=7}={}){this.directory=resolve(directory);this.maxBytes=maxBytes;this.retentionDays=retentionDays;this.active=new Map();this.writes=new Map();this.cleaning=null;this.lastCleanup=0;}
  async stage(image, service, signal, { elementType = 2 } = {}) {
    if (typeof service?.getRichMediaFilePathForGuild !== 'function') return image.path;
    // The upload service resolves its own managed media directory. A generic
    // outbox path is insufficient for some desktop SDK versions.
    const destination = await service.getRichMediaFilePathForGuild({
      md5HexStr: image.md5, fileName: image.md5 + '.' + image.format,
      elementType, elementSubType: 0, thumbSize: 0,
      needCreate: true, downloadType: 1, file_uuid: ''
    });
    signal?.throwIfAborted();
    const root = await realpath(dirname(this.directory));
    if (typeof destination !== 'string' || !isAbsolute(destination)) throw new BotError('QQ SDK returned no valid media directory',1501);
    const within = path => { const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..\\')&&!part.startsWith('../')&&!isAbsolute(part); };
    if (!within(resolve(destination))) throw new BotError('QQ SDK media directory is outside QQ_KERNEL_DATA',1501);
    await mkdir(dirname(destination),{recursive:true});
    if (!within(join(await realpath(dirname(destination)),destination.split(/[\\/]/).at(-1)))) throw new BotError('QQ SDK media directory cannot use an external link',1501);
    try {
      const existing = await realpath(destination);
      if (relative(existing,resolve(destination)) !== '') throw new BotError('QQ SDK media file cannot be a link',1501);
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    let writing=this.writes.get(destination);
    if(!writing) {
      writing=(async()=>{
        try { await writeFile(destination,image.bytes,{flag:'wx',mode:0o600}); }
        catch(error) {
          if(error.code!=='EEXIST')throw error;
          const bytes=await localBytes(destination,this.maxBytes,signal);
          if(!bytes.equals(image.bytes))throw new BotError('QQ SDK media file integrity mismatch',1500);
        }
      })();
      this.writes.set(destination,writing);
      writing.finally(()=>{if(this.writes.get(destination)===writing)this.writes.delete(destination);}).catch(()=>{});
    }
    await writing;
    signal?.throwIfAborted();
    return destination;
  }
  async acquire(source,{signal}={}) {
    const image=await readImage(source,{maxBytes:this.maxBytes,signal});
    return this.retain(image,{signal});
  }
  async retain(image,{signal}={}) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=join(this.directory,image.md5+'.'+image.format);
    while(this.cleaning)await this.cleaning;
    this.active.set(path,(this.active.get(path)||0)+1);
    try {
      let writing=this.writes.get(path);
      if(!writing){
        writing=(async()=>{
          try { await writeFile(path,image.bytes,{flag:'wx',mode:0o600}); }
          catch(error) {
            if(error.code!=='EEXIST')throw error;
            if(await realpath(path)!==join(await realpath(this.directory),image.md5+'.'+image.format))throw new BotError('Invalid media cache path',1400);
            const existing=await localBytes(path,this.maxBytes,signal);
            if(!existing.equals(image.bytes))throw new BotError('Media cache integrity mismatch',1500);
          }
          const now=new Date();await utimes(path,now,now);
        })();this.writes.set(path,writing);
        writing.finally(()=>{if(this.writes.get(path)===writing)this.writes.delete(path);}).catch(()=>{});
      }
      await writing;signal?.throwIfAborted();
      let released=false;
      return {...image,path,file:pathToFileURL(path).href,release:()=>{if(released)return;released=true;const count=(this.active.get(path)||1)-1;if(count)this.active.set(path,count);else this.active.delete(path);}};
    }catch(error){const count=(this.active.get(path)||1)-1;if(count)this.active.set(path,count);else this.active.delete(path);throw error;}
  }
  async cleanup() {
    if(this.cleaning)return this.cleaning;
    if(Date.now()-this.lastCleanup<3600000)return;
    this.cleaning=(async()=>{
      let names;try{names=await readdir(this.directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
      const before=Date.now()-this.retentionDays*86400000;
      for(const name of names){if(!(this.pattern||/^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/).test(name))continue;const path=join(this.directory,name);if(this.active.has(path))continue;const info=await stat(path);if(info.mtimeMs<before&&!this.active.has(path))await unlink(path);}
      this.lastCleanup=Date.now();
    })().finally(()=>{this.cleaning=null;});return this.cleaning;
  }
}
