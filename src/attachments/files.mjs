import { open, realpath } from 'node:fs/promises';
import { relative, isAbsolute, extname } from 'node:path';
import { BotError } from '../errors.mjs';
import { imageInfo } from '../qq/kernel/image.mjs';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const imageMime = { png:'image/png', jpg:'image/jpeg', gif:'image/gif', webp:'image/webp' };
const textExtensions = new Set('txt md markdown csv tsv json jsonl log xml html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs sh ps1 sql yaml yml toml ini conf tex'.split(' '));
export const acceptsFileName = name => textExtensions.has(extname(name).slice(1).toLowerCase()) || /\.(?:pdf|docx|xlsx|png|jpe?g|gif|webp)$/i.test(name);
export const attachmentError = message => new BotError(message,1400);
export const safeName = value => String(value || '附件').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,180) || '附件';
export function attachmentType(name, bytes) {
  try { const info=imageInfo(bytes);return {kind:'image',extension:info.format,mime:imageMime[info.format]}; } catch {}
  const extension=extname(name).slice(1).toLowerCase();
  if (textExtensions.has(extension)) return {kind:'text',extension,mime:'text/plain'};
  if (extension==='pdf' && bytes.subarray(0,5).toString()==='%PDF-') return {kind:'pdf',extension,mime:'application/pdf'};
  if (['docx','xlsx'].includes(extension) && bytes.subarray(0,2).toString()==='PK') return {kind:extension,extension,mime:'application/zip'};
  throw attachmentError('格式不支持或文件内容无效。支持图片、文本、PDF、DOCX 和 XLSX；旧版 DOC/XLS 请先转换。');
}
export function decodeUpload(data,maxBytes=MAX_ATTACHMENT_BYTES) {
  if(typeof data!=='string')throw attachmentError('请选择附件后重新上传。');
  const value=data.replace(/^data:[^,]{0,150};base64,/i,'').replace(/^base64:\/\//,'');
  if(value.length>4*Math.ceil(maxBytes/3))throw attachmentError('附件超过大小限制。');
  if(!value||value.length%4===1||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw attachmentError('附件编码无效，请重新选择。');
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>maxBytes||bytes.toString('base64').replace(/=+$/,'')!==value.replace(/=+$/,''))throw attachmentError('附件为空、编码无效或超过大小限制。');
  return bytes;
}
export async function readOwnedFile(root, source, maxBytes=MAX_ATTACHMENT_BYTES, signal) {
  signal?.throwIfAborted();
  const directory=await realpath(root),path=await realpath(source),part=relative(directory,path);
  if(!part||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw attachmentError('附件不在受管理的缓存目录中。');
  let handle;
  try {
    handle=await open(path,'r');const info=await handle.stat();
    if(!info.isFile()||info.size<1||info.size>maxBytes)throw attachmentError('附件为空或超过大小限制。');
    const bytes=Buffer.alloc(info.size);let offset=0;
    while(offset<bytes.length){signal?.throwIfAborted();const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw attachmentError('附件内容不完整，请重新发送。');offset+=result.bytesRead;}
    return bytes;
  } finally {await handle?.close();}
}
