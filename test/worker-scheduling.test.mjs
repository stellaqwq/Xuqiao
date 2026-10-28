import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { ReplyWorker } from '../src/worker.mjs';
import { BotError } from '../src/errors.mjs';
import { config, temp, cleanup, waitFor, app, request } from './helpers.mjs';

const event = (id, user = 10001) => ({ self_id: 10000, post_type: 'message', message_type: 'private',
  user_id: user, message_id: id, message: `question ${id}` });
const settings = (directory = 'unused', env = {}) => config(directory, { AI_ENABLED: 'true', AI_MODEL: 'test',
  AI_ALLOWED_USERS: '10001,10002', AI_CONCURRENCY: '4', ...env });
function setup(t, { cfg = settings(), action = async () => {}, ai = { reply: async () => 'answer' } } = {}) {
  const store = new Store(':memory:');
  const adapter = Object.assign(new EventEmitter(), { online: true, status() { return { online: this.online }; }, action });
  const worker = new ReplyWorker({ adapter, store, ai, config: cfg, log: () => {} });
  cleanup(t, async () => { await worker.close(); store.close(); });
  return { store, adapter, worker };
}

test('send retries persist an independent counter, back off exponentially, and stop at the configured limit', async t => {
  let now = 1000000, sends = 0;
  t.mock.method(Date, 'now', () => now);
  const { store, worker } = setup(t, { action: async () => {
    sends++; throw new BotError('queue full', 1503, { retryable: true });
  } });
  const { id } = store.ingest(event(1), 'question', 10);
  store.update(id, 'ready', { reply: 'saved answer', attempts: 2 });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await worker.step();
    const job = store.get(id);
    assert.equal(job.attempts, 2, 'Generation budget stays independent');
    assert.equal(job.send_attempts, attempt);
    assert.equal(store.list()[0].send_attempts, attempt);
    assert.equal(sends, attempt);
    if (attempt < 5) {
      assert.equal(job.status, 'ready');
      assert.equal(job.next_at - now, 1000 * 2 ** (attempt - 1));
      await worker.step(); assert.equal(sends, attempt, 'No send before retry is due');
      now = job.next_at;
    } else {
      assert.equal(job.status, 'failed');
      assert.equal(job.reason, 'send_attempts_exhausted');
      assert.equal(job.reply, 'saved answer');
    }
  }
  now += 60000; await worker.step(); assert.equal(sends, 5);
});

test('send backoff is capped and an unknown result on the final attempt stays uncertain', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  let unknown = false;
  const { store, worker } = setup(t, { cfg: settings('unused', { SEND_MAX_ATTEMPTS: '8' }), action: async () => {
    throw new BotError('driver failure', 1502, { retryable: true, uncertain: unknown });
  } });
  const { id } = store.ingest(event(1), 'question', 10);
  store.update(id, 'ready', { reply: 'answer', sendAttempts: 6 });
  await worker.step(); assert.equal(store.get(id).next_at - now, 30000);
  now = store.get(id).next_at; unknown = true;
  await worker.step();
  assert.equal(store.get(id).status, 'uncertain');
  assert.equal(store.get(id).send_attempts, 8);
  assert.equal(store.get(id).reason, 'delivery_unknown');
});

test('idle workers do not poll and an ingest wakes them to complete a reply', async t => {
  let sends = 0;
  const { store, worker, adapter } = setup(t, { action: async () => { sends++; } });
  const query = t.mock.method(store, 'next');
  worker.start();
  await waitFor(() => worker.waiters.size === 4);
  const idleQueries = query.mock.callCount();
  await delay(250);
  assert.equal(query.mock.callCount(), idleQueries, 'No idle queries across multiple former polling intervals');
  worker.ingest(event(1));
  await waitFor(() => store.summary().done === 1);
  assert.equal(sends, 1);
  await worker.close();
  assert.equal(worker.waiters.size, 0);
  assert.equal(store.listenerCount('change'), 0);
  assert.equal(adapter.listenerCount('state'), 0);
});

test('offline workers wake on reconnection and future retries wake at their scheduled time', async t => {
  let sends = 0;
  const { store, worker, adapter } = setup(t, { action: async () => { sends++; } });
  adapter.online = false;
  const { id } = store.ingest(event(1), 'question', 10);
  store.update(id, 'ready', { reply: 'answer', nextAt: Date.now() + 250 });
  worker.start();
  await waitFor(() => worker.waiters.size === 4);
  assert.equal(sends, 0);
  adapter.online = true; adapter.emit('state');
  await waitFor(() => store.get(id).status === 'done');
  assert.equal(sends, 1);
});

test('a store change between querying and sleeping cannot strand a task', async t => {
  const { store, worker } = setup(t);
  const original = store.next.bind(store);
  let inserted = false;
  t.mock.method(store, 'next', () => {
    const result = original();
    if (!inserted) { inserted = true; queueMicrotask(() => worker.ingest(event(1))); }
    return result;
  });
  worker.start();
  await waitFor(() => store.summary().done === 1);
});

test('active conversation heads do not create idle timers or permit later jobs to overtake', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { store, worker } = setup(t, { ai: { reply: async () => held } });
  cleanup(t, () => release('answer'));
  worker.ingest(event(1)); worker.ingest(event(2));
  const query = t.mock.method(store, 'next');
  worker.start();
  await waitFor(() => store.get(1).status === 'generating' && worker.waiters.size === 3);
  assert.equal(store.nextTime(), null);
  const queries = query.mock.callCount();
  await delay(250); assert.equal(query.mock.callCount(), queries);
  release('answer');
  await waitFor(() => store.summary().done === 2);
});

test('uncertain jobs consume admission capacity until resolved or expired, without auto-resending', () => {
  const store = new Store(':memory:');
  try {
    const first = store.ingest(event(1), 'question', 1).id;
    store.update(first, 'uncertain', { reply: 'answer' });
    const blocked = store.ingest(event(2), 'question 2', 1);
    assert.equal(blocked.status, 'ignored'); assert.equal(store.get(blocked.id).reason, 'queue_full');
    assert.equal(store.next(), undefined);
    store.update(first, 'failed', { reason: 'manually_discarded' });
    assert.equal(store.ingest(event(3), 'question 3', 1).status, 'queued');
  } finally { store.close(); }
});

test('uncertain retention uses the time delivery became unknown and preserves active work', t => {
  let now = 100 * 86400000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:');
  try {
    for (let id = 1; id <= 4; id++) store.ingest(event(id), 'question', 10);
    store.update(1, 'uncertain'); store.update(2, 'uncertain'); store.update(3, 'sending');
    store.db.prepare('UPDATE jobs SET created_at=?').run(now - 90 * 86400000);
    store.db.prepare('UPDATE jobs SET updated_at=? WHERE id IN (1,3)').run(now - 31 * 86400000);
    store.cleanup(7, 30);
    assert.equal(store.get(1), undefined);
    assert.equal(store.get(2).status, 'uncertain', 'Recently unknown records keep a full review window');
    assert.equal(store.get(3).status, 'sending'); assert.equal(store.get(4).status, 'queued');
    store.recover(); store.cleanup(7, 30);
    assert.equal(store.get(3).status, 'uncertain', 'Crash recovery starts a new review window');
    now += 31 * 86400000; store.cleanup(7, 30);
    assert.equal(store.get(2), undefined); assert.equal(store.get(3), undefined);
    assert.equal(store.ingest(event(5), 'new work', 2).status, 'queued');
  } finally { store.close(); }
});

test('old databases migrate counters without losing generation attempts, replies or retry dates', async t => {
  const path = join(await temp(t), 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
    event TEXT NOT NULL, input TEXT, reply TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  legacy.prepare('INSERT INTO jobs VALUES (1,?,?,?,?,?,?,?,?,?,?,?)').run('key', 'conversation', JSON.stringify(event(1)),
    'question', 'saved reply', 'ready', 2, 123456, 'send_failed', 1, 2);
  legacy.close();
  let store = new Store(path);
  try {
    assert.equal(store.get(1).attempts, 2); assert.equal(store.get(1).send_attempts, 0);
    assert.equal(store.get(1).reply, 'saved reply'); assert.equal(store.get(1).next_at, 123456);
    store.update(1, 'ready', { sendAttempts: 3 });
  } finally { store.close(); }
  store = new Store(path);
  try { assert.equal(store.get(1).send_attempts, 3); } finally { store.close(); }
});

test('administrator job listings expose generation and send counters separately', async t => {
  const bot = await app(t);
  const { id } = bot.store.ingest(event(1), 'question', 10);
  bot.store.update(id, 'failed', { attempts: 2, sendAttempts: 5, reason: 'send_attempts_exhausted' });
  const result = await request(bot, '/admin/jobs');
  assert.equal(result.code, 200);
  assert.equal(result.data[0].attempts, 2);
  assert.equal(result.data[0].send_attempts, 5);
});

test('send retry and uncertain retention settings reject invalid values', () => {
  assert.equal(settings().sendMaxAttempts, 5); assert.equal(settings().uncertainRetentionDays, 30);
  for (const [key, value] of [['SEND_MAX_ATTEMPTS', '0'], ['SEND_MAX_ATTEMPTS', '17'], ['UNCERTAIN_RETENTION_DAYS', '0'], ['UNCERTAIN_RETENTION_DAYS', '3651']]) {
    assert.throws(() => settings('unused', { [key]: value }), new RegExp(key));
  }
});
