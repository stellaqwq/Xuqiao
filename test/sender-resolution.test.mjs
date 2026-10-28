import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { messageSender, normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { resolveMessageSender } from '../src/qq/kernel/contacts.mjs';
import { kernelHost } from './kernel-host-harness.mjs';
import { waitFor, withTestTimeout } from './helpers.mjs';

const raw = extra => ({ chatType: 2, peerUid: '20000', senderUid: 'u_member', senderUin: '0',
  msgId: '123456789', msgTime: '1793000000', elements: [{ elementType: 1, textElement: { content: 'fixture' } }], ...extra });
const self = { uin: '10000', uid: 'u_self' };
const session = getUin => ({ getUixConvertService: () => ({ getUin }) });

test('message sender uses valid explicit identities, self UID and confirmed cached mappings', () => {
  assert.equal(messageSender(raw({ senderUin: '10002' }), 10000), 10002);
  assert.equal(messageSender(raw({ senderUid: 'u_self', selfUid: 'u_self' }), 10000), 10000);
  assert.equal(messageSender(raw({ senderUin: '-1' }), 10000, () => '10003'), 10003);
  assert.equal(messageSender(raw({ senderUin: true }), 10000), 0);
  assert.equal(messageSender(raw({ senderUin: '9007199254740992' }), 10000), 0);
  assert.equal(normalizeMessage(raw({ senderUid: 'u_self', selfUid: 'u_self' }), 10000).sender.user_id, 10000);
});

test('UID-only group members are resolved through the SDK and then reused from the cache', async () => {
  for (const wrap of [value => value, value => ({ result: 0, uinInfo: value }), value => ({ uinInfo: Object.fromEntries(value) })]) {
    let calls = 0; const cache = new Map();
    const sdk = session(async uids => { calls++; assert.deepEqual(uids, ['u_member']); return wrap(new Map([['u_member', '10001']])); });
    const options = { self, lookup: uid => cache.get(uid), learn: value => cache.set(value.uid, value.uin) };
    const original = raw({}), result = await resolveMessageSender(sdk, original, options);
    assert.equal(original.senderUin, '0'); assert.equal(result.senderUin, '10001');
    const normalized = normalizeMessage(result, 10000);
    assert.equal(normalized.sender.user_id, 10001); assert.equal(normalized.groupId, 20000);
    assert.equal((await resolveMessageSender(sdk, raw({ peerUid: '30000' }), options)).senderUin, '10001');
    assert.equal(calls, 1);
  }
});

test('self identity and known senders do not require a native lookup', async () => {
  const sdk = session(() => { throw Error('unexpected lookup'); });
  assert.equal((await resolveMessageSender(sdk, raw({ senderUid: 'u_self' }), { self })).senderUin, '10000');
  assert.equal((await resolveMessageSender(sdk, raw({ senderUin: '10001' }), { self })).senderUin, '10001');
  assert.equal((await resolveMessageSender(sdk, raw({}), { self, lookup: () => '10001' })).senderUin, '10001');
  // Trust the active session's identity, not a selfUid field in the packet.
  const unknown = await resolveMessageSender(session(async () => new Map()), raw({ selfUid: 'u_member' }), { self });
  assert.equal(unknown.senderUin, '0');
});

test('missing or invalid UID never becomes the conversation peer or a made-up sender', async () => {
  for (const senderUid of ['', undefined, '20000']) {
    const original = raw({ senderUid });
    const result = await resolveMessageSender(session(() => { throw Error('unexpected lookup'); }), original, { self });
    assert.equal(result, original);
    assert.throws(() => normalizeMessage(result, 10000), /no resolved sender/);
  }
});

test('invalid, unrelated and rejected conversion results remain unresolved', async () => {
  for (const result of [new Map(), new Map([['u_other', '10001']]), { result: 1 },
    ...[0, true, -1, 'NaN', '9007199254740992', { uin: '10001' }].map(value => new Map([['u_member', value]]))]) {
    const original = raw({}); let learned = false;
    assert.equal(await resolveMessageSender(session(async () => result), original, { self, learn: () => { learned = true; } }), original);
    assert.equal(learned, false);
    assert.throws(() => normalizeMessage(original, 10000), /no resolved sender/);
  }
});

test('a hung conversion is bounded and its late response cannot change identity caches', async () => {
  let release, learned = false;
  const original = raw({});
  const result = await withTestTimeout(() => resolveMessageSender(session(() => new Promise(resolve => { release = resolve; })),
    original, { self, timeout: 25, learn: () => { learned = true; } }), 500);
  assert.equal(result, original);
  release(new Map([['u_member', '10001']])); await delay(20);
  assert.equal(learned, false);
});

test('session cancellation rejects pending sender resolution and discards late native results', async () => {
  const controller = new AbortController(); let release, learned = false;
  const result = resolveMessageSender(session(() => new Promise(resolve => { release = resolve; })), raw({}),
    { self, signal: controller.signal, learn: () => { learned = true; } });
  const rejected = assert.rejects(result, error => error.name === 'AbortError');
  await waitFor(() => release); controller.abort(); await rejected;
  release(new Map([['u_member', '10001']])); await delay(20);
  assert.equal(learned, false);
});

test('real host receive path resolves group senders and preserves conversation order', async t => {
  let release, calls = 0;
  const host = await kernelHost(t, { getUin: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  host.authenticate(); await waitFor(() => host.inspect().online);
  host.receive(raw({ msgId: '1' }));
  host.receive(raw({ msgId: '2', senderUid: 'u_second', senderUin: '10002' }));
  await waitFor(() => release);
  assert.equal(host.packets.filter(p => p.event === 'message').length, 0);
  release(new Map([['u_member', '10001']]));
  await waitFor(() => host.packets.filter(p => p.event === 'message').length === 2);
  const packets = host.packets.filter(p => p.event === 'message');
  assert.deepEqual(packets.map(p => p.data.msgId), ['1', '2']);
  assert.equal(normalizeMessage(packets[0].data, 10000).sender.user_id, 10001);
  host.receive(raw({ msgId: '3', peerUid: '30000' }));
  await waitFor(() => host.packets.filter(p => p.event === 'message').length === 3);
  assert.equal(calls, 1);
});

test('a kick during conversion prevents old messages and contact mappings from reaching the driver', async t => {
  let release;
  const host = await kernelHost(t, { getUin: () => new Promise(resolve => { release = resolve; }) });
  host.authenticate(); await waitFor(() => host.inspect().online);
  host.receive(raw({})); await waitFor(() => release); host.kick();
  release(new Map([['u_member', '10001']])); await delay(40);
  assert.equal(host.packets.some(p => p.event === 'message'), false);
  assert.equal(host.packets.some(p => p.event === 'contact' && p.data.user_id === 10001), false);
  assert.equal(host.inspect().online, false);
});

test('an unresolved sender does not block later valid messages in the same group', async t => {
  const host = await kernelHost(t);
  host.authenticate(); await waitFor(() => host.inspect().online);
  host.receive(raw({ msgId: '1' })); host.receive(raw({ msgId: '2', senderUid: 'u_second', senderUin: '10002' }));
  await waitFor(() => host.packets.filter(p => p.event === 'message').length === 2);
  const packets = host.packets.filter(p => p.event === 'message');
  assert.throws(() => normalizeMessage(packets[0].data, 10000), /no resolved sender/);
  assert.equal(normalizeMessage(packets[1].data, 10000).sender.user_id, 10002);
});
