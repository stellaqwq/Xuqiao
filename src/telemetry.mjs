import { EventEmitter } from 'node:events';
import { toCQ } from './messages.mjs';

// Bounded, process-local history. Message content is never written to logs.
export class Telemetry extends EventEmitter {
  constructor(limit = 1000) { super(); this.limit = limit; this.sequence = 0; this.entries = []; }
  message(event) {
    // Base64 image payloads belong to the send pipeline, not to the admin
    // history buffer. Keep diagnostic metadata without retaining binary data.
    if(Array.isArray(event.message)&&event.message.some(s=>['image','record'].includes(s.type)&&/^(?:base64:\/\/|data:(?:image|audio)\/|data:application\/octet-stream;)/i.test(s.data?.file||''))) {
      const message=event.message.map(s=>['image','record'].includes(s.type)&&/^(?:base64:\/\/|data:(?:image|audio)\/|data:application\/octet-stream;)/i.test(s.data?.file||'')?
        {type:s.type,data:{summary:s.data.summary||(s.type==='record'?'语音':'图片'),file:'['+s.type+' payload omitted]'}}:s);
      event={...event,message,raw_message:toCQ(message)};
    }
    if (event.message_id!==undefined && ['message','message_sent'].includes(event.post_type) && this.entries.some(e => e.kind==='message' &&
      e.event.self_id===event.self_id && e.event.post_type===event.post_type && e.event.message_id===event.message_id)) return;
    return this.add('message', { event });
  }
  add(kind, data) {
    const entry = { id:++this.sequence, time:new Date().toISOString(), kind, ...data };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.emit('entry', entry); return entry;
  }
  read(after = 0) { return { entries:this.entries.filter(e => e.id > after), cursor:this.sequence, oldest:this.entries[0]?.id || 0 }; }
}
