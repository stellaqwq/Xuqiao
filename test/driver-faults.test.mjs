import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BotError } from '../src/errors.mjs';
import { describeDriverFault } from '../src/qq/faults.mjs';
import { normalizeMessage } from '../src/qq/kernel/messages.mjs';
import { KernelDriver } from '../src/qq/kernel-driver.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { app, config, temp, cleanup, request } from './helpers.mjs';

const raw = extra => ({ chatType: 1, peerUid: 'u_peer', senderUin: '10001', senderUid: 'u_peer',
  msgId: '123456789', msgTime: '1793000000', elements: [{ elementType: 1, textElement: { content: 'private message' } }], ...extra });

test('fault diagnostics distinguish invalid message metadata without leaking the packet', () => {
  for (const [change, reason] of [
    [{ chatType: 9 }, 'message_conversation_unsupported'],
    [{ msgId: '' }, 'message_id_missing'],
    [{ peerUid: '' }, 'message_peer_missing'],
    [{ senderUin: '0' }, 'message_sender_unresolved'],
    [{ msgTime: 'invalid' }, 'message_timestamp_invalid'],
    [{ chatType: 2, peerUid: 'not-a-group' }, 'message_group_invalid']
  ]) {
    assert.throws(() => normalizeMessage(raw(change), 10000), error => {
      assert.deepEqual(describeDriverFault(error), { code: 1500, reason }); return true;
    });
  }
});

test('unknown exceptions and untrusted reason fields never expose text or credentials', () => {
  const secret = 'private-text Bearer credential C:\\private\\path';
  for (const error of [new Error(secret), Object.assign(new BotError(secret), { reason: secret }), { code: secret, message: secret }, null]) {
    assert.deepEqual(describeDriverFault(error), { code: 1500, reason: 'driver_operation_failed' });
  }
});

test('kernel retains one safe fault while continuing to accept valid incoming messages', async t => {
  const db = new DatabaseSync(':memory:'); cleanup(t, () => db.close());
  const driver = new KernelDriver({ config: config(await temp(t), { QQ_DRIVER: 'kernel', QQ_ACCOUNT: '10000' }),
    ids: new MessageIdMap(db), writeEvidence: async () => {} });
  const child = driver.child = {};
  driver.online = true; driver.state = 'online';
  const faults = [], messages = [];
  driver.on('fault', error => faults.push(describeDriverFault(error)));
  driver.on('message', message => messages.push(message));
  driver.receive({ event: 'message', data: raw({ senderUin: '0' }) }, child);
  assert.deepEqual(faults, [{ code: 1500, reason: 'message_sender_unresolved' }]);
  const info = driver.diagnostics();
  assert.equal(info.last_fault.reason, 'message_sender_unresolved'); assert.ok(!Number.isNaN(Date.parse(info.last_fault.time)));
  assert.ok(!JSON.stringify(info.last_fault).includes('private message'));
  info.last_fault.reason = 'changed externally';
  assert.equal(driver.diagnostics().last_fault.reason, 'message_sender_unresolved');
  driver.receive({ event: 'message', data: raw({}) }, child);
  assert.equal(messages.length, 1); assert.equal(driver.online, true); assert.equal(faults.length, 1);
  await driver.evidenceWrite;
});

test('admin fault logs expose fixed reasons while omitting raw errors and preserving online state', async t => {
  const bot = await app(t);
  bot.adapter.driver.emit('fault', new BotError('QQ message identity has no resolved sender', 1500));
  bot.adapter.driver.emit('fault', Object.assign(new Error('secret-chat-and-token'), { reason: 'secret-token' }));
  const { data } = await request(bot, '/admin/telemetry');
  const logs = data.entries.filter(e => e.kind === 'log' && e.event === 'qq_driver_fault');
  assert.deepEqual(logs.map(e => e.fields), [
    { code: 1500, reason: 'message_sender_unresolved' }, { code: 1500, reason: 'driver_operation_failed' }
  ]);
  assert.ok(!JSON.stringify(logs).includes('secret'));
  assert.equal((await request(bot, '/get_status')).data.data.online, true);
});
