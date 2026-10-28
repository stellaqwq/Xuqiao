import { BotError } from '../../errors.mjs';
import { id, toCQ } from '../../messages.mjs';
import { encode, decode, all, first, number, text, buffer, nested } from './protobuf.mjs';

export function encodeTextMessage({ kind, target, message, sequence, random, uid, resolveUid }) {
  const elements = message.map(segment => {
    if (segment.type === 'text') return { 1: { 1: segment.data.text } };
    if (segment.type === 'at' && kind === 'group') {
      const allMembers = segment.data.qq === 'all';
      const targetUid = allMembers ? '' : resolveUid(id(segment.data.qq, 'at.qq'));
      if (!allMembers && !targetUid) throw new BotError('Unknown mention UID; receive a message from this user first', 1404);
      return { 1: { 1: allMembers ? '@全体成员' : `@${segment.data.qq}`, 12: encode({ 3: allMembers ? 1 : 2, 4: 0, 5: 0, 9: targetUid }) } };
    }
    throw new BotError(`Native QQ sending does not support segment: ${segment.type}`, 1404);
  });
  if (kind === 'private' && !uid) throw new BotError('Private recipient UID unavailable; refresh friends or receive a message first', 1404);
  return encode({
    1: kind === 'group' ? { 2: { 1: target } } : { 1: { 2: uid } },
    2: { 1: 1, 2: 0, 3: 0 }, 3: { 1: { 2: elements } }, 4: sequence, 5: random,
    12: kind === 'group' ? { 1: Math.floor(Date.now() / 1000) } : undefined
  });
}
export function decodeSendAck(data, kind) {
  let ack, result, sequence, time;
  try {
    ack = decode(data); result = first(ack, 1) ?? 0n;
    if (typeof result !== 'bigint') throw new Error();
    result = BigInt.asIntN(32, result);
    sequence = number(ack, kind === 'group' ? 11 : 14); time = number(ack, 3);
  } catch { throw new BotError('Malformed QQ send ACK; result unknown', 1502, { uncertain: true }); }
  if (result !== 0n) throw new BotError(`QQ message rejected (${result})`, 1500);
  if (!sequence || !time) throw new BotError('QQ send ACK lacks message identity; result unknown', 1502, { uncertain: true });
  return { sequence, time };
}
export function decodePush(data, account, resolveUin = () => undefined) {
  const message = nested(decode(data), 1), head = nested(message, 1), content = nested(message, 2);
  const type = number(content, 1);
  if (![82, 166].includes(type)) return null;
  const sender = number(head, 1), time = number(content, 6), sequence = number(content, 5);
  if (!sender || !time || !sequence) throw new BotError('QQ message push lacks stable identity', 1500);
  const fromUid = text(head, 2), toUid = text(head, 6), to = number(head, 5);
  const group = nested(head, 8), groupId = number(group, 1);
  if (type === 82 && !groupId) throw new BotError('QQ group push lacks group ID', 1500);
  const body = nested(message, 3), rich = nested(body, 1), segments = [];
  if (buffer(body, 2).length || buffer(body, 3).length) throw new BotError('Native QQ received an unsupported message body', 1404);
  let unsupported = false;
  for (const raw of all(rich, 2)) {
    const element = decode(raw);
    if (first(element, 1) !== undefined) {
      const entry = nested(element, 1), value = text(entry, 1), attr = buffer(entry, 3);
      let mention;
      if (attr.length >= 11) mention = attr.readUInt32BE(7) || 'all';
      else if (buffer(entry, 12).length) {
        const extra = nested(entry, 12), mentionType = number(extra, 3), mentionUid = text(extra, 9);
        if (mentionType === 1) mention = 'all';
        else if (mentionType === 2) {
          mention = number(extra, 4) || (mentionUid === fromUid ? sender : resolveUin(mentionUid));
          if (!mention) throw new BotError('Native QQ cannot resolve received mention UID', 1404);
        }
      }
      if (mention !== undefined) segments.push({ type: 'at', data: { qq: String(mention) } });
      else if (value) segments.push({ type: 'text', data: { text: value } });
    } else if ([2, 3, 4, 5, 6, 8, 12, 13, 19, 21, 24, 31, 45, 51, 53].some(field => element.has(field))) unsupported = true;
  }
  // Never pass a partial message to AI or silently discard unimplemented media.
  if (unsupported || rich.has(3) || rich.has(4) || !segments.length) {
    throw new BotError('Native QQ received an unsupported message segment', 1404);
  }
  const kind = type === 82 ? 'group' : 'private', target = kind === 'group' ? groupId : sender === account ? to : sender;
  if (!target) throw new BotError('QQ message push lacks conversation target', 1500);
  return { kind, target, sequence, time, fromUid, toUid, to, sender: { user_id: sender,
    nickname: kind === 'group' ? text(group, 4) : text(nested(head, 7), 6) }, message: segments,
    ...(kind === 'group' ? { groupId } : { subType: 'friend' }) };
}

// One canonical key is shared by send ACKs, self pushes and duplicate pushes.
export const messageKey = message => `ntqq:${message.kind}:${message.target}:${message.sender.user_id}:${message.sequence}`;
export function onebotMessage(message, messageId) {
  return { message_id: messageId, real_id: message.sequence, time: message.time, message_type: message.kind,
    message: message.message, raw_message: toCQ(message.message), sender: message.sender,
    ...(message.kind === 'group' ? { group_id: message.target } : { user_id: message.target }) };
}
