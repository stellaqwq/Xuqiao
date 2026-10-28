import { aiInput, chatCommandAllowed, replyMessage, replyOptions } from './messages.mjs';
import { filterAIReply } from './reply-filter.mjs';
import { BotError } from './errors.mjs';

// A durable receipt is written before each QQ submission. Interrupted partial
// generations are never replayed from the beginning after a restart.
export class ReplyStream {
  constructor(worker, job, event) {
    Object.assign(this, { worker, job, event });
    this.sent = '';
  }
  async delta(_delta, text) {
    const { worker: w, job, event } = this;
    text = filterAIReply(text, w.config, { partial: true }).trimStart();
    w.store.streamText(job.id, text);
    if (job.channel === 'web' || !this.qq) return;
    while (true) {
      let pending = text.slice(this.sent.length);
      // Hold potential meme tags until the existing media planner handles them.
      const tag = pending.indexOf('[[');
      if (tag !== -1) pending = pending.slice(0, tag);
      else if (pending.endsWith('[')) pending = pending.slice(0,-1);
      const chars = Array.from(pending.trimEnd()), limit = w.config.ai.streamChunkChars || 240;
      const candidate = chars.slice(0, limit).join('');
      const matches = [...candidate.matchAll(/[。！？!?\n](?:[”’」』])?/gu)];
      const end = matches.at(-1);
      let length = end && end.index + end[0].length >= Math.min(60, limit) ? end.index + end[0].length : 0;
      if (!length && chars.length >= limit) length = candidate.length;
      if (!length) return;
      const content = pending.slice(0, length);
      const signal=this.signal||w.controller.signal;signal.throwIfAborted();
      if (!chatCommandAllowed(event, w.config) || !(w.groupChatPlus?.route(job)?w.groupChatPlus.scopedRoute(job,event):aiInput(event,w.config.ai))) throw new BotError('Reply permission revoked', 1403);
      const part = w.store.beginStreamPart(job.id, content);
      try {
        const result = await w.adapter.action(event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg', {
          ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id }),
          message: replyMessage(event, [{ type: 'text', data: { text: content } }],this.replyOptions||replyOptions(w.config))
        }, { signal });
        w.store.endStreamPart(job.id, part, 'sent', result?.message_id);
        this.sent += content;
      } catch (error) {
        const unknown = error.uncertain || !error.code;
        w.store.endStreamPart(job.id, part, unknown ? 'uncertain' : 'failed');
        throw error;
      }
    }
  }
}
