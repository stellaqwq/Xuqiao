import { replyBody } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ReplyWorker } from '../src/worker.mjs';
import { Store } from '../src/store.mjs';
import { QQAdapter } from '../src/qq/adapter.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { BotError } from '../src/errors.mjs';
import { config, temp, cleanup, waitFor, withTestTimeout } from './helpers.mjs';

const event = (id, user = 10001) => ({ self_id: 10000, post_type: 'message', message_type: 'private',
  user_id: user, message_id: id, message: `question ${id}` });
const settings = directory => config(directory, { AI_ENABLED: 'true', AI_MODEL: 'test',
  AI_ALLOWED_USERS: '10001,10002', AI_CONCURRENCY: '2', SEND_CONCURRENCY: '1' });

test('shutdown preserves a limiter-queued reply across restart while submitted delivery remains uncertain', async t => {
  const cfg = settings(await temp(t)), path = join(cfg.dataDir, 'worker.sqlite');
  let store = new Store(path), adapter, worker;
  cleanup(t, async () => { await worker?.close(); await adapter?.close(); store.close(); });
  const submissions = [];
  class HeldDriver extends QQDriver {
    async connect() { this.online = true; }
    async invoke(command, params) {
      assert.equal(command, 'message.send'); submissions.push(params.target);
      return new Promise(() => {});
    }
  }
  adapter = new QQAdapter(new HeldDriver({ account: 10000 }), cfg);
  await adapter.start();
  let generations = 0;
  const ai = { async reply() { generations++; return 'unexpected regeneration'; } };
  const logs = [];
  worker = new ReplyWorker({ adapter, store, ai, config: cfg, log: (level, name, fields) => logs.push({ level, name, ...fields }) });
  const first = store.ingest(event(1), 'question 1', 10).id;
  const second = store.ingest(event(2, 10002), 'question 2', 10).id;
  store.update(first, 'ready', { reply: 'first answer', attempts: 1 });
  store.update(second, 'ready', { reply: 'second answer', attempts: 1 });
  worker.start();
  await waitFor(() => submissions.length === 1 && adapter.limiter.queue.length === 1);
  assert.equal(store.get(first).status, 'sending');
  assert.equal(store.get(second).status, 'sending');
  await withTestTimeout(() => worker.close());
  assert.deepEqual(submissions, [10001]);
  assert.equal(store.get(first).status, 'uncertain');
  assert.equal(store.get(first).reason, 'delivery_unknown');
  assert.equal(store.get(second).status, 'ready');
  assert.equal(store.get(second).reason, 'send_cancelled_before_submission');
  assert.equal(store.get(second).reply, 'second answer');
  assert.equal(store.get(second).attempts, 1);
  assert.equal(store.get(second).send_attempts, 0, 'Pre-submission shutdown does not consume the send retry budget');
  assert.equal(store.history('10000:private:10002', 10).length, 0);
  assert.ok(logs.some(entry => entry.job === second && entry.state === 'ready'));

  await adapter.close(); store.close(); store = new Store(path);
  const resumed = [];
  class ConfirmedDriver extends QQDriver {
    async connect() { this.online = true; }
    async invoke(command, params) { assert.equal(command, 'message.send'); resumed.push(params); return { message_id: 123 }; }
  }
  adapter = new QQAdapter(new ConfirmedDriver({ account: 10000 }), cfg);
  await adapter.start();
  worker = new ReplyWorker({ adapter, store, ai, config: cfg, log: () => {} });
  worker.start();
  await waitFor(() => store.get(second).status === 'done');
  await worker.close();
  assert.equal(store.get(first).status, 'uncertain');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].target, 10002);
  assert.deepEqual(replyBody(resumed[0].message), [{ type: 'text', data: { text: 'second answer' } }]);
  assert.equal(generations, 0);
  assert.equal(store.get(second).send_attempts, 1);
  assert.deepEqual(store.history('10000:private:10002', 10), [
    { role: 'user', content: 'question 2' }, { role: 'assistant', content: 'second answer' }
  ]);
});

test('shutdown during the global send cooldown retains the reply without submitting it', async t => {
  const cfg = { ...settings(await temp(t)), sendInterval: 60000 };
  const store = new Store(':memory:');
  let submissions = 0;
  class CountingDriver extends QQDriver {
    async connect() { this.online = true; }
    async invoke() { submissions++; return { message_id: 123 }; }
  }
  const adapter = new QQAdapter(new CountingDriver({ account: 10000 }), cfg);
  const worker = new ReplyWorker({ adapter, store, ai: {}, config: cfg, log: () => {} });
  cleanup(t, async () => { await worker.close(); await adapter.close(); store.close(); });
  await adapter.start();
  const { id } = store.ingest(event(1), 'question 1', 10);
  store.update(id, 'ready', { reply: 'saved answer' });
  adapter.limiter.lastGlobal = Date.now();
  worker.start();
  await waitFor(() => adapter.limiter.queue.length === 1);
  await withTestTimeout(() => worker.close());
  assert.equal(store.get(id).status, 'ready');
  assert.equal(store.get(id).reply, 'saved answer');
  assert.equal(submissions, 0);
  assert.equal(adapter.limiter.queue.length, 0);
});

test('shutdown never retries ambiguous delivery or an unrelated permanent send failure', async () => {
  for (const [error, expected] of [
    [new BotError('submitted', 1502, { uncertain: true }), 'uncertain'],
    [new Error('untyped driver failure'), 'uncertain'],
    [new BotError('unsupported action', 1404), 'failed'],
    [{ code: 1502 }, 'failed']
  ]) {
    const cfg = settings('unused'), store = new Store(':memory:');
    let worker;
    try {
      worker = new ReplyWorker({ adapter: { status: () => ({ online: true }), action: async () => {
        worker.controller.abort(); throw error;
      } }, store, ai: {}, config: cfg, log: () => {} });
      const { id } = store.ingest(event(1), 'question 1', 10);
      store.update(id, 'ready', { reply: 'saved answer' });
      await worker.step();
      assert.equal(store.get(id).status, expected);
    } finally { await worker?.close(); store.close(); }
  }
});
