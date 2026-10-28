import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QzoneTransport, parseSession, parsePayload, gtk } from '../src/qzone/transport.mjs';
import { QzoneService } from '../src/qzone/service.mjs';
import { Store } from '../src/store.mjs';
import { BotError } from '../src/errors.mjs';
import { DemoDriver } from '../src/qq/demo-driver.mjs';
import { createLoginServer } from '../src/web/login-server.mjs';
import { createQzoneTools } from '../examples/qzone-tool.mjs';
import { app, temp, config, cleanup, request, waitFor } from './helpers.mjs';

const cookie = 'uin=o00123456; p_uin=o00123456; skey=test-skey; p_skey=test-pskey; unrelated=discard-me';
const session = () => parseSession(cookie, 'test-token');
async function service(t, overrides = {}) {
  const directory = await temp(t), c = config(directory, { QQ_DRIVER: 'kernel', AI_MODEL: 'test-model' });
  const store = new Store(join(directory, 'test.sqlite')); cleanup(t, () => store.close());
  const instance = new QzoneService({ store, config: c, ...overrides }); cleanup(t, () => instance.close());
  instance.saveSession({ cookie, token: 'test-token' });
  return { instance, store, c, directory };
}
const draft = instance => instance.saveDraft({ content: '这是一条待发布的说说。', visibility: 'private' });
const publish = (instance, row) => instance.publish({ id: row.id, revision: row.revision, account: 123456 });

test('Qzone sessions validate identity, strip unrelated cookies and reject header injection', () => {
  assert.equal(session().account, 123456);
  assert.ok(!session().cookie.includes('unrelated'));
  for (const value of ['', 'uin=o123456; skey=x', 'uin=o123456; p_uin=o999999; p_skey=x', cookie + '\r\nX-Header: bad', 'uin=o123456; p_skey=x; p_skey=y']) assert.throws(() => parseSession(value), BotError);
  assert.throws(() => parseSession(cookie, 'bad\nvalue'), BotError);
  assert.equal(gtk('abc'), 193485963);
});

test('Qzone JSONP parsing never executes remote scripts', () => {
  assert.deepEqual(parsePayload('shine0_Callback({"code":0,"tid":"abc"});'), { code: 0, tid: 'abc' });
  assert.deepEqual(parsePayload('{"code":-3}'), { code: -3 });
  for (const value of ['callback({code:0})', 'callback({"code":0}); globalThis.qzoneUnsafe=true;', '<html>login</html>', 'null']) assert.throws(() => parsePayload(value));
  assert.equal(globalThis.qzoneUnsafe, undefined);
});

test('Qzone transport encodes Chinese content, credentials, token and exact visibility rights', async () => {
  for (const [visibility, right] of [['public', '1'], ['friends', '4'], ['private', '64']]) {
    let calls = 0;
    const transport = new QzoneTransport({ fetch: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://user.qzone.qq.com');
      assert.equal(url.searchParams.get('g_tk'), String(gtk('test-pskey')));
      assert.equal(url.searchParams.get('qzonetoken'), 'test-token');
      assert.equal(options.redirect, 'error');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('con'), '周末 & 快乐\n你好😀');
      assert.equal(form.get('ugc_right'), right);
      assert.equal(form.get('hostuin'), '123456');
      assert.equal(form.get('to_tweet'), '0');
      assert.equal(options.headers.Cookie, session().cookie);
      return new Response('callback({"code":0,"data":{"tid":"post-123"}});');
    } });
    const result = await transport.publish(session(), { content: '周末 & 快乐\n你好😀', visibility });
    assert.equal(result.tid, 'post-123'); assert.equal(calls, 1);
    assert.equal(result.url, 'https://user.qzone.qq.com/123456/mood/post-123');
  }
});

test('Qzone transport separates definitive rejection from ambiguous responses without retries', async () => {
  const cases = [
    [() => new Response('{"code":-3,"message":"secret server payload"}'), false],
    [() => new Response('', { status: 500 }), true],
    [() => new Response('<html>login</html>'), true],
    [() => new Response('{"code":0}'), true],
    [() => new Response('{"tid":"abc"}'), true],
    [() => { throw Error('network secret'); }, true],
    [() => new Response('x'.repeat(2 * 1024 * 1024 + 1)), true]
  ];
  for (const [result, uncertain] of cases) {
    let calls = 0;
    const transport = new QzoneTransport({ fetch: async () => { calls++; return result(); } });
    await assert.rejects(transport.publish(session(), { content: 'text', visibility: 'private' }), error => {
      assert.equal(error.uncertain, uncertain); assert.ok(!error.message.includes('secret')); return true;
    });
    assert.equal(calls, 1);
  }
});

test('Qzone obtains page tokens before mutation and expired login never triggers a publish', async () => {
  for (const home of ['window.g_qzonetoken="page-token";', 'window.g_qzonetoken=(function(){try{return "page-token";}catch(e){}return "";})();']) {
    const calls = [];
    const transport = new QzoneTransport({ fetch: async (url, options) => {
      calls.push(options.method || 'GET');
      if (!options.method) return new Response(home);
      assert.equal(url.searchParams.get('qzonetoken'), 'page-token');
      return new Response('{"code":0,"tid":"abc"}');
    } });
    await transport.publish(parseSession(cookie), { content: 'text', visibility: 'private' });
    assert.deepEqual(calls, ['GET', 'POST']);
  }
  let calls = 0;
  const expired = new QzoneTransport({ fetch: async () => { calls++; return new Response('Please login'); } });
  await assert.rejects(expired.publish(parseSession(cookie), { content: 'text', visibility: 'private' }), error => !error.uncertain);
  assert.equal(calls, 1);
});

test('Qzone keeps p_uin and accepts an authenticated page with an empty optional token', async () => {
  const sessionWithoutPUin = parseSession('uin=o123456; skey=fixture; p_skey=fixture-key');
  const requests = [];
  const transport = new QzoneTransport({ fetch: async (url, options) => {
    assert.match(options.headers.Cookie, /(?:^|; )p_uin=o123456(?:;|$)/);
    requests.push(options.method || 'GET');
    if (!options.method) return new Response("window.g_iLoginUin=123456;window.g_qzonetoken='';");
    assert.equal(url.searchParams.has('qzonetoken'), false);
    return new Response('{"code":0,"tid":"accepted"}');
  } });
  assert.equal((await transport.publish(sessionWithoutPUin, { content:'fixture', visibility:'private' })).tid, 'accepted');
  assert.deepEqual(requests, ['GET','POST']);
});

test('Qzone rejects guest or mismatched home identities even when a page token exists', async () => {
  for (const account of [0, 999999]) {
    let calls = 0;
    const transport = new QzoneTransport({ fetch: async () => {
      calls++; return new Response(`window.g_iLoginUin=${account};window.g_qzonetoken='token';`);
    } });
    await assert.rejects(transport.publish(parseSession(cookie), { content:'fixture', visibility:'private' }), error => !error.uncertain);
    assert.equal(calls, 1);
  }
});

test('space credentials are encrypted, survive restart, and never appear in public state or posts', async t => {
  const { instance, c, store, directory } = await service(t);
  const saved = await readFile(join(directory, 'qzone-session', '1.session'), 'utf8');
  assert.ok(!saved.includes('test-pskey')); assert.ok(!saved.includes('test-token'));
  assert.ok(!JSON.stringify(instance.status()).includes('test-'));
  await instance.close();
  const restarted = new QzoneService({ store, config: c }); cleanup(t, () => restarted.close());
  assert.equal(restarted.status().account, 123456);
  restarted.clearSession(); assert.equal(restarted.status().configured, false);
  assert.ok(!JSON.stringify(restarted.list()).includes('test-pskey'));
});

test('Qzone drafts use revision checks, default to private and reject unsupported data', async t => {
  const { instance } = await service(t);
  const row = instance.saveDraft({ content: '你好😀' });
  assert.equal(row.visibility, 'private');
  const saved = instance.saveDraft({ id: row.id, revision: row.revision, content: '改好了', visibility: 'friends' });
  assert.equal(saved.content, '改好了');
  assert.throws(() => instance.saveDraft({ ...row, content: 'stale' }), /其他页面/);
  for (const params of [{ content: '' }, { content: '😀'.repeat(2001) }, { content: 'hello', visibility: '__proto__' }]) assert.throws(() => instance.saveDraft(params), BotError);
});

test('concurrent and repeated publishes cross the network only once', async t => {
  let release, calls = 0;
  const { instance } = await service(t, { transport: { publish: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { tid: 'abc', url: 'https://user.qzone.qq.com/123456/mood/abc' }; } } });
  const row = draft(instance), first = publish(instance, row);
  assert.equal(instance.get(row.id).status, 'publishing');
  const duplicate = await publish(instance, row); assert.equal(duplicate.status, 'publishing');
  const other = draft(instance); assert.throws(() => publish(instance, other), /正在发布/);
  release(); const result = await first; assert.equal(result.status, 'published');
  assert.equal((await publish(instance, row)).status, 'published'); assert.equal(calls, 1);
});

test('Qzone refuses changed accounts and stale content before publishing', async t => {
  let calls = 0;
  const { instance } = await service(t, { transport: { publish: async () => { calls++; return { tid: 'abc', url: null }; } } });
  const row = draft(instance);
  assert.throws(() => instance.publish({ id: row.id, revision: row.revision, account: 999999 }), /账号已变化/);
  instance.saveDraft({ id: row.id, revision: row.revision, content: 'updated' });
  assert.throws(() => publish(instance, row), /其他页面/);
  assert.equal(calls, 0);
});

test('uncertain posts require reconciliation and cannot be resent or edited', async t => {
  let calls = 0;
  const { instance } = await service(t, { transport: { publish: async () => { calls++; throw new BotError('timeout', 1502, { uncertain: true }); } } });
  const row = draft(instance), uncertain = await publish(instance, row);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal((await publish(instance, row)).status, 'uncertain');
  assert.throws(() => instance.saveDraft({ ...uncertain, content: 'retry' }), /不能编辑/);
  const resolved = instance.resolve({ id: row.id, revision: uncertain.revision, outcome: 'published' });
  assert.equal(resolved.status, 'published'); assert.equal(calls, 1);
});

test('explicit publish rejection retains editable content and a safe reason', async t => {
  const { instance } = await service(t, { transport: { publish: async () => { throw new BotError('secret detail', 1500); } } });
  const result = await publish(instance, draft(instance));
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'publish_rejected');
  assert.ok(!JSON.stringify(instance.list()).includes('secret detail'));
  assert.equal(instance.saveDraft({ ...result, content: '修订后' }).status, 'draft');
});

test('AI generation runs independently of chat auto replies and never publishes automatically', async t => {
  let calls = 0;
  const { instance } = await service(t, { ai: { reply: async (prompt, history, signal) => {
    calls++; assert.equal(prompt, '写一条周末心情'); assert.deepEqual(history, []); assert.ok(signal); return '慢慢来，给今天留一点空白。';
  } }, transport: { publish: () => assert.fail('generation must not publish') } });
  assert.equal(instance.config.ai.enabled, false);
  const row = instance.generate({ prompt: '写一条周末心情', visibility: 'friends' });
  await waitFor(() => instance.get(row.id).status === 'draft');
  assert.equal(instance.get(row.id).content, '慢慢来，给今天留一点空白。'); assert.equal(calls, 1);
});

test('generation concurrency, failure, and shutdown are bounded and persisted', async t => {
  const { instance } = await service(t, { ai: { reply: async (_prompt, _history, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('private provider detail')), { once: true })) } });
  const one = instance.generate({ prompt: 'one' }), two = instance.generate({ prompt: 'two' });
  assert.throws(() => instance.generate({ prompt: 'three' }), /两条/);
  await new Promise(resolve => setImmediate(resolve)); await instance.close();
  for (const row of [one, two]) { assert.equal(instance.get(row.id).status, 'failed'); assert.equal(instance.get(row.id).reason, 'generation_interrupted'); }
  assert.ok(!JSON.stringify(instance.list()).includes('private provider'));
});

test('restart recovers interrupted work and retention preserves uncertain posts for their longer period', async t => {
  const { instance, store, c } = await service(t);
  const one = draft(instance), two = draft(instance), three = draft(instance);
  store.db.prepare("UPDATE qzone_posts SET status='publishing' WHERE id=?").run(one.id);
  store.db.prepare("UPDATE qzone_posts SET status='generating' WHERE id=?").run(two.id);
  store.db.prepare('UPDATE qzone_posts SET updated_at=? WHERE id=?').run(Date.now() - 8 * 86400000, three.id);
  await instance.close();
  const recovered = new QzoneService({ store, config: c }); cleanup(t, () => recovered.close());
  assert.equal(recovered.get(one.id).status, 'uncertain'); assert.equal(recovered.get(two.id).status, 'failed');
  assert.throws(() => recovered.get(three.id), /不存在/);
  store.db.prepare('UPDATE qzone_posts SET updated_at=? WHERE id=?').run(Date.now() - 8 * 86400000, one.id);
  recovered.cleanup(); assert.equal(recovered.get(one.id).status, 'uncertain');
});

test('retention never reuses a post ID and stale clients cannot publish a different draft', async t => {
  const { instance, store } = await service(t);
  const original = draft(instance);
  store.db.prepare('UPDATE qzone_posts SET updated_at=?').run(Date.now() - 8 * 86400000);
  instance.cleanup();
  const newer = draft(instance);
  assert.ok(newer.id > original.id);
  assert.throws(() => publish(instance, original), /不存在/);
  assert.equal(instance.get(newer.id).status, 'draft');
});

test('Qzone admin routes require admin credentials; demo generation and publish never use the network', async t => {
  const bot = await app(t, {}, { qzoneTransport: { publish: () => assert.fail('demo network'), check: () => assert.fail('demo network') }, qzoneAI: { reply: () => assert.fail('demo AI') } });
  assert.equal((await request(bot, '/admin/qzone/status', undefined, 'onebot')).code, 401);
  assert.equal((await request(bot, '/admin/qzone/generate', { prompt: '演示' }, 'onebot')).code, 401);
  const made = (await request(bot, '/admin/qzone/generate', { prompt: '演示' })).data.data;
  await waitFor(() => bot.qzone.get(made.id).status === 'draft');
  const row = bot.qzone.get(made.id);
  const result = (await request(bot, '/admin/qzone/publish', { id: row.id, revision: row.revision, account: 10000 })).data.data;
  assert.equal(result.status, 'published'); assert.equal(result.simulated, true); assert.equal(result.url, null);
  const posts = (await request(bot, '/admin/qzone/posts')).data; assert.equal(posts.length, 1);
  assert.equal((await request(bot, '/admin/qzone/__proto__', {})).code, 404);
});

test('local web proxy preserves origin checks and encrypted session privacy for space routes', async t => {
  const bot = await app(t, { QQ_DRIVER: 'qzone-test', AI_MODEL: 'fixture' }, { driver: new DemoDriver({ account: 10000 }), qzoneTransport: { publish: async () => { throw new BotError('rejected', 1500); } } });
  const web = await createLoginServer({ backend: `http://127.0.0.1:${bot.address.port}`, token: bot.config.adminToken }); cleanup(t, () => web.close());
  const post = (route, value, origin = new URL(web.url).origin) => fetch(web.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  assert.equal((await post('/qzone/session', { cookie }, 'http://evil.invalid')).status, 403);
  const saved = await post('/qzone/session', { cookie, token: 'test-token' });
  assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes('test-pskey'));
  const row = await (await post('/qzone/draft', { content: 'test' })).json();
  const rejected = await post('/qzone/publish', { id: row.id, revision: row.revision, account: 123456 });
  assert.equal(rejected.status, 200); assert.equal((await rejected.json()).status, 'failed');
  assert.equal((await fetch(web.url + '/qzone/status')).status, 200);
  assert.equal((await fetch(web.url + '/qzone/unknown')).status, 404);
});

test('external AI can publish content directly without a draft or web confirmation', async t => {
  let calls = 0;
  const { instance } = await service(t, { transport: { publish: async (session, row) => {
    calls++; assert.equal(session.account, 123456); assert.equal(row.content, 'AI 直接写好的说说');
    assert.equal(row.visibility, 'private'); return { tid: 'direct-post', url: null };
  } } });
  const params = { request_id: 'direct-content-001', account: 123456, content: 'AI 直接写好的说说' };
  const result = await instance.send(params);
  assert.equal(result.status, 'published'); assert.equal(result.request_id, params.request_id);
  instance.clearSession();
  assert.equal((await instance.send(params)).id, result.id); assert.equal(calls, 1);
});

test('direct publishing validates input and rejects changed payloads for the same request key', async t => {
  const { instance } = await service(t, { transport: { publish: async () => ({ tid: 'abc', url: null }) } });
  const base = { request_id: 'direct-validation-001', account: 123456, content: '原文' };
  await instance.send(base);
  for (const change of [{ content: '改文' }, { account: 999999 }, { visibility: 'public' }]) await assert.rejects(instance.send({ ...base, ...change }), /同一 request_id/);
  for (const params of [
    { account: 123456, content: 'text' }, { ...base, request_id: '../../bad path' },
    { ...base, prompt: 'also a prompt' }, { request_id: 'direct-missing-001', account: 123456 },
    { ...base, account: '123456' }, { ...base, visibility: ['private'] }
  ]) await assert.rejects(instance.send(params), BotError);
  assert.equal(instance.list().length, 1);
});

test('direct request IDs prevent concurrent duplicate sends and persist across restart and retention', async t => {
  let calls = 0, release;
  const transport = { publish: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { tid: 'abc', url: null }; } };
  const { instance, store, c } = await service(t, { transport });
  const params = { request_id: 'direct-persistent-001', account: 123456, content: '持久化防重' };
  const first = instance.send(params);
  assert.equal((await instance.send(params)).status, 'publishing');
  release(); const sent = await first; assert.equal(sent.status, 'published');
  await instance.close();
  const restarted = new QzoneService({ store, config: c, transport }); cleanup(t, () => restarted.close());
  assert.equal((await restarted.send(params)).id, sent.id); assert.equal(calls, 1);
  store.db.prepare('UPDATE qzone_posts SET updated_at=? WHERE id=?').run(Date.now() - 8 * 86400000, sent.id);
  restarted.cleanup();
  assert.equal((await restarted.send(params)).status, 'expired'); assert.equal(calls, 1);
});

test('ambiguous direct publication cannot be resent by repeating the request key', async t => {
  let calls = 0;
  const { instance } = await service(t, { transport: { publish: async () => { calls++; throw new BotError('timeout', 1502, { uncertain: true }); } } });
  const params = { request_id: 'direct-uncertain-001', account: 123456, content: '检查未知结果' };
  assert.equal((await instance.send(params)).status, 'uncertain');
  assert.equal((await instance.send(params)).status, 'uncertain');
  assert.equal(instance.requestStatus(params.request_id).reason, 'publish_uncertain'); assert.equal(calls, 1);
});

test('a topic-only direct call generates and publishes automatically with chat AI disabled', async t => {
  let generateCalls = 0, publishCalls = 0;
  const { instance } = await service(t, { ai: { reply: async prompt => { generateCalls++; assert.equal(prompt, '写周末的心情'); return '周末，给自己留一点慢下来的时间。'; } }, transport: { publish: async (_session, row) => {
    publishCalls++; assert.equal(row.content, '周末，给自己留一点慢下来的时间。'); assert.equal(row.visibility, 'friends'); return { tid: 'auto-post', url: null };
  } } });
  const params = { request_id: 'direct-ai-001', account: 123456, prompt: '写周末的心情', visibility: 'friends' };
  assert.equal(instance.config.ai.enabled, false);
  const receipt = await instance.send(params);
  await waitFor(() => instance.requestStatus(params.request_id).status === 'published');
  assert.equal((await instance.send(params)).id, receipt.id);
  assert.equal(generateCalls, 1); assert.equal(publishCalls, 1);
});

test('changing space credentials during direct AI generation prevents publishing to the wrong account', async t => {
  let release, calls = 0;
  const { instance } = await service(t, { ai: { reply: async () => new Promise(resolve => { release = resolve; }) }, transport: { publish: async () => { calls++; return { tid: 'wrong', url: null }; } } });
  const params = { request_id: 'direct-account-001', account: 123456, prompt: '写一句心情' };
  await instance.send(params); await waitFor(() => release);
  instance.saveSession({ cookie: 'uin=o999999; p_skey=another-key', token: 'another-token' });
  release('慢下来。');
  await waitFor(() => instance.requestStatus(params.request_id).status === 'failed');
  assert.equal(instance.requestStatus(params.request_id).reason, 'publish_not_started'); assert.equal(calls, 0);
});

test('direct AI generation failures never dispatch a publication', async t => {
  const { instance } = await service(t, { ai: { reply: async () => { throw Error('private provider detail'); } }, transport: { publish: () => assert.fail('generation failed') } });
  const params = { request_id: 'direct-ai-failed-001', account: 123456, prompt: 'test' };
  await instance.send(params);
  await waitFor(() => instance.requestStatus(params.request_id).status === 'failed');
  assert.equal(instance.requestStatus(params.request_id).reason, 'generation_failed');
  assert.ok(!JSON.stringify(instance.list()).includes('private provider'));
});

test('a direct request and post are committed atomically before contacting Qzone', async t => {
  const { instance, store } = await service(t, { transport: { publish: () => assert.fail('no committed request') } });
  store.db.exec("CREATE TEMP TRIGGER reject_direct_request BEFORE INSERT ON qzone_requests BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(instance.send({ request_id: 'direct-atomic-001', account: 123456, content: 'test' }), /test failure/);
  assert.equal(instance.list().length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM qzone_requests').get().n, 0);
});

test('direct HTTP endpoints enforce admin auth, accept AI content and expose pollable receipts', async t => {
  const bot = await app(t, {}, { qzoneTransport: { publish: () => assert.fail('demo network') } });
  const params = { request_id: 'direct-http-001', account: 10000, content: '【演示】AI 直接调用' };
  assert.equal((await request(bot, '/admin/qzone/send', params, 'onebot')).code, 401);
  const result = (await request(bot, '/admin/qzone/send', params)).data;
  assert.equal(result.status, 'ok'); assert.equal(result.data.status, 'published'); assert.equal(result.data.simulated, true);
  const route = '/admin/qzone/request?request_id=' + params.request_id;
  assert.equal((await request(bot, route, undefined, 'onebot')).code, 401);
  const receipt = (await request(bot, route)).data; assert.equal(receipt.id, result.data.id);
  assert.equal((await request(bot, '/admin/qzone/send', params)).data.data.id, receipt.id);
  assert.equal((await request(bot, '/admin/qzone/request?request_id=not-found-id')).code, 404);
});

test('AI tool definitions and adapter publish through HTTP while keeping credentials out of model schemas', async t => {
  const bot = await app(t);
  assert.equal((await request(bot, '/admin/qzone/tools', undefined, 'onebot')).code, 401);
  const definitions = (await request(bot, '/admin/qzone/tools')).data;
  assert.deepEqual(definitions.map(tool => tool.name), ['send_qzone_post', 'get_qzone_post_result']);
  assert.ok(!JSON.stringify(definitions).includes(bot.config.adminToken));
  const tools = createQzoneTools({ baseUrl: `http://127.0.0.1:${bot.address.port}`, adminToken: bot.config.adminToken });
  assert.ok(!JSON.stringify(tools).includes(bot.config.adminToken));
  const params = { request_id: 'adapter-test-001', account: 10000, content: '【演示】工具调用' };
  const result = await tools.send_qzone_post.execute(params);
  assert.equal(result.status, 'published');
  assert.equal((await tools.get_qzone_post_result.execute({ request_id: params.request_id })).id, result.id);
  await assert.rejects(tools.send_qzone_post.execute({ ...params, content: 'changed' }), /同一 request_id/);
});
