import { BotError } from '../../errors.mjs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const messageKey = raw => JSON.stringify(['qq-kernel', Number(raw.chatType), String(raw.peerUid), String(raw.msgId)]);

function accountNumber(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return 0;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}
export function messageSender(raw, account, resolveUid = () => 0) {
  const explicit = accountNumber(raw.senderUin);
  if (explicit) return explicit;
  if (typeof raw.senderUid !== 'string' || !/^u_[\w-]+$/.test(raw.senderUid)) return 0;
  if (raw.senderUid === raw.selfUid) return accountNumber(account);
  return accountNumber(resolveUid(raw.senderUid));
}

export function kernelText(message) {
  if (!Array.isArray(message) || !message.length || message.some(s => s.type !== 'text' || typeof s.data?.text !== 'string')) {
    throw new BotError('Official kernel adapter currently sends text segments only', 1404);
  }
  const content = message.map(s => s.data.text).join('');
  if (!content || content.length > 10000) throw new BotError('Invalid QQ text length', 1400);
  return [{ elementType: 1, elementId: '', textElement: { content, atType: 0, atUid: '', atNtUid: '', atTinyId: '', atNtUin: '' } }];
}

export function normalizeMessage(raw, account, resolveUid = () => 0, resolveImage, resolveReply) {
  const kind = Number(raw.chatType) === 1 ? 'private' : Number(raw.chatType) === 2 ? 'group' : null;
  const sender = messageSender(raw, account, resolveUid);
  if (!kind) throw new BotError('Unsupported QQ message conversation type', 1500);
  if (!String(raw.msgId || '')) throw new BotError('QQ message identity has no message ID', 1500);
  if (!raw.peerUid) throw new BotError('QQ message identity has no peer', 1500);
  if (!Number.isSafeInteger(sender) || sender <= 0) throw new BotError('QQ message identity has no resolved sender', 1500);
  const message = [];
  for (const element of raw.elements || []) {
    const text = element.textElement;
    if (Number(element.elementType) === 1 && text) {
      const at = Number(text.atType) === 1 ? 'all' : Number(text.atNtUin) ||
        (text.atNtUid && text.atNtUid === raw.selfUid ? account : resolveUid(text.atNtUid));
      if (Number(text.atType) > 0 && at) message.push({ type: 'at', data: { qq: String(at) } });
      else if (text.content) message.push({ type: 'text', data: { text: String(text.content) } });
    } else if(Number(element.elementType)===2&&element.picElement) {
      const pic=element.picElement;
      if(pic.onebotImageError){message.push({type:'text',data:{text:'[图片下载失败，请稍后重发]'}});continue;}
      const url=typeof pic.originImageUrl==='string'&&/^https?:\/\//i.test(pic.originImageUrl)?pic.originImageUrl:'';
      const path=typeof pic.sourcePath==='string'&&isAbsolute(pic.sourcePath)?pic.sourcePath:'';
      const data={file:path?pathToFileURL(path).href:String(pic.fileName||pic.md5HexStr||'image'),
        sub_type:Number(pic.picSubType)||0,summary:String(pic.summary||''),file_size:String(pic.fileSize||'0')};
      if(url)data.url=url;
      if(pic.onebotImageFile&&resolveImage)Object.assign(data,resolveImage(pic.onebotImageFile));
      message.push({type:'image',data});
    } else if(Number(element.elementType)===3&&element.fileElement) {
      const file=element.fileElement,path=file.onebotFilePath;
      message.push({type:'file',data:{name:String(file.fileName||'附件'),file:typeof path==='string'&&isAbsolute(path)?pathToFileURL(path).href:'',file_size:String(file.fileSize||'0'),
        ...(file.onebotFileError?{error:'文件下载失败、格式不支持或超过大小限制，请转换格式或分批重发。'}:{})}});
    } else if(Number(element.elementType)===7&&element.replyElement) {
      const reply=element.replyElement,source=reply.replayMsgId&&reply.replayMsgId!=='0'?reply.replayMsgId:reply.sourceMsgIdInRecords;
      const id=source&&resolveReply?.(String(source));
      if(id!==undefined&&id!==null)message.push({type:'reply',data:{id:String(id)}});
    } else if(Number(element.elementType)===4&&element.pttElement) {
      const voice=element.pttElement;
      message.push({type:'record',data:{file:typeof voice.filePath==='string'&&isAbsolute(voice.filePath)?pathToFileURL(voice.filePath).href:String(voice.fileName||voice.md5HexStr||'voice.silk'),
        file_size:String(voice.fileSize||'0'),duration:Number(voice.duration)||0}});
    } else message.push({ type: 'text', data: { text: `[QQ 消息段 ${Number(element.elementType)}]` } });
  }
  if (!message.length) throw new BotError('QQ message has no supported content', 1404);
  const time = Number(raw.msgTime);
  if (!Number.isSafeInteger(time) || time < 0) throw new BotError('Invalid QQ message timestamp', 1500);
  const groupId = kind === 'group' ? Number(raw.peerUid) : undefined;
  if (kind === 'group' && (!Number.isSafeInteger(groupId) || groupId <= 0)) throw new BotError('Invalid QQ group identity', 1500);
  return { nativeId: messageKey(raw), kind, sender: { user_id: sender, nickname: raw.sendNickName || raw.senderMemberName || '' },
    message, time, ...(kind === 'group' ? { groupId } : {}) };
}

// A local sendMsg(result=0) only means accepted. Success requires a matching
// kernel status update for the same conversation and native message ID.
export class SendTracker {
  constructor(timeout = 14000) { this.timeout = timeout; this.pending = new Map(); }
  wait(raw, signal, timeout = this.timeout) {
    signal?.throwIfAborted();
    const key = messageKey(raw);
    if (this.pending.has(key)) throw new BotError('Duplicate kernel send identity', 1500);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
    const finish = (error, value) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(key);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new BotError('QQ send confirmation unavailable', 1502, { uncertain: true }));
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true }); this.pending.set(key, finish);
    return { promise, reject: error => finish(error) };
  }
  update(raw) {
    const finish = this.pending.get(messageKey(raw));
    if (!finish) return;
    if (Number(raw.sendStatus) === 2) finish(null, raw);
    else if (raw.sendStatus !== undefined && Number(raw.sendStatus) === 0) finish(new BotError('QQ kernel reported send failure', 1500));
  }
  close() { for (const finish of [...this.pending.values()]) finish(new BotError('QQ kernel disconnected before send confirmation', 1502, { uncertain: true })); }
}
