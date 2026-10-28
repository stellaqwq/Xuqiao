import { join, relative } from 'node:path';
import { realpath, utimes } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ImageCache, readImage } from './kernel/image.mjs';
import { BotError } from '../errors.mjs';

const filePattern=/^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/;
const mime={png:'image/png',jpg:'image/jpeg',gif:'image/gif',webp:'image/webp'};

// A capability URL grants access to one validated cached image only. It never
// carries OneBot/admin credentials and cannot select an arbitrary disk path.
export class ImageDelivery {
  constructor(config,account) {
    this.config=config;this.account=account;
    this.cache=new ImageCache(join(config.kernel.data,'media-inbox'),config.media);
  }
  setOrigin(origin) {this.origin=this.config.media?.baseUrl||origin;}
  signature(file) {return createHmac('sha256',this.config.sessionKey).update(JSON.stringify(['image',this.account(),file])).digest('hex');}
  describe(file) {
    if(!filePattern.test(file)||!this.origin)throw new BotError('Received image is not ready for delivery',1501);
    return {file,url:this.origin+'/media/image/'+file+'?key='+this.signature(file)};
  }
  async read(file) {
    if(typeof file!=='string'||!filePattern.test(file))throw new BotError('Unknown cached image',1404);
    let image;
    let path;
    try {
      const root=await realpath(this.cache.directory);path=await realpath(join(root,file));
      if(relative(root,path)!==file)throw new BotError('Image path cannot use an external link',1404);
      image=await readImage(path,{maxBytes:this.cache.maxBytes});
    }
    catch {throw new BotError('Cached image is unavailable or expired',1404);}
    if(image.md5+'.'+image.format!==file)throw new BotError('Cached image checksum mismatch',1404);
    const now=new Date();await utimes(path,now,now);
    return {...image,path,release(){}};
  }
  async info(file) {
    const image=await this.read(file);
    try{return {size:image.bytes.length,filename:file,...this.describe(file),file:image.path};}
    finally{image.release();}
  }
  async http(req,res,url) {
    if(!url.pathname.startsWith('/media/image/'))return false;
    const file=url.pathname.slice('/media/image/'.length),key=url.searchParams.get('key')||'';
    const authorized=filePattern.test(file)&&/^[a-f0-9]{64}$/.test(key)&&timingSafeEqual(Buffer.from(key,'hex'),Buffer.from(this.signature(file),'hex'));
    if(!authorized||!['GET','HEAD'].includes(req.method)){
      res.writeHead(404,{'Cache-Control':'no-store'});res.end();return true;
    }
    let image;
    try {
      image=await this.read(file);
      res.writeHead(200,{'Content-Type':mime[image.format],'Content-Length':image.bytes.length,
        'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:image.bytes);
    } catch {res.writeHead(404,{'Cache-Control':'no-store'});res.end();}
    finally{image?.release();}
    return true;
  }
}
