import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseMessage, toCQ, aiInput, id } from '../src/messages.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { SessionVault } from '../src/qq/session-vault.mjs';
import { MessageIdMap } from '../src/qq/message-ids.mjs';
import { SendLimiter } from '../src/limiter.mjs';
import { QQAdapter } from '../src/qq/adapter.mjs';
import { QQDriver } from '../src/qq/driver.mjs';
import { temp, config, cleanup } from './helpers.mjs';

test('CQ segments round-trip escaped text and parameters without double decoding', () => {
  const message = [{ type: 'text', data: { text: '[CQ:at,qq=42] &amp; 中文' } },
    { type: 'image', data: { file: 'a,b[x]&' } }];
  assert.deepEqual(JSON.parse(JSON.stringify(parseMessage(toCQ(message)))), message);
  assert.deepEqual(parseMessage('[CQ:at,qq=42]', true), [{ type: 'text', data: { text: '[CQ:at,qq=42]' } }]);
  assert.throws(() => parseMessage(''), /Invalid message/);
  assert.throws(() => parseMessage('', true), /Empty message/);
  assert.throws(() => parseMessage([{ type: 'text', data: { text: '' } }]), /Empty message/);
  assert.throws(() => id('1.0', 'user'), /Invalid/);
  assert.throws(() => id('9007199254740993', 'user'), /Invalid/);
  assert.equal(id('-1', 'message', { signed: true }), -1);
});

test('AI requires allowlists and group mentions; escaped mentions do not activate it', () => {
  const ai = config('unused', { AI_ENABLED: 'true', AI_MODEL: 'test', AI_ALLOWED_USERS: '10001', AI_ALLOWED_GROUPS: '20000' }).ai;
  const event = { self_id: 10000, user_id: 10001, message_type: 'group', group_id: 20000,
    post_type: 'message', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 问题 ' } }] };
  assert.equal(aiInput(event, ai), '[QQ 10001] 问题');
  assert.equal(aiInput({ ...event, group_id: 30000 }, ai), null);
  assert.equal(aiInput({ ...event, message: '&#91;CQ:at,qq=10000&#93; 问题' }, ai), null);
  assert.equal(aiInput({ ...event, user_id: 10000 }, ai), null);
  assert.throws(() => loadConfig({}), /ONEBOT_ACCESS_TOKEN/);
  assert.throws(() => config('unused', { AI_ENABLED: 'true', AI_MODEL: 'test' }), /allowlist/);
});

function event(id) {
  return { self_id: 10000, message_type: 'private', user_id: 10001, message_id: id, message: '你好', post_type: 'message' };
}
test('persistent queue deduplicates and recovers unknown sends conservatively', async t => {
  const directory = await temp(t);
  const path = join(directory, 'db.sqlite');
  let store = new Store(path);
  assert.equal(store.ingest(event(1), 'first', 100).inserted, true);
  assert.equal(store.ingest(event(1), 'first', 100).inserted, false);
  store.ingest(event(2), 'second', 100);
  store.ingest(event(3), 'third', 100);
  store.update(1, 'generating', { attempts: 1 }); store.update(2, 'sending', { reply: 'answer' });
  store.update(3, 'ready', { reply: 'third answer' }); store.close();
  store = new Store(path); cleanup(t, () => store.close()); store.recover();
  assert.equal(store.get(1).status, 'queued');
  assert.equal(store.get(2).status, 'uncertain');
  assert.equal(store.get(3).status, 'ready');
  assert.equal(store.next().id, 1);
  store.update(1, 'ready', { reply: 'first answer' });
  store.finish(store.get(1), 1);
  assert.deepEqual(store.history('10000:private:10001', 10), [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'first answer' }]);
  assert.equal(store.next().id, 3);
});

test('queue backpressure and history retention do not grow pending work indefinitely', () => {
  const store = new Store(':memory:');
  try {
    store.ingest(event(1), 'a', 1); store.ingest(event(2), 'b', 1);
    assert.equal(store.get(2).reason, 'queue_full');
    assert.equal(store.get(2).status, 'ignored');
    store.update(1, 'ready', { reply: 'reply' }); store.finish(store.get(1), 0);
    assert.deepEqual(store.history('10000:private:10001', 1), []);
  } finally { store.close(); }
});

test('session vault encrypts, replaces atomically and detects tampering/wrong keys', async t => {
  const directory = await temp(t);
  const key = randomBytes(32).toString('hex');
  const vault = new SessionVault(directory, key);
  vault.save(10000, { credential: 'secret-ticket' });
  const path = join(directory, '10000.session');
  assert.equal(readFileSync(path, 'utf8').includes('secret-ticket'), false);
  assert.deepEqual(vault.load(10000), { credential: 'secret-ticket' });
  vault.save(10000, { credential: 'new-ticket' });
  assert.equal(vault.load(10000).credential, 'new-ticket');
  assert.throws(() => new SessionVault(directory, randomBytes(32).toString('hex')).load(10000));
  const content = JSON.parse(readFileSync(path, 'utf8'));
  content.tag = randomBytes(16).toString('base64'); writeFileSync(path, JSON.stringify(content));
  assert.throws(() => vault.load(10000));
  assert.throws(() => vault.load('../escape'));
});

test('native message ID mapping persists and is isolated by account', async t => {
  const directory = await temp(t); const path = join(directory, 'db.sqlite');
  let store = new Store(path); let map = new MessageIdMap(store.db);
  const first = map.allocate(10000, 'opaque-native-id');
  assert.equal(map.allocate(10000, 'opaque-native-id'), first);
  const other = map.allocate(10001, 'opaque-native-id'); assert.notEqual(other, first);
  store.close(); store = new Store(path); cleanup(t, () => store.close()); map = new MessageIdMap(store.db);
  assert.equal(map.allocate(10000, 'opaque-native-id'), first);
  assert.equal(map.resolve(10001, first), null);
  assert.equal(map.resolve(10000, first), 'opaque-native-id');
});

test('send limiter serializes callers and applies a per-conversation interval', async () => {
  const limiter = new SendLimiter(15, 45); const timestamps = [];
  await Promise.all(['a', 'b', 'a'].map(session => limiter.run(session, () => { timestamps.push(Date.now()); })));
  assert.ok(timestamps[1] - timestamps[0] >= 12);
  assert.ok(timestamps[2] - timestamps[0] >= 42);
});

test('timed-out driver mutations are uncertain and never automatically retried', async t => {
  class SlowDriver extends QQDriver {
    async invoke() { this.count = (this.count || 0) + 1; return new Promise(() => {}); }
  }
  const driver = new SlowDriver({ account: 10000 }); driver.online = true;
  const adapter = new QQAdapter(driver, config(await temp(t), { QQ_RPC_TIMEOUT_MS: '20' }));
  cleanup(t, () => adapter.close());
  await assert.rejects(adapter.action('send_private_msg', { user_id: 10001, message: 'test' }), error => error.uncertain === true && error.code === 1502);
  assert.equal(driver.count, 1);
});
