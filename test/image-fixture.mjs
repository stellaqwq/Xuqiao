import { deflateSync } from 'node:zlib';
function crc32(bytes) { let crc=0xffffffff;for(const value of bytes){crc^=value;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
function chunk(type,data) {const bytes=Buffer.from(type),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);bytes.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc32(Buffer.concat([bytes,data])),data.length+8);return result;}
export function png(width=32,height=24) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(height*(width*3+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(width*3+1)+1+x*3;rows[p]=40+Math.floor(x/width*160);rows[p+1]=60+Math.floor(y/height*150);rows[p+2]=140;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
export const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
export function pngWithComment(bytes,length) { return Buffer.concat([bytes.subarray(0,bytes.length-12),chunk('tEXt',Buffer.concat([Buffer.from('Comment\0'),Buffer.alloc(length,97)])),bytes.subarray(bytes.length-12)]); }
