import { deadline } from '../../errors.mjs';
import { abortable } from './lifecycle.mjs';
import { messageKey } from './messages.mjs';

const content = raw => Array.isArray(raw?.elements) && raw.elements.length > 0;
export const isEmptyMessageRecord = raw => [1, 2].includes(Number(raw?.chatType)) &&
  Number(raw?.msgType) === 1 && Number(raw?.subMsgType) === 0 &&
  (!raw?.senderUid || raw.senderUid === '0') && Number(raw?.senderUin || 0) === 0 &&
  Array.isArray(raw?.elements) && raw.elements.length === 0;
function keyOf(raw) {
  return raw?.peerUid && String(raw?.msgId || '') && [1, 2].includes(Number(raw.chatType)) ? messageKey(raw) : null;
}

// Empty type-1 records are pushed separately from their populated message.
// Keep a bounded watch for the matching update, without inventing a sender or
// publishing an empty chat message. Ordinary updates remain send acknowledgments.
export class ReceiveRecords {
  constructor({ timeout = 1500, limit = 256, ttl = 60000, now = Date.now, onPending = () => {} } = {}) {
    Object.assign(this, { timeout, limit, ttl, now, onPending }); this.records = new Map();
  }
  prune() { const before = this.now() - this.ttl; for (const [key, record] of this.records) if (record.time <= before) this.records.delete(key); }
  clear() { this.records.clear(); }
  observe(raw, received) {
    this.prune(); const key = keyOf(raw), known = this.records.get(key);
    if (known?.published) return false;
    if (!received) return !!known && content(raw);
    if (isEmptyMessageRecord(raw) && key) {
      if (known?.queried) return false;
      if (!known) {
        while (this.records.size >= this.limit) this.records.delete(this.records.keys().next().value);
        this.records.set(key, { time: this.now(), queried: false, published: false });
      }
    }
    return true;
  }
  async prepare(raw, service, signal) {
    signal?.throwIfAborted();
    const key = keyOf(raw);
    if (key && isEmptyMessageRecord(raw) && !this.records.has(key)) this.observe(raw, true);
    const record = this.records.get(key);
    if (record?.published) return null;
    if (!isEmptyMessageRecord(raw) || !record) return raw;
    if (record.queried) return null;
    record.queried = true;
    let status = 'empty';
    try {
      if (typeof service?.getMsgsByMsgId !== 'function') throw new Error('Message readback unavailable');
      const peer = { chatType: Number(raw.chatType), peerUid: String(raw.peerUid), guildId: '' };
      const result = await deadline(operation => abortable(() => service.getMsgsByMsgId(peer, [String(raw.msgId)]), operation),
        this.timeout, { signal });
      signal?.throwIfAborted();
      if (result?.result !== undefined && Number(result.result) !== 0) throw new Error('Message readback rejected');
      const values = Array.isArray(result) ? result : Array.isArray(result?.msgList) ? result.msgList : [];
      const found = values.find(value => String(value?.msgId) === String(raw.msgId) &&
        (!value.peerUid || String(value.peerUid) === peer.peerUid) &&
        (value.chatType === undefined || Number(value.chatType) === peer.chatType) && content(value));
      if (found) return { ...raw, ...found, ...peer, msgId: raw.msgId };
    } catch {
      signal?.throwIfAborted(); status = 'unavailable';
    }
    this.onPending(raw, status); return null;
  }
  published(raw) { const record = this.records.get(keyOf(raw)); if (record) record.published = true; }
}
