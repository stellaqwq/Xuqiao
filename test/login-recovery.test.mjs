import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { KernelDriver } from '../src/qq/kernel-driver.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { kernelHost } from './kernel-host-harness.mjs';
import { config, temp, cleanup, waitFor } from './helpers.mjs';

test('manual login cancels stalled transport recovery and obtains a fresh QR', async t => {
  const host = await kernelHost(t);
  host.authenticate(); await waitFor(() => host.inspect().online);
  host.setTransport(0); await waitFor(() => host.inspect().state === 'connection_lost');
  const reads = host.reads, recovery = host.request('auth.restore');
  await waitFor(() => host.reads > reads);
  const reply = await host.request('auth.start').result;
  assert.ok((await recovery.result).error);
  assert.equal(reply.error, undefined); assert.match(reply.result.qrcode, /^data:image\/png;base64,/);
  assert.equal(host.inspect().state, 'waiting_scan'); assert.equal(host.inspect().online, false);
  assert.equal(host.qrRequests, 1); assert.equal(host.quickLogins, 0);
  assert.ok(host.packets.some(p => p.event === 'state' && p.data.state === 'requesting_qr' && p.data.reconnect === false));
  host.setTransport(1); await delay(60);
  assert.equal(host.inspect().online, false, 'the old transport cannot complete the new login');
  assert.equal((await host.request('auth.restore').result).result.state, 'waiting_scan');
  host.savedLoginCallback(); host.savedLoginFailed(); await delay(40);
  assert.equal(host.inspect().state, 'waiting_scan', 'late saved-login callbacks cannot replace QR authentication');
  assert.equal((await host.request('auth.start').result).result.handle, reply.result.handle);
  assert.equal(host.qrRequests, 1);
  host.authenticate(); await waitFor(() => host.inspect().online);
});

test('manual login bypasses a hung saved-account lookup and discards its late response', async t => {
  const host = await kernelHost(t); let release;
  host.setLoginListResponse(() => new Promise(resolve => { release = resolve; }));
  const recovery = host.request('auth.restore'); await waitFor(() => release);
  const reply = await host.request('auth.start').result;
  assert.equal(reply.error, undefined); assert.equal(reply.result.state, 'waiting_scan');
  assert.ok((await recovery.result).error);
  release({ result: 0, LocalLoginInfoList: [{ uin: '10000', isQuickLogin: true }] });
  await delay(40);
  assert.equal(host.quickLogins, 0); assert.equal(host.inspect().state, 'waiting_scan');
  assert.equal(host.inspect().requests, 0); assert.equal(host.sends, 0);
});

test('manual login also cancels a hung quick-login submission', async t => {
  const host = await kernelHost(t); let release;
  host.allowQuickLogin(); host.setQuickLoginResponse(() => new Promise(resolve => { release = resolve; }));
  const recovery = host.request('auth.restore'); await waitFor(() => release);
  const reply = await host.request('auth.start').result;
  assert.equal(reply.error, undefined); assert.equal(reply.result.state, 'waiting_scan');
  assert.ok((await recovery.result).error);
  release({ result: 0 }); await delay(40);
  assert.equal(host.quickLogins, 1); assert.equal(host.qrRequests, 1); assert.equal(host.inspect().online, false);
});

test('driver forwards manual login while connect is waiting on saved-session recovery', async t => {
  const configuration = config(await temp(t), { QQ_DRIVER: 'kernel' });
  const db = new DatabaseSync(':memory:'); cleanup(t, () => db.close());
  const child = new EventEmitter(); child.connected = true;
  const requests = [];
  child.send = (packet, callback) => {
    requests.push(packet); callback?.();
    if (packet.event === 'shutdown') queueMicrotask(() => { child.connected = false; child.emit('exit', 0); });
  };
  const driver = new KernelDriver({ config: configuration, ids: new MessageIdMap(db),
    verify: async () => ({ version: 'synthetic' }), spawn: () => {
      queueMicrotask(() => child.emit('message', { event: 'ready' })); return child;
    } });
  driver.on('fault', () => {}); cleanup(t, () => driver.close());
  await driver.connect(); driver.needsRecovery = true;
  const recovering = driver.connect(); await waitFor(() => requests.some(p => p.command === 'auth.restore'));
  const manual = driver.invoke('auth.start');
  await waitFor(() => requests.some(p => p.command === 'auth.start'));
  const packet = requests.find(p => p.command === 'auth.start');
  child.emit('message', { id: packet.id, result: { state: 'waiting_scan', handle: 'new-qr' } });
  assert.equal((await manual).handle, 'new-qr');
  const recovery = requests.find(p => p.command === 'auth.restore');
  child.emit('message', { id: recovery.id, error: { code: 1502, message: 'Cancelled old recovery' } });
  await assert.rejects(recovering, error => error.code === 1502);
  assert.equal(driver.pending.size, 0);
});
