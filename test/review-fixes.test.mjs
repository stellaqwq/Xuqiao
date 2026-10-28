import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { lockData } from '../src/data-lock.mjs';
import { AIClient } from '../src/ai.mjs';
import { ReplyWorker } from '../src/worker.mjs';
import { Store } from '../src/store.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { KernelDriver } from '../src/qq/kernel-driver.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { QQAdapter } from '../src/qq/adapter.mjs';
import { SendTracker, kernelText } from '../src/qq/kernel/messages.mjs';
import { sendKernelText } from '../src/qq/kernel/send.mjs';
import { SendLimiter } from '../src/limiter.mjs';
import { app, config, temp, cleanup, waitFor, withTestTimeout } from './helpers.mjs';
import { kernelHost } from './kernel-host-harness.mjs';

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('stale-lock recovery is exclusive across processes and a crashed owner is recoverable', async t => {
  const directory = await temp(t), children = [];
  const contender = (pause = false) => {
    const child = fork(fileURLToPath(new URL('./lock-owner-fixture.mjs', import.meta.url)), [directory, ...(pause ? ['pause-stale-check'] : [])],
      { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', value => { child.result = value; }); child.on('error', error => { child.result = { error: error.message }; });
    child.stderr.resume(); child.done = new Promise(resolve => child.once('exit', resolve)); children.push(child); return child;
  };
  cleanup(t, async () => { for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill(); await Promise.all(children.map(child => child.done)); });
  await writeFile(join(directory, 'runtime.lock'), '2147483646');
  const first = contender(true);
  await waitFor(() => existsSync(join(directory, 'checking-stale-owner')));
  const competing = contender(); await waitFor(() => competing.result);
  assert.match(competing.result.error, /Another QQ bot/); await competing.done;
  await writeFile(join(directory, 'continue-owner-check'), '1');
  await waitFor(() => first.result); assert.equal(first.result.owned, true);
  assert.equal(JSON.parse(await readFile(join(directory, 'runtime.lock'), 'utf8')).pid, first.pid);
  first.kill(); await first.done;
  const replacement = contender(); await waitFor(() => replacement.result);
  assert.equal(replacement.result.owned, true);
  replacement.send('close'); await replacement.done;
  assert.equal(existsSync(join(directory, 'runtime.lock')), false);
});

test('data locking respects a running legacy PID owner and release preserves another marker', async t => {
  const directory = await temp(t), marker = join(directory, 'runtime.lock');
  await writeFile(marker, String(process.pid));
  assert.throws(() => lockData(directory), /Another QQ bot/);
  await writeFile(marker, '2147483646');
  const release = lockData(directory);
  assert.throws(() => lockData(directory), /Another QQ bot/);
  await writeFile(marker, 'another-owner');
  release(); release();
  assert.equal(await readFile(marker, 'utf8'), 'another-owner');
});

test('a stale versioned marker remains recoverable when the operating system reuses its PID', async t => {
  const directory = await temp(t), marker = join(directory, 'runtime.lock');
  const first = lockData(directory), previous = await readFile(marker, 'utf8'); first();
  // The PID is still live in this test, just as it can be reused after a crash.
  await writeFile(marker, previous);
  const second = lockData(directory);
  try {
    assert.notEqual(await readFile(marker, 'utf8'), previous);
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, process.pid);
  } finally { second(); }
});

test('a kick cancels old network recovery and requires fresh authentication before returning online', async t => {
  const host = await kernelHost(t);
  host.authenticate(); await waitFor(() => host.inspect().online);
  const oldListener = host.messageListeners.at(-1);
  host.setTransport(0); await waitFor(() => host.inspect().state === 'connection_lost');
  const reads = host.reads, recovery = host.request('auth.restore');
  await waitFor(() => host.reads > reads);
  host.kick(); host.setTransport(1);
  assert.ok((await recovery.result).error);
  await delay(60);
  assert.equal(host.inspect().state, 'kicked'); assert.equal(host.inspect().online, false); assert.equal(host.quickLogins, 0);
  host.allowQuickLogin();
  assert.equal((await host.request('auth.restore').result).error, undefined);
  assert.equal(host.inspect().online, true); assert.equal(host.quickLogins, 1);
  oldListener.onKickedOffLine();
  assert.equal(host.inspect().online, true, 'callbacks from the old session must not affect the new session');
});

test('a late SDK initialization callback cannot undo a kick', async t => {
  const host = await kernelHost(t, { autoInitialize: false });
  host.authenticate(); await waitFor(() => host.inspect().state === 'initializing_session');
  host.kickDuringInitialization(); host.initialize(); await delay(40);
  assert.equal(host.inspect().state, 'kicked'); assert.equal(host.inspect().online, false);
});

test('cancelling a hung SDK send releases its host request and keeps delivery uncertain', async t => {
  const host = await kernelHost(t, { sendMessage: () => new Promise(() => {}) });
  host.authenticate(); await waitFor(() => host.inspect().online);
  const sending = host.request('message.send', { kind: 'private', target: 10001, peerUid: 'u_peer', message: [{ type: 'text', data: { text: 'test' } }] });
  await waitFor(() => host.sends === 1);
  assert.equal(host.inspect().requests, 1); host.cancel(sending.id);
  const reply = await sending.result;
  assert.equal(reply.error.code, 1502); assert.equal(reply.error.uncertain, true); assert.equal(reply.error.retryable, false);
  await waitFor(() => host.inspect().requests === 0);
  assert.equal((await host.request('account.get').result).result.user_id, 10000);
  assert.equal(host.sends, 1);
});

test('SDK acceptance remains bounded even if a terminal ACK arrives before its Promise returns', async () => {
  const tracker = new SendTracker(30);
  const msgService = { generateMsgUniqueId: () => '123', sendMsg(id, peer) {
    queueMicrotask(() => tracker.update({ ...peer, msgId: id, sendStatus: 2 })); return new Promise(() => {});
  } };
  await assert.rejects(sendKernelText({ session: {}, msgService, self: { uin: '10000', uid: 'u_self' },
    contacts: new Map([[10001, { uid: 'u_peer' }]]), tracker },
    { kind: 'private', target: 10001, message: [{ type: 'text', data: { text: 'test' } }] }, new AbortController().signal), error => error.code === 1502 && error.uncertain && !error.retryable);
  assert.equal(tracker.pending.size, 0);
});

test('AI body timeouts retry within the configured attempt budget and eventually send once', async () => {
  const original = globalThis.fetch, store = new Store(':memory:'); let calls = 0, sends = 0;
  try {
    globalThis.fetch = async (_, options) => {
      if (++calls > 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Body timed out', 'AbortError')), { once: true });
      } }));
    };
    const cfg = config('unused', { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001', AI_TIMEOUT_MS: '30', AI_MAX_ATTEMPTS: '3' });
    const worker = new ReplyWorker({ adapter: { status: () => ({ online: true }), action: async () => { sends++; } }, store, ai: new AIClient(cfg.ai), config: cfg, log: () => {} });
    worker.ingest({ self_id: 10000, user_id: 10001, post_type: 'message', message_type: 'private', message_id: 1, message: 'question' });
    await withTestTimeout(() => worker.step()); assert.equal(store.get(1).status, 'queued'); assert.equal(store.get(1).attempts, 1);
    // Advance the persisted backoff without slowing this regression test.
    store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=1').run();
    await worker.step(); assert.equal(store.get(1).status, 'ready'); assert.equal(store.get(1).attempts, 2);
    await worker.step(); assert.equal(store.get(1).status, 'done'); assert.equal(sends, 1); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; store.close(); }
});

test('AI body connection errors are retryable but shutdown cancellation and invalid JSON are not', async () => {
  const original = globalThis.fetch, cfg = config('unused').ai;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Connection reset')); } }));
    await assert.rejects(new AIClient(cfg).reply('question', [], new AbortController().signal), error => error.retryable === true);
    const controller = new AbortController();
    globalThis.fetch = async () => {
      controller.abort(); return new Response(new ReadableStream({ start(stream) { stream.error(new DOMException('Cancelled', 'AbortError')); } }));
    };
    await assert.rejects(new AIClient(cfg).reply('question', [], controller.signal), error => error.retryable === false);
    globalThis.fetch = async () => new Response('invalid json');
    await assert.rejects(new AIClient(cfg).reply('question', [], new AbortController().signal), error => error.retryable === false);
  } finally { globalThis.fetch = original; }
});

test('scheduled store cleanup prunes old driver caches and unreferenced IDs while preserving retained messages', () => {
  const store = new Store(':memory:');
  try {
    const ids = new MessageIdMap(store.db), cfg = config('unused');
    new KernelDriver({ config: cfg, ids });
    store.db.exec('CREATE TABLE native_messages(account TEXT, message_id INTEGER, content TEXT, time INTEGER)');
    const now = Math.floor(Date.now() / 1000), old = now - 30 * 86400;
    const expired = ids.allocate(10000, 'expired'), retained = ids.allocate(10000, 'retained');
    const recentMapping = ids.allocate(10000, 'recently-observed'), orphan = ids.allocate(10000, 'orphan');
    const nativeExpired = ids.allocate(10000, 'native-expired'), nativeRetained = ids.allocate(10000, 'native-retained');
    store.db.prepare('UPDATE native_message_ids SET last_seen=? WHERE onebot_id!=?').run(old, recentMapping);
    const add = store.db.prepare('INSERT INTO kernel_messages VALUES (?,?,?,?)');
    add.run('10000', expired, 'expired body', old); add.run('10000', retained, 'retained body', now); add.run('10000', recentMapping, 'old synchronized body', old);
    const native = store.db.prepare('INSERT INTO native_messages VALUES (?,?,?,?)');
    native.run('10000', nativeExpired, 'expired native body', old); native.run('10000', nativeRetained, 'retained native body', now);
    store.cleanup(7);
    assert.deepEqual(store.db.prepare('SELECT message_id FROM kernel_messages').all().map(row => row.message_id), [retained]);
    assert.deepEqual(store.db.prepare('SELECT message_id FROM native_messages').all().map(row => row.message_id), [nativeRetained]);
    assert.equal(ids.resolve(10000, expired), null); assert.equal(ids.resolve(10000, orphan), null); assert.equal(ids.resolve(10000, nativeExpired), null);
    assert.equal(ids.resolve(10000, retained), 'retained'); assert.equal(ids.resolve(10000, recentMapping), 'recently-observed');
    assert.ok(ids.allocate(10000, 'next') > nativeRetained); store.cleanup(7);
  } finally { store.close(); }
});

test('legacy ID mappings migrate with a retention grace period and keep their existing OneBot IDs', () => {
  const store = new Store(':memory:');
  try {
    store.db.exec("CREATE TABLE native_message_ids(onebot_id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, native_id TEXT NOT NULL, UNIQUE(account,native_id)); INSERT INTO native_message_ids VALUES(42,'10000','legacy');");
    const ids = new MessageIdMap(store.db); store.cleanup(7);
    assert.equal(ids.allocate(10000, 'legacy'), 42);
    assert.ok(store.db.prepare('SELECT last_seen FROM native_message_ids').get().last_seen > 0);
  } finally { store.close(); }
});

test('pruning all mappings never reuses IDs or bypasses signed-int32 exhaustion', () => {
  const store = new Store(':memory:');
  try {
    const ids = new MessageIdMap(store.db), previous = ids.allocate(10000, 'previous');
    store.db.exec('DELETE FROM native_message_ids');
    assert.ok(ids.allocate(10000, 'next') > previous);
    store.db.exec("DELETE FROM native_message_ids; UPDATE sqlite_sequence SET seq=2147483647 WHERE name='native_message_ids'");
    assert.throws(() => ids.allocate(10000, 'exhausted'), /space exhausted/);
  } finally { store.close(); }
});

test('group webhook defaults respect text-only drivers and explicit unsupported mentions still fail', async t => {
  class TextDriver extends QQDriver {
    get mode() { return 'kernel'; }
    get capabilities() { return ['message.send']; }
    async connect() { this.online = true; }
    async invoke(_, params) { kernelText(params.message); this.sent = params.message; return { message_id: 1 }; }
  }
  const driver = new TextDriver({ account: 10000 }), bot = await app(t, {}, { driver });
  const original = globalThis.fetch; let reply = { reply: 'plain reply' };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(reply));
    const event = { self_id: 10000, post_type: 'message', message_type: 'group', user_id: 10001, group_id: 20000 };
    await bot.server.postWebhook(event); assert.deepEqual(driver.sent, [{ type: 'text', data: { text: 'plain reply' } }]);
    reply = { reply: 'plain reply', at_sender: true };
    await assert.rejects(bot.server.postWebhook(event), error => error.code === 1404);
    const demo = await app(t); reply = { reply: 'demo reply' }; await demo.server.postWebhook(event);
    assert.equal(demo.adapter.driver.messages.get(1).message[0].type, 'at');
    reply = { reply: 'without mention', at_sender: false }; await demo.server.postWebhook(event);
    assert.equal(demo.adapter.driver.messages.get(2).message[0].type, 'text');
  } finally { globalThis.fetch = original; }
});

test('slow sends do not block unrelated sessions while concurrency stays bounded and each session stays ordered', async t => {
  const limiter = new SendLimiter(0, 0, { concurrency: 2 }), a = deferred(), b = deferred();
  cleanup(t, () => { a.resolve(); b.resolve(); limiter.close(); });
  const started = []; let active = 0, maximum = 0;
  const submit = (session, label, hold) => limiter.run(session, async () => {
    started.push(label); maximum = Math.max(maximum, ++active);
    try { if (hold) await hold.promise; } finally { active--; }
  });
  const firstA = submit('a', 'a1', a), secondA = submit('a', 'a2'), firstB = submit('b', 'b', b), firstC = submit('c', 'c');
  assert.deepEqual(started, ['a1', 'b']); b.resolve(); await firstB;
  await waitFor(() => started.includes('c'));
  assert.equal(started.includes('a2'), false); a.resolve(); await Promise.all([firstA, secondA, firstC]);
  assert.equal(maximum, 2); assert.ok(started.indexOf('a2') > started.indexOf('a1'));
});

test('a session cooldown does not hold up an eligible session behind it', async () => {
  const limiter = new SendLimiter(0, 40), order = [];
  try {
    await limiter.run('a', () => order.push('a1'));
    const same = limiter.run('a', () => order.push('a2'));
    await limiter.run('b', () => order.push('b'));
    assert.deepEqual(order, ['a1', 'b']); await same;
    assert.deepEqual(order, ['a1', 'b', 'a2']);
  } finally { limiter.close(); }
});

test('the send queue is bounded and queued cancellations and close never submit a message', async t => {
  const limiter = new SendLimiter(0, 0, { concurrency: 1, maxPending: 1 }), held = deferred(), controller = new AbortController();
  cleanup(t, () => { held.resolve(); limiter.close(); });
  const active = limiter.run('a', () => held.promise); let queuedCalls = 0;
  const queued = limiter.run('b', () => { queuedCalls++; }, controller.signal);
  const cancelled = assert.rejects(queued, error => error.code === 1502 && !error.uncertain);
  await assert.rejects(limiter.run('c', () => {}), error => error.code === 1503 && error.retryable && !error.uncertain);
  controller.abort(); await cancelled;
  const closing = limiter.run('c', () => { queuedCalls++; });
  const closed = assert.rejects(closing, error => error.code === 1502 && !error.uncertain);
  limiter.close(); await closed; held.resolve(); await active; assert.equal(queuedCalls, 0);
});

test('adapter shutdown cancels externally signalled queued sends and leaves only submitted sends uncertain', async t => {
  class SlowDriver extends QQDriver {
    async invoke() { this.calls = (this.calls || 0) + 1; return new Promise(() => {}); }
  }
  const driver = new SlowDriver({ account: 10000 }); driver.online = true;
  const adapter = new QQAdapter(driver, config(await temp(t), { SEND_CONCURRENCY: '1' })); cleanup(t, () => adapter.close());
  const external = new AbortController();
  const first = assert.rejects(adapter.action('send_private_msg', { user_id: 10001, message: 'first' }, { signal: external.signal }), error => error.uncertain === true);
  await waitFor(() => driver.calls === 1);
  const second = assert.rejects(adapter.action('send_private_msg', { user_id: 10002, message: 'second' }, { signal: external.signal }), error => error.code === 1502 && !error.uncertain);
  await adapter.close(); await Promise.all([first, second]);
  assert.equal(driver.calls, 1); assert.equal(external.signal.aborted, false);
});

test('send concurrency and queue capacity reject invalid configuration', () => {
  assert.equal(config('unused').sendConcurrency, 4); assert.equal(config('unused').maxPendingSends, 1000);
  for (const [key, value] of [['SEND_CONCURRENCY', '0'], ['SEND_CONCURRENCY', '17'], ['MAX_PENDING_SENDS', '0'], ['MAX_PENDING_SENDS', '10001']]) {
    assert.throws(() => config('unused', { [key]: value }), new RegExp(key));
  }
});
