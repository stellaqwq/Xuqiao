import { BotError, deadline } from '../../errors.mjs';
import { abortable } from './lifecycle.mjs';
import { messageSender } from './messages.mjs';

const validUid = uid => typeof uid === 'string' && /^u_[\w-]+$/.test(uid);
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const asMap = value => value instanceof Map ? value : new Map(Object.entries(value || {}));

function check(result) {
  if (result?.result !== undefined && Number(result.result) !== 0) throw new BotError('QQ contact query failed', 1500);
  return result;
}
function list(value, field) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[field])) return value[field];
  if (value?.data !== undefined) return list(value.data, field);
  return null;
}

// Some SDK versions return the list; others acknowledge the request and deliver
// the list through the listener. Subscribe before invoking the SDK in either case.
async function queryList(request, callbacks, name, field, signal) {
  signal?.throwIfAborted();
  let resolveEvent, rejectAbort;
  const pushed = new Promise(resolve => { resolveEvent = resolve; });
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const receive = (...values) => {
    for (const value of values) { const found = list(value, field); if (found) { resolveEvent(found); break; } }
  };
  const abort = () => rejectAbort(new BotError('QQ contact query cancelled', 1502));
  callbacks.on(name, receive); signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = check(await Promise.race([Promise.resolve().then(request), cancelled]));
    return list(result, field) ?? await Promise.race([pushed, cancelled]);
  } finally { callbacks.off(name, receive); signal?.removeEventListener('abort', abort); }
}

export async function resolveContactUid(session, target, signal, learn = () => {}) {
  signal?.throwIfAborted();
  const result = check(await abortable(() => session.getUixConvertService().getUid([String(target)]), signal));
  signal?.throwIfAborted();
  const uid = asMap(result?.uidInfo ?? result).get(String(target));
  if (!validUid(uid)) throw new BotError('QQ could not resolve this recipient UID', 1404);
  learn({ uin: String(target), uid }); return uid;
}

// Incoming group messages can contain only senderUid until member profiles
// have loaded. Confirm that UID through the SDK before publishing the message;
// peerUid denotes the conversation and must never substitute for its sender.
export async function resolveMessageSender(session, raw, {
  self, lookup = () => 0, learn = () => {}, signal, timeout = 3000
} = {}) {
  signal?.throwIfAborted();
  if (![1, 2].includes(Number(raw.chatType))) return raw;
  const identified = messageSender({ ...raw, selfUid: self?.uid }, self?.uin, lookup);
  if (identified) return String(raw.senderUin) === String(identified) ? raw : { ...raw, senderUin: String(identified) };
  if (!validUid(raw.senderUid)) return raw;
  try {
    const result = check(await deadline(operation => abortable(
      () => session.getUixConvertService().getUin([raw.senderUid]), operation
    ), timeout, { signal }));
    signal?.throwIfAborted();
    const value = asMap(result?.uinInfo ?? result).get(raw.senderUid);
    const uin = messageSender({ senderUin: value });
    if (!uin) return raw;
    learn({ uin: String(uin), uid: raw.senderUid });
    return { ...raw, senderUin: String(uin) };
  } catch {
    // Preserve normal validation/diagnostics if the SDK cannot resolve it.
    // Session cancellation must instead stop this old receive operation.
    signal?.throwIfAborted();
    return raw;
  }
}

export async function fetchKernelFriends(session, callbacks, signal, learn = () => {}, arity = 3) {
  const args = arity === 2 ? [true, 0] : ['qq-ai-bot', true, 0];
  const groups = await queryList(() => session.getBuddyService().getBuddyListV2(...args), callbacks, 'buddy-list', 'buddyList', signal);
  const entries = [];
  for (const group of groups) {
    if (Array.isArray(group?.buddyList)) entries.push(...group.buddyList);
    else if (Array.isArray(group?.buddyUids)) entries.push(...group.buddyUids.map(uid => ({ uid })));
    else if (validUid(group?.uid)) entries.push(group);
    else throw new BotError('QQ returned an unknown friend list shape', 1500);
  }
  let profiles = new Map();
  try { profiles = asMap(session.getProfileService().getCoreAndBaseInfo('qq-ai-bot', entries.map(entry => entry.uid))); } catch {}
  const unresolved = entries.filter(entry => !validId(entry.uin ?? entry.coreInfo?.uin ?? profiles.get(entry.uid)?.uin)).map(entry => entry.uid);
  let uins = new Map();
  if (unresolved.length) {
    const result = check(await abortable(() => session.getUixConvertService().getUin(unresolved), signal));
    uins = asMap(result?.uinInfo ?? result);
  }
  signal?.throwIfAborted();
  const friends = new Map();
  for (const entry of entries) {
    const core = entry.coreInfo || profiles.get(entry.uid)?.coreInfo || entry;
    const uin = entry.uin ?? core.uin ?? profiles.get(entry.uid)?.uin ?? uins.get(entry.uid);
    if (!validUid(entry.uid) || !validId(uin)) throw new BotError('QQ friend entry lacks a valid identity', 1500);
    const contact = { uin: String(uin), uid: entry.uid, nick: core.nick || '', remark: core.remark || '' };
    learn(contact); friends.set(Number(uin), { user_id: Number(uin), nickname: contact.nick, remark: contact.remark });
  }
  return [...friends.values()];
}

export async function fetchKernelGroups(session, callbacks, signal) {
  const groups = await queryList(() => session.getGroupService().getGroupList(true), callbacks, 'group-list', 'groupList', signal);
  return groups.map(group => {
    const id = group.groupCode ?? group.group_id;
    if (!validId(id)) throw new BotError('QQ group entry lacks a valid identity', 1500);
    const result = { group_id: Number(id), group_name: group.groupName ?? group.group_name ?? '' };
    for (const [source, target] of [['memberCount', 'member_count'], ['maxMemberCount', 'max_member_count']]) {
      if (Number.isSafeInteger(Number(group[source])) && Number(group[source]) >= 0) result[target] = Number(group[source]);
    }
    return result;
  });
}
