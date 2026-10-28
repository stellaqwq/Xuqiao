import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { QQAdapter } from '../src/qq/adapter.mjs';
import { KernelDriver, assertKernelPlatform, captureHostStderr } from '../src/qq/kernel-driver.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { SendTracker } from '../src/qq/kernel/messages.mjs';
import { sendKernelText } from '../src/qq/kernel/send.mjs';
import { quickLoginAccount, shutdownKernel } from '../src/qq/kernel/lifecycle.mjs';
import { buddyListArity } from '../src/qq/kernel/profile.mjs';
import { fetchKernelFriends, fetchKernelGroups, resolveContactUid } from '../src/qq/kernel/contacts.mjs';
import { sourceFiles, exportSource } from '../scripts/source-package.mjs';
import { app, config, temp, cleanup, waitFor, incoming } from './helpers.mjs';

test('driver startup failure rejects the app, releases its lock, and closes the driver', async t => {
  const directory = await temp(t);
  class BrokenDriver extends QQDriver {
    async connect() { throw new Error('synthetic startup failure'); }
    async close() { this.wasClosed = true; }
  }
  const driver = new BrokenDriver();
  const configuration = config(directory);
  await assert.rejects(createApp(configuration, { driver, log: () => {} }), /synthetic startup failure/);
  assert.equal(driver.wasClosed, true);
  await assert.rejects(access(join(directory, 'runtime.lock')), { code: 'ENOENT' });
  const replacement = await createApp(configuration, { log: () => {} });
  cleanup(t, () => replacement.close());
  assert.equal(replacement.adapter.status().online, true);
});

test('kernel rejects unsupported platforms, and the Linux entrypoint exits before listening', async () => {
  assert.doesNotThrow(() => assertKernelPlatform('win32', 'x64'));
  for (const [platform, architecture] of [['linux', 'x64'], ['win32', 'arm64']]) {
    assert.throws(() => assertKernelPlatform(platform, architecture), error => error.reason === 'kernel_requires_windows_x64');
  }
  const child = spawn(process.execPath, ['scripts/container.mjs'], {
    cwd: resolve('.'), env: { ...process.env, QQ_DRIVER: 'kernel' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(code, 1); assert.match(output, /Windows x64/); assert.doesNotMatch(output, /onebot_listening/);
});

async function kernel(t, options = {}) {
  const directory = await temp(t);
  const db = new DatabaseSync(':memory:'); cleanup(t, () => db.close());
  const children = [], writes = [];
  const configuration = config(directory, { QQ_DRIVER: 'kernel', QQ_SHUTDOWN_TIMEOUT_MS: '100' });
  const driver = new KernelDriver({ config: configuration, ids: new MessageIdMap(db),
    verify: async () => ({ version: 'synthetic-host' }),
    writeEvidence: async (_, content) => { writes.push(JSON.parse(content)); },
    spawn: cfg => {
      const child = new EventEmitter(); child.connected = true; child.account = cfg.account; child.requests = [];
      child.finish = code => { child.connected = false; child.exitCode = code; child.emit('exit', code); };
      child.kill = () => { child.killed = true; queueMicrotask(() => child.finish(1)); };
      child.send = (packet, callback) => {
        child.requests.push(packet); callback?.();
        if (packet.event === 'shutdown') {
          child.shutdownRequested = true;
          if (!options.manualStop) queueMicrotask(() => child.finish(0));
        } else if (packet.command === 'auth.restore') {
          queueMicrotask(() => {
            const data = options.loginRequired ? { state: 'login_required', online: false, reconnect: false } :
              { state: 'online', online: true, account: 10000, authenticated: true };
            child.emit('message', { event: 'state', data });
            child.emit('message', { id: packet.id, result: { state: data.state } });
          });
        }
      };
      children.push(child);
      queueMicrotask(() => child.emit('message', { event: 'ready' })); return child;
    }
  });
  driver.on('fault', () => {}); cleanup(t, () => driver.close());
  await driver.connect();
  const state = (child, data) => child.emit('message', { event: 'state', data });
  return { driver, children, writes, state, configuration };
}

test('kernel process loss triggers adapter reconnection, pins the account and rejects stale host events', async t => {
  const { driver, children, state, configuration } = await kernel(t);
  const adapter = new QQAdapter(driver, configuration); cleanup(t, () => adapter.close());
  const first = children[0];
  state(first, { state: 'online', online: true, authenticated: true, account: 10000 });
  await writeFile(join(configuration.kernel.data, 'host-stderr.log'), 'native crash detail');
  first.finish(1);
  assert.equal(adapter.status().online, false); assert.ok(adapter.reconnectTimer);
  await waitFor(() => children.length === 2);
  assert.equal(children[1].account, 10000);
  assert.equal(await readFile(join(configuration.kernel.data, 'host-stderr.previous.log'), 'utf8'), 'native crash detail');
  assert.equal(driver.online, false, 'loading a replacement host cannot fabricate authentication');
  state(first, { state: 'online', online: true, authenticated: true, account: 10001 });
  assert.equal(driver.account, 10000); assert.equal(driver.online, false);
  state(children[1], { state: 'online', online: true, authenticated: true, account: 10000 });
  assert.equal(adapter.reconnectTimer, null);
});

test('kernel connection loss restores the existing host; authentication rejection stops retries', async t => {
  for (const loginRequired of [false, true]) {
    const { driver, children, state, configuration } = await kernel(t, { loginRequired });
    const adapter = new QQAdapter(driver, configuration); cleanup(t, () => adapter.close());
    state(children[0], { state: 'online', online: true, authenticated: true, account: 10000 });
    state(children[0], { state: loginRequired ? 'kicked' : 'connection_lost', online: false, reconnect: true });
    await waitFor(() => children[0].requests.some(packet => packet.command === 'auth.restore'));
    await waitFor(() => !driver.connecting);
    assert.equal(children.length, 1); assert.equal(driver.online, !loginRequired);
    assert.equal(adapter.reconnectTimer, null);
  }
});

test('logout cancels pending reconnects and waits for the host to exit', async t => {
  const { driver, children, state, configuration } = await kernel(t, { manualStop: true });
  const adapter = new QQAdapter(driver, configuration); cleanup(t, () => adapter.close());
  const child = children[0];
  state(child, { state: 'connection_lost', online: false, reconnect: true });
  let finished = false;
  const logout = adapter.login('logout', {}).then(value => { finished = true; return value; });
  await waitFor(() => child.shutdownRequested);
  assert.equal(finished, false); assert.equal(adapter.reconnectTimer, null);
  child.finish(0);
  assert.equal((await logout).disconnected, true); assert.equal(child.killed, undefined);
  await driver.connect(); assert.equal(children.length, 1);
});

test('unresponsive hosts are force stopped only after the shutdown grace period', async t => {
  const { driver, children } = await kernel(t, { manualStop: true });
  const closing = driver.close();
  assert.equal(children[0].killed, undefined);
  await closing; assert.equal(children[0].killed, true);
});

test('native stderr is retained locally with a bounded size', async t => {
  const directory = await temp(t), path = join(directory, 'stderr.log');
  const child = new EventEmitter(); child.stderr = new PassThrough();
  const finished = captureHostStderr(child, path);
  child.stderr.end(Buffer.alloc(300 * 1024, 'x'));
  await finished;
  assert.equal((await readFile(path)).length, 256 * 1024);
});

test('validation writes only change when state or a milestone changes', async t => {
  const { driver, children, writes, state } = await kernel(t);
  const child = children[0];
  state(child, { state: 'online', online: true, authenticated: true, account: 10000 });
  await driver.recordEvidence(); const before = writes.length;
  for (let i = 0; i < 100; i++) child.emit('message', { event: 'message', data: {
    chatType: 1, peerUid: 'u_contact', senderUin: '10001', senderUid: 'u_contact', msgId: String(i + 1),
    msgTime: String(Math.floor(Date.now() / 1000)), elements: [{ elementType: 1, textElement: { content: 'private body' } }]
  } });
  await driver.recordEvidence();
  assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).messages_received, true);
  assert.equal(JSON.stringify(writes).includes('private body'), false);
});

test('first private send resolves UID through the SDK and still requires a terminal acknowledgement', async () => {
  const tracker = new SendTracker(500), learned = []; let calls = 0;
  const session = { getUixConvertService: () => ({ async getUid(ids) {
    assert.deepEqual(ids, ['10001']); return { uidInfo: new Map([['10001', 'u_recipient']]) };
  } }) };
  const msgService = { generateMsgUniqueId: () => '123', async sendMsg(msgId, peer, elements) {
    calls++; assert.equal(peer.peerUid, 'u_recipient');
    queueMicrotask(() => tracker.update({ ...peer, msgId, sendStatus: 2, elements })); return { result: 0 };
  } };
  const result = await sendKernelText({ session, msgService, self: { uin: '10000', uid: 'u_self' }, contacts: new Map(),
    learn: value => learned.push(value), tracker }, { kind: 'private', target: 10001, message: [{ type: 'text', data: { text: 'hello' } }] }, new AbortController().signal);
  assert.equal(result.raw.peerUid, 'u_recipient'); assert.equal(calls, 1); assert.equal(learned[0].uin, '10001');
  await assert.rejects(resolveContactUid({ getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map() }) }) }, 10002), error => error.code === 1404);
});

test('kernel friend and group lists support SDK results, callback results and UID-only categories', async () => {
  const callbacks = new EventEmitter(), learned = [];
  const session = {
    getBuddyService: () => ({ getBuddyListV2: async (...args) => {
      assert.deepEqual(args, ['qq-ai-bot', true, 0]); return { result: 0, data: [{ buddyUids: ['u_friend'] }] };
    } }),
    getUixConvertService: () => ({ getUin: async () => new Map([['u_friend', '10001']]) }),
    getProfileService: () => ({ getCoreAndBaseInfo: () => new Map([['u_friend', { coreInfo: { nick: 'Friend', remark: 'Remark' } }]]) }),
    getGroupService: () => ({ getGroupList: async () => {
      callbacks.emit('group-list', 0, [{ groupCode: '20000', groupName: 'Group', memberCount: 3 }]);
      return { result: 0 };
    } })
  };
  assert.deepEqual(await fetchKernelFriends(session, callbacks, undefined, value => learned.push(value)), [{ user_id: 10001, nickname: 'Friend', remark: 'Remark' }]);
  assert.equal(learned[0].uid, 'u_friend');
  assert.deepEqual(await fetchKernelGroups(session, callbacks), [{ group_id: 20000, group_name: 'Group', member_count: 3 }]);
  assert.equal(callbacks.eventNames().length, 0);
  const controller = new AbortController();
  const missing = fetchKernelGroups({ getGroupService: () => ({ getGroupList: async () => ({ result: 0 }) }) }, callbacks, controller.signal);
  controller.abort(); await assert.rejects(missing, error => error.code === 1502);
  assert.equal(callbacks.eventNames().length, 0);
});

test('quick login selects one eligible account, rejects expired credentials and obeys cancellation', async () => {
  let calls = 0;
  const records = [{ uin: '10000', isQuickLogin: true }, { uin: '10001', isAutoLogin: true }];
  const login = { getLoginList: async () => ({ result: 0, LocalLoginInfoList: records }),
    quickLoginWithUin: async uin => { calls++; assert.equal(uin, '10000'); return { result: '0' }; } };
  assert.equal(await quickLoginAccount(login, 0), null); assert.equal(calls, 0);
  assert.equal(await quickLoginAccount(login, 10000), 10000); assert.equal(calls, 1);
  assert.equal(await quickLoginAccount(login, 10002), null);
  await assert.rejects(quickLoginAccount({ ...login, quickLoginWithUin: async () => ({ result: '1' }) }, 10000), error => error.code === 1401 && !error.retryable);
  const controller = new AbortController();
  const hung = quickLoginAccount({ getLoginList: () => new Promise(() => {}) }, 10000, controller.signal);
  controller.abort(); await assert.rejects(hung, error => error.code === 1502);
});

test('graceful SDK shutdown cancels requests then waits for services in order', async () => {
  const order = [], controller = new AbortController();
  await shutdownKernel({ requests: new Map([[1, controller]]), tracker: { close() { assert.equal(controller.signal.aborted, true); order.push('tracker'); } },
    startup: { async stop() { order.push('session'); } }, login: { destroy() { order.push('login'); } }, engine: { destroy() { order.push('engine'); } } });
  assert.deepEqual(order, ['tracker', 'session', 'login', 'engine']);
});

test('slow conversations do not block other conversations and each session keeps its history order', async t => {
  let releaseSlow, startedSlow = false;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  let active = 0, maximum = 0; const calls = [];
  const bot = await app(t, { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001,10002,10003', AI_CONCURRENCY: '2' }, {
    ai: { async reply(input, history) {
      active++; maximum = Math.max(maximum, active); calls.push({ input, history });
      try { if (input === 'slow') { startedSlow = true; return await slow; } return 'answer ' + input; }
      finally { active--; }
    } }
  });
  cleanup(t, () => releaseSlow('slow answer'));
  bot.adapter.driver.inject(incoming(101, { message: 'slow' }));
  bot.adapter.driver.inject(incoming(102, { message: 'next in slow session' }));
  bot.adapter.driver.inject(incoming(103, { sender: { user_id: 10002 }, message: 'fast' }));
  bot.adapter.driver.inject(incoming(104, { sender: { user_id: 10003 }, message: 'also fast' }));
  await waitFor(() => startedSlow && bot.store.summary().done === 2);
  assert.equal(calls.some(call => call.input === 'next in slow session'), false);
  assert.equal(maximum, 2);
  releaseSlow('slow answer'); await waitFor(() => bot.store.summary().done === 4);
  assert.deepEqual(calls.find(call => call.input === 'next in slow session').history,
    [{ role: 'user', content: 'slow' }, { role: 'assistant', content: 'slow answer' }]);
});

test('AI concurrency is bounded in config', () => {
  assert.equal(config('unused').ai.concurrency, 4);
  for (const value of ['0', '17', '1.5']) assert.throws(() => config('unused', { AI_CONCURRENCY: value }), /AI_CONCURRENCY/);
});

test('buddy list signature is selected from the exact official binary, including the new source argument', async () => {
  for (const arity of [2, 3]) assert.equal(buddyListArity(Buffer.from(`NodeIKernelBuddyService::getBuddyListV2 needs ${arity} arguments`)), arity);
  assert.throws(() => buddyListArity(Buffer.from('unknown')), /signature/);
  assert.throws(() => buddyListArity(Buffer.from('NodeIKernelBuddyService::getBuddyListV2 needs 4 arguments')), /signature/);
  let args;
  const session = { getBuddyService: () => ({ getBuddyListV2: async (...value) => { args = value; return { result: 0, data: [] }; } }),
    getProfileService: () => ({ getCoreAndBaseInfo: () => new Map() }) };
  assert.deepEqual(await fetchKernelFriends(session, new EventEmitter(), undefined, () => {}, 2), []);
  assert.deepEqual(args, [true, 0]);
});

test('source export excludes secrets, account directories, databases and runtime files without Git', async t => {
  const root = resolve('.'), directory = await temp(t), destination = join(directory, 'source');
  const files = await sourceFiles(root);
  assert.ok(files.includes('.env.example')); assert.ok(files.includes('src/main.mjs'));
  assert.ok(files.every(name => !/^(?:\.env$|data\/|runtime\/|node_modules\/)|\.sqlite|\.session/.test(name)));
  const result = await exportSource(root, destination); assert.equal(result.files, files.length);
  const manifest = JSON.parse(await readFile(join(destination, 'SOURCE-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.files.length, files.length);
  await assert.rejects(access(join(destination, '.env')), { code: 'ENOENT' });
  await assert.rejects(access(join(destination, 'data')), { code: 'ENOENT' });
  await assert.rejects(exportSource(root, destination), { code: 'EEXIST' });
  // Even files hidden inside otherwise permitted source directories are excluded.
  const fixture = join(directory, 'fixture'); await mkdir(fixture);
  for (const name of ['src', 'scripts', 'test', 'docs', 'native', 'examples']) await mkdir(join(fixture, name));
  for (const name of ['package.json', 'package-lock.json', 'README.md', '.env.example', '.gitignore', '.dockerignore', '.npmignore', 'Dockerfile', 'compose.yaml', 'start.cmd']) await writeFile(join(fixture, name), 'example');
  await writeFile(join(fixture, 'src', '.env'), 'secret'); await writeFile(join(fixture, 'src', 'bot.sqlite'), 'secret');
  await mkdir(join(fixture, 'src', 'data')); await writeFile(join(fixture, 'src', 'data', 'session.mjs'), 'secret');
  assert.equal((await sourceFiles(fixture)).some(name => name.startsWith('src/')), false);
});
