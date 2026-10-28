import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { bundleQQ, verifyRuntime } from '../src/qq/kernel/runtime.mjs';
import { readPE } from '../src/qq/kernel/pe.mjs';
import { buildBridgeImage } from '../src/qq/kernel/bridge-image.mjs';
import { kernelText, normalizeMessage, SendTracker } from '../src/qq/kernel/messages.mjs';
import { KernelDriver } from '../src/qq/kernel-driver.mjs';
import { sdkAppId, loginOptions } from '../src/qq/kernel/profile.mjs';
import { waitForMessageService } from '../src/qq/kernel/session-ready.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { temp, config, cleanup } from './helpers.mjs';

const stop = '?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z';
test('login configuration uses the SDK ID from the exact QQ build and keeps SDK field types', () => {
  const appid = sdkAppId(Buffer.from('prefix\0QQAppId/537391628\0suffix'));
  assert.equal(appid, '537391628');
  assert.throws(() => sdkAppId(Buffer.from('no application marker')), /unique SDK/);
  assert.throws(() => sdkAppId(Buffer.from('QQAppId/537391628\0QQAppId/537340213\0')), /unique SDK/);
  const options = loginOptions({ appid, version: '9.9.36-53644', directory: 'data',
    machineId: '00000000-0000-0000-0000-000000000001', platformVersion: 'Windows', hostName: 'test' });
  assert.equal(options.appid, '537391628'); assert.equal(options.clientVer, '9.9.36-53644');
  assert.equal(typeof options.externalVersion, 'boolean');
  assert.throws(() => loginOptions({ appid, version: '9.9.36-53644', machineId: '' }), /incomplete/);
});

test('message binding yields after native initialization and waits for service wrappers to become available', async () => {
  let callbackActive = true, attempts = 0, bound = 0, handlers;
  const service = { addKernelMsgListener(value) { bound++; handlers = value; } };
  const session = { getMSFService: () => ({ getMsfStatus: () => 1 }), getMsgService() {
    assert.equal(callbackActive, false, 'service lookup must not run within the initialization callback');
    if (++attempts === 1) throw new TypeError('Cannot convert undefined or null to object');
    if (attempts === 2) return undefined; return service;
  } };
  const received = []; let kicked = 0;
  const pending = waitForMessageService({ session, makeListener: value => value, onMessages: (...args) => received.push(args),
    onKickedOffline: () => { kicked++; }, timeout: 500 });
  callbackActive = false;
  assert.equal(await pending, service); assert.equal(bound, 1);
  handlers.onRecvMsg('incoming'); handlers.onMsgInfoListUpdate('confirmation');
  assert.deepEqual(received, [['incoming', true], ['confirmation', false]]);
  handlers.onKickedOffLine(); assert.equal(kicked, 1, 'kick notifications arrive on the message listener');
});

test('an unavailable or cancelled message session never binds and releases its readiness timer', async () => {
  let bindings = 0;
  const session = { getMSFService: () => ({ getMsfStatus: () => 0 }), getMsgService: () => { bindings++; return {}; } };
  await assert.rejects(waitForMessageService({ session, makeListener: value => value, onMessages: () => {}, timeout: 20 }), error => error.code === 1502);
  const controller = new AbortController();
  const pending = waitForMessageService({ session, makeListener: value => value, onMessages: () => {}, signal: controller.signal, timeout: 500 }); controller.abort();
  await assert.rejects(pending, error => error.code === 1502);
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(bindings, 0);
});
test('native bridge is reproducible, resolves only host N-API exports, and rejects malformed images', async t => {
  const binary = buildBridgeImage([stop, 'qq_magic_napi_register', 'napi_get_undefined']);
  assert.deepEqual(binary, buildBridgeImage([stop, 'qq_magic_napi_register', 'napi_get_undefined']));
  const pe = readPE(binary);
  assert.equal(pe.exports.has(stop), true); assert.equal(pe.exports.has('napi_register_module_v1'), true);
  assert.deepEqual(pe.imports.map(i => i.library.value), ['node.exe']);
  assert.deepEqual(pe.imports[0].names.map(n => n.value), ['napi_add_env_cleanup_hook']);
  assert.throws(() => readPE(Buffer.alloc(100)), /Unsupported|malformed/);
  assert.throws(() => buildBridgeImage(['unrecognized']), /Unsupported/);
  if (process.platform === 'win32' && process.arch === 'x64') {
    const directory = await temp(t), dll = join(directory, 'QQNT.dll'); await writeFile(dll, binary);
    const result = spawnSync(process.execPath, ['-e', 'const m={exports:{}};process.dlopen(m,process.argv[1]);process.stdout.write("loaded")', dll], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'loaded');
  }
});

test('bundling preserves source program bytes, excludes logs, detects corruption and rejects inventory traversal', async t => {
  // Packaging fixture only; these bytes never claim to authenticate or send QQ messages.
  const root = await temp(t), source = join(root, 'installed'), app = join(source, 'resources', 'app'), target = join(root, 'bundled');
  await mkdir(app, { recursive: true }); await writeFile(join(source, 'QQ.exe'), 'packaging-fixture');
  const pkg = JSON.stringify({ name: 'qq-chat', version: 'fixture-1', main: 'original.js', eleArch: 'x64' });
  await writeFile(join(app, 'package.json'), pkg); await writeFile(join(app, 'wrapper.node'), 'fixture-kernel');
  await writeFile(join(app, 'debug.log'), 'excluded');
  await bundleQQ({ source: join(source, 'QQ.exe'), destination: target });
  const manifest = await verifyRuntime(target);
  assert.equal(manifest.entry_modified, false); assert.equal(manifest.binary_modified, false);
  assert.equal(await readFile(join(app, 'package.json'), 'utf8'), pkg);
  assert.equal(await readFile(join(target, 'resources', 'app', 'package.json'), 'utf8'), pkg);
  assert.equal(manifest.files.some(f => f.path.endsWith('debug.log')), false);
  await writeFile(join(target, 'resources', 'app', 'wrapper.node'), 'corrupted');
  await assert.rejects(verifyRuntime(target), /integrity mismatch/);
  const traversal = join(root, 'traversal'); await mkdir(traversal);
  await writeFile(join(traversal, 'runtime.json'), JSON.stringify({ schema: 1, files: [{ path: '../escape', bytes: 1, sha256: '' }] }));
  await assert.rejects(verifyRuntime(traversal), /inventory path/);
});

const raw = (extra = {}) => ({ chatType: 1, peerUid: 'u_contact', senderUin: '10001', senderUid: 'u_contact',
  msgId: '987654321098765432', msgTime: '1700000000', elements: [{ elementType: 1, textElement: { content: 'hello', atType: 0 } }], ...extra });
test('kernel message identities retain large IDs and unresolved mentions never impersonate self mentions', () => {
  const message = normalizeMessage(raw(), 10000);
  assert.equal(message.sender.user_id, 10001); assert.match(message.nativeId, /987654321098765432/);
  const unknownAt = normalizeMessage(raw({ elements: [{ elementType: 1, textElement: { content: '@unknown', atType: 2 } }] }), 10000);
  assert.deepEqual(unknownAt.message, [{ type: 'text', data: { text: '@unknown' } }]);
  const group = normalizeMessage(raw({ chatType: 2, peerUid: '20000', selfUid: 'u_self',
    elements: [{ elementType: 1, textElement: { content: '@self', atType: 2, atNtUid: 'u_self' } }] }), 10000);
  assert.equal(group.groupId, 20000); assert.equal(group.message[0].data.qq, '10000');
  assert.throws(() => normalizeMessage(raw({ senderUin: '0' }), 10000), /identity/);
  assert.throws(() => kernelText([{ type: 'image', data: { file: 'x' } }]), /text segments only/);
});

test('send completion requires a terminal update matching both native ID and conversation', async () => {
  const tracker = new SendTracker(500);
  const entry = tracker.wait(raw()); let done = false; entry.promise.then(() => { done = true; });
  tracker.update(raw({ sendStatus: 1 })); tracker.update(raw({ sendStatus: 2, peerUid: 'u_other' }));
  await Promise.resolve(); assert.equal(done, false);
  tracker.update(raw({ sendStatus: 2 })); assert.equal((await entry.promise).msgId, raw().msgId);
  assert.equal(tracker.pending.size, 0);
  const failure = tracker.wait(raw()); tracker.update(raw({ sendStatus: 0 }));
  await assert.rejects(failure.promise, error => error.code === 1500 && !error.uncertain);
});

test('lost send confirmation and cancellation remain uncertain and clean up pending sends', async () => {
  const tracker = new SendTracker(20);
  await assert.rejects(tracker.wait(raw()).promise, error => error.code === 1502 && error.uncertain);
  const controller = new AbortController(), entry = tracker.wait(raw(), controller.signal); controller.abort();
  await assert.rejects(entry.promise, error => error.uncertain);
  assert.equal(tracker.pending.size, 0);
});

async function fakeDriver(t, env = {}) {
  const directory = await temp(t), configuration = config(directory, { QQ_DRIVER: 'kernel', ...env });
  const db = new DatabaseSync(':memory:'); cleanup(t, () => db.close());
  const child = new EventEmitter(); child.connected = true;
  const exit = () => { child.connected = false; child.exitCode = 0; child.emit('exit', 0); };
  child.kill = () => { child.killed = true; queueMicrotask(exit); };
  child.disconnect = () => { child.connected = false; };
  child.send = (packet, callback) => { child.lastRequest = packet; callback?.(); if (packet.event === 'shutdown') queueMicrotask(exit); };
  const driver = new KernelDriver({ config: configuration, ids: new MessageIdMap(db), verify: async () => ({ version: 'synthetic-host' }),
    spawn: () => { queueMicrotask(() => child.emit('message', { event: 'ready', data: { loaded: true } })); return child; } });
  driver.on('fault', () => {}); cleanup(t, () => driver.close());
  await driver.connect(); return { driver, child };
}
test('synthetic host readiness never means logged in; IDs persist and process loss leaves sends uncertain', async t => {
  const { driver, child } = await fakeDriver(t);
  assert.equal(driver.online, false); assert.equal(driver.diagnostics().core_loaded, true);
  child.emit('message', { event: 'state', data: { online: true, state: 'online', account: 10000 } });
  assert.equal(driver.online, false);
  child.emit('message', { event: 'state', data: { online: true, authenticated: true, state: 'online', account: 10000 } });
  assert.equal(driver.online, true);
  const events = []; driver.on('message', message => events.push(message));
  for (let i = 0; i < 2; i++) child.emit('message', { event: 'message', data: raw() });
  assert.equal(events[0].id, events[1].id);
  assert.equal((await driver.invoke('message.get', { messageId: events[0].id })).real_id, raw().msgId);
  const sending = driver.invoke('message.send', { kind: 'group', target: 20000, message: [{ type: 'text', data: { text: 'test' } }] });
  child.emit('exit', 1);
  await assert.rejects(sending, error => error.code === 1502 && error.uncertain);
  assert.equal(driver.online, false); assert.equal(driver.pending.size, 0);
});
test('a different scanned account terminates the synthetic host before accepting messages', async t => {
  const { driver, child } = await fakeDriver(t, { QQ_ACCOUNT: '10000' });
  child.emit('message', { event: 'state', data: { online: true, authenticated: true, state: 'online', account: 10001 } });
  assert.equal(child.killed, true); assert.equal(driver.online, false); assert.equal(driver.account, 10000);
});

test('kernel resolves reply IDs within the same account and conversation before submitting',async t=>{
  const {driver,child}=await fakeDriver(t);
  child.emit('message',{event:'state',data:{online:true,authenticated:true,state:'online',account:10000}});
  child.emit('message',{event:'contact',data:{user_id:10001,uid:'u_contact',nickname:'发送者'}});
  const source=driver.saveMessage(raw({chatType:2,peerUid:'20000',msgSeq:'42',clientSeq:'8'}));
  const message=[{type:'reply',data:{id:String(source.id)}},{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'回答'}}];
  await assert.rejects(driver.invoke('message.send',{kind:'group',target:30000,message}),error=>error.code===1400);
  await assert.rejects(driver.invoke('message.send',{kind:'private',target:10001,message}),error=>error.code===1400);
  const pending=driver.invoke('message.send',{kind:'group',target:20000,message});
  const packet=child.lastRequest;assert.equal(packet.params.replySource.msgSeq,'42');assert.equal(packet.params.replyIdentity.peerUid,'20000');assert.equal(packet.params.mentions['10001'].uid,'u_contact');
  child.emit('message',{id:packet.id,error:{message:'fixture rejection',code:1500}});await assert.rejects(pending);
});
