import { BotError } from '../../errors.mjs';
import { encode, decode, all, number, text, nested, packed } from './protobuf.mjs';

async function oidb(transport, command, subcommand, body, uid, context) {
  const response = decode(await transport.request(`OidbSvcTrpcTcp.0x${command.toString(16)}_${subcommand}`,
    encode({ 1: command, 2: subcommand, 4: encode(body), 12: Number(uid) }), context));
  if (number(response, 1) !== command || number(response, 2) !== subcommand || number(response, 3)) {
    throw new BotError('QQ contact query rejected or mismatched', 1500);
  }
  return nested(response, 4);
}
export async function fetchFriends(transport, context) {
  const friends = new Map(), tokens = new Set();
  let next;
  for (let page = 0; page < 1000; page++) {
    const response = await oidb(transport, 0xfd4, 1, {
      2: 300, 4: 0, 5: next ? { 1: next } : undefined, 6: 1, 7: 2147483647,
      10001: [{ 1: 1, 2: { 1: packed([103, 102, 20002, 27394]) } }, { 1: 4, 2: { 1: packed([100, 101, 102]) } }],
      10002: packed([13578, 13579, 13573, 13572, 13568]), 10003: 4051
    }, false, context);
    for (const raw of all(response, 101)) {
      const friend = decode(raw), properties = new Map();
      for (const additional of all(friend, 10001).map(decode)) {
        if (number(additional, 1) !== 1) continue;
        for (const property of all(nested(additional, 2), 2).map(decode)) properties.set(number(property, 1), text(property, 2));
      }
      const user_id = number(friend, 3), uid = text(friend, 1);
      if (!user_id || !uid) throw new BotError('QQ friend entry lacks identity', 1500);
      friends.set(user_id, { user_id, uid, nickname: properties.get(20002) || '', remark: properties.get(103) || '' });
    }
    next = number(nested(response, 2), 1);
    if (!next) return friends;
    if (tokens.has(next)) throw new BotError('QQ friend pagination loop', 1500);
    tokens.add(next);
  }
  throw new BotError('QQ friend page limit exceeded', 1500);
}
export async function fetchGroups(transport, context) {
  const flags = Object.fromEntries([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 5001, 5002, 5003].map(key => [key, 1]));
  const response = await oidb(transport, 0xfe5, 2, { 1: { 1: flags,
    2: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(key => [key, 1])), 3: { 5: 1, 6: 1 } } }, true, context);
  return all(response, 2).map(raw => {
    const group = decode(raw), info = nested(group, 4), group_id = number(group, 3);
    if (!group_id) throw new BotError('QQ group entry lacks identity', 1500);
    return { group_id, group_name: text(info, 5), member_count: number(info, 4), max_member_count: number(info, 3) };
  });
}
